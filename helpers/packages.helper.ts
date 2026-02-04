// helpers/packages.helper.ts

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';

// ================================
// Tipos
// ================================
interface Package {
  id: number;
  code: string | null;
  height: number | null;
  width: number | null;
  depth: number | null;
  weight: number | null;
  is_consolidated: boolean;
  is_collected: boolean;
  pallet: boolean;
  packaging: string | null;
  notes: string | null;
  created_by: number | null;
  created_at: string;
}

interface CardPackage {
  id: number;
  card_id: string;
  package_id: number;
  linked_at: string;
  linked_by: number | null;
  package?: Package;
}

interface CreatePackagePayload {
  code?: string;
  height?: number;
  width?: number;
  depth?: number;
  weight?: number;
  is_consolidated?: boolean;
  is_collected?: boolean;
  pallet?: boolean;
  packaging?: string;
  notes?: string;
}

interface UpdatePackagePayload {
  code?: string;
  height?: number;
  width?: number;
  depth?: number;
  weight?: number;
  is_consolidated?: boolean;
  is_collected?: boolean;
  pallet?: boolean;
  packaging?: string;
  notes?: string;
}

// ================================
// Lógica de Servicio (PackageService)
// ================================
class PackageService {
  /**
   * Obtiene todos los packages (con paginación opcional)
   */
  static async getAllPackages(limit: number = 100, offset: number = 0): Promise<Package[]> {
    const query = `
      SELECT id, code, height, width, depth, weight, is_consolidated, is_collected, pallet, packaging, notes, created_by, created_at
      FROM packages
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const result = await pool.query(query, [limit, offset]);
    return result.rows;
  }

  /**
   * Obtiene todos los packages con información de tarjetas vinculadas y custom fields
   */
  static async getAllPackagesWithCards(limit: number = 500): Promise<any[]> {
    // Primero obtenemos los paquetes no consolidados
    const packagesQuery = `
      SELECT id, code, height, width, depth, weight, is_consolidated, is_collected, pallet, packaging, notes, created_by, created_at
      FROM packages
      WHERE is_consolidated = false
      ORDER BY created_at DESC
      LIMIT $1
    `;
    const packagesResult = await pool.query(packagesQuery, [limit]);
    const packages = packagesResult.rows;

    if (packages.length === 0) {
      return [];
    }

    // Obtener IDs de paquetes
    const packageIds = packages.map((p: Package) => p.id);

    // Obtener las tarjetas vinculadas a estos paquetes con sus custom fields (OT=9, Importe=12) y board_id
    const cardsQuery = `
      SELECT
        cp.package_id,
        c.id as card_id,
        c.title as card_title,
        l.board_id,
        cf_ot.text_value as ot_value,
        cf_importe.numeric_value as importe_value
      FROM cards_packages cp
      INNER JOIN cards c ON cp.card_id = c.id
      INNER JOIN lists l ON c.list_id = l.id
      LEFT JOIN card_custom_field_values cf_ot ON c.id = cf_ot.card_id AND cf_ot.field_id = 9
      LEFT JOIN card_custom_field_values cf_importe ON c.id = cf_importe.card_id AND cf_importe.field_id = 12
      WHERE cp.package_id = ANY($1)
      ORDER BY cp.linked_at DESC
    `;
    const cardsResult = await pool.query(cardsQuery, [packageIds]);

    // Agrupar tarjetas por package_id
    const cardsByPackage: Record<number, any[]> = {};
    for (const row of cardsResult.rows) {
      if (!cardsByPackage[row.package_id]) {
        cardsByPackage[row.package_id] = [];
      }
      cardsByPackage[row.package_id].push({
        card_id: row.card_id,
        card_title: row.card_title,
        board_id: row.board_id,
        ot: row.ot_value,
        importe: row.importe_value
      });
    }

    // Añadir la información de tarjetas a cada paquete
    return packages.map((pkg: Package) => ({
      ...pkg,
      linked_cards: cardsByPackage[pkg.id] || []
    }));
  }

  /**
   * Busca packages por código o notas
   */
  static async searchPackages(searchTerm: string, limit: number = 50): Promise<Package[]> {
    const query = `
      SELECT id, code, height, width, depth, weight, is_consolidated, is_collected, notes, created_by, created_at
      FROM packages
      WHERE code ILIKE $1 OR notes ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const result = await pool.query(query, [`%${searchTerm}%`, limit]);
    return result.rows;
  }

  /**
   * Obtiene un package por ID
   */
  static async getPackageById(id: number): Promise<Package | null> {
    const query = `
      SELECT id, code, height, width, depth, weight, is_consolidated, is_collected, pallet, packaging, notes, created_by, created_at
      FROM packages
      WHERE id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0] || null;
  }

  /**
   * Crea un nuevo package
   */
  static async createPackage(data: CreatePackagePayload, userId: number): Promise<Package> {
    const { code, height, width, depth, weight, is_consolidated, is_collected, pallet, packaging, notes } = data;

    const query = `
      INSERT INTO packages (code, height, width, depth, weight, is_consolidated, is_collected, pallet, packaging, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    const result = await pool.query(query, [
      code || null,
      height || null,
      width || null,
      depth || null,
      weight || null,
      is_consolidated || false,
      is_collected || false,
      pallet || false,
      packaging || 'Cartón',
      notes || null,
      userId
    ]);
    return result.rows[0] as Package;
  }

  /**
   * Actualiza un package
   */
  static async updatePackage(id: number, data: UpdatePackagePayload): Promise<Package | null> {
    const fieldsToUpdate = Object.keys(data).filter(key => data[key as keyof UpdatePackagePayload] !== undefined);

    if (fieldsToUpdate.length === 0) {
      return this.getPackageById(id);
    }

    const setClause = fieldsToUpdate.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
    const queryValues: any[] = fieldsToUpdate.map(key => data[key as keyof UpdatePackagePayload]);
    queryValues.push(id);

    const query = `
      UPDATE packages
      SET ${setClause}
      WHERE id = $${queryValues.length}
      RETURNING *
    `;

    const result = await pool.query(query, queryValues);
    return result.rows[0] || null;
  }

  /**
   * Elimina un package
   */
  static async deletePackage(id: number): Promise<boolean> {
    const deleteResult = await pool.query('DELETE FROM packages WHERE id = $1', [id]);
    return (deleteResult.rowCount ?? 0) > 0;
  }

  /**
   * Obtiene los packages vinculados a una tarjeta
   */
  static async getCardPackages(cardId: string): Promise<(CardPackage & { package: Package })[]> {
    const query = `
      SELECT
        cp.id,
        cp.card_id,
        cp.package_id,
        cp.linked_at,
        cp.linked_by,
        p.id as "pkg_id",
        p.code as "pkg_code",
        p.height as "pkg_height",
        p.width as "pkg_width",
        p.depth as "pkg_depth",
        p.weight as "pkg_weight",
        p.is_consolidated as "pkg_is_consolidated",
        p.is_collected as "pkg_is_collected",
        p.pallet as "pkg_pallet",
        p.packaging as "pkg_packaging",
        p.notes as "pkg_notes",
        p.created_by as "pkg_created_by",
        p.created_at as "pkg_created_at"
      FROM cards_packages cp
      INNER JOIN packages p ON cp.package_id = p.id
      WHERE cp.card_id = $1
      ORDER BY p.is_consolidated DESC, p.created_at ASC
    `;
    const result = await pool.query(query, [cardId]);

    return result.rows.map(row => ({
      id: row.id,
      card_id: row.card_id,
      package_id: row.package_id,
      linked_at: row.linked_at,
      linked_by: row.linked_by,
      package: {
        id: row.pkg_id,
        code: row.pkg_code,
        height: row.pkg_height,
        width: row.pkg_width,
        depth: row.pkg_depth,
        weight: row.pkg_weight,
        is_consolidated: row.pkg_is_consolidated,
        is_collected: row.pkg_is_collected,
        pallet: row.pkg_pallet,
        packaging: row.pkg_packaging,
        notes: row.pkg_notes,
        created_by: row.pkg_created_by,
        created_at: row.pkg_created_at
      }
    }));
  }

  /**
   * Obtiene las tarjetas a las que está vinculado un package
   */
  static async getPackageCards(packageId: number): Promise<{ card_id: string; card_title: string; board_name: string }[]> {
    const query = `
      SELECT
        cp.card_id,
        c.title as card_title,
        b.name as board_name
      FROM cards_packages cp
      INNER JOIN cards c ON cp.card_id = c.id
      INNER JOIN lists l ON c.list_id = l.id
      INNER JOIN boards b ON l.board_id = b.id
      WHERE cp.package_id = $1
      ORDER BY cp.linked_at DESC
    `;
    const result = await pool.query(query, [packageId]);
    return result.rows;
  }

  /**
   * Vincula un package a una tarjeta
   */
  static async linkPackageToCard(cardId: string, packageId: number, userId: number): Promise<CardPackage> {
    // Verificar que la tarjeta existe
    const cardCheck = await pool.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (cardCheck.rowCount === 0) {
      throw new Error('La tarjeta especificada no existe.');
    }

    // Verificar que el package existe
    const packageCheck = await pool.query('SELECT id FROM packages WHERE id = $1', [packageId]);
    if (packageCheck.rowCount === 0) {
      throw new Error('El paquete especificado no existe.');
    }

    const query = `
      INSERT INTO cards_packages (card_id, package_id, linked_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (card_id, package_id) DO NOTHING
      RETURNING *
    `;
    const result = await pool.query(query, [cardId, packageId, userId]);

    if (result.rowCount === 0) {
      // Ya existía el vínculo
      const existing = await pool.query(
        'SELECT * FROM cards_packages WHERE card_id = $1 AND package_id = $2',
        [cardId, packageId]
      );
      return existing.rows[0];
    }

    return result.rows[0] as CardPackage;
  }

  /**
   * Desvincula un package de una tarjeta
   */
  static async unlinkPackageFromCard(cardId: string, packageId: number): Promise<boolean> {
    // Verificar que el paquete no esté recolectado
    const packageCheck = await pool.query(
      'SELECT is_collected FROM packages WHERE id = $1',
      [packageId]
    );
    if (packageCheck.rows[0]?.is_collected) {
      throw new Error('No se puede desvincular un paquete recolectado. Primero márcalo como pendiente.');
    }

    const deleteResult = await pool.query(
      'DELETE FROM cards_packages WHERE card_id = $1 AND package_id = $2',
      [cardId, packageId]
    );
    return (deleteResult.rowCount ?? 0) > 0;
  }

  /**
   * Crea un package y lo vincula directamente a una tarjeta
   */
  static async createAndLinkPackage(cardId: string, data: CreatePackagePayload, userId: number): Promise<{ package: Package; link: CardPackage }> {
    // Verificar que la tarjeta existe
    const cardCheck = await pool.query('SELECT id FROM cards WHERE id = $1', [cardId]);
    if (cardCheck.rowCount === 0) {
      throw new Error('La tarjeta especificada no existe.');
    }

    // Crear el package
    const pkg = await this.createPackage(data, userId);

    // Vincularlo a la tarjeta
    const link = await this.linkPackageToCard(cardId, pkg.id, userId);

    return { package: pkg, link };
  }
}

// ================================
// Lógica de Controlador (PackageController)
// ================================
class PackageController {
  /**
   * Obtiene todos los packages
   */
  static async getAllPackages(c: Context) {
    try {
      const limit = parseInt(c.req.query('limit') || '100');
      const offset = parseInt(c.req.query('offset') || '0');

      const packages = await PackageService.getAllPackages(limit, offset);
      return c.json(packages);
    } catch (error: any) {
      console.error('Error en PackageController.getAllPackages:', error);
      return c.json({ error: 'Error al obtener los paquetes' }, 500);
    }
  }

  /**
   * Obtiene todos los packages con información de tarjetas vinculadas
   */
  static async getAllPackagesWithCards(c: Context) {
    try {
      const limit = parseInt(c.req.query('limit') || '500');
      const packages = await PackageService.getAllPackagesWithCards(limit);
      return c.json(packages);
    } catch (error: any) {
      console.error('Error en PackageController.getAllPackagesWithCards:', error);
      return c.json({ error: 'Error al obtener los paquetes con tarjetas' }, 500);
    }
  }

  /**
   * Busca packages por término
   */
  static async searchPackages(c: Context) {
    try {
      const searchTerm = c.req.query('q') || '';
      const limit = parseInt(c.req.query('limit') || '50');

      if (!searchTerm) {
        return c.json({ error: 'El parámetro q es requerido' }, 400);
      }

      const packages = await PackageService.searchPackages(searchTerm, limit);
      return c.json(packages);
    } catch (error: any) {
      console.error('Error en PackageController.searchPackages:', error);
      return c.json({ error: 'Error al buscar paquetes' }, 500);
    }
  }

  /**
   * Obtiene un package por ID
   */
  static async getPackageById(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de paquete inválido' }, 400);
      }

      const pkg = await PackageService.getPackageById(id);
      if (!pkg) {
        return c.json({ error: `Paquete con ID ${id} no encontrado` }, 404);
      }

      // También obtener las tarjetas vinculadas
      const linkedCards = await PackageService.getPackageCards(id);

      return c.json({ ...pkg, linked_cards: linkedCards });
    } catch (error: any) {
      console.error('Error en PackageController.getPackageById:', error);
      return c.json({ error: 'Error al obtener el paquete' }, 500);
    }
  }

  /**
   * Crea un nuevo package
   */
  static async createPackage(c: Context<{ Variables: Variables }>) {
    try {
      const data: CreatePackagePayload = await c.req.json();
      const user = c.get('user');

      const newPackage = await PackageService.createPackage(data, user.id);
      return c.json(newPackage, 201);
    } catch (error: any) {
      console.error('Error en PackageController.createPackage:', error);
      return c.json({ error: 'No se pudo crear el paquete' }, 500);
    }
  }

  /**
   * Actualiza un package
   */
  static async updatePackage(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de paquete inválido' }, 400);
      }

      const data: UpdatePackagePayload = await c.req.json();
      const updatedPackage = await PackageService.updatePackage(id, data);

      if (!updatedPackage) {
        return c.json({ error: `Paquete con ID ${id} no encontrado` }, 404);
      }

      return c.json(updatedPackage);
    } catch (error: any) {
      console.error('Error en PackageController.updatePackage:', error);
      return c.json({ error: 'No se pudo actualizar el paquete' }, 500);
    }
  }

  /**
   * Elimina un package
   */
  static async deletePackage(c: Context) {
    try {
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) {
        return c.json({ error: 'ID de paquete inválido' }, 400);
      }

      const wasDeleted = await PackageService.deletePackage(id);

      if (!wasDeleted) {
        return c.json({ error: `Paquete con ID ${id} no encontrado` }, 404);
      }

      return c.body(null, 204);
    } catch (error: any) {
      console.error('Error en PackageController.deletePackage:', error);
      return c.json({ error: 'No se pudo eliminar el paquete' }, 500);
    }
  }

  /**
   * Obtiene los packages de una tarjeta
   */
  static async getCardPackages(c: Context) {
    try {
      const cardId = c.req.param('cardId');
      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }

      const packages = await PackageService.getCardPackages(cardId);
      return c.json(packages);
    } catch (error: any) {
      console.error('Error en PackageController.getCardPackages:', error);
      return c.json({ error: 'Error al obtener los paquetes de la tarjeta' }, 500);
    }
  }

  /**
   * Vincula un package existente a una tarjeta
   */
  static async linkPackageToCard(c: Context<{ Variables: Variables }>) {
    try {
      const cardId = c.req.param('cardId');
      const data = await c.req.json();
      const user = c.get('user');

      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }
      if (!data.package_id || typeof data.package_id !== 'number') {
        return c.json({ error: 'package_id es requerido y debe ser un número' }, 400);
      }

      const link = await PackageService.linkPackageToCard(cardId, data.package_id, user.id);
      return c.json(link, 201);
    } catch (error: any) {
      console.error('Error en PackageController.linkPackageToCard:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo vincular el paquete' }, 500);
    }
  }

  /**
   * Desvincula un package de una tarjeta
   */
  static async unlinkPackageFromCard(c: Context) {
    try {
      const cardId = c.req.param('cardId');
      const packageId = parseInt(c.req.param('packageId'));

      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }
      if (isNaN(packageId)) {
        return c.json({ error: 'packageId inválido' }, 400);
      }

      const wasUnlinked = await PackageService.unlinkPackageFromCard(cardId, packageId);

      if (!wasUnlinked) {
        return c.json({ error: 'El paquete no está vinculado a esta tarjeta' }, 404);
      }

      return c.body(null, 204);
    } catch (error: any) {
      console.error('Error en PackageController.unlinkPackageFromCard:', error);
      if (error.message?.includes('recolectado')) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: 'No se pudo desvincular el paquete' }, 500);
    }
  }

  /**
   * Crea un package y lo vincula a una tarjeta en un solo paso
   */
  static async createAndLinkPackage(c: Context<{ Variables: Variables }>) {
    try {
      const cardId = c.req.param('cardId');
      const data: CreatePackagePayload = await c.req.json();
      const user = c.get('user');

      if (!cardId) {
        return c.json({ error: 'cardId es requerido' }, 400);
      }

      const result = await PackageService.createAndLinkPackage(cardId, data, user.id);
      return c.json(result, 201);
    } catch (error: any) {
      console.error('Error en PackageController.createAndLinkPackage:', error);
      if (error.message.includes('no existe')) {
        return c.json({ error: error.message }, 404);
      }
      return c.json({ error: 'No se pudo crear y vincular el paquete' }, 500);
    }
  }
}

// ================================
// Definición de Rutas de Packages
// ================================
export const packageRoutes = new Hono<{ Variables: Variables }>();

packageRoutes.use('*', keycloakAuthMiddleware);

// Rutas de packages (CRUD global)
packageRoutes.get('/packages', PackageController.getAllPackages);
packageRoutes.get('/packages/with-cards', PackageController.getAllPackagesWithCards);
packageRoutes.get('/packages/search', PackageController.searchPackages);
packageRoutes.get('/packages/:id', PackageController.getPackageById);
packageRoutes.post('/packages', PackageController.createPackage);
packageRoutes.put('/packages/:id', PackageController.updatePackage);
packageRoutes.delete('/packages/:id', PackageController.deletePackage);

// Rutas de packages en tarjetas
packageRoutes.get('/cards/:cardId/packages', PackageController.getCardPackages);
packageRoutes.post('/cards/:cardId/packages', PackageController.createAndLinkPackage);  // Crear y vincular
packageRoutes.post('/cards/:cardId/packages/link', PackageController.linkPackageToCard);  // Solo vincular existente
packageRoutes.delete('/cards/:cardId/packages/:packageId', PackageController.unlinkPackageFromCard);
