// src/helpers/permissions.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import { requireOwnership, requirePermission, requireBoardAccess } from '../middleware/permissions';
import type { Variables, BoardMember, PermissionRole, AddMemberPayload, UpdateMemberPermissionsPayload, RemoveMemberPayload } from '../types';
import { PermissionAction } from '../types';

// ================================
// Lógica de Servicio (PermissionService)
// ================================
class BoardPermissionService {
  /**
   * Obtiene todos los miembros de un tablero
   */
  static async getBoardMembers(boardId: number): Promise<BoardMember[]> {
    console.log(`🔍 [BoardPermissionService.getBoardMembers] Buscando miembros para tablero ID: ${boardId}`);
    
    const query = `
      SELECT 
        bm.*,
        u.email as user_email,
        (b.owner_id = bm.user_id) as is_owner
      FROM board_members bm
      INNER JOIN usuarios u ON bm.user_id = u.id
      INNER JOIN boards b ON bm.board_id = b.id
      WHERE bm.board_id = $1
      ORDER BY is_owner DESC, bm.joined_at ASC
    `;
    const result = await pool.query(query, [boardId]);
    console.log(`📊 [BoardPermissionService.getBoardMembers] Encontrados ${result.rows.length} miembros para tablero ${boardId}:`, result.rows.map((r: any) => ({ board_id: r.board_id, user_email: r.user_email })));
    return result.rows;
  }

  /**
   * Obtiene todos los roles de permisos disponibles
   */
  static async getPermissionRoles(): Promise<PermissionRole[]> {
    const query = 'SELECT * FROM permission_roles ORDER BY name';
    const result = await pool.query(query);
    return result.rows;
  }

  /**
   * Obtiene un rol de permisos por nombre
   */
  static async getPermissionRoleByName(roleName: string): Promise<PermissionRole | null> {
    const query = 'SELECT * FROM permission_roles WHERE name = $1';
    const result = await pool.query(query, [roleName]);
    return result.rows[0] || null;
  }

  /**
   * Añade un miembro al tablero
   */
  static async addMemberToBoard(data: AddMemberPayload, invitedBy: number): Promise<BoardMember> {
    const { board_id, user_email, role_name, permissions } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Verificar que el tablero existe
      const boardCheck = await client.query('SELECT id FROM boards WHERE id = $1', [board_id]);
      if ((boardCheck.rowCount ?? 0) === 0) {
        throw new Error('El tablero especificado no existe.');
      }

      // 2. Buscar el usuario por email
      const userResult = await client.query('SELECT id FROM usuarios WHERE email = $1', [user_email]);
      if ((userResult.rowCount ?? 0) === 0) {
        throw new Error('No se encontró un usuario con ese email.');
      }
      const userId = userResult.rows[0].id;

      // 3. Verificar que el usuario no sea ya miembro
      const memberCheck = await client.query(
        'SELECT id FROM board_members WHERE board_id = $1 AND user_id = $2',
        [board_id, userId]
      );
      if ((memberCheck.rowCount ?? 0) > 0) {
        throw new Error('El usuario ya es miembro de este tablero.');
      }

      // 4. Determinar permisos (por rol o custom)
      let finalPermissions = {
        can_view: true,
        can_create_cards: false,
        can_edit_cards: false,
        can_move_cards: false,
        can_delete_cards: false,
        can_manage_labels: false,
        can_add_members: false,
        can_remove_members: false,
        can_edit_board: false,
        can_delete_board: false
      };

      if (role_name) {
        const role = await this.getPermissionRoleByName(role_name);
        if (!role) {
          throw new Error(`Rol '${role_name}' no encontrado.`);
        }
        finalPermissions = {
          can_view: role.can_view,
          can_create_cards: role.can_create_cards,
          can_edit_cards: role.can_edit_cards,
          can_move_cards: role.can_move_cards,
          can_delete_cards: role.can_delete_cards,
          can_manage_labels: role.can_manage_labels,
          can_add_members: role.can_add_members,
          can_remove_members: role.can_remove_members,
          can_edit_board: role.can_edit_board,
          can_delete_board: role.can_delete_board
        };
      } else if (permissions) {
        finalPermissions = { ...finalPermissions, ...permissions };
      }

      // 5. Insertar el miembro
      const insertQuery = `
        INSERT INTO board_members (
          board_id, user_id, invited_by,
          can_view, can_create_cards, can_edit_cards, can_move_cards,
          can_delete_cards, can_manage_labels, can_add_members, 
          can_remove_members, can_edit_board, can_delete_board
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `;
      
      const insertResult = await client.query(insertQuery, [
        board_id, userId, invitedBy,
        finalPermissions.can_view, finalPermissions.can_create_cards,
        finalPermissions.can_edit_cards, finalPermissions.can_move_cards,
        finalPermissions.can_delete_cards, finalPermissions.can_manage_labels,
        finalPermissions.can_add_members, finalPermissions.can_remove_members,
        finalPermissions.can_edit_board, finalPermissions.can_delete_board
      ]);

      await client.query('COMMIT');
      
      // Añadir información del usuario al resultado
      const newMember = insertResult.rows[0];
      newMember.user_email = user_email;
      newMember.is_owner = false;
      
      return newMember;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en BoardPermissionService.addMemberToBoard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Actualiza los permisos de un miembro
   */
  static async updateMemberPermissions(data: UpdateMemberPermissionsPayload): Promise<BoardMember | null> {
    const { board_id, user_id, permissions } = data;

    console.log('🔧 Actualizando permisos de miembro:', { board_id, user_id, permissions });

    const fieldsToUpdate = Object.keys(permissions);
    console.log('🔧 Campos a actualizar:', fieldsToUpdate);
    
    if (fieldsToUpdate.length === 0) {
      console.log('🔧 No hay campos para actualizar, devolviendo miembro actual');
      const current = await pool.query(
        'SELECT * FROM board_members WHERE board_id = $1 AND user_id = $2',
        [board_id, user_id]
      );
      return current.rows[0] || null;
    }

    const setClause = fieldsToUpdate.map((key, index) => `"${key}" = $${index + 3}`).join(', ');
    const queryValues = [board_id, user_id, ...fieldsToUpdate.map(key => permissions[key as keyof typeof permissions])];

    const query = `
      UPDATE board_members 
      SET ${setClause}, updated_at = NOW()
      WHERE board_id = $1 AND user_id = $2
      RETURNING *
    `;
    
    console.log('🔧 Query SQL:', query);
    console.log('🔧 Query values:', queryValues);
    
    try {
      const result = await pool.query(query, queryValues);
      console.log('🔧 Resultado query:', result.rows[0]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('💥 Error en query SQL:', error);
      throw error;
    }
  }

  /**
   * Elimina un miembro del tablero
   */
  static async removeMemberFromBoard(boardId: number, userId: number): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que no se está intentando eliminar al owner
      const ownerCheck = await client.query(
        'SELECT owner_id FROM boards WHERE id = $1',
        [boardId]
      );
      
      if (ownerCheck.rows[0]?.owner_id === userId) {
        throw new Error('No se puede eliminar al propietario del tablero.');
      }

      const deleteResult = await client.query(
        'DELETE FROM board_members WHERE board_id = $1 AND user_id = $2',
        [boardId, userId]
      );

      await client.query('COMMIT');
      return (deleteResult.rowCount ?? 0) > 0;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en BoardPermissionService.removeMemberFromBoard:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene los tableros a los que tiene acceso un usuario
   */
  static async getUserBoards(userId: number): Promise<any[]> {
    const query = `
      SELECT 
        b.id, b.name, b.description, b.created_at, b.updated_at,
        (b.owner_id = $1) as is_owner,
        bm.can_view, bm.can_create_cards, bm.can_edit_cards, bm.can_move_cards,
        bm.can_delete_cards, bm.can_manage_labels, bm.can_add_members,
        bm.can_remove_members, bm.can_edit_board, bm.can_delete_board, bm.joined_at
      FROM board_members bm
      INNER JOIN boards b ON bm.board_id = b.id
      WHERE bm.user_id = $1 AND bm.can_view = TRUE
      ORDER BY is_owner DESC, b.name ASC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  }
}

// ================================
// Lógica de Controlador (PermissionController)
// ================================
class PermissionController {
  /**
   * Obtiene los miembros de un tablero
   */
  static async getBoardMembers(c: Context) {
    try {
      const boardIdParam = c.req.param('boardId');
      const boardId = parseInt(boardIdParam);
      console.log(`🚀 [PermissionController.getBoardMembers] REQUEST para boardId: ${boardIdParam} (parsed: ${boardId})`);
      
      if (isNaN(boardId)) {
        console.error(`❌ [PermissionController.getBoardMembers] ID de tablero inválido: ${boardIdParam}`);
        return c.json({ error: 'ID de tablero inválido' }, 400);
      }

      const members = await BoardPermissionService.getBoardMembers(boardId);
      console.log(`✅ [PermissionController.getBoardMembers] Devolviendo ${members.length} miembros para tablero ${boardId}`);
      return c.json(members);

    } catch (error: any) {
      console.error(`Error en PermissionController.getBoardMembers para boardId ${c.req.param('boardId')}:`, error);
      return c.json({ error: 'Error al obtener los miembros del tablero' }, 500);
    }
  }

  /**
   * Obtiene los roles de permisos disponibles
   */
  static async getPermissionRoles(c: Context) {
    try {
      const roles = await BoardPermissionService.getPermissionRoles();
      return c.json(roles);

    } catch (error: any) {
      console.error('Error en PermissionController.getPermissionRoles:', error);
      return c.json({ error: 'Error al obtener los roles de permisos' }, 500);
    }
  }

  /**
   * Añade un miembro al tablero
   */
  static async addMember(c: Context) {
    try {
      const user = c.get('user');
      const data: AddMemberPayload = await c.req.json();

      if (!data.board_id || typeof data.board_id !== 'number') {
        return c.json({ error: 'board_id es requerido y debe ser un número' }, 400);
      }
      if (!data.user_email || typeof data.user_email !== 'string') {
        return c.json({ error: 'user_email es requerido y debe ser un string' }, 400);
      }

      const newMember = await BoardPermissionService.addMemberToBoard(data, user.userId);
      return c.json({ mensaje: 'Miembro añadido exitosamente', member: newMember }, 201);

    } catch (error: any) {
      console.error('Error en PermissionController.addMember:', error);
      if (error.message.includes('no existe') || error.message.includes('no encontró')) {
        return c.json({ error: error.message }, 404);
      }
      if (error.message.includes('ya es miembro')) {
        return c.json({ error: error.message }, 409);
      }
      return c.json({ error: 'No se pudo añadir el miembro' }, 500);
    }
  }

  /**
   * Actualiza los permisos de un miembro
   */
  static async updateMemberPermissions(c: Context) {
    try {
      const data: UpdateMemberPermissionsPayload = await c.req.json();
      console.log('🎯 Datos recibidos en updateMemberPermissions:', JSON.stringify(data, null, 2));

      if (!data.board_id || !data.user_id || !data.permissions) {
        console.log('💥 Faltan campos requeridos:', { 
          board_id: !!data.board_id, 
          user_id: !!data.user_id, 
          permissions: !!data.permissions 
        });
        return c.json({ error: 'board_id, user_id y permissions son requeridos' }, 400);
      }

      const updatedMember = await BoardPermissionService.updateMemberPermissions(data);

      if (!updatedMember) {
        console.log('💥 Miembro no encontrado después de actualización');
        return c.json({ error: 'Miembro no encontrado' }, 404);
      }

      console.log('✅ Permisos actualizados exitosamente:', updatedMember);
      return c.json({ mensaje: 'Permisos actualizados exitosamente', member: updatedMember });

    } catch (error: any) {
      console.error('💥 Error en PermissionController.updateMemberPermissions:', error);
      console.error('💥 Stack trace:', error.stack);
      return c.json({ error: 'No se pudieron actualizar los permisos' }, 500);
    }
  }

  /**
   * Elimina un miembro del tablero
   */
  static async removeMember(c: Context) {
    try {
      const boardId = parseInt(c.req.param('boardId'));
      const userId = parseInt(c.req.param('userId'));

      if (isNaN(boardId) || isNaN(userId)) {
        return c.json({ error: 'ID de tablero y usuario requeridos' }, 400);
      }

      const wasRemoved = await BoardPermissionService.removeMemberFromBoard(boardId, userId);

      if (!wasRemoved) {
        return c.json({ error: 'Miembro no encontrado' }, 404);
      }

      return c.json({ mensaje: 'Miembro eliminado exitosamente' });

    } catch (error: any) {
      console.error('Error en PermissionController.removeMember:', error);
      if (error.message.includes('propietario')) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: 'No se pudo eliminar el miembro' }, 500);
    }
  }

  /**
   * Obtiene los tableros del usuario actual
   */
  static async getUserBoards(c: Context) {
    try {
      const user = c.get('user');
      const boards = await BoardPermissionService.getUserBoards(user.userId);
      return c.json(boards);

    } catch (error: any) {
      console.error('Error en PermissionController.getUserBoards:', error);
      return c.json({ error: 'Error al obtener los tableros del usuario' }, 500);
    }
  }

  /**
   * Obtiene todos los tableros (solo para admins)
   */
  static async getAllBoards(c: Context) {
    try {
      const user = c.get('user');
      
      // Verificar que el usuario sea admin
      const userQuery = 'SELECT rol FROM usuarios WHERE id = $1';
      const userResult = await pool.query(userQuery, [user.userId]);
      
      if (userResult.rows.length === 0) {
        return c.json({ error: 'Usuario no encontrado' }, 404);
      }
      
      if (userResult.rows[0].rol !== 'admin') {
        return c.json({ error: 'Acceso denegado: se requieren permisos de administrador' }, 403);
      }

      // Obtener todos los tableros con información del propietario
      const boardsQuery = `
        SELECT 
          b.id, b.name, b.description, b.created_at, b.updated_at,
          u.email as owner_email
        FROM boards b
        LEFT JOIN usuarios u ON b.owner_id = u.id
        ORDER BY b.created_at DESC
      `;
      
      const result = await pool.query(boardsQuery);
      return c.json(result.rows);

    } catch (error: any) {
      console.error('Error en PermissionController.getAllBoards:', error);
      return c.json({ error: 'Error al obtener todos los tableros' }, 500);
    }
  }

  /**
   * Obtiene información del usuario actual
   */
  static async getMe(c: Context) {
    try {
      const user = c.get('user');
      
      // Obtener información completa del usuario desde la base de datos
      const query = 'SELECT id, email, rol, created_at, updated_at FROM usuarios WHERE id = $1';
      const result = await pool.query(query, [user.userId]);
      
      if (result.rows.length === 0) {
        return c.json({ error: 'Usuario no encontrado' }, 404);
      }

      const userInfo = result.rows[0];
      
      return c.json({
        id: userInfo.id,
        email: userInfo.email,
        name: userInfo.email, // Usando email como name por ahora
        isAdmin: userInfo.rol === 'admin',
        created_at: userInfo.created_at || new Date().toISOString(),
        updated_at: userInfo.updated_at || userInfo.created_at || new Date().toISOString()
      });

    } catch (error: any) {
      console.error('Error en PermissionController.getMe:', error);
      return c.json({ error: 'Error al obtener información del usuario' }, 500);
    }
  }

  /**
   * Obtiene los permisos del usuario actual en un tablero específico
   */
  static async getMyPermissions(c: Context) {
    try {
      const user = c.get('user');
      const boardId = parseInt(c.req.param('boardId'));
      
      if (isNaN(boardId)) {
        return c.json({ error: 'ID de tablero inválido' }, 400);
      }

      // Verificar que el tablero existe y que el usuario tiene acceso
      const query = `
        SELECT 
          bm.can_view, bm.can_create_cards, bm.can_edit_cards, bm.can_move_cards,
          bm.can_delete_cards, bm.can_manage_labels, bm.can_add_members,
          bm.can_remove_members, bm.can_edit_board, bm.can_delete_board,
          (b.owner_id = bm.user_id) as is_owner,
          b.name as board_name
        FROM board_members bm
        INNER JOIN boards b ON bm.board_id = b.id
        WHERE bm.board_id = $1 AND bm.user_id = $2
      `;
      
      const result = await pool.query(query, [boardId, user.userId]);
      
      if (result.rows.length === 0) {
        return c.json({ error: 'No tienes acceso a este tablero' }, 403);
      }

      const permissions = result.rows[0];
      
      return c.json({
        board_id: boardId,
        board_name: permissions.board_name,
        is_owner: permissions.is_owner,
        permissions: {
          can_view: permissions.can_view,
          can_create_cards: permissions.can_create_cards,
          can_edit_cards: permissions.can_edit_cards,
          can_move_cards: permissions.can_move_cards,
          can_delete_cards: permissions.can_delete_cards,
          can_manage_labels: permissions.can_manage_labels,
          can_add_members: permissions.can_add_members,
          can_remove_members: permissions.can_remove_members,
          can_edit_board: permissions.can_edit_board,
          can_delete_board: permissions.can_delete_board || permissions.is_owner
        }
      });

    } catch (error: any) {
      console.error(`Error en PermissionController.getMyPermissions para boardId ${c.req.param('boardId')}:`, error);
      return c.json({ error: 'Error al obtener los permisos del usuario' }, 500);
    }
  }

  /**
   * Obtiene todos los usuarios disponibles para asignación
   */
  static async getAllUsers(c: Context) {
    try {
      console.log('📋 [PermissionController.getAllUsers] Obteniendo todos los usuarios');
      
      const query = `
        SELECT 
          id,
          email,
          COALESCE(email, 'Usuario') as name,
          rol,
          created_at
        FROM usuarios 
        ORDER BY email ASC
      `;
      
      const result = await pool.query(query);
      
      const users = result.rows.map(row => ({
        user_id: row.id,
        user_email: row.email,
        user_name: row.name,
        user_role: row.rol,
        created_at: row.created_at
      }));
      
      console.log(`✅ [PermissionController.getAllUsers] Encontrados ${users.length} usuarios`);
      
      return c.json(users);

    } catch (error: any) {
      console.error('Error en PermissionController.getAllUsers:', error);
      return c.json({ error: 'Error al obtener los usuarios' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Permisos
// ================================
export const permissionRoutes = new Hono<{ Variables: Variables }>();

permissionRoutes.use('*', keycloakAuthMiddleware);

// Rutas de miembros del tablero
permissionRoutes.get('/boards/:boardId/members', requireBoardAccess(), PermissionController.getBoardMembers);
permissionRoutes.post('/boards/members', requirePermission(PermissionAction.ADD_MEMBERS), PermissionController.addMember);
permissionRoutes.put('/boards/members/permissions', requirePermission(PermissionAction.EDIT_BOARD), PermissionController.updateMemberPermissions);
permissionRoutes.delete('/boards/:boardId/members/:userId', requirePermission(PermissionAction.REMOVE_MEMBERS), PermissionController.removeMember);

// Rutas de información
permissionRoutes.get('/permission-roles', PermissionController.getPermissionRoles);
permissionRoutes.get('/user/me', PermissionController.getMe);
permissionRoutes.get('/user/boards', PermissionController.getUserBoards);
permissionRoutes.get('/users', PermissionController.getAllUsers);
permissionRoutes.get('/boards/:boardId/my-permissions', PermissionController.getMyPermissions);

// Ruta para que admins obtengan todos los tableros
permissionRoutes.get('/boards', PermissionController.getAllBoards);