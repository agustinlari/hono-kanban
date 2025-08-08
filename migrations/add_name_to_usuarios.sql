-- ================================
-- Añadir campo 'name' a tabla usuarios
-- ================================

BEGIN;

-- 1. Añadir columna 'name' a la tabla usuarios
ALTER TABLE usuarios 
ADD COLUMN name TEXT;

-- 2. Crear índice para búsquedas por nombre
CREATE INDEX idx_usuarios_name ON usuarios(name);

-- 3. Agregar comentario
COMMENT ON COLUMN usuarios.name IS 'Nombre completo del usuario obtenido de Keycloak';

-- 4. Actualizar nombres existentes (si los hay) - opcional
-- UPDATE usuarios SET name = email WHERE name IS NULL;

COMMIT;

-- 5. Verificar la estructura
\d usuarios

SELECT 
    'Campo name añadido exitosamente' as mensaje,
    COUNT(*) as usuarios_total 
FROM usuarios;