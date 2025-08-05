// ================================
// src/routes/index.ts 
// ================================
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'path'; // Importa 'path'
import type { Variables } from '../types';

// Importa todos tus helpers de rutas
import { authRoutes } from '../helpers/auth.helper';
import { archivoRoutes } from '../helpers/archivosHelper';
import { boardRoutes } from '../helpers/boards.helper';
import { listRoutes } from '../helpers/lists.helper';
import { cardRoutes } from '../helpers/cards.helper';
import { labelRoutes } from '../helpers/labels.helper';
import { permissionRoutes } from '../helpers/permissions.helper';

// Importa la constante de la ruta de uploads desde el helper de archivos
import { UPLOADS_DIR } from '../helpers/archivosHelper'; 

// --- Configuración para servir archivos estáticos ---
// Obtiene el nombre de la carpeta de subidas (ej: "uploads")
const uploadsFolderName = path.basename(UPLOADS_DIR); 

// Crea la instancia principal del enrutador
export const routes = new Hono<{ Variables: Variables }>();


// --- Rutas ---

// Ruta básica
routes.get('/', (c) => {
  console.log("Petición recibida en /");
  return c.text('¡Hola Mundo con Hono!');
});

// --- Servir imágenes con CORS personalizado ---
// En lugar de usar serveStatic que puede tener problemas con CORS,
// creamos un handler personalizado que sirve los archivos con CORS correcto
routes.get(`/public/${uploadsFolderName}/*`, async (c) => {
  try {
    // Extraer el nombre del archivo de la URL
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const filename = pathname.split('/').pop(); // Obtener solo el nombre del archivo
    
    if (!filename) {
      return c.json({ error: 'Archivo no especificado' }, 400);
    }
    
    // Construir la ruta completa del archivo
    const filePath = path.join(UPLOADS_DIR, filename);
    
    // Verificar que el archivo existe
    const fs = await import('fs/promises');
    try {
      await fs.access(filePath);
    } catch {
      return c.json({ error: 'Archivo no encontrado' }, 404);
    }
    
    // Leer el archivo
    const fileBuffer = await fs.readFile(filePath);
    
    // Determinar el tipo MIME basado en la extensión
    const ext = path.extname(filename).toLowerCase();
    let mimeType = 'application/octet-stream';
    
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    };
    
    if (mimeTypes[ext]) {
      mimeType = mimeTypes[ext];
    }
    
    // Establecer headers de contenido (CORS ya manejado por middleware)
    c.header('Content-Type', mimeType);
    c.header('Cache-Control', 'public, max-age=31536000'); // Cache por 1 año
    
    return c.body(fileBuffer);
    
  } catch (error) {
    console.error('Error sirviendo archivo estático:', error);
    return c.json({ error: 'Error interno del servidor' }, 500);
  }
});

// Test endpoint para verificar CORS
routes.get('/test-cors', (c) => {
  return c.json({ message: 'CORS test successful', timestamp: new Date().toISOString() });
});

// OPTIONS ya manejado por el middleware de CORS en index.ts

// --- Montar todas las rutas modulares de la API ---
routes.route('/', authRoutes);
routes.route('/', archivoRoutes);
routes.route('/', boardRoutes);
routes.route('/', listRoutes);
routes.route('/', cardRoutes);
routes.route('/', labelRoutes);
routes.route('/', permissionRoutes);