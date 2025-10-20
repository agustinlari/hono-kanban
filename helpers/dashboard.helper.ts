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

export interface ProjectWorkloadData {
  labels: string[];
  projects: Array<{
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

      // Tiempo medio por tarea (días entre start_date y updated_at cuando progress = 100)
      const avgTaskTimeQuery = `
        SELECT AVG(
          EXTRACT(EPOCH FROM (c.updated_at - c.start_date)) / 86400
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
   * Obtiene datos para el gráfico de tareas creadas vs completadas por semana en el año actual
   */
  static async getTasksTimeline(userId: number, filters?: {
    projectIds?: number[];
    boardIds?: number[];
    userIds?: number[];
  }): Promise<TasksTimelineData> {
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

      const currentYear = new Date().getFullYear();
      const today = new Date();

      // Consulta para tareas creadas por semana (basado en start_date)
      const createdQuery = `
        SELECT
          DATE_TRUNC('week', c.start_date) as week_start,
          COUNT(DISTINCT c.id) as count
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.start_date IS NOT NULL
          AND EXTRACT(YEAR FROM c.start_date) = ${currentYear}
          AND c.start_date <= CURRENT_DATE
          ${projectFilter}
          ${boardFilter}
          ${userFilter}
        GROUP BY week_start
        ORDER BY week_start
      `;

      // Consulta para tareas completadas por semana (basado en due_date cuando progress = 100)
      const completedQuery = `
        SELECT
          DATE_TRUNC('week', c.due_date) as week_start,
          COUNT(DISTINCT c.id) as count
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.progress = 100
          AND c.due_date IS NOT NULL
          AND EXTRACT(YEAR FROM c.due_date) = ${currentYear}
          AND c.due_date <= CURRENT_DATE
          ${projectFilter}
          ${boardFilter}
          ${userFilter}
        GROUP BY week_start
        ORDER BY week_start
      `;

      const [createdResult, completedResult] = await Promise.all([
        pool.query(createdQuery, params),
        pool.query(completedQuery, params)
      ]);

      // Generar semanas desde inicio de año hasta la semana actual
      const weeks: Date[] = [];
      const startOfYear = new Date(currentYear, 0, 1);

      // Ajustar al lunes de la primera semana
      const firstMonday = new Date(startOfYear);
      const dayOfWeek = firstMonday.getDay();
      const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      firstMonday.setDate(firstMonday.getDate() + daysToMonday);

      // Calcular el lunes de la semana actual
      const currentMonday = new Date(today);
      const currentDayOfWeek = currentMonday.getDay();
      const daysToCurrentMonday = currentDayOfWeek === 0 ? -6 : 1 - currentDayOfWeek;
      currentMonday.setDate(currentMonday.getDate() + daysToCurrentMonday);
      currentMonday.setHours(0, 0, 0, 0);

      // Generar semanas solo hasta la semana actual
      let weekStart = new Date(firstMonday);
      while (weekStart <= currentMonday) {
        weeks.push(new Date(weekStart));
        weekStart.setDate(weekStart.getDate() + 7);
      }

      // Crear mapas de datos
      const createdMap = new Map<string, number>();
      createdResult.rows.forEach(row => {
        const weekKey = new Date(row.week_start).toISOString().split('T')[0];
        createdMap.set(weekKey, parseInt(row.count));
      });

      const completedMap = new Map<string, number>();
      completedResult.rows.forEach(row => {
        const weekKey = new Date(row.week_start).toISOString().split('T')[0];
        completedMap.set(weekKey, parseInt(row.count));
      });

      // Generar arrays de datos para cada semana
      const labels: string[] = [];
      const created: number[] = [];
      const completed: number[] = [];

      weeks.forEach((week, index) => {
        const weekKey = week.toISOString().split('T')[0];
        // Formato de etiqueta: "S1", "S2", etc.
        labels.push(`S${index + 1}`);
        created.push(createdMap.get(weekKey) || 0);
        completed.push(completedMap.get(weekKey) || 0);
      });

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
   * Obtiene datos para el gráfico de carga de trabajo por usuario (próximos 60 días)
   */
  static async getWorkload(userId: number, filters?: {
    projectIds?: number[];
    boardIds?: number[];
    userIds?: number[];
  }): Promise<WorkloadData> {
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

      // Obtener tareas incompletas en los próximos 60 días (visión prospectiva)
      const query = `
        SELECT
          c.id as card_id,
          c.start_date,
          c.due_date,
          c.progress,
          u.id as user_id,
          u.name as user_name,
          ca.workload_hours
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        INNER JOIN card_assignments ca ON c.id = ca.card_id
        INNER JOIN usuarios u ON ca.user_id = u.id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.start_date IS NOT NULL
          AND c.due_date IS NOT NULL
          AND c.progress < 100
          AND c.due_date >= CURRENT_DATE
          AND c.start_date <= CURRENT_DATE + INTERVAL '60 days'
          ${projectFilter}
          ${boardFilter}
        ORDER BY u.id, c.start_date
      `;

      // Filtrar por usuarios específicos si se proporciona
      let finalQuery = query;
      if (filters?.userIds && filters.userIds.length > 0) {
        finalQuery = query.replace(
          'ORDER BY u.id',
          `AND u.id = ANY($${paramIndex})\n        ORDER BY u.id`
        );
        params.push(filters.userIds);
      }

      const result = await pool.query(finalQuery, params);

      // Si no hay tareas, devolver datos vacíos
      if (result.rows.length === 0) {
        return {
          labels: [],
          users: [],
          capacity: []
        };
      }

      // Agrupar por usuario
      const userWorkloadMap = new Map<number, { name: string; tasks: any[] }>();
      result.rows.forEach(row => {
        if (!userWorkloadMap.has(row.user_id)) {
          userWorkloadMap.set(row.user_id, {
            name: row.user_name,
            tasks: []
          });
        }
        userWorkloadMap.get(row.user_id)!.tasks.push(row);
      });

      // Generar rango de fechas: desde HOY hasta HOY + 60 días
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 60);

      // Generar array de días laborables (lunes a viernes) en los próximos 60 días
      const days: Date[] = [];
      const currentDay = new Date(today);
      while (currentDay <= endDate) {
        const dayOfWeek = currentDay.getDay();
        // Solo incluir días laborables (lunes a viernes)
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
          days.push(new Date(currentDay));
        }
        currentDay.setDate(currentDay.getDate() + 1);
      }

      // Calcular carga por usuario por día
      const usersData: Array<{ name: string; data: number[] }> = [];

      userWorkloadMap.forEach((userData, userId) => {
        const dailyWorkload: number[] = new Array(days.length).fill(0);

        userData.tasks.forEach(task => {
          const taskStart = new Date(task.start_date);
          taskStart.setHours(0, 0, 0, 0);
          const taskEnd = new Date(task.due_date);
          taskEnd.setHours(0, 0, 0, 0);

          // Calcular días laborables entre start y end
          let workDays = 0;
          const currentDay = new Date(taskStart);
          while (currentDay <= taskEnd) {
            const dayOfWeek = currentDay.getDay();
            if (dayOfWeek !== 0 && dayOfWeek !== 6) { // No contar sábados ni domingos
              workDays++;
            }
            currentDay.setDate(currentDay.getDate() + 1);
          }

          // Si no hay días laborables, evitar división por 0
          if (workDays === 0) workDays = 1;

          // Distribuir horas por día laborable
          const hoursPerDay = parseFloat(task.workload_hours) / workDays;

          // Asignar horas a cada día en el rango
          const assignDay = new Date(taskStart);
          while (assignDay <= taskEnd) {
            const dayOfWeek = assignDay.getDay();

            // Solo asignar horas a días laborables (lunes a viernes)
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
              // Buscar el índice de este día en el array de días laborables
              const dayIndex = days.findIndex(d =>
                d.getFullYear() === assignDay.getFullYear() &&
                d.getMonth() === assignDay.getMonth() &&
                d.getDate() === assignDay.getDate()
              );

              if (dayIndex >= 0) {
                dailyWorkload[dayIndex] += hoursPerDay;
              }
            }

            assignDay.setDate(assignDay.getDate() + 1);
          }
        });

        usersData.push({
          name: userData.name,
          data: dailyWorkload.map(h => Math.round(h * 10) / 10) // Redondear a 1 decimal
        });
      });

      // Calcular capacidad total del equipo (número_de_usuarios × 8h/día)
      const userCount = userWorkloadMap.size;
      const teamCapacity = userCount * 8;
      const capacity: number[] = days.map(() => teamCapacity);

      // Generar etiquetas (formato: "20 Oct", "21 Oct", etc.) - solo días laborables
      const labels = days.map(day => {
        const dayNum = day.getDate();
        const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        const month = monthNames[day.getMonth()];
        return `${dayNum} ${month}`;
      });

      return {
        labels,
        users: usersData,
        capacity
      };
    } catch (error) {
      console.error('Error en DashboardService.getWorkload:', error);
      throw error;
    }
  }

  /**
   * Obtiene datos para el gráfico de carga de trabajo por proyecto (próximos 60 días)
   */
  static async getProjectWorkload(userId: number, filters?: {
    projectIds?: number[];
    boardIds?: number[];
    userIds?: number[];
  }): Promise<ProjectWorkloadData> {
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

      // Obtener tareas incompletas en los próximos 60 días (visión prospectiva)
      const query = `
        SELECT
          c.id as card_id,
          c.start_date,
          c.due_date,
          c.progress,
          c.proyecto_id,
          p.nombre_proyecto as project_name,
          SUM(ca.workload_hours) as total_workload_hours
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN proyectos p ON c.proyecto_id = p.id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.start_date IS NOT NULL
          AND c.due_date IS NOT NULL
          AND c.progress < 100
          AND c.due_date >= CURRENT_DATE
          AND c.start_date <= CURRENT_DATE + INTERVAL '60 days'
          AND c.proyecto_id IS NOT NULL
          ${projectFilter}
          ${boardFilter}
        GROUP BY c.id, c.start_date, c.due_date, c.progress, c.proyecto_id, p.nombre_proyecto
        ORDER BY c.proyecto_id, c.start_date
      `;

      // Filtrar por usuarios específicos si se proporciona
      let finalQuery = query;
      if (filters?.userIds && filters.userIds.length > 0) {
        finalQuery = query.replace(
          'ORDER BY c.proyecto_id',
          `HAVING BOOL_OR(ca.user_id = ANY($${paramIndex}))\n        ORDER BY c.proyecto_id`
        );
        params.push(filters.userIds);
      }

      const result = await pool.query(finalQuery, params);

      // Si no hay tareas, devolver datos vacíos
      if (result.rows.length === 0) {
        return {
          labels: [],
          projects: [],
          capacity: []
        };
      }

      // Agrupar por proyecto
      const projectWorkloadMap = new Map<number, { name: string; tasks: any[] }>();
      result.rows.forEach(row => {
        if (!projectWorkloadMap.has(row.proyecto_id)) {
          projectWorkloadMap.set(row.proyecto_id, {
            name: row.project_name || `Proyecto ${row.proyecto_id}`,
            tasks: []
          });
        }
        projectWorkloadMap.get(row.proyecto_id)!.tasks.push(row);
      });

      // Generar rango de fechas: desde HOY hasta HOY + 60 días
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 60);

      // Generar array de días laborables (lunes a viernes) en los próximos 60 días
      const days: Date[] = [];
      const currentDay = new Date(today);
      while (currentDay <= endDate) {
        const dayOfWeek = currentDay.getDay();
        // Solo incluir días laborables (lunes a viernes)
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
          days.push(new Date(currentDay));
        }
        currentDay.setDate(currentDay.getDate() + 1);
      }

      // Calcular carga por proyecto por día
      const projectsData: Array<{ name: string; data: number[] }> = [];

      projectWorkloadMap.forEach((projectData, projectId) => {
        const dailyWorkload: number[] = new Array(days.length).fill(0);

        projectData.tasks.forEach(task => {
          const taskStart = new Date(task.start_date);
          taskStart.setHours(0, 0, 0, 0);
          const taskEnd = new Date(task.due_date);
          taskEnd.setHours(0, 0, 0, 0);

          // Calcular días laborables entre start y end
          let workDays = 0;
          const currentDay = new Date(taskStart);
          while (currentDay <= taskEnd) {
            const dayOfWeek = currentDay.getDay();
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
              workDays++;
            }
            currentDay.setDate(currentDay.getDate() + 1);
          }

          // Si no hay días laborables, evitar división por 0
          if (workDays === 0) workDays = 1;

          // Distribuir horas por día laborable
          const hoursPerDay = parseFloat(task.total_workload_hours || 0) / workDays;

          // Asignar horas a cada día en el rango
          const assignDay = new Date(taskStart);
          while (assignDay <= taskEnd) {
            const dayOfWeek = assignDay.getDay();

            // Solo asignar horas a días laborables (lunes a viernes)
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
              // Buscar el índice de este día en el array de días laborables
              const dayIndex = days.findIndex(d =>
                d.getFullYear() === assignDay.getFullYear() &&
                d.getMonth() === assignDay.getMonth() &&
                d.getDate() === assignDay.getDate()
              );

              if (dayIndex >= 0) {
                dailyWorkload[dayIndex] += hoursPerDay;
              }
            }

            assignDay.setDate(assignDay.getDate() + 1);
          }
        });

        projectsData.push({
          name: projectData.name,
          data: dailyWorkload.map(h => Math.round(h * 10) / 10)
        });
      });

      // Calcular capacidad total del equipo basado en los usuarios que realmente aparecen en el gráfico
      // Contar usuarios únicos de los proyectos mostrados (próximos 60 días)
      const uniqueUsers = new Set<number>();
      const userCheckQuery = `
        SELECT DISTINCT ca.user_id
        FROM card_assignments ca
        INNER JOIN cards c ON ca.card_id = c.id
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.progress < 100
          AND c.due_date >= CURRENT_DATE
          AND c.start_date <= CURRENT_DATE + INTERVAL '60 days'
          AND c.proyecto_id IS NOT NULL
          ${projectFilter}
          ${boardFilter}
      `;

      const userCheckParams = [userId];
      let userCheckParamIndex = 2;
      if (filters?.projectIds && filters.projectIds.length > 0) {
        userCheckParams.push(filters.projectIds);
        userCheckParamIndex++;
      }
      if (filters?.boardIds && filters.boardIds.length > 0) {
        userCheckParams.push(filters.boardIds);
        userCheckParamIndex++;
      }

      let finalUserCheckQuery = userCheckQuery;
      if (filters?.userIds && filters.userIds.length > 0) {
        finalUserCheckQuery = userCheckQuery.replace(
          `${projectFilter}
          ${boardFilter}`,
          `${projectFilter}
          ${boardFilter}
          AND ca.user_id = ANY($${userCheckParamIndex})`
        );
        userCheckParams.push(filters.userIds);
      }

      const userCheckResult = await pool.query(finalUserCheckQuery, userCheckParams);
      const userCount = userCheckResult.rows.length || 1;
      const teamCapacity = userCount * 8;
      const capacity: number[] = days.map(() => teamCapacity);

      // Generar etiquetas (formato: "20 Oct", "21 Oct", etc.) - solo días laborables
      const labels = days.map(day => {
        const dayNum = day.getDate();
        const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        const month = monthNames[day.getMonth()];
        return `${dayNum} ${month}`;
      });

      return {
        labels,
        projects: projectsData,
        capacity
      };
    } catch (error) {
      console.error('Error en DashboardService.getProjectWorkload:', error);
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

  static async getProjectWorkload(c: Context) {
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

      const data = await DashboardService.getProjectWorkload(user.userId, filters);
      return c.json(data, 200);

    } catch (error: any) {
      console.error('Error en DashboardController.getProjectWorkload:', error);
      return c.json({ error: 'No se pudieron obtener los datos de carga de trabajo por proyecto' }, 500);
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
dashboardRoutes.get('/dashboard/charts/project-workload', DashboardController.getProjectWorkload);

export { DashboardController };
