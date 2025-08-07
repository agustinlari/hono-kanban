-- ================================
-- Recrear tabla usuarios para Keycloak
-- ================================
-- CUIDADO: Este script elimina todos los usuarios existentes
-- Solo usar en desarrollo/pre-producción

BEGIN;

-- 1. Eliminar restricciones de foreign keys que dependen de usuarios
-- (Las que están en card_assignments)
ALTER TABLE card_assignments DROP CONSTRAINT IF EXISTS fk_card_assignments_user;
ALTER TABLE card_assignments DROP CONSTRAINT IF EXISTS fk_card_assignments_assigned_by;

-- 2. Eliminar tabla usuarios actual
DROP TABLE IF EXISTS usuarios CASCADE;

-- 3. Recrear tabla usuarios con estructura optimizada para Keycloak
CREATE TABLE usuarios (
    id SERIAL PRIMARY KEY,
    keycloak_id UUID UNIQUE NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT, -- Opcional, solo para compatibilidad
    rol user_role DEFAULT 'user' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Crear índices para rendimiento
CREATE INDEX idx_usuarios_keycloak_id ON usuarios(keycloak_id);
CREATE INDEX idx_usuarios_email ON usuarios(email);
CREATE INDEX idx_usuarios_rol ON usuarios(rol);

-- 5. Agregar comentarios para documentación
COMMENT ON TABLE usuarios IS 'Usuarios del sistema integrados con Keycloak';
COMMENT ON COLUMN usuarios.keycloak_id IS 'UUID del usuario en Keycloak (requerido)';
COMMENT ON COLUMN usuarios.email IS 'Email del usuario sincronizado con Keycloak';
COMMENT ON COLUMN usuarios.password_hash IS 'Hash de contraseña (obsoleto, solo para compatibilidad)';
COMMENT ON COLUMN usuarios.rol IS 'Rol interno del usuario en la aplicación';

-- 6. Restaurar foreign keys para card_assignments
ALTER TABLE card_assignments 
ADD CONSTRAINT fk_card_assignments_user 
FOREIGN KEY (user_id) REFERENCES usuarios(id) ON DELETE CASCADE;

ALTER TABLE card_assignments 
ADD CONSTRAINT fk_card_assignments_assigned_by 
FOREIGN KEY (assigned_by) REFERENCES usuarios(id) ON DELETE CASCADE;

-- 7. Insertar usuario administrador de ejemplo (opcional)
-- Nota: Deberás obtener el keycloak_id real desde Keycloak
-- INSERT INTO usuarios (keycloak_id, email, rol) 
-- VALUES ('00000000-0000-0000-0000-000000000000', 'admin@osmos.es', 'admin');

COMMIT;

-- 8. Verificar la estructura
\d usuarios

SELECT 
    'Tabla usuarios recreada exitosamente' as mensaje,
    COUNT(*) as usuarios_total 
FROM usuarios;