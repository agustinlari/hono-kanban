-- Migración: Añadir campo can_delete_board a la tabla board_members
-- Fecha: 2025-01-08
-- Descripción: Añade el campo can_delete_board para permitir a los owners eliminar tableros

-- Verificar si la columna ya existe antes de añadirla
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'board_members' 
        AND column_name = 'can_delete_board'
    ) THEN
        -- Añadir la nueva columna
        ALTER TABLE board_members 
        ADD COLUMN can_delete_board BOOLEAN NOT NULL DEFAULT FALSE;
        
        -- Establecer can_delete_board = TRUE para todos los owners existentes
        UPDATE board_members 
        SET can_delete_board = TRUE 
        WHERE EXISTS (
            SELECT 1 
            FROM boards b 
            WHERE b.id = board_members.board_id 
            AND b.owner_id = board_members.user_id
        );
        
        RAISE NOTICE 'Columna can_delete_board añadida exitosamente a board_members';
    ELSE
        RAISE NOTICE 'La columna can_delete_board ya existe en board_members';
    END IF;
END $$;

-- También añadir la columna a permission_roles si no existe
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'permission_roles' 
        AND column_name = 'can_delete_board'
    ) THEN
        -- Añadir la nueva columna a permission_roles
        ALTER TABLE permission_roles 
        ADD COLUMN can_delete_board BOOLEAN NOT NULL DEFAULT FALSE;
        
        -- Establecer can_delete_board = TRUE solo para el rol 'owner' si existe
        UPDATE permission_roles 
        SET can_delete_board = TRUE 
        WHERE name = 'owner';
        
        RAISE NOTICE 'Columna can_delete_board añadida exitosamente a permission_roles';
    ELSE
        RAISE NOTICE 'La columna can_delete_board ya existe en permission_roles';
    END IF;
END $$;