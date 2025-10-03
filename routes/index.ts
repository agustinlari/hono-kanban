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
import { keycloakAuthRoutes } from '../helpers/keycloak-auth.helper';
import { obrasRoutes } from '../helpers/obras.helper';
import { wallpaperRoutes } from '../helpers/wallpapers.helper';
import { projectsRoutes } from '../helpers/projects.helper';
import { checklistsRoutes } from '../helpers/checklists.helper';

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
// (El debug middleware se movió después para no interferir con CORS)
routes.use('*', (c, next) => {
  console.log('📋 [Routes] Petición recibida:', c.req.method, c.req.url);
  console.log('📋 [Routes] Origin:', c.req.header('Origin'));
  return next();
});

// Servir archivos estáticos de wallpapers ANTES de las rutas autenticadas
routes.use('/wallpapers/*', serveStatic({
  root: './',
  rewriteRequestPath: (path) => path.replace(/^\/wallpapers/, '/wallpapers')
}));

// IMPORTANTE: keycloakAuthRoutes PRIMERO para evitar conflictos de rutas
routes.route('/', keycloakAuthRoutes);
routes.route('/', authRoutes);
routes.route('/', archivoRoutes);
routes.route('/', boardRoutes);
routes.route('/', listRoutes);
routes.route('/', cardRoutes);
routes.route('/', labelRoutes);
routes.route('/', permissionRoutes);
routes.route('/', assignmentRoutes);
routes.route('/', obrasRoutes);
routes.route('/', wallpaperRoutes);
routes.route('/', projectsRoutes);
routes.route('/', checklistsRoutes);