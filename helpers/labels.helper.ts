// En: src/helpers/labels.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { authMiddleware } from '../middleware/auth';
import { requirePermission, requireBoardAccess } from '../middleware/permissions';
import type { Variables } from '../types';
import { PermissionAction } from '../types';
import type { 
  Label, 
  CreateLabelPayload, 
  UpdateLabelPayload, 
  CardLabelPayload 
} from '../types/kanban.types';

// ================================
// Lógica de Servicio (LabelService)
// ================================
class LabelService {
  /**
   * Obtiene todas las etiquetas de un tablero
   */
  static async getLabelsByBoardId(boardId: number): Promise<Label[]> {
    const query = `
      SELECT id, board_id, name, color, created_at, updated_at
      FROM labels 
      WHERE board_id = $1 
      ORDER BY created_at ASC
    `;
    const result = await pool.query(query, [boardId]);
    return result.rows;
  }

  /**
   * Crea una nueva etiqueta en un tablero
   */
  static async createLabel(data: CreateLabelPayload): Promise<Label> {
    const { board_id, name, color } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que el tablero existe
      const boardCheck = await client.query('SELECT id FROM boards WHERE id = $1', [board_id]);
      if (boardCheck.rowCount === 0) {
        throw new Error('El tablero especificado no existe.');
      }

      // Crear la etiqueta
      const query = `
        INSERT INTO labels (board_id, name, color) 
        VALUES ($1, $2, $3) 
        RETURNING *
      `;
      const result = await client.query(query, [board_id, name, color]);
      
      await client.query('COMMIT');
      return result.rows[0] as Label;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en LabelService.createLabel:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Actualiza una etiqueta existente
   */
  static async updateLabel(id: number, data: UpdateLabelPayload): Promise<Label | null> {
    console.log(`🏷️ [LabelService.updateLabel] Iniciando actualización de etiqueta ${id}`, data);
    
    const fieldsToUpdate = Object.keys(data) as Array<keyof UpdateLabelPayload>;
    console.log(`🔍 [LabelService.updateLabel] Campos a actualizar:`, fieldsToUpdate);
    
    if (fieldsToUpdate.length === 0) {
      console.log(`⚠️ [LabelService.updateLabel] No hay campos para actualizar`);
      const currentLabel = await pool.query('SELECT * FROM labels WHERE id = $1', [id]);
      return currentLabel.rows[0] || null;
    }

    const setClause = fieldsToUpdate.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
    const queryValues = fieldsToUpdate.map(key => data[key]);
    queryValues.push(id);

    const query = `
      UPDATE labels 
      SET ${setClause}, updated_at = NOW()
      WHERE id = $${queryValues.length} 
      RETURNING *
    `;
    
    console.log(`📝 [LabelService.updateLabel] Query SQL:`, query);
    console.log(`📝 [LabelService.updateLabel] Valores:`, queryValues);
    
    const result = await pool.query(query, queryValues);
    console.log(`✅ [LabelService.updateLabel] Resultado:`, result.rows[0]);
    return result.rows[0] || null;
  }

  /**
   * Elimina una etiqueta (también se elimina de todas las tarjetas)
   */
  static async deleteLabel(id: number): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const deleteResult = await client.query('DELETE FROM labels WHERE id = $1', [id]);
      
      await client.query('COMMIT');
      return (deleteResult.rowCount ?? 0) > 0;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en LabelService.deleteLabel:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Asigna una etiqueta a una tarjeta
   */
  static async assignLabelToCard(cardId: string, labelId: number): Promise<void> {
    console.log(`🔗 [LabelService.assignLabelToCard] Iniciando asignación - cardId: ${cardId}, labelId: ${labelId}`);
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      console.log('📝 [LabelService.assignLabelToCard] Transacción iniciada');

      // Verificar que la tarjeta existe
      console.log(`🃏 [LabelService.assignLabelToCard] Verificando tarjeta ${cardId}...`);
      const cardCheck = await client.query('SELECT id FROM cards WHERE id = $1', [cardId]);
      console.log(`🎯 [LabelService.assignLabelToCard] Tarjetas encontradas: ${cardCheck.rowCount}`);
      
      if (cardCheck.rowCount === 0) {
        throw new Error('La tarjeta especificada no existe.');
      }

      // Verificar que la etiqueta existe
      console.log(`🏷️ [LabelService.assignLabelToCard] Verificando etiqueta ${labelId}...`);
      const labelCheck = await client.query('SELECT id FROM labels WHERE id = $1', [labelId]);
      console.log(`🎯 [LabelService.assignLabelToCard] Etiquetas encontradas: ${labelCheck.rowCount}`);
      
      if (labelCheck.rowCount === 0) {
        throw new Error('La etiqueta especificada no existe.');
      }

      // Asignar etiqueta (INSERT IGNORE equivalente con ON CONFLICT)
      console.log('💾 [LabelService.assignLabelToCard] Insertando relación...');
      const query = `
        INSERT INTO card_labels (card_id, label_id) 
        VALUES ($1, $2)
        ON CONFLICT (card_id, label_id) DO NOTHING
      `;
      await client.query(query, [cardId, labelId]);
      console.log('✅ [LabelService.assignLabelToCard] Relación insertada');
      
      await client.query('COMMIT');
      console.log('🎉 [LabelService.assignLabelToCard] Transacción completada exitosamente');

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('💥 [LabelService.assignLabelToCard] Error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Desasigna una etiqueta de una tarjeta
   */
  static async unassignLabelFromCard(cardId: string, labelId: number): Promise<boolean> {
    const deleteResult = await pool.query(
      'DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2',
      [cardId, labelId]
    );
    return (deleteResult.rowCount ?? 0) > 0;
  }

  /**
   * Obtiene todas las etiquetas de una tarjeta específica
   */
  static async getLabelsForCard(cardId: string): Promise<Label[]> {
    const query = `
      SELECT l.id, l.board_id, l.name, l.color, l.created_at, l.updated_at
      FROM labels l
      INNER JOIN card_labels cl ON l.id = cl.label_id
      WHERE cl.card_id = $1
      ORDER BY l.name ASC
    `;
    const result = await pool.query(query, [cardId]);
    return result.rows;
  }
}

// ================================
// Lógica de Controlador (LabelController)
// ================================
class LabelController {
  /**
   * Obtiene todas las etiquetas de un tablero
   */
  static async getByBoardId(c: Context) {
    try {
      const boardId = parseInt(c.req.param('boardId'));
      if (isNaN(boardId)) {
        return c.json({ error: 'ID de tablero inválido' }, 400);
      }

      const labels = await LabelService.getLabelsByBoardId(boardId);
      return c.json(labels);

    } catch (error: any) {
      console.error(`Error en LabelController.getByBoardId para boardId ${c.req.param('boardId')}:`, error);
      return c.json({ error: 'Error al obtener las etiquetas del tablero' }, 500);
    }
  }

  /**
   * Crea una nueva etiqueta
   */
  static async create(c: Context) {
    try {
      const data: CreateLabelPayload = await c.req.json();

      if (!data.board_id || typeof data.board_id !== 'number') {
        return c.json({ error: 'board_id es requerido y debe ser un número' }, 400);
      }
      if (!data.name || typeof data.name !== 'string') {
        return c.json({ error: 'name es requerido y debe ser un string' }, 400);
      }
      if (!data.color || typeof data.color !== 'string') {
        return c.json({ error: 'color es requerido y debe ser un string' }, 400);
      }

      // Validar formato de color hex
      if (!/^#[0-9A-F]{6}$/i.test(data.color)) {
        return c.json({ error: 'color debe ser un valor hexadecimal válido (ej: #FF5733)' }, 400);
      }

      const newLabel = await LabelService.createLabel(data);
      return c.json(newLabel, 201);

    } catch (error: any) {
      console.error('Error en LabelController.create:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      if (error.code === '23505') { // Unique constraint violation
        return c.json({ error: 'Ya existe una etiqueta con ese nombre en este tablero' }, 409);
      }
      return c.json({ error: 'No se pudo crear la etiqueta' }, 500);
    }
  }

  /**
   * Actualiza una etiqueta
   */
  static async update(c: Context) {
    try {
      console.log(`🎯 [LabelController.update] REQUEST recibido para ID: ${c.req.param('id')}`);
      
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        console.log(`❌ [LabelController.update] ID inválido: ${c.req.param('id')}`);
        return c.json({ error: 'ID de etiqueta inválido' }, 400);
      }

      const data: UpdateLabelPayload = await c.req.json();
      console.log(`📦 [LabelController.update] Datos recibidos:`, data);

      if (Object.keys(data).length === 0) {
        console.log(`❌ [LabelController.update] Cuerpo vacío`);
        return c.json({ error: 'El cuerpo de la petición no puede estar vacío' }, 400);
      }

      // Validar color si se proporciona
      if (data.color && !/^#[0-9A-F]{6}$/i.test(data.color)) {
        console.log(`❌ [LabelController.update] Color inválido: ${data.color}`);
        return c.json({ error: 'color debe ser un valor hexadecimal válido (ej: #FF5733)' }, 400);
      }

      console.log(`🔄 [LabelController.update] Llamando a LabelService.updateLabel...`);
      const updatedLabel = await LabelService.updateLabel(id, data);

      if (!updatedLabel) {
        console.log(`❌ [LabelController.update] Etiqueta no encontrada: ${id}`);
        return c.json({ error: `Etiqueta con ID ${id} no encontrada` }, 404);
      }

      console.log(`✅ [LabelController.update] Etiqueta actualizada exitosamente:`, updatedLabel);
      return c.json(updatedLabel);

    } catch (error: any) {
      console.error(`💥 [LabelController.update] Error para id ${c.req.param('id')}:`, error);
      if (error.code === '23505') {
        return c.json({ error: 'Ya existe una etiqueta con ese nombre en este tablero' }, 409);
      }
      return c.json({ error: 'No se pudo actualizar la etiqueta' }, 500);
    }
  }

  /**
   * Elimina una etiqueta
   */
  static async delete(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de etiqueta inválido' }, 400);
      }

      const wasDeleted = await LabelService.deleteLabel(id);

      if (!wasDeleted) {
        return c.json({ error: `Etiqueta con ID ${id} no encontrada` }, 404);
      }

      return c.body(null, 204);

    } catch (error: any) {
      console.error(`Error en LabelController.delete para id ${c.req.param('id')}:`, error);
      return c.json({ error: 'No se pudo eliminar la etiqueta' }, 500);
    }
  }

  /**
   * Asigna una etiqueta a una tarjeta
   */
  static async assignToCard(c: Context) {
    try {
      console.log('🏷️ [LabelController.assignToCard] REQUEST recibido');
      
      const data: CardLabelPayload = await c.req.json();
      console.log('📦 [LabelController.assignToCard] Datos recibidos:', data);
      console.log('🔍 [LabelController.assignToCard] Tipos:', {
        card_id: typeof data.card_id,
        label_id: typeof data.label_id,
        card_id_value: data.card_id,
        label_id_value: data.label_id
      });

      if (!data.card_id || !data.label_id) {
        console.error('❌ [LabelController.assignToCard] Faltan datos requeridos:', {
          card_id: data.card_id,
          label_id: data.label_id
        });
        return c.json({ error: 'card_id y label_id son requeridos' }, 400);
      }

      console.log('✨ [LabelController.assignToCard] Llamando a LabelService...');
      await LabelService.assignLabelToCard(data.card_id, data.label_id);
      console.log('✅ [LabelController.assignToCard] Etiqueta asignada exitosamente');
      
      return c.json({ mensaje: 'Etiqueta asignada exitosamente' });

    } catch (error: any) {
      console.error('💥 [LabelController.assignToCard] Error:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo asignar la etiqueta' }, 500);
    }
  }

  /**
   * Desasigna una etiqueta de una tarjeta
   */
  static async unassignFromCard(c: Context) {
    try {
      const cardId = c.req.param('cardId');
      const labelId = parseInt(c.req.param('labelId'));

      if (!cardId || isNaN(labelId)) {
        return c.json({ error: 'cardId y labelId son requeridos' }, 400);
      }

      const wasUnassigned = await LabelService.unassignLabelFromCard(cardId, labelId);

      if (!wasUnassigned) {
        return c.json({ error: 'La etiqueta no estaba asignada a esta tarjeta' }, 404);
      }

      return c.json({ mensaje: 'Etiqueta desasignada exitosamente' });

    } catch (error: any) {
      console.error('Error en LabelController.unassignFromCard:', error);
      return c.json({ error: 'No se pudo desasignar la etiqueta' }, 500);
    }
  }

  /**
   * Obtiene las etiquetas de una tarjeta
   */
  static async getCardLabels(c: Context) {
    try {
      const cardId = c.req.param('cardId');
      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }

      const labels = await LabelService.getLabelsForCard(cardId);
      return c.json(labels);

    } catch (error: any) {
      console.error(`Error en LabelController.getCardLabels para cardId ${c.req.param('cardId')}:`, error);
      return c.json({ error: 'Error al obtener las etiquetas de la tarjeta' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Etiquetas
// ================================
export const labelRoutes = new Hono<{ Variables: Variables }>();

labelRoutes.use('*', authMiddleware);

// Rutas de etiquetas por tablero
labelRoutes.get('/boards/:boardId/labels', requireBoardAccess(), LabelController.getByBoardId);
labelRoutes.post('/labels', requirePermission(PermissionAction.MANAGE_LABELS), LabelController.create);
labelRoutes.put('/labels/:id', requirePermission(PermissionAction.MANAGE_LABELS), LabelController.update);
labelRoutes.delete('/labels/:id', requirePermission(PermissionAction.MANAGE_LABELS), LabelController.delete);

// Rutas de asignación de etiquetas a tarjetas (requiere editar tarjetas)
labelRoutes.post('/cards/labels', requirePermission(PermissionAction.EDIT_CARDS), LabelController.assignToCard);
labelRoutes.delete('/cards/:cardId/labels/:labelId', requirePermission(PermissionAction.EDIT_CARDS), LabelController.unassignFromCard);
labelRoutes.get('/cards/:cardId/labels', requireBoardAccess(), LabelController.getCardLabels);