// En: src/helpers/cards.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import { requirePermission } from '../middleware/permissions';
import type { Variables } from '../types';
import { PermissionAction } from '../types';
import type { Card, CreateCardPayload, UpdateCardPayload, MoveCardPayload, MoveCardToBoardPayload } from '../types/kanban.types';
import { validateDates, formatDateForDB, parseDate } from '../utils/dateUtils';
import { ActivityService } from './activity.helper';
import { SSEService } from './sse.helper';

// ================================
// Lógica de Servicio (CardService)
// ================================
class CardService {
  /**
   * Crea una nueva tarjeta en una lista específica.
   * Calcula automáticamente la posición para que se añada al final.
   */
  static async createCard(data: CreateCardPayload, userId: number): Promise<Card> {
    const { title, list_id, proyecto_id } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Comprobar si la lista existe.
      const listCheck = await client.query('SELECT id, title FROM lists WHERE id = $1', [list_id]);
      if (listCheck.rowCount === 0) {
        throw new Error('La lista especificada no existe.');
      }
      const listTitle = listCheck.rows[0].title;

      // 2. Calcular la nueva posición de la tarjeta dentro de esa lista.
      const positionResult = await client.query(
        'SELECT COUNT(*) as count FROM cards WHERE list_id = $1',
        [list_id]
      );
      const newPosition = parseInt(positionResult.rows[0].count);

      // 3. Insertar la nueva tarjeta.
      const query = `
        INSERT INTO cards (title, list_id, position, proyecto_id)
        VALUES ($1, $2, $3, $4) RETURNING *;
      `;
      const result = await client.query(query, [title, list_id, newPosition, proyecto_id || null]);

      const newCard = result.rows[0];

      // 4. Registrar actividad de creación
      await ActivityService.createActionWithClient(
        client,
        newCard.id,
        userId,
        `creó esta tarjeta en "${listTitle}"`
      );

      await client.query('COMMIT');

      // Obtener board_id para emitir evento SSE
      const boardIdQuery = await client.query(
        'SELECT board_id FROM lists WHERE id = $1',
        [list_id]
      );
      const boardId = boardIdQuery.rows[0]?.board_id;

      // Si hay proyecto_id, obtener la información del proyecto
      if (newCard.proyecto_id) {
        const projectQuery = `
          SELECT id, nombre_proyecto, descripcion, activo, codigo, cod_integracion, cadena, mercado, ciudad, inmueble,
                 numero_obra_osmos, inicio_obra_prevista, apert_espacio_prevista, es_bim
          FROM proyectos
          WHERE id = $1
        `;
        const projectResult = await client.query(projectQuery, [newCard.proyecto_id]);

        if (projectResult.rowCount && projectResult.rowCount > 0) {
          const project = projectResult.rows[0];
          newCard.proyecto = {
            id: project.id,
            nombre_proyecto: project.nombre_proyecto,
            descripcion: project.descripcion,
            activo: project.activo,
            codigo: project.codigo,
            cod_integracion: project.cod_integracion,
            cadena: project.cadena,
            mercado: project.mercado,
            ciudad: project.ciudad,
            inmueble: project.inmueble,
            numero_obra_osmos: project.numero_obra_osmos,
            inicio_obra_prevista: project.inicio_obra_prevista,
            apert_espacio_prevista: project.apert_espacio_prevista,
            es_bim: project.es_bim
          };
        }
      }

      // Emitir evento SSE de creación de tarjeta
      if (boardId) {
        SSEService.emitBoardEvent({
          type: 'card:created',
          boardId,
          data: {
            card: newCard,
            listId: list_id
          }
        });
      }

      return newCard as Card;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.createCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  static async updateCard(id: string, data: UpdateCardPayload, userId: number): Promise<Card | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validar fechas si se proporcionaron
      if (data.start_date || data.due_date) {
        const startDate = data.start_date ? 
          (typeof data.start_date === 'string' ? parseDate(data.start_date) : parseDate(data.start_date.toISOString())) 
          : null;
        const dueDate = data.due_date ? 
          (typeof data.due_date === 'string' ? parseDate(data.due_date) : parseDate(data.due_date.toISOString())) 
          : null;
        
        const validation = validateDates(startDate, dueDate);
        if (!validation.valid) {
          throw new Error(validation.error);
        }
      }

      // Separar campos de la tabla cards de las etiquetas y assignees
      const { labels, assignees, ...cardFields } = data;
      const fieldsToUpdate = Object.keys(cardFields) as Array<keyof Omit<UpdateCardPayload, 'labels' | 'assignees'>>;
      
      let updatedCard: Card | null = null;

      // Actualizar campos de la tarjeta si hay alguno
      if (fieldsToUpdate.length > 0) {
        const setClause = fieldsToUpdate.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
        const queryValues = fieldsToUpdate.map(key => cardFields[key]);
        queryValues.push(id);

        const query = `
          UPDATE cards 
          SET ${setClause}, updated_at = NOW()
          WHERE id = $${queryValues.length} 
          RETURNING *;
        `;
        
        console.log('🔍 [CardService.updateCard] Query:', query);
        console.log('🔍 [CardService.updateCard] Values:', queryValues);
        
        try {
          const result = await client.query(query, queryValues);
          if (result.rowCount === 0) {
            throw new Error('Tarjeta no encontrada');
          }
          updatedCard = result.rows[0] as Card;
          console.log('✅ [CardService.updateCard] Tarjeta actualizada exitosamente');
        } catch (dbError) {
          console.error('💥 [CardService.updateCard] Error de base de datos:', dbError);
          throw new Error(`Error actualizando tarjeta: ${(dbError as Error).message}`);
        }
      } else {
        // Si no hay campos de tarjeta para actualizar, obtener la tarjeta actual
        const result = await client.query('SELECT * FROM cards WHERE id = $1', [id]);
        if (result.rowCount === 0) {
          throw new Error('Tarjeta no encontrada');
        }
        updatedCard = result.rows[0] as Card;
      }

      // Gestionar etiquetas si se proporcionaron
      if (labels !== undefined) {
        // Eliminar todas las etiquetas actuales de la tarjeta
        await client.query('DELETE FROM card_labels WHERE card_id = $1', [id]);
        
        // Agregar las nuevas etiquetas
        if (labels.length > 0) {
          const labelValues = labels.map((label, index) => `($1, $${index + 2})`).join(', ');
          const labelIds = labels.map(label => label.id);
          
          const insertQuery = `
            INSERT INTO card_labels (card_id, label_id) 
            VALUES ${labelValues}
            ON CONFLICT (card_id, label_id) DO NOTHING
          `;
          
          await client.query(insertQuery, [id, ...labelIds]);
        }
      }

      // Gestionar asignaciones de usuarios si se proporcionaron
      if (assignees !== undefined) {
        console.log('🔍 [CardService.updateCard] Actualizando asignaciones:', assignees);

        // Obtener asignaciones actuales antes de eliminar
        const currentAssignmentsResult = await client.query(
          'SELECT user_id FROM card_assignments WHERE card_id = $1',
          [id]
        );
        const currentAssignees = currentAssignmentsResult.rows.map(row => row.user_id);

        // Eliminar asignaciones actuales
        await client.query('DELETE FROM card_assignments WHERE card_id = $1', [id]);

        // Agregar nuevas asignaciones
        if (assignees.length > 0) {
          // Extraer los user_ids para la verificación
          const userIds = assignees.map(a => a.user_id);

          // Verificar que todos los usuarios existen
          const usersCheck = await client.query(
            'SELECT id, email, name FROM usuarios WHERE id = ANY($1)',
            [userIds]
          );

          if (usersCheck.rowCount !== assignees.length) {
            throw new Error('Uno o más usuarios especificados no existen');
          }

          // Insertar nuevas asignaciones y crear actividades/notificaciones para nuevos asignados
          for (const assigneeData of assignees) {
            await client.query(
              'INSERT INTO card_assignments (card_id, user_id, assigned_by, workload_hours, assignment_order) VALUES ($1, $2, $3, $4, $5)',
              [id, assigneeData.user_id, userId, assigneeData.workload_hours, assigneeData.assignment_order || null]
            );

            // Si es un usuario nuevo (no estaba asignado antes), crear actividad y notificación
            if (!currentAssignees.includes(assigneeData.user_id)) {
              const userData = usersCheck.rows.find(u => u.id === assigneeData.user_id);
              const assignedUserName = userData?.name || userData?.email || 'Usuario';
              const description = `asignó a ${assignedUserName}`;

              // Crear actividad
              const activityResult = await client.query(
                `INSERT INTO card_activity (card_id, user_id, activity_type, description)
                 VALUES ($1, $2, 'ACTION', $3)
                 RETURNING id`,
                [id, userId, description]
              );

              const activityId = activityResult.rows[0].id;
              console.log(`✅ [CardService.updateCard] Actividad creada con id=${activityId} para asignación de usuario ${assigneeData.user_id} por usuario ${userId}`);

              // Crear notificación para el usuario asignado (si no es el mismo que asigna)
              if (assigneeData.user_id !== userId) {
                try {
                  const { NotificationService } = await import('./notifications.helper');
                  await NotificationService.createNotificationWithClient(client, assigneeData.user_id, activityId, description);
                  console.log(`✅ [CardService.updateCard] Notificación creada para usuario ${assigneeData.user_id}`);
                } catch (notifError) {
                  console.error(`❌ [CardService.updateCard] Error creando notificación:`, notifError);
                }
              }
            }
          }
        }

        console.log('✅ [CardService.updateCard] Asignaciones actualizadas');
      }

      await client.query('COMMIT');
      
      // Después de actualizar, obtener la tarjeta completa con asignaciones, etiquetas y proyecto
      const fullCardQuery = `
        SELECT c.*,
               COALESCE(assignees_agg.assignees, '[]') AS assignees,
               COALESCE(labels_agg.labels, '[]') AS labels,
               p.nombre_proyecto, p.descripcion as proyecto_descripcion, p.activo as proyecto_activo,
               p.codigo as proyecto_codigo, p.cod_integracion as proyecto_cod_integracion,
               p.cadena as proyecto_cadena, p.mercado as proyecto_mercado, p.ciudad as proyecto_ciudad, p.inmueble as proyecto_inmueble,
               p.numero_obra_osmos as proyecto_numero_obra_osmos, p.inicio_obra_prevista as proyecto_inicio_obra_prevista,
               p.apert_espacio_prevista as proyecto_apert_espacio_prevista, p.es_bim as proyecto_es_bim
        FROM cards c
        LEFT JOIN proyectos p ON c.proyecto_id = p.id
        LEFT JOIN (
          SELECT ca.card_id,
                 json_agg(
                   json_build_object(
                     'id', ca.id,
                     'user_id', ca.user_id,
                     'card_id', ca.card_id,
                     'user_email', u.email,
                     'user_name', COALESCE(u.email, 'Usuario'),
                     'assigned_by', ca.assigned_by,
                     'assigned_at', ca.assigned_at,
                     'workload_hours', ca.workload_hours,
                     'assignment_order', ca.assignment_order
                   ) ORDER BY COALESCE(ca.assignment_order, 999) ASC
                 ) AS assignees
          FROM card_assignments ca
          JOIN usuarios u ON ca.user_id = u.id
          WHERE ca.card_id = $1
          GROUP BY ca.card_id
        ) assignees_agg ON c.id = assignees_agg.card_id
        LEFT JOIN (
          SELECT cl.card_id,
                 json_agg(
                   json_build_object(
                     'id', l.id,
                     'name', l.name,
                     'color', l.color,
                     'board_id', l.board_id
                   )
                 ) AS labels
          FROM card_labels cl
          JOIN labels l ON cl.label_id = l.id
          WHERE cl.card_id = $1
          GROUP BY cl.card_id
        ) labels_agg ON c.id = labels_agg.card_id
        WHERE c.id = $1
      `;
      
      const fullCardResult = await client.query(fullCardQuery, [id]);
      if (fullCardResult.rowCount === 0) {
        return updatedCard; // Fallback a la tarjeta básica si no se encuentra
      }
      
      const fullCard = fullCardResult.rows[0];
      fullCard.assignees = fullCard.assignees || [];
      fullCard.labels = fullCard.labels || [];

      // Agregar información del proyecto si existe
      if (fullCard.proyecto_id && fullCard.nombre_proyecto) {
        fullCard.proyecto = {
          id: fullCard.proyecto_id,
          nombre_proyecto: fullCard.nombre_proyecto,
          descripcion: fullCard.proyecto_descripcion,
          activo: fullCard.proyecto_activo,
          codigo: fullCard.proyecto_codigo,
          cod_integracion: fullCard.proyecto_cod_integracion,
          cadena: fullCard.proyecto_cadena,
          mercado: fullCard.proyecto_mercado,
          ciudad: fullCard.proyecto_ciudad,
          inmueble: fullCard.proyecto_inmueble,
          numero_obra_osmos: fullCard.proyecto_numero_obra_osmos,
          inicio_obra_prevista: fullCard.proyecto_inicio_obra_prevista,
          apert_espacio_prevista: fullCard.proyecto_apert_espacio_prevista,
          es_bim: fullCard.proyecto_es_bim
        };
      }

      // Emitir evento SSE de actualización de tarjeta
      // Obtener board_id desde la lista de la tarjeta
      const boardIdQuery = await client.query(
        'SELECT board_id FROM lists WHERE id = $1',
        [fullCard.list_id]
      );
      const boardId = boardIdQuery.rows[0]?.board_id;

      if (boardId) {
        SSEService.emitBoardEvent({
          type: 'card:updated',
          boardId,
          data: {
            card: fullCard
          }
        });
      }

      return fullCard;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.updateCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Elimina una tarjeta específica por su ID.
   */
  static async deleteCard(id: string): Promise<boolean> {
    // A diferencia de las listas, borrar una tarjeta no tiene efectos en cascada.
    // Pero sí necesitaremos reordenar las tarjetas restantes en su lista.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Obtener la list_id y la posición de la tarjeta que vamos a borrar.
      const cardMetaResult = await client.query(
        'SELECT list_id, position FROM cards WHERE id = $1',
        [id]
      );

      if (cardMetaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return false; // La tarjeta no existe
      }
      const { list_id, position } = cardMetaResult.rows[0];

      // 2. Obtener board_id antes de borrar la tarjeta
      const boardIdQuery = await client.query(
        'SELECT board_id FROM lists WHERE id = $1',
        [list_id]
      );
      const boardId = boardIdQuery.rows[0]?.board_id;

      // 3. Borrar la tarjeta.
      await client.query('DELETE FROM cards WHERE id = $1', [id]);

      // 4. Reordenar las tarjetas restantes en la misma lista.
      // Todas las tarjetas que estaban después de la borrada, deben retroceder una posición.
      await client.query(
        'UPDATE cards SET position = position - 1 WHERE list_id = $1 AND position > $2',
        [list_id, position]
      );

      await client.query('COMMIT');

      // Emitir evento SSE de eliminación de tarjeta
      if (boardId) {
        SSEService.emitBoardEvent({
          type: 'card:deleted',
          boardId,
          data: {
            cardId: id,
            listId: list_id
          }
        });
      }

      return true;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.deleteCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async moveCard(data: MoveCardPayload, userId: number): Promise<void> {
    const { cardId, sourceListId, targetListId, newIndex } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Obtener la posición original de la tarjeta que se está moviendo.
      const cardResult = await client.query('SELECT position FROM cards WHERE id = $1', [cardId]);
      if (cardResult.rowCount === 0) {
        throw new Error('La tarjeta a mover no existe.');
      }
      const originalIndex = cardResult.rows[0].position;

      // Obtener nombres de las listas para el registro de actividad
      let sourceListTitle = '';
      let targetListTitle = '';
      const needsActivityLog = sourceListId !== targetListId;

      if (needsActivityLog) {
        const listsQuery = `
          SELECT id, title FROM lists WHERE id = ANY($1)
        `;
        const listsResult = await client.query(listsQuery, [[sourceListId, targetListId]]);
        const sourceList = listsResult.rows.find((l: any) => l.id === sourceListId);
        const targetList = listsResult.rows.find((l: any) => l.id === targetListId);
        sourceListTitle = sourceList?.title || 'Lista origen';
        targetListTitle = targetList?.title || 'Lista destino';
      }

      // CASO A: Mover dentro de la misma lista
      if (sourceListId === targetListId) {
        // "Sacar" la tarjeta de su posición actual
        await client.query(
          'UPDATE cards SET position = -1 WHERE id = $1',
          [cardId]
        );

        // Si se mueve de una posición baja a una alta (ej: 1 -> 3)
        if (originalIndex < newIndex) {
          // Las tarjetas entre la posición antigua y la nueva retroceden un lugar.
          await client.query(
            'UPDATE cards SET position = position - 1 WHERE list_id = $1 AND position > $2 AND position <= $3',
            [sourceListId, originalIndex, newIndex]
          );
        }
        // Si se mueve de una posición alta a una baja (ej: 3 -> 1)
        else {
          // Las tarjetas entre la posición nueva y la antigua avanzan un lugar.
          await client.query(
            'UPDATE cards SET position = position + 1 WHERE list_id = $1 AND position >= $2 AND position < $3',
            [sourceListId, newIndex, originalIndex]
          );
        }
      }
      // CASO B: Mover a una lista diferente
      else {
        // 2a. Cerrar el hueco en la lista de origen.
        // Todas las tarjetas que estaban después de la movida retroceden una posición.
        await client.query(
          'UPDATE cards SET position = position - 1 WHERE list_id = $1 AND position > $2',
          [sourceListId, originalIndex]
        );

        // 2b. Hacer espacio en la lista de destino.
        // Todas las tarjetas en o después del nuevo índice avanzan una posición.
        await client.query(
          'UPDATE cards SET position = position + 1 WHERE list_id = $1 AND position >= $2',
          [targetListId, newIndex]
        );
      }

      // 3. Finalmente, actualizar la tarjeta movida a su nueva lista y posición.
      await client.query(
        'UPDATE cards SET list_id = $1, position = $2 WHERE id = $3',
        [targetListId, newIndex, cardId]
      );

      // 4. Registrar actividad solo si la tarjeta cambió de lista
      if (needsActivityLog) {
        const description = `movió esta tarjeta de "${sourceListTitle}" a "${targetListTitle}"`;
        const activityResult = await client.query(
          `INSERT INTO card_activity (card_id, user_id, activity_type, description)
           VALUES ($1, $2, 'ACTION', $3)
           RETURNING id`,
          [cardId, userId, description]
        );

        const activityId = activityResult.rows[0].id;

        // Crear notificaciones para usuarios asignados a la tarjeta
        const assigneesQuery = `
          SELECT user_id FROM card_assignments
          WHERE card_id = $1 AND user_id != $2
        `;
        const assigneesResult = await client.query(assigneesQuery, [cardId, userId]);

        // Importar NotificationService y crear notificaciones
        if (assigneesResult.rows.length > 0) {
          const { NotificationService } = await import('./notifications.helper');
          for (const row of assigneesResult.rows) {
            try {
              await NotificationService.createNotificationWithClient(client, row.user_id, activityId, description);
            } catch (notifError) {
              console.error(`Error creando notificación de movimiento para user_id=${row.user_id}:`, notifError);
            }
          }
        }
      }

      await client.query('COMMIT');

      // Emitir evento SSE de movimiento de tarjeta
      // Obtener board_id desde la lista de destino
      const boardIdQuery = await client.query(
        'SELECT board_id FROM lists WHERE id = $1',
        [targetListId]
      );
      const boardId = boardIdQuery.rows[0]?.board_id;

      if (boardId) {
        SSEService.emitBoardEvent({
          type: 'card:moved',
          boardId,
          data: {
            cardId,
            sourceListId,
            targetListId,
            newIndex,
            movedBetweenLists: sourceListId !== targetListId
          }
        });
      }

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.moveCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Mueve una tarjeta a un tablero diferente
   * Maneja la validación de permisos, filtrado de asignados y etiquetas
   */
  static async moveCardToBoard(data: MoveCardToBoardPayload, userId: number): Promise<void> {
    const { cardId, targetBoardId, targetListId, newIndex } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Obtener información de la tarjeta actual (board, list, assignees, labels)
      const cardQuery = `
        SELECT c.id, c.list_id, l.board_id, l.title as list_title
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        WHERE c.id = $1
      `;
      const cardResult = await client.query(cardQuery, [cardId]);

      if (cardResult.rowCount === 0) {
        throw new Error('La tarjeta a mover no existe.');
      }

      const card = cardResult.rows[0];
      const sourceBoardId = card.board_id;
      const sourceListId = card.list_id;

      // Si el tablero de destino es el mismo, usar el método moveCard normal
      if (sourceBoardId === targetBoardId) {
        await client.query('ROLLBACK');
        throw new Error('Para mover tarjetas dentro del mismo tablero, usa el endpoint /cards/move');
      }

      // 2. Verificar permisos del usuario en el tablero de destino
      const { PermissionService } = await import('../middleware/permissions');
      const hasPermission = await PermissionService.hasPermission(userId, targetBoardId, PermissionAction.MOVE_CARDS);

      if (!hasPermission) {
        throw new Error('No tienes permisos para mover tarjetas al tablero de destino.');
      }

      // 3. Obtener nombres de tableros para el registro de actividad
      const boardsQuery = `SELECT id, name FROM boards WHERE id = ANY($1)`;
      const boardsResult = await client.query(boardsQuery, [[sourceBoardId, targetBoardId]]);
      const sourceBoard = boardsResult.rows.find((b: any) => b.id === sourceBoardId);
      const targetBoard = boardsResult.rows.find((b: any) => b.id === targetBoardId);
      const sourceBoardName = sourceBoard?.name || 'Tablero origen';
      const targetBoardName = targetBoard?.name || 'Tablero destino';

      // 4. Verificar que la lista de destino existe y pertenece al tablero de destino
      const targetListQuery = `SELECT id FROM lists WHERE id = $1 AND board_id = $2`;
      const targetListResult = await client.query(targetListQuery, [targetListId, targetBoardId]);

      if (targetListResult.rowCount === 0) {
        throw new Error('La lista de destino no existe o no pertenece al tablero especificado.');
      }

      // 5. Obtener los miembros del tablero de destino
      const targetBoardMembersQuery = `SELECT user_id FROM board_members WHERE board_id = $1`;
      const targetBoardMembersResult = await client.query(targetBoardMembersQuery, [targetBoardId]);
      const targetBoardMemberIds = new Set(targetBoardMembersResult.rows.map((row: any) => row.user_id));

      // 6. Obtener los IDs de las etiquetas del tablero de destino
      const targetBoardLabelsQuery = `SELECT id FROM labels WHERE board_id = $1`;
      const targetBoardLabelsResult = await client.query(targetBoardLabelsQuery, [targetBoardId]);
      const targetBoardLabelIds = new Set(targetBoardLabelsResult.rows.map((row: any) => row.id));

      // 7. Obtener asignados actuales de la tarjeta
      const currentAssigneesQuery = `SELECT user_id FROM card_assignments WHERE card_id = $1`;
      const currentAssigneesResult = await client.query(currentAssigneesQuery, [cardId]);
      const currentAssignees = currentAssigneesResult.rows.map((row: any) => row.user_id);

      // 8. Filtrar asignados: mantener solo los que son miembros del tablero de destino
      const assigneesToRemove = currentAssignees.filter(uid => !targetBoardMemberIds.has(uid));

      if (assigneesToRemove.length > 0) {
        await client.query(
          `DELETE FROM card_assignments WHERE card_id = $1 AND user_id = ANY($2)`,
          [cardId, assigneesToRemove]
        );
        console.log(`✅ Eliminados ${assigneesToRemove.length} asignados que no son miembros del tablero de destino`);
      }

      // 9. Obtener etiquetas actuales de la tarjeta
      const currentLabelsQuery = `SELECT label_id FROM card_labels WHERE card_id = $1`;
      const currentLabelsResult = await client.query(currentLabelsQuery, [cardId]);
      const currentLabels = currentLabelsResult.rows.map((row: any) => row.label_id);

      // 10. Filtrar etiquetas: mantener solo las que existen en el tablero de destino
      const labelsToRemove = currentLabels.filter(lid => !targetBoardLabelIds.has(lid));

      if (labelsToRemove.length > 0) {
        await client.query(
          `DELETE FROM card_labels WHERE card_id = $1 AND label_id = ANY($2)`,
          [cardId, labelsToRemove]
        );
        console.log(`✅ Eliminadas ${labelsToRemove.length} etiquetas que no existen en el tablero de destino`);
      }

      // 11. Cerrar el hueco en la lista de origen
      const positionResult = await client.query('SELECT position FROM cards WHERE id = $1', [cardId]);
      const originalPosition = positionResult.rows[0].position;

      await client.query(
        'UPDATE cards SET position = position - 1 WHERE list_id = $1 AND position > $2',
        [sourceListId, originalPosition]
      );

      // 12. Hacer espacio en la lista de destino
      await client.query(
        'UPDATE cards SET position = position + 1 WHERE list_id = $1 AND position >= $2',
        [targetListId, newIndex]
      );

      // 13. Actualizar la tarjeta a la nueva lista y posición
      await client.query(
        'UPDATE cards SET list_id = $1, position = $2 WHERE id = $3',
        [targetListId, newIndex, cardId]
      );

      // 14. Registrar actividad
      const description = `movió esta tarjeta de "${sourceBoardName}" a "${targetBoardName}"`;
      const activityResult = await client.query(
        `INSERT INTO card_activity (card_id, user_id, activity_type, description)
         VALUES ($1, $2, 'ACTION', $3)
         RETURNING id`,
        [cardId, userId, description]
      );

      const activityId = activityResult.rows[0].id;

      // 15. Crear notificaciones para los asignados restantes (que no fueron removidos)
      const remainingAssigneesQuery = `
        SELECT user_id FROM card_assignments
        WHERE card_id = $1 AND user_id != $2
      `;
      const remainingAssigneesResult = await client.query(remainingAssigneesQuery, [cardId, userId]);

      if (remainingAssigneesResult.rows.length > 0) {
        const { NotificationService } = await import('./notifications.helper');
        for (const row of remainingAssigneesResult.rows) {
          try {
            await NotificationService.createNotificationWithClient(client, row.user_id, activityId, description);
          } catch (notifError) {
            console.error(`Error creando notificación de movimiento entre tableros para user_id=${row.user_id}:`, notifError);
          }
        }
      }

      await client.query('COMMIT');

      // 16. Emitir eventos SSE a ambos tableros
      SSEService.emitBoardEvent({
        type: 'card:moved',
        boardId: sourceBoardId,
        data: {
          cardId,
          sourceListId,
          targetListId,
          newIndex,
          movedToAnotherBoard: true,
          targetBoardId
        }
      });

      SSEService.emitBoardEvent({
        type: 'card:moved',
        boardId: targetBoardId,
        data: {
          cardId,
          sourceListId,
          targetListId,
          newIndex,
          movedFromAnotherBoard: true,
          sourceBoardId
        }
      });

      console.log(`✅ Tarjeta ${cardId} movida exitosamente de tablero ${sourceBoardId} a tablero ${targetBoardId}`);

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.moveCardToBoard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene todos los proyectos disponibles para asociar a tarjetas
   */
  static async getAvailableProjects(): Promise<any[]> {
    const client = await pool.connect();
    try {
      const query = `
        SELECT id, nombre_proyecto, descripcion, activo,
               codigo, cod_integracion, cadena, mercado, ciudad, inmueble,
               numero_obra_osmos, inicio_obra_prevista, apert_espacio_prevista, es_bim
        FROM proyectos
        WHERE activo = true
        ORDER BY nombre_proyecto ASC
      `;
      const result = await client.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error en CardService.getAvailableProjects:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Busca tarjetas en todos los tableros accesibles por el usuario
   */
  static async searchCards(
    userId: number,
    filters: {
      searchTerm?: string;
      projectIds?: number[];
      boardIds?: number[];
      userIds?: number[];
      labelIds?: number[];
      hideCompleted?: boolean;
      startDateFrom?: string;
      startDateTo?: string;
      dueDateFrom?: string;
      dueDateTo?: string;
    }
  ): Promise<any[]> {
    const client = await pool.connect();
    try {
      const { searchTerm, projectIds, boardIds, userIds, labelIds, hideCompleted, startDateFrom, startDateTo, dueDateFrom, dueDateTo } = filters;

      // Query base que incluye joins con proyectos, usuarios asignados y tableros
      let query = `
        SELECT DISTINCT
          c.id,
          c.title,
          c.description,
          c.list_id,
          c.position,
          c.progress,
          c.start_date,
          c.due_date,
          c.proyecto_id,
          l.title as list_title,
          l.board_id,
          b.name as board_name,
          p.nombre_proyecto,
          p.codigo as proyecto_codigo,
          p.cadena as proyecto_cadena,
          p.inmueble as proyecto_inmueble,
          COALESCE(
            jsonb_agg(
              DISTINCT jsonb_build_object(
                'id', u.id,
                'name', u.name
              )
            ) FILTER (WHERE u.id IS NOT NULL),
            '[]'::jsonb
          ) as assigned_users,
          COALESCE(
            jsonb_agg(
              DISTINCT jsonb_build_object(
                'id', lb.id,
                'name', lb.name,
                'color', lb.color
              )
            ) FILTER (WHERE lb.id IS NOT NULL),
            '[]'::jsonb
          ) as labels
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        LEFT JOIN proyectos p ON c.proyecto_id = p.id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        LEFT JOIN usuarios u ON ca.user_id = u.id
        LEFT JOIN card_labels cl ON c.id = cl.card_id
        LEFT JOIN labels lb ON cl.label_id = lb.id
        WHERE EXISTS (
          SELECT 1 FROM board_members bm
          WHERE bm.board_id = b.id AND bm.user_id = $1
        )
      `;

      const params: any[] = [userId];
      let paramIndex = 2;

      // Filtro de búsqueda de texto
      if (searchTerm && searchTerm.trim()) {
        query += ` AND (
          c.title ILIKE $${paramIndex} OR
          c.description ILIKE $${paramIndex}
        )`;
        params.push(`%${searchTerm.trim()}%`);
        paramIndex++;
      }

      // Filtro por proyectos
      if (projectIds && projectIds.length > 0) {
        query += ` AND c.proyecto_id = ANY($${paramIndex})`;
        params.push(projectIds);
        paramIndex++;
      }

      // Filtro por tableros
      if (boardIds && boardIds.length > 0) {
        query += ` AND b.id = ANY($${paramIndex})`;
        params.push(boardIds);
        paramIndex++;
      }

      // Filtro por usuarios asignados
      if (userIds && userIds.length > 0) {
        query += ` AND EXISTS (
          SELECT 1 FROM card_assignments ca2
          WHERE ca2.card_id = c.id AND ca2.user_id = ANY($${paramIndex})
        )`;
        params.push(userIds);
        paramIndex++;
      }

      // Filtro por labels
      if (labelIds && labelIds.length > 0) {
        query += ` AND EXISTS (
          SELECT 1 FROM card_labels cl2
          WHERE cl2.card_id = c.id AND cl2.label_id = ANY($${paramIndex})
        )`;
        params.push(labelIds);
        paramIndex++;
      }

      // Filtro por fecha de inicio (desde)
      if (startDateFrom) {
        query += ` AND c.start_date >= $${paramIndex}`;
        params.push(startDateFrom);
        paramIndex++;
      }

      // Filtro por fecha de inicio (hasta)
      if (startDateTo) {
        query += ` AND c.start_date <= $${paramIndex}`;
        params.push(startDateTo);
        paramIndex++;
      }

      // Filtro por fecha de vencimiento (desde)
      if (dueDateFrom) {
        query += ` AND c.due_date >= $${paramIndex}`;
        params.push(dueDateFrom);
        paramIndex++;
      }

      // Filtro por fecha de vencimiento (hasta)
      if (dueDateTo) {
        query += ` AND c.due_date <= $${paramIndex}`;
        params.push(dueDateTo);
        paramIndex++;
      }

      // Filtro para ocultar completadas
      if (hideCompleted) {
        query += ` AND (c.progress IS NULL OR c.progress < 100)`;
      }

      query += `
        GROUP BY c.id, l.title, l.board_id, b.name, p.nombre_proyecto, p.codigo, p.cadena, p.inmueble
        ORDER BY c.id DESC
        LIMIT 100
      `;

      console.log('🔍 [SearchCards] Query:', query);
      console.log('🔍 [SearchCards] Params:', params);

      const result = await client.query(query, params);

      console.log('✅ [SearchCards] Resultados encontrados:', result.rows.length);

      return result.rows;
    } catch (error) {
      console.error('❌ Error en CardService.searchCards:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Lógica de Controlador (CardController)
// ================================
class CardController {
  static async create(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const data: CreateCardPayload = await c.req.json();

      if (typeof data.title !== 'string' || !data.list_id || typeof data.list_id !== 'number') {
        return c.json({ error: 'Los campos "title" (string) y "list_id" (number) son requeridos' }, 400);
      }

      const newCard = await CardService.createCard(data, user.userId);
      return c.json(newCard, 201);

    } catch (error: any) {
      console.error('Error en CardController.create:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo crear la tarjeta' }, 500);
    }
  }
    static async update(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const id = c.req.param('id');
      const data: UpdateCardPayload = await c.req.json();

      if (Object.keys(data).length === 0) {
        return c.json({ error: 'El cuerpo de la petición no puede estar vacío.' }, 400);
      }

      const updatedCard = await CardService.updateCard(id, data, user.userId);

      if (!updatedCard) {
        return c.json({ error: `Tarjeta con ID ${id} no encontrada` }, 404);
      }

      return c.json(updatedCard, 200);

    } catch (error: any) {
      console.error(`Error en CardController.update para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'No se pudo actualizar la tarjeta' }, 500);
    }
  }

  /**
   * Maneja la eliminación de una tarjeta.
   */
  static async delete(c: Context) {
    try {
      const id = c.req.param('id');
      const wasDeleted = await CardService.deleteCard(id);

      if (!wasDeleted) {
        return c.json({ error: `Tarjeta con ID ${id} no encontrada` }, 404);
      }

      return c.body(null, 204);

    } catch (error: any) {
      console.error(`Error en CardController.delete para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'No se pudo eliminar la tarjeta' }, 500);
    }
  }
  static async move(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const data: MoveCardPayload = await c.req.json();

      // DEBUG: Agregar logging para ver qué datos se están recibiendo
      console.log('=== BACKEND CARD MOVE DEBUG ===');
      console.log('Datos recibidos:', JSON.stringify(data, null, 2));
      console.log('Tipos de datos:');
      console.log('- cardId:', typeof data.cardId, 'valor:', data.cardId);
      console.log('- sourceListId:', typeof data.sourceListId, 'valor:', data.sourceListId);
      console.log('- targetListId:', typeof data.targetListId, 'valor:', data.targetListId);
      console.log('- newIndex:', typeof data.newIndex, 'valor:', data.newIndex);
      console.log('===============================');

      // Validación y conversión de tipos si es necesario
      const cardId = String(data.cardId);
      const sourceListId = typeof data.sourceListId === 'string' ? parseInt(data.sourceListId) : data.sourceListId;
      const targetListId = typeof data.targetListId === 'string' ? parseInt(data.targetListId) : data.targetListId;
      const newIndex = typeof data.newIndex === 'string' ? parseInt(data.newIndex) : data.newIndex;

      // Validación básica
      if (!cardId || isNaN(sourceListId) || isNaN(targetListId) || isNaN(newIndex)) {
        console.log('❌ Error de validación:');
        console.log('- cardId válido:', !!cardId);
        console.log('- sourceListId válido:', !isNaN(sourceListId));
        console.log('- targetListId válido:', !isNaN(targetListId));
        console.log('- newIndex válido:', !isNaN(newIndex));
        return c.json({
          error: 'Parámetros inválidos',
          details: {
            cardId: !!cardId,
            sourceListId: !isNaN(sourceListId),
            targetListId: !isNaN(targetListId),
            newIndex: !isNaN(newIndex)
          }
        }, 400);
      }

      const moveData = {
        cardId,
        sourceListId,
        targetListId,
        newIndex
      };

      console.log('✅ Datos procesados para CardService.moveCard:', moveData);

      await CardService.moveCard(moveData, user.userId);

      console.log('✅ Tarjeta movida exitosamente');

      // La operación fue exitosa, no es necesario devolver contenido.
      return c.body(null, 204);

    } catch (error: any) {
      console.error('❌ Error en CardController.move:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo mover la tarjeta', details: error.message }, 500);
    }
  }

  /**
   * Maneja el movimiento de una tarjeta a un tablero diferente
   */
  static async moveToBoard(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const data: MoveCardToBoardPayload = await c.req.json();

      console.log('=== BACKEND CARD MOVE TO BOARD DEBUG ===');
      console.log('Datos recibidos:', JSON.stringify(data, null, 2));
      console.log('=========================================');

      // Validación y conversión de tipos
      const cardId = String(data.cardId);
      const targetBoardId = typeof data.targetBoardId === 'string' ? parseInt(data.targetBoardId) : data.targetBoardId;
      const targetListId = typeof data.targetListId === 'string' ? parseInt(data.targetListId) : data.targetListId;
      const newIndex = typeof data.newIndex === 'string' ? parseInt(data.newIndex) : data.newIndex;

      // Validación básica
      if (!cardId || isNaN(targetBoardId) || isNaN(targetListId) || isNaN(newIndex)) {
        console.log('❌ Error de validación en moveToBoard');
        return c.json({
          error: 'Parámetros inválidos',
          details: {
            cardId: !!cardId,
            targetBoardId: !isNaN(targetBoardId),
            targetListId: !isNaN(targetListId),
            newIndex: !isNaN(newIndex)
          }
        }, 400);
      }

      const moveData = {
        cardId,
        targetBoardId,
        targetListId,
        newIndex
      };

      console.log('✅ Datos procesados para CardService.moveCardToBoard:', moveData);

      await CardService.moveCardToBoard(moveData, user.userId);

      console.log('✅ Tarjeta movida exitosamente a otro tablero');

      return c.body(null, 204);

    } catch (error: any) {
      console.error('❌ Error en CardController.moveToBoard:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      if (error.message.includes('permisos')) {
        return c.json({ error: error.message }, 403);
      }
      return c.json({ error: 'No se pudo mover la tarjeta a otro tablero', details: error.message }, 500);
    }
  }

  /**
   * Obtiene todos los proyectos disponibles para asociar a tarjetas
   */
  static async getProjects(c: Context) {
    try {
      const projects = await CardService.getAvailableProjects();
      return c.json(projects, 200);
    } catch (error: any) {
      console.error('Error en CardController.getProjects:', error);
      return c.json({ error: 'No se pudieron obtener los proyectos' }, 500);
    }
  }

  /**
   * Busca tarjetas en todos los tableros accesibles por el usuario
   */
  static async search(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      // Obtener parámetros de query
      const searchTerm = c.req.query('searchTerm');
      const projectIdsParam = c.req.query('projectIds');
      const boardIdsParam = c.req.query('boardIds');
      const userIdsParam = c.req.query('userIds');
      const labelIdsParam = c.req.query('labelIds');
      const hideCompleted = c.req.query('hideCompleted') === 'true';
      const startDateFrom = c.req.query('startDateFrom');
      const startDateTo = c.req.query('startDateTo');
      const dueDateFrom = c.req.query('dueDateFrom');
      const dueDateTo = c.req.query('dueDateTo');

      // Parsear arrays de IDs
      const projectIds = projectIdsParam ? projectIdsParam.split(',').map(Number).filter(n => !isNaN(n)) : undefined;
      const boardIds = boardIdsParam ? boardIdsParam.split(',').map(Number).filter(n => !isNaN(n)) : undefined;
      const userIds = userIdsParam ? userIdsParam.split(',').map(Number).filter(n => !isNaN(n)) : undefined;
      const labelIds = labelIdsParam ? labelIdsParam.split(',').map(Number).filter(n => !isNaN(n)) : undefined;

      console.log('🔍 [CardController.search] Filtros recibidos:', {
        searchTerm,
        projectIds,
        boardIds,
        userIds,
        labelIds,
        hideCompleted,
        startDateFrom,
        startDateTo,
        dueDateFrom,
        dueDateTo
      });

      const cards = await CardService.searchCards(user.userId, {
        searchTerm,
        projectIds,
        boardIds,
        userIds,
        labelIds,
        hideCompleted,
        startDateFrom,
        startDateTo,
        dueDateFrom,
        dueDateTo
      });

      return c.json(cards, 200);
    } catch (error: any) {
      console.error('❌ Error en CardController.search:', error);
      return c.json({ error: 'Error al buscar tarjetas', details: error.message }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Tarjetas
// ================================
export const cardRoutes = new Hono<{ Variables: Variables }>();

cardRoutes.use('*', keycloakAuthMiddleware);

// Endpoint para crear una nueva tarjeta
cardRoutes.post('/cards', requirePermission(PermissionAction.CREATE_CARDS), CardController.create);
cardRoutes.put('/cards/:id', requirePermission(PermissionAction.EDIT_CARDS), CardController.update);
cardRoutes.delete('/cards/:id', requirePermission(PermissionAction.DELETE_CARDS), CardController.delete);
cardRoutes.patch('/cards/move', requirePermission(PermissionAction.MOVE_CARDS), CardController.move);
cardRoutes.patch('/cards/move-to-board', requirePermission(PermissionAction.MOVE_CARDS), CardController.moveToBoard);

// Endpoint para obtener proyectos disponibles
cardRoutes.get('/cards/projects', CardController.getProjects);

// Endpoint para buscar tarjetas en todos los tableros
cardRoutes.get('/cards/search', CardController.search);