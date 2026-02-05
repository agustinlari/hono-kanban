// helpers/sync.helper.ts - Sincronización de proyectos desde ERP externo
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { pool } from '../config/database';
import type { Variables } from '../types';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';

// ================================
// Configuración
// ================================
const SYNC_API_KEY = process.env.API_EXPORT_KEY || 'kE7pZ2nQ9xR4sWbV1yU8vA3mF6jH1gC4';

// ================================
// Tipos
// ================================
interface SyncAgent {
  id: string;
  controller: any;
  connectedAt: number;
  aborted: boolean;
}

interface ProyectoERP {
  fpacod: string;      // -> nombre_proyecto
  inscli: string;      // -> cadena
  envpai: string;      // -> mercado
  envpob: string;      // -> ciudad
  envdir: string;      // -> inmueble
  numobr: string;      // -> numero_obra_osmos (clave para UPSERT)
  nombre: string;      // -> descripcion
}

// ================================
// Servicio de Sincronización
// ================================
class SyncService {
  private static agent: SyncAgent | null = null;
  private static pendingRequest: {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timeout: NodeJS.Timeout;
  } | null = null;

  /**
   * Registra el agente de sincronización
   */
  static registerAgent(controller: any): string {
    // Si hay un agente anterior, marcarlo como abortado
    if (this.agent && !this.agent.aborted) {
      console.log('🔄 Cerrando agente de sincronización anterior');
      this.agent.aborted = true;
      try {
        this.agent.controller.close?.();
      } catch (e) {
        // Ignorar errores al cerrar
      }
    }

    const agentId = `sync-agent-${Date.now()}`;
    this.agent = {
      id: agentId,
      controller,
      connectedAt: Date.now(),
      aborted: false
    };

    console.log(`✅ Agente de sincronización conectado: ${agentId}`);
    return agentId;
  }

  /**
   * Desregistra el agente de sincronización
   */
  static unregisterAgent(): void {
    if (this.agent) {
      console.log(`🔌 Agente de sincronización desconectado: ${this.agent.id}`);
      this.agent.aborted = true;
      this.agent = null;
    }
  }

  /**
   * Verifica si hay un agente conectado
   */
  static isAgentConnected(): boolean {
    return this.agent !== null && !this.agent.aborted;
  }

  /**
   * Envía solicitud de sincronización al agente
   * Retorna una promesa que se resuelve cuando el agente responde
   */
  static async requestSync(): Promise<{ success: boolean; message: string; count?: number }> {
    if (!this.isAgentConnected()) {
      return {
        success: false,
        message: 'No hay agente de sincronización conectado. Verifica que el script Python esté ejecutándose.'
      };
    }

    // Crear promesa que se resolverá cuando lleguen los datos
    return new Promise((resolve, reject) => {
      // Timeout de 60 segundos
      const timeout = setTimeout(() => {
        this.pendingRequest = null;
        reject(new Error('Timeout esperando respuesta del agente de sincronización'));
      }, 60000);

      this.pendingRequest = { resolve, reject, timeout };

      // Enviar evento al agente
      try {
        this.agent!.controller.writeSSE({
          event: 'sync:request',
          data: JSON.stringify({ timestamp: Date.now() })
        });
        console.log('📡 Solicitud de sincronización enviada al agente');
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequest = null;
        this.unregisterAgent();
        reject(new Error('Error enviando solicitud al agente'));
      }
    });
  }

  /**
   * Procesa los datos recibidos del agente y hace UPSERT en la BD
   */
  static async processProjectsData(proyectos: ProyectoERP[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const p of proyectos) {
        // Verificar si existe el proyecto por numero_obra_osmos
        const existing = await client.query(
          'SELECT id FROM proyectos WHERE numero_obra_osmos = $1',
          [p.numobr]
        );

        if (existing.rowCount && existing.rowCount > 0) {
          // UPDATE
          await client.query(`
            UPDATE proyectos SET
              nombre_proyecto = $1,
              cadena = $2,
              mercado = $3,
              ciudad = $4,
              inmueble = $5,
              descripcion = $6,
              fecha_cambio = NOW()
            WHERE numero_obra_osmos = $7
          `, [
            p.fpacod || null,
            p.inscli || null,
            p.envpai || null,
            p.envpob || null,
            p.envdir || null,
            p.nombre || null,
            p.numobr
          ]);
          updated++;
        } else {
          // INSERT
          await client.query(`
            INSERT INTO proyectos (
              nombre_proyecto, cadena, mercado, ciudad, inmueble,
              descripcion, numero_obra_osmos, creado_manualmente, activo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, true)
          `, [
            p.fpacod || null,
            p.inscli || null,
            p.envpai || null,
            p.envpob || null,
            p.envdir || null,
            p.nombre || null,
            p.numobr
          ]);
          inserted++;
        }
      }

      await client.query('COMMIT');
      console.log(`✅ Sincronización completada: ${inserted} insertados, ${updated} actualizados`);

      // Resolver la promesa pendiente si existe
      if (this.pendingRequest) {
        clearTimeout(this.pendingRequest.timeout);
        this.pendingRequest.resolve({
          success: true,
          message: `Sincronización completada: ${inserted} nuevos, ${updated} actualizados`,
          count: inserted + updated
        });
        this.pendingRequest = null;
      }

      return { inserted, updated };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error en sincronización:', error);

      if (this.pendingRequest) {
        clearTimeout(this.pendingRequest.timeout);
        this.pendingRequest.reject(error);
        this.pendingRequest = null;
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Envía heartbeat al agente
   */
  static sendHeartbeat(): void {
    if (this.agent && !this.agent.aborted) {
      try {
        this.agent.controller.writeSSE({ event: 'ping', data: 'heartbeat' });
      } catch (error) {
        console.error('❌ Error enviando heartbeat al agente:', error);
        this.unregisterAgent();
      }
    }
  }
}

// Heartbeat cada 30 segundos
setInterval(() => {
  SyncService.sendHeartbeat();
}, 30000);

// ================================
// Rutas
// ================================
export const syncRoutes = new Hono<{ Variables: Variables }>();

/**
 * SSE endpoint para el agente de sincronización (Python script)
 * Autenticación por API key
 */
syncRoutes.get('/sync/agent', async (c: Context) => {
  const apiKey = c.req.query('api_key');

  if (apiKey !== SYNC_API_KEY) {
    return c.json({ error: 'API key inválida' }, 401);
  }

  console.log('🔌 Agente de sincronización conectando...');

  return streamSSE(c, async (stream) => {
    const agentId = SyncService.registerAgent(stream);

    // Enviar confirmación de conexión
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ agentId, message: 'Conectado al servidor de sincronización' })
    });

    // Mantener conexión abierta
    try {
      while (true) {
        await stream.sleep(10000);
      }
    } catch (error) {
      console.log('🔌 Conexión del agente cerrada');
    } finally {
      SyncService.unregisterAgent();
    }
  });
});

/**
 * Endpoint para que los usuarios soliciten sincronización
 * Requiere autenticación JWT
 */
syncRoutes.post('/sync/request', keycloakAuthMiddleware, async (c: Context) => {
  try {
    const result = await SyncService.requestSync();
    return c.json(result, result.success ? 200 : 503);
  } catch (error: any) {
    console.error('Error en solicitud de sincronización:', error);
    return c.json({
      success: false,
      message: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * Endpoint para que el agente envíe los datos de proyectos
 * Autenticación por API key
 */
syncRoutes.post('/sync/projects', async (c: Context) => {
  const apiKey = c.req.header('X-API-Key') || c.req.query('api_key');

  if (apiKey !== SYNC_API_KEY) {
    return c.json({ error: 'API key inválida' }, 401);
  }

  try {
    const body = await c.req.json();
    const proyectos: ProyectoERP[] = body.proyectos;

    if (!Array.isArray(proyectos)) {
      return c.json({ error: 'Se esperaba un array de proyectos' }, 400);
    }

    console.log(`📥 Recibidos ${proyectos.length} proyectos del agente`);

    const result = await SyncService.processProjectsData(proyectos);

    return c.json({
      success: true,
      inserted: result.inserted,
      updated: result.updated,
      total: result.inserted + result.updated
    });
  } catch (error: any) {
    console.error('Error procesando proyectos:', error);
    return c.json({
      error: 'Error procesando proyectos',
      details: error.message
    }, 500);
  }
});

/**
 * Endpoint para verificar estado del agente de sincronización
 */
syncRoutes.get('/sync/status', keycloakAuthMiddleware, async (c: Context) => {
  return c.json({
    agentConnected: SyncService.isAgentConnected(),
    timestamp: new Date().toISOString()
  });
});
