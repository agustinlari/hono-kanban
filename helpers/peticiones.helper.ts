// En: src/helpers/peticiones.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';

// ================================
// Interfaces
// ================================
interface Link {
  name: string;
  path: string;
}

interface CreateSolicitudCuadroPayload {
  titulo: string;
  descripcion: string;
  esquemasValidados: 'si' | 'no';
  proyectoId?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  vinculos?: Link[];
  datosEstructurados?: {
    nombreCuadro?: string;
    poderCorte?: number;
    regimenNeutro?: string;
    observaciones?: string;
    valoracionesFacturacion?: string;
    dimensionFondo?: number;
    dimensionAncho?: number;
    dimensionAlto?: number;
    fechaEntrega?: string | null;
    paletizado?: string;
    envioSeparado?: string;
  };
}

// ================================
// Lógica de Servicio (PeticionesService)
// ================================
class PeticionesService {
  /**
   * Obtiene una petición por ID
   */
  static async getPeticionById(peticionId: number) {
    const client = await pool.connect();

    try {
      const query = `
        SELECT id, form_type, form_data, submitted_by_user_id, submitted_at
        FROM peticiones
        WHERE id = $1
      `;

      const result = await client.query(query, [peticionId]);

      if (result.rows.length === 0) {
        throw new Error('Petición no encontrada');
      }

      return result.rows[0];

    } catch (error) {
      console.error('Error en PeticionesService.getPeticionById:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene todas las peticiones de un usuario
   */
  static async getPeticionesByUser(userId: number, includeArchived: boolean = false) {
    const client = await pool.connect();

    try {
      const query = `
        SELECT
          p.id,
          p.form_type,
          p.form_data,
          p.submitted_by_user_id,
          p.submitted_at,
          p.archived,
          c.id as card_id,
          c.title as card_title,
          c.progress as card_progress,
          l.board_id,
          l.title as list_name,
          proj.codigo as proyecto_codigo,
          proj.cadena as proyecto_cliente,
          proj.inmueble as proyecto_inmueble,
          u.name as submitted_by_name,
          u.email as submitted_by_email
        FROM peticiones p
        LEFT JOIN cards c ON c.peticion_id = p.id
        LEFT JOIN lists l ON c.list_id = l.id
        LEFT JOIN proyectos proj ON (p.form_data->>'proyectoId')::int = proj.id
        LEFT JOIN usuarios u ON p.submitted_by_user_id = u.id
        WHERE p.submitted_by_user_id = $1
        ${!includeArchived ? 'AND (p.archived IS NULL OR p.archived = false)' : ''}
        ORDER BY p.submitted_at DESC
      `;

      const result = await client.query(query, [userId]);

      return result.rows;

    } catch (error) {
      console.error('Error en PeticionesService.getPeticionesByUser:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene todas las peticiones (de todos los usuarios)
   */
  static async getAllPeticiones(includeArchived: boolean = false) {
    const client = await pool.connect();

    try {
      const query = `
        SELECT
          p.id,
          p.form_type,
          p.form_data,
          p.submitted_by_user_id,
          p.submitted_at,
          p.archived,
          c.id as card_id,
          c.title as card_title,
          c.progress as card_progress,
          l.board_id,
          l.title as list_name,
          proj.codigo as proyecto_codigo,
          proj.cadena as proyecto_cliente,
          proj.inmueble as proyecto_inmueble,
          u.name as submitted_by_name,
          u.email as submitted_by_email
        FROM peticiones p
        LEFT JOIN cards c ON c.peticion_id = p.id
        LEFT JOIN lists l ON c.list_id = l.id
        LEFT JOIN proyectos proj ON (p.form_data->>'proyectoId')::int = proj.id
        LEFT JOIN usuarios u ON p.submitted_by_user_id = u.id
        ${!includeArchived ? 'WHERE (p.archived IS NULL OR p.archived = false)' : ''}
        ORDER BY p.submitted_at DESC
      `;

      const result = await client.query(query);

      return result.rows;

    } catch (error) {
      console.error('Error en PeticionesService.getAllPeticiones:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene los tipos de peticiones únicos
   */
  static async getPeticionTypes() {
    const client = await pool.connect();

    try {
      const query = `
        SELECT DISTINCT form_type
        FROM peticiones
        ORDER BY form_type
      `;

      const result = await client.query(query);

      return result.rows.map(row => row.form_type);

    } catch (error) {
      console.error('Error en PeticionesService.getPeticionTypes:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Archiva o desarchiva una petición
   */
  static async toggleArchivePeticion(peticionId: number, userId: number, archived: boolean) {
    const client = await pool.connect();

    try {
      // Verificar que la petición pertenece al usuario
      const checkQuery = `
        SELECT id FROM peticiones
        WHERE id = $1 AND submitted_by_user_id = $2
      `;
      const checkResult = await client.query(checkQuery, [peticionId, userId]);

      if (checkResult.rows.length === 0) {
        throw new Error('Petición no encontrada o sin permisos');
      }

      // Actualizar el estado archived
      const updateQuery = `
        UPDATE peticiones
        SET archived = $1
        WHERE id = $2
        RETURNING id, archived
      `;

      const result = await client.query(updateQuery, [archived, peticionId]);

      return result.rows[0];

    } catch (error) {
      console.error('Error en PeticionesService.toggleArchivePeticion:', error);
      throw error;
    } finally {
      client.release();
    }
  }

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

      const { titulo, descripcion, esquemasValidados, proyectoId, startDate, dueDate, vinculos, datosEstructurados } = data;

      // 1. Crear la petición en la tabla peticiones
      const peticionQuery = `
        INSERT INTO peticiones (form_type, form_data, submitted_by_user_id)
        VALUES ($1, $2, $3)
        RETURNING id
      `;

      const formData = {
        titulo,
        descripcion,
        esquemasValidados,
        proyectoId: proyectoId || null,
        startDate: startDate || null,
        dueDate: dueDate || null,
        vinculos: vinculos || [],
        // Guardar datos estructurados adicionales
        ...(datosEstructurados || {})
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
          proyecto_id,
          start_date,
          due_date,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, (
          SELECT COALESCE(MAX(position), 0) + 1
          FROM cards
          WHERE list_id = $3
        ), $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING id
      `;

      const cardResult = await client.query(cardQuery, [
        titulo,
        descripcion,
        60, // list_id
        0,  // progress
        peticionId,
        proyectoId || null,
        startDate || null,
        dueDate || null
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
  static async getPeticion(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const peticionId = parseInt(c.req.param('id'));
      if (isNaN(peticionId)) {
        return c.json({ error: 'ID de petición inválido' }, 400);
      }

      const peticion = await PeticionesService.getPeticionById(peticionId);

      return c.json(peticion, 200);

    } catch (error: any) {
      console.error('Error en PeticionesController.getPeticion:', error);

      if (error.message === 'Petición no encontrada') {
        return c.json({ error: 'Petición no encontrada' }, 404);
      }

      return c.json({
        error: 'No se pudo obtener la petición',
        details: error.message
      }, 500);
    }
  }

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

  static async getUserPeticiones(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      // Obtener parámetro de query para incluir archivadas
      const includeArchived = c.req.query('includeArchived') === 'true';

      const peticiones = await PeticionesService.getPeticionesByUser(user.userId, includeArchived);

      return c.json({
        success: true,
        peticiones
      }, 200);

    } catch (error: any) {
      console.error('Error en PeticionesController.getUserPeticiones:', error);
      return c.json({
        error: 'No se pudieron obtener las solicitudes',
        details: error.message
      }, 500);
    }
  }

  static async getAllPeticiones(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      // Obtener parámetro de query para incluir archivadas
      const includeArchived = c.req.query('includeArchived') === 'true';

      const peticiones = await PeticionesService.getAllPeticiones(includeArchived);

      return c.json({
        success: true,
        peticiones
      }, 200);

    } catch (error: any) {
      console.error('Error en PeticionesController.getAllPeticiones:', error);
      return c.json({
        error: 'No se pudieron obtener las solicitudes',
        details: error.message
      }, 500);
    }
  }

  static async getPeticionTypes(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const types = await PeticionesService.getPeticionTypes();

      return c.json({
        success: true,
        types
      }, 200);

    } catch (error: any) {
      console.error('Error en PeticionesController.getPeticionTypes:', error);
      return c.json({
        error: 'No se pudieron obtener los tipos de peticiones',
        details: error.message
      }, 500);
    }
  }

  static async toggleArchivePeticion(c: Context) {
    try {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'No autorizado' }, 401);
      }

      const peticionId = parseInt(c.req.param('id'));
      if (isNaN(peticionId)) {
        return c.json({ error: 'ID de petición inválido' }, 400);
      }

      const { archived } = await c.req.json();

      if (typeof archived !== 'boolean') {
        return c.json({ error: 'El campo archived debe ser un booleano' }, 400);
      }

      const result = await PeticionesService.toggleArchivePeticion(peticionId, user.userId, archived);

      return c.json({
        success: true,
        peticion: result
      }, 200);

    } catch (error: any) {
      console.error('Error en PeticionesController.toggleArchivePeticion:', error);

      if (error.message === 'Petición no encontrada o sin permisos') {
        return c.json({ error: error.message }, 404);
      }

      return c.json({
        error: 'No se pudo archivar la petición',
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

// Ruta para obtener todas las peticiones del usuario
peticionesRoutes.get('/peticiones/user', PeticionesController.getUserPeticiones);

// Ruta para obtener TODAS las peticiones (de todos los usuarios)
peticionesRoutes.get('/peticiones/all', PeticionesController.getAllPeticiones);

// Ruta para obtener tipos de peticiones únicos
peticionesRoutes.get('/peticiones/types', PeticionesController.getPeticionTypes);

// Ruta para obtener una petición por ID
peticionesRoutes.get('/peticiones/:id', PeticionesController.getPeticion);

// Ruta para archivar/desarchivar una petición
peticionesRoutes.patch('/peticiones/:id/archive', PeticionesController.toggleArchivePeticion);

// Ruta para crear solicitud de cuadro eléctrico
peticionesRoutes.post('/peticiones/cuadro-electrico', PeticionesController.createSolicitudCuadro);

export { PeticionesController };
