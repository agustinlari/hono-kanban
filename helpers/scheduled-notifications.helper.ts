// Servicio para notificaciones programadas (cron jobs)
import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { emailService } from '../services/email.service';
import { emailSettings } from '../config/email.config';

export class ScheduledNotificationsService {
  /**
   * Envía notificaciones para tarjetas próximas a vencer (dentro de 2 días)
   */
  static async sendDueSoonNotifications(): Promise<{ sent: number; skipped: number }> {
    let sent = 0;
    let skipped = 0;

    try {
      console.log('🔔 [ScheduledNotifications] Iniciando chequeo de tarjetas próximas a vencer...');

      // Buscar tarjetas que vencen en 2 días y no están completadas
      const query = `
        SELECT DISTINCT
          c.id as card_id,
          c.title as card_title,
          c.due_date,
          b.id as board_id,
          b.name as board_name,
          u.id as user_id,
          u.email as user_email,
          u.name as user_name
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        LEFT JOIN usuarios u ON ca.user_id = u.id
        WHERE c.due_date IS NOT NULL
          AND c.due_date::date = (CURRENT_DATE + INTERVAL '2 days')::date
          AND (c.progress IS NULL OR c.progress < 100)
          AND u.id IS NOT NULL
      `;

      const result = await pool.query(query);
      console.log(`📊 [ScheduledNotifications] Encontradas ${result.rows.length} asignaciones para tarjetas próximas a vencer`);

      for (const row of result.rows) {
        try {
          // Verificar preferencias del usuario
          const prefsQuery = `
            SELECT email_enabled
            FROM notification_preferences
            WHERE user_id = $1 AND notification_type = 'card_due_soon'
          `;
          const prefsResult = await pool.query(prefsQuery, [row.user_id]);
          const emailEnabled = prefsResult.rows[0]?.email_enabled ?? false;

          if (!emailEnabled) {
            console.log(`⏭️ [ScheduledNotifications] Usuario ${row.user_email} tiene notificaciones deshabilitadas para due_soon`);
            skipped++;
            continue;
          }

          const cardUrl = `${emailSettings.appUrl}/kanban/home?board=${row.board_id}&card=${row.card_id}`;
          const dueDate = new Date(row.due_date);
          const formattedDate = dueDate.toLocaleDateString('es-ES', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });

          await emailService.sendCardDueSoonNotification({
            userEmail: row.user_email,
            userName: row.user_name || row.user_email,
            cardTitle: row.card_title,
            boardName: row.board_name,
            cardUrl,
            dueDate: formattedDate
          });

          console.log(`✅ [ScheduledNotifications] Email de due_soon enviado a ${row.user_email} para tarjeta "${row.card_title}"`);
          sent++;
        } catch (emailError) {
          console.error(`❌ [ScheduledNotifications] Error enviando email due_soon:`, emailError);
          skipped++;
        }
      }

      console.log(`🎯 [ScheduledNotifications] Due soon: ${sent} enviados, ${skipped} omitidos`);
      return { sent, skipped };
    } catch (error) {
      console.error(`❌ [ScheduledNotifications] Error en sendDueSoonNotifications:`, error);
      throw error;
    }
  }

  /**
   * Envía notificaciones para tarjetas vencidas
   */
  static async sendOverdueNotifications(): Promise<{ sent: number; skipped: number }> {
    let sent = 0;
    let skipped = 0;

    try {
      console.log('🔔 [ScheduledNotifications] Iniciando chequeo de tarjetas vencidas...');

      // Buscar tarjetas vencidas (due_date en el pasado) y no completadas
      const query = `
        SELECT DISTINCT
          c.id as card_id,
          c.title as card_title,
          c.due_date,
          b.id as board_id,
          b.name as board_name,
          u.id as user_id,
          u.email as user_email,
          u.name as user_name,
          CURRENT_DATE - c.due_date::date as days_overdue
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        LEFT JOIN usuarios u ON ca.user_id = u.id
        WHERE c.due_date IS NOT NULL
          AND c.due_date::date < CURRENT_DATE
          AND (c.progress IS NULL OR c.progress < 100)
          AND u.id IS NOT NULL
      `;

      const result = await pool.query(query);
      console.log(`📊 [ScheduledNotifications] Encontradas ${result.rows.length} asignaciones para tarjetas vencidas`);

      for (const row of result.rows) {
        try {
          // Verificar preferencias del usuario
          const prefsQuery = `
            SELECT email_enabled
            FROM notification_preferences
            WHERE user_id = $1 AND notification_type = 'card_overdue'
          `;
          const prefsResult = await pool.query(prefsQuery, [row.user_id]);
          const emailEnabled = prefsResult.rows[0]?.email_enabled ?? false;

          if (!emailEnabled) {
            console.log(`⏭️ [ScheduledNotifications] Usuario ${row.user_email} tiene notificaciones deshabilitadas para overdue`);
            skipped++;
            continue;
          }

          const cardUrl = `${emailSettings.appUrl}/kanban/home?board=${row.board_id}&card=${row.card_id}`;
          const dueDate = new Date(row.due_date);
          const formattedDate = dueDate.toLocaleDateString('es-ES', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });

          const daysOverdue = row.days_overdue;
          const daysOverdueText = daysOverdue === 1
            ? 'Hace 1 día'
            : `Hace ${daysOverdue} días`;

          await emailService.sendCardOverdueNotification({
            userEmail: row.user_email,
            userName: row.user_name || row.user_email,
            cardTitle: row.card_title,
            boardName: row.board_name,
            cardUrl,
            dueDate: formattedDate,
            daysOverdue: daysOverdueText
          });

          console.log(`✅ [ScheduledNotifications] Email de overdue enviado a ${row.user_email} para tarjeta "${row.card_title}"`);
          sent++;
        } catch (emailError) {
          console.error(`❌ [ScheduledNotifications] Error enviando email overdue:`, emailError);
          skipped++;
        }
      }

      console.log(`🎯 [ScheduledNotifications] Overdue: ${sent} enviados, ${skipped} omitidos`);
      return { sent, skipped };
    } catch (error) {
      console.error(`❌ [ScheduledNotifications] Error en sendOverdueNotifications:`, error);
      throw error;
    }
  }

  /**
   * Ejecuta todos los chequeos de notificaciones programadas
   */
  static async runAllChecks(): Promise<{ dueSoon: any; overdue: any }> {
    console.log('🚀 [ScheduledNotifications] Iniciando chequeos programados...');

    const dueSoon = await this.sendDueSoonNotifications();
    const overdue = await this.sendOverdueNotifications();

    console.log('✅ [ScheduledNotifications] Chequeos completados');

    return { dueSoon, overdue };
  }
}

// ================================
// Controlador (ScheduledNotificationsController)
// ================================
export class ScheduledNotificationsController {
  static async checkDueSoon(c: Context) {
    try {
      const result = await ScheduledNotificationsService.sendDueSoonNotifications();
      return c.json({
        success: true,
        message: 'Notificaciones de tarjetas próximas a vencer enviadas',
        ...result
      });
    } catch (error: any) {
      console.error('Error en checkDueSoon:', error);
      return c.json({ error: 'Error enviando notificaciones de due_soon', details: error.message }, 500);
    }
  }

  static async checkOverdue(c: Context) {
    try {
      const result = await ScheduledNotificationsService.sendOverdueNotifications();
      return c.json({
        success: true,
        message: 'Notificaciones de tarjetas vencidas enviadas',
        ...result
      });
    } catch (error: any) {
      console.error('Error en checkOverdue:', error);
      return c.json({ error: 'Error enviando notificaciones de overdue', details: error.message }, 500);
    }
  }

  static async runAll(c: Context) {
    try {
      const result = await ScheduledNotificationsService.runAllChecks();
      return c.json({
        success: true,
        message: 'Todos los chequeos de notificaciones completados',
        ...result
      });
    } catch (error: any) {
      console.error('Error en runAll:', error);
      return c.json({ error: 'Error ejecutando chequeos programados', details: error.message }, 500);
    }
  }
}

// ================================
// Rutas (scheduledNotificationsRoutes)
// ================================
export const scheduledNotificationsRoutes = new Hono();

// Endpoint para chequear tarjetas próximas a vencer
scheduledNotificationsRoutes.post('/check-due-soon', ScheduledNotificationsController.checkDueSoon);

// Endpoint para chequear tarjetas vencidas
scheduledNotificationsRoutes.post('/check-overdue', ScheduledNotificationsController.checkOverdue);

// Endpoint para ejecutar todos los chequeos
scheduledNotificationsRoutes.post('/run-all', ScheduledNotificationsController.runAll);
