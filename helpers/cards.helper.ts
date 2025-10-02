// En: src/helpers/cards.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import { requirePermission } from '../middleware/permissions';
import type { Variables } from '../types';
import { PermissionAction } from '../types';
import type { Card, CreateCardPayload, UpdateCardPayload, MoveCardPayload } from '../types/kanban.types';
import { validateDates, formatDateForDB, parseDate } from '../utils/dateUtils';

// ================================
// Lógica de Servicio (CardService)
// ================================
class CardService {
  /**
   * Crea una nueva tarjeta en una lista específica.
   * Calcula automáticamente la posición para que se añada al final.
   */
  static async createCard(data: CreateCardPayload): Promise<Card> {
    const { title, list_id, proyecto_id } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Comprobar si la lista existe.
      const listCheck = await client.query('SELECT id FROM lists WHERE id = $1', [list_id]);
      if (listCheck.rowCount === 0) {
        throw new Error('La lista especificada no existe.');
      }

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

      await client.query('COMMIT');

      const newCard = result.rows[0];

      // Si hay proyecto_id, obtener la información del proyecto
      if (newCard.proyecto_id) {
        const projectQuery = `
          SELECT id, nombre_proyecto, descripcion, activo, codigo, cod_integracion, cadena, mercado, ciudad, inmueble,
                 numero_obra_osmos, inicio_obra_prevista, apert_espacio_prevista, es_bim
          FROM proyectos
          WHERE id = $1
        `;
        const projectResult = await client.query(projectQuery, [newCard.proyecto_id]);

        if (projectResult.rowCount > 0) {
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

      return newCard as Card;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.createCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  static async updateCard(id: string, data: UpdateCardPayload): Promise<Card | null> {
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
        
        // Eliminar asignaciones actuales
        await client.query('DELETE FROM card_assignments WHERE card_id = $1', [id]);

        // Agregar nuevas asignaciones
        if (assignees.length > 0) {
          // Verificar que todos los usuarios existen
          const usersCheck = await client.query(
            'SELECT id FROM usuarios WHERE id = ANY($1)',
            [assignees]
          );

          if (usersCheck.rowCount !== assignees.length) {
            throw new Error('Uno o más usuarios especificados no existen');
          }

          // Insertar nuevas asignaciones
          for (const userId of assignees) {
            await client.query(
              'INSERT INTO card_assignments (card_id, user_id, assigned_by) VALUES ($1, $2, $3)',
              [id, userId, 1] // TODO: Usar el ID del usuario que está haciendo la asignación
            );
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
                     'assigned_at', ca.assigned_at
                   )
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

      // 2. Borrar la tarjeta.
      await client.query('DELETE FROM cards WHERE id = $1', [id]);

      // 3. Reordenar las tarjetas restantes en la misma lista.
      // Todas las tarjetas que estaban después de la borrada, deben retroceder una posición.
      await client.query(
        'UPDATE cards SET position = position - 1 WHERE list_id = $1 AND position > $2',
        [list_id, position]
      );
      
      await client.query('COMMIT');
      return true;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.deleteCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async moveCard(data: MoveCardPayload): Promise<void> {
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

      await client.query('COMMIT');

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.moveCard:', error);
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
}

// ================================
// Lógica de Controlador (CardController)
// ================================
class CardController {
  static async create(c: Context) {
    try {
      const data: CreateCardPayload = await c.req.json();

      if (typeof data.title !== 'string' || !data.list_id || typeof data.list_id !== 'number') {
        return c.json({ error: 'Los campos "title" (string) y "list_id" (number) son requeridos' }, 400);
      }

      const newCard = await CardService.createCard(data);
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
      const id = c.req.param('id');
      const data: UpdateCardPayload = await c.req.json();

      if (Object.keys(data).length === 0) {
        return c.json({ error: 'El cuerpo de la petición no puede estar vacío.' }, 400);
      }

      const updatedCard = await CardService.updateCard(id, data);

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

      await CardService.moveCard(moveData);

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

// Endpoint para obtener proyectos disponibles
cardRoutes.get('/cards/projects', CardController.getProjects);