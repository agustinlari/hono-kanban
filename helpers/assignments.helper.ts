// helpers/assignments.helper.ts - Gestión de asignaciones de usuarios a tarjetas

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import { requirePermission } from '../middleware/permissions';
import type { Variables } from '../types';
import { PermissionAction } from '../types';
import type { CardAssignee, AssignUserPayload, UnassignUserPayload, AssignmentResponse } from '../types/kanban.types';
import { ActivityService } from './activity.helper';
import { SSEService } from './sse.helper';

// ================================
// Lógica de Servicio (AssignmentService)
// ================================
class AssignmentService {
  /**
   * Obtiene todos los usuarios asignados a una tarjeta
   */
  static async getCardAssignees(cardId: string): Promise<CardAssignee[]> {
    const query = `
      SELECT
        ca.id,
        ca.card_id,
        ca.user_id,
        ca.assigned_by,
        ca.assigned_at,
        ca.workload_hours,
        ca.assignment_order,
        u.email as user_email,
        u.email as user_name
      FROM card_assignments ca
      INNER JOIN usuarios u ON ca.user_id = u.id
      WHERE ca.card_id = $1
      ORDER BY COALESCE(ca.assignment_order, 999), ca.assigned_at ASC
    `;

    const result = await pool.query(query, [cardId]);
    return result.rows as CardAssignee[];
  }

  /**
   * Asigna un usuario a una tarjeta
   */
  static async assignUserToCard(cardId: string, userId: number, assignedBy: number): Promise<CardAssignee> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que la tarjeta existe
      const cardCheck = await client.query('SELECT id FROM cards WHERE id = $1', [cardId]);
      if (!cardCheck.rowCount || cardCheck.rowCount === 0) {
        throw new Error('La tarjeta especificada no existe');
      }

      // Verificar que el usuario a asignar existe
      const userCheck = await client.query('SELECT id, email FROM usuarios WHERE id = $1', [userId]);
      if (!userCheck.rowCount || userCheck.rowCount === 0) {
        throw new Error('El usuario especificado no existe');
      }

      // Verificar que no esté ya asignado
      const existingAssignment = await client.query(
        'SELECT id FROM card_assignments WHERE card_id = $1 AND user_id = $2',
        [cardId, userId]
      );

      if (existingAssignment.rowCount && existingAssignment.rowCount > 0) {
        throw new Error('El usuario ya está asignado a esta tarjeta');
      }

      // Calcular el próximo assignment_order (automático)
      const orderQuery = await client.query(
        'SELECT COALESCE(MAX(assignment_order), 0) + 1 as next_order FROM card_assignments WHERE card_id = $1',
        [cardId]
      );
      const nextOrder = orderQuery.rows[0].next_order;

      // Crear la asignación con workload_hours por defecto en 0
      const insertQuery = `
        INSERT INTO card_assignments (card_id, user_id, assigned_by, workload_hours, assignment_order)
        VALUES ($1, $2, $3, 0, $4)
        RETURNING id, assigned_at, workload_hours, assignment_order
      `;

      const insertResult = await client.query(insertQuery, [cardId, userId, assignedBy, nextOrder]);
      const assignment = insertResult.rows[0];

      // Retornar la asignación completa con datos del usuario
      const userData = userCheck.rows[0];
      const assignedUserName = userData.name || userData.email;

      console.log(`🎯 [ASSIGNMENT] Asignando usuario ${userId} (${assignedUserName}) a tarjeta ${cardId} por usuario ${assignedBy}`);

      // Registrar actividad de asignación
      const description = `asignó a ${assignedUserName}`;
      const activityResult = await client.query(
        `INSERT INTO card_activity (card_id, user_id, activity_type, description)
         VALUES ($1, $2, 'ACTION', $3)
         RETURNING id`,
        [cardId, assignedBy, description]
      );

      const activityId = activityResult.rows[0].id;
      console.log(`✅ [ASSIGNMENT] Actividad creada con id=${activityId}`);

      // Crear notificación para el usuario asignado (si no es el mismo que asigna)
      if (userId !== assignedBy) {
        console.log(`🔔 [ASSIGNMENT] Creando notificación para usuario ${userId}`);
        try {
          const { NotificationService } = await import('./notifications.helper');
          await NotificationService.createNotificationWithClient(client, userId, activityId, description);
          console.log(`✅ [ASSIGNMENT] Notificación creada exitosamente`);
        } catch (notifError) {
          console.error(`❌ [ASSIGNMENT] Error creando notificación de asignación:`, notifError);
        }

        // Verificar si el usuario tiene emails habilitados para este tipo de notificación
        console.log(`📧 [ASSIGNMENT] Verificando preferencias de email para usuario ${userId}`);
        try {
          const { NotificationPreferenceService } = await import('./notification-preferences.helper');
          const emailEnabled = await NotificationPreferenceService.isEmailEnabled(userId, 'card_assigned');

          if (emailEnabled) {
            console.log(`📧 [ASSIGNMENT] Email habilitado, enviando notificación por email`);

            // Obtener información adicional para el email
            const cardQuery = await client.query(
              `SELECT c.title, c.id, l.board_id, b.name as board_name
               FROM cards c
               JOIN lists l ON c.list_id = l.id
               JOIN boards b ON l.board_id = b.id
               WHERE c.id = $1`,
              [cardId]
            );

            const assignerQuery = await client.query(
              'SELECT name, email FROM usuarios WHERE id = $1',
              [assignedBy]
            );

            if (cardQuery.rowCount && cardQuery.rowCount > 0 && assignerQuery.rowCount && assignerQuery.rowCount > 0) {
              const cardData = cardQuery.rows[0];
              const assignerData = assignerQuery.rows[0];

              const { emailService } = await import('../services/email.service');
              const { emailSettings } = await import('../config/email.config');

              const cardUrl = `${emailSettings.appUrl}/kanban/?board=${cardData.board_id}&card=${cardId}`;

              await emailService.sendCardAssignedNotification({
                userEmail: userData.email,
                userName: assignedUserName,
                cardTitle: cardData.title,
                boardName: cardData.board_name,
                cardUrl: cardUrl,
                assignedBy: assignerData.name || assignerData.email
              });

              console.log(`✅ [ASSIGNMENT] Email enviado exitosamente a ${userData.email}`);
            }
          } else {
            console.log(`⏭️ [ASSIGNMENT] Email deshabilitado para usuario ${userId}`);
          }
        } catch (emailError) {
          console.error(`❌ [ASSIGNMENT] Error enviando email de asignación:`, emailError);
          // No fallar la operación si el email falla
        }
      } else {
        console.log(`⏭️ [ASSIGNMENT] No se crea notificación (usuario se asigna a sí mismo)`);
      }

      await client.query('COMMIT');

      const assigneeData = {
        id: assignment.id,
        card_id: cardId,
        user_id: userId,
        user_email: userData.email,
        user_name: userData.email,
        assigned_by: assignedBy,
        assigned_at: assignment.assigned_at,
        workload_hours: assignment.workload_hours,
        assignment_order: assignment.assignment_order
      };

      // Emitir evento SSE para actualizar la tarjeta en todos los clientes
      try {
        // Obtener el boardId de la tarjeta
        const boardQuery = await pool.query(`
          SELECT l.board_id, c.*
          FROM cards c
          JOIN lists l ON c.list_id = l.id
          WHERE c.id = $1
        `, [cardId]);

        if (boardQuery.rowCount && boardQuery.rowCount > 0) {
          const boardId = boardQuery.rows[0].board_id;
          const card = boardQuery.rows[0];

          console.log(`📡 [SSE] Emitiendo evento card:updated para board ${boardId}`);
          await SSEService.emitBoardEvent({
            type: 'card:updated',
            boardId: boardId,
            data: { card }
          });
        }
      } catch (sseError) {
        console.error('❌ Error emitiendo evento SSE de asignación:', sseError);
        // No fallar la operación si SSE falla
      }

      return assigneeData;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en AssignmentService.assignUserToCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Desasigna un usuario de una tarjeta
   */
  static async unassignUserFromCard(cardId: string, userId: number, requestingUserId: number): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que la asignación existe y obtener datos del usuario
      const assignmentCheck = await client.query(
        `SELECT ca.id, u.name, u.email
         FROM card_assignments ca
         JOIN usuarios u ON ca.user_id = u.id
         WHERE ca.card_id = $1 AND ca.user_id = $2`,
        [cardId, userId]
      );

      if (!assignmentCheck.rowCount || assignmentCheck.rowCount === 0) {
        throw new Error('El usuario no está asignado a esta tarjeta');
      }

      const userData = assignmentCheck.rows[0];
      const unassignedUserName = userData.name || userData.email;

      // Eliminar la asignación
      const deleteResult = await client.query(
        'DELETE FROM card_assignments WHERE card_id = $1 AND user_id = $2',
        [cardId, userId]
      );

      // Registrar actividad de desasignación
      await ActivityService.createAction(
        cardId,
        requestingUserId,
        `eliminó a ${unassignedUserName}`
      );

      await client.query('COMMIT');

      const success = deleteResult.rowCount !== null && deleteResult.rowCount > 0;

      // Emitir evento SSE para actualizar la tarjeta en todos los clientes
      if (success) {
        try {
          // Obtener el boardId de la tarjeta
          const boardQuery = await pool.query(`
            SELECT l.board_id, c.*
            FROM cards c
            JOIN lists l ON c.list_id = l.id
            WHERE c.id = $1
          `, [cardId]);

          if (boardQuery.rowCount && boardQuery.rowCount > 0) {
            const boardId = boardQuery.rows[0].board_id;
            const card = boardQuery.rows[0];

            console.log(`📡 [SSE] Emitiendo evento card:updated para board ${boardId} (desasignación)`);
            await SSEService.emitBoardEvent({
              type: 'card:updated',
              boardId: boardId,
              data: { card }
            });
          }
        } catch (sseError) {
          console.error('❌ Error emitiendo evento SSE de desasignación:', sseError);
          // No fallar la operación si SSE falla
        }
      }

      return success;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en AssignmentService.unassignUserFromCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene todas las tarjetas asignadas a un usuario específico
   */
  static async getUserAssignedCards(userId: number): Promise<any[]> {
    const query = `
      SELECT
        c.id,
        c.title,
        c.description,
        c.image_url,
        c.start_date,
        c.due_date,
        c.progress,
        c.proyecto_id,
        l.id as list_id,
        l.title as list_name,
        b.id as board_id,
        b.name as board_name,
        p.codigo as proyecto_codigo,
        p.nombre_proyecto as proyecto_nombre,
        ca.assigned_at,
        ca.workload_hours
      FROM card_assignments ca
      INNER JOIN cards c ON ca.card_id = c.id
      INNER JOIN lists l ON c.list_id = l.id
      INNER JOIN boards b ON l.board_id = b.id
      LEFT JOIN proyectos p ON c.proyecto_id = p.id
      WHERE ca.user_id = $1
      ORDER BY ca.assigned_at DESC
    `;

    const result = await pool.query(query, [userId]);

    // Formatear los resultados para incluir el objeto proyecto si existe
    return result.rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      image_url: row.image_url,
      start_date: row.start_date,
      due_date: row.due_date,
      progress: row.progress,
      list_id: row.list_id,
      list_name: row.list_name,
      board_id: row.board_id,
      board_name: row.board_name,
      assigned_at: row.assigned_at,
      workload_hours: row.workload_hours,
      proyecto: row.proyecto_id ? {
        id: row.proyecto_id,
        codigo: row.proyecto_codigo,
        nombre_proyecto: row.proyecto_nombre
      } : null
    }));
  }

  /**
   * Actualiza todas las asignaciones de una tarjeta (reemplaza las existentes)
   */
  static async updateCardAssignments(cardId: string, userIds: number[], assignedBy: number): Promise<CardAssignee[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que la tarjeta existe
      const cardCheck = await client.query('SELECT id FROM cards WHERE id = $1', [cardId]);
      if (!cardCheck.rowCount || cardCheck.rowCount === 0) {
        throw new Error('La tarjeta especificada no existe');
      }

      // Eliminar asignaciones actuales
      await client.query('DELETE FROM card_assignments WHERE card_id = $1', [cardId]);

      // Si no hay usuarios para asignar, retornar array vacío
      if (!userIds || userIds.length === 0) {
        await client.query('COMMIT');
        return [];
      }

      // Verificar que todos los usuarios existen
      const usersCheck = await client.query(
        'SELECT id, email FROM usuarios WHERE id = ANY($1)',
        [userIds]
      );

      if (!usersCheck.rowCount || usersCheck.rowCount !== userIds.length) {
        throw new Error('Uno o más usuarios especificados no existen');
      }

      // Crear las nuevas asignaciones
      const assignments: CardAssignee[] = [];
      let orderCounter = 1;
      for (const userId of userIds) {
        const insertResult = await client.query(
          'INSERT INTO card_assignments (card_id, user_id, assigned_by, workload_hours, assignment_order) VALUES ($1, $2, $3, 0, $4) RETURNING id, assigned_at, workload_hours, assignment_order',
          [cardId, userId, assignedBy, orderCounter]
        );

        const userData = usersCheck.rows.find((u: any) => u.id === userId);
        assignments.push({
          id: insertResult.rows[0].id,
          card_id: cardId,
          user_id: userId,
          user_email: userData.email,
          user_name: userData.email,
          assigned_by: assignedBy,
          assigned_at: insertResult.rows[0].assigned_at,
          workload_hours: insertResult.rows[0].workload_hours,
          assignment_order: insertResult.rows[0].assignment_order
        });
        orderCounter++;
      }

      await client.query('COMMIT');
      return assignments;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en AssignmentService.updateCardAssignments:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Lógica de Controlador (AssignmentController)
// ================================
class AssignmentController {
  /**
   * GET /cards/:cardId/assignees - Obtener usuarios asignados a una tarjeta
   */
  static async getCardAssignees(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    if (!cardId) return c.json({ error: 'ID de tarjeta requerido' }, 400);

    try {
      const assignees = await AssignmentService.getCardAssignees(cardId);
      return c.json({ assignees });
    } catch (error: any) {
      console.error(`Error obteniendo asignaciones de tarjeta ${cardId}:`, error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * POST /cards/:cardId/assignees - Asignar usuario a una tarjeta
   */
  static async assignUserToCard(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    if (!cardId) return c.json({ error: 'ID de tarjeta requerido' }, 400);

    try {
      const { user_id } = await c.req.json();
      if (!user_id) return c.json({ error: 'ID de usuario requerido' }, 400);

      const assignment = await AssignmentService.assignUserToCard(cardId, user_id, user.userId);
      
      return c.json({
        message: 'Usuario asignado exitosamente',
        assignment
      }, 201);
    } catch (error: any) {
      console.error(`Error asignando usuario a tarjeta ${cardId}:`, error);
      
      if (error.message.includes('no existe') || error.message.includes('ya está asignado')) {
        return c.json({ error: error.message }, 400);
      }
      
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * DELETE /cards/:cardId/assignees/:userId - Desasignar usuario de una tarjeta
   */
  static async unassignUserFromCard(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    const userId = parseInt(c.req.param('userId'));

    if (!cardId || isNaN(userId)) {
      return c.json({ error: 'ID de tarjeta e ID de usuario requeridos' }, 400);
    }

    try {
      const success = await AssignmentService.unassignUserFromCard(cardId, userId, user.userId);
      
      if (success) {
        return c.json({ message: 'Usuario desasignado exitosamente' });
      } else {
        return c.json({ error: 'No se pudo desasignar el usuario' }, 500);
      }
    } catch (error: any) {
      console.error(`Error desasignando usuario ${userId} de tarjeta ${cardId}:`, error);
      
      if (error.message.includes('no está asignado')) {
        return c.json({ error: error.message }, 400);
      }
      
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * PUT /cards/:cardId/assignees - Actualizar todas las asignaciones de una tarjeta
   */
  static async updateCardAssignments(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    if (!cardId) return c.json({ error: 'ID de tarjeta requerido' }, 400);

    try {
      const { user_ids } = await c.req.json();
      
      // user_ids puede ser un array vacío para desasignar a todos
      if (!Array.isArray(user_ids)) {
        return c.json({ error: 'user_ids debe ser un array' }, 400);
      }

      const assignments = await AssignmentService.updateCardAssignments(cardId, user_ids, user.userId);
      
      return c.json({
        message: 'Asignaciones actualizadas exitosamente',
        assignees: assignments
      });
    } catch (error: any) {
      console.error(`Error actualizando asignaciones de tarjeta ${cardId}:`, error);
      
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 400);
      }
      
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * GET /users/me/assigned-cards - Obtener tarjetas asignadas al usuario actual
   */
  static async getUserAssignedCards(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    try {
      const cards = await AssignmentService.getUserAssignedCards(user.userId);
      return c.json({ cards });
    } catch (error: any) {
      console.error(`Error obteniendo tarjetas asignadas al usuario ${user.userId}:`, error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }
}

// ================================
// Definición y Exportación de Rutas
// ================================
export const assignmentRoutes = new Hono<{ Variables: Variables }>();

// Rutas para gestionar asignaciones de tarjetas
assignmentRoutes.get('/cards/:cardId/assignees', keycloakAuthMiddleware, AssignmentController.getCardAssignees);
assignmentRoutes.post('/cards/:cardId/assignees', keycloakAuthMiddleware, requirePermission(PermissionAction.EDIT_CARDS), AssignmentController.assignUserToCard);
assignmentRoutes.delete('/cards/:cardId/assignees/:userId', keycloakAuthMiddleware, requirePermission(PermissionAction.EDIT_CARDS), AssignmentController.unassignUserFromCard);
assignmentRoutes.put('/cards/:cardId/assignees', keycloakAuthMiddleware, requirePermission(PermissionAction.EDIT_CARDS), AssignmentController.updateCardAssignments);

// Ruta para obtener tarjetas asignadas al usuario actual
assignmentRoutes.get('/users/me/assigned-cards', keycloakAuthMiddleware, AssignmentController.getUserAssignedCards);

export { AssignmentService };