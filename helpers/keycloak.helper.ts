// helpers/keycloak.helper.ts - Integración con Keycloak
import jwt from 'jsonwebtoken';
import jwksClient, { type JwksClient } from 'jwks-rsa';
import { 
  KEYCLOAK_BASE_URL, 
  KEYCLOAK_REALM, 
  KEYCLOAK_PUBLIC_KEY_URL,
  KEYCLOAK_ISSUER,
  KEYCLOAK_CLIENT_ID
} from '../config/env';

// Cliente JWKS para obtener las claves públicas de Keycloak
const client = jwksClient({
  jwksUri: KEYCLOAK_PUBLIC_KEY_URL,
  requestHeaders: {},
  timeout: 30000,
});

export interface KeycloakUser {
  sub: string;           // UUID del usuario en Keycloak
  email: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  realm_access?: {
    roles: string[];
  };
  resource_access?: {
    [clientId: string]: {
      roles: string[];
    };
  };
  iat: number;
  exp: number;
  aud: string;
  iss: string;
}

/**
 * Obtiene la clave pública para verificar el JWT
 */
function getKey(header: any, callback: any) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err);
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

/**
 * Valida un token JWT de Keycloak
 */
export async function validateKeycloakToken(token: string): Promise<KeycloakUser> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, {
      audience: 'account', // Cliente por defecto en Keycloak
      issuer: KEYCLOAK_ISSUER,
      algorithms: ['RS256']
    }, (err, decoded) => {
      if (err) {
        console.error('Error validando token Keycloak:', err);
        reject(new Error('Token inválido'));
        return;
      }
      
      resolve(decoded as KeycloakUser);
    });
  });
}

/**
 * Obtiene información del usuario desde Keycloak (opcional)
 */
export async function getKeycloakUserInfo(accessToken: string): Promise<any> {
  const { KEYCLOAK_USERINFO_URL } = await import('../config/env');
  const response = await fetch(KEYCLOAK_USERINFO_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error('Error obteniendo información del usuario');
  }

  return response.json();
}

/**
 * Verifica si un usuario tiene un rol específico
 */
export function hasKeycloakRole(user: KeycloakUser, role: string): boolean {
  return user.realm_access?.roles.includes(role) || false;
}

/**
 * Obtiene los roles de un usuario para un cliente específico
 */
export function getClientRoles(user: KeycloakUser, clientId: string): string[] {
  return user.resource_access?.[clientId]?.roles || [];
}