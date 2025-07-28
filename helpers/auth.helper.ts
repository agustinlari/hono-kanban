// helpers/auth.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Importaciones de configuración y del middleware
import { pool } from '../config/database'; 
import { JWT_SECRET } from '../config/env';
import { authMiddleware } from '../middleware/auth'; // <--- ¡AQUÍ ESTÁ LA MAGIA!
import type { User, RegisterRequest, LoginRequest, Variables } from '../types';

// ================================
// Lógica de Servicio (AuthService)
// ================================
class AuthService {
  static async registerUser(data: RegisterRequest): Promise<void> {
    const { email, password } = data;
    const hash = await bcrypt.hash(password, 10);
    
    // Al registrar, el rol por defecto será 'user' gracias al DEFAULT de la BBDD.
    await pool.query(
      'INSERT INTO usuarios (email, password_hash) VALUES ($1, $2)', 
      [email, hash]
    );
  }

  static async loginUser(data: LoginRequest): Promise<string> {
    const { email, password } = data;
    
    // --- CAMBIO ---: Aseguramos que la consulta trae el rol.
    const result = await pool.query('SELECT id, email, password_hash, rol FROM usuarios WHERE email = $1', [email]);
    const user = result.rows[0] as User | undefined;
    
    if (!user) {
      throw new Error('Usuario no encontrado');
    }
    
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new Error('Contraseña incorrecta');
    }
    
    // --- CAMBIO CRÍTICO ---: Añadimos 'rol' al payload del token.
    const token = jwt.sign(
      { userId: user.id, email: user.email, rol: user.rol }, 
      JWT_SECRET, 
      { expiresIn: '1h' } // Recomendación: usa un tiempo de expiración más largo, como '1d' o '7d'
    );
    
    return token;
  }
}

// ================================
// Lógica de Controlador (AuthController)
// ================================
class AuthController {
  static async register(c: Context) {
    try {
      const data: RegisterRequest = await c.req.json();
      
      if (!data.email || !data.password) {
        return c.json({ error: 'Email y contraseña son requeridos' }, 400);
      }
      
      await AuthService.registerUser(data);
      return c.json({ mensaje: 'Usuario registrado con éxito' }, 201);
      
    } catch (err: any) {
      if (err.code === '23505') { 
        return c.json({ error: 'El email ya está registrado' }, 409);
      }
      
      console.error('Error en registro:', err);
      return c.json({ error: 'No se pudo registrar el usuario' }, 500);
    }
  }

  static async login(c: Context) {
    try {
      const data: LoginRequest = await c.req.json();
      
      if (!data.email || !data.password) {
        return c.json({ error: 'Email y contraseña son requeridos' }, 400);
      }
      
      const token = await AuthService.loginUser(data);
      return c.json({ token });
      
    } catch (err: any) {
      if (err.message === 'Usuario no encontrado' || err.message === 'Contraseña incorrecta') {
        return c.json({ error: 'Credenciales inválidas' }, 401);
      }
      
      console.error('Error en login:', err);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  static async profile(c: Context<{ Variables: Variables }>) {
    const user = c.get('user');
    return c.json({ 
      mensaje: `Bienvenido a tu perfil, ${user.email}`,
      datosUsuario: user 
    });
  }
}

// ================================
// Definición de Rutas de Autenticación
// ================================
export const authRoutes = new Hono<{ Variables: Variables }>();

authRoutes.post('/register', AuthController.register);
authRoutes.post('/login', AuthController.login);
// Se usa el middleware importado
authRoutes.get('/perfil', authMiddleware, AuthController.profile);