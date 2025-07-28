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

// --- Middleware para servir imágenes ---
// Esta es la única línea necesaria para serveStatic.
// Mapea la URL /public/{nombre_de_la_carpeta} a la ubicación física exacta.
routes.use(`/public/${uploadsFolderName}/*`, serveStatic({
  root: path.dirname(UPLOADS_DIR),
}));

// --- Montar todas las rutas modulares de la API ---
routes.route('/', authRoutes);
routes.route('/', archivoRoutes);
routes.route('/api', boardRoutes);