// helpers/users.helper.ts - Endpoints para gestión de perfil de usuario
import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import type { Variables } from '../types';
import { validateKeycloakToken } from './keycloak.helper';

// ================================
// Servicio de Usuario
// ================================
class UserService {
  /**
   * Obtiene el perfil completo del usuario actual
   */
  static async getUserProfile(keycloakId: string) {
    const client = await pool.connect();

    try {
      const result = await client.query(`
        SELECT
          id,
          keycloak_id,
          email,
          name,
          rol,
          color_fondo,
          color_texto,
          created_at,
          updated_at
        FROM usuarios
        WHERE keycloak_id = $1
      `, [keycloakId]);

      if (result.rowCount === 0) {
        throw new Error('Usuario no encontrado');
      }

      const user = result.rows[0];

      return {
        id: user.id,
        keycloakId: user.keycloak_id,
        email: user.email,
        name: user.name,
        rol: user.rol,
        color_fondo: user.color_fondo,
        color_texto: user.color_texto,
        created_at: user.created_at,
        updated_at: user.updated_at
      };
    } finally {
      client.release();
    }
  }

  /**
   * Actualiza los colores del avatar del usuario
   */
  static async updateUserColors(keycloakId: string, colorFondo: string, colorTexto: string) {
    const client = await pool.connect();

    try {
      const result = await client.query(`
        UPDATE usuarios
        SET
          color_fondo = $1,
          color_texto = $2,
          updated_at = NOW()
        WHERE keycloak_id = $3
        RETURNING
          id,
          keycloak_id,
          email,
          name,
          rol,
          color_fondo,
          color_texto,
          updated_at
      `, [colorFondo, colorTexto, keycloakId]);

      if (result.rowCount === 0) {
        throw new Error('Usuario no encontrado');
      }

      const user = result.rows[0];

      return {
        id: user.id,
        keycloakId: user.keycloak_id,
        email: user.email,
        name: user.name,
        rol: user.rol,
        color_fondo: user.color_fondo,
        color_texto: user.color_texto,
        updated_at: user.updated_at
      };
    } finally {
      client.release();
    }
  }
}

// ================================
// Controlador de Usuario
// ================================
class UserController {
  /**
   * GET /users/me/profile - Obtener perfil del usuario actual
   */
  static async getProfile(c: Context) {
    try {
      const authHeader = c.req.header('Authorization');

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'Token requerido' }, 401);
      }

      const token = authHeader.substring(7);
      const keycloakUser = await validateKeycloakToken(token);

      if (!keycloakUser || !keycloakUser.sub) {
        return c.json({ error: 'Token inválido' }, 401);
      }

      const profile = await UserService.getUserProfile(keycloakUser.sub);

      return c.json({
        success: true,
        user: profile
      });

    } catch (error: any) {
      console.error('❌ Error en getProfile controller:', error);
      return c.json({
        error: error.message || 'Error obteniendo perfil'
      }, 500);
    }
  }

  /**
   * PUT /users/me/colors - Actualizar colores del avatar
   */
  static async updateColors(c: Context) {
    try {
      const authHeader = c.req.header('Authorization');

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'Token requerido' }, 401);
      }

      const token = authHeader.substring(7);
      const keycloakUser = await validateKeycloakToken(token);

      if (!keycloakUser || !keycloakUser.sub) {
        return c.json({ error: 'Token inválido' }, 401);
      }

      const { color_fondo, color_texto } = await c.req.json();

      if (!color_fondo || !color_texto) {
        return c.json({
          error: 'color_fondo y color_texto son requeridos'
        }, 400);
      }

      const updatedUser = await UserService.updateUserColors(
        keycloakUser.sub,
        color_fondo,
        color_texto
      );

      return c.json({
        success: true,
        message: 'Colores actualizados correctamente',
        user: updatedUser
      });

    } catch (error: any) {
      console.error('❌ Error en updateColors controller:', error);
      return c.json({
        error: error.message || 'Error actualizando colores'
      }, 500);
    }
  }
}

// ================================
// Rutas de Usuario
// ================================
export const userRoutes = new Hono<{ Variables: Variables }>();

// Rutas de perfil de usuario (requieren autenticación)
userRoutes.get('/users/me/profile', UserController.getProfile);
userRoutes.put('/users/me/colors', UserController.updateColors);

export { UserService, UserController };
