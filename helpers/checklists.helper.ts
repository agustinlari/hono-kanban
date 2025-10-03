// helpers/checklists.helper.ts
import { Hono } from 'hono';
import { pool } from '../config/database';
import type { Context } from 'hono';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import { requirePermission } from '../middleware/permissions';
import { PermissionAction } from '../types';

interface Variables {
  user: {
    userId: number;
    email: string;
    name: string;
  };
}

// ================================
// Clases de servicio
// ================================

export class ChecklistsService {
  /**
   * Obtiene todos los checklists de una tarjeta
   */
  static async getCardChecklists(cardId: string) {
    const client = await pool.connect();
    try {
      console.log(`📋 [CHECKLISTS] Obteniendo checklists para la tarjeta: ${cardId}`);

      const checklistsQuery = `
        SELECT id, card_id, title, position, created_at, updated_at
        FROM card_checklists
        WHERE card_id = $1
        ORDER BY position ASC
      `;

      const checklistsResult = await client.query(checklistsQuery, [cardId]);
      const checklists = checklistsResult.rows;

      // Para cada checklist, obtener sus items
      for (const checklist of checklists) {
        const itemsQuery = `
          SELECT id, checklist_id, description, is_completed, position, created_at, updated_at
          FROM checklist_items
          WHERE checklist_id = $1
          ORDER BY position ASC
        `;

        const itemsResult = await client.query(itemsQuery, [checklist.id]);
        checklist.items = itemsResult.rows;
      }

      console.log(`✅ [CHECKLISTS] ${checklists.length} checklists obtenidos para la tarjeta ${cardId}`);
      return checklists;
    } finally {
      client.release();
    }
  }

  /**
   * Crea un nuevo checklist para una tarjeta
   */
  static async createChecklist(cardId: string, title: string, userId: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Obtener la siguiente posición
      const positionQuery = `
        SELECT COALESCE(MAX(position), 0) + 1 as next_position
        FROM card_checklists
        WHERE card_id = $1
      `;
      const positionResult = await client.query(positionQuery, [cardId]);
      const position = positionResult.rows[0].next_position;

      // Crear el checklist
      const createQuery = `
        INSERT INTO card_checklists (card_id, title, position)
        VALUES ($1, $2, $3)
        RETURNING *
      `;

      const result = await client.query(createQuery, [cardId, title, position]);
      const checklist = result.rows[0];
      checklist.items = []; // Inicializar con array vacío de items

      await client.query('COMMIT');
      console.log(`✅ [CHECKLISTS] Checklist creado: ${checklist.id} para tarjeta ${cardId}`);

      return checklist;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Actualiza el título de un checklist
   */
  static async updateChecklistTitle(checklistId: number, title: string, userId: number) {
    const client = await pool.connect();
    try {
      const updateQuery = `
        UPDATE card_checklists
        SET title = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `;

      const result = await client.query(updateQuery, [title, checklistId]);

      if (result.rows.length === 0) {
        throw new Error('Checklist no encontrado');
      }

      console.log(`✅ [CHECKLISTS] Título del checklist actualizado: ${checklistId}`);
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Elimina un checklist y todos sus items
   */
  static async deleteChecklist(checklistId: number, userId: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que el checklist existe
      const existingQuery = `SELECT * FROM card_checklists WHERE id = $1`;
      const existingResult = await client.query(existingQuery, [checklistId]);

      if (existingResult.rows.length === 0) {
        throw new Error('Checklist no encontrado');
      }

      // Eliminar checklist (los items se eliminan automáticamente por CASCADE)
      const deleteQuery = `DELETE FROM card_checklists WHERE id = $1 RETURNING *`;
      const result = await client.query(deleteQuery, [checklistId]);

      await client.query('COMMIT');
      console.log(`✅ [CHECKLISTS] Checklist eliminado: ${checklistId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Crea un nuevo item en un checklist
   */
  static async createChecklistItem(checklistId: number, description: string, userId: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que el checklist existe
      const checklistQuery = `SELECT * FROM card_checklists WHERE id = $1`;
      const checklistResult = await client.query(checklistQuery, [checklistId]);

      if (checklistResult.rows.length === 0) {
        throw new Error('Checklist no encontrado');
      }

      // Obtener la siguiente posición
      const positionQuery = `
        SELECT COALESCE(MAX(position), 0) + 1 as next_position
        FROM checklist_items
        WHERE checklist_id = $1
      `;
      const positionResult = await client.query(positionQuery, [checklistId]);
      const position = positionResult.rows[0].next_position;

      // Crear el item
      const createQuery = `
        INSERT INTO checklist_items (checklist_id, description, position)
        VALUES ($1, $2, $3)
        RETURNING *
      `;

      const result = await client.query(createQuery, [checklistId, description, position]);
      const item = result.rows[0];

      await client.query('COMMIT');
      console.log(`✅ [CHECKLISTS] Item creado: ${item.id} en checklist ${checklistId}`);

      return item;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Actualiza un item del checklist
   */
  static async updateChecklistItem(itemId: number, updates: { description?: string; is_completed?: boolean }, userId: number) {
    const client = await pool.connect();
    try {
      // Construir query dinámicamente basado en los campos a actualizar
      const setParts = [];
      const values = [];
      let paramCount = 1;

      if (updates.description !== undefined) {
        setParts.push(`description = $${paramCount}`);
        values.push(updates.description);
        paramCount++;
      }

      if (updates.is_completed !== undefined) {
        setParts.push(`is_completed = $${paramCount}`);
        values.push(updates.is_completed);
        paramCount++;
      }

      if (setParts.length === 0) {
        throw new Error('No hay campos para actualizar');
      }

      setParts.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(itemId);

      const updateQuery = `
        UPDATE checklist_items
        SET ${setParts.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      if (result.rows.length === 0) {
        throw new Error('Item no encontrado');
      }

      console.log(`✅ [CHECKLISTS] Item actualizado: ${itemId}`);
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Elimina un item del checklist
   */
  static async deleteChecklistItem(itemId: number, userId: number) {
    const client = await pool.connect();
    try {
      const deleteQuery = `DELETE FROM checklist_items WHERE id = $1 RETURNING *`;
      const result = await client.query(deleteQuery, [itemId]);

      if (result.rows.length === 0) {
        throw new Error('Item no encontrado');
      }

      console.log(`✅ [CHECKLISTS] Item eliminado: ${itemId}`);
      return result.rows[0];
    } finally {
      client.release();
    }
  }
}

// ================================
// Rutas de la API
// ================================

export const checklistsRoutes = new Hono<{ Variables: Variables }>();

// Aplicar middleware de autenticación a todas las rutas
checklistsRoutes.use('*', keycloakAuthMiddleware);

/**
 * GET /api/cards/:cardId/checklists
 * Obtiene todos los checklists de una tarjeta
 */
checklistsRoutes.get('/api/cards/:cardId/checklists', requirePermission(PermissionAction.VIEW), async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const cardId = c.req.param('cardId');
    console.log(`📋 [CHECKLISTS] Obteniendo checklists para tarjeta: ${cardId} por usuario: ${user.userId}`);

    const checklists = await ChecklistsService.getCardChecklists(cardId);

    return c.json(checklists);
  } catch (error) {
    console.error('❌ [CHECKLISTS] Error obteniendo checklists:', error);
    return c.json({
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * POST /api/cards/:cardId/checklists
 * Crea un nuevo checklist para una tarjeta
 */
checklistsRoutes.post('/api/cards/:cardId/checklists', requirePermission(PermissionAction.EDIT_CARDS), async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const cardId = c.req.param('cardId');
    const body = await c.req.json();
    const { title } = body;

    if (!title || !title.trim()) {
      return c.json({ error: 'El título es requerido' }, 400);
    }

    console.log(`📋 [CHECKLISTS] Creando checklist para tarjeta: ${cardId} por usuario: ${user.userId}`);

    const checklist = await ChecklistsService.createChecklist(cardId, title.trim(), user.userId);

    return c.json(checklist, 201);
  } catch (error) {
    console.error('❌ [CHECKLISTS] Error creando checklist:', error);
    return c.json({
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * PUT /api/checklists/:checklistId
 * Actualiza el título de un checklist
 */
checklistsRoutes.put('/api/checklists/:checklistId', requirePermission(PermissionAction.EDIT_CARDS), async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const checklistId = parseInt(c.req.param('checklistId'), 10);
    if (isNaN(checklistId)) {
      return c.json({ error: 'ID de checklist inválido' }, 400);
    }

    const body = await c.req.json();
    const { title } = body;

    if (!title || !title.trim()) {
      return c.json({ error: 'El título es requerido' }, 400);
    }

    console.log(`📋 [CHECKLISTS] Actualizando checklist: ${checklistId} por usuario: ${user.userId}`);

    const checklist = await ChecklistsService.updateChecklistTitle(checklistId, title.trim(), user.userId);

    return c.json(checklist);
  } catch (error) {
    console.error('❌ [CHECKLISTS] Error actualizando checklist:', error);
    return c.json({
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * DELETE /api/checklists/:checklistId
 * Elimina un checklist
 */
checklistsRoutes.delete('/api/checklists/:checklistId', requirePermission(PermissionAction.EDIT_CARDS), async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const checklistId = parseInt(c.req.param('checklistId'), 10);
    if (isNaN(checklistId)) {
      return c.json({ error: 'ID de checklist inválido' }, 400);
    }

    console.log(`📋 [CHECKLISTS] Eliminando checklist: ${checklistId} por usuario: ${user.userId}`);

    const deletedChecklist = await ChecklistsService.deleteChecklist(checklistId, user.userId);

    return c.json({
      message: 'Checklist eliminado exitosamente',
      data: deletedChecklist
    });
  } catch (error) {
    console.error('❌ [CHECKLISTS] Error eliminando checklist:', error);
    return c.json({
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * POST /api/checklists/:checklistId/items
 * Crea un nuevo item en un checklist
 */
checklistsRoutes.post('/api/checklists/:checklistId/items', requirePermission(PermissionAction.EDIT_CARDS), async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const checklistId = parseInt(c.req.param('checklistId'), 10);
    if (isNaN(checklistId)) {
      return c.json({ error: 'ID de checklist inválido' }, 400);
    }

    const body = await c.req.json();
    const { description } = body;

    if (!description || !description.trim()) {
      return c.json({ error: 'La descripción es requerida' }, 400);
    }

    console.log(`📋 [CHECKLISTS] Creando item en checklist: ${checklistId} por usuario: ${user.userId}`);

    const item = await ChecklistsService.createChecklistItem(checklistId, description.trim(), user.userId);

    return c.json(item, 201);
  } catch (error) {
    console.error('❌ [CHECKLISTS] Error creando item:', error);
    return c.json({
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * PUT /api/checklist-items/:itemId
 * Actualiza un item del checklist
 */
checklistsRoutes.put('/api/checklist-items/:itemId', requirePermission(PermissionAction.EDIT_CARDS), async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const itemId = parseInt(c.req.param('itemId'), 10);
    if (isNaN(itemId)) {
      return c.json({ error: 'ID de item inválido' }, 400);
    }

    const body = await c.req.json();
    const updates: { description?: string; is_completed?: boolean } = {};

    if (body.description !== undefined) {
      if (!body.description.trim()) {
        return c.json({ error: 'La descripción no puede estar vacía' }, 400);
      }
      updates.description = body.description.trim();
    }

    if (body.is_completed !== undefined) {
      updates.is_completed = Boolean(body.is_completed);
    }

    console.log(`📋 [CHECKLISTS] Actualizando item: ${itemId} por usuario: ${user.userId}`);

    const item = await ChecklistsService.updateChecklistItem(itemId, updates, user.userId);

    return c.json(item);
  } catch (error) {
    console.error('❌ [CHECKLISTS] Error actualizando item:', error);
    return c.json({
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * DELETE /api/checklist-items/:itemId
 * Elimina un item del checklist
 */
checklistsRoutes.delete('/api/checklist-items/:itemId', requirePermission(PermissionAction.EDIT_CARDS), async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    const itemId = parseInt(c.req.param('itemId'), 10);
    if (isNaN(itemId)) {
      return c.json({ error: 'ID de item inválido' }, 400);
    }

    console.log(`📋 [CHECKLISTS] Eliminando item: ${itemId} por usuario: ${user.userId}`);

    const deletedItem = await ChecklistsService.deleteChecklistItem(itemId, user.userId);

    return c.json({
      message: 'Item eliminado exitosamente',
      data: deletedItem
    });
  } catch (error) {
    console.error('❌ [CHECKLISTS] Error eliminando item:', error);
    return c.json({
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});