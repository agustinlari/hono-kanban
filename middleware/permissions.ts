// src/middleware/permissions.ts

import type { Context, Next } from 'hono';
import { pool } from '../config/database';
import type { BoardPermissions, Variables } from '../types';
import { PermissionAction } from '../types';

// ================================
// Servicio de Permisos
// ================================
export class PermissionService {
  /**
   * Obtiene los permisos de un usuario en un tablero específico
   */
  static async getUserBoardPermissions(userId: number, boardId: number): Promise<BoardPermissions | null> {
    const query = `
      SELECT 
        can_view, can_create_cards, can_edit_cards, can_move_cards,
        can_delete_cards, can_manage_labels, can_add_members, 
        can_remove_members, can_edit_board
      FROM board_members 
      WHERE user_id = $1 AND board_id = $2
    `;
    
    const result = await pool.query(query, [userId, boardId]);
    return result.rows[0] || null;
  }

  /**
   * Verifica si un usuario es owner de un tablero
   */
  static async isOwner(userId: number, boardId: number): Promise<boolean> {
    const query = 'SELECT owner_id FROM boards WHERE id = $1';
    const result = await pool.query(query, [boardId]);
    
    if (result.rows.length === 0) return false;
    return result.rows[0].owner_id === userId;
  }

  /**
   * Verifica si un usuario tiene un permiso específico en un tablero
   */
  static async hasPermission(
    userId: number, 
    boardId: number, 
    action: PermissionAction
  ): Promise<boolean> {
    // El owner siempre tiene todos los permisos
    if (await this.isOwner(userId, boardId)) {
      return true;
    }

    const permissions = await this.getUserBoardPermissions(userId, boardId);
    if (!permissions) return false;

    return permissions[action] === true;
  }

  /**
   * Obtiene el board_id desde diferentes fuentes (parámetros, body, etc.)
   */
  static getBoardIdFromContext(c: Context): number | null {
    // Intentar obtener de parámetros de la URL
    const boardIdParam = c.req.param('boardId') || c.req.param('id');
    if (boardIdParam) {
      const boardId = parseInt(boardIdParam);
      if (!isNaN(boardId)) return boardId;
    }

    // Intentar obtener del cuerpo de la petición
    try {
      const body = c.req.json();
      if (body && typeof body === 'object' && 'board_id' in body) {
        const boardId = parseInt(body.board_id as string);
        if (!isNaN(boardId)) return boardId;
      }
    } catch {
      // Ignorar errores de parsing JSON
    }

    return null;
  }

  /**
   * Obtiene el board_id desde el card_id
   */
  static async getBoardIdFromCard(cardId: string): Promise<number | null> {
    console.log(`🔍 Buscando board_id para card: ${cardId}`);
    const query = `
      SELECT l.board_id 
      FROM cards c 
      INNER JOIN lists l ON c.list_id = l.id 
      WHERE c.id = $1
    `;
    const result = await pool.query(query, [cardId]);
    const boardId = result.rows[0]?.board_id || null;
    console.log(`🔍 Board_id encontrado: ${boardId}`);
    return boardId;
  }

  /**
   * Obtiene el board_id desde el list_id
   */
  static async getBoardIdFromList(listId: number): Promise<number | null> {
    console.log(`🔍 Buscando board_id para list: ${listId}`);
    const query = 'SELECT board_id FROM lists WHERE id = $1';
    const result = await pool.query(query, [listId]);
    const boardId = result.rows[0]?.board_id || null;
    console.log(`🔍 Board_id encontrado desde list: ${boardId}`);
    return boardId;
  }

  /**
   * Obtiene el board_id desde el label_id
   */
  static async getBoardIdFromLabel(labelId: number): Promise<number | null> {
    const query = 'SELECT board_id FROM labels WHERE id = $1';
    const result = await pool.query(query, [labelId]);
    return result.rows[0]?.board_id || null;
  }
}

// ================================
// Middleware de Permisos
// ================================

/**
 * Middleware que verifica si el usuario tiene un permiso específico
 */
export function requirePermission(action: PermissionAction) {
  return async (c: Context<{ Variables: Variables }>, next: Next) => {
    const user = c.get('user');
    if (!user) {
      console.log('❌ No hay usuario en el contexto');
      return c.json({ error: 'No autorizado' }, 401);
    }

    console.log(`🔐 Verificando permiso: ${action} para usuario: ${user.userId}`);

    let boardId: number | null = null;

    // Obtener board_id según el contexto
    boardId = PermissionService.getBoardIdFromContext(c);
    console.log(`🔍 Board_id desde contexto: ${boardId}`);
    
    // Si no se encuentra en contexto directo, buscar por entidades relacionadas
    if (!boardId) {
      console.log('🔍 No se encontró board_id en contexto, buscando por entidades relacionadas...');
      
      // Para endpoints que usan el body, necesitamos obtener el board_id desde diferentes campos
      try {
        const body = await c.req.json();
        console.log(`🔍 Body recibido:`, body);
        
        // Para /cards/move - usar cardId
        if (body.cardId) {
          console.log(`🔍 cardId desde body: ${body.cardId}`);
          boardId = await PermissionService.getBoardIdFromCard(body.cardId);
        }
        
        // Para /cards (crear tarjeta) - usar list_id
        if (!boardId && body.list_id) {
          console.log(`🔍 list_id desde body: ${body.list_id}`);
          boardId = await PermissionService.getBoardIdFromList(body.list_id);
        }
        
        // Para /labels (crear etiqueta) - usar board_id directamente
        if (!boardId && body.board_id) {
          console.log(`🔍 board_id desde body: ${body.board_id}`);
          boardId = body.board_id;
        }
        
      } catch (error) {
        console.log('❌ Error al parsear JSON del body:', error);
      }
      
      // Fallback: obtener desde parámetros de URL
      if (!boardId) {
        const cardId = c.req.param('cardId') || c.req.param('id');
        console.log(`🔍 cardId desde parámetros: ${cardId}`);
        if (cardId) {
          boardId = await PermissionService.getBoardIdFromCard(cardId);
        }
      }
    }

    if (!boardId) {
      const listId = parseInt(c.req.param('listId') || '');
      if (!isNaN(listId)) {
        boardId = await PermissionService.getBoardIdFromList(listId);
      }
    }

    if (!boardId) {
      const labelId = parseInt(c.req.param('labelId') || '');
      if (!isNaN(labelId)) {
        boardId = await PermissionService.getBoardIdFromLabel(labelId);
      }
    }

    if (!boardId) {
      console.log('❌ No se pudo determinar el board_id');
      return c.json({ error: 'No se pudo determinar el tablero' }, 400);
    }

    console.log(`✅ Board_id determinado: ${boardId}`);

    try {
      const hasPermission = await PermissionService.hasPermission(user.userId, boardId, action);
      console.log(`🔐 Usuario ${user.userId} tiene permiso ${action}: ${hasPermission}`);
      
      if (!hasPermission) {
        return c.json({ 
          error: 'No tienes permisos para realizar esta acción',
          required_permission: action,
          board_id: boardId
        }, 403);
      }

      // Añadir información al contexto para uso posterior
      c.set('boardId', boardId);
      const permissions = await PermissionService.getUserBoardPermissions(user.userId, boardId);
      if (permissions) {
        c.set('userPermissions', permissions);
      }
      
      await next();
    } catch (error) {
      console.error('Error verificando permisos:', error);
      return c.json({ error: 'Error interno verificando permisos' }, 500);
    }
  };
}

/**
 * Middleware que verifica si el usuario es owner del tablero
 */
export function requireOwnership() {
  return async (c: Context<{ Variables: Variables }>, next: Next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'No autorizado' }, 401);
    }

    const boardId = PermissionService.getBoardIdFromContext(c);
    if (!boardId) {
      return c.json({ error: 'No se pudo determinar el tablero' }, 400);
    }

    try {
      const isOwner = await PermissionService.isOwner(user.userId, boardId);
      
      if (!isOwner) {
        return c.json({ 
          error: 'Solo el propietario del tablero puede realizar esta acción',
          board_id: boardId
        }, 403);
      }

      c.set('boardId', boardId);
      await next();
    } catch (error) {
      console.error('Error verificando ownership:', error);
      return c.json({ error: 'Error interno verificando ownership' }, 500);
    }
  };
}

/**
 * Middleware que verifica acceso básico al tablero (al menos can_view)
 */
export function requireBoardAccess() {
  return requirePermission(PermissionAction.VIEW_BOARD);
}

// ================================
// Helpers para uso en controladores
// ================================

/**
 * Obtiene los permisos del usuario actual en el contexto
 */
export function getUserPermissions(c: Context<{ Variables: Variables }>): BoardPermissions | null {
  return c.get('userPermissions') || null;
}

/**
 * Obtiene el board_id del contexto actual
 */
export function getBoardId(c: Context<{ Variables: Variables }>): number | null {
  return c.get('boardId') || null;
}