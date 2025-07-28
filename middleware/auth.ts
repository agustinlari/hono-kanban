// src/middleware/auth.ts

import type { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, API_EXPORT_KEY } from '../config/env';
import type { Variables } from '../types';

// Usamos Context<{ Variables: Variables }> para que c.set('user', ...) 
// tenga el tipado correcto y sea consistente con las rutas.
export const authMiddleware = async (c: Context<{ Variables: Variables }>, next: Next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Token de autorización no proporcionado o con formato incorrecto' }, 401);
  }

  const token = authHeader.split(' ')[1];
  
  try {
    // El payload verificado ahora tendrá el rol
    const payload = jwt.verify(token, JWT_SECRET) as Variables['user'];
    c.set('user', payload);
    await next();
  } catch (err) {
    return c.json({ error: 'Token inválido o expirado' }, 401);
  }
};

// --- ¡NUEVA FUNCIÓN! ---
// Este es nuestro nuevo middleware de AUTORIZACIÓN.
// Es una "fábrica" que crea un middleware específico según los roles permitidos.
export const authorize = (allowedRoles: Array<'admin' | 'user'>) => {
  return async (c: Context<{ Variables: Variables }>, next: Next) => {
    const user = c.get('user');
    
    if (!user || !user.rol) {
      // Esto no debería pasar si authMiddleware se ejecutó primero, pero es una buena defensa.
      return c.json({ error: 'Forbidden: No se pudo identificar el rol del usuario.' }, 403);
    }
    
    if (allowedRoles.includes(user.rol as 'admin' | 'user')) {
      // ¡Permiso concedido! El usuario tiene un rol permitido.
      await next();
    } else {
      // ¡Permiso denegado!
      return c.json({ error: 'Forbidden: No tienes los permisos necesarios para realizar esta acción.' }, 403);
    }
  };
};

// ==================================================
// --- ¡NUEVO MIDDLEWARE! ---
// Middleware para Autenticación por Clave de API (para Excel)
// ==================================================
export const apiKeyAuthMiddleware = async (c: Context, next: Next) => {
  const apiKey = c.req.header('X-API-Key'); // La cabecera que buscará Excel

  if (!apiKey) {
    return c.json({ error: 'Falta la cabecera de autenticación X-API-Key.' }, 401);
  }

  // Comparamos la clave enviada con la que tenemos en nuestro entorno.
  // Es importante usar una comparación segura si te preocupa la seguridad al máximo,
  // pero para este caso, una comparación directa es suficiente.
  if (apiKey === API_EXPORT_KEY) {
    // La clave es correcta, permite que la petición continúe.
    await next();
  } else {
    // La clave es incorrecta, deniega el acceso.
    return c.json({ error: 'Clave de API inválida.' }, 403);
  }
};