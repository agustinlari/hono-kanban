import { Context } from 'hono';
import { pool } from '../config/database';

export interface NotificationPreference {
  id: number;
  user_id: number;
  notification_type: string;
  email_enabled: boolean;
  in_app_enabled: boolean;
  board_id: number | null;
  created_at: Date;
  updated_at: Date;
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

      return result.rows[0] || null;
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
    return preference?.email_enabled || false;
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
      return result.rows;
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
      const query = `
        INSERT INTO notification_preferences (user_id, notification_type, email_enabled, in_app_enabled, board_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, notification_type, board_id)
        DO UPDATE SET
          email_enabled = $3,
          in_app_enabled = $4,
          updated_at = NOW()
        RETURNING *
      `;

      const result = await client.query(query, [
        userId,
        notificationType,
        emailEnabled,
        inAppEnabled,
        boardId || null
      ]);

      console.log(`✅ [NotificationPreferences] Preferencia actualizada para user ${userId}: ${notificationType} = ${emailEnabled ? 'Email ON' : 'Email OFF'}`);

      return result.rows[0];
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
   * GET /api/notification-preferences
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
   * PUT /api/notification-preferences
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
   * POST /api/test-email
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
notificationPreferenceRoutes.get('/api/notification-preferences', NotificationPreferenceController.getMyPreferences);
notificationPreferenceRoutes.put('/api/notification-preferences', NotificationPreferenceController.updateMyPreferences);
notificationPreferenceRoutes.post('/api/test-email', NotificationPreferenceController.sendTestEmail);
