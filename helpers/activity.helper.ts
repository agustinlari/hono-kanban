// helpers/activity.helper.ts - Gestión de actividades y mensajes en tarjetas

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import { requirePermission } from '../middleware/permissions';
import type { Variables } from '../types';
import { PermissionAction } from '../types';
import type {
  CardActivity,
  CreateActivityPayload,
  CreateActionPayload,
  ActivityType
} from '../types/kanban.types';

// ================================
// Lógica de Servicio (ActivityService)
// ================================
export class ActivityService {
  /**
   * Obtiene todas las actividades de una tarjeta
   */
  static async getCardActivities(cardId: string): Promise<CardActivity[]> {
    const query = `
      SELECT
        ca.id,
        ca.card_id,
        ca.user_id,
        ca.activity_type,
        ca.description,
        ca.created_at,
        u.email as user_email,
        COALESCE(u.name, u.email) as user_name
      FROM card_activity ca
      LEFT JOIN usuarios u ON ca.user_id = u.id
      WHERE ca.card_id = $1
      ORDER BY ca.created_at DESC
    `;

    const result = await pool.query(query, [cardId]);
    return result.rows as CardActivity[];
  }

  /**
   * Crea un comentario manual de un usuario
   */
  static async createComment(cardId: string, userId: number, description: string): Promise<CardActivity> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que la tarjeta existe
      const cardCheck = await client.query('SELECT id FROM cards WHERE id = $1', [cardId]);
      if (!cardCheck.rowCount || cardCheck.rowCount === 0) {
        throw new Error('La tarjeta especificada no existe');
      }

      // Crear el comentario
      const insertQuery = `
        INSERT INTO card_activity (card_id, user_id, activity_type, description)
        VALUES ($1, $2, 'COMMENT', $3)
        RETURNING id, card_id, user_id, activity_type, description, created_at
      `;

      const insertResult = await client.query(insertQuery, [cardId, userId, description]);
      const activity = insertResult.rows[0];

      // Obtener datos del usuario
      const userQuery = 'SELECT email, COALESCE(name, email) as name FROM usuarios WHERE id = $1';
      const userResult = await client.query(userQuery, [userId]);
      const userData = userResult.rows[0];

      await client.query('COMMIT');

      return {
        ...activity,
        user_email: userData.email,
        user_name: userData.name
      } as CardActivity;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en ActivityService.createComment:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Crea una actividad automática (acción del sistema)
   * Esta función es para uso interno, no expuesta a través de la API
   */
  static async createAction(cardId: string, userId: number | null, description: string): Promise<void> {
    const client = await pool.connect();
    try {
      const insertQuery = `
        INSERT INTO card_activity (card_id, user_id, activity_type, description)
        VALUES ($1, $2, 'ACTION', $3)
      `;

      await client.query(insertQuery, [cardId, userId, description]);

    } catch (error) {
      console.error('Error en ActivityService.createAction:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Elimina un comentario (solo el autor puede eliminarlo)
   */
  static async deleteActivity(activityId: number, requestingUserId: number): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que la actividad existe y es un comentario del usuario
      const activityCheck = await client.query(
        'SELECT user_id, activity_type FROM card_activity WHERE id = $1',
        [activityId]
      );

      if (!activityCheck.rowCount || activityCheck.rowCount === 0) {
        throw new Error('La actividad no existe');
      }

      const activity = activityCheck.rows[0];

      // Solo se pueden eliminar comentarios, no acciones automáticas
      if (activity.activity_type !== 'COMMENT') {
        throw new Error('No se pueden eliminar actividades automáticas del sistema');
      }

      // Solo el autor puede eliminar su comentario
      if (activity.user_id !== requestingUserId) {
        throw new Error('Solo puedes eliminar tus propios comentarios');
      }

      // Eliminar el comentario
      const deleteResult = await client.query(
        'DELETE FROM card_activity WHERE id = $1',
        [activityId]
      );

      await client.query('COMMIT');

      return deleteResult.rowCount !== null && deleteResult.rowCount > 0;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en ActivityService.deleteActivity:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Lógica de Controlador (ActivityController)
// ================================
class ActivityController {
  /**
   * GET /cards/:cardId/activities - Obtener actividades de una tarjeta
   */
  static async getCardActivities(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    if (!cardId) return c.json({ error: 'ID de tarjeta requerido' }, 400);

    try {
      const activities = await ActivityService.getCardActivities(cardId);
      return c.json({ activities });
    } catch (error: any) {
      console.error(`Error obteniendo actividades de tarjeta ${cardId}:`, error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * POST /cards/:cardId/activities - Crear un comentario en una tarjeta
   */
  static async createComment(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    if (!cardId) return c.json({ error: 'ID de tarjeta requerido' }, 400);

    try {
      const { description } = await c.req.json();

      if (!description || typeof description !== 'string' || description.trim().length === 0) {
        return c.json({ error: 'La descripción del comentario es requerida' }, 400);
      }

      const activity = await ActivityService.createComment(cardId, user.userId, description.trim());

      return c.json({
        message: 'Comentario creado exitosamente',
        activity
      }, 201);
    } catch (error: any) {
      console.error(`Error creando comentario en tarjeta ${cardId}:`, error);

      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }

      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * DELETE /activities/:activityId - Eliminar un comentario
   */
  static async deleteActivity(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const activityId = parseInt(c.req.param('activityId'));

    if (isNaN(activityId)) {
      return c.json({ error: 'ID de actividad inválido' }, 400);
    }

    try {
      const success = await ActivityService.deleteActivity(activityId, user.userId);

      if (success) {
        return c.json({ message: 'Comentario eliminado exitosamente' });
      } else {
        return c.json({ error: 'No se pudo eliminar el comentario' }, 500);
      }
    } catch (error: any) {
      console.error(`Error eliminando actividad ${activityId}:`, error);

      if (error.message.includes('no existe') ||
          error.message.includes('no se pueden eliminar') ||
          error.message.includes('Solo puedes')) {
        return c.json({ error: error.message }, 400);
      }

      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }
}

// ================================
// Definición y Exportación de Rutas
// ================================
export const activityRoutes = new Hono<{ Variables: Variables }>();

// Rutas para gestionar actividades de tarjetas
activityRoutes.get('/cards/:cardId/activities', keycloakAuthMiddleware, ActivityController.getCardActivities);
activityRoutes.post('/cards/:cardId/activities', keycloakAuthMiddleware, requirePermission(PermissionAction.VIEW_BOARD), ActivityController.createComment);
activityRoutes.delete('/activities/:activityId', keycloakAuthMiddleware, ActivityController.deleteActivity);
