// ================================
// src/helpers/exportHelper.ts
// ================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { apiKeyAuthMiddleware } from '../middleware/auth';
import type { Variables } from '../types';
import Papa from 'papaparse'; // Importamos la librería para CSV

// ================================
// Types (Podríamos importarlos si estuvieran en un archivo central)
// ================================
export interface InventarioItem {
    refArticulo: string;
    Descripcion: string;
    EAN13?: string;
    Ubicacion?: string;
    StockMinimo?: number;
    StockMaximo?: number;
    reservadas?: number;
    totales?: number;
}

// ================================
// Service: Lógica de negocio
// ================================
class ExportService {
    /**
     * Obtiene TODOS los artículos del inventario para la exportación.
     */
    static async getInventarioCompleto(): Promise<InventarioItem[]> {
        const query = `
            SELECT 
                "refArticulo", "EAN13", "Descripcion", "Ubicacion", 
                "StockMinimo", "StockMaximo", "totales", "reservadas" 
            FROM "Inventario" 
            ORDER BY "refArticulo" ASC
        `;
        try {
            const result = await pool.query(query);
            return result.rows as InventarioItem[];
        } catch (error) {
            console.error('Error en ExportService.getInventarioCompleto:', error);
            throw new Error('No se pudo obtener el inventario completo desde la base de datos.');
        }
    }
}

// ================================
// Controller: Maneja las peticiones y respuestas
// ================================
class ExportController {
    /**
     * Genera y devuelve un archivo CSV del inventario completo.
     */
    static async exportInventarioToCsv(c: Context) {
        try {
            console.log("Petición de exportación de inventario a CSV recibida.");
            const inventarioCompleto = await ExportService.getInventarioCompleto();

            if (inventarioCompleto.length === 0) {
                return c.text('No hay datos de inventario para exportar.', 200);
            }

            // Convertir el array de objetos JSON a formato CSV
            const csv = Papa.unparse(inventarioCompleto, {
                header: true, // Incluye los nombres de las columnas como cabecera
                quotes: true, // Pone comillas alrededor de todos los campos para mayor compatibilidad
            });
            
            // Genera un nombre de archivo con la fecha actual
            const fileName = `inventario-export-${new Date().toISOString().slice(0, 10)}.csv`;

            // Establecer las cabeceras de la respuesta para forzar la descarga
            c.header('Content-Type', 'text/csv; charset=utf-8');
            c.header('Content-Disposition', `attachment; filename="${fileName}"`);
            
            return c.body(csv);

        } catch (error: any) {
            console.error('Error en ExportController.exportInventarioToCsv:', error);
            return c.json({ error: error.message || 'Error interno al generar la exportación.' }, 500);
        }
    }

    // Futuro: Podrías añadir aquí 'exportTransaccionesToCsv', etc.
}

// ================================
// Routes: Definición de las rutas de exportación
// ================================
export const exportRoutes = new Hono<{ Variables: Variables }>();

// La ruta está protegida por el middleware de API Key
exportRoutes.get(
    '/api/v1/export/inventario', 
    apiKeyAuthMiddleware, 
    ExportController.exportInventarioToCsv
);