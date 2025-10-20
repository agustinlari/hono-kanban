// En: src/helpers/dashboard.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';

// ================================
// Interfaces para Dashboard
// ================================
export interface DashboardMetrics {
  projects: {
    active: number;
    withoutCards: number;
    completed: number;
  };
  tasks: {
    avgTime: string;
    oldestInProgress: string;
  };
  team: {
    workloadRatio: string;
  };
}

export interface DashboardFilters {
  projects: Array<{ id: number; name: string }>;
  boards: Array<{ id: number; name: string }>;
  users: Array<{ id: number; name: string }>;
}

export interface TasksTimelineData {
  labels: string[];
  created: number[];
  completed: number[];
}

export interface WorkloadData {
  labels: string[];
  users: Array<{
    name: string;
    data: number[];
  }>;
  capacity: number[];
}

// ================================
// Lógica de Servicio (DashboardService)
// ================================
class DashboardService {
  /**
   * Obtiene las métricas principales del dashboard
   */
  static async getMetrics(userId: number, filters?: {
    projectIds?: number[];
    boardIds?: number[];
    userIds?: number[];
  }): Promise<DashboardMetrics> {
    try {
      // Construir condiciones de filtro
      let projectFilter = '';
      let boardFilter = '';
      let userFilter = '';
      const params: any[] = [userId];
      let paramIndex = 2;

      if (filters?.projectIds && filters.projectIds.length > 0) {
        projectFilter = ` AND c.proyecto_id = ANY($${paramIndex})`;
        params.push(filters.projectIds);
        paramIndex++;
      }

      if (filters?.boardIds && filters.boardIds.length > 0) {
        boardFilter = ` AND b.id = ANY($${paramIndex})`;
        params.push(filters.boardIds);
        paramIndex++;
      }

      if (filters?.userIds && filters.userIds.length > 0) {
        userFilter = ` AND ca.user_id = ANY($${paramIndex})`;
        params.push(filters.userIds);
        paramIndex++;
      }

      // Proyectos activos
      const activeProjectsQuery = `
        SELECT COUNT(DISTINCT p.id) as count
        FROM proyectos p
        INNER JOIN cards c ON c.proyecto_id = p.id
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          ${projectFilter}
          ${boardFilter}
          ${userFilter}
      `;
      const activeProjectsResult = await pool.query(activeProjectsQuery, params);
      const activeProjects = parseInt(activeProjectsResult.rows[0]?.count || '0');

      // Proyectos sin tarjetas
      const projectsWithoutCardsQuery = `
        SELECT COUNT(*) as count
        FROM proyectos p
        WHERE NOT EXISTS (
          SELECT 1 FROM cards c WHERE c.proyecto_id = p.id
        )
      `;
      const projectsWithoutCardsResult = await pool.query(projectsWithoutCardsQuery);
      const projectsWithoutCards = parseInt(projectsWithoutCardsResult.rows[0]?.count || '0');

      // Proyectos completados (todos sus tarjetas al 100%)
      const completedProjectsQuery = `
        SELECT COUNT(DISTINCT p.id) as count
        FROM proyectos p
        INNER JOIN cards c ON c.proyecto_id = p.id
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          ${projectFilter}
          ${boardFilter}
          ${userFilter}
        GROUP BY p.id
        HAVING MIN(c.progress) = 100
      `;
      const completedProjectsResult = await pool.query(completedProjectsQuery, params);
      const completedProjects = completedProjectsResult.rows.length;

      // Tiempo medio por tarea (días entre start_date y fecha de completado)
      const avgTaskTimeQuery = `
        SELECT AVG(
          EXTRACT(EPOCH FROM (
            COALESCE(
              (SELECT created_at FROM card_activity
               WHERE card_id = c.id
               AND activity_type = 'progress_updated'
               AND description LIKE '%100%'
               ORDER BY created_at DESC LIMIT 1),
              NOW()
            ) - c.start_date
          )) / 86400
        ) as avg_days
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.start_date IS NOT NULL
          AND c.progress = 100
          ${projectFilter}
          ${boardFilter}
          ${userFilter}
      `;
      const avgTaskTimeResult = await pool.query(avgTaskTimeQuery, params);
      const avgDays = parseFloat(avgTaskTimeResult.rows[0]?.avg_days || '0');
      const avgTaskTime = avgDays > 0 ? `${avgDays.toFixed(1)} días` : 'N/A';

      // Tarea más antigua en curso
      const oldestTaskQuery = `
        SELECT c.title, c.start_date
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.progress > 0
          AND c.progress < 100
          AND c.start_date IS NOT NULL
          ${projectFilter}
          ${boardFilter}
          ${userFilter}
        ORDER BY c.start_date ASC
        LIMIT 1
      `;
      const oldestTaskResult = await pool.query(oldestTaskQuery, params);
      let oldestTaskInProgress = 'N/A';
      if (oldestTaskResult.rows.length > 0) {
        const task = oldestTaskResult.rows[0];
        const startDate = new Date(task.start_date);
        const now = new Date();
        const daysDiff = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        oldestTaskInProgress = `${task.title.substring(0, 30)}${task.title.length > 30 ? '...' : ''} (${daysDiff} días)`;
      }

      // Ratio Carga actual / Capacidad del equipo
      // Suponiendo 8 horas/día por usuario y 5 días/semana = 40 horas/semana por usuario
      const workloadRatioQuery = `
        SELECT
          COUNT(DISTINCT u.id) as user_count,
          COALESCE(SUM(ca.workload_hours), 0) as total_workload
        FROM usuarios u
        INNER JOIN board_members bm ON u.id = bm.user_id
        LEFT JOIN card_assignments ca ON u.id = ca.user_id
        LEFT JOIN cards c ON ca.card_id = c.id
        WHERE bm.board_id IN (
          SELECT board_id FROM board_members WHERE user_id = $1 AND can_view = true
        )
        AND (c.progress IS NULL OR c.progress < 100)
      `;
      const workloadRatioResult = await pool.query(workloadRatioQuery, [userId]);
      const userCount = parseInt(workloadRatioResult.rows[0]?.user_count || '0');
      const totalWorkload = parseFloat(workloadRatioResult.rows[0]?.total_workload || '0');
      const weeklyCapacity = userCount * 40; // 40 horas/semana por usuario
      const workloadRatio = weeklyCapacity > 0 ? `${((totalWorkload / weeklyCapacity) * 100).toFixed(0)}%` : '0%';

      return {
        projects: {
          active: activeProjects,
          withoutCards: projectsWithoutCards,
          completed: completedProjects
        },
        tasks: {
          avgTime: avgTaskTime,
          oldestInProgress: oldestTaskInProgress
        },
        team: {
          workloadRatio: workloadRatio
        }
      };
    } catch (error) {
      console.error('Error en DashboardService.getMetrics:', error);
      throw error;
    }
  }

  /**
   * Obtiene los filtros disponibles para el usuario
   */
  static async getFilters(userId: number): Promise<DashboardFilters> {
    try {
      // Proyectos accesibles
      const projectsQuery = `
        SELECT DISTINCT p.id, p.nombre_proyecto as name
        FROM proyectos p
        INNER JOIN cards c ON c.proyecto_id = p.id
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND p.nombre_proyecto IS NOT NULL
        ORDER BY p.nombre_proyecto ASC
      `;
      const projectsResult = await pool.query(projectsQuery, [userId]);

      // Tableros accesibles
      const boardsQuery = `
        SELECT DISTINCT b.id, b.name
        FROM boards b
        INNER JOIN board_members bm ON b.id = bm.board_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
        ORDER BY b.name ASC
      `;
      const boardsResult = await pool.query(boardsQuery, [userId]);

      // Usuarios en los tableros del usuario actual
      const usersQuery = `
        SELECT DISTINCT u.id, u.name
        FROM usuarios u
        INNER JOIN board_members bm ON u.id = bm.user_id
        WHERE bm.board_id IN (
          SELECT board_id FROM board_members WHERE user_id = $1 AND can_view = true
        )
        ORDER BY u.name ASC
      `;
      const usersResult = await pool.query(usersQuery, [userId]);

      return {
        projects: projectsResult.rows,
        boards: boardsResult.rows,
        users: usersResult.rows
      };
    } catch (error) {
      console.error('Error en DashboardService.getFilters:', error);
      throw error;
    }
  }

  /**
   * Obtiene datos para el gráfico de tareas creadas vs completadas en el año actual
   */
  static async getTasksTimeline(userId: number, filters?: {
    projectIds?: number[];
    boardIds?: number[];
    userIds?: number[];
  }): Promise<TasksTimelineData> {
    try {
      // Obtener el año actual
      const currentYear = new Date().getFullYear();

      // TODO: Implementar lógica real para obtener datos por mes
      // Por ahora devolver datos de ejemplo
      const labels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
      const created = [12, 15, 18, 22, 19, 25, 28, 30, 26, 24, 20, 18];
      const completed = [8, 10, 14, 18, 16, 20, 24, 26, 22, 20, 16, 14];

      return {
        labels,
        created,
        completed
      };
    } catch (error) {
      console.error('Error en DashboardService.getTasksTimeline:', error);
      throw error;
    }
  }

  /**
   * Obtiene datos para el gráfico de carga de trabajo por usuario
   */
  static async getWorkload(userId: number, filters?: {
    projectIds?: number[];
    boardIds?: number[];
    userIds?: number[];
  }): Promise<WorkloadData> {
    try {
      // TODO: Implementar lógica real para obtener carga de trabajo por usuario
      // Por ahora devolver datos de ejemplo
      const labels = ['Semana 1', 'Semana 2', 'Semana 3', 'Semana 4'];
      const users = [
        { name: 'Usuario 1', data: [32, 35, 38, 40] },
        { name: 'Usuario 2', data: [28, 30, 32, 35] },
        { name: 'Usuario 3', data: [25, 28, 30, 32] }
      ];
      const capacity = [40, 40, 40, 40]; // Capacidad semanal (40h)

      return {
        labels,
        users,
        capacity
      };
    } catch (error) {
      console.error('Error en DashboardService.getWorkload:', error);
      throw error;
    }
  }
}

// ================================
// Lógica de Controlador (DashboardController)
// ================================
class DashboardController {
  static async getMetrics(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      // Obtener filtros de query params
      const projectIds = c.req.query('projectIds')?.split(',').map(Number);
      const boardIds = c.req.query('boardIds')?.split(',').map(Number);
      const userIds = c.req.query('userIds')?.split(',').map(Number);

      const filters = {
        projectIds: projectIds?.filter(id => !isNaN(id)),
        boardIds: boardIds?.filter(id => !isNaN(id)),
        userIds: userIds?.filter(id => !isNaN(id))
      };

      const metrics = await DashboardService.getMetrics(user.userId, filters);
      return c.json(metrics, 200);

    } catch (error: any) {
      console.error('Error en DashboardController.getMetrics:', error);
      return c.json({ error: 'No se pudieron obtener las métricas' }, 500);
    }
  }

  static async getFilters(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const filters = await DashboardService.getFilters(user.userId);
      return c.json(filters, 200);

    } catch (error: any) {
      console.error('Error en DashboardController.getFilters:', error);
      return c.json({ error: 'No se pudieron obtener los filtros' }, 500);
    }
  }

  static async getTasksTimeline(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const projectIds = c.req.query('projectIds')?.split(',').map(Number);
      const boardIds = c.req.query('boardIds')?.split(',').map(Number);
      const userIds = c.req.query('userIds')?.split(',').map(Number);

      const filters = {
        projectIds: projectIds?.filter(id => !isNaN(id)),
        boardIds: boardIds?.filter(id => !isNaN(id)),
        userIds: userIds?.filter(id => !isNaN(id))
      };

      const data = await DashboardService.getTasksTimeline(user.userId, filters);
      return c.json(data, 200);

    } catch (error: any) {
      console.error('Error en DashboardController.getTasksTimeline:', error);
      return c.json({ error: 'No se pudieron obtener los datos del timeline' }, 500);
    }
  }

  static async getWorkload(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const projectIds = c.req.query('projectIds')?.split(',').map(Number);
      const boardIds = c.req.query('boardIds')?.split(',').map(Number);
      const userIds = c.req.query('userIds')?.split(',').map(Number);

      const filters = {
        projectIds: projectIds?.filter(id => !isNaN(id)),
        boardIds: boardIds?.filter(id => !isNaN(id)),
        userIds: userIds?.filter(id => !isNaN(id))
      };

      const data = await DashboardService.getWorkload(user.userId, filters);
      return c.json(data, 200);

    } catch (error: any) {
      console.error('Error en DashboardController.getWorkload:', error);
      return c.json({ error: 'No se pudieron obtener los datos de carga de trabajo' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Dashboard
// ================================
export const dashboardRoutes = new Hono<{ Variables: Variables }>();

dashboardRoutes.use('*', keycloakAuthMiddleware);
dashboardRoutes.get('/dashboard/metrics', DashboardController.getMetrics);
dashboardRoutes.get('/dashboard/filters', DashboardController.getFilters);
dashboardRoutes.get('/dashboard/charts/tasks-timeline', DashboardController.getTasksTimeline);
dashboardRoutes.get('/dashboard/charts/workload', DashboardController.getWorkload);

export { DashboardController };
