// helpers/sync.helper.ts - Sincronización de proyectos desde ERP externo
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { pool } from '../config/database';
import type { Variables } from '../types';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import NodeGeocoder from 'node-geocoder';

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
  envcpo: string;      // -> codigo_postal
  numobr: string;      // -> numero_obra_osmos (clave para UPSERT)
  nombre: string;      // -> descripcion
}

interface PedidoERP {
  numobr: string;      // -> numero_obra_osmos (para buscar id_proyecto)
  numped: string;      // -> numero_pedido (título de la tarjeta)
  fisnom: string;      // -> nombre_proveedor (descripción de la tarjeta)
  fecped: string;      // -> fecha_pedido (start_date de la tarjeta)
  situac: string;      // B=borrador, E=enviado, P=parcial, R=recibido, C=cancelado -> lista
  estado: string;      // A=abierto (progress=0), C=cerrado (progress=100)
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
          // Check if coordinates are user-overridden
          const overrideCheck = await client.query(
            'SELECT coordinates_user_override FROM proyectos WHERE numero_obra_osmos = $1',
            [p.numobr]
          );
          const hasOverride = overrideCheck.rows[0]?.coordinates_user_override === true;

          if (hasOverride) {
            // UPDATE without touching coordinates - user has overridden them
            await client.query(`
              UPDATE proyectos SET
                nombre_proyecto = $1,
                cadena = $2,
                mercado = $3,
                ciudad = $4,
                inmueble = $5,
                codigo_postal = $6,
                descripcion = $7,
                fecha_cambio = NOW()
              WHERE numero_obra_osmos = $8
            `, [
              p.fpacod || null,
              p.inscli || null,
              p.envpai || null,
              p.envpob || null,
              p.envdir || null,
              p.envcpo || null,
              p.nombre || null,
              p.numobr
            ]);
          } else {
            // UPDATE normally (geocoding will run after and set coordinates)
            await client.query(`
              UPDATE proyectos SET
                nombre_proyecto = $1,
                cadena = $2,
                mercado = $3,
                ciudad = $4,
                inmueble = $5,
                codigo_postal = $6,
                descripcion = $7,
                fecha_cambio = NOW()
              WHERE numero_obra_osmos = $8
            `, [
              p.fpacod || null,
              p.inscli || null,
              p.envpai || null,
              p.envpob || null,
              p.envdir || null,
              p.envcpo || null,
              p.nombre || null,
              p.numobr
            ]);
          }
          updated++;
        } else {
          // INSERT
          await client.query(`
            INSERT INTO proyectos (
              nombre_proyecto, cadena, mercado, ciudad, inmueble,
              codigo_postal, descripcion, numero_obra_osmos, creado_manualmente, activo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true)
          `, [
            p.fpacod || null,
            p.inscli || null,
            p.envpai || null,
            p.envpob || null,
            p.envdir || null,
            p.envcpo || null,
            p.nombre || null,
            p.numobr
          ]);
          inserted++;
        }
      }

      await client.query('COMMIT');
      console.log(`✅ Sincronización completada: ${inserted} insertados, ${updated} actualizados`);

      // Geocodificar proyectos sin coordenadas (en background, no bloquea)
      geocodeProjectsWithoutCoordinates().catch(err => {
        console.error('⚠️ Error en geocodificación post-sync:', err);
      });

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

  // Mapeo de situación ERP -> list_id en board "Pedidos" (id=61)
  private static readonly SITUAC_TO_LIST: Record<string, number> = {
    'E': 112,  // Enviado
    'P': 113,  // Parcial
    'R': 114,  // Recibido
    'B': 115,  // Borrador y Cancelados
    'C': 115,  // Borrador y Cancelados
  };

  private static readonly PEDIDOS_BOARD_ID = 61;

  /**
   * Procesa los pedidos recibidos del agente y crea/actualiza tarjetas en el tablero "Pedidos"
   */
  static async processPedidosData(pedidos: PedidoERP[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Cargar todas las tarjetas existentes del board Pedidos de una vez (por título = numped)
      const existingCards = await client.query(
        `SELECT c.id, c.title, c.list_id, c.progress
         FROM cards c
         JOIN lists l ON c.list_id = l.id
         WHERE l.board_id = $1`,
        [this.PEDIDOS_BOARD_ID]
      );
      const cardMap = new Map<string, { id: string; list_id: number; progress: number }>();
      for (const row of existingCards.rows) {
        cardMap.set(row.title, { id: row.id, list_id: row.list_id, progress: row.progress });
      }

      for (const p of pedidos) {
        const situac = (p.situac || '').trim().toUpperCase();
        const estado = (p.estado || '').trim().toUpperCase();

        // Determinar list_id según situación
        const targetListId = this.SITUAC_TO_LIST[situac];
        if (!targetListId) {
          console.log(`⚠️ Pedido ${p.numped}: situación desconocida '${situac}', ignorando`);
          continue;
        }

        // Determinar progress según estado
        const progress = estado === 'C' ? 100 : 0;

        // Buscar proyecto vinculado
        const proyecto = await client.query(
          'SELECT id FROM proyectos WHERE numero_obra_osmos = $1',
          [p.numobr]
        );
        const proyectoId = proyecto.rows.length > 0 ? proyecto.rows[0].id : null;

        const existingCard = cardMap.get(p.numped);

        if (existingCard) {
          // UPDATE: actualizar list_id, progress, description, start_date, proyecto_id
          await client.query(`
            UPDATE cards SET
              list_id = $1,
              progress = $2,
              description = $3,
              start_date = $4,
              proyecto_id = $5
            WHERE id = $6
          `, [
            targetListId,
            progress,
            p.fisnom || null,
            p.fecped || null,
            proyectoId,
            existingCard.id
          ]);
          updated++;
        } else {
          // INSERT: nueva tarjeta al final de la lista
          const posResult = await client.query(
            'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM cards WHERE list_id = $1',
            [targetListId]
          );
          const nextPos = posResult.rows[0].next_pos;

          await client.query(`
            INSERT INTO cards (title, description, position, list_id, start_date, proyecto_id, progress)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            p.numped,
            p.fisnom || null,
            nextPos,
            targetListId,
            p.fecped || null,
            proyectoId,
            progress
          ]);
          inserted++;
        }
      }

      await client.query('COMMIT');
      console.log(`✅ Pedidos sincronizados en tablero: ${inserted} tarjetas creadas, ${updated} actualizadas`);
      return { inserted, updated };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error sincronizando pedidos en tablero:', error);
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
// Geocodificación
// ================================
const geocoder = NodeGeocoder({
  provider: 'openstreetmap',
  timeout: 5000,
  'user-agent': 'kanban-logistics/1.0'
} as any);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Geocodifica proyectos que tienen dirección pero no coordenadas.
 * Usa estrategia de fallback: dirección completa → ciudad+país → solo ciudad.
 * Respeta el rate limit de Nominatim (1 req/s).
 */
async function geocodeProjectsWithoutCoordinates(): Promise<void> {
  const result = await pool.query(`
    SELECT id, ciudad, inmueble, codigo_postal, mercado
    FROM proyectos
    WHERE latitud IS NULL
      AND coordinates_user_override = false
      AND (ciudad IS NOT NULL OR inmueble IS NOT NULL OR codigo_postal IS NOT NULL)
  `);

  if (result.rows.length === 0) {
    return;
  }

  console.log(`🗺️ Geocodificando ${result.rows.length} proyectos...`);
  let ok = 0;
  let failed = 0;

  for (const row of result.rows) {
    try {
      // Construir variantes de dirección (de más específica a menos)
      const attempts: string[] = [];

      // 1) Dirección completa
      const fullParts: string[] = [];
      if (row.inmueble) fullParts.push(row.inmueble);
      if (row.codigo_postal) fullParts.push(row.codigo_postal);
      if (row.ciudad) fullParts.push(row.ciudad);
      if (row.mercado) fullParts.push(row.mercado);
      if (fullParts.length > 0) attempts.push(fullParts.join(', '));

      // 2) Sin inmueble (código postal + ciudad + país)
      if (row.inmueble && (row.ciudad || row.codigo_postal)) {
        const noParts: string[] = [];
        if (row.codigo_postal) noParts.push(row.codigo_postal);
        if (row.ciudad) noParts.push(row.ciudad);
        if (row.mercado) noParts.push(row.mercado);
        const noInmueble = noParts.join(', ');
        if (noInmueble !== attempts[0]) attempts.push(noInmueble);
      }

      // 3) Solo ciudad + país
      if (row.ciudad && row.mercado) {
        const cityCountry = `${row.ciudad}, ${row.mercado}`;
        if (!attempts.includes(cityCountry)) attempts.push(cityCountry);
      }

      if (attempts.length === 0) continue;

      let found = false;
      for (const address of attempts) {
        const results = await geocoder.geocode(address);
        await delay(1100);

        if (results && results.length > 0) {
          await pool.query(
            'UPDATE proyectos SET latitud = $1, longitud = $2 WHERE id = $3',
            [results[0].latitude, results[0].longitude, row.id]
          );
          ok++;
          found = true;
          break;
        }
      }

      if (!found) failed++;
    } catch (err) {
      console.error(`⚠️ Error geocodificando proyecto ${row.id}:`, err);
      failed++;
      await delay(1100);
    }
  }

  console.log(`Done! OK: ${ok} Failed: ${failed}`);
}

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
 * Endpoint para que el agente envíe los datos de pedidos
 * Autenticación por API key
 */
syncRoutes.post('/sync/pedidos', async (c: Context) => {
  const apiKey = c.req.header('X-API-Key') || c.req.query('api_key');

  if (apiKey !== SYNC_API_KEY) {
    return c.json({ error: 'API key inválida' }, 401);
  }

  try {
    const body = await c.req.json();
    const pedidos: PedidoERP[] = body.pedidos;

    if (!Array.isArray(pedidos)) {
      return c.json({ error: 'Se esperaba un array de pedidos' }, 400);
    }

    console.log(`📥 Recibidos ${pedidos.length} pedidos del agente`);

    const result = await SyncService.processPedidosData(pedidos);

    return c.json({
      success: true,
      inserted: result.inserted,
      updated: result.updated,
      total: result.inserted + result.updated
    });
  } catch (error: any) {
    console.error('Error procesando pedidos:', error);
    return c.json({
      error: 'Error procesando pedidos',
      details: error.message
    }, 500);
  }
});

/**
 * Endpoint para obtener todos los pedidos con información del proyecto
 * Requiere autenticación JWT
 */
syncRoutes.get('/pedidos', keycloakAuthMiddleware, async (c: Context) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.numero_pedido,
        p.id_proyecto,
        p.nombre_proveedor,
        p.fecha_pedido,
        p.is_collected,
        p.notas,
        p.created_at,
        pr.numero_obra_osmos,
        pr.ciudad,
        pr.mercado,
        pr.inmueble,
        pr.latitud,
        pr.longitud
      FROM pedidos p
      LEFT JOIN proyectos pr ON p.id_proyecto = pr.id
      ORDER BY p.fecha_pedido DESC
    `);

    return c.json(result.rows);
  } catch (error: any) {
    console.error('Error obteniendo pedidos:', error);
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Endpoint para actualizar un pedido (is_collected, notas)
 * Requiere autenticación JWT
 */
syncRoutes.put('/pedidos/:id', keycloakAuthMiddleware, async (c: Context) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json();
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (body.is_collected !== undefined) {
      fields.push(`is_collected = $${paramIndex++}`);
      values.push(body.is_collected);
    }
    if (body.notas !== undefined) {
      fields.push(`notas = $${paramIndex++}`);
      values.push(body.notas);
    }

    if (fields.length === 0) {
      return c.json({ error: 'No hay campos para actualizar' }, 400);
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE pedidos SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return c.json({ error: 'Pedido no encontrado' }, 404);
    }

    return c.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error actualizando pedido:', error);
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Endpoint para vincular un pedido a la tarjeta actual (logística)
 * Crea una entrada en cards_packages vinculando el pedido
 */
syncRoutes.post('/pedidos/:id/link-card', keycloakAuthMiddleware, async (c: Context) => {
  const pedidoId = c.req.param('id');
  try {
    const body = await c.req.json();
    const { card_id } = body;

    if (!card_id) {
      return c.json({ error: 'card_id es requerido' }, 400);
    }

    // Marcar el pedido como vinculado a logística
    await pool.query(
      'UPDATE pedidos SET is_collected = true WHERE id = $1',
      [pedidoId]
    );

    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error vinculando pedido:', error);
    return c.json({ error: error.message }, 500);
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

/**
 * Endpoint para forzar geocodificación de proyectos sin coordenadas
 * Requiere autenticación JWT
 */
syncRoutes.post('/sync/geocode', keycloakAuthMiddleware, async (c: Context) => {
  try {
    geocodeProjectsWithoutCoordinates().catch(err => {
      console.error('⚠️ Error en geocodificación manual:', err);
    });
    return c.json({
      success: true,
      message: 'Geocodificación iniciada en segundo plano'
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});
