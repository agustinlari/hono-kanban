// En: src/helpers/lists.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';
import type { List, CreateListPayload } from '../types/kanban.types';

// ================================
// Lógica de Servicio (ListService)
// ================================
class ListService {
  /**
   * Crea una nueva lista en un tablero específico.
   * Calcula automáticamente la posición para que se añada al final.
   */
  static async createList(data: CreateListPayload): Promise<List> {
    const { title, board_id } = data;

    // 1. Iniciar una transacción para garantizar la consistencia de los datos.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 2. Comprobar si el tablero existe para evitar errores de clave foránea.
      const boardCheck = await client.query('SELECT id FROM boards WHERE id = $1', [board_id]);
      if (boardCheck.rowCount === 0) {
        throw new Error('El tablero especificado no existe.');
      }

      // 3. Calcular la nueva posición. Será el número de listas que ya existen en ese tablero.
      const positionResult = await client.query(
        'SELECT COUNT(*) as count FROM lists WHERE board_id = $1',
        [board_id]
      );
      const newPosition = parseInt(positionResult.rows[0].count);

      // 4. Insertar la nueva lista en la base de datos.
      const query = `
        INSERT INTO lists (title, board_id, position) 
        VALUES ($1, $2, $3) RETURNING *;
      `;
      const result = await client.query(query, [title, board_id, newPosition]);
      
      // 5. Confirmar la transacción.
      await client.query('COMMIT');

      // 6. Devolver la nueva lista creada (sin tarjetas, ya que es nueva).
      const newList = result.rows[0];
      return { ...newList, cards: [] };

    } catch (error) {
      // Si algo falla, revertir todos los cambios.
      await client.query('ROLLBACK');
      console.error('Error en ListService.createList:', error);
      throw error; // Relanzar para que el controlador lo maneje.
    } finally {
      // Liberar la conexión al pool.
      client.release();
    }
  }

   static async updateListTitle(id: number, newTitle: string): Promise<List | null> {
    const query = `
      UPDATE lists 
      SET title = $1 
      WHERE id = $2 
      RETURNING *;
    `;
    const result = await pool.query(query, [newTitle, id]);

    if (result.rowCount === 0) {
      return null; // La lista no fue encontrada
    }

    // Devolvemos la lista actualizada. Asumimos que no necesitamos sus tarjetas para esta operación.
    const updatedList = result.rows[0];
    return { ...updatedList, cards: [] };
  }

    static async deleteList(id: number): Promise<boolean> {
        const query = 'DELETE FROM lists WHERE id = $1';
        const result = await pool.query(query, [id]);

        // --- CAMBIO AQUÍ ---
        // Hacemos una comprobación explícita.
        if (!result || typeof result.rowCount !== 'number') {
        return false; // No se pudo determinar si se borró, así que asumimos que no.
  }

  return result.rowCount > 0;
}
  /**
   * Reordena las tarjetas de una lista según el array de IDs proporcionado.
   * Actualiza las posiciones de todas las tarjetas en una sola transacción.
   */
  static async sortCards(listId: number, cardIds: string[]): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que la lista existe
      const listCheck = await client.query('SELECT id FROM lists WHERE id = $1', [listId]);
      if (listCheck.rowCount === 0) {
        throw new Error('La lista especificada no existe.');
      }

      // Actualizar la posición de cada tarjeta según su índice en el array
      for (let i = 0; i < cardIds.length; i++) {
        await client.query(
          'UPDATE cards SET position = $1 WHERE id = $2 AND list_id = $3',
          [i, cardIds[i], listId]
        );
      }

      await client.query('COMMIT');
      return true;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en ListService.sortCards:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Lógica de Controlador (ListController)
// ================================
class ListController {
  static async create(c: Context) {
    try {
      const data: CreateListPayload = await c.req.json();

      // Validación básica de los datos de entrada
      if (!data.title || typeof data.title !== 'string' || !data.board_id || typeof data.board_id !== 'number') {
        return c.json({ error: 'Los campos "title" (string) y "board_id" (number) son requeridos' }, 400);
      }

      const newList = await ListService.createList(data);
      return c.json(newList, 201);

    } catch (error: any) {
      console.error('Error en ListController.create:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo crear la lista' }, 500);
    }
  }

    static async updateTitle(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de lista inválido' }, 400);
      }

      const { title } = await c.req.json<{ title: string }>();
      if (!title || typeof title !== 'string') {
        return c.json({ error: 'El campo "title" es requerido y debe ser un string' }, 400);
      }

      const updatedList = await ListService.updateListTitle(id, title);

      if (!updatedList) {
        return c.json({ error: `Lista con ID ${id} no encontrada` }, 404);
      }

      return c.json(updatedList, 200);

    } catch (error: any) {
      console.error(`Error en ListController.updateTitle para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'No se pudo actualizar la lista' }, 500);
    }
  }

  static async delete(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de lista inválido' }, 400);
      }

      const wasDeleted = await ListService.deleteList(id);

      if (!wasDeleted) {
        return c.json({ error: `Lista con ID ${id} no encontrada` }, 404);
      }

      // Devolvemos una respuesta vacía con éxito, es una práctica común para DELETE.
      return c.body(null, 204);
      // Alternativa: return c.json({ mensaje: 'Lista eliminada con éxito' }, 200);

    } catch (error: any) {
      console.error(`Error en ListController.delete para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'No se pudo eliminar la lista' }, 500);
    }
  }

  static async sortCards(c: Context) {
    try {
      const listId = parseInt(c.req.param('id'));
      if (isNaN(listId)) {
        return c.json({ error: 'ID de lista inválido' }, 400);
      }

      const { cardIds } = await c.req.json<{ cardIds: string[] }>();
      if (!cardIds || !Array.isArray(cardIds)) {
        return c.json({ error: 'El campo "cardIds" es requerido y debe ser un array' }, 400);
      }

      await ListService.sortCards(listId, cardIds);
      return c.json({ success: true }, 200);

    } catch (error: any) {
      console.error(`Error en ListController.sortCards para el id ${c.req.param('id')}:`, error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo ordenar las tarjetas' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Listas
// ================================
export const listRoutes = new Hono<{ Variables: Variables }>();

// Todas las rutas de listas también requerirán autenticación.
listRoutes.use('*', keycloakAuthMiddleware);

// Endpoint para crear una nueva lista
listRoutes.post('/lists', ListController.create);

// Endpoint para actualizar el título de una lista
listRoutes.put('/lists/:id', ListController.updateTitle);

// Endpoint para eliminar una lista
listRoutes.delete('/lists/:id', ListController.delete);

// Endpoint para ordenar las tarjetas de una lista
listRoutes.patch('/lists/:id/sort', ListController.sortCards);