// src/helpers/wallpapers.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';
import { requireBoardAccess } from '../middleware/permissions';
import fs from 'fs/promises';
import path from 'path';

// ================================
// Lógica de Servicio (WallpaperService)
// ================================
class WallpaperService {
  /**
   * Obtiene todos los wallpapers disponibles
   */
  static async getAvailableWallpapers(): Promise<Array<{ filename: string; name: string; url: string }>> {
    const wallpapersDir = path.join(__dirname, '..', 'wallpapers');

    try {
      const files = await fs.readdir(wallpapersDir);

      // Filtrar solo archivos de imagen
      const imageFiles = files.filter(file =>
        /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
      );

      // Mapear a objetos con información útil
      const wallpapers = imageFiles.map(filename => ({
        filename,
        name: this.formatName(filename),
        url: `/wallpapers/${encodeURIComponent(filename)}`
      }));

      return wallpapers;
    } catch (error) {
      console.error('Error reading wallpapers directory:', error);
      return [];
    }
  }

  /**
   * Formatea el nombre del archivo para mostrarlo al usuario
   */
  private static formatName(filename: string): string {
    // Eliminar extensión y formatear nombre
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');

    // Capitalizar primera letra y reemplazar guiones/espacios
    return nameWithoutExt
      .split(/[-_\s]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Actualiza el wallpaper de un tablero
   */
  static async updateBoardWallpaper(boardId: number, wallpaper: string | null): Promise<boolean> {
    try {
      const result = await pool.query(
        'UPDATE boards SET wallpaper = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [wallpaper, boardId]
      );

      return result.rowCount! > 0;
    } catch (error) {
      console.error('Error updating board wallpaper:', error);
      throw error;
    }
  }
}

// ================================
// Controladores de Wallpapers
// ================================
class WallpaperController {
  /**
   * GET /wallpapers - Obtener todos los wallpapers disponibles
   */
  static async getAvailable(c: Context<{ Variables: Variables }>) {
    try {
      const wallpapers = await WallpaperService.getAvailableWallpapers();
      return c.json(wallpapers);
    } catch (error: any) {
      console.error('Error in WallpaperController.getAvailable:', error);
      return c.json({ error: 'No se pudieron obtener los wallpapers' }, 500);
    }
  }

  /**
   * PUT /boards/:id/wallpaper - Actualizar wallpaper de un tablero
   */
  static async updateBoardWallpaper(c: Context<{ Variables: Variables }>) {
    try {
      const boardId = parseInt(c.req.param('id'));
      if (isNaN(boardId)) {
        return c.json({ error: 'ID de tablero inválido' }, 400);
      }

      const body = await c.req.json();
      const { wallpaper } = body;

      // Validar que el wallpaper existe (si no es null)
      if (wallpaper !== null) {
        const availableWallpapers = await WallpaperService.getAvailableWallpapers();
        const wallpaperExists = availableWallpapers.some(w => w.filename === wallpaper);

        if (!wallpaperExists) {
          return c.json({ error: 'Wallpaper no encontrado' }, 400);
        }
      }

      const updated = await WallpaperService.updateBoardWallpaper(boardId, wallpaper);

      if (!updated) {
        return c.json({ error: 'Tablero no encontrado' }, 404);
      }

      return c.json({
        success: true,
        message: wallpaper ? 'Wallpaper actualizado correctamente' : 'Wallpaper eliminado correctamente',
        wallpaper
      });
    } catch (error: any) {
      console.error('Error in WallpaperController.updateBoardWallpaper:', error);
      return c.json({ error: 'No se pudo actualizar el wallpaper' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Wallpapers
// ================================
export const wallpaperRoutes = new Hono<{ Variables: Variables }>();

// Aplicar middleware de autenticación a todas las rutas
wallpaperRoutes.use('/*', keycloakAuthMiddleware);

// Rutas públicas (para usuarios autenticados)
wallpaperRoutes.get('/wallpapers', WallpaperController.getAvailable);

// Rutas que requieren acceso al tablero
wallpaperRoutes.put('/boards/:id/wallpaper', requireBoardAccess(), WallpaperController.updateBoardWallpaper);

export { WallpaperController };