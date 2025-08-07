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

// CORS deshabilitado - Se maneja en nginx
// app.use('/public/*', cors({...}));
// app.use('*', cors({...}));
console.log("CORS deshabilitado - Se maneja en nginx.");

//Montar todas las rutas
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