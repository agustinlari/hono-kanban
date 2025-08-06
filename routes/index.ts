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
import { assignmentRoutes } from '../helpers/assignments.helper';

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

// Los archivos estáticos ahora son servidos directamente por nginx
// No necesitamos handlers personalizados en Hono para /public/uploads/

// Test endpoint para verificar CORS
routes.get('/test-cors', (c) => {
  return c.json({ message: 'CORS test successful', timestamp: new Date().toISOString() });
});

// --- Montar todas las rutas modulares de la API ---
routes.route('/', authRoutes);
routes.route('/', archivoRoutes);
routes.route('/', boardRoutes);
routes.route('/', listRoutes);
routes.route('/', cardRoutes);
routes.route('/', labelRoutes);
routes.route('/', permissionRoutes);
routes.route('/', assignmentRoutes);