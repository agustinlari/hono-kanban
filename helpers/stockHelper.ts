// /helpers/stockHelper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { authMiddleware, authorize } from '../middleware/auth'; 
import type { Variables } from '../types';

// --- TYPES (originalmente en types/stock.ts) ---
export type TipoOperacionStock = "Retirar" | "Ingresar" | "Reservar" | "Liberar";

export interface GestionaStockRequest {
  refArticulo: string;
  cantidad: number;
  tipo_operacion: TipoOperacionStock;
  // --- MODIFICACIÓN ---: Se añade el usuario al request del servicio
  usuario: string;
}

export interface InventarioStockInfo {
  totales: number;
  reservadas: number;
}

// --- SERVICE (originalmente en services/StockService.ts) ---
export class StockService {
  // --- MODIFICACIÓN ---: La firma del método ahora usa la interfaz actualizada
  static async gestionarStock(params: GestionaStockRequest): Promise<{ mensaje: string; detalleError?: string }> {
    // --- MODIFICACIÓN ---: Extraemos el usuario de los parámetros
    const { refArticulo, cantidad, tipo_operacion, usuario } = params;
    const cantidadNum = Number(cantidad);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Obtener y bloquear el artículo del inventario
      const inventarioResult = await client.query(
        'SELECT totales, reservadas FROM "Inventario" WHERE "refArticulo" = $1 FOR UPDATE',
        [refArticulo]
      );

      if (inventarioResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('Artículo no encontrado');
      }

      const inventario: InventarioStockInfo = inventarioResult.rows[0];
      let totales = Number(inventario.totales);
      let reservadas = Number(inventario.reservadas);
      const disponibles = totales - reservadas;

      let nuevo_total = totales;
      let nueva_reservada = reservadas;

      switch (tipo_operacion) {
        case "Retirar":
          if (disponibles < cantidadNum) {
            await client.query('ROLLBACK');
            throw new Error("No hay suficiente stock disponible para retirar");
          }
          nuevo_total -= cantidadNum;
          break;
        case "Ingresar":
          nuevo_total += cantidadNum;
          break;
        case "Reservar":
          if (disponibles < cantidadNum) {
            await client.query('ROLLBACK');
            throw new Error("No hay suficiente stock disponible para reservar");
          }
          nueva_reservada += cantidadNum;
          break;
        case "Liberar":
          if (reservadas < cantidadNum) {
            await client.query('ROLLBACK');
            throw new Error("No se pueden liberar más unidades de las reservadas");
          }
          nueva_reservada -= cantidadNum;
          break;
        default:
          await client.query('ROLLBACK');
          throw new Error("Tipo de operación no válido");
      }

      // 2. Actualizar Inventario
      await client.query(
        'UPDATE "Inventario" SET totales = $1, reservadas = $2 WHERE "refArticulo" = $3',
        [nuevo_total, nueva_reservada, refArticulo]
      );

      // 3. Registrar en Transacciones
      try {
        // --- MODIFICACIÓN ---: Se actualiza la sentencia INSERT y los parámetros
        // Se añaden los campos "usuario" y "totaldespues"
        // El valor de 'totaldespues' es la variable 'nuevo_total' que ya hemos calculado.
        await client.query(
          'INSERT INTO "Transacciones" ("TipoTransaccion", "refArticulo", "Cantidad", "Fecha", "usuario", "totaldespues") VALUES ($1, $2, $3, NOW(), $4, $5)',
          [tipo_operacion, refArticulo, cantidadNum, usuario, nuevo_total]
        );
      } catch (insertError: any) {
        await client.query('ROLLBACK');
        console.error("Error al registrar transacción, rollback realizado:", insertError);
        throw new Error(`Operación de inventario revertida. Error al registrar transacción: ${insertError.message}`);
      }

      await client.query('COMMIT');
      return { mensaje: "Operación realizada correctamente" };

    } catch (error: any) {
      throw error;
    } finally {
      client.release();
    }
  }
}

// --- CONTROLLER (originalmente en controllers/stockController.ts) ---
const TIPOS_OPERACION_VALIDOS: TipoOperacionStock[] = ["Retirar", "Ingresar", "Reservar", "Liberar"];

export class StockController {
  static async gestionarStock(c: Context<{ Variables: Variables }>) {
    console.log("Petición POST recibida en /gestionar-stock");
    try {
      // --- MODIFICACIÓN CORREGIDA ---
      // Extraemos el usuario del contexto, que gracias a tu `types/index.ts` sabemos que tiene `userId` y `email`.
      const user = c.var.user; 
      
      // Verificamos que el objeto 'user' y sus propiedades necesarias existan.
      // Usaremos el email, ya que es un string y encaja con la columna 'usuario' (varchar).
      if (!user || !user.email) {
        console.error("Error de autenticación: El email del usuario no se encontró en el contexto.");
        return c.json({ error: "Error de autenticación interna. Usuario no identificado." }, 500);
      }
      const emailUsuario = user.email; // Usamos el email como identificador del usuario

      // Leemos el cuerpo de la petición
      const body = await c.req.json();
      const { refArticulo, cantidad, tipo_operacion } = body;

      // Validación de parámetros (sin cambios)
      if (!refArticulo || typeof refArticulo !== 'string' || refArticulo.trim() === '') {
        return c.json({ error: "Parámetro 'refArticulo' es requerido y debe ser un string no vacío." }, 400);
      }
      if (cantidad === undefined || typeof cantidad !== 'number' || isNaN(cantidad) || cantidad <= 0) {
        return c.json({ error: "Parámetro 'cantidad' es requerido y debe ser un número positivo." }, 400);
      }
      if (!tipo_operacion || !TIPOS_OPERACION_VALIDOS.includes(tipo_operacion)) {
        return c.json({ error: `Parámetro 'tipo_operacion' es requerido y debe ser uno de: ${TIPOS_OPERACION_VALIDOS.join(', ')}.` }, 400);
      }
      
      // --- MODIFICACIÓN CORREGIDA ---
      // Pasamos el email del usuario al servicio. El servicio espera una propiedad 'usuario'.
      const resultado = await StockService.gestionarStock({
        refArticulo,
        cantidad,
        tipo_operacion,
        usuario: emailUsuario // Pasamos el email como el valor para el campo 'usuario'
      });

      console.log(`GestionarStock: Operación exitosa para ${refArticulo}, tipo: ${tipo_operacion}, cantidad: ${cantidad}, por usuario: ${emailUsuario}`);
      return c.json(resultado, 200);

    } catch (error: any) {
      console.error('GestionarStock: Error general:', error);
      if (error instanceof SyntaxError) {
        return c.json({ error: 'Error al parsear el cuerpo de la petición: no es un JSON válido.' }, 400);
      }
      if (error.message.includes("Artículo no encontrado")) {
        return c.json({ error: error.message }, 404);
      }
      if (error.message.includes("No hay suficiente stock") || error.message.includes("No se pueden liberar más")) {
        return c.json({ error: error.message }, 400); // O 409 Conflict
      }
      if (error.code) { 
        return c.json({ error: `Error de base de datos: ${error.message}` }, 500);
      }
      return c.json({ error: error.message || 'Error interno del servidor.' }, 500);
    }
  }
}

// --- ROUTES (originalmente en routes/stockRoutes.ts) ---
export const stockRoutes = new Hono<{ Variables: Variables }>();

stockRoutes.post('/gestionar-stock', authMiddleware, authorize(['admin']), StockController.gestionarStock);