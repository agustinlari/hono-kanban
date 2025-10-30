import { Context } from 'hono';
import { pool } from '../config/database';

export interface NotificationPreference {
  id: number;
  userId: number;
  notificationType: string;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  boardId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationType =
  | 'card_assigned'
  | 'card_created_in_board'
  | 'card_comment'
  | 'card_mentioned'
  | 'card_due_soon'
  | 'card_overdue'
  | 'card_completed';

export class NotificationPreferenceService {
  /**
   * Obtener preferencia de usuario para un tipo específico
   */
  static async getUserPreference(
    userId: number,
    notificationType: NotificationType,
    boardId?: number
  ): Promise<NotificationPreference | null> {
    const client = await pool.connect();
    try {
      const query = `
        SELECT * FROM notification_preferences
        WHERE user_id = $1 AND notification_type = $2
        ${boardId ? 'AND board_id = $3' : 'AND board_id IS NULL'}
        LIMIT 1
      `;
      const params = boardId ? [userId, notificationType, boardId] : [userId, notificationType];
      const result = await client.query(query, params);

      if (!result.rows[0]) return null;

      // Transformar snake_case a camelCase
      const row = result.rows[0];
      return {
        id: row.id,
        userId: row.user_id,
        notificationType: row.notification_type,
        emailEnabled: row.email_enabled,
        inAppEnabled: row.in_app_enabled,
        boardId: row.board_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } finally {
      client.release();
    }
  }

  /**
   * Verificar si el usuario tiene emails habilitados para un tipo de notificación
   */
  static async isEmailEnabled(
    userId: number,
    notificationType: NotificationType,
    boardId?: number
  ): Promise<boolean> {
    const preference = await this.getUserPreference(userId, notificationType, boardId);

    // Si no existe preferencia, por defecto los emails están deshabilitados
    return preference?.emailEnabled || false;
  }

  /**
   * Obtener todas las preferencias de un usuario
   */
  static async getUserPreferences(userId: number): Promise<NotificationPreference[]> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM notification_preferences WHERE user_id = $1 ORDER BY notification_type, board_id',
        [userId]
      );
      // Transformar snake_case a camelCase para el frontend
      return result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        notificationType: row.notification_type,
        emailEnabled: row.email_enabled,
        inAppEnabled: row.in_app_enabled,
        boardId: row.board_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Crear o actualizar preferencia
   */
  static async upsertPreference(
    userId: number,
    notificationType: NotificationType,
    emailEnabled: boolean,
    inAppEnabled: boolean = true,
    boardId?: number
  ): Promise<NotificationPreference> {
    const client = await pool.connect();
    try {
      const normalizedBoardId = boardId || null;

      // Primero intentar actualizar
      const updateQuery = `
        UPDATE notification_preferences
        SET email_enabled = $3,
            in_app_enabled = $4,
            updated_at = NOW()
        WHERE user_id = $1
          AND notification_type = $2
          AND (board_id = $5 OR (board_id IS NULL AND $5 IS NULL))
        RETURNING *
      `;

      const updateResult = await client.query(updateQuery, [
        userId,
        notificationType,
        emailEnabled,
        inAppEnabled,
        normalizedBoardId
      ]);

      if (updateResult.rowCount && updateResult.rowCount > 0) {
        console.log(`✅ [NotificationPreferences] Preferencia actualizada para user ${userId}: ${notificationType} = ${emailEnabled ? 'Email ON' : 'Email OFF'}`);
        const row = updateResult.rows[0];
        return {
          id: row.id,
          userId: row.user_id,
          notificationType: row.notification_type,
          emailEnabled: row.email_enabled,
          inAppEnabled: row.in_app_enabled,
          boardId: row.board_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      }

      // Si no se actualizó nada, insertar nuevo registro
      const insertQuery = `
        INSERT INTO notification_preferences (user_id, notification_type, email_enabled, in_app_enabled, board_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;

      const insertResult = await client.query(insertQuery, [
        userId,
        notificationType,
        emailEnabled,
        inAppEnabled,
        normalizedBoardId
      ]);

      console.log(`✅ [NotificationPreferences] Preferencia creada para user ${userId}: ${notificationType} = ${emailEnabled ? 'Email ON' : 'Email OFF'}`);

      const row = insertResult.rows[0];
      return {
        id: row.id,
        userId: row.user_id,
        notificationType: row.notification_type,
        emailEnabled: row.email_enabled,
        inAppEnabled: row.in_app_enabled,
        boardId: row.board_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } finally {
      client.release();
    }
  }

  /**
   * Actualizar múltiples preferencias a la vez
   */
  static async updatePreferences(
    userId: number,
    preferences: Array<{
      notificationType: NotificationType;
      emailEnabled: boolean;
      inAppEnabled?: boolean;
      boardId?: number;
    }>
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const pref of preferences) {
        await this.upsertPreference(
          userId,
          pref.notificationType,
          pref.emailEnabled,
          pref.inAppEnabled !== undefined ? pref.inAppEnabled : true,
          pref.boardId
        );
      }

      await client.query('COMMIT');
      console.log(`✅ [NotificationPreferences] ${preferences.length} preferencias actualizadas para user ${userId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtener todos los usuarios que deben recibir email para un evento específico
   */
  static async getUsersToNotify(
    notificationType: NotificationType,
    boardId?: number
  ): Promise<number[]> {
    const client = await pool.connect();
    try {
      const query = `
        SELECT DISTINCT user_id
        FROM notification_preferences
        WHERE notification_type = $1
        AND email_enabled = true
        ${boardId ? 'AND (board_id = $2 OR board_id IS NULL)' : 'AND board_id IS NULL'}
      `;

      const params = boardId ? [notificationType, boardId] : [notificationType];
      const result = await client.query(query, params);

      return result.rows.map(row => row.user_id);
    } finally {
      client.release();
    }
  }

  /**
   * Eliminar preferencia
   */
  static async deletePreference(
    userId: number,
    notificationType: NotificationType,
    boardId?: number
  ): Promise<void> {
    const client = await pool.connect();
    try {
      const query = `
        DELETE FROM notification_preferences
        WHERE user_id = $1 AND notification_type = $2
        ${boardId ? 'AND board_id = $3' : 'AND board_id IS NULL'}
      `;

      const params = boardId ? [userId, notificationType, boardId] : [userId, notificationType];
      await client.query(query, params);

      console.log(`🗑️ [NotificationPreferences] Preferencia eliminada: user ${userId}, type ${notificationType}`);
    } finally {
      client.release();
    }
  }
}

/**
 * Controlador de endpoints
 */
export class NotificationPreferenceController {
  /**
   * GET /notification-preferences
   * Obtener preferencias del usuario autenticado
   */
  static async getMyPreferences(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const preferences = await NotificationPreferenceService.getUserPreferences(user.userId);

      return c.json({ preferences });
    } catch (error: any) {
      console.error('❌ Error en NotificationPreferenceController.getMyPreferences:', error);
      return c.json({ error: 'Error obteniendo preferencias' }, 500);
    }
  }

  /**
   * PUT /notification-preferences
   * Actualizar preferencias del usuario
   */
  static async updateMyPreferences(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const body = await c.req.json();
      const { preferences } = body;

      if (!Array.isArray(preferences)) {
        return c.json({ error: 'El campo preferences debe ser un array' }, 400);
      }

      await NotificationPreferenceService.updatePreferences(user.userId, preferences);

      return c.json({ success: true, message: 'Preferencias actualizadas correctamente' });
    } catch (error: any) {
      console.error('❌ Error en NotificationPreferenceController.updateMyPreferences:', error);
      return c.json({ error: 'Error actualizando preferencias' }, 500);
    }
  }

  /**
   * POST /test-email
   * Enviar email de prueba
   */
  static async sendTestEmail(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const { emailService } = await import('../services/email.service');

      const success = await emailService.sendTestEmail(user.email);

      if (success) {
        return c.json({
          success: true,
          message: `Email de prueba enviado a ${user.email}`
        });
      } else {
        return c.json({
          success: false,
          error: 'Error enviando email de prueba'
        }, 500);
      }
    } catch (error: any) {
      console.error('❌ Error en NotificationPreferenceController.sendTestEmail:', error);
      return c.json({
        success: false,
        error: error.message || 'Error enviando email de prueba'
      }, 500);
    }
  }
}

// Exportar las rutas siguiendo el patrón de Hono
import { Hono } from 'hono';
import type { Variables } from '../types';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';

export const notificationPreferenceRoutes = new Hono<{ Variables: Variables }>();

// Aplicar middleware de autenticación
notificationPreferenceRoutes.use('*', keycloakAuthMiddleware);

// Rutas
notificationPreferenceRoutes.get('/notification-preferences', NotificationPreferenceController.getMyPreferences);
notificationPreferenceRoutes.put('/notification-preferences', NotificationPreferenceController.updateMyPreferences);
notificationPreferenceRoutes.post('/test-email', NotificationPreferenceController.sendTestEmail);
