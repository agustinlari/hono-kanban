-- Migración para integrar Keycloak
-- Archivo: migrations/add_keycloak_integration.sql

-- 1. Agregar campo keycloak_id a la tabla usuarios
ALTER TABLE usuarios 
ADD COLUMN keycloak_id UUID UNIQUE;

-- 2. Hacer el password_hash opcional (ya no será necesario con Keycloak)
ALTER TABLE usuarios 
ALTER COLUMN password_hash DROP NOT NULL;

-- 3. Agregar índice para búsquedas eficientes por keycloak_id
CREATE INDEX idx_usuarios_keycloak_id ON usuarios(keycloak_id);

-- 4. Comentarios para documentar los cambios
COMMENT ON COLUMN usuarios.keycloak_id IS 'UUID del usuario en Keycloak';
COMMENT ON COLUMN usuarios.password_hash IS 'Hash de contraseña (obsoleto con Keycloak)';

-- NOTA: 
-- Los usuarios existentes mantendrán su password_hash hasta que se autentiquen por primera vez con Keycloak
-- Una vez que un usuario tenga keycloak_id, se usará exclusivamente la autenticación de Keycloak