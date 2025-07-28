import { Hono } from 'hono';
import type { Context } from 'hono';
import { authMiddleware } from '../middleware/auth'; // VERIFICA ESTA RUTA
import type { Variables } from '../types';           // VERIFICA ESTA RUTA

// Importaciones necesarias de la lógica del servicio y controlador
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../config/database';      // VERIFICA ESTA RUTA
import { Readable } from 'stream';
import { createReadStream } from 'fs';

// =================================================================
// 1. CONSTANTES DE CONFIGURACIÓN
// =================================================================

const UPLOAD_DIR_FROM_ENV = process.env.UPLOAD_DIR;
if (!UPLOAD_DIR_FROM_ENV) {
  console.warn("ADVERTENCIA: La variable de entorno UPLOAD_DIR no está definida. Usando './uploads' como directorio de subida.");
}
export const UPLOADS_DIR = path.resolve(UPLOAD_DIR_FROM_ENV || 'uploads');
console.log(`Directorio de subida de archivos configurado en: ${UPLOADS_DIR}`);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];


// =================================================================
// 2. TIPOS E INTERFACES
// =================================================================

export interface ArchivoMetadata {
  id: number;
  nombre_original: string;
  nombre_guardado: string;
  ruta_relativa: string;
  mimetype: string;
  tamano_bytes: number;
  usuario_id: number;
  fecha_subida: Date;
}


// =================================================================
// 3. LÓGICA DE SERVICIO
// =================================================================

class ArchivoService {
  private static async ensureUploadDirExists(): Promise<void> {
    try {
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
    } catch (error) {
      console.error(`Error al crear el directorio de subida ${UPLOADS_DIR}:`, error);
      throw new Error(`No se pudo crear el directorio de subida.`);
    }
  }

  static async guardarArchivoLocal(
    file: File,
    userId: number,
    refArticulo: string | null
  ): Promise<ArchivoMetadata> {
    await this.ensureUploadDirExists();

    const extension = path.extname(file.name);
    const nombreGuardado = `${uuidv4()}${extension}`;
    const rutaRelativa = nombreGuardado;
    const rutaCompleta = path.join(UPLOADS_DIR, rutaRelativa);

    const buffer = await file.arrayBuffer();
    await fs.writeFile(rutaCompleta, Buffer.from(buffer));

    const metadataParaInsertar = {
      nombre_original: file.name,
      nombre_guardado: nombreGuardado,
      ruta_relativa: rutaRelativa,
      mimetype: file.type,
      tamano_bytes: file.size,
      usuario_id: userId,
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const archivoQuery = `
        INSERT INTO archivos (nombre_original, nombre_guardado, ruta_relativa, mimetype, tamano_bytes, usuario_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, fecha_subida
      `;
      
      const archivoResult = await client.query(archivoQuery, [
        metadataParaInsertar.nombre_original,
        metadataParaInsertar.nombre_guardado,
        metadataParaInsertar.ruta_relativa,
        metadataParaInsertar.mimetype,
        metadataParaInsertar.tamano_bytes,
        metadataParaInsertar.usuario_id,
      ]);
      
      const nuevoArchivo: ArchivoMetadata = {
        ...metadataParaInsertar,
        id: archivoResult.rows[0].id,
        fecha_subida: archivoResult.rows[0].fecha_subida,
      };

      if (refArticulo) {
        const asociacionQuery = `
          INSERT INTO inventario_archivos (inventario_ref_articulo, archivo_id)
          VALUES ($1, $2)
        `;
        await client.query(asociacionQuery, [refArticulo, nuevoArchivo.id]);
      }

      await client.query('COMMIT');
      
      return nuevoArchivo;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error en la transacción de guardado de archivo, cambios revertidos.", error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async obtenerMetadataArchivo(id: number, userId: number): Promise<ArchivoMetadata | null> {
    const result = await pool.query(
      'SELECT * FROM archivos WHERE id = $1 AND usuario_id = $2',
      [id, userId]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return result.rows[0] as ArchivoMetadata;
  }

  static async obtenerRutaAbsoluta(rutaRelativa: string): Promise<string | null> {
    const rutaCompleta = path.join(UPLOADS_DIR, rutaRelativa);
    try {
      await fs.access(rutaCompleta);
      return rutaCompleta;
    } catch (error) {
      return null;
    }
  }

  static async borrarArchivoLocal(id: number, userId: number): Promise<boolean> {
    const metadata = await this.obtenerMetadataArchivo(id, userId);
    if (!metadata) {
      throw new Error("Archivo no encontrado o acceso denegado.");
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rutaCompleta = path.join(UPLOADS_DIR, metadata.ruta_relativa);
      
      try {
        await fs.unlink(rutaCompleta);
      } catch (unlinkError: any) {
        if (unlinkError.code === 'ENOENT') {
          console.warn(`Archivo no encontrado en disco, pero se borrará de la BD: ${rutaCompleta}.`);
        } else {
          throw unlinkError;
        }
      }
      
      // Gracias a ON DELETE CASCADE, al borrar de 'archivos', se borrará automáticamente de 'inventario_archivos'.
      await client.query('DELETE FROM archivos WHERE id = $1', [id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error en la transacción al borrar archivo:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Añade este método DENTRO de la clase ArchivoService

static async desvincularYLimpiarArchivoDeArticulo(refArticulo: string, archivoId: number): Promise<{ mensaje: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Paso 1: Intentar borrar la asociación específica
      const deleteLinkResult = await client.query(
        'DELETE FROM inventario_archivos WHERE inventario_ref_articulo = $1 AND archivo_id = $2',
        [refArticulo, archivoId]
      );

      if (deleteLinkResult.rowCount === 0) {
        // Si no se borró ninguna fila, es porque el enlace no existía.
        // No es un error, simplemente informamos y terminamos.
        await client.query('ROLLBACK'); // Deshacemos por si acaso, aunque no debería haber cambios.
        return { mensaje: 'La imagen no estaba asociada a este artículo.' };
      }

      // Paso 2: Verificar si el archivo quedó huérfano
      const checkOrphanResult = await client.query(
        'SELECT COUNT(*) FROM inventario_archivos WHERE archivo_id = $1',
        [archivoId]
      );
      const associationsCount = parseInt(checkOrphanResult.rows[0].count, 10);

      // Paso 3: Si está huérfano (count === 0), borrarlo por completo
      if (associationsCount === 0) {
        // Obtenemos la ruta del archivo para poder borrarlo del disco
        const fileMetaResult = await client.query(
          'SELECT ruta_relativa FROM archivos WHERE id = $1',
          [archivoId]
        );

        if (fileMetaResult.rows.length > 0) {
          const rutaRelativa = fileMetaResult.rows[0].ruta_relativa;
          const rutaCompleta = path.join(UPLOADS_DIR, rutaRelativa);

          // Borramos la entrada de la tabla 'archivos'
          // ON DELETE CASCADE se encargará de cualquier otra tabla que dependa de esta.
          await client.query('DELETE FROM archivos WHERE id = $1', [archivoId]);

          // Intentamos borrar el archivo físico del disco
          try {
            await fs.unlink(rutaCompleta);
          } catch (unlinkError: any) {
            if (unlinkError.code === 'ENOENT') {
              console.warn(`Se borró el registro de la BD, pero el archivo físico no se encontró en: ${rutaCompleta}`);
            } else {
              // Si falla por otra razón (ej. permisos), lanzamos el error para hacer rollback
              throw unlinkError;
            }
          }
           await client.query('COMMIT');
           return { mensaje: 'Imagen desvinculada y archivo huérfano eliminado con éxito.' };
        }
      }

      // Si llegamos aquí, el archivo no estaba huérfano.
      await client.query('COMMIT');
      return { mensaje: 'Imagen desvinculada con éxito. El archivo se mantiene porque está en uso por otros artículos.' };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error en la transacción al desvincular archivo, cambios revertidos:", error);
      throw error; // Lanzamos el error para que el controlador lo capture
    } finally {
      client.release();
    }
  }
}


// =================================================================
// 4. LÓGICA DE CONTROLADOR
// =================================================================

class ArchivoController {
  static async subirArchivo(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    try {
      const formData = await c.req.formData();
      const file = formData.get('archivo') as File | null;
      const refArticulo = formData.get('refArticulo') as string | null;

      if (!file) {
        return c.json({ error: 'No se proporcionó ningún archivo' }, 400);
      }
      if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: `El archivo excede el tamaño máximo de ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 413);
      }
      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        return c.json({ error: `Tipo de archivo no permitido. Permitidos: ${ALLOWED_MIME_TYPES.join(', ')}` }, 415);
      }
      
      const metadata = await ArchivoService.guardarArchivoLocal(file, user.userId, refArticulo);
      
      const mensaje = refArticulo 
        ? 'Archivo subido y asociado con éxito' 
        : 'Archivo subido con éxito (sin asociación)';
        
      return c.json({ mensaje, data: metadata }, 201);
    } catch (error: any) {
      console.error('Error al subir archivo:', error);
      // Código '23503' de PostgreSQL para foreign_key_violation
      if (error.code === '23503') { 
          return c.json({ error: 'La referencia del artículo proporcionada no existe.' }, 404);
      }
      const errorMessage = error instanceof Error ? error.message : 'Error interno al procesar el archivo';
      return c.json({ error: errorMessage }, 500);
    }
  }

  static async descargarArchivo(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'ID de archivo inválido' }, 400);

    try {
      const metadata = await ArchivoService.obtenerMetadataArchivo(id, user.userId);
      if (!metadata) return c.json({ error: 'Archivo no encontrado o acceso denegado' }, 404);

      const rutaAbsoluta = await ArchivoService.obtenerRutaAbsoluta(metadata.ruta_relativa);
      if (!rutaAbsoluta) {
        console.error(`Archivo con metadatos ID ${id} no encontrado en disco.`);
        return c.json({ error: 'Archivo físico no encontrado en el servidor' }, 404);
      }

      const nodeStream = createReadStream(rutaAbsoluta);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;

      c.header('Content-Type', metadata.mimetype);
      c.header('Content-Disposition', `attachment; filename="${metadata.nombre_original}"`);
      c.header('Content-Length', metadata.tamano_bytes.toString());

      return c.body(webStream);
    } catch (error: any) {
      console.error(`Error al descargar archivo ID ${id}:`, error);
      return c.json({ error: 'Error interno al descargar el archivo' }, 500);
    }
  }

  static async borrarArchivo(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'ID de archivo inválido' }, 400);

    try {
      await ArchivoService.borrarArchivoLocal(id, user.userId);
      return c.json({ mensaje: 'Archivo borrado con éxito' });
    } catch (error: any) {
      console.error(`Error al borrar archivo ID ${id}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Error interno al borrar el archivo';
      return c.json({ error: errorMessage }, 500);
    }
  }
}


// =================================================================
// 5. DEFINICIÓN Y EXPORTACIÓN DE RUTAS
// =================================================================

export const archivoRoutes = new Hono<{ Variables: Variables }>();

archivoRoutes.post('/archivos/subir', authMiddleware, ArchivoController.subirArchivo);
archivoRoutes.get('/archivos/:id/descargar', authMiddleware, ArchivoController.descargarArchivo);
archivoRoutes.delete('/archivos/:id', authMiddleware, ArchivoController.borrarArchivo);