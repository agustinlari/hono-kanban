// helpers/keycloak-auth.helper.ts - Endpoints de autenticación con Keycloak
import { Hono } from 'hono';
import type { Context } from 'hono';
import { 
  KEYCLOAK_BASE_URL, 
  KEYCLOAK_REALM, 
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_TOKEN_URL,
  KEYCLOAK_USERINFO_URL
} from '../config/env';
import { validateKeycloakToken, getKeycloakUserInfo } from './keycloak.helper';
import { pool } from '../config/database';
import type { Variables } from '../types';

// ================================
// Servicio de Autenticación Keycloak
// ================================
class KeycloakAuthService {
  /**
   * Autentica un usuario con Keycloak usando username/password
   */
  static async login(username: string, password: string) {
    try {
      console.log('🔐 [KeycloakAuth] Iniciando login para:', username);
      console.log('🔗 [KeycloakAuth] URL:', KEYCLOAK_TOKEN_URL);
      console.log('🆔 [KeycloakAuth] Client ID:', KEYCLOAK_CLIENT_ID);
      
      // 1. Obtener token de Keycloak
      const response = await fetch(KEYCLOAK_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: KEYCLOAK_CLIENT_ID,
          username,
          password,
        }),
      });

      console.log('📡 [KeycloakAuth] Respuesta Keycloak status:', response.status);

      if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ [KeycloakAuth] Error de Keycloak:', errorData);
        throw new Error(errorData.error_description || 'Credenciales inválidas');
      }

      const tokenData = await response.json();

      // 2. Validar y decodificar el token
      const keycloakUser = await validateKeycloakToken(tokenData.access_token);

      // 3. Crear o actualizar usuario en nuestra base de datos
      const appUser = await this.getOrCreateUser(keycloakUser);

      return {
        success: true,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        user: appUser,
        keycloak_user: keycloakUser
      };

    } catch (error: any) {
      console.error('Error en login con Keycloak:', error);
      throw new Error(error.message || 'Error de autenticación');
    }
  }

  /**
   * Refresca un token de acceso
   */
  static async refreshToken(refreshToken: string) {
    try {
      const response = await fetch(KEYCLOAK_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: KEYCLOAK_CLIENT_ID,
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        throw new Error('Token de refresco inválido');
      }

      const tokenData = await response.json();
      
      // Validar el nuevo token
      const keycloakUser = await validateKeycloakToken(tokenData.access_token);
      const appUser = await this.getOrCreateUser(keycloakUser);

      return {
        success: true,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        user: appUser
      };

    } catch (error: any) {
      console.error('Error refrescando token:', error);
      throw new Error('No se pudo refrescar el token');
    }
  }

  /**
   * Obtiene información del usuario autenticado
   */
  static async getUserProfile(accessToken: string) {
    try {
      const keycloakUser = await validateKeycloakToken(accessToken);
      const appUser = await this.getOrCreateUser(keycloakUser);

      return {
        success: true,
        user: appUser,
        keycloak_user: keycloakUser
      };
    } catch (error: any) {
      throw new Error('Token inválido o expirado');
    }
  }

  /**
   * Obtiene o crea un usuario en nuestra base de datos
   */
  private static async getOrCreateUser(keycloakUser: any) {
    const client = await pool.connect();
    
    try {
      // Buscar usuario existente por Keycloak ID
      let userResult = await client.query(
        'SELECT * FROM usuarios WHERE keycloak_id = $1',
        [keycloakUser.sub]
      );

      if (userResult.rowCount && userResult.rowCount > 0) {
        // Usuario existe, actualizar información si es necesario
        const existingUser = userResult.rows[0];
        
        if (existingUser.email !== keycloakUser.email) {
          await client.query(
            'UPDATE usuarios SET email = $1, updated_at = NOW() WHERE keycloak_id = $2',
            [keycloakUser.email, keycloakUser.sub]
          );
          existingUser.email = keycloakUser.email;
        }

        return {
          id: existingUser.id,
          keycloakId: keycloakUser.sub,
          userId: existingUser.id, // Para compatibilidad
          email: keycloakUser.email,
          name: keycloakUser.name || keycloakUser.preferred_username || keycloakUser.email,
          rol: existingUser.rol,
          keycloakRoles: keycloakUser.realm_access?.roles || []
        };
      } else {
        // Usuario no existe, crearlo
        const insertResult = await client.query(`
          INSERT INTO usuarios (keycloak_id, email, rol) 
          VALUES ($1, $2, $3) 
          RETURNING *
        `, [
          keycloakUser.sub,
          keycloakUser.email,
          'user' // Rol por defecto
        ]);

        const newUser = insertResult.rows[0];

        return {
          id: newUser.id,
          keycloakId: keycloakUser.sub,
          userId: newUser.id, // Para compatibilidad
          email: keycloakUser.email,
          name: keycloakUser.name || keycloakUser.preferred_username || keycloakUser.email,
          rol: newUser.rol,
          keycloakRoles: keycloakUser.realm_access?.roles || []
        };
      }
    } finally {
      client.release();
    }
  }
}

// ================================
// Controlador de Autenticación
// ================================
class KeycloakAuthController {
  /**
   * POST /auth/keycloak/login - Login con Keycloak
   */
  static async login(c: Context) {
    try {
      const { username, password } = await c.req.json();

      if (!username || !password) {
        return c.json({ 
          error: 'Username y password son requeridos' 
        }, 400);
      }

      const result = await KeycloakAuthService.login(username, password);

      return c.json({
        message: 'Autenticación exitosa',
        ...result
      });

    } catch (error: any) {
      console.error('Error en login controller:', error);
      return c.json({ 
        error: error.message || 'Error de autenticación' 
      }, 401);
    }
  }

  /**
   * POST /auth/keycloak/refresh - Refrescar token
   */
  static async refresh(c: Context) {
    try {
      const { refresh_token } = await c.req.json();

      if (!refresh_token) {
        return c.json({ 
          error: 'Refresh token es requerido' 
        }, 400);
      }

      const result = await KeycloakAuthService.refreshToken(refresh_token);

      return c.json({
        message: 'Token refrescado exitosamente',
        ...result
      });

    } catch (error: any) {
      console.error('Error en refresh controller:', error);
      return c.json({ 
        error: error.message || 'Error refrescando token' 
      }, 401);
    }
  }

  /**
   * GET /auth/keycloak/me - Información del usuario actual
   */
  static async me(c: Context) {
    try {
      const authHeader = c.req.header('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'Token requerido' }, 401);
      }

      const token = authHeader.substring(7);
      const result = await KeycloakAuthService.getUserProfile(token);

      return c.json(result);

    } catch (error: any) {
      console.error('Error en me controller:', error);
      return c.json({ 
        error: error.message || 'Error obteniendo perfil' 
      }, 401);
    }
  }

  /**
   * POST /auth/keycloak/logout - Logout (principalmente para limpiar del lado cliente)
   */
  static async logout(c: Context) {
    // Para logout completo de Keycloak necesitaríamos hacer una petición a Keycloak
    // Por ahora solo confirmamos que el cliente puede limpiar sus tokens
    return c.json({
      success: true,
      message: 'Logout exitoso'
    });
  }
}

// ================================
// Rutas de Autenticación Keycloak
// ================================
export const keycloakAuthRoutes = new Hono<{ Variables: Variables }>();

// Rutas públicas de autenticación
keycloakAuthRoutes.post('/auth/keycloak/login', KeycloakAuthController.login);
keycloakAuthRoutes.post('/auth/keycloak/refresh', KeycloakAuthController.refresh);
keycloakAuthRoutes.post('/auth/keycloak/logout', KeycloakAuthController.logout);

// Ruta protegida para información del usuario
keycloakAuthRoutes.get('/auth/keycloak/me', KeycloakAuthController.me);

export { KeycloakAuthService, KeycloakAuthController };