// src/helpers/sqlExecutor.ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; // Ajusta la ruta si es necesario
import { authMiddleware, authorize } from '../middleware/auth';
import type { Variables } from '../types'; // Asumiendo que Variables está en src/types/index.ts o similar

// ================================
// TYPES
// ================================
export interface SqlExecuteRequest {
  sql: string;
  params?: any[]; // Parámetros opcionales para la consulta
}

export interface SqlExecuteResponse {
  success: boolean;
  message?: string;
  data?: any[]; // Para resultados de SELECT
  rowCount?: number | null; // Para INSERT, UPDATE, DELETE
  error?: string;
  command?: string; // El tipo de comando SQL ejecutado (SELECT, INSERT, etc.)
}

// ================================
// SERVICE LOGIC (Database Interaction)
// ================================
async function executeQueryInDatabase(request: SqlExecuteRequest): Promise<SqlExecuteResponse> {
  const { sql, params } = request;

  if (!sql || typeof sql !== 'string' || sql.trim() === '') {
    return { success: false, error: "La consulta SQL no puede estar vacía." };
  }

  const client = await pool.connect();
  try {
    // ¡ADVERTENCIA IMPORTANTE DE SEGURIDAD!
    // Ejecutar SQL directamente del cliente es inherentemente arriesgado.
    // Asegúrate de que este endpoint esté extremadamente bien protegido
    // y solo accesible por usuarios de confianza absoluta.
    console.log(`Ejecutando SQL: ${sql}`);
    if (params) {
      console.log(`Con parámetros: ${JSON.stringify(params)}`);
    }

    const result = await client.query(sql, params || []);
    
    let response: SqlExecuteResponse = {
      success: true,
      command: result.command,
      rowCount: result.rowCount,
    };

    if (result.command === 'SELECT' && result.rows) {
      response.data = result.rows;
      response.message = `Consulta SELECT ejecutada exitosamente. Filas devueltas: ${result.rows.length}.`;
    } else if (result.command && ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'].includes(result.command.toUpperCase())) {
      response.message = `Comando ${result.command} ejecutado exitosamente. Filas afectadas: ${result.rowCount || 0}.`;
    } else {
      response.message = `Comando ejecutado. Tipo: ${result.command}, Filas afectadas: ${result.rowCount}.`;
    }
    
    return response;

  } catch (error: any) {
    console.error('Error al ejecutar la consulta SQL:', error);
    return {
      success: false,
      error: `Error de base de datos: ${error.message}`,
    };
  } finally {
    client.release();
  }
}

// ================================
// CONTROLLER LOGIC (Hono Handler)
// ================================
async function handleSqlExecute(c: Context<{ Variables: Variables }>) {
  console.log("Petición POST recibida en /admin/sql/execute (desde helper)");
  try {
    const body = await c.req.json<SqlExecuteRequest>();
    
    if (!body.sql || typeof body.sql !== 'string' || body.sql.trim() === '') {
      return c.json({ success: false, error: "El cuerpo de la petición debe contener una propiedad 'sql' con la consulta." }, 400);
    }
    if (body.params && !Array.isArray(body.params)) {
      return c.json({ success: false, error: "Si se proveen 'params', debe ser un array." }, 400);
    }

    const resultado = await executeQueryInDatabase(body);

    if (!resultado.success) {
      return c.json(resultado, resultado.error?.includes("vacía") || resultado.error?.includes("parámetro") ? 400 : 500);
    }
    
    console.log(`SQL ejecutado (helper): ${resultado.command}, Filas: ${resultado.rowCount ?? resultado.data?.length}`);
    return c.json(resultado);

  } catch (error: any) {
    console.error('SQL Executor Helper: Error general:', error);
    if (error instanceof SyntaxError) {
      return c.json({ success: false, error: 'Error al parsear el cuerpo de la petición: no es un JSON válido.' }, 400);
    }
    return c.json({ success: false, error: error.message || 'Error interno del servidor.' }, 500);
  }
}

// ================================
// ROUTES EXPORT
// ================================
export const sqlExecutorHelperRoutes = new Hono<{ Variables: Variables }>();

// Ruta protegida para ejecutar SQL. ¡USA CON EXTREMA PRECAUCIÓN!
// Solo accesible por administradores o roles de confianza.
sqlExecutorHelperRoutes.post('/execute', authMiddleware, authorize(['admin']), handleSqlExecute);

// Podrías añadir más rutas relacionadas con este helper aquí si fuera necesario
// sqlExecutorHelperRoutes.put('/execute-script', authMiddleware, handleSqlExecute); // Ejemplo