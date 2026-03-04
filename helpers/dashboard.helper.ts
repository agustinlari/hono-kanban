// En: src/helpers/dashboard.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';

// ================================
// Interfaces
// ================================
export interface CuadrosCumulativeData {
  labels: string[];
  cumulative: number[];
  completedThisYear: number;
  pending: number;
}

// ================================
// Dashboard Service
// ================================
export class DashboardService {
  /**
   * Obtiene datos acumulativos de tareas completadas del tablero "Cuadros" (id=46)
   * basado en la fecha del custom field "Fecha salida taller" (id=8)
   * Nota: Este método también se usa en la página Home
   */
  static async getCuadrosCumulative(): Promise<CuadrosCumulativeData> {
    try {
      const BOARD_ID = 46;
      const FIELD_ID = 8; // "Fecha salida taller"
      const currentYear = new Date().getFullYear();
      const startOfYear = `${currentYear}-01-01`;

      // Obtener todas las tareas completadas este año ordenadas por fecha
      const completedQuery = `
        SELECT
          ccfv.date_value::date as fecha_salida,
          COUNT(*) as count
        FROM card_custom_field_values ccfv
        INNER JOIN cards c ON ccfv.card_id = c.id
        INNER JOIN lists l ON c.list_id = l.id
        WHERE l.board_id = $1
          AND ccfv.field_id = $2
          AND ccfv.date_value IS NOT NULL
          AND ccfv.date_value >= $3
          AND ccfv.date_value <= CURRENT_DATE
        GROUP BY ccfv.date_value::date
        ORDER BY ccfv.date_value::date
      `;
      const completedResult = await pool.query(completedQuery, [BOARD_ID, FIELD_ID, startOfYear]);

      // Obtener total completados este año
      const totalCompletedQuery = `
        SELECT COUNT(*) as total
        FROM card_custom_field_values ccfv
        INNER JOIN cards c ON ccfv.card_id = c.id
        INNER JOIN lists l ON c.list_id = l.id
        WHERE l.board_id = $1
          AND ccfv.field_id = $2
          AND ccfv.date_value IS NOT NULL
          AND ccfv.date_value >= $3
      `;
      const totalCompletedResult = await pool.query(totalCompletedQuery, [BOARD_ID, FIELD_ID, startOfYear]);
      const completedThisYear = parseInt(totalCompletedResult.rows[0]?.total || '0');

      // Obtener pendientes (sin fecha salida)
      const pendingQuery = `
        SELECT COUNT(*) as total
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        LEFT JOIN card_custom_field_values ccfv ON c.id = ccfv.card_id AND ccfv.field_id = $2
        WHERE l.board_id = $1
          AND (ccfv.date_value IS NULL OR ccfv.date_value > CURRENT_DATE)
      `;
      const pendingResult = await pool.query(pendingQuery, [BOARD_ID, FIELD_ID]);
      const pending = parseInt(pendingResult.rows[0]?.total || '0');

      // Construir arrays acumulativos
      const labels: string[] = [];
      const cumulative: number[] = [];
      let runningTotal = 0;

      const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

      completedResult.rows.forEach(row => {
        const date = new Date(row.fecha_salida);
        const dayNum = date.getDate();
        const month = monthNames[date.getMonth()];
        labels.push(`${dayNum} ${month}`);

        runningTotal += parseInt(row.count);
        cumulative.push(runningTotal);
      });

      return {
        labels,
        cumulative,
        completedThisYear,
        pending
      };
    } catch (error) {
      console.error('Error en DashboardService.getCuadrosCumulative:', error);
      throw error;
    }
  }

  // Nuevos métodos irán aquí
}

// ================================
// Dashboard Controller
// ================================
export class DashboardController {
  static async getCuadrosCumulative(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const data = await DashboardService.getCuadrosCumulative();
      return c.json(data, 200);

    } catch (error: any) {
      console.error('Error en DashboardController.getCuadrosCumulative:', error);
      return c.json({ error: 'No se pudieron obtener los datos acumulativos de Cuadros' }, 500);
    }
  }

  // Nuevos controllers irán aquí
}

// ================================
// Rutas del Dashboard
// ================================
export const dashboardRoutes = new Hono<{ Variables: Variables }>();
dashboardRoutes.use('*', keycloakAuthMiddleware);

// Endpoint usado también por la página Home
dashboardRoutes.get('/dashboard/charts/cuadros-cumulative', DashboardController.getCuadrosCumulative);

// Nuevas rutas irán aquí
