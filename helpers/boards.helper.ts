// En: src/helpers/boards.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';
import type { Board, List, Card, CreateBoardPayload } from '../types/kanban.types';
import { requireBoardAccess, requireOwnership } from '../middleware/permissions';
import fs from 'fs/promises';
import path from 'path';

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
    if (!boardResult.rowCount || boardResult.rowCount === 0) {
      return null;
    }
    const boardData = boardResult.rows[0];

    // 2. Obtener todas las listas Y tarjetas de ese tablero con un solo JOIN (incluye proyectos)
    const listsAndCardsQuery = `
      SELECT
        l.id as list_id, l.title as list_title, l.position as list_position,
        c.id as card_id, c.title as card_title, c.description, c.position as card_position,
        c.image_url, c.start_date, c.due_date, c.proyecto_id,
        p.nombre_proyecto, p.descripcion as proyecto_descripcion, p.estado as proyecto_estado,
        p.codigo as proyecto_codigo, p.cod_integracion as proyecto_cod_integracion,
        p.cadena as proyecto_cadena, p.direccion as proyecto_direccion
      FROM lists l
      LEFT JOIN cards c ON c.list_id = l.id
      LEFT JOIN proyectos p ON c.proyecto_id = p.id
      WHERE l.board_id = $1
      ORDER BY l.position, c.position;
    `;
    const listsAndCardsResult = await pool.query(listsAndCardsQuery, [id]);

    // 3. Obtener todos los usuarios asignados a las tarjetas de este tablero
    const assigneesQuery = `
      SELECT 
        ca.id,
        ca.card_id,
        ca.user_id,
        ca.assigned_by,
        ca.assigned_at,
        u.email as user_email,
        u.email as user_name
      FROM card_assignments ca
      INNER JOIN usuarios u ON ca.user_id = u.id
      INNER JOIN cards c ON ca.card_id = c.id
      INNER JOIN lists l ON c.list_id = l.id
      WHERE l.board_id = $1
    `;
    const assigneesResult = await pool.query(assigneesQuery, [id]);

    // 4. Obtener todas las etiquetas de las tarjetas de este tablero
    const labelsQuery = `
      SELECT 
        cl.card_id,
        l.id as label_id, l.name as label_name, l.color as label_color,
        l.created_at as label_created_at, l.updated_at as label_updated_at
      FROM card_labels cl
      INNER JOIN labels l ON cl.label_id = l.id
      INNER JOIN cards c ON cl.card_id = c.id
      INNER JOIN lists lst ON c.list_id = lst.id
      WHERE lst.board_id = $1
      ORDER BY l.name;
    `;
    const labelsResult = await pool.query(labelsQuery, [id]);

    // 4. Crear un mapa de usuarios asignados por tarjeta
    const cardAssigneesMap = new Map<string, any[]>();
    for (const assigneeRow of assigneesResult.rows) {
      if (!cardAssigneesMap.has(assigneeRow.card_id)) {
        cardAssigneesMap.set(assigneeRow.card_id, []);
      }
      cardAssigneesMap.get(assigneeRow.card_id)!.push({
        id: assigneeRow.id,
        user_id: assigneeRow.user_id,
        card_id: assigneeRow.card_id,
        user_email: assigneeRow.user_email,
        user_name: assigneeRow.user_name,
        assigned_by: assigneeRow.assigned_by,
        assigned_at: assigneeRow.assigned_at
      });
    }

    // 5. Crear un mapa de etiquetas por tarjeta
    const cardLabelsMap = new Map<string, any[]>();
    for (const labelRow of labelsResult.rows) {
      if (!cardLabelsMap.has(labelRow.card_id)) {
        cardLabelsMap.set(labelRow.card_id, []);
      }
      cardLabelsMap.get(labelRow.card_id)!.push({
        id: labelRow.label_id,
        board_id: id,
        name: labelRow.label_name,
        color: labelRow.label_color,
        created_at: labelRow.label_created_at,
        updated_at: labelRow.label_updated_at
      });
    }

    // 5. Procesar los resultados para anidar los datos correctamente
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
        const cardData: any = {
          id: row.card_id,
          title: row.card_title,
          description: row.description,
          position: row.card_position,
          image_url: row.image_url,
          list_id: row.list_id,
          proyecto_id: row.proyecto_id || null,
          start_date: row.start_date || null,
          due_date: row.due_date || null,
          created_at: new Date(),
          updated_at: new Date(),
          labels: cardLabelsMap.get(row.card_id) || [],
          assignees: cardAssigneesMap.get(row.card_id) || []
        };

        // Agregar información del proyecto si existe
        if (row.proyecto_id && row.nombre_proyecto) {
          cardData.proyecto = {
            id: row.proyecto_id,
            nombre_proyecto: row.nombre_proyecto,
            descripcion: row.proyecto_descripcion,
            estado: row.proyecto_estado,
            codigo: row.proyecto_codigo,
            cod_integracion: row.proyecto_cod_integracion,
            cadena: row.proyecto_cadena,
            direccion: row.proyecto_direccion
          };
        }

        list.cards.push(cardData);
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
    if (!boardCheck.rowCount || boardCheck.rowCount === 0) {
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
  static async createBoard(data: CreateBoardPayload, ownerId: number): Promise<Board> {
      const { name, description = null } = data;
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 1. Crear el tablero
        const boardQuery = `
          INSERT INTO boards (name, description, owner_id) 
          VALUES ($1, $2, $3) RETURNING *`;
        const boardResult = await client.query(boardQuery, [name, description, ownerId]);
        const newBoard = boardResult.rows[0];

        // 2. Añadir al owner como miembro con permisos completos (si no existe ya)
        const memberQuery = `
          INSERT INTO board_members (
            board_id, user_id, invited_by,
            can_view, can_create_cards, can_edit_cards, can_move_cards,
            can_delete_cards, can_manage_labels, can_add_members,
            can_remove_members, can_edit_board, can_delete_board
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (board_id, user_id) DO UPDATE SET
            can_view = EXCLUDED.can_view,
            can_create_cards = EXCLUDED.can_create_cards,
            can_edit_cards = EXCLUDED.can_edit_cards,
            can_move_cards = EXCLUDED.can_move_cards,
            can_delete_cards = EXCLUDED.can_delete_cards,
            can_manage_labels = EXCLUDED.can_manage_labels,
            can_add_members = EXCLUDED.can_add_members,
            can_remove_members = EXCLUDED.can_remove_members,
            can_edit_board = EXCLUDED.can_edit_board,
            can_delete_board = EXCLUDED.can_delete_board,
            updated_at = NOW()`;
        
        await client.query(memberQuery, [
          newBoard.id, ownerId, ownerId, // invited_by es el mismo owner
          true, true, true, true, // can_view, can_create_cards, can_edit_cards, can_move_cards
          true, true, true, true, // can_delete_cards, can_manage_labels, can_add_members, can_remove_members
          true, true // can_edit_board, can_delete_board
        ]);

        await client.query('COMMIT');
        console.log(`✅ Tablero creado y owner añadido como miembro: ${newBoard.name} (ID: ${newBoard.id})`);
        return newBoard;

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error creando tablero:', error);
        throw error;
      } finally {
        client.release();
      }
  }

  /**
   * Elimina un tablero y todos sus datos relacionados (listas, tarjetas, archivos)
   */
  static async deleteBoard(id: number): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Verificar que el tablero existe
      const boardCheck = await client.query('SELECT id FROM boards WHERE id = $1', [id]);
      if (!boardCheck.rowCount || boardCheck.rowCount === 0) {
        await client.query('ROLLBACK');
        return false; // El tablero no existe
      }

      // 2. Obtener todos los archivos asociados a las tarjetas de este tablero para borrarlos del disco
      const filesQuery = `
        SELECT DISTINCT a.id, a.ruta_relativa
        FROM archivos a
        INNER JOIN card_attachments ca ON a.id = ca.archivo_id
        INNER JOIN cards c ON ca.card_id = c.id
        INNER JOIN lists l ON c.list_id = l.id
        WHERE l.board_id = $1
      `;
      const filesResult = await client.query(filesQuery, [id]);
      const filesToDelete = filesResult.rows;

      // 3. Eliminar el tablero (las claves foráneas con ON DELETE CASCADE se encargarán del resto)
      // Orden de eliminación por las foreign keys:
      // boards -> lists -> cards -> card_attachments -> archivos
      await client.query('DELETE FROM boards WHERE id = $1', [id]);

      await client.query('COMMIT');

      // 4. Borrar archivos físicos del disco (después del commit para evitar inconsistencias)
      for (const file of filesToDelete) {
        try {
          const rutaCompleta = path.join(process.env.UPLOAD_DIR || 'uploads', file.ruta_relativa);
          await fs.unlink(rutaCompleta);
          console.log(`Archivo físico eliminado: ${rutaCompleta}`);
        } catch (unlinkError: any) {
          if (unlinkError.code === 'ENOENT') {
            console.warn(`Archivo físico no encontrado (ya fue eliminado): ${file.ruta_relativa}`);
          } else {
            console.error(`Error al eliminar archivo físico ${file.ruta_relativa}:`, unlinkError);
            // No lanzamos el error aquí porque la transacción ya se hizo commit
          }
        }
      }

      console.log(`Tablero ${id} eliminado exitosamente con ${filesToDelete.length} archivos`);
      return true;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en BoardService.deleteBoard:', error);
      throw error;
    } finally {
      client.release();
    }
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
      const user = c.get('user');
      const data: CreateBoardPayload = await c.req.json();
      if (!data.name || typeof data.name !== 'string') {
        return c.json({ error: 'El nombre del tablero es requerido' }, 400);
      }
      const newBoard = await BoardService.createBoard(data, user.userId);
      return c.json(newBoard, 201);
    } catch (error: any) {
        console.error('Error en BoardController.create:', error);
        return c.json({ error: 'No se pudo crear el tablero' }, 500);
    }
  }

  /**
   * Elimina un tablero específico por su ID
   */
  static async delete(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de tablero inválido' }, 400);
      }

      const wasDeleted = await BoardService.deleteBoard(id);

      if (!wasDeleted) {
        return c.json({ error: `Tablero con ID ${id} no encontrado` }, 404);
      }

      // Devolver 204 No Content para indicar eliminación exitosa sin contenido
      return c.body(null, 204);

    } catch (error: any) {
      console.error(`Error en BoardController.delete para el id ${c.req.param('id')}:`, error);
      return c.json({ error: 'No se pudo eliminar el tablero' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Tableros
// ================================
export const boardRoutes = new Hono<{ Variables: Variables }>();

// Todas las rutas de tableros requerirán autenticación
boardRoutes.use('*', keycloakAuthMiddleware);
// Nota: /boards (getAll) ahora se maneja desde permissionRoutes.getUserBoards()
boardRoutes.get('/boards/:id', requireBoardAccess(), BoardController.getOne);
boardRoutes.post('/boards', BoardController.create);
boardRoutes.delete('/boards/:id', requireOwnership(), BoardController.delete);
boardRoutes.get('/boards/:id/lists', requireBoardAccess(), BoardController.getListsOfBoard);

export { BoardController };