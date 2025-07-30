// En: src/helpers/cards.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { authMiddleware } from '../middleware/auth';
import type { Variables } from '../types';
import type { Card, CreateCardPayload, UpdateCardPayload, MoveCardPayload } from '../types/kanban.types';

// ================================
// Lógica de Servicio (CardService)
// ================================
class CardService {
  /**
   * Crea una nueva tarjeta en una lista específica.
   * Calcula automáticamente la posición para que se añada al final.
   */
  static async createCard(data: CreateCardPayload): Promise<Card> {
    const { title, list_id } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Comprobar si la lista existe.
      const listCheck = await client.query('SELECT id FROM lists WHERE id = $1', [list_id]);
      if (listCheck.rowCount === 0) {
        throw new Error('La lista especificada no existe.');
      }

      // 2. Calcular la nueva posición de la tarjeta dentro de esa lista.
      const positionResult = await client.query(
        'SELECT COUNT(*) as count FROM cards WHERE list_id = $1',
        [list_id]
      );
      const newPosition = parseInt(positionResult.rows[0].count);

      // 3. Insertar la nueva tarjeta.
      const query = `
        INSERT INTO cards (title, list_id, position) 
        VALUES ($1, $2, $3) RETURNING *;
      `;
      const result = await client.query(query, [title, list_id, newPosition]);
      
      await client.query('COMMIT');
      
      return result.rows[0] as Card;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.createCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  static async updateCard(id: string, data: UpdateCardPayload): Promise<Card | null> {
    const fieldsToUpdate = Object.keys(data) as Array<keyof UpdateCardPayload>;
    
    // Si no se proporcionan campos para actualizar, no hacemos nada.
    if (fieldsToUpdate.length === 0) {
      // Opcionalmente, podrías devolver la tarjeta actual o un error.
      // Devolver la tarjeta actual puede ser útil.
      const currentCard = await pool.query('SELECT * FROM cards WHERE id = $1', [id]);
      return currentCard.rows[0] || null;
    }

    // Construcción dinámica de la cláusula SET
    // ej: "title" = $1, "description" = $2
    const setClause = fieldsToUpdate.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
    
    const queryValues = fieldsToUpdate.map(key => data[key]);
    queryValues.push(id); // El último parámetro será el ID para la cláusula WHERE

    const query = `
      UPDATE cards 
      SET ${setClause} 
      WHERE id = $${queryValues.length} 
      RETURNING *;
    `;
    
    const result = await pool.query(query, queryValues);

    if (result.rowCount === 0) {
      return null; // La tarjeta no fue encontrada
    }

    return result.rows[0] as Card;
  }

  /**
   * Elimina una tarjeta específica por su ID.
   */
  static async deleteCard(id: string): Promise<boolean> {
    // A diferencia de las listas, borrar una tarjeta no tiene efectos en cascada.
    // Pero sí necesitaremos reordenar las tarjetas restantes en su lista.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Obtener la list_id y la posición de la tarjeta que vamos a borrar.
      const cardMetaResult = await client.query(
        'SELECT list_id, position FROM cards WHERE id = $1',
        [id]
      );

      if (cardMetaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return false; // La tarjeta no existe
      }
      const { list_id, position } = cardMetaResult.rows[0];

      // 2. Borrar la tarjeta.
      await client.query('DELETE FROM cards WHERE id = $1', [id]);

      // 3. Reordenar las tarjetas restantes en la misma lista.
      // Todas las tarjetas que estaban después de la borrada, deben retroceder una posición.
      await client.query(
        'UPDATE cards SET position = position - 1 WHERE list_id = $1 AND position > $2',
        [list_id, position]
      );
      
      await client.query('COMMIT');
      return true;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.deleteCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async moveCard(data: MoveCardPayload): Promise<void> {
    const { cardId, sourceListId, targetListId, newIndex } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Obtener la posición original de la tarjeta que se está moviendo.
      const cardResult = await client.query('SELECT position FROM cards WHERE id = $1', [cardId]);
      if (cardResult.rowCount === 0) {
        throw new Error('La tarjeta a mover no existe.');
      }
      const originalIndex = cardResult.rows[0].position;

      // CASO A: Mover dentro de la misma lista
      if (sourceListId === targetListId) {
        // "Sacar" la tarjeta de su posición actual
        await client.query(
          'UPDATE cards SET position = -1 WHERE id = $1',
          [cardId]
        );

        // Si se mueve de una posición baja a una alta (ej: 1 -> 3)
        if (originalIndex < newIndex) {
          // Las tarjetas entre la posición antigua y la nueva retroceden un lugar.
          await client.query(
            'UPDATE cards SET position = position - 1 WHERE list_id = $1 AND position > $2 AND position <= $3',
            [sourceListId, originalIndex, newIndex]
          );
        } 
        // Si se mueve de una posición alta a una baja (ej: 3 -> 1)
        else { 
          // Las tarjetas entre la posición nueva y la antigua avanzan un lugar.
          await client.query(
            'UPDATE cards SET position = position + 1 WHERE list_id = $1 AND position >= $2 AND position < $3',
            [sourceListId, newIndex, originalIndex]
          );
        }
      } 
      // CASO B: Mover a una lista diferente
      else {
        // 2a. Cerrar el hueco en la lista de origen.
        // Todas las tarjetas que estaban después de la movida retroceden una posición.
        await client.query(
          'UPDATE cards SET position = position - 1 WHERE list_id = $1 AND position > $2',
          [sourceListId, originalIndex]
        );

        // 2b. Hacer espacio en la lista de destino.
        // Todas las tarjetas en o después del nuevo índice avanzan una posición.
        await client.query(
          'UPDATE cards SET position = position + 1 WHERE list_id = $1 AND position >= $2',
          [targetListId, newIndex]
        );
      }

      // 3. Finalmente, actualizar la tarjeta movida a su nueva lista y posición.
      await client.query(
        'UPDATE cards SET list_id = $1, position = $2 WHERE id = $3',
        [targetListId, newIndex, cardId]
      );
      
      await client.query('COMMIT');

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en CardService.moveCard:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Lógica de Controlador (CardController)
// ================================
class CardController {
  static async create(c: Context) {
    try {
      const data: CreateCardPayload = await c.req.json();

      if (!data.title || typeof data.title !== 'string' || !data.list_id || typeof data.list_id !== 'number') {
        return c.json({ error: 'Los campos "title" (string) y "list_id" (number) son requeridos' }, 400);
      }

      const newCard = await CardService.createCard(data);
      return c.json(newCard, 201);

    } catch (error: any) {
      console.error('Error en CardController.create:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo crear la tarjeta' }, 500);
    }
  }
    static async update(c: Context) {
    try {
      const id = c.req.param('id');
      const data: UpdateCardPayload = await c.req.json();

      if (Object.keys(data).length === 0) {
        return c.json({ error: 'El cuerpo de la petición no puede estar vacío.' }, 400);
      }

      const updatedCard = await CardService.updateCard(id, data);

      if (!updatedCard) {
        return c.json({ error: `Tarjeta con ID ${id} no encontrada` }, 404);
      }

      return c.json(updatedCard, 200);

    } catch (error: any) {
      console.error(`Error en CardController.update para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'No se pudo actualizar la tarjeta' }, 500);
    }
  }

  /**
   * Maneja la eliminación de una tarjeta.
   */
  static async delete(c: Context) {
    try {
      const id = c.req.param('id');
      const wasDeleted = await CardService.deleteCard(id);

      if (!wasDeleted) {
        return c.json({ error: `Tarjeta con ID ${id} no encontrada` }, 404);
      }

      return c.body(null, 204);

    } catch (error: any) {
      console.error(`Error en CardController.delete para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'No se pudo eliminar la tarjeta' }, 500);
    }
  }
  static async move(c: Context) {
    try {
      const data: MoveCardPayload = await c.req.json();
      
      // Validación básica
      if (!data.cardId || !data.sourceListId || !data.targetListId || data.newIndex === undefined) {
          return c.json({ error: 'Faltan parámetros requeridos (cardId, sourceListId, targetListId, newIndex).' }, 400);
      }
      
      await CardService.moveCard(data);
      
      // La operación fue exitosa, no es necesario devolver contenido.
      return c.body(null, 204);

    } catch (error: any) {
      console.error('Error en CardController.move:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo mover la tarjeta' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Tarjetas
// ================================
export const cardRoutes = new Hono<{ Variables: Variables }>();

cardRoutes.use('*', authMiddleware);

// Endpoint para crear una nueva tarjeta
cardRoutes.post('/cards', CardController.create);
cardRoutes.put('/cards/:id', CardController.update);
cardRoutes.delete('/cards/:id', CardController.delete);
cardRoutes.patch('/cards/move', CardController.move);