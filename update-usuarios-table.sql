-- Script para añadir campos created_at y updated_at a la tabla usuarios
-- Ejecutar este script en tu base de datos PostgreSQL

-- Añadir columnas created_at y updated_at a la tabla usuarios
ALTER TABLE usuarios 
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Crear trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_usuarios_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Crear trigger que se ejecuta antes de cada UPDATE
CREATE TRIGGER trigger_update_usuarios_updated_at
    BEFORE UPDATE ON usuarios
    FOR EACH ROW
    EXECUTE FUNCTION update_usuarios_updated_at();

-- Actualizar registros existentes para que tengan created_at si es NULL
-- (Esto es opcional, ajusta según necesites)
UPDATE usuarios 
SET created_at = NOW() 
WHERE created_at IS NULL;

UPDATE usuarios 
SET updated_at = NOW() 
WHERE updated_at IS NULL;

-- Verificar que las columnas se añadieron correctamente
SELECT 'Columnas created_at y updated_at añadidas a usuarios' as verificacion WHERE EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'usuarios' AND column_name = 'created_at'
) AND EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'usuarios' AND column_name = 'updated_at'
);

-- Ver la estructura actualizada de la tabla
SELECT column_name, data_type, column_default, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'usuarios' 
ORDER BY ordinal_position;