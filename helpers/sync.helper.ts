// helpers/sync.helper.ts - Sincronización directa de proyectos desde ERP (SQL Server)
import { Hono } from 'hono';
import type { Context } from 'hono';
import sql from 'mssql';
import cron from 'node-cron';
import { pool } from '../config/database';
import type { Variables } from '../types';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import NodeGeocoder from 'node-geocoder';
import { imapService } from '../services/imap.service';

// ================================
// Configuración SQL Server (ERP)
// ================================
const ERP_CONFIG: sql.config = {
  server: 'SRVSQL',
  database: 'OBRAOSM2026',
  user: 'consultasOsmos',
  password: 'yZ43mEsewFvu',
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  requestTimeout: 30000,
  connectionTimeout: 10000,
};

// Mapeo de códigos fpacod a nombres descriptivos
const FPACOD_MAP: Record<string, string> = {
  'X060': 'Otros',
  'CF60': 'Retail',
  'C000': 'Cuadros',
};

function translateFpacod(code: string): string {
  return FPACOD_MAP[code.trim()] || code;
}

// ================================
// Tipos
// ================================
interface ProyectoERP {
  fpacod: string;
  inscli: string;
  envpai: string;
  envpob: string;
  envdir: string;
  envcpo: string;
  numobr: string;
  nombre: string;
}

interface PedidoERP {
  numobr: string;
  numped: string;
  fisnom: string;
  fecped: string;
  situac: string;
  estado: string;
}

// ================================
// Consultas al ERP
// ================================
async function fetchProyectosFromERP(): Promise<ProyectoERP[]> {
  console.log('📡 Consultando proyectos en SQL Server...');
  const connection = await sql.connect(ERP_CONFIG);
  try {
    const result = await connection.request().query(`
      SELECT
        obras.fpacod,
        obras.inscli,
        obras.envpai,
        obras.envpob,
        obras.envdir,
        obras.envcpo,
        obras.numobr,
        obras.nombre
      FROM obras
      WHERE (obras.fpacod='X060' OR obras.fpacod='CF90' OR obras.fpacod='CF60' OR obras.fpacod='C000')
        AND obras.numemp = 2
    `);

    const proyectos: ProyectoERP[] = result.recordset.map((row: any) => ({
      fpacod: translateFpacod(String(row.fpacod || '').trim()),
      inscli: String(row.inscli || '').trim(),
      envpai: String(row.envpai || '').trim(),
      envpob: String(row.envpob || '').trim(),
      envdir: String(row.envdir || '').trim(),
      envcpo: String(row.envcpo || '').trim(),
      numobr: String(row.numobr || '').trim(),
      nombre: String(row.nombre || '').trim(),
    }));

    console.log(`✅ Obtenidos ${proyectos.length} proyectos de SQL Server`);
    return proyectos;
  } finally {
    await connection.close();
  }
}

async function fetchPedidosFromERP(): Promise<PedidoERP[]> {
  console.log('📡 Consultando pedidos en SQL Server...');
  const connection = await sql.connect(ERP_CONFIG);
  try {
    const result = await connection.request().query(`
      SELECT
        pediprov.numobr,
        pediprov.numped,
        pediprov.fisnom,
        pediprov.fecped,
        pediprov.situac,
        pediprov.estado
      FROM pediprov
      WHERE pediprov.numalm = 1
        AND pediprov.numemp = 2
        AND pediprov.fecped >= DATEADD(month, -2, GETDATE())
    `);

    const pedidos: PedidoERP[] = result.recordset.map((row: any) => ({
      numobr: String(row.numobr || '').trim(),
      numped: String(row.numped || '').trim(),
      fisnom: String(row.fisnom || '').trim(),
      fecped: row.fecped ? new Date(row.fecped).toISOString() : '',
      situac: String(row.situac || '').trim(),
      estado: String(row.estado || '').trim(),
    }));

    console.log(`✅ Obtenidos ${pedidos.length} pedidos de SQL Server`);
    return pedidos;
  } finally {
    await connection.close();
  }
}

// ================================
// Servicio de Sincronización
// ================================
class SyncService {
  private static syncing = false;

  static async requestSync(): Promise<{ success: boolean; message: string; count?: number }> {
    if (this.syncing) {
      return { success: false, message: 'Ya hay una sincronización en curso' };
    }

    this.syncing = true;
    try {
      // 1. Sincronizar proyectos
      const proyectos = await fetchProyectosFromERP();
      const projectResult = await this.processProjectsData(proyectos);

      // 2. Sincronizar pedidos
      const pedidos = await fetchPedidosFromERP();
      const pedidosResult = await this.processPedidosData(pedidos);

      const message = `Proyectos: ${projectResult.inserted} nuevos, ${projectResult.updated} actualizados. ` +
        `Pedidos: ${pedidosResult.inserted} nuevos, ${pedidosResult.updated} actualizados.`;

      console.log(`✅ Sincronización completa: ${message}`);
      return {
        success: true,
        message,
        count: projectResult.inserted + projectResult.updated + pedidosResult.inserted + pedidosResult.updated
      };
    } catch (error: any) {
      console.error('❌ Error en sincronización:', error);
      return {
        success: false,
        message: `Error de sincronización: ${error.message}`
      };
    } finally {
      this.syncing = false;
    }
  }

  static async processProjectsData(proyectos: ProyectoERP[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const p of proyectos) {
        const existing = await client.query(
          'SELECT id, coordinates_user_override FROM proyectos WHERE numero_obra_osmos = $1',
          [p.numobr]
        );

        if (existing.rowCount && existing.rowCount > 0) {
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
          updated++;
        } else {
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
      console.log(`✅ Proyectos: ${inserted} insertados, ${updated} actualizados`);

      // Geocodificar en background
      geocodeProjectsWithoutCoordinates().catch(err => {
        console.error('⚠️ Error en geocodificación post-sync:', err);
      });

      return { inserted, updated };
    } catch (error) {
      await client.query('ROLLBACK');
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

  static async processPedidosData(pedidos: PedidoERP[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingCards = await client.query(
        `SELECT c.id, c.title, c.list_id, c.progress
         FROM cards c
         JOIN lists l ON c.list_id = l.id
         WHERE l.board_id = $1`,
        [this.PEDIDOS_BOARD_ID]
      );
      const cardMap = new Map<string, { id: string; list_id: number; progress: number }>();
      for (const row of existingCards.rows) {
        const numped = row.title.substring(0, 6);
        cardMap.set(numped, { id: row.id, list_id: row.list_id, progress: row.progress });
      }

      for (const p of pedidos) {
        const situac = (p.situac || '').trim().toUpperCase();
        const estado = (p.estado || '').trim().toUpperCase();

        const targetListId = this.SITUAC_TO_LIST[situac];
        if (!targetListId) {
          console.log(`⚠️ Pedido ${p.numped}: situación desconocida '${situac}', ignorando`);
          continue;
        }

        const progress = estado === 'C' ? 100 : 0;

        const proyecto = await client.query(
          'SELECT id FROM proyectos WHERE numero_obra_osmos = $1',
          [p.numobr]
        );
        const proyectoId = proyecto.rows.length > 0 ? proyecto.rows[0].id : null;

        const titleParts = [p.numped];
        if (p.fisnom) titleParts.push(p.fisnom);
        if (p.fecped) titleParts.push(p.fecped.substring(0, 10));
        const title = titleParts.join(' · ');

        const existingCard = cardMap.get(p.numped);

        if (existingCard) {
          await client.query(`
            UPDATE cards SET
              title = $1,
              list_id = $2,
              progress = $3,
              start_date = $4,
              proyecto_id = $5
            WHERE id = $6
          `, [
            title,
            targetListId,
            progress,
            p.fecped || null,
            proyectoId,
            existingCard.id
          ]);
          updated++;
        } else {
          const posResult = await client.query(
            'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM cards WHERE list_id = $1',
            [targetListId]
          );
          const nextPos = posResult.rows[0].next_pos;

          await client.query(`
            INSERT INTO cards (title, description, position, list_id, start_date, proyecto_id, progress)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            title,
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
      console.log(`✅ Pedidos: ${inserted} tarjetas creadas, ${updated} actualizadas`);
      return { inserted, updated };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

// ================================
// Cron: sincronización automática diaria a las 7:00
// ================================
cron.schedule('0 7 * * *', async () => {
  console.log('⏰ Sincronización automática programada iniciada');
  const result = await SyncService.requestSync();
  console.log(`⏰ Resultado sync automático: ${result.message}`);
});
console.log('⏰ Cron de sincronización configurado: todos los días a las 7:00');

// ================================
// Geocodificación
// ================================
const geocoder = NodeGeocoder({
  provider: 'openstreetmap',
  timeout: 5000,
  'user-agent': 'kanban-logistics/1.0'
} as any);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
      const attempts: string[] = [];

      const fullParts: string[] = [];
      if (row.inmueble) fullParts.push(row.inmueble);
      if (row.codigo_postal) fullParts.push(row.codigo_postal);
      if (row.ciudad) fullParts.push(row.ciudad);
      if (row.mercado) fullParts.push(row.mercado);
      if (fullParts.length > 0) attempts.push(fullParts.join(', '));

      if (row.inmueble && (row.ciudad || row.codigo_postal)) {
        const noParts: string[] = [];
        if (row.codigo_postal) noParts.push(row.codigo_postal);
        if (row.ciudad) noParts.push(row.ciudad);
        if (row.mercado) noParts.push(row.mercado);
        const noInmueble = noParts.join(', ');
        if (noInmueble !== attempts[0]) attempts.push(noInmueble);
      }

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

syncRoutes.get('/sync/status', keycloakAuthMiddleware, async (c: Context) => {
  return c.json({
    agentConnected: true,
    timestamp: new Date().toISOString()
  });
});

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

syncRoutes.post('/pedidos/:id/link-card', keycloakAuthMiddleware, async (c: Context) => {
  const pedidoId = c.req.param('id');
  try {
    const body = await c.req.json();
    const { card_id } = body;

    if (!card_id) {
      return c.json({ error: 'card_id es requerido' }, 400);
    }

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

// ================================
// Rutas de lectura de correos (IMAP)
// ================================

// Test de conexión IMAP
syncRoutes.get('/email/test', keycloakAuthMiddleware, async (c: Context) => {
  try {
    const result = await imapService.testConnection();
    return c.json(result);
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

// Procesar correos de pedidos (vincula emails no leídos a tarjetas)
syncRoutes.post('/email/process-orders', keycloakAuthMiddleware, async (c: Context) => {
  try {
    const user = c.get('user') as any;
    const result = await imapService.processOrderEmails(user.userId);

    return c.json({
      success: true,
      message: `${result.matched.length} correos vinculados a pedidos, ${result.unmatched.length} sin coincidencia`,
      processed: result.processed,
      matched: result.matched.map(m => ({
        subject: m.email.subject,
        from: m.email.from,
        pedidoNumber: m.pedidoNumber,
        cardTitle: m.matchedCardTitle,
      })),
      unmatched: result.unmatched.map(u => ({
        subject: u.subject,
        from: u.from,
        uid: u.uid,
      })),
      errors: result.errors,
    });
  } catch (error: any) {
    console.error('Error procesando correos de pedidos:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Visor de correo completo por UID (retorna HTML)
syncRoutes.get('/email/view/:uid', keycloakAuthMiddleware, async (c: Context) => {
  try {
    const uid = parseInt(c.req.param('uid'));
    if (isNaN(uid)) {
      return c.json({ error: 'UID inválido' }, 400);
    }

    const email = await imapService.fetchEmailByUid(uid);
    if (!email) {
      return c.json({ error: 'Correo no encontrado' }, 404);
    }

    return c.json({
      success: true,
      subject: email.subject,
      from: email.from,
      date: email.date,
      html: email.html,
    });
  } catch (error: any) {
    console.error('Error recuperando correo:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Leer correos recientes
syncRoutes.get('/email/fetch', keycloakAuthMiddleware, async (c: Context) => {
  try {
    const limit = parseInt(c.req.query('limit') || '10');
    const onlyUnseen = c.req.query('unseen') === 'true';
    const emails = await imapService.fetchEmails(limit, onlyUnseen);
    return c.json({ success: true, count: emails.length, emails });
  } catch (error: any) {
    console.error('Error leyendo correos:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});
