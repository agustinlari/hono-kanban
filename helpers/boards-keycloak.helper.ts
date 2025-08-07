// helpers/boards-keycloak.helper.ts - Rutas de tableros con autenticación Keycloak
import { Hono } from 'hono';
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import { requireBoardAccess, requireOwnership } from '../middleware/permissions';
import type { Variables } from '../types';

// Importar controllers existentes
import { BoardController } from '../helpers/boards.helper';

// ================================
// Rutas de Tableros con Keycloak
// ================================
export const boardKeycloakRoutes = new Hono<{ Variables: Variables }>();

// Todas las rutas usan autenticación Keycloak
boardKeycloakRoutes.use('*', keycloakAuthMiddleware);

// Rutas de tableros (prefijo /api/v2 para diferenciar)
boardKeycloakRoutes.get('/api/v2/boards/:id', requireBoardAccess(), BoardController.getOne);
boardKeycloakRoutes.post('/api/v2/boards', BoardController.create);
boardKeycloakRoutes.delete('/api/v2/boards/:id', requireOwnership(), BoardController.delete);
boardKeycloakRoutes.get('/api/v2/boards/:id/lists', requireBoardAccess(), BoardController.getListsOfBoard);

// Nota: Los middlewares de permisos (requireBoardAccess, requireOwnership) 
// deberán ser actualizados para trabajar con el nuevo formato de usuario de Keycloak