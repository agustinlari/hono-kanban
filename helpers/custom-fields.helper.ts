// En: src/helpers/custom-fields.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';
import type {
  CustomFieldDefinition,
  CardCustomFieldValue,
  CreateCustomFieldPayload,
  UpdateCustomFieldPayload,
  SetCustomFieldValuePayload
} from '../types/kanban.types';

// ================================
// Lógica de Servicio (CustomFieldService)
// ================================
class CustomFieldService {
  /**
   * Obtiene todas las definiciones de campos personalizados globales
   */
  static async getAllDefinitions(): Promise<CustomFieldDefinition[]> {
    const query = `
      SELECT id, name, description, data_type, options, created_by, created_at
      FROM custom_field_definitions
      ORDER BY name ASC
    `;
    const result = await pool.query(query);
    return result.rows;
  }

  /**
   * Obtiene una definición de campo por ID
   */
  static async getDefinitionById(id: number): Promise<CustomFieldDefinition | null> {
    const query = `
      SELECT id, name, description, data_type, options, created_by, created_at
      FROM custom_field_definitions
      WHERE id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0] || null;
  }

  /**
   * Crea una nueva definición de campo personalizado
   */
  static async createDefinition(data: CreateCustomFieldPayload, userId: number): Promise<CustomFieldDefinition> {
    const { name, description, data_type, options } = data;

    const query = `
      INSERT INTO custom_field_definitions (name, description, data_type, options, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await pool.query(query, [
      name,
      description || null,
      data_type,
      options ? JSON.stringify(options) : null,
      userId
    ]);
    return result.rows[0] as CustomFieldDefinition;
  }

  /**
   * Actualiza una definición de campo personalizado
   */
  static async updateDefinition(id: number, data: UpdateCustomFieldPayload): Promise<CustomFieldDefinition | null> {
    const fieldsToUpdate = Object.keys(data) as Array<keyof UpdateCustomFieldPayload>;

    if (fieldsToUpdate.length === 0) {
      return this.getDefinitionById(id);
    }

    const setClause = fieldsToUpdate.map((key, index) => {
      if (key === 'options') {
        return `"${key}" = $${index + 1}::jsonb`;
      }
      return `"${key}" = $${index + 1}`;
    }).join(', ');

    const queryValues: any[] = fieldsToUpdate.map(key => {
      if (key === 'options') {
        return data[key] ? JSON.stringify(data[key]) : null;
      }
      return data[key];
    });
    queryValues.push(id);

    const query = `
      UPDATE custom_field_definitions
      SET ${setClause}
      WHERE id = $${queryValues.length}
      RETURNING *
    `;

    const result = await pool.query(query, queryValues);
    return result.rows[0] || null;
  }

  /**
   * Elimina una definición de campo (CASCADE elimina valores asociados)
   */
  static async deleteDefinition(id: number): Promise<boolean> {
    const deleteResult = await pool.query('DELETE FROM custom_field_definitions WHERE id = $1', [id]);
    return (deleteResult.rowCount ?? 0) > 0;
  }

  /**
   * Obtiene los valores de campos personalizados de una tarjeta
   */
  static async getCardFieldValues(cardId: string): Promise<(CardCustomFieldValue & { field: CustomFieldDefinition })[]> {
    const query = `
      SELECT
        v.id,
        v.card_id,
        v.field_id,
        v.text_value,
        v.numeric_value,
        v.bool_value,
        v.date_value,
        v.created_at,
        v.updated_at,
        d.id as "field_id",
        d.name as "field_name",
        d.description as "field_description",
        d.data_type as "field_data_type",
        d.options as "field_options"
      FROM card_custom_field_values v
      INNER JOIN custom_field_definitions d ON v.field_id = d.id
      WHERE v.card_id = $1
      ORDER BY d.name ASC
    `;
    const result = await pool.query(query, [cardId]);

    return result.rows.map(row => ({
      id: row.id,
      card_id: row.card_id,
      field_id: row.field_id,
      text_value: row.text_value,
      numeric_value: row.numeric_value,
      bool_value: row.bool_value,
      date_value: row.date_value,
      created_at: row.created_at,
      updated_at: row.updated_at,
      field: {
        id: row.field_id,
        name: row.field_name,
        description: row.field_description,
        data_type: row.field_data_type,
        options: row.field_options,
        created_by: null,
        created_at: null
      }
    }));
  }

  /**
   * Asigna o actualiza un valor de campo personalizado a una tarjeta
   */
  static async setCardFieldValue(cardId: string, fieldId: number, value: any): Promise<CardCustomFieldValue> {
    // Obtener el tipo de dato del campo
    const fieldDef = await this.getDefinitionById(fieldId);
    if (!fieldDef) {
      throw new Error('El campo personalizado especificado no existe.');
    }

    // Verificar que la tarjeta existe
    const cardCheck = await pool.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (cardCheck.rowCount === 0) {
      throw new Error('La tarjeta especificada no existe.');
    }

    // Preparar los valores según el tipo de dato
    let textValue = null;
    let numericValue = null;
    let boolValue = null;
    let dateValue = null;

    switch (fieldDef.data_type) {
      case 'text':
      case 'select':
        textValue = value !== null && value !== undefined ? String(value) : null;
        break;
      case 'number':
        numericValue = value !== null && value !== undefined ? Number(value) : null;
        break;
      case 'boolean':
        boolValue = value !== null && value !== undefined ? Boolean(value) : null;
        break;
      case 'date':
        dateValue = value ? new Date(value) : null;
        break;
    }

    // UPSERT: insertar o actualizar si ya existe
    const query = `
      INSERT INTO card_custom_field_values (card_id, field_id, text_value, numeric_value, bool_value, date_value)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (card_id, field_id)
      DO UPDATE SET
        text_value = EXCLUDED.text_value,
        numeric_value = EXCLUDED.numeric_value,
        bool_value = EXCLUDED.bool_value,
        date_value = EXCLUDED.date_value,
        updated_at = NOW()
      RETURNING *
    `;
    const result = await pool.query(query, [cardId, fieldId, textValue, numericValue, boolValue, dateValue]);
    return result.rows[0] as CardCustomFieldValue;
  }

  /**
   * Elimina un valor de campo personalizado de una tarjeta
   */
  static async removeCardFieldValue(cardId: string, fieldId: number): Promise<boolean> {
    const deleteResult = await pool.query(
      'DELETE FROM card_custom_field_values WHERE card_id = $1 AND field_id = $2',
      [cardId, fieldId]
    );
    return (deleteResult.rowCount ?? 0) > 0;
  }
}

// ================================
// Lógica de Controlador (CustomFieldController)
// ================================
class CustomFieldController {
  /**
   * Obtiene todas las definiciones de campos personalizados
   */
  static async getAllDefinitions(c: Context) {
    try {
      const definitions = await CustomFieldService.getAllDefinitions();
      return c.json(definitions);
    } catch (error: any) {
      console.error('Error en CustomFieldController.getAllDefinitions:', error);
      return c.json({ error: 'Error al obtener las definiciones de campos' }, 500);
    }
  }

  /**
   * Crea una nueva definición de campo personalizado
   */
  static async createDefinition(c: Context<{ Variables: Variables }>) {
    try {
      const data: CreateCustomFieldPayload = await c.req.json();
      const user = c.get('user');

      console.log('📝 [CustomFieldController.createDefinition] Datos recibidos:', JSON.stringify(data));
      console.log('📝 [CustomFieldController.createDefinition] Usuario:', user?.id);

      // Validaciones
      if (!data.name || typeof data.name !== 'string') {
        console.log('❌ [CustomFieldController.createDefinition] Fallo: name inválido');
        return c.json({ error: 'name es requerido y debe ser un string' }, 400);
      }
      if (!data.data_type || !['text', 'number', 'boolean', 'date', 'select'].includes(data.data_type)) {
        console.log('❌ [CustomFieldController.createDefinition] Fallo: data_type inválido:', data.data_type);
        return c.json({ error: 'data_type es requerido y debe ser: text, number, boolean, date o select' }, 400);
      }
      if (data.data_type === 'select' && (!data.options || !Array.isArray(data.options) || data.options.length === 0)) {
        return c.json({ error: 'Para tipo select, options es requerido y debe ser un array no vacío' }, 400);
      }

      const newDefinition = await CustomFieldService.createDefinition(data, user.id);
      return c.json(newDefinition, 201);

    } catch (error: any) {
      console.error('Error en CustomFieldController.createDefinition:', error);
      if (error.code === '23505') { // Unique constraint violation
        return c.json({ error: 'Ya existe un campo con ese nombre' }, 409);
      }
      return c.json({ error: 'No se pudo crear el campo personalizado' }, 500);
    }
  }

  /**
   * Actualiza una definición de campo personalizado
   */
  static async updateDefinition(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de campo inválido' }, 400);
      }

      const data: UpdateCustomFieldPayload = await c.req.json();

      if (Object.keys(data).length === 0) {
        return c.json({ error: 'El cuerpo de la petición no puede estar vacío' }, 400);
      }

      // Validar data_type si se proporciona
      if (data.data_type && !['text', 'number', 'boolean', 'date', 'select'].includes(data.data_type)) {
        return c.json({ error: 'data_type debe ser: text, number, boolean, date o select' }, 400);
      }

      const updatedDefinition = await CustomFieldService.updateDefinition(id, data);

      if (!updatedDefinition) {
        return c.json({ error: `Campo con ID ${id} no encontrado` }, 404);
      }

      return c.json(updatedDefinition);

    } catch (error: any) {
      console.error(`Error en CustomFieldController.updateDefinition:`, error);
      if (error.code === '23505') {
        return c.json({ error: 'Ya existe un campo con ese nombre' }, 409);
      }
      return c.json({ error: 'No se pudo actualizar el campo personalizado' }, 500);
    }
  }

  /**
   * Elimina una definición de campo personalizado
   */
  static async deleteDefinition(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de campo inválido' }, 400);
      }

      const wasDeleted = await CustomFieldService.deleteDefinition(id);

      if (!wasDeleted) {
        return c.json({ error: `Campo con ID ${id} no encontrado` }, 404);
      }

      return c.body(null, 204);

    } catch (error: any) {
      console.error(`Error en CustomFieldController.deleteDefinition:`, error);
      return c.json({ error: 'No se pudo eliminar el campo personalizado' }, 500);
    }
  }

  /**
   * Obtiene los valores de campos personalizados de una tarjeta
   */
  static async getCardFieldValues(c: Context) {
    try {
      const cardId = c.req.param('cardId');
      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }

      const values = await CustomFieldService.getCardFieldValues(cardId);
      return c.json(values);

    } catch (error: any) {
      console.error(`Error en CustomFieldController.getCardFieldValues:`, error);
      return c.json({ error: 'Error al obtener los valores de campos personalizados' }, 500);
    }
  }

  /**
   * Asigna o actualiza un valor de campo personalizado a una tarjeta
   */
  static async setCardFieldValue(c: Context) {
    try {
      const cardId = c.req.param('cardId');
      const data: SetCustomFieldValuePayload = await c.req.json();

      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }
      if (!data.field_id || typeof data.field_id !== 'number') {
        return c.json({ error: 'field_id es requerido y debe ser un número' }, 400);
      }

      const value = await CustomFieldService.setCardFieldValue(cardId, data.field_id, data.value);
      return c.json(value);

    } catch (error: any) {
      console.error('Error en CustomFieldController.setCardFieldValue:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo asignar el valor del campo' }, 500);
    }
  }

  /**
   * Actualiza un valor de campo personalizado de una tarjeta
   */
  static async updateCardFieldValue(c: Context) {
    try {
      const cardId = c.req.param('cardId');
      const fieldId = parseInt(c.req.param('fieldId'));
      const data = await c.req.json();

      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }
      if (isNaN(fieldId)) {
        return c.json({ error: 'fieldId inválido' }, 400);
      }

      const value = await CustomFieldService.setCardFieldValue(cardId, fieldId, data.value);
      return c.json(value);

    } catch (error: any) {
      console.error('Error en CustomFieldController.updateCardFieldValue:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo actualizar el valor del campo' }, 500);
    }
  }

  /**
   * Elimina un valor de campo personalizado de una tarjeta
   */
  static async removeCardFieldValue(c: Context) {
    try {
      const cardId = c.req.param('cardId');
      const fieldId = parseInt(c.req.param('fieldId'));

      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }
      if (isNaN(fieldId)) {
        return c.json({ error: 'fieldId inválido' }, 400);
      }

      const wasRemoved = await CustomFieldService.removeCardFieldValue(cardId, fieldId);

      if (!wasRemoved) {
        return c.json({ error: 'El valor del campo no existe para esta tarjeta' }, 404);
      }

      return c.body(null, 204);

    } catch (error: any) {
      console.error('Error en CustomFieldController.removeCardFieldValue:', error);
      return c.json({ error: 'No se pudo eliminar el valor del campo' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Campos Personalizados
// ================================
export const customFieldRoutes = new Hono<{ Variables: Variables }>();

customFieldRoutes.use('*', keycloakAuthMiddleware);

// Rutas de definiciones de campos personalizados (globales - solo requieren autenticación)
customFieldRoutes.get('/custom-fields', CustomFieldController.getAllDefinitions);
customFieldRoutes.post('/custom-fields', CustomFieldController.createDefinition);
customFieldRoutes.put('/custom-fields/:id', CustomFieldController.updateDefinition);
customFieldRoutes.delete('/custom-fields/:id', CustomFieldController.deleteDefinition);

// Rutas de valores de campos en tarjetas (solo requieren autenticación)
customFieldRoutes.get('/cards/:cardId/custom-fields', CustomFieldController.getCardFieldValues);
customFieldRoutes.post('/cards/:cardId/custom-fields', CustomFieldController.setCardFieldValue);
customFieldRoutes.put('/cards/:cardId/custom-fields/:fieldId', CustomFieldController.updateCardFieldValue);
customFieldRoutes.delete('/cards/:cardId/custom-fields/:fieldId', CustomFieldController.removeCardFieldValue);
