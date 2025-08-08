// middleware/keycloak-auth.ts - Middleware para autenticación con Keycloak
import type { Context, Next } from 'hono';
import { validateKeycloakToken, type KeycloakUser } from '../helpers/keycloak.helper';
import { pool } from '../config/database';

export interface AppUser {
  keycloakId: string;  // UUID de Keycloak
  userId: number;      // ID interno de nuestra app
  email: string;
  name?: string;
  rol: 'admin' | 'user';
  keycloakRoles: string[];
}

/**
 * Middleware de autenticación con Keycloak
 */
export async function keycloakAuthMiddleware(c: Context, next: Next) {
  try {
    const authHeader = c.req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Token de autenticación requerido' }, 401);
    }

    const token = authHeader.substring(7);
    
    // Validar token con Keycloak
    const keycloakUser = await validateKeycloakToken(token);
    
    // Buscar o crear usuario en nuestra base de datos
    const appUser = await getOrCreateUser(keycloakUser);
    
    // Guardar información del usuario en el contexto
    c.set('user', appUser);
    c.set('keycloakUser', keycloakUser);

    await next();
  } catch (error: any) {
    console.error('Error en keycloakAuthMiddleware:', error);
    return c.json({ error: 'Token inválido o expirado' }, 401);
  }
}

/**
 * Obtiene o crea un usuario en nuestra base de datos basado en la info de Keycloak
 */
async function getOrCreateUser(keycloakUser: KeycloakUser): Promise<AppUser> {
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
      
      // Actualizar email y nombre si cambiaron
      const newName = keycloakUser.name || keycloakUser.preferred_username || keycloakUser.email;
      
      if (existingUser.email !== keycloakUser.email || existingUser.name !== newName) {
        await client.query(
          'UPDATE usuarios SET email = $1, name = $2, updated_at = NOW() WHERE keycloak_id = $3',
          [keycloakUser.email, newName, keycloakUser.sub]
        );
      }

      return {
        id: existingUser.id, // Frontend espera 'id', no 'userId'
        keycloakId: keycloakUser.sub,
        userId: existingUser.id,
        email: keycloakUser.email,
        name: newName,
        isAdmin: existingUser.rol === 'admin', // Frontend espera 'isAdmin'
        rol: existingUser.rol,
        keycloakRoles: keycloakUser.realm_access?.roles || [],
        created_at: existingUser.created_at,
        updated_at: existingUser.updated_at
      };
    } else {
      // Usuario no existe, crearlo
      const newName = keycloakUser.name || keycloakUser.preferred_username || keycloakUser.email;
      
      const insertResult = await client.query(`
        INSERT INTO usuarios (keycloak_id, email, name, rol) 
        VALUES ($1, $2, $3, $4) 
        RETURNING *
      `, [
        keycloakUser.sub,
        keycloakUser.email,
        newName,
        'user' // Rol por defecto
      ]);

      const newUser = insertResult.rows[0];

      return {
        id: newUser.id, // Frontend espera 'id', no 'userId'
        keycloakId: keycloakUser.sub,
        userId: newUser.id,
        email: keycloakUser.email,
        name: newName,
        isAdmin: newUser.rol === 'admin', // Frontend espera 'isAdmin'
        rol: newUser.rol,
        keycloakRoles: keycloakUser.realm_access?.roles || [],
        created_at: newUser.created_at,
        updated_at: newUser.updated_at
      };
    }
  } finally {
    client.release();
  }
}

/**
 * Middleware para verificar rol de administrador
 */
export function requireAdminRole() {
  return async (c: Context, next: Next) => {
    const user = c.get('user') as AppUser;
    
    if (!user) {
      return c.json({ error: 'No autorizado' }, 401);
    }

    // Verificar si es admin en nuestra app O tiene rol admin en Keycloak
    const isAdmin = user.rol === 'admin' || 
                   user.keycloakRoles.includes('admin') ||
                   user.keycloakRoles.includes('realm-admin');

    if (!isAdmin) {
      return c.json({ error: 'Se requieren permisos de administrador' }, 403);
    }

    await next();
  };
}