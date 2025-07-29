// En: src/helpers/boards.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { authMiddleware } from '../middleware/auth';
import type { Variables } from '../types';
import type { Board, List, Card, CreateBoardPayload } from '../types/kanban.types'; // <-- Nuestros nuevos tipos

// ================================
// Lógica de Servicio (BoardService)
// ================================
class BoardService {
  /**
   * Obtiene todos los tableros (sin listas ni tarjetas, para una vista general)
   */
  static async getAllBoards(): Promise<Omit<Board, 'lists'>[]> {
    const result = await pool.query('SELECT id, name, description, created_at, updated_at FROM boards ORDER BY created_at ASC');
    return result.rows;
  }

  /**
   * Obtiene UN tablero específico con todas sus listas y tarjetas anidadas.
   * Esta es la consulta clave para tu aplicación.
   */
  static async getBoardById(id: number): Promise<Board | null> {
    // 1. Obtener la información del tablero
    const boardResult = await pool.query('SELECT * FROM boards WHERE id = $1', [id]);
    if (boardResult.rowCount === 0) {
      return null;
    }
    const boardData = boardResult.rows[0];

    // 2. Obtener todas las listas Y tarjetas de ese tablero con un solo JOIN
    const listsAndCardsQuery = `
      SELECT 
        l.id as list_id, l.title as list_title, l.position as list_position,
        c.id as card_id, c.title as card_title, c.description, c.position as card_position, c.image_url
      FROM lists l
      LEFT JOIN cards c ON c.list_id = l.id
      WHERE l.board_id = $1
      ORDER BY l.position, c.position;
    `;
    const listsAndCardsResult = await pool.query(listsAndCardsQuery, [id]);

    // 3. Procesar los resultados para anidar los datos correctamente
    const listsMap = new Map<number, List>();
    for (const row of listsAndCardsResult.rows) {
      // Si la lista no está en nuestro mapa, la añadimos
      if (!listsMap.has(row.list_id)) {
        listsMap.set(row.list_id, {
          id: row.list_id,
          title: row.list_title,
          position: row.list_position,
          board_id: id,
          cards: [],
          // Asigna valores por defecto o busca la forma de traerlos si los necesitas
          created_at: new Date(), 
          updated_at: new Date()
        });
      }

      // Si la fila tiene datos de una tarjeta, la añadimos a su lista
      if (row.card_id) {
        const list = listsMap.get(row.list_id)!;
        list.cards.push({
          id: row.card_id,
          title: row.card_title,
          description: row.description,
          position: row.card_position,
          image_url: row.image_url,
          list_id: row.list_id,
          created_at: new Date(),
          updated_at: new Date()
        });
      }
    }

    // Convertir el mapa a un array ordenado y asignarlo al tablero
    const finalBoard: Board = {
      ...boardData,
      lists: Array.from(listsMap.values())
    };

    return finalBoard;
  }

    static async getListsByBoardId(boardId: number): Promise<Omit<List, 'cards'>[] | null> {
    // Primero, comprobamos si el tablero existe para dar un buen error 404
    const boardCheck = await pool.query('SELECT id FROM boards WHERE id = $1', [boardId]);
    if (boardCheck.rowCount === 0) {
      return null; // Devuelve null para que el controlador sepa que es un 404
    }

    // Si el tablero existe, obtenemos sus listas ordenadas por posición
    const query = `
      SELECT id, title, position, board_id, created_at, updated_at 
      FROM lists 
      WHERE board_id = $1 
      ORDER BY position ASC;
    `;
    const result = await pool.query(query, [boardId]);
    
    return result.rows;
  }
  /**
   * Crea un nuevo tablero
   */
  static async createBoard(data: CreateBoardPayload): Promise<Board> {
      const { name, description = null } = data;
      // Las nuevas listas se insertan al final, así que su posición es el número actual de tableros.
      const positionResult = await pool.query('SELECT COUNT(*) as count FROM boards');
      const newPosition = parseInt(positionResult.rows[0].count);

      const query = `
        INSERT INTO boards (name, description) 
        VALUES ($1, $2) RETURNING *`;
      const result = await pool.query(query, [name, description]);
      return result.rows[0];
  }
}

// ================================
// Lógica de Controlador (BoardController)
// ================================
class BoardController {
  static async getAll(c: Context) {
    try {
      const boards = await BoardService.getAllBoards();
      return c.json(boards);
    } catch (error: any) {
      console.error('Error en BoardController.getAll:', error);
      return c.json({ error: 'Error al obtener los tableros' }, 500);
    }
  }

  static async getListsOfBoard(c: Context) {
    try {
      const boardId = parseInt(c.req.param('id'));
      if (isNaN(boardId)) {
        return c.json({ error: 'ID de tablero inválido' }, 400);
      }

      const lists = await BoardService.getListsByBoardId(boardId);

      // El servicio devuelve null si el tablero no existe
      if (lists === null) {
        return c.json({ error: `Tablero con ID ${boardId} no encontrado` }, 404);
      }
      
      return c.json(lists);

    } catch (error: any) {
      console.error(`Error en BoardController.getListsOfBoard para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'Error al obtener las listas del tablero' }, 500);
    }
  }

  static async getOne(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de tablero inválido' }, 400);
      }
      const board = await BoardService.getBoardById(id);
      if (!board) {
        return c.json({ error: 'Tablero no encontrado' }, 404);
      }
      return c.json(board);
    } catch (error: any) {
      console.error(`Error en BoardController.getOne para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'Error al obtener el tablero' }, 500);
    }
  }
    
  static async create(c: Context) {
    try {
      const data: CreateBoardPayload = await c.req.json();
      if (!data.name || typeof data.name !== 'string') {
        return c.json({ error: 'El nombre del tablero es requerido' }, 400);
      }
      const newBoard = await BoardService.createBoard(data);
      return c.json(newBoard, 201);
    } catch (error: any) {
        console.error('Error en BoardController.create:', error);
        return c.json({ error: 'No se pudo crear el tablero' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Tableros
// ================================
export const boardRoutes = new Hono<{ Variables: Variables }>();

// Todas las rutas de tableros requerirán autenticación
boardRoutes.use('*', authMiddleware);

boardRoutes.get('/boards', BoardController.getAll);
boardRoutes.get('/boards/:id', BoardController.getOne);
boardRoutes.post('/boards', BoardController.create);
boardRoutes.get('/boards/:id/lists', BoardController.getListsOfBoard);