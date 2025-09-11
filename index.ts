// ================================
// src/index.ts (ARCHIVO PRINCIPAL)
// ================================
import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors'; // Importar CORS
import { routes } from './routes';
import { PORT } from './config/env';
import type { Variables } from './types';


console.log("Iniciando script index.ts...");

const app = new Hono<{ Variables: Variables }>();
console.log("Instancia de Hono creada.");

// CORS habilitado para todos los endpoints (nginx ya maneja /api/kanban)
app.use('/*', cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:4173', 'https://aplicaciones.osmos.es'],
  credentials: false,
  exposeHeaders: ['*'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

console.log("CORS habilitado para endpoints de autenticación.");

//Montar todas las rutas directamente (nginx ya elimina /api/kanban)
app.route('/', routes);
console.log(`Configurando para el puerto: ${PORT}`);
console.log("A punto de llamar a serve()...");

serve({
  fetch: app.fetch,
  port: PORT,
}, (info) => {
  console.log(`Servidor corriendo en http://localhost:${info.port}`);
});

export default app;