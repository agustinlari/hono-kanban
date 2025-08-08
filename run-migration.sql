-- Script para ejecutar la migración add_can_delete_board_column.sql
-- Ejecutar este archivo en el servidor PostgreSQL

\i /home/osmos/hono-kanban/migrations/add_can_delete_board_column.sql

-- Verificar que las columnas se añadieron correctamente
SELECT 
    column_name, 
    data_type, 
    is_nullable, 
    column_default 
FROM information_schema.columns 
WHERE table_name IN ('board_members', 'permission_roles') 
AND column_name = 'can_delete_board'
ORDER BY table_name, column_name;