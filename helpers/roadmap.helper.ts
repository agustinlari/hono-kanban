// En: src/helpers/roadmap.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';

// ================================
// Interfaces para Roadmap
// ================================
export interface RoadmapTask {
  card_id: string;
  card_title: string;
  card_progress: number;
  start_date: string;
  due_date: string;
  board_id: number;
  board_name: string;
  proyecto_id: number;
  proyecto_codigo: number;
  proyecto_cadena: string;
  proyecto_nombre_proyecto: string;
  proyecto_inmueble: string;
  proyecto_inicio_obra_prevista: string;
  proyecto_apert_espacio_prevista: string;
  proyecto_numero_obra_osmos: string;
  assigned_users: Array<{ id: number; name: string }>;
}

export interface RoadmapData {
  tasks: RoadmapTask[];
}

export interface IncompleteTask {
  card_id: string;
  card_title: string;
  board_id: number;
  board_name: string;
  list_id: number;
  list_title: string;
  proyecto_id: number;
  proyecto_codigo: number;
  missing_start_date: boolean;
  missing_due_date: boolean;
  missing_assignees: boolean;
}

export interface IncompleteTasks {
  tasks: IncompleteTask[];
}

export interface TaskWithoutProject {
  card_id: string;
  card_title: string;
  card_progress: number;
  board_id: number;
  board_name: string;
  list_id: number;
  list_title: string;
}

export interface TasksWithoutProject {
  tasks: TaskWithoutProject[];
}

// ================================
// Lógica de Servicio (RoadmapService)
// ================================
class RoadmapService {
  /**
   * Obtiene todas las tarjetas con fechas de los tableros accesibles por el usuario
   */
  static async getRoadmapData(userId: number): Promise<RoadmapData> {
    try {
      const query = `
        SELECT
          c.id as card_id,
          c.title as card_title,
          c.progress as card_progress,
          c.start_date,
          c.due_date,
          b.id as board_id,
          b.name as board_name,
          p.id as proyecto_id,
          p.codigo as proyecto_codigo,
          p.cadena as proyecto_cadena,
          p.nombre_proyecto as proyecto_nombre_proyecto,
          p.inmueble as proyecto_inmueble,
          p.inicio_obra_prevista as proyecto_inicio_obra_prevista,
          p.apert_espacio_prevista as proyecto_apert_espacio_prevista,
          p.numero_obra_osmos as proyecto_numero_obra_osmos,
          COALESCE(
            jsonb_agg(
              DISTINCT jsonb_build_object('id', ca.user_id, 'name', u.name)
            ) FILTER (WHERE ca.user_id IS NOT NULL),
            '[]'::jsonb
          ) as assigned_users
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN proyectos p ON c.proyecto_id = p.id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        LEFT JOIN usuarios u ON ca.user_id = u.id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.start_date IS NOT NULL
          AND c.due_date IS NOT NULL
          AND c.proyecto_id IS NOT NULL
        GROUP BY c.id, b.id, p.id
        ORDER BY c.start_date ASC
      `;

      const result = await pool.query(query, [userId]);

      return {
        tasks: result.rows
      };
    } catch (error) {
      console.error('Error en RoadmapService.getRoadmapData:', error);
      throw error;
    }
  }

  /**
   * Obtiene todas las tarjetas incompletas (sin fechas o sin usuarios asignados)
   * de TODOS los proyectos accesibles por el usuario
   */
  static async getIncompleteTasks(userId: number): Promise<IncompleteTasks> {
    try {
      const query = `
        SELECT
          c.id as card_id,
          c.title as card_title,
          b.id as board_id,
          b.name as board_name,
          l.id as list_id,
          l.title as list_title,
          c.proyecto_id,
          p.codigo as proyecto_codigo,
          (c.start_date IS NULL) as missing_start_date,
          (c.due_date IS NULL) as missing_due_date,
          (COUNT(ca.user_id) = 0) as missing_assignees
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN proyectos p ON c.proyecto_id = p.id
        LEFT JOIN card_assignments ca ON c.id = ca.card_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.proyecto_id IS NOT NULL
          AND (
            c.start_date IS NULL
            OR c.due_date IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM card_assignments ca2 WHERE ca2.card_id = c.id
            )
          )
        GROUP BY c.id, b.id, l.id, p.id, c.start_date, c.due_date
        ORDER BY b.name, c.title
      `;

      const result = await pool.query(query, [userId]);

      return {
        tasks: result.rows
      };
    } catch (error) {
      console.error('Error en RoadmapService.getIncompleteTasks:', error);
      throw error;
    }
  }

  /**
   * Obtiene todas las tarjetas sin proyecto asignado (progreso < 100)
   * de tableros accesibles por el usuario
   */
  static async getTasksWithoutProject(userId: number): Promise<TasksWithoutProject> {
    try {
      const query = `
        SELECT
          c.id as card_id,
          c.title as card_title,
          c.progress as card_progress,
          b.id as board_id,
          b.name as board_name,
          l.id as list_id,
          l.title as list_title
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND (c.proyecto_id IS NULL OR c.proyecto_id = 0)
          AND (c.progress < 100 OR c.progress IS NULL)
        ORDER BY b.name, c.title
      `;

      const result = await pool.query(query, [userId]);

      return {
        tasks: result.rows
      };
    } catch (error) {
      console.error('Error en RoadmapService.getTasksWithoutProject:', error);
      throw error;
    }
  }
}

// ================================
// Lógica de Controlador (RoadmapController)
// ================================
class RoadmapController {
  static async getData(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const data = await RoadmapService.getRoadmapData(user.userId);
      return c.json(data, 200);

    } catch (error: any) {
      console.error('Error en RoadmapController.getData:', error);
      return c.json({ error: 'No se pudieron obtener los datos del roadmap' }, 500);
    }
  }

  static async getIncompleteTasks(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const data = await RoadmapService.getIncompleteTasks(user.userId);
      return c.json(data, 200);

    } catch (error: any) {
      console.error('Error en RoadmapController.getIncompleteTasks:', error);
      return c.json({ error: 'No se pudieron obtener las tareas incompletas' }, 500);
    }
  }

  static async getTasksWithoutProject(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const data = await RoadmapService.getTasksWithoutProject(user.userId);
      return c.json(data, 200);

    } catch (error: any) {
      console.error('Error en RoadmapController.getTasksWithoutProject:', error);
      return c.json({ error: 'No se pudieron obtener las tareas sin proyecto' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Roadmap
// ================================
export const roadmapRoutes = new Hono<{ Variables: Variables }>();

roadmapRoutes.use('*', keycloakAuthMiddleware);
roadmapRoutes.get('/roadmap', RoadmapController.getData);
roadmapRoutes.get('/roadmap/incomplete-tasks', RoadmapController.getIncompleteTasks);
roadmapRoutes.get('/roadmap/tasks-without-project', RoadmapController.getTasksWithoutProject);

export { RoadmapController };
