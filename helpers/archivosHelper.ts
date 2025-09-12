// src/helpers/archivosHelper.ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';

// Importaciones necesarias de la lógica del servicio y controlador
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../config/database';
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

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB para permitir más tipos de archivos
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];


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
  is_thumbnail?: boolean;
}

export interface CardAttachment {
  id: number;
  card_id: string;
  archivo_id: number;
  is_thumbnail: boolean;
  created_at: Date;
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
    cardId: string | null = null,
    isThumbnail: boolean = false
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

      // Si se proporciona cardId, crear la asociación con la tarjeta
      if (cardId) {
        // Verificar que la tarjeta existe
        const cardCheck = await client.query('SELECT id FROM cards WHERE id = $1', [cardId]);
        if (cardCheck.rowCount === 0) {
          throw new Error('La tarjeta especificada no existe.');
        }

        const asociacionQuery = `
          INSERT INTO card_attachments (card_id, archivo_id, is_thumbnail)
          VALUES ($1, $2, $3)
        `;
        await client.query(asociacionQuery, [cardId, nuevoArchivo.id, isThumbnail]);

        // Si es un thumbnail, actualizar el image_url de la tarjeta
        if (isThumbnail) {
          // Usar la ruta configurada en nginx para kanban uploads
          const imageUrl = `/public/kanban-uploads/${nuevoArchivo.nombre_guardado}`;
          console.log(`Actualizando image_url de tarjeta ${cardId} con URL: ${imageUrl}`);
          
          const updateResult = await client.query(
            'UPDATE cards SET image_url = $1, updated_at = NOW() WHERE id = $2',
            [imageUrl, cardId]
          );
          
          console.log(`Filas afectadas al actualizar image_url: ${updateResult.rowCount}`);
          
          if (updateResult.rowCount === 0) {
            console.warn(`No se pudo actualizar image_url para la tarjeta ${cardId}`);
          }
        }
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

  /**
   * Elimina un thumbnail por su URL (elimina archivo físico + registro en BD)
   * Opción B: Mantener consistencia con la tabla archivos
   */
  static async eliminarThumbnailPorUrl(imageUrl: string): Promise<boolean> {
    console.log('🗑️ Eliminando thumbnail por URL:', imageUrl);
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Extraer el nombre del archivo de la URL
      // URLs como: /public/kanban-uploads/filename.jpg
      const urlParts = imageUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      
      if (!filename) {
        console.warn('No se pudo extraer el nombre del archivo de la URL:', imageUrl);
        await client.query('ROLLBACK');
        return false;
      }
      
      console.log('🔍 Buscando archivo en BD por nombre_guardado:', filename);
      
      // Buscar el archivo en la base de datos por nombre_guardado
      const archivoResult = await client.query(
        'SELECT id, ruta_relativa FROM archivos WHERE nombre_guardado = $1',
        [filename]
      );
      
      if (archivoResult.rows.length === 0) {
        console.warn('⚠️ No se encontró el archivo en la BD:', filename);
        // Intentar eliminar solo el archivo físico como fallback
        const rutaCompleta = path.join(UPLOADS_DIR, filename);
        try {
          await fs.unlink(rutaCompleta);
          console.log('✅ Archivo físico eliminado (sin registro en BD):', rutaCompleta);
        } catch (unlinkError: any) {
          if (unlinkError.code !== 'ENOENT') {
            console.error('💥 Error eliminando archivo físico:', unlinkError);
          }
        }
        await client.query('COMMIT');
        return true;
      }
      
      const archivo = archivoResult.rows[0];
      console.log('📄 Archivo encontrado en BD:', archivo);
      
      // Eliminar el archivo físico
      const rutaCompleta = path.join(UPLOADS_DIR, archivo.ruta_relativa);
      console.log('🗑️ Eliminando archivo físico:', rutaCompleta);
      
      try {
        await fs.unlink(rutaCompleta);
        console.log('✅ Archivo físico eliminado:', rutaCompleta);
      } catch (unlinkError: any) {
        if (unlinkError.code === 'ENOENT') {
          console.warn('⚠️ Archivo físico no encontrado en disco:', rutaCompleta);
        } else {
          console.error('💥 Error al eliminar archivo físico:', unlinkError);
          throw unlinkError;
        }
      }
      
      // Eliminar asociaciones en card_attachments (si existen)
      console.log('🗑️ Eliminando asociaciones en card_attachments para archivo ID:', archivo.id);
      const attachmentsResult = await client.query('DELETE FROM card_attachments WHERE archivo_id = $1', [archivo.id]);
      console.log('✅ Asociaciones eliminadas de card_attachments:', attachmentsResult.rowCount);
      
      // Eliminar el registro de la tabla archivos (esto se hace al final por las FK)
      console.log('🗑️ Eliminando registro de archivos, ID:', archivo.id);
      const deleteResult = await client.query('DELETE FROM archivos WHERE id = $1', [archivo.id]);
      console.log('✅ Registros eliminados de archivos:', deleteResult.rowCount);
      
      await client.query('COMMIT');
      console.log('🎉 Thumbnail eliminado completamente (archivo físico + card_attachments + archivos)');
      return true;
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('💥 Error procesando eliminación de thumbnail:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Añade este método DENTRO de la clase ArchivoService

  static async desvincularYLimpiarArchivoDeCard(cardId: string, archivoId: number): Promise<{ mensaje: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Paso 1: Obtener información sobre la asociación
      const attachmentInfo = await client.query(
        'SELECT is_thumbnail FROM card_attachments WHERE card_id = $1 AND archivo_id = $2',
        [cardId, archivoId]
      );

      if (attachmentInfo.rowCount === 0) {
        await client.query('ROLLBACK');
        return { mensaje: 'El archivo no estaba asociado a esta tarjeta.' };
      }

      const isThumbnail = attachmentInfo.rows[0].is_thumbnail;

      // Paso 2: Borrar la asociación específica
      await client.query(
        'DELETE FROM card_attachments WHERE card_id = $1 AND archivo_id = $2',
        [cardId, archivoId]
      );

      // Paso 3: Si era thumbnail, limpiar la URL de la tarjeta
      if (isThumbnail) {
        await client.query(
          'UPDATE cards SET image_url = NULL WHERE id = $1',
          [cardId]
        );
      }

      // Paso 4: Verificar si el archivo quedó huérfano
      const checkOrphanResult = await client.query(
        'SELECT COUNT(*) FROM card_attachments WHERE archivo_id = $1',
        [archivoId]
      );
      const associationsCount = parseInt(checkOrphanResult.rows[0].count, 10);

      // Paso 5: Si está huérfano, borrarlo por completo
      if (associationsCount === 0) {
        const fileMetaResult = await client.query(
          'SELECT ruta_relativa FROM archivos WHERE id = $1',
          [archivoId]
        );

        if (fileMetaResult.rows.length > 0) {
          const rutaRelativa = fileMetaResult.rows[0].ruta_relativa;
          const rutaCompleta = path.join(UPLOADS_DIR, rutaRelativa);

          await client.query('DELETE FROM archivos WHERE id = $1', [archivoId]);

          try {
            await fs.unlink(rutaCompleta);
          } catch (unlinkError: any) {
            if (unlinkError.code === 'ENOENT') {
              console.warn(`Se borró el registro de la BD, pero el archivo físico no se encontró en: ${rutaCompleta}`);
            } else {
              throw unlinkError;
            }
          }
           await client.query('COMMIT');
           return { mensaje: 'Archivo desvinculado y eliminado con éxito.' };
        }
      }

      await client.query('COMMIT');
      return { mensaje: 'Archivo desvinculado con éxito. El archivo se mantiene porque está en uso por otras tarjetas.' };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error en la transacción al desvincular archivo, cambios revertidos:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async obtenerArchivosDeCard(cardId: string): Promise<(ArchivoMetadata & CardAttachment)[]> {
    const query = `
      SELECT a.*, ca.is_thumbnail, ca.created_at as attachment_created_at
      FROM archivos a
      INNER JOIN card_attachments ca ON a.id = ca.archivo_id
      WHERE ca.card_id = $1
      ORDER BY ca.is_thumbnail DESC, ca.created_at ASC
    `;
    
    const result = await pool.query(query, [cardId]);
    return result.rows.map((row: any) => ({
      ...row,
      attachment_created_at: row.attachment_created_at
    }));
  }

  static async verificarEstadoCard(cardId: string): Promise<any> {
    console.log(`Verificando estado de la tarjeta: ${cardId}`);
    
    // Obtener info de la tarjeta
    const cardResult = await pool.query('SELECT id, title, image_url FROM cards WHERE id = $1', [cardId]);
    
    // Obtener attachments
    const attachmentsResult = await pool.query(`
      SELECT ca.*, a.nombre_original, a.mimetype 
      FROM card_attachments ca 
      JOIN archivos a ON ca.archivo_id = a.id 
      WHERE ca.card_id = $1
    `, [cardId]);
    
    const estado = {
      tarjeta: cardResult.rows[0] || null,
      attachments: attachmentsResult.rows,
      thumbnails: attachmentsResult.rows.filter((a: any) => a.is_thumbnail)
    };
    
    console.log('Estado de la tarjeta:', JSON.stringify(estado, null, 2));
    return estado;
  }

  static async migrarUrlsImagenes(): Promise<{ migradas: number; errores: number }> {
    console.log('🔄 Iniciando migración de URLs de imágenes...');
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Obtener todas las tarjetas con image_url que usen el patrón antiguo
      const query = `
        SELECT c.id as card_id, c.image_url, a.nombre_guardado
        FROM cards c
        INNER JOIN card_attachments ca ON c.id = ca.card_id AND ca.is_thumbnail = true
        INNER JOIN archivos a ON ca.archivo_id = a.id
        WHERE c.image_url LIKE '/archivos/%/descargar'
      `;
      
      const result = await client.query(query);
      const uploadsFolderName = path.basename(UPLOADS_DIR);
      
      let migradas = 0;
      let errores = 0;

      for (const row of result.rows) {
        try {
          const nuevaUrl = `/public/kanban-uploads/${row.nombre_guardado}`;
          
          await client.query(
            'UPDATE cards SET image_url = $1 WHERE id = $2',
            [nuevaUrl, row.card_id]
          );
          
          console.log(`✅ Migrada: ${row.card_id} -> ${nuevaUrl}`);
          migradas++;
        } catch (error) {
          console.error(`❌ Error migrando ${row.card_id}:`, error);
          errores++;
        }
      }

      await client.query('COMMIT');
      console.log(`🎉 Migración completada: ${migradas} exitosas, ${errores} errores`);
      
      return { migradas, errores };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('💥 Error en migración:', error);
      throw error;
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
      const cardId = formData.get('cardId') as string | null;
      const isThumbnail = formData.get('isThumbnail') === 'true';

      if (!file) {
        return c.json({ error: 'No se proporcionó ningún archivo' }, 400);
      }
      if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: `El archivo excede el tamaño máximo de ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 413);
      }
      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        return c.json({ error: `Tipo de archivo no permitido. Permitidos: ${ALLOWED_MIME_TYPES.join(', ')}` }, 415);
      }
      
      // Si se marca como thumbnail, debe ser una imagen
      if (isThumbnail && !IMAGE_MIME_TYPES.includes(file.type)) {
        return c.json({ error: 'Los thumbnails deben ser archivos de imagen' }, 400);
      }
      
      console.log(`Subiendo archivo: ${file.name}, cardId: ${cardId}, isThumbnail: ${isThumbnail}`);
      
      const metadata = await ArchivoService.guardarArchivoLocal(file, user.userId, cardId, isThumbnail);
      
      let mensaje = 'Archivo subido con éxito';
      if (cardId) {
        mensaje = isThumbnail 
          ? 'Thumbnail subido y asociado con éxito' 
          : 'Archivo subido y asociado con éxito';
      }
        
      return c.json({ mensaje, data: metadata }, 201);
    } catch (error: any) {
      console.error('Error al subir archivo:', error);
      if (error.code === '23503') { 
          return c.json({ error: 'La tarjeta proporcionada no existe.' }, 404);
      }
      if (error.message === 'La tarjeta especificada no existe.') {
        return c.json({ error: error.message }, 404);
      }
      const errorMessage = error instanceof Error ? error.message : 'Error interno al procesar el archivo';
      return c.json({ error: errorMessage }, 500);
    }
  }

  static async obtenerArchivosCard(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    if (!cardId) return c.json({ error: 'ID de tarjeta requerido' }, 400);

    try {
      const archivos = await ArchivoService.obtenerArchivosDeCard(cardId);
      return c.json({ archivos });
    } catch (error: any) {
      console.error(`Error al obtener archivos de la tarjeta ${cardId}:`, error);
      return c.json({ error: 'Error interno al obtener los archivos' }, 500);
    }
  }

  static async desvincularArchivoDeCard(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    const archivoId = parseInt(c.req.param('archivoId'));
    
    if (!cardId || isNaN(archivoId)) {
      return c.json({ error: 'ID de tarjeta y archivo requeridos' }, 400);
    }

    try {
      const resultado = await ArchivoService.desvincularYLimpiarArchivoDeCard(cardId, archivoId);
      return c.json(resultado);
    } catch (error: any) {
      console.error(`Error al desvincular archivo ${archivoId} de tarjeta ${cardId}:`, error);
      return c.json({ error: 'Error interno al desvincular el archivo' }, 500);
    }
  }

  static async verificarEstadoCard(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    if (!cardId) return c.json({ error: 'ID de tarjeta requerido' }, 400);

    try {
      const estado = await ArchivoService.verificarEstadoCard(cardId);
      return c.json(estado);
    } catch (error: any) {
      console.error(`Error al verificar estado de tarjeta ${cardId}:`, error);
      return c.json({ error: 'Error interno al verificar el estado' }, 500);
    }
  }

  static async migrarUrls(c: Context) {
    const user = c.get('user');
    
    // Para el endpoint público temporal, saltarse la verificación de admin
    const isPublicEndpoint = c.req.path.includes('migrar-urls-publico');
    
    if (!isPublicEndpoint) {
      // Solo permitir a administradores ejecutar la migración en el endpoint protegido
      if (!user || user.rol !== 'admin') {
        return c.json({ error: 'Solo administradores pueden ejecutar migraciones' }, 403);
      }
    }

    try {
      const resultado = await ArchivoService.migrarUrlsImagenes();
      return c.json({
        mensaje: 'Migración completada',
        ...resultado
      });
    } catch (error: any) {
      console.error('Error en migración de URLs:', error);
      return c.json({ error: 'Error al ejecutar la migración' }, 500);
    }
  }

  static async descargarArchivo(c: Context) {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'ID de archivo inválido' }, 400);

    try {
      // Primero verificar si el archivo está asociado a alguna tarjeta (acceso público)
      const cardAssociationQuery = `
        SELECT COUNT(*) as count 
        FROM card_attachments 
        WHERE archivo_id = $1
      `;
      const cardAssociation = await pool.query(cardAssociationQuery, [id]);
      const isCardAttachment = parseInt(cardAssociation.rows[0].count) > 0;

      let metadata;
      if (isCardAttachment) {
        // Si está asociado a una tarjeta, permitir acceso público (sin autenticación)
        const metadataQuery = 'SELECT * FROM archivos WHERE id = $1';
        const result = await pool.query(metadataQuery, [id]);
        metadata = result.rows[0] || null;
      } else {
        // Si no está asociado a tarjetas, requerir autenticación
        const user = c.get('user');
        if (!user) return c.json({ error: 'No autorizado' }, 401);
        metadata = await ArchivoService.obtenerMetadataArchivo(id, user.userId);
      }

      if (!metadata) return c.json({ error: 'Archivo no encontrado o acceso denegado' }, 404);

      const rutaAbsoluta = await ArchivoService.obtenerRutaAbsoluta(metadata.ruta_relativa);
      if (!rutaAbsoluta) {
        console.error(`Archivo con metadatos ID ${id} no encontrado en disco.`);
        return c.json({ error: 'Archivo físico no encontrado en el servidor' }, 404);
      }

      const nodeStream = createReadStream(rutaAbsoluta);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;

      c.header('Content-Type', metadata.mimetype);
      
      // Para imágenes de tarjetas, mostrar inline en lugar de forzar descarga
      if (isCardAttachment && metadata.mimetype.startsWith('image/')) {
        c.header('Content-Disposition', `inline; filename="${metadata.nombre_original}"`);
      } else {
        c.header('Content-Disposition', `attachment; filename="${metadata.nombre_original}"`);
      }
      
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

  static async eliminarThumbnailPorUrl(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    const cardId = c.req.param('cardId');
    if (!cardId) return c.json({ error: 'ID de tarjeta requerido' }, 400);

    try {
      const { image_url } = await c.req.json();
      if (!image_url) {
        return c.json({ error: 'image_url es requerido' }, 400);
      }

      console.log(`🗑️ Eliminando thumbnail de tarjeta ${cardId}:`, image_url);
      
      // Eliminar el archivo físico
      const eliminado = await ArchivoService.eliminarThumbnailPorUrl(image_url);
      
      if (eliminado) {
        return c.json({ mensaje: 'Thumbnail eliminado exitosamente' });
      } else {
        return c.json({ error: 'No se pudo eliminar el thumbnail' }, 500);
      }
    } catch (error: any) {
      console.error(`Error al eliminar thumbnail de tarjeta ${cardId}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Error interno al eliminar el thumbnail';
      return c.json({ error: errorMessage }, 500);
    }
  }
}


// =================================================================
// 5. DEFINICIÓN Y EXPORTACIÓN DE RUTAS
// =================================================================

export const archivoRoutes = new Hono<{ Variables: Variables }>();

archivoRoutes.post('/archivos/subir', keycloakAuthMiddleware, ArchivoController.subirArchivo);
archivoRoutes.get('/archivos/:id/descargar', ArchivoController.descargarArchivo); // Sin authMiddleware para permitir acceso público a imágenes de tarjetas
archivoRoutes.delete('/archivos/:id', keycloakAuthMiddleware, ArchivoController.borrarArchivo);

// Rutas específicas para tarjetas
archivoRoutes.get('/cards/:cardId/archivos', keycloakAuthMiddleware, ArchivoController.obtenerArchivosCard);
archivoRoutes.delete('/cards/:cardId/archivos/:archivoId', keycloakAuthMiddleware, ArchivoController.desvincularArchivoDeCard);
archivoRoutes.delete('/cards/:cardId/thumbnail', keycloakAuthMiddleware, ArchivoController.eliminarThumbnailPorUrl);
archivoRoutes.get('/cards/:cardId/estado', keycloakAuthMiddleware, ArchivoController.verificarEstadoCard);

// Ruta temporal para migrar URLs existentes (solo admin)
archivoRoutes.post('/archivos/migrar-urls', keycloakAuthMiddleware, ArchivoController.migrarUrls);

// Ruta temporal PÚBLICA para migración de emergencia (ELIMINAR después de usar)
archivoRoutes.post('/archivos/migrar-urls-publico', ArchivoController.migrarUrls);