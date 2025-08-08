-- ================================
-- Recrear tabla usuarios para Keycloak (VERSIÓN SEGURA)
-- ================================
-- CUIDADO: Este script elimina todos los usuarios existentes y sus asignaciones
-- Solo usar en desarrollo/pre-producción

BEGIN;

-- 1. Limpiar TODAS las asignaciones existentes (para evitar problemas de FK)
DELETE FROM card_assignments;
COMMENT ON TABLE card_assignments IS 'Tabla limpiada - se recrearán las asignaciones después';

-- 2. Eliminar restricciones de foreign keys que dependen de usuarios
ALTER TABLE card_assignments DROP CONSTRAINT IF EXISTS fk_card_assignments_user;
ALTER TABLE card_assignments DROP CONSTRAINT IF EXISTS fk_card_assignments_assigned_by;

-- 3. También limpiar otras tablas que podrían referenciar usuarios
-- (Ajusta según las tablas que tengas en tu esquema)
DELETE FROM board_members WHERE user_id IN (SELECT id FROM usuarios);

-- 4. Eliminar tabla usuarios actual
DROP TABLE IF EXISTS usuarios CASCADE;

-- 5. Recrear tabla usuarios con estructura optimizada para Keycloak
CREATE TABLE usuarios (
    id SERIAL PRIMARY KEY,
    keycloak_id UUID UNIQUE NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT, -- Opcional, solo para compatibilidad
    rol user_role DEFAULT 'user' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Crear índices para rendimiento
CREATE INDEX idx_usuarios_keycloak_id ON usuarios(keycloak_id);
CREATE INDEX idx_usuarios_email ON usuarios(email);
CREATE INDEX idx_usuarios_rol ON usuarios(rol);

-- 7. Agregar comentarios para documentación
COMMENT ON TABLE usuarios IS 'Usuarios del sistema integrados con Keycloak';
COMMENT ON COLUMN usuarios.keycloak_id IS 'UUID del usuario en Keycloak (requerido)';
COMMENT ON COLUMN usuarios.email IS 'Email del usuario sincronizado con Keycloak';
COMMENT ON COLUMN usuarios.password_hash IS 'Hash de contraseña (obsoleto, solo para compatibilidad)';
COMMENT ON COLUMN usuarios.rol IS 'Rol interno del usuario en la aplicación';

-- 8. Restaurar foreign keys para card_assignments
ALTER TABLE card_assignments 
ADD CONSTRAINT fk_card_assignments_user 
FOREIGN KEY (user_id) REFERENCES usuarios(id) ON DELETE CASCADE;

ALTER TABLE card_assignments 
ADD CONSTRAINT fk_card_assignments_assigned_by 
FOREIGN KEY (assigned_by) REFERENCES usuarios(id) ON DELETE CASCADE;

-- 9. Insertar usuario administrador de ejemplo (opcional)
-- Nota: El keycloak_id se generará automáticamente cuando hagas login por primera vez
-- INSERT INTO usuarios (keycloak_id, email, rol) 
-- VALUES ('00000000-0000-0000-0000-000000000000', 'admin@osmos.es', 'admin');

COMMIT;

-- 10. Verificar la estructura
\d usuarios

SELECT 
    'Tabla usuarios recreada exitosamente' as mensaje,
    COUNT(*) as usuarios_total 
FROM usuarios;

SELECT 
    'Tabla card_assignments limpiada' as mensaje,
    COUNT(*) as asignaciones_total 
FROM card_assignments;

COMMENT ON DATABASE kanban IS 'Base de datos migrada a Keycloak - ' || CURRENT_TIMESTAMP;