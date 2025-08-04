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

// Middleware de CORS Global (ajusta 'origin' y 'allowHeaders' según tus necesidades)
app.use('*', cors({
  origin: '*', // O un array de orígenes permitidos: ['http://localhost:3001', 'https://tufrontend.com']
  allowHeaders: [
    'Authorization', 
    'X-Client-Info', 
    'Apikey', 
    'Content-Type',
    'Cache-Control',
    'Pragma',
    'Expires'
  ], 
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  maxAge: 86400, // Cache preflight requests por 1 día
  credentials: true, // Si necesitas enviar cookies o Authorization header con credenciales
}));
console.log("Middleware CORS configurado globalmente.");

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