// ================================
// src/helpers/projects.helper.ts
// ================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';

// ================================
// Servicio de Proyectos CRUD
// ================================
class ProjectsService {
  /**
   * Obtiene todos los proyectos
   */
  static async getAllProjects() {
    const client = await pool.connect();

    try {
      const query = `
        SELECT
          id, creado_manualmente, nombre_proyecto, ciudad, descripcion, activo, fecha_cambio,
          responsable_tecnico_id, responsable_delineacion_id, centro_coste, notas_internas,
          fecha_asignacion_responsable, cod_integracion, mercado, cadena, codigo, inmueble,
          sup_alq, bt_solicitud, inicio_obra_prevista, inicio_obra_real, apert_espacio_prevista,
          presupuesto, fecha_inicio_planificada, fecha_fin_estimada, es_bim, numero_obra_osmos
        FROM proyectos
        ORDER BY codigo ASC, cod_integracion ASC
      `;

      const result = await client.query(query);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene un proyecto por ID
   */
  static async getProjectById(id: number) {
    const client = await pool.connect();

    try {
      const query = `
        SELECT
          id, mercado, ciudad, cadena, codigo, cod_integracion,
          nombre_proyecto, activo, inmueble, sup_alq, bt_solicitud,
          inicio_obra_prevista, inicio_obra_real, apert_espacio_prevista,
          descripcion, es_bim, numero_obra_osmos,
          creado_manualmente, fecha_cambio
        FROM proyectos
        WHERE id = $1
      `;

      const result = await client.query(query, [id]);
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Crea un nuevo proyecto
   */
  static async createProject(projectData: any, userId: number) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verificar que no exista ya un proyecto con el mismo código o código de integración
      if (projectData.codigo) {
        const existingByCode = await client.query(
          'SELECT id FROM proyectos WHERE codigo = $1',
          [projectData.codigo]
        );
        if (existingByCode.rows.length > 0) {
          throw new Error(`Ya existe un proyecto con el código ${projectData.codigo}`);
        }
      }

      if (projectData.cod_integracion) {
        const existingByCodIntegracion = await client.query(
          'SELECT id FROM proyectos WHERE cod_integracion = $1',
          [projectData.cod_integracion]
        );
        if (existingByCodIntegracion.rows.length > 0) {
          throw new Error(`Ya existe un proyecto con el código de integración ${projectData.cod_integracion}`);
        }
      }

      const insertQuery = `
        INSERT INTO proyectos (
          mercado, ciudad, cadena, codigo, cod_integracion,
          nombre_proyecto, activo, inmueble, sup_alq, bt_solicitud,
          inicio_obra_prevista, inicio_obra_real, apert_espacio_prevista,
          descripcion, es_bim, numero_obra_osmos,
          creado_manualmente
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *
      `;

      const values = [
        projectData.mercado || null,
        projectData.ciudad || null,
        projectData.cadena || null,
        projectData.codigo || null,
        projectData.cod_integracion || null,
        projectData.nombre_proyecto || null,
        projectData.activo !== false, // Default true si no se especifica
        projectData.inmueble || null,
        projectData.sup_alq || null,
        projectData.bt_solicitud || null,
        projectData.inicio_obra_prevista || null,
        projectData.inicio_obra_real || null,
        projectData.apert_espacio_prevista || null,
        projectData.descripcion || null,
        projectData.es_bim || false,
        projectData.numero_obra_osmos || null,
        true // creado_manualmente
      ];

      const result = await client.query(insertQuery, values);
      const newProject = result.rows[0];

      // Registrar en historial
      try {
        const historialQuery = `
          INSERT INTO proyectos_historial (proyecto_id, usuario_id, tipo_accion)
          VALUES ($1, $2, $3)
        `;
        await client.query(historialQuery, [newProject.id, userId, 'CREATE']);
      } catch (historialError) {
        console.warn(`⚠️ [PROJECTS] Error registrando historial (no crítico): ${historialError.message}`);
      }

      await client.query('COMMIT');
      console.log(`✅ [PROJECTS] Proyecto creado con ID: ${newProject.id}`);

      return newProject;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Actualiza un proyecto existente
   */
  static async updateProject(id: number, projectData: any, userId: number) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verificar que el proyecto existe
      const existingProject = await client.query('SELECT * FROM proyectos WHERE id = $1', [id]);
      if (existingProject.rows.length === 0) {
        throw new Error('Proyecto no encontrado');
      }

      const oldProject = existingProject.rows[0];

      // Verificar códigos únicos si se cambiaron
      if (projectData.codigo && projectData.codigo !== oldProject.codigo) {
        const existingByCode = await client.query(
          'SELECT id FROM proyectos WHERE codigo = $1 AND id != $2',
          [projectData.codigo, id]
        );
        if (existingByCode.rows.length > 0) {
          throw new Error(`Ya existe un proyecto con el código ${projectData.codigo}`);
        }
      }

      if (projectData.cod_integracion && projectData.cod_integracion !== oldProject.cod_integracion) {
        const existingByCodIntegracion = await client.query(
          'SELECT id FROM proyectos WHERE cod_integracion = $1 AND id != $2',
          [projectData.cod_integracion, id]
        );
        if (existingByCodIntegracion.rows.length > 0) {
          throw new Error(`Ya existe un proyecto con el código de integración ${projectData.cod_integracion}`);
        }
      }

      const updateQuery = `
        UPDATE proyectos SET
          mercado = $1, ciudad = $2, cadena = $3, codigo = $4, cod_integracion = $5,
          nombre_proyecto = $6, activo = $7, inmueble = $8, sup_alq = $9,
          bt_solicitud = $10, inicio_obra_prevista = $11, inicio_obra_real = $12,
          apert_espacio_prevista = $13, descripcion = $14, es_bim = $15,
          numero_obra_osmos = $16,
          fecha_cambio = CURRENT_TIMESTAMP
        WHERE id = $17
        RETURNING *
      `;

      const values = [
        projectData.mercado !== undefined ? projectData.mercado : oldProject.mercado,
        projectData.ciudad !== undefined ? projectData.ciudad : oldProject.ciudad,
        projectData.cadena !== undefined ? projectData.cadena : oldProject.cadena,
        projectData.codigo !== undefined ? projectData.codigo : oldProject.codigo,
        projectData.cod_integracion !== undefined ? projectData.cod_integracion : oldProject.cod_integracion,
        projectData.nombre_proyecto !== undefined ? projectData.nombre_proyecto : oldProject.nombre_proyecto,
        projectData.activo !== undefined ? projectData.activo : oldProject.activo,
        projectData.inmueble !== undefined ? projectData.inmueble : oldProject.inmueble,
        projectData.sup_alq !== undefined ? projectData.sup_alq : oldProject.sup_alq,
        projectData.bt_solicitud !== undefined ? projectData.bt_solicitud : oldProject.bt_solicitud,
        projectData.inicio_obra_prevista !== undefined ? projectData.inicio_obra_prevista : oldProject.inicio_obra_prevista,
        projectData.inicio_obra_real !== undefined ? projectData.inicio_obra_real : oldProject.inicio_obra_real,
        projectData.apert_espacio_prevista !== undefined ? projectData.apert_espacio_prevista : oldProject.apert_espacio_prevista,
        projectData.descripcion !== undefined ? projectData.descripcion : oldProject.descripcion,
        projectData.es_bim !== undefined ? projectData.es_bim : oldProject.es_bim,
        projectData.numero_obra_osmos !== undefined ? projectData.numero_obra_osmos : oldProject.numero_obra_osmos,
        id
      ];

      const result = await client.query(updateQuery, values);
      const updatedProject = result.rows[0];

      // Detectar cambios para el historial
      const changes = [];
      const fieldsToCheck = [
        'mercado', 'ciudad', 'cadena', 'codigo', 'cod_integracion',
        'nombre_proyecto', 'activo', 'inmueble', 'sup_alq', 'bt_solicitud',
        'inicio_obra_prevista', 'inicio_obra_real', 'apert_espacio_prevista',
        'descripcion', 'es_bim', 'numero_obra_osmos'
      ];

      for (const field of fieldsToCheck) {
        if (projectData[field] !== undefined && projectData[field] !== oldProject[field]) {
          changes.push({
            campo: field,
            valorAnterior: oldProject[field],
            valorNuevo: projectData[field]
          });
        }
      }

      // Registrar cambios en historial
      try {
        for (const change of changes) {
          const historialQuery = `
            INSERT INTO proyectos_historial (proyecto_id, usuario_id, tipo_accion, campo_modificado, valor_anterior, valor_nuevo)
            VALUES ($1, $2, $3, $4, $5, $6)
          `;
          await client.query(historialQuery, [
            id, userId, 'UPDATE', change.campo, change.valorAnterior, change.valorNuevo
          ]);
        }
      } catch (historialError) {
        console.warn(`⚠️ [PROJECTS] Error registrando historial (no crítico): ${historialError.message}`);
      }

      await client.query('COMMIT');
      console.log(`✅ [PROJECTS] Proyecto actualizado: ${id} (${changes.length} cambios)`);

      return updatedProject;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

}

// ================================
// Rutas de la API
// ================================
export const projectsRoutes = new Hono<{ Variables: Variables }>();

/**
 * GET /api/projects
 * Obtiene todos los proyectos
 */
projectsRoutes.get('/api/projects', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    console.log(`📋 [PROJECTS] Obteniendo todos los proyectos por usuario: ${user.userId}`);

    const projects = await ProjectsService.getAllProjects();

    return c.json(projects);

  } catch (error) {
    console.error('❌ [PROJECTS] Error obteniendo proyectos:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * GET /api/projects/:id
 * Obtiene un proyecto por ID
 */
projectsRoutes.get('/api/projects/:id', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ error: 'ID de proyecto inválido' }, 400);
    }

    console.log(`📋 [PROJECTS] Obteniendo proyecto ${id} por usuario: ${user.userId}`);

    const project = await ProjectsService.getProjectById(id);

    if (!project) {
      return c.json({ error: 'Proyecto no encontrado' }, 404);
    }

    return c.json({
      success: true,
      data: project
    });

  } catch (error) {
    console.error('❌ [PROJECTS] Error obteniendo proyecto:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * POST /api/projects
 * Crea un nuevo proyecto
 */
projectsRoutes.post('/api/projects', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const projectData = await c.req.json();
    console.log(`📋 [PROJECTS] Creando nuevo proyecto por usuario: ${user.userId}`);

    // Validaciones básicas
    if (!projectData.nombre_proyecto || !projectData.nombre_proyecto.trim()) {
      return c.json({ error: 'El nombre del proyecto es requerido' }, 400);
    }

    const newProject = await ProjectsService.createProject(projectData, user.userId);

    return c.json({
      success: true,
      message: 'Proyecto creado exitosamente',
      data: newProject
    }, 201);

  } catch (error) {
    console.error('❌ [PROJECTS] Error creando proyecto:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * PUT /api/projects/:id
 * Actualiza un proyecto existente
 */
projectsRoutes.put('/api/projects/:id', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ error: 'ID de proyecto inválido' }, 400);
    }

    const projectData = await c.req.json();
    console.log(`📋 [PROJECTS] Actualizando proyecto ${id} por usuario: ${user.userId}`);

    const updatedProject = await ProjectsService.updateProject(id, projectData, user.userId);

    return c.json({
      success: true,
      message: 'Proyecto actualizado exitosamente',
      data: updatedProject
    });

  } catch (error) {
    console.error('❌ [PROJECTS] Error actualizando proyecto:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

