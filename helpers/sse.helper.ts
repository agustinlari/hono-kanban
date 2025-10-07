// helpers/sse.helper.ts - Servicio centralizado de Server-Sent Events (SSE)

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { pool } from '../config/database';
import { validateKeycloakToken, type KeycloakUser } from './keycloak.helper';
import type { Variables } from '../types';
import type { AppUser } from '../middleware/keycloak-auth';

// ================================
// Tipos de Eventos SSE
// ================================
export type SSEEventType =
  | 'card:created'
  | 'card:updated'
  | 'card:deleted'
  | 'card:moved'
  | 'activity:created'
  | 'activity:updated'
  | 'activity:deleted'
  | 'label:created'
  | 'label:updated'
  | 'label:deleted'
  | 'checklist:created'
  | 'checklist:updated'
  | 'checklist:deleted'
  | 'assignment:created'
  | 'assignment:deleted'
  | 'notification:new'
  | 'notification:read'
  | 'notification:read_all';

export interface SSEEvent {
  type: SSEEventType;
  boardId?: number; // Para eventos de tablero
  userId?: number;  // Para eventos personales (notificaciones)
  data: any;
}

export interface SSEClient {
  id: string;
  userId: number;
  userEmail: string;
  controller: any; // StreamingAPI de Hono
  boardIds: Set<number>; // Tableros que el usuario está viendo actualmente
}

// ================================
// Servicio Central de SSE
// ================================
export class SSEService {
  private static clients: Map<string, SSEClient> = new Map();
  private static clientIdCounter = 0;

  /**
   * Genera un ID único para cada cliente
   */
  private static generateClientId(): string {
    return `client-${Date.now()}-${++this.clientIdCounter}`;
  }

  /**
   * Registra un nuevo cliente SSE
   */
  static registerClient(
    userId: number,
    userEmail: string,
    controller: any
  ): string {
    const clientId = this.generateClientId();

    const client: SSEClient = {
      id: clientId,
      userId,
      userEmail,
      controller,
      boardIds: new Set()
    };

    this.clients.set(clientId, client);
    console.log(`✅ Cliente SSE registrado: ${clientId} (user: ${userEmail}, total clientes: ${this.clients.size})`);

    return clientId;
  }

  /**
   * Desregistra un cliente SSE
   */
  static unregisterClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      this.clients.delete(clientId);
      console.log(`🔌 Cliente SSE desconectado: ${clientId} (user: ${client.userEmail}, total clientes: ${this.clients.size})`);
    }
  }

  /**
   * Actualiza los tableros que un cliente está viendo
   */
  static updateClientBoards(clientId: string, boardIds: number[]): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.boardIds = new Set(boardIds);
      console.log(`📋 Cliente ${clientId} actualizado con tableros: [${Array.from(client.boardIds).join(', ')}]`);
    }
  }

  /**
   * Verifica si un usuario tiene permisos para ver un tablero
   */
  private static async userHasAccessToBoard(userId: number, boardId: number): Promise<boolean> {
    try {
      const query = `
        SELECT can_view
        FROM board_members
        WHERE user_id = $1 AND board_id = $2
      `;
      const result = await pool.query(query, [userId, boardId]);

      if (result.rowCount === 0) {
        return false;
      }

      return result.rows[0].can_view === true;
    } catch (error) {
      console.error(`Error verificando acceso al tablero ${boardId} para usuario ${userId}:`, error);
      return false;
    }
  }

  /**
   * Envía un mensaje SSE a un cliente específico
   */
  private static async sendToClient(client: SSEClient, event: SSEEvent): Promise<boolean> {
    try {
      await client.controller.writeSSE({
        event: event.type,
        data: JSON.stringify(event.data)
      });
      return true;
    } catch (error) {
      console.error(`Error enviando evento a cliente ${client.id}:`, error);
      return false;
    }
  }

  /**
   * Emite un evento relacionado con un tablero a todos los clientes con acceso
   */
  static async emitBoardEvent(event: SSEEvent): Promise<void> {
    if (!event.boardId) {
      console.warn('⚠️ emitBoardEvent llamado sin boardId');
      return;
    }

    console.log(`📡 Emitiendo evento de tablero: ${event.type} (boardId: ${event.boardId})`);

    const clientsToNotify: SSEClient[] = [];

    // Filtrar clientes que están viendo este tablero
    for (const client of this.clients.values()) {
      if (client.boardIds.has(event.boardId)) {
        clientsToNotify.push(client);
      }
    }

    console.log(`🎯 Clientes potenciales para tablero ${event.boardId}: ${clientsToNotify.length}`);

    // Verificar permisos y enviar eventos
    for (const client of clientsToNotify) {
      const hasAccess = await this.userHasAccessToBoard(client.userId, event.boardId);

      if (hasAccess) {
        const success = await this.sendToClient(client, event);
        if (success) {
          console.log(`✅ Evento enviado a cliente ${client.id} (${client.userEmail})`);
        } else {
          console.error(`❌ Error enviando evento a cliente ${client.id}`);
          // Desconectar cliente si falla el envío
          this.unregisterClient(client.id);
        }
      } else {
        console.log(`🚫 Cliente ${client.id} no tiene acceso al tablero ${event.boardId}`);
      }
    }
  }

  /**
   * Emite un evento personal a un usuario específico (ej: notificaciones)
   */
  static emitUserEvent(event: SSEEvent): void {
    if (!event.userId) {
      console.warn('⚠️ emitUserEvent llamado sin userId');
      return;
    }

    console.log(`📧 Emitiendo evento personal: ${event.type} (userId: ${event.userId})`);

    let sentCount = 0;

    // Enviar a todos los clientes de este usuario
    for (const client of this.clients.values()) {
      if (client.userId === event.userId) {
        this.sendToClient(client, event).then(success => {
          if (success) {
            sentCount++;
            console.log(`✅ Evento personal enviado a cliente ${client.id} (${client.userEmail})`);
          } else {
            console.error(`❌ Error enviando evento personal a cliente ${client.id}`);
            this.unregisterClient(client.id);
          }
        });
      }
    }

    if (sentCount === 0) {
      console.log(`ℹ️ Usuario ${event.userId} no tiene clientes conectados`);
    }
  }

  /**
   * Envía un heartbeat a todos los clientes para mantener la conexión viva
   */
  static sendHeartbeat(): void {
    const deadClients: string[] = [];

    for (const [clientId, client] of this.clients.entries()) {
      try {
        client.controller.writeSSE({ data: 'heartbeat', event: 'ping' });
      } catch (error) {
        console.error(`Error enviando heartbeat a cliente ${clientId}:`, error);
        deadClients.push(clientId);
      }
    }

    // Limpiar clientes muertos
    for (const clientId of deadClients) {
      this.unregisterClient(clientId);
    }
  }

  /**
   * Obtiene estadísticas del servicio SSE
   */
  static getStats() {
    return {
      totalClients: this.clients.size,
      clients: Array.from(this.clients.values()).map(c => ({
        id: c.id,
        userId: c.userId,
        userEmail: c.userEmail,
        boardIds: Array.from(c.boardIds)
      }))
    };
  }
}

// Configurar heartbeat cada 30 segundos para mantener conexiones vivas
setInterval(() => {
  SSEService.sendHeartbeat();
}, 30000);

// ================================
// Controlador SSE
// ================================
class SSEController {
  /**
   * Obtiene o crea un usuario en nuestra base de datos basado en la info de Keycloak
   */
  private static async getOrCreateUser(keycloakUser: KeycloakUser): Promise<AppUser> {
    const client = await pool.connect();

    try {
      // Buscar usuario existente por Keycloak ID
      let userResult = await client.query(
        'SELECT * FROM usuarios WHERE keycloak_id = $1',
        [keycloakUser.sub]
      );

      if (userResult.rowCount && userResult.rowCount > 0) {
        // Usuario existe
        const existingUser = userResult.rows[0];
        const newName = keycloakUser.name || keycloakUser.preferred_username || keycloakUser.email;

        // Actualizar email y nombre si cambiaron
        if (existingUser.email !== keycloakUser.email || existingUser.name !== newName) {
          await client.query(
            'UPDATE usuarios SET email = $1, name = $2, updated_at = NOW() WHERE keycloak_id = $3',
            [keycloakUser.email, newName, keycloakUser.sub]
          );
        }

        return {
          id: existingUser.id,
          keycloakId: keycloakUser.sub,
          userId: existingUser.id,
          email: keycloakUser.email,
          name: newName,
          isAdmin: existingUser.rol === 'admin',
          rol: existingUser.rol,
          keycloakRoles: keycloakUser.realm_access?.roles || [],
          created_at: existingUser.created_at,
          updated_at: existingUser.updated_at
        };
      } else {
        // Usuario no existe, crearlo
        const newName = keycloakUser.name || keycloakUser.preferred_username || keycloakUser.email;

        const insertResult = await client.query(`
          INSERT INTO usuarios (keycloak_id, email, name, rol)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        `, [
          keycloakUser.sub,
          keycloakUser.email,
          newName,
          'user' // Rol por defecto
        ]);

        const newUser = insertResult.rows[0];

        return {
          id: newUser.id,
          keycloakId: keycloakUser.sub,
          userId: newUser.id,
          email: keycloakUser.email,
          name: newName,
          isAdmin: newUser.rol === 'admin',
          rol: newUser.rol,
          keycloakRoles: keycloakUser.realm_access?.roles || [],
          created_at: newUser.created_at,
          updated_at: newUser.updated_at
        };
      }
    } finally {
      client.release();
    }
  }

  /**
   * GET /events - Endpoint SSE para conexiones en tiempo real
   */
  static async handleSSE(c: Context) {
    // Extraer token JWT del query parameter
    const token = c.req.query('token');

    if (!token) {
      return c.json({ error: 'Token JWT requerido' }, 401);
    }

    // Verificar el token con Keycloak
    let keycloakUser: KeycloakUser;
    let appUser: AppUser;

    try {
      // Validar token con Keycloak
      keycloakUser = await validateKeycloakToken(token);

      // Buscar o crear usuario en nuestra base de datos
      appUser = await SSEController.getOrCreateUser(keycloakUser);

    } catch (error) {
      console.error('Error verificando token SSE con Keycloak:', error);
      return c.json({ error: 'Token inválido o expirado' }, 401);
    }

    console.log(`🔌 Nueva conexión SSE de usuario: ${appUser.email} (ID: ${appUser.userId})`);

    // Obtener boardIds del query parameter (opcional, puede venir después)
    const boardIdsParam = c.req.query('boardIds');
    let boardIds: number[] = [];

    if (boardIdsParam) {
      try {
        boardIds = JSON.parse(boardIdsParam);
      } catch (error: any) {
        console.warn('Error parseando boardIds:', error);
      }
    }

    // Establecer conexión SSE
    let clientId: string | null = null;

    return streamSSE(c, async (stream) => {
      // Registrar cliente
      clientId = SSEService.registerClient(appUser.userId, appUser.email, stream);

      // Suscribir a tableros si se proporcionaron
      if (boardIds.length > 0) {
        SSEService.updateClientBoards(clientId, boardIds);
      }

      // Enviar evento inicial de conexión
      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({
          message: 'Conectado al servidor SSE',
          userId: appUser.userId,
          clientId,
          boardIds
        })
      });

      // Mantener la conexión abierta
      let isRunning = true;

      // Detectar cuando el cliente se desconecta
      stream.onAbort(() => {
        isRunning = false;
        if (clientId) {
          SSEService.unregisterClient(clientId);
        }
        console.log(`Cliente desconectado: ${clientId}`);
      });

      // Mantener la stream viva
      while (isRunning) {
        await stream.sleep(30000); // Esperar 30 segundos
      }
    });
  }

  /**
   * POST /events/subscribe - Suscribirse a tableros específicos
   */
  static async subscribeToBoards(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    try {
      const { boardIds } = await c.req.json();

      if (!Array.isArray(boardIds)) {
        return c.json({ error: 'boardIds debe ser un array' }, 400);
      }

      // Nota: En la práctica, el clientId debería enviarse desde el frontend
      // Por ahora, actualizamos todos los clientes de este usuario
      for (const [clientId, client] of SSEService['clients'].entries()) {
        if (client.userId === user.userId) {
          SSEService.updateClientBoards(clientId, boardIds);
        }
      }

      return c.json({
        message: 'Suscripción actualizada',
        boardIds
      });

    } catch (error: any) {
      console.error('Error suscribiendo a tableros:', error);
      return c.json({ error: 'Error interno del servidor' }, 500);
    }
  }

  /**
   * GET /events/stats - Obtener estadísticas del servicio SSE (solo para debugging)
   */
  static async getStats(c: Context) {
    const user = c.get('user');
    if (!user) return c.json({ error: 'No autorizado' }, 401);

    return c.json(SSEService.getStats());
  }
}

// ================================
// Definición y Exportación de Rutas
// ================================
export const sseRoutes = new Hono<{ Variables: Variables }>();

// Endpoint SSE principal (sin middleware de autenticación porque usa token en query)
sseRoutes.get('/events', SSEController.handleSSE);

// Endpoints auxiliares (con autenticación estándar)
// Nota: Estos no están implementados porque el diseño SSE es unidireccional
// El frontend enviará el boardId en la query al conectarse inicialmente
