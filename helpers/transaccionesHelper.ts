// /helpers/transaccionesHelper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { authMiddleware, authorize } from '../middleware/auth';
import type { Variables } from '../types'; 

// ================================
// Types: Definiciones de Transacciones
// ================================
export interface Transaccion {
  id: number;
  TipoTransaccion: string;
  refArticulo: string;
  Cantidad: number;
  Fecha: Date;
  // --- INICIO DE CAMBIOS ---
  usuario: string;        // AÑADIDO: Nueva columna para el nombre de usuario.
  totaldespues: number;   // AÑADIDO: Nueva columna para el total después de la transacción.
  // --- FIN DE CAMBIOS ---
}

export interface TransaccionesPaginadasRequest {
  cantidad: number;
  fechaInicio: string;
  fechaFinal: string;
  offset: number;
  texto?: string | null;
}

export interface TransaccionesPaginadasResponse {
  resultados: Transaccion[];
  total: number;
}

// ================================
// Helper: validationUtils (función esFechaValida)
// ================================
export function esFechaValida(fecha: any): fecha is string {
  if (typeof fecha !== 'string') return false;
  return !isNaN(Date.parse(fecha));
}

// ================================
// Service: TransaccionesService
// ================================
class TransaccionesService {
  static async getTransaccionesPaginadas(
    params: TransaccionesPaginadasRequest
  ): Promise<TransaccionesPaginadasResponse> {
    const { cantidad, fechaInicio, fechaFinal, offset, texto } = params;

    const queryParams: any[] = [fechaInicio, fechaFinal];
    let queryParamsCount = queryParams.length;

    let baseQuery = `
      FROM "Transacciones"
      WHERE "Fecha" >= $1 AND "Fecha" <= $2
    `;
    
    let filterQuery = '';
    if (texto && texto.trim() !== '') {
      queryParams.push(`%${texto.trim()}%`);
      queryParamsCount++;
      filterQuery = ` AND "refArticulo" ILIKE $${queryParamsCount}`;
    }

    const countQueryStr = `SELECT COUNT(*) as total ${baseQuery} ${filterQuery}`;
    
    // --- INICIO DE CAMBIOS ---
    // AÑADIMOS "usuario" y "totaldespues" a la lista de campos a seleccionar.
    // Es importante usar las comillas dobles si tus nombres de columna en PostgreSQL son sensibles a mayúsculas/minúsculas.
    const dataQueryStr = `
      SELECT id, "TipoTransaccion", "refArticulo", "Cantidad", "Fecha", "usuario", "totaldespues"
      ${baseQuery}
      ${filterQuery}
      ORDER BY "Fecha" DESC
      LIMIT $${queryParamsCount + 1} OFFSET $${queryParamsCount + 2}
    `;
    // --- FIN DE CAMBIOS ---

    const client = await pool.connect();
    try {
      const totalResult = await client.query(countQueryStr, queryParams);
      const total = parseInt(totalResult.rows[0].total, 10);

      const dataResult = await client.query(dataQueryStr, [...queryParams, cantidad, offset]);
      
      // --- INICIO DE CAMBIOS ---
      // El mapeo ahora incluirá los nuevos campos.
      // El operador "..." (spread) copia automáticamente "usuario".
      // Para "totaldespues", es una buena práctica convertirlo explícitamente a número,
      // ya que el tipo 'numeric' de PostgreSQL a veces se devuelve como string para mantener la precisión.
      const resultados: Transaccion[] = dataResult.rows.map(row => ({
        ...row,
        Fecha: new Date(row.Fecha), 
        totaldespues: parseFloat(row.totaldespues) // Aseguramos que sea un número.
      }));
      // --- FIN DE CAMBIOS ---
      
      return { resultados, total };

    } finally {
      client.release();
    }
  }
}

// ================================
// Controller: TransaccionesController
// (No se necesitan cambios en el controlador)
// ================================
class TransaccionesController {
  static async getTransaccionesPaginadas(c: Context) {
    console.log("Petición POST recibida en /transacciones-paginadas");
    try {
      const body = await c.req.json() as TransaccionesPaginadasRequest;
      const { cantidad, fechaInicio, fechaFinal, offset, texto } = body;

      if (typeof cantidad !== 'number' || cantidad <= 0 || cantidad > 100) {
        return c.json({ error: "El parámetro 'cantidad' debe ser un número positivo (1-100)." }, 400);
      }
      if (typeof offset !== 'number' || offset < 0) {
        return c.json({ error: "El parámetro 'offset' debe ser un número no negativo." }, 400);
      }
      if (!esFechaValida(fechaInicio) || !esFechaValida(fechaFinal)) {
        return c.json({ error: "Las fechas 'fechaInicio' o 'fechaFinal' no son válidas, faltan o no son strings." }, 400);
      }
      if (new Date(fechaInicio) > new Date(fechaFinal)) {
        return c.json({ error: "'fechaInicio' no puede ser posterior a 'fechaFinal'." }, 400);
      }
      if (texto !== undefined && texto !== null && typeof texto !== 'string') {
        return c.json({ error: "El parámetro 'texto' debe ser un string o null/undefined." }, 400);
      }
      
      const resultado = await TransaccionesService.getTransaccionesPaginadas({
        cantidad,
        fechaInicio,
        fechaFinal,
        offset,
        texto
      });
      
      console.log(`TransaccionesPaginadas: Datos recuperados: ${resultado.resultados.length} filas, total: ${resultado.total}`);
      return c.json(resultado);

    } catch (error: any) {
      console.error('TransaccionesPaginadas: Error general:', error);
      if (error instanceof SyntaxError) {
        return c.json({ error: 'Error al parsear el cuerpo de la petición: no es un JSON válido.' }, 400);
      }
      if (error.message.includes("El parámetro") || error.message.includes("Las fechas")) {
        return c.json({ error: error.message }, 400);
      }
      if (error.code) { 
        return c.json({ error: `Error de base de datos: ${error.message}` }, 500);
      }
      return c.json({ error: error.message || 'Error interno del servidor.' }, 500);
    }
  }
}

// ================================
// Routes: transaccionesRoutes
// (No se necesitan cambios en las rutas)
// ================================
export const transaccionesRoutes = new Hono<{ Variables: Variables }>();

transaccionesRoutes.post(
    '/transacciones-paginadas', 
    authMiddleware, 
    authorize(['admin']), // <-- ¡ESTE ES EL CAMBIO CLAVE!
    TransaccionesController.getTransaccionesPaginadas
);