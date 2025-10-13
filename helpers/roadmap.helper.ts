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
}

export interface RoadmapData {
  tasks: RoadmapTask[];
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
          p.numero_obra_osmos as proyecto_numero_obra_osmos
        FROM cards c
        INNER JOIN lists l ON c.list_id = l.id
        INNER JOIN boards b ON l.board_id = b.id
        INNER JOIN board_members bm ON b.id = bm.board_id
        LEFT JOIN proyectos p ON c.proyecto_id = p.id
        WHERE bm.user_id = $1
          AND bm.can_view = true
          AND c.start_date IS NOT NULL
          AND c.due_date IS NOT NULL
          AND c.proyecto_id IS NOT NULL
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
}

// ================================
// Definición de Rutas de Roadmap
// ================================
export const roadmapRoutes = new Hono<{ Variables: Variables }>();

roadmapRoutes.use('*', keycloakAuthMiddleware);
roadmapRoutes.get('/roadmap', RoadmapController.getData);

export { RoadmapController };
