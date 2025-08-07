// helpers/migration.helper.ts - Helpers para migración de usuarios a Keycloak
import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { authMiddleware } from '../middleware/auth';
import type { Variables } from '../types';

// ================================
// Servicio de Migración
// ================================
class MigrationService {
  /**
   * Ejecuta la migración SQL para Keycloak
   */
  static async executeKeycloakMigration(): Promise<{ success: boolean; message: string; details?: any }> {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // 1. Verificar si la migración ya se ejecutó
      const columnCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'usuarios' 
        AND column_name = 'keycloak_id'
      `);

      if (columnCheck.rowCount && columnCheck.rowCount > 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: 'La migración ya fue ejecutada previamente',
          details: { keycloak_id_exists: true }
        };
      }

      // 2. Ejecutar la migración paso a paso
      console.log('🔄 Ejecutando migración de Keycloak...');

      // Agregar columna keycloak_id
      await client.query('ALTER TABLE usuarios ADD COLUMN keycloak_id UUID UNIQUE');
      console.log('✅ Columna keycloak_id agregada');

      // Hacer password_hash opcional
      await client.query('ALTER TABLE usuarios ALTER COLUMN password_hash DROP NOT NULL');
      console.log('✅ password_hash ahora es opcional');

      // Crear índice
      await client.query('CREATE INDEX idx_usuarios_keycloak_id ON usuarios(keycloak_id)');
      console.log('✅ Índice creado');

      // Agregar comentarios
      await client.query("COMMENT ON COLUMN usuarios.keycloak_id IS 'UUID del usuario en Keycloak'");
      await client.query("COMMENT ON COLUMN usuarios.password_hash IS 'Hash de contraseña (obsoleto con Keycloak)'");
      console.log('✅ Comentarios agregados');

      await client.query('COMMIT');

      return {
        success: true,
        message: 'Migración de Keycloak ejecutada exitosamente',
        details: {
          changes: [
            'Campo keycloak_id agregado',
            'password_hash ahora es opcional',
            'Índice idx_usuarios_keycloak_id creado',
            'Comentarios agregados'
          ]
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error en migración de Keycloak:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Verifica el estado de la migración
   */
  static async checkMigrationStatus(): Promise<any> {
    const client = await pool.connect();
    
    try {
      // Verificar columnas existentes
      const columnsResult = await client.query(`
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM information_schema.columns 
        WHERE table_name = 'usuarios'
        AND column_name IN ('keycloak_id', 'password_hash')
        ORDER BY column_name
      `);

      // Verificar índices
      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'usuarios'
        AND indexname LIKE '%keycloak%'
      `);

      // Contar usuarios
      const usersResult = await client.query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(keycloak_id) as users_with_keycloak_id,
          COUNT(password_hash) as users_with_password
        FROM usuarios
      `);

      return {
        columns: columnsResult.rows,
        indexes: indexResult.rows,
        user_stats: usersResult.rows[0],
        migration_completed: columnsResult.rows.some(row => row.column_name === 'keycloak_id')
      };
    } finally {
      client.release();
    }
  }
}

// ================================
// Controlador de Migración
// ================================
class MigrationController {
  /**
   * Ejecuta la migración de Keycloak
   */
  static async executeKeycloakMigration(c: Context) {
    try {
      const result = await MigrationService.executeKeycloakMigration();
      
      if (result.success) {
        return c.json(result, 200);
      } else {
        return c.json(result, 400);
      }
    } catch (error: any) {
      console.error('Error ejecutando migración:', error);
      return c.json({
        success: false,
        message: 'Error ejecutando la migración',
        error: error.message
      }, 500);
    }
  }

  /**
   * Verifica el estado de la migración
   */
  static async checkStatus(c: Context) {
    try {
      const status = await MigrationService.checkMigrationStatus();
      return c.json(status);
    } catch (error: any) {
      console.error('Error verificando estado de migración:', error);
      return c.json({ error: 'Error verificando estado de migración' }, 500);
    }
  }
}

// ================================
// Rutas de Migración (TEMPORALES)
// ================================
export const migrationRoutes = new Hono<{ Variables: Variables }>();

// Solo accesible para usuarios autenticados
migrationRoutes.use('*', authMiddleware);

// Endpoints de migración
migrationRoutes.get('/migration/keycloak/status', MigrationController.checkStatus);
migrationRoutes.post('/migration/keycloak/execute', MigrationController.executeKeycloakMigration);

// IMPORTANTE: Estos endpoints deben eliminarse después de la migración
export { MigrationService };