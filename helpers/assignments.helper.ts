// helpers/assignments.helper.ts - Gestión de asignaciones de usuarios a tarjetas

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { authMiddleware } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import type { Variables } from '../types';
import { PermissionAction } from '../types';
import type { CardAssignee, AssignUserPayload, UnassignUserPayload, AssignmentResponse } from '../types/kanban.types';

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
        u.email as user_email,
        u.name as user_name
      FROM card_assignments ca
      INNER JOIN usuarios u ON ca.user_id = u.id
      WHERE ca.card_id = $1
      ORDER BY ca.assigned_at ASC
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
      const userCheck = await client.query('SELECT id, email, name FROM usuarios WHERE id = $1', [userId]);
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

      // Crear la asignación
      const insertQuery = `
        INSERT INTO card_assignments (card_id, user_id, assigned_by)
        VALUES ($1, $2, $3)
        RETURNING id, assigned_at
      `;

      const insertResult = await client.query(insertQuery, [cardId, userId, assignedBy]);
      const assignment = insertResult.rows[0];

      await client.query('COMMIT');

      // Retornar la asignación completa con datos del usuario
      const userData = userCheck.rows[0];
      return {
        id: assignment.id,
        card_id: cardId,
        user_id: userId,
        user_email: userData.email,
        user_name: userData.name,
        assigned_by: assignedBy,
        assigned_at: assignment.assigned_at
      };

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

      // Verificar que la asignación existe
      const assignmentCheck = await client.query(
        'SELECT id FROM card_assignments WHERE card_id = $1 AND user_id = $2',
        [cardId, userId]
      );

      if (!assignmentCheck.rowCount || assignmentCheck.rowCount === 0) {
        throw new Error('El usuario no está asignado a esta tarjeta');
      }

      // Eliminar la asignación
      const deleteResult = await client.query(
        'DELETE FROM card_assignments WHERE card_id = $1 AND user_id = $2',
        [cardId, userId]
      );

      await client.query('COMMIT');
      
      return deleteResult.rowCount !== null && deleteResult.rowCount > 0;

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
        c.id as card_id,
        c.title as card_title,
        c.description,
        c.image_url,
        c.start_date,
        c.due_date,
        l.id as list_id,
        l.title as list_title,
        b.id as board_id,
        b.name as board_name,
        ca.assigned_at
      FROM card_assignments ca
      INNER JOIN cards c ON ca.card_id = c.id
      INNER JOIN lists l ON c.list_id = l.id
      INNER JOIN boards b ON l.board_id = b.id
      WHERE ca.user_id = $1
      ORDER BY ca.assigned_at DESC
    `;

    const result = await pool.query(query, [userId]);
    return result.rows;
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
        'SELECT id, email, name FROM usuarios WHERE id = ANY($1)',
        [userIds]
      );

      if (!usersCheck.rowCount || usersCheck.rowCount !== userIds.length) {
        throw new Error('Uno o más usuarios especificados no existen');
      }

      // Crear las nuevas asignaciones
      const assignments: CardAssignee[] = [];
      for (const userId of userIds) {
        const insertResult = await client.query(
          'INSERT INTO card_assignments (card_id, user_id, assigned_by) VALUES ($1, $2, $3) RETURNING id, assigned_at',
          [cardId, userId, assignedBy]
        );

        const userData = usersCheck.rows.find((u: any) => u.id === userId);
        assignments.push({
          id: insertResult.rows[0].id,
          card_id: cardId,
          user_id: userId,
          user_email: userData.email,
          user_name: userData.name,
          assigned_by: assignedBy,
          assigned_at: insertResult.rows[0].assigned_at
        });
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
assignmentRoutes.get('/cards/:cardId/assignees', authMiddleware, AssignmentController.getCardAssignees);
assignmentRoutes.post('/cards/:cardId/assignees', authMiddleware, requirePermission(PermissionAction.EDIT_CARDS), AssignmentController.assignUserToCard);
assignmentRoutes.delete('/cards/:cardId/assignees/:userId', authMiddleware, requirePermission(PermissionAction.EDIT_CARDS), AssignmentController.unassignUserFromCard);
assignmentRoutes.put('/cards/:cardId/assignees', authMiddleware, requirePermission(PermissionAction.EDIT_CARDS), AssignmentController.updateCardAssignments);

// Ruta para obtener tarjetas asignadas al usuario actual
assignmentRoutes.get('/users/me/assigned-cards', authMiddleware, AssignmentController.getUserAssignedCards);

export { AssignmentService };