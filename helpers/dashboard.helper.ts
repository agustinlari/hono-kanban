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

  /**
   * KPI Cartón: cuenta cartones consumidos por cuadros Prisma P salidos este año.
   * - field_id=8: Fecha salida taller (filtra año actual)
   * - field_id=15: Tipo armario (filtra text_value='Prisma P')
   * - field_id=16: Nº paneles -> x2 cartones cada uno
   * - field_id=21: Nº patinillos -> x2 cartones cada uno
   */
  static async getCartonKpi() {
    const currentYear = new Date().getFullYear();
    const startOfYear = `${currentYear}-01-01`;

    const query = `
      SELECT
        COALESCE(SUM(COALESCE(f16.numeric_value, 0) * 2 + COALESCE(f21.numeric_value, 0) * 2), 0) as total_cartones,
        COUNT(*) as total_cuadros
      FROM cards c
      INNER JOIN card_custom_field_values f8 ON c.id = f8.card_id AND f8.field_id = 8
      INNER JOIN card_custom_field_values f15 ON c.id = f15.card_id AND f15.field_id = 15 AND f15.text_value = 'Prisma P'
      LEFT JOIN card_custom_field_values f16 ON c.id = f16.card_id AND f16.field_id = 16
      LEFT JOIN card_custom_field_values f21 ON c.id = f21.card_id AND f21.field_id = 21
      WHERE f8.date_value >= $1
        AND f8.date_value <= CURRENT_DATE
    `;
    const result = await pool.query(query, [startOfYear]);

    return {
      totalCartones: parseInt(result.rows[0]?.total_cartones || '0'),
      totalCuadros: parseInt(result.rows[0]?.total_cuadros || '0'),
      year: currentYear,
    };
  }

  /**
   * Gráfica acumulativa de cartón por semana (Prisma P, año actual).
   * Devuelve todas las semanas del año (S1..S52) con el acumulado hasta cada una.
   */
  static async getCartonWeeklyChart() {
    const currentYear = new Date().getFullYear();
    const startOfYear = `${currentYear}-01-01`;

    const query = `
      SELECT
        EXTRACT(WEEK FROM f8.date_value)::int as semana,
        SUM(COALESCE(f16.numeric_value, 0) * 2 + COALESCE(f21.numeric_value, 0) * 2) as cartones
      FROM cards c
      INNER JOIN card_custom_field_values f8 ON c.id = f8.card_id AND f8.field_id = 8
      INNER JOIN card_custom_field_values f15 ON c.id = f15.card_id AND f15.field_id = 15 AND f15.text_value = 'Prisma P'
      LEFT JOIN card_custom_field_values f16 ON c.id = f16.card_id AND f16.field_id = 16
      LEFT JOIN card_custom_field_values f21 ON c.id = f21.card_id AND f21.field_id = 21
      WHERE f8.date_value >= $1
        AND f8.date_value <= CURRENT_DATE
      GROUP BY EXTRACT(WEEK FROM f8.date_value)
      ORDER BY semana
    `;
    const result = await pool.query(query, [startOfYear]);

    // Semana actual del año
    const now = new Date();
    const startOfYearDate = new Date(currentYear, 0, 1);
    const diff = now.getTime() - startOfYearDate.getTime();
    const currentWeek = Math.ceil((diff / (1000 * 60 * 60 * 24) + startOfYearDate.getDay() + 1) / 7);

    // Mapa de datos por semana
    const weekMap = new Map<number, number>();
    result.rows.forEach(row => {
      weekMap.set(row.semana, parseInt(row.cartones));
    });

    // Generar todas las semanas desde S1 hasta la semana actual
    const labels: string[] = [];
    const weekly: number[] = [];
    const cumulative: number[] = [];
    let runningTotal = 0;

    for (let w = 1; w <= currentWeek; w++) {
      labels.push(`S${w}`);
      const weekValue = weekMap.get(w) || 0;
      weekly.push(weekValue);
      runningTotal += weekValue;
      cumulative.push(runningTotal);
    }

    return { labels, weekly, cumulative, year: currentYear };
  }

  /**
   * KPI Poliestireno: 1 unidad por panel + 1 por patinillo (todos los tipos de envolvente).
   * Filtra por field_id=8 (fecha salida taller) en el año actual.
   */
  static async getPoliestirenoKpi() {
    const currentYear = new Date().getFullYear();
    const startOfYear = `${currentYear}-01-01`;

    const query = `
      SELECT
        COALESCE(SUM(COALESCE(f16.numeric_value, 0) + COALESCE(f21.numeric_value, 0)), 0) as total_poliestireno,
        COUNT(*) as total_cuadros
      FROM cards c
      INNER JOIN card_custom_field_values f8 ON c.id = f8.card_id AND f8.field_id = 8
      LEFT JOIN card_custom_field_values f16 ON c.id = f16.card_id AND f16.field_id = 16
      LEFT JOIN card_custom_field_values f21 ON c.id = f21.card_id AND f21.field_id = 21
      WHERE f8.date_value >= $1
        AND f8.date_value <= CURRENT_DATE
    `;
    const result = await pool.query(query, [startOfYear]);

    return {
      totalPoliestireno: parseInt(result.rows[0]?.total_poliestireno || '0'),
      totalCuadros: parseInt(result.rows[0]?.total_cuadros || '0'),
      year: currentYear,
    };
  }

  /**
   * Gráfica acumulativa de poliestireno por semana (año actual).
   */
  static async getPoliestirenoWeeklyChart() {
    const currentYear = new Date().getFullYear();
    const startOfYear = `${currentYear}-01-01`;

    const query = `
      SELECT
        EXTRACT(WEEK FROM f8.date_value)::int as semana,
        SUM(COALESCE(f16.numeric_value, 0) + COALESCE(f21.numeric_value, 0)) as unidades
      FROM cards c
      INNER JOIN card_custom_field_values f8 ON c.id = f8.card_id AND f8.field_id = 8
      LEFT JOIN card_custom_field_values f16 ON c.id = f16.card_id AND f16.field_id = 16
      LEFT JOIN card_custom_field_values f21 ON c.id = f21.card_id AND f21.field_id = 21
      WHERE f8.date_value >= $1
        AND f8.date_value <= CURRENT_DATE
      GROUP BY EXTRACT(WEEK FROM f8.date_value)
      ORDER BY semana
    `;
    const result = await pool.query(query, [startOfYear]);

    const now = new Date();
    const startOfYearDate = new Date(currentYear, 0, 1);
    const diff = now.getTime() - startOfYearDate.getTime();
    const currentWeek = Math.ceil((diff / (1000 * 60 * 60 * 24) + startOfYearDate.getDay() + 1) / 7);

    const weekMap = new Map<number, number>();
    result.rows.forEach(row => {
      weekMap.set(row.semana, parseInt(row.unidades));
    });

    const labels: string[] = [];
    const weekly: number[] = [];
    const cumulative: number[] = [];
    let runningTotal = 0;

    for (let w = 1; w <= currentWeek; w++) {
      labels.push(`S${w}`);
      const weekValue = weekMap.get(w) || 0;
      weekly.push(weekValue);
      runningTotal += weekValue;
      cumulative.push(runningTotal);
    }

    return { labels, weekly, cumulative, year: currentYear };
  }
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

  static async getCartonKpi(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }
      const data = await DashboardService.getCartonKpi();
      return c.json(data, 200);
    } catch (error: any) {
      console.error('Error en DashboardController.getCartonKpi:', error);
      return c.json({ error: 'No se pudo obtener el KPI de cartón' }, 500);
    }
  }

  static async getCartonWeeklyChart(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }
      const data = await DashboardService.getCartonWeeklyChart();
      return c.json(data, 200);
    } catch (error: any) {
      console.error('Error en DashboardController.getCartonWeeklyChart:', error);
      return c.json({ error: 'No se pudo obtener la gráfica de cartón' }, 500);
    }
  }

  static async getPoliestirenoKpi(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);
      const data = await DashboardService.getPoliestirenoKpi();
      return c.json(data, 200);
    } catch (error: any) {
      console.error('Error en DashboardController.getPoliestirenoKpi:', error);
      return c.json({ error: 'No se pudo obtener el KPI de poliestireno' }, 500);
    }
  }

  static async getPoliestirenoWeeklyChart(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);
      const data = await DashboardService.getPoliestirenoWeeklyChart();
      return c.json(data, 200);
    } catch (error: any) {
      console.error('Error en DashboardController.getPoliestirenoWeeklyChart:', error);
      return c.json({ error: 'No se pudo obtener la gráfica de poliestireno' }, 500);
    }
  }
}

// ================================
// Rutas del Dashboard
// ================================
export const dashboardRoutes = new Hono<{ Variables: Variables }>();
dashboardRoutes.use('*', keycloakAuthMiddleware);

// Endpoint usado también por la página Home
dashboardRoutes.get('/dashboard/charts/cuadros-cumulative', DashboardController.getCuadrosCumulative);

// KPIs de Materias Primas
dashboardRoutes.get('/dashboard/kpi/carton', DashboardController.getCartonKpi);
dashboardRoutes.get('/dashboard/charts/carton-weekly', DashboardController.getCartonWeeklyChart);
dashboardRoutes.get('/dashboard/kpi/poliestireno', DashboardController.getPoliestirenoKpi);
dashboardRoutes.get('/dashboard/charts/poliestireno-weekly', DashboardController.getPoliestirenoWeeklyChart);
