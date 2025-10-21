// En: src/helpers/card-links.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import { requirePermission } from '../middleware/permissions';
import type { Variables } from '../types';
import { PermissionAction } from '../types';
import { ActivityService } from './activity.helper';
import { SSEService } from './sse.helper';

// ================================
// Tipos
// ================================
interface CardLink {
  id: number;
  card_id: string;
  path: string;
  name: string | null;
  user_id: number | null;
  created_at: Date;
}

interface CreateCardLinkPayload {
  path: string;
  name?: string;
}

interface UpdateCardLinkPayload {
  name: string;
}

// ================================
// Lógica de Servicio (CardLinkService)
// ================================
class CardLinkService {
  /**
   * Obtiene todos los vínculos de una tarjeta
   */
  static async getCardLinks(cardId: string): Promise<CardLink[]> {
    const query = `
      SELECT cl.*, u.name as user_name
      FROM card_links cl
      LEFT JOIN usuarios u ON cl.user_id = u.id
      WHERE cl.card_id = $1
      ORDER BY cl.created_at DESC
    `;

    const result = await pool.query(query, [cardId]);
    return result.rows;
  }

  /**
   * Crea un nuevo vínculo para una tarjeta
   */
  static async createCardLink(cardId: string, data: CreateCardLinkPayload, userId: number): Promise<CardLink> {
    const { path, name } = data;

    // Validar que la ruta no esté vacía
    if (!path || path.trim() === '') {
      throw new Error('La ruta del vínculo no puede estar vacía');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que la tarjeta existe
      const cardCheck = await client.query('SELECT id FROM cards WHERE id = $1', [cardId]);
      if (cardCheck.rowCount === 0) {
        throw new Error('La tarjeta especificada no existe');
      }

      // Insertar el vínculo
      const query = `
        INSERT INTO card_links (card_id, path, name, user_id)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;

      const result = await client.query(query, [
        cardId,
        path,
        name || null,
        userId
      ]);

      const newLink = result.rows[0];

      // Registrar actividad
      const linkName = name || path;
      await ActivityService.createActionWithClient(
        client,
        cardId,
        userId,
        `añadió el vínculo "${linkName}"`
      );

      await client.query('COMMIT');

      // Obtener board_id para emitir evento SSE
      const boardIdQuery = await client.query(`
        SELECT l.board_id
        FROM cards c
        JOIN lists l ON c.list_id = l.id
        WHERE c.id = $1
      `, [cardId]);

      const boardId = boardIdQuery.rows[0]?.board_id;

      if (boardId) {
        SSEService.emitBoardEvent({
          boardId,
          eventType: 'card:updated',
          data: { cardId }
        });
      }

      return newLink;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Actualiza el nombre de un vínculo
   */
  static async updateCardLink(
    cardId: string,
    linkId: number,
    data: UpdateCardLinkPayload,
    userId: number
  ): Promise<CardLink> {
    const { name } = data;

    // Validar que el nombre no esté vacío
    if (!name || name.trim() === '') {
      throw new Error('El nombre del vínculo no puede estar vacío');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que el vínculo existe y pertenece a la tarjeta
      const linkCheck = await client.query(
        'SELECT * FROM card_links WHERE id = $1 AND card_id = $2',
        [linkId, cardId]
      );

      if (linkCheck.rowCount === 0) {
        throw new Error('El vínculo especificado no existe');
      }

      const oldLink = linkCheck.rows[0];

      // Actualizar el vínculo
      const query = `
        UPDATE card_links
        SET name = $1
        WHERE id = $2 AND card_id = $3
        RETURNING *
      `;

      const result = await client.query(query, [name, linkId, cardId]);
      const updatedLink = result.rows[0];

      // Registrar actividad
      const oldName = oldLink.name || oldLink.path;
      await ActivityService.createActionWithClient(
        client,
        cardId,
        userId,
        `renombró el vínculo de "${oldName}" a "${name}"`
      );

      await client.query('COMMIT');

      // Obtener board_id para emitir evento SSE
      const boardIdQuery = await client.query(`
        SELECT l.board_id
        FROM cards c
        JOIN lists l ON c.list_id = l.id
        WHERE c.id = $1
      `, [cardId]);

      const boardId = boardIdQuery.rows[0]?.board_id;

      if (boardId) {
        SSEService.emitBoardEvent({
          boardId,
          eventType: 'card:updated',
          data: { cardId }
        });
      }

      return updatedLink;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Elimina un vínculo de una tarjeta
   */
  static async deleteCardLink(cardId: string, linkId: number, userId: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que el vínculo existe y pertenece a la tarjeta
      const linkCheck = await client.query(
        'SELECT * FROM card_links WHERE id = $1 AND card_id = $2',
        [linkId, cardId]
      );

      if (linkCheck.rowCount === 0) {
        throw new Error('El vínculo especificado no existe');
      }

      const link = linkCheck.rows[0];

      // Eliminar el vínculo
      await client.query(
        'DELETE FROM card_links WHERE id = $1 AND card_id = $2',
        [linkId, cardId]
      );

      // Registrar actividad
      const linkName = link.name || link.path;
      await ActivityService.createActionWithClient(
        client,
        cardId,
        userId,
        `eliminó el vínculo "${linkName}"`
      );

      await client.query('COMMIT');

      // Obtener board_id para emitir evento SSE
      const boardIdQuery = await client.query(`
        SELECT l.board_id
        FROM cards c
        JOIN lists l ON c.list_id = l.id
        WHERE c.id = $1
      `, [cardId]);

      const boardId = boardIdQuery.rows[0]?.board_id;

      if (boardId) {
        SSEService.emitBoardEvent({
          boardId,
          eventType: 'card:updated',
          data: { cardId }
        });
      }

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Controlador (CardLinkController)
// ================================
class CardLinkController {
  /**
   * Obtiene todos los vínculos de una tarjeta
   */
  static async getLinks(c: Context) {
    try {
      const cardId = c.req.param('cardId');

      if (!cardId) {
        return c.json({ error: 'ID de tarjeta requerido' }, 400);
      }

      const links = await CardLinkService.getCardLinks(cardId);
      return c.json(links, 200);

    } catch (error: any) {
      console.error('Error en CardLinkController.getLinks:', error);
      return c.json({ error: 'No se pudieron obtener los vínculos', details: error.message }, 500);
    }
  }

  /**
   * Crea un nuevo vínculo para una tarjeta
   */
  static async createLink(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const cardId = c.req.param('cardId');

      if (!cardId) {
        return c.json({ error: 'ID de tarjeta requerido' }, 400);
      }

      const data: CreateCardLinkPayload = await c.req.json();

      const newLink = await CardLinkService.createCardLink(cardId, data, user.userId);
      return c.json(newLink, 201);

    } catch (error: any) {
      console.error('Error en CardLinkController.createLink:', error);

      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      if (error.message.includes('no puede estar vacía') || error.message.includes('no puede estar vacío')) {
        return c.json({ error: error.message }, 400);
      }

      return c.json({ error: 'No se pudo crear el vínculo', details: error.message }, 500);
    }
  }

  /**
   * Actualiza el nombre de un vínculo
   */
  static async updateLink(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const cardId = c.req.param('cardId');
      const linkId = parseInt(c.req.param('linkId'));

      if (!cardId || isNaN(linkId)) {
        return c.json({ error: 'ID de tarjeta y vínculo requeridos' }, 400);
      }

      const data: UpdateCardLinkPayload = await c.req.json();

      const updatedLink = await CardLinkService.updateCardLink(cardId, linkId, data, user.userId);
      return c.json(updatedLink, 200);

    } catch (error: any) {
      console.error('Error en CardLinkController.updateLink:', error);

      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      if (error.message.includes('no puede estar vacía') || error.message.includes('no puede estar vacío')) {
        return c.json({ error: error.message }, 400);
      }

      return c.json({ error: 'No se pudo actualizar el vínculo', details: error.message }, 500);
    }
  }

  /**
   * Elimina un vínculo de una tarjeta
   */
  static async deleteLink(c: Context) {
    try {
      const user = c.get('user');
      if (!user) return c.json({ error: 'No autorizado' }, 401);

      const cardId = c.req.param('cardId');
      const linkId = parseInt(c.req.param('linkId'));

      if (!cardId || isNaN(linkId)) {
        return c.json({ error: 'ID de tarjeta y vínculo requeridos' }, 400);
      }

      await CardLinkService.deleteCardLink(cardId, linkId, user.userId);
      return c.body(null, 204);

    } catch (error: any) {
      console.error('Error en CardLinkController.deleteLink:', error);

      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }

      return c.json({ error: 'No se pudo eliminar el vínculo', details: error.message }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Vínculos
// ================================
export const cardLinkRoutes = new Hono<{ Variables: Variables }>();

cardLinkRoutes.use('*', keycloakAuthMiddleware);

// Rutas de vínculos de tarjetas
cardLinkRoutes.get('/cards/:cardId/links', requirePermission(PermissionAction.VIEW_CARDS), CardLinkController.getLinks);
cardLinkRoutes.post('/cards/:cardId/links', requirePermission(PermissionAction.EDIT_CARDS), CardLinkController.createLink);
cardLinkRoutes.put('/cards/:cardId/links/:linkId', requirePermission(PermissionAction.EDIT_CARDS), CardLinkController.updateLink);
cardLinkRoutes.delete('/cards/:cardId/links/:linkId', requirePermission(PermissionAction.EDIT_CARDS), CardLinkController.deleteLink);
