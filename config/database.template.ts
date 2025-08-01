 // ================================
// src/config/database.ts
// ================================
import dotenv from 'dotenv';
dotenv.config();
import { Pool } from 'pg';

export const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'nombreDDBB',
  password: process.env.DB_PASSWORD || 'contraseñaDDBB',
  port: parseInt(process.env.DB_PORT || '5432'),
});