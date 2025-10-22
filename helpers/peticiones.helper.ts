// En: src/helpers/peticiones.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';

// ================================
// Interfaces
// ================================
interface CreateSolicitudCuadroPayload {
  titulo: string;
  descripcion: string;
  esquemasValidados: 'si' | 'no';
}

// ================================
// Lógica de Servicio (PeticionesService)
// ================================
class PeticionesService {
  /**
   * Crea una petición de cuadro eléctrico y su card asociada
   */
  static async createSolicitudCuadro(
    userId: number,
    data: CreateSolicitudCuadroPayload
  ) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { titulo, descripcion, esquemasValidados } = data;

      // 1. Crear la petición en la tabla peticiones
      const peticionQuery = `
        INSERT INTO peticiones (form_type, form_data, submitted_by_user_id)
        VALUES ($1, $2, $3)
        RETURNING id
      `;

      const formData = {
        titulo,
        descripcion,
        esquemasValidados
      };

      const peticionResult = await client.query(peticionQuery, [
        'solicitud_cuadro_electrico',
        JSON.stringify(formData),
        userId
      ]);

      const peticionId = peticionResult.rows[0].id;

      // 2. Crear la card en el board 46, lista 60
      const cardQuery = `
        INSERT INTO cards (
          title,
          description,
          list_id,
          position,
          progress,
          peticion_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, (
          SELECT COALESCE(MAX(position), 0) + 1
          FROM cards
          WHERE list_id = $3
        ), $4, $5, NOW(), NOW())
        RETURNING id
      `;

      const cardResult = await client.query(cardQuery, [
        titulo,
        descripcion,
        60, // list_id
        0,  // progress
        peticionId
      ]);

      const cardId = cardResult.rows[0].id;

      // 3. Asignar el usuario a la card
      const assignmentQuery = `
        INSERT INTO card_assignments (card_id, user_id, assigned_by, workload_hours, assignment_order)
        VALUES ($1, $2, $3, $4, $5)
      `;

      await client.query(assignmentQuery, [
        cardId,
        userId,
        userId, // assigned_by (el usuario se auto-asigna)
        0,      // workload_hours
        0       // assignment_order
      ]);

      // 4. Registrar actividad
      const activityQuery = `
        INSERT INTO card_activity (card_id, user_id, activity_type, description)
        VALUES ($1, $2, $3, $4)
      `;

      await client.query(activityQuery, [
        cardId,
        userId,
        'ACTION',
        'creó esta tarjeta desde una solicitud de cuadro eléctrico'
      ]);

      await client.query('COMMIT');

      return {
        success: true,
        peticionId,
        cardId,
        message: 'Solicitud creada correctamente'
      };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en PeticionesService.createSolicitudCuadro:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Lógica de Controlador (PeticionesController)
// ================================
class PeticionesController {
  static async createSolicitudCuadro(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const data: CreateSolicitudCuadroPayload = await c.req.json();

      // Validaciones
      if (!data.titulo || !data.titulo.trim()) {
        return c.json({ error: 'El título es obligatorio' }, 400);
      }

      if (!data.descripcion || !data.descripcion.trim()) {
        return c.json({ error: 'La descripción es obligatoria' }, 400);
      }

      const result = await PeticionesService.createSolicitudCuadro(user.userId, data);

      return c.json(result, 201);

    } catch (error: any) {
      console.error('Error en PeticionesController.createSolicitudCuadro:', error);
      return c.json({
        error: 'No se pudo crear la solicitud',
        details: error.message
      }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Peticiones
// ================================
export const peticionesRoutes = new Hono<{ Variables: Variables }>();

peticionesRoutes.use('*', keycloakAuthMiddleware);

// Ruta para crear solicitud de cuadro eléctrico
peticionesRoutes.post('/peticiones/cuadro-electrico', PeticionesController.createSolicitudCuadro);

export { PeticionesController };
