// src/helpers/inventarioHelper.ts

// ================================
// TYPES
// ================================
export interface InventarioItem {
  refArticulo: string;
  Descripcion: string;
  EAN13?: string;
  Ubicacion?: string;
  StockMinimo?: number;
  StockMaximo?: number;
  reservadas?: number;
  totales?: number;
}
export interface InventarioCreatePayload {
  refArticulo: string;
  Descripcion: string;
  EAN13?: string;
  Ubicacion?: string;
  StockMinimo?: number;
  StockMaximo?: number;
}
export type InventarioUpdatePayload = Partial<Omit<InventarioItem, 'refArticulo'>>;
export interface InventarioPaginadoRequest {
  cantidad: number;
  offset: number;
  texto?: string | null;
}
export interface InventarioPaginadoResponse {
  resultados: InventarioItem[];
  total: number;
}

// ================================
// VALIDATION UTILS
// ================================
export function esFechaValida(fecha: any): fecha is string {
  if (typeof fecha !== 'string') return false;
  return !isNaN(Date.parse(fecha));
}

// ================================
// IMPORTS EXTERNOS
// ================================
import { pool } from '../config/database'; 
import { Hono } from 'hono';
import type { Context } from 'hono';
import { authMiddleware, authorize } from '../middleware/auth'; 
import type { Variables } from '../types'; 
import fs from 'fs/promises';
import path from 'path';
import { UPLOADS_DIR } from './archivosHelper';

// ================================
// SERVICE
// ================================
export class InventarioService {
  static async getInventarioPaginado(params: InventarioPaginadoRequest): Promise<InventarioPaginadoResponse> {
    const { cantidad, offset, texto } = params;
    let baseQuery = 'FROM "Inventario"';
    let whereClause = '';
    let queryParams: any[] = [];
    const searchText = typeof texto === 'string' ? texto.trim() : '';
    if (searchText !== '') {
      whereClause = `WHERE ("refArticulo" ILIKE $1 OR "Descripcion" ILIKE $1 OR "EAN13" ILIKE $1)`;
      queryParams.push(`%${searchText}%`);
    }
    const countQuery = `SELECT COUNT(*) as total ${baseQuery} ${whereClause}`;
    const dataQuery = `SELECT * ${baseQuery} ${whereClause} ORDER BY "refArticulo" ASC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    const finalDataQueryParams = [...queryParams, cantidad, offset];
    const finalCountQueryParams = [...queryParams];
    try {
      const [countResult, dataResult] = await Promise.all([
        pool.query(countQuery, finalCountQueryParams),
        pool.query(dataQuery, finalDataQueryParams)
      ]);
      const total = parseInt(countResult.rows[0].total);
      const resultados = dataResult.rows as InventarioItem[];
      return { resultados, total };
    } catch (error) {
      console.error('Error en getInventarioPaginado:', error);
      throw error;
    }
  }

  static async updateInventarioItem(id: string, data: InventarioUpdatePayload): Promise<InventarioItem | null> {
    const fieldsToUpdate = Object.keys(data) as Array<keyof InventarioUpdatePayload>;
    if (fieldsToUpdate.length === 0) {
      const currentItemResult = await pool.query('SELECT * FROM "Inventario" WHERE "refArticulo" = $1', [id]);
      if (!currentItemResult || typeof currentItemResult.rowCount !== 'number' || currentItemResult.rowCount === 0) {
        return null;
      }
      return currentItemResult.rows[0] as InventarioItem;
    }
    const setClause = fieldsToUpdate.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
    const queryValues = fieldsToUpdate.map(key => data[key as keyof InventarioUpdatePayload]);
    queryValues.push(id);
    const updateQuery = `UPDATE "Inventario" SET ${setClause} WHERE "refArticulo" = $${queryValues.length} RETURNING *;`;
    try {
      const result = await pool.query(updateQuery, queryValues);
      if (!result || typeof result.rowCount !== 'number' || result.rowCount === 0) {
        return null;
      }
      return result.rows[0] as InventarioItem;
    } catch (error) {
      console.error('Error en updateInventarioItem:', error);
      throw error;
    }
  }

  // <-- FUNCIÓN CORREGIDA
  static async createInventarioItem(data: InventarioCreatePayload): Promise<InventarioItem> {
    try {
      const { refArticulo, Descripcion, EAN13 = '', Ubicacion = '', StockMinimo = 0, StockMaximo = 9999 } = data;
      
      const checkQuery = 'SELECT 1 FROM "Inventario" WHERE "refArticulo" = $1';
      const checkResult = await pool.query(checkQuery, [refArticulo]);

      if (typeof checkResult.rowCount === 'number' && checkResult.rowCount > 0) {
        const error = new Error(`El artículo con referencia '${refArticulo}' ya existe.`);
        (error as any).code = '23505';
        (error as any).statusCode = 409;
        throw error;
      }

      const insertQuery = `INSERT INTO "Inventario" ("refArticulo", "Descripcion", "EAN13", "Ubicacion", "StockMinimo", "StockMaximo", "totales", "reservadas") VALUES ($1, $2, $3, $4, $5, $6, 0, 0) RETURNING *;`;
      const queryValues = [refArticulo, Descripcion, EAN13, Ubicacion, StockMinimo, StockMaximo];

      const result = await pool.query(insertQuery, queryValues);
      return result.rows[0] as InventarioItem;

    } catch (error) {
      console.error('Error en createInventarioItem:', error);
      throw error; // Relanzamos para que el controlador lo maneje
    }
  }
  
  static async getArchivosDeArticulo(refArticulo: string): Promise<any[]> {
    try {
      const query = `SELECT a.id, a.nombre_original, a.nombre_guardado, a.mimetype FROM archivos a JOIN inventario_archivos ia ON a.id = ia.archivo_id WHERE ia.inventario_ref_articulo = $1`;
      const { rows } = await pool.query(query, [refArticulo]);
      return rows;
    } catch (error) {
      console.error(`Error en getArchivosDeArticulo para ${refArticulo}:`, error);
      throw error;
    }
  }

  static async asociarArchivo(refArticulo: string, archivoId: number): Promise<void> {
    try {
      const query = `INSERT INTO inventario_archivos (inventario_ref_articulo, archivo_id) VALUES ($1, $2)`;
      await pool.query(query, [refArticulo, archivoId]);
    } catch (error) {
      console.error(`Error en asociarArchivo para ${refArticulo}, archivo ${archivoId}:`, error);
      throw error;
    }
  }

  // REEMPLAZA el antiguo método desasociarArchivo por este:
  static async desasociarYLimpiarArchivo(refArticulo: string, archivoId: number): Promise<{ mensaje: string }> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Paso 1: Borrar la asociación específica.
        const deleteLinkResult = await client.query(
            'DELETE FROM inventario_archivos WHERE inventario_ref_articulo = $1 AND archivo_id = $2',
            [refArticulo, archivoId]
        );

        // Si no se borró nada, la asociación no existía.
        if (deleteLinkResult.rowCount === 0) {
            await client.query('ROLLBACK');
            throw new Error('Asociación no encontrada'); // Lanzamos error para que el controller lo maneje como 404
        }

        // Paso 2: Comprobar si el archivo ha quedado huérfano.
        const checkOrphanResult = await client.query(
            'SELECT COUNT(*) FROM inventario_archivos WHERE archivo_id = $1',
            [archivoId]
        );
        const associationsCount = parseInt(checkOrphanResult.rows[0].count, 10);

        // Paso 3: Si está huérfano, borrar el archivo y su registro principal.
        if (associationsCount === 0) {
            // Obtenemos los metadatos del archivo para saber cuál borrar del disco.
            const fileMetaResult = await client.query(
                'SELECT ruta_relativa FROM archivos WHERE id = $1',
                [archivoId]
            );

            if (fileMetaResult.rows.length > 0) {
                const rutaRelativa = fileMetaResult.rows[0].ruta_relativa;
                const rutaCompleta = path.join(UPLOADS_DIR, rutaRelativa);

                // Borramos el registro de la tabla 'archivos'.
                await client.query('DELETE FROM archivos WHERE id = $1', [archivoId]);

                // Borramos el archivo físico.
                try {
                    await fs.unlink(rutaCompleta);
                } catch (unlinkError: any) {
                    if (unlinkError.code === 'ENOENT') {
                        console.warn(`Archivo huérfano (ID: ${archivoId}) borrado de la BD, pero no se encontró en el disco en: ${rutaCompleta}`);
                    } else {
                        // Si hay otro error (ej. permisos), revertimos la transacción.
                        throw unlinkError;
                    }
                }
                
                await client.query('COMMIT');
                return { mensaje: 'Imagen desvinculada y archivo huérfano eliminado con éxito.' };
            }
        }
        
        // Si no estaba huérfano, simplemente confirmamos la transacción.
        await client.query('COMMIT');
        return { mensaje: 'Imagen desvinculada con éxito. El archivo se mantiene al estar en uso.' };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error en desasociarYLimpiarArchivo para ref ${refArticulo}, archivo ${archivoId}:`, error);
        throw error; // Relanzamos para que el controlador lo capture.
    } finally {
        client.release();
    }
  }
}

// ================================
// CONTROLLER
// ================================
export class InventarioController {
  static async getInventarioPaginado(c: Context) {
    try {
      const body = await c.req.json() as InventarioPaginadoRequest;
      const { cantidad, offset, texto } = body;
      if (typeof cantidad !== 'number' || typeof offset !== 'number' || (texto !== null && texto !== undefined && typeof texto !== 'string')) {
        return c.json({ error: 'Parámetros inválidos.' }, 400);
      }
      if (cantidad <= 0 || cantidad > 100) return c.json({ error: 'La cantidad debe estar entre 1 y 100.' }, 400);
      if (offset < 0) return c.json({ error: 'El offset no puede ser negativo.' }, 400);
      const resultado = await InventarioService.getInventarioPaginado({ cantidad, offset, texto });
      return c.json(resultado);
    } catch (error: any) {
      console.error('Error en getInventarioPaginado (Controller):', error);
      if (error instanceof SyntaxError) return c.json({ error: 'Cuerpo de la petición JSON malformado.' }, 400);
      return c.json({ error: error.message || 'Error interno del servidor.' }, 500);
    }
  }

  static async updateInventarioItem(c: Context) {
    try {
      const id = c.req.param('refArticulo');
      const body = await c.req.json() as InventarioUpdatePayload;
      if (typeof body !== 'object' || body === null || Object.keys(body).length === 0) {
        return c.json({ error: 'El cuerpo de la petición no puede estar vacío.' }, 400);
      }
      const updatedItem = await InventarioService.updateInventarioItem(id, body);
      if (!updatedItem) return c.json({ error: `Ítem con ID ${id} no encontrado.` }, 404);
      return c.json(updatedItem, 200);
    } catch (error: any) {
      console.error('Error en updateInventarioItem (Controller):', error);
      if (error instanceof SyntaxError) return c.json({ error: 'Cuerpo de la petición JSON malformado.' }, 400);
      return c.json({ error: error.message || 'Error interno del servidor.' }, 500);
    }
  }

  static async createInventarioItem(c: Context) {
    try {
      const body = await c.req.json() as InventarioCreatePayload;
      if (!body.refArticulo || !body.Descripcion) return c.json({ error: 'Los campos "refArticulo" y "Descripcion" son obligatorios.' }, 400);
      if (typeof body.refArticulo !== 'string' || typeof body.Descripcion !== 'string') return c.json({ error: 'Los campos "refArticulo" y "Descripcion" deben ser de tipo string.' }, 400);
      const newItem = await InventarioService.createInventarioItem(body);
      return c.json(newItem, 201);
    } catch (error: any) {
      console.error('Error en createInventarioItem (Controller):', error);
      if (error.statusCode === 409) return c.json({ error: error.message }, 409);
      if (error instanceof SyntaxError) return c.json({ error: 'Cuerpo de la petición JSON malformado.' }, 400);
      return c.json({ error: error.message || 'Error interno del servidor.' }, 500);
    }
  }

  static async getArchivosDeArticulo(c: Context) {
    try {
      const refArticulo = c.req.param('refArticulo');
      const archivos = await InventarioService.getArchivosDeArticulo(refArticulo);
      return c.json(archivos);
    } catch (error: any) {
      console.error('Error al obtener archivos de artículo:', error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  static async asociarArchivo(c: Context) {
    try {
      const refArticulo = c.req.param('refArticulo');
      const { archivo_id } = await c.req.json<{ archivo_id: number }>();
      if (typeof archivo_id !== 'number') return c.json({ error: 'El ID del archivo es requerido y debe ser un número' }, 400);
      await InventarioService.asociarArchivo(refArticulo, archivo_id);
      return c.json({ mensaje: 'Archivo asociado con éxito' }, 201);
    } catch (error: any) {
      if (error.code === '23505') return c.json({ error: 'Este archivo ya está asociado a este artículo.' }, 409);
      if (error.code === '23503') return c.json({ error: 'El artículo o el archivo especificado no existe.' }, 404);
      console.error('Error al asociar archivo:', error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

// REEMPLAZA el antiguo método desasociarArchivo por este:
  static async desasociarArchivo(c: Context) {
    try {
        const refArticulo = c.req.param('refArticulo');
        const archivoId = parseInt(c.req.param('archivoId'));

        if (isNaN(archivoId)) {
            return c.json({ error: 'El ID del archivo debe ser un número válido' }, 400);
        }
        
        // Llamamos a nuestro nuevo y mejorado método de servicio
        const resultado = await InventarioService.desasociarYLimpiarArchivo(refArticulo, archivoId);

        return c.json(resultado);
        
    } catch (error: any) {
        console.error('Error al desasociar archivo (Controller):', error);
        // Si el servicio lanzó el error "Asociación no encontrada", lo devolvemos como 404.
        if (error.message === 'Asociación no encontrada') {
            return c.json({ error: error.message }, 404);
        }
        return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }
}

// ================================
// ROUTES
// ================================
export const inventarioRoutes = new Hono<{ Variables: Variables }>();

inventarioRoutes.post('/inventario-paginado', authMiddleware, InventarioController.getInventarioPaginado);
inventarioRoutes.get('/inventario-paginado', authMiddleware, async (c) => {
  try {
    const cantidadStr = c.req.query('cantidad') || '10';
    const offsetStr = c.req.query('offset') || '0';
    const texto = c.req.query('texto') || null;
    const cantidad = parseInt(cantidadStr);
    const offset = parseInt(offsetStr);
    if (isNaN(cantidad) || isNaN(offset)) return c.json({ error: 'Los parámetros cantidad y offset deben ser números válidos.' }, 400);
    if (cantidad <= 0 || cantidad > 100) return c.json({ error: 'La cantidad debe estar entre 1 y 100.' }, 400);
    if (offset < 0) return c.json({ error: 'El offset no puede ser negativo.' }, 400);
    const resultado = await InventarioService.getInventarioPaginado({ cantidad, offset, texto });
    return c.json(resultado);
  } catch (error: any) {
    console.error('Error en GET /inventario-paginado:', error);
    return c.json({ error: error.message || 'Error interno del servidor.' }, 500);
  }
});

inventarioRoutes.put('/inventario/:refArticulo', authMiddleware, authorize(['admin']), InventarioController.updateInventarioItem);
inventarioRoutes.post('/inventario', authMiddleware, authorize(['admin']), InventarioController.createInventarioItem);
inventarioRoutes.get('/inventario/:refArticulo/archivos', authMiddleware, InventarioController.getArchivosDeArticulo);
inventarioRoutes.post('/inventario/:refArticulo/archivos', authMiddleware, authorize(['admin']), InventarioController.asociarArchivo);
inventarioRoutes.delete('/inventario/:refArticulo/archivos/:archivoId', authMiddleware, authorize(['admin']), InventarioController.desasociarArchivo);