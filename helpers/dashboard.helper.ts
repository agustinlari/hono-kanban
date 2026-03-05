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
   * Materias Primas: datos completos (KPIs + gráficas) para el dashboard.
   * Obtiene paneles por semana y tipo de envolvente, aplica factores de coste del CSV.
   * Grandes = Prisma P, Prisma G, Spacial SF | Pequeños = Cofret plástico
   */
  static async getMateriasPrimasData() {
    const currentYear = new Date().getFullYear();
    const startOfYear = `${currentYear}-01-01`;

    // Factores por panel según tipo de envolvente (del CSV Costes material)
    // Cada material tiene 3 dimensiones: importe (€), peso (Kg), superficie (m²)
    interface MaterialFactors { importe: number; peso: number; superficie: number }
    type EnvFactors = Record<string, MaterialFactors>;
    const COST_FACTORS: Record<string, EnvFactors> = {
      'Prisma P': {
        palets:          { importe: 0.44,     peso: 22,    superficie: 0.87  },
        poliestireno:    { importe: 0.12213,  peso: 0.69,  superficie: 0.35  },
        carton:          { importe: 0.076465, peso: 1.865, superficie: 3.68  },
        cintaPlastica:   { importe: 0.012213, peso: 0.069, superficie: 0.13  },
        filmExtensible:  { importe: 0.023541, peso: 0.133, superficie: 5     },
        cintaAdhesiva:   { importe: 0.013275, peso: 0.075, superficie: 0.48  },
      },
      'Prisma G': {
        palets:          { importe: 0.44,     peso: 22,    superficie: 0.87  },
        poliestireno:    { importe: 0.12213,  peso: 0.69,  superficie: 0.35  },
        carton:          { importe: 0,        peso: 0,     superficie: 0     },
        cintaPlastica:   { importe: 0.012213, peso: 0.069, superficie: 0.13  },
        filmExtensible:  { importe: 0.023541, peso: 0.133, superficie: 5     },
        cintaAdhesiva:   { importe: 0.013275, peso: 0.075, superficie: 0.48  },
      },
      'Spacial SF': {
        palets:          { importe: 0.44,     peso: 22,    superficie: 0.87  },
        poliestireno:    { importe: 0.12213,  peso: 0.69,  superficie: 0.35  },
        carton:          { importe: 0.076465, peso: 1.865, superficie: 3.68  },
        cintaPlastica:   { importe: 0.012213, peso: 0.069, superficie: 0.13  },
        filmExtensible:  { importe: 0.023541, peso: 0.133, superficie: 5     },
        cintaAdhesiva:   { importe: 0.013275, peso: 0.075, superficie: 0.48  },
      },
      'Cofret plástico': {
        palets:          { importe: 0.44,     peso: 13.2,  superficie: 0.522 },
        poliestireno:    { importe: 0.12213,  peso: 0.414, superficie: 0.21  },
        carton:          { importe: 0,        peso: 0,     superficie: 0     },
        cintaPlastica:   { importe: 0.012213, peso: 0.0414,superficie: 0.078 },
        filmExtensible:  { importe: 0.023541, peso: 0.0798,superficie: 3     },
        cintaAdhesiva:   { importe: 0.013275, peso: 0.045, superficie: 0.288 },
      },
    };
    const GRANDES = ['Prisma P', 'Prisma G', 'Spacial SF'];

    // Query: paneles por semana y tipo envolvente
    const query = `
      SELECT
        EXTRACT(WEEK FROM f8.date_value)::int as semana,
        f15.text_value as envolvente,
        SUM(COALESCE(f16.numeric_value, 0)) as paneles,
        COUNT(DISTINCT c.id) as cuadros
      FROM cards c
      INNER JOIN card_custom_field_values f8 ON c.id = f8.card_id AND f8.field_id = 8
      INNER JOIN card_custom_field_values f15 ON c.id = f15.card_id AND f15.field_id = 15
      LEFT JOIN card_custom_field_values f16 ON c.id = f16.card_id AND f16.field_id = 16
      WHERE f8.date_value >= $1
        AND f8.date_value <= CURRENT_DATE
        AND f15.text_value IN ('Prisma P', 'Prisma G', 'Spacial SF', 'Cofret plástico')
      GROUP BY semana, envolvente
      ORDER BY semana
    `;
    const result = await pool.query(query, [startOfYear]);

    // Semana actual
    const now = new Date();
    const startOfYearDate = new Date(currentYear, 0, 1);
    const diff = now.getTime() - startOfYearDate.getTime();
    const currentWeek = Math.ceil((diff / (1000 * 60 * 60 * 24) + startOfYearDate.getDay() + 1) / 7);

    // Acumular totales
    let totalPanelesGrandes = 0;
    let totalPanelesPequenos = 0;
    let cuadrosGrandes = 0;
    let cuadrosPequenos = 0;
    const MATERIALS = ['palets', 'poliestireno', 'carton', 'cintaPlastica', 'filmExtensible', 'cintaAdhesiva'] as const;
    const kpis = { palets: 0, poliestireno: 0, carton: 0, cintaPlastica: 0, filmExtensible: 0, cintaAdhesiva: 0 };
    const kpisPeso = { palets: 0, poliestireno: 0, carton: 0, cintaPlastica: 0, filmExtensible: 0, cintaAdhesiva: 0 };
    const kpisSuperficie = { palets: 0, poliestireno: 0, carton: 0, cintaPlastica: 0, filmExtensible: 0, cintaAdhesiva: 0 };

    // Mapas semanales para gráficas
    const weekGrandes = new Map<number, number>();
    const weekPequenos = new Map<number, number>();

    for (const row of result.rows) {
      const env = row.envolvente as string;
      const paneles = parseFloat(row.paneles) || 0;
      const cuadros = parseInt(row.cuadros) || 0;
      const semana = row.semana as number;
      const factors = COST_FACTORS[env];
      if (!factors) continue;

      const isGrande = GRANDES.includes(env);
      if (isGrande) {
        totalPanelesGrandes += paneles;
        cuadrosGrandes += cuadros;
        weekGrandes.set(semana, (weekGrandes.get(semana) || 0) + paneles);
      } else {
        totalPanelesPequenos += paneles;
        cuadrosPequenos += cuadros;
        weekPequenos.set(semana, (weekPequenos.get(semana) || 0) + paneles);
      }

      // Acumular las 3 dimensiones por material
      for (const mat of MATERIALS) {
        const f = factors[mat];
        if (!f) continue;
        kpis[mat] += paneles * f.importe;
        kpisPeso[mat] += paneles * f.peso;
        kpisSuperficie[mat] += paneles * f.superficie;
      }
    }

    // Construir arrays semanales acumulativos
    function buildWeeklyChart(weekMap: Map<number, number>) {
      const labels: string[] = [];
      const weekly: number[] = [];
      const cumulative: number[] = [];
      let runningTotal = 0;
      for (let w = 1; w <= currentWeek; w++) {
        labels.push(`S${w}`);
        const val = weekMap.get(w) || 0;
        weekly.push(val);
        runningTotal += val;
        cumulative.push(runningTotal);
      }
      return { labels, weekly, cumulative };
    }

    // Redondear KPIs a 2 decimales
    for (const mat of MATERIALS) {
      kpis[mat] = Math.round(kpis[mat] * 100) / 100;
      kpisPeso[mat] = Math.round(kpisPeso[mat] * 100) / 100;
      kpisSuperficie[mat] = Math.round(kpisSuperficie[mat] * 100) / 100;
    }

    return {
      paneles: {
        grandes: totalPanelesGrandes,
        pequenos: totalPanelesPequenos,
        cuadrosGrandes,
        cuadrosPequenos,
      },
      kpis,
      kpisPeso,
      kpisSuperficie,
      chartGrandes: buildWeeklyChart(weekGrandes),
      chartPequenos: buildWeeklyChart(weekPequenos),
      year: currentYear,
    };
  }
  /**
   * Devuelve la lista de tarjetas que tienen envolvente + paneles,
   * con título, proyecto, tipo de envolvente y cantidad de paneles.
   * Se usa para el buscador de costes individuales en SCRAP.
   */
  static async getCardsWithCosts() {
    const query = `
      SELECT
        c.id,
        c.title,
        p.nombre_proyecto as proyecto,
        f15.text_value as envolvente,
        COALESCE(f16.numeric_value, 0) as paneles
      FROM cards c
      INNER JOIN card_custom_field_values f15 ON c.id = f15.card_id AND f15.field_id = 15
      LEFT JOIN card_custom_field_values f16 ON c.id = f16.card_id AND f16.field_id = 16
      LEFT JOIN proyectos p ON c.proyecto_id = p.id
      WHERE f15.text_value IN ('Prisma P', 'Prisma G', 'Spacial SF', 'Cofret plástico')
      ORDER BY c.title ASC
    `;
    const result = await pool.query(query);
    return result.rows.map(row => ({
      id: row.id,
      title: row.title,
      proyecto: row.proyecto || null,
      envolvente: row.envolvente,
      paneles: parseFloat(row.paneles) || 0,
    }));
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

  static async getMateriasPrimas(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);
      const data = await DashboardService.getMateriasPrimasData();
      return c.json(data, 200);
    } catch (error: any) {
      console.error('Error en DashboardController.getMateriasPrimas:', error);
      return c.json({ error: 'No se pudieron obtener los datos de materias primas' }, 500);
    }
  }

  static async getCardsWithCosts(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);
      const data = await DashboardService.getCardsWithCosts();
      return c.json(data, 200);
    } catch (error: any) {
      console.error('Error en DashboardController.getCardsWithCosts:', error);
      return c.json({ error: 'No se pudieron obtener las tarjetas con costes' }, 500);
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

// Materias Primas (KPIs + gráficas en un solo endpoint)
dashboardRoutes.get('/dashboard/materias-primas', DashboardController.getMateriasPrimas);

// Tarjetas con costes (para buscador SCRAP)
dashboardRoutes.get('/dashboard/cards-with-costs', DashboardController.getCardsWithCosts);
