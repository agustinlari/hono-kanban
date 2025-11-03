// helpers/notifications.helper.ts - Gestión del sistema de notificaciones

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';
import type {
  Notification,
  NotificationsResponse,
  NotificationType
} from '../types/kanban.types';
import { SSEService } from './sse.helper';

// ================================
// Lógica de Servicio (NotificationService)
// ================================
export class NotificationService {
  /**
   * Crea una notificación para un usuario (versión con cliente de transacción)
   */
  static async createNotificationWithClient(
    client: any,
    userId: number,
    activityId: number,
    activityDescription: string
  ): Promise<void> {
    try {
      // Verificar que no exista ya una notificación para este usuario y actividad
      const existingCheck = await client.query(
        'SELECT id FROM notifications WHERE user_id = $1 AND activity_id = $2',
        [userId, activityId]
      );

      if (existingCheck.rowCount && existingCheck.rowCount > 0) {
        console.log(`Notificación ya existe para user_id=${userId} y activity_id=${activityId}`);
        return;
      }

      // Verificar preferencias del usuario
      const prefsQuery = `
        SELECT * FROM user_notification_preferences
        WHERE user_id = $1
      `;
      const prefsResult = await client.query(prefsQuery, [userId]);

      // Si no tiene preferencias, usar valores por defecto
      const prefs = prefsResult.rows[0] || {
        on_mention_in_app: true,
        on_assignment_in_app: true,
        on_comment_in_app: true,
        on_move_in_app: true
      };

      // Determinar si crear notificación según preferencias
      let shouldCreate = false;

      if (activityDescription.includes(`@user_${userId}`) || activityDescription.includes('@')) {
        shouldCreate = prefs.on_mention_in_app !== false;
      } else if (activityDescription.includes('asignado') || activityDescription.includes('assigned')) {
        shouldCreate = prefs.on_assignment_in_app !== false;
      } else if (activityDescription.includes('comentó') || activityDescription.includes('commented')) {
        shouldCreate = prefs.on_comment_in_app !== false;
      } else if (activityDescription.includes('movió') || activityDescription.includes('moved')) {
        shouldCreate = prefs.on_move_in_app !== false;
      } else {
        // Por defecto, crear la notificación
        shouldCreate = true;
      }

      if (!shouldCreate) {
        console.log(`Usuario ${userId} tiene desactivadas notificaciones para este tipo de actividad`);
        return;
      }

      // Crear la notificación
      const insertQuery = `
        INSERT INTO notifications (user_id, activity_id)
        VALUES ($1, $2)
        RETURNING id
      `;

      const notificationResult = await client.query(insertQuery, [userId, activityId]);
      const notificationId = notificationResult.rows[0]?.id;
      console.log(`✅ Notificación creada para user_id=${userId}, activity_id=${activityId}`);

      // Emitir evento SSE personal de nueva notificación
      // Necesitamos obtener el contador total de notificaciones no leídas
      const countQuery = `
        SELECT COUNT(*) as count
        FROM notifications
        WHERE user_id = $1 AND read_at IS NULL
      `;
      const countResult = await client.query(countQuery, [userId]);
      const unreadCount = parseInt(countResult.rows[0].count);

      // Obtener información completa de la notificación para el evento
      const notificationQuery = `
        SELECT
          n.id,
          n.user_id,
          n.activity_id,
          n.read_at,
          n.created_at,
          ca.card_id,
          ca.activity_type,
          ca.description,
          ca.created_at as activity_created_at,
          c.title as card_title,
          l.title as list_title,
          l.board_id,
          b.name as board_name,
          u.email as actor_email,
          COALESCE(u.name, u.email) as actor_name
        FROM notifications n
        JOIN card_activity ca ON n.activity_id = ca.id
        JOIN cards c ON ca.card_id = c.id
        JOIN lists l ON c.list_id = l.id
        JOIN boards b ON l.board_id = b.id
        LEFT JOIN usuarios u ON ca.user_id = u.id
        WHERE n.id = $1
      `;
      const notificationInfoResult = await client.query(notificationQuery, [notificationId]);

      if (notificationInfoResult.rowCount && notificationInfoResult.rowCount > 0) {
        const notif = notificationInfoResult.rows[0];
        const fullNotification = {
          id: notif.id,
          user_id: notif.user_id,
          activity_id: notif.activity_id,
          read_at: notif.read_at,
          created_at: notif.created_at,
          card_id: notif.card_id,
          card_title: notif.card_title,
          board_id: notif.board_id,
          board_name: notif.board_name,
          list_title: notif.list_title,
          notification_type: this.determineNotificationType(notif.description),
          activity: {
            id: notif.activity_id,
            card_id: notif.card_id,
            user_id: notif.user_id,
            activity_type: notif.activity_type,
            description: notif.description,
            created_at: notif.activity_created_at,
            user_email: notif.actor_email,
            user_name: notif.actor_name
          }
        };

        // Emitir evento SSE personal
        SSEService.emitUserEvent({
          type: 'notification:new',
          userId,
          data: {
            notification: fullNotification,
            unread_count: unreadCount
          }
        });
      }

    } catch (error) {
      console.error('Error en NotificationService.createNotificationWithClient:', error);
      throw error;
    }
  }

  /**
   * Crea una notificación para un usuario (versión legacy con pool)
   */
  static async createNotification(
    userId: number,
    activityId: number
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que no exista ya una notificación para este usuario y actividad
      const existingCheck = await client.query(
        'SELECT id FROM notifications WHERE user_id = $1 AND activity_id = $2',
        [userId, activityId]
      );

      if (existingCheck.rowCount && existingCheck.rowCount > 0) {
        console.log(`Notificación ya existe para user_id=${userId} y activity_id=${activityId}`);
        await client.query('COMMIT');
        return;
      }

      // Verificar preferencias del usuario
      const prefsQuery = `
        SELECT * FROM user_notification_preferences
        WHERE user_id = $1
      `;
      const prefsResult = await client.query(prefsQuery, [userId]);

      // Si no tiene preferencias, usar valores por defecto
      const prefs = prefsResult.rows[0] || {
        on_mention_in_app: true,
        on_assignment_in_app: true,
        on_comment_in_app: true,
        on_move_in_app: true
      };

      // Obtener información de la actividad para determinar el tipo
      const activityQuery = `
        SELECT description FROM card_activity WHERE id = $1
      `;
      const activityResult = await client.query(activityQuery, [activityId]);

      if (!activityResult.rowCount || activityResult.rowCount === 0) {
        console.log(`Actividad ${activityId} no encontrada para notificación`);
        await client.query('COMMIT');
        return;
      }

      const activityDescription = activityResult.rows[0].description;

      // Determinar si crear notificación según preferencias
      let shouldCreate = false;

      if (activityDescription.includes(`@user_${userId}`) || activityDescription.includes('@')) {
        shouldCreate = prefs.on_mention_in_app !== false;
      } else if (activityDescription.includes('asignado') || activityDescription.includes('assigned')) {
        shouldCreate = prefs.on_assignment_in_app !== false;
      } else if (activityDescription.includes('comentó') || activityDescription.includes('commented')) {
        shouldCreate = prefs.on_comment_in_app !== false;
      } else if (activityDescription.includes('movió') || activityDescription.includes('moved')) {
        shouldCreate = prefs.on_move_in_app !== false;
      } else {
        shouldCreate = true;
      }

      if (!shouldCreate) {
        console.log(`Usuario ${userId} tiene desactivadas notificaciones para este tipo de actividad`);
        await client.query('COMMIT');
        return;
      }

      // Crear la notificación
      const insertQuery = `
        INSERT INTO notifications (user_id, activity_id)
        VALUES ($1, $2)
        RETURNING id
      `;

      await client.query(insertQuery, [userId, activityId]);
      console.log(`✅ Notificación creada para user_id=${userId}, activity_id=${activityId}`);

      await client.query('COMMIT');

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en NotificationService.createNotification:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene las notificaciones de un usuario
   */
  static async getUserNotifications(
    userId: number,
    includeRead: boolean = false,
    limit: number = 50
  ): Promise<NotificationsResponse> {
    const client = await pool.connect();
    try {
      let whereClause = 'n.user_id = $1';
      if (!includeRead) {
        whereClause += ' AND n.read_at IS NULL';
      }

      const query = `
        SELECT
          n.id,
          n.user_id,
          n.activity_id,
          n.read_at,
          n.created_at,
          ca.card_id,
          ca.activity_type,
          ca.description,
          ca.created_at as activity_created_at,
          c.title as card_title,
          l.title as list_title,
          l.board_id,
          b.name as board_name,
          u.email as actor_email,
          COALESCE(u.name, u.email) as actor_name
        FROM notifications n
        JOIN card_activity ca ON n.activity_id = ca.id
        JOIN cards c ON ca.card_id = c.id
        JOIN lists l ON c.list_id = l.id
        JOIN boards b ON l.board_id = b.id
        LEFT JOIN usuarios u ON ca.user_id = u.id
        WHERE ${whereClause}
        ORDER BY n.created_at DESC
        LIMIT $2
      `;

      const result = await client.query(query, [userId, limit]);

      // Contar notificaciones no leídas
      const countQuery = `
        SELECT COUNT(*) as count
        FROM notifications
        WHERE user_id = $1 AND read_at IS NULL
      `;
      const countResult = await client.query(countQuery, [userId]);
      const unreadCount = parseInt(countResult.rows[0].count);

      const notifications: Notification[] = result.rows.map(row => ({
        id: row.id,
        user_id: row.user_id,
        activity_id: row.activity_id,
        read_at: row.read_at,
        created_at: row.created_at,
        card_id: row.card_id,
        card_title: row.card_title,
        board_id: row.board_id,
        board_name: row.board_name,
        list_title: row.list_title,
        notification_type: this.determineNotificationType(row.description),
        activity: {
          id: row.activity_id,
          card_id: row.card_id,
          user_id: row.user_id,
          activity_type: row.activity_type,
          description: row.description,
          created_at: row.activity_created_at,
          user_email: row.actor_email,
          user_name: row.actor_name
        }
      }));

      return {
        notifications,
        unread_count: unreadCount
      };

    } catch (error) {
      console.error('Error en NotificationService.getUserNotifications:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Marca una notificación como leída
   */
  static async markAsRead(notificationId: number, userId: number): Promise<boolean> {
    const client = await pool.connect();
    try {
      const query = `
        UPDATE notifications
        SET read_at = NOW()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL
        RETURNING id
      `;

      const result = await client.query(query, [notificationId, userId]);
      const success = result.rowCount !== null && result.rowCount > 0;

      if (success) {
        // Obtener nuevo contador de notificaciones no leídas
        const countQuery = `
          SELECT COUNT(*) as count
          FROM notifications
          WHERE user_id = $1 AND read_at IS NULL
        `;
        const countResult = await client.query(countQuery, [userId]);
        const unreadCount = parseInt(countResult.rows[0].count);

        // Emitir evento SSE de notificación leída
        SSEService.emitUserEvent({
          type: 'notification:read',
          userId,
          data: {
            notificationId,
            unread_count: unreadCount
          }
        });
      }

      return success;

    } catch (error) {
      console.error('Error en NotificationService.markAsRead:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Marca todas las notificaciones de un usuario como leídas
   */
  static async markAllAsRead(userId: number): Promise<number> {
    const client = await pool.connect();
    try {
      const query = `
        UPDATE notifications
        SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL
        RETURNING id
      `;

      const result = await client.query(query, [userId]);
      const count = result.rowCount || 0;

      if (count > 0) {
        // Emitir evento SSE de todas las notificaciones leídas
        SSEService.emitUserEvent({
          type: 'notification:read_all',
          userId,
          data: {
            count,
            unread_count: 0
          }
        });
      }

      return count;

    } catch (error) {
      console.error('Error en NotificationService.markAllAsRead:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Determina el tipo de notificación basándose en la descripción
   */
  private static determineNotificationType(description: string): NotificationType {
    if (description.includes('@')) {
      return 'MENTION';
    } else if (description.includes('asignado') || description.includes('assigned')) {
      return 'ASSIGNMENT';
    } else if (description.includes('movió') || description.includes('moved')) {
      return 'CARD_MOVE';
    } else if (description.includes('comentó') || description.includes('commented')) {
      return 'COMMENT';
    } else if (description.includes('vencimiento') || description.includes('due date')) {
      return 'DUE_DATE_REMINDER';
    }
    return 'COMMENT'; // Por defecto
  }

  /**
   * Extrae menciones del formato @[Nombre](userId) de un texto
   * Retorna array de userIds mencionados
   */
  static extractMentions(text: string): number[] {
    // Regex para capturar @[Nombre](userId)
    const mentionRegex = /@\[[^\]]+\]\((\d+)\)/g;
    const userIds: number[] = [];
    let match;

    while ((match = mentionRegex.exec(text)) !== null) {
      const userId = parseInt(match[1]);
      if (!isNaN(userId) && !userIds.includes(userId)) {
        userIds.push(userId);
      }
    }

    return userIds;
  }

  /**
   * Busca usuarios por IDs mencionados y retorna sus IDs (validación)
   * Ahora recibe directamente los IDs extraídos de las menciones
   */
  static async findUsersByMention(userIds: number[]): Promise<number[]> {
    if (userIds.length === 0) return [];

    const client = await pool.connect();
    try {
      // Verificar que los usuarios existen
      const query = `
        SELECT DISTINCT id
        FROM usuarios
        WHERE id = ANY($1::int[])
      `;

      const result = await client.query(query, [userIds]);
      return result.rows.map(row => row.id);

    } catch (error) {
      console.error('Error en NotificationService.findUsersByMention:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Lógica de Controlador (NotificationController)
// ================================
class NotificationController {
  /**
   * GET /notifications - Obtener notificaciones del usuario autenticado
   */
  static async getUserNotifications(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    try {
      const includeRead = c.req.query('include_read') === 'true';
      const limit = parseInt(c.req.query('limit') || '50');

      const response = await NotificationService.getUserNotifications(
        user.userId,
        includeRead,
        limit
      );

      return c.json(response);
    } catch (error: any) {
      console.error('Error obteniendo notificaciones:', error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * PUT /notifications/:id/read - Marcar notificación como leída
   */
  static async markAsRead(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const notificationId = parseInt(c.req.param('id'));
    if (isNaN(notificationId)) {
      return c.json({ error: 'ID de notificación inválido' }, 400);
    }

    try {
      const success = await NotificationService.markAsRead(notificationId, user.userId);

      if (success) {
        return c.json({ message: 'Notificación marcada como leída' });
      } else {
        return c.json({ error: 'Notificación no encontrada o ya leída' }, 404);
      }
    } catch (error: any) {
      console.error('Error marcando notificación como leída:', error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * PUT /notifications/read-all - Marcar todas las notificaciones como leídas
   */
  static async markAllAsRead(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    try {
      const count = await NotificationService.markAllAsRead(user.userId);

      return c.json({
        message: `${count} notificación(es) marcada(s) como leída(s)`,
        count
      });
    } catch (error: any) {
      console.error('Error marcando todas las notificaciones como leídas:', error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }
}

// ================================
// Definición y Exportación de Rutas
// ================================
export const notificationRoutes = new Hono<{ Variables: Variables }>();

// Rutas para gestionar notificaciones
notificationRoutes.get('/notifications', keycloakAuthMiddleware, NotificationController.getUserNotifications);
notificationRoutes.put('/notifications/:id/read', keycloakAuthMiddleware, NotificationController.markAsRead);
notificationRoutes.put('/notifications/read-all', keycloakAuthMiddleware, NotificationController.markAllAsRead);
