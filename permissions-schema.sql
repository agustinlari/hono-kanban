-- Script SQL para crear el sistema de usuarios y permisos por tablero
-- Ejecutar este script en tu base de datos PostgreSQL

-- Modificar la tabla boards para añadir owner_id
ALTER TABLE boards 
ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE;

-- Crear índice para owner_id
CREATE INDEX IF NOT EXISTS idx_boards_owner_id ON boards(owner_id);

-- Tabla de miembros del tablero con permisos específicos
CREATE TABLE IF NOT EXISTS board_members (
    id SERIAL PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    
    -- Permisos específicos (boolean flags)
    can_view BOOLEAN DEFAULT TRUE,           -- Ver el tablero
    can_create_cards BOOLEAN DEFAULT FALSE,  -- Crear tarjetas
    can_edit_cards BOOLEAN DEFAULT FALSE,    -- Editar tarjetas
    can_move_cards BOOLEAN DEFAULT FALSE,    -- Mover tarjetas
    can_delete_cards BOOLEAN DEFAULT FALSE,  -- Eliminar tarjetas
    can_manage_labels BOOLEAN DEFAULT FALSE, -- Gestionar etiquetas
    can_add_members BOOLEAN DEFAULT FALSE,   -- Añadir miembros
    can_remove_members BOOLEAN DEFAULT FALSE,-- Eliminar miembros
    can_edit_board BOOLEAN DEFAULT FALSE,    -- Editar info del tablero
    
    -- Metadatos
    invited_by INTEGER REFERENCES usuarios(id), -- Quién invitó a este usuario
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Evitar duplicados
    UNIQUE(board_id, user_id)
);

-- Índices para mejor rendimiento
CREATE INDEX IF NOT EXISTS idx_board_members_board_id ON board_members(board_id);
CREATE INDEX IF NOT EXISTS idx_board_members_user_id ON board_members(user_id);
CREATE INDEX IF NOT EXISTS idx_board_members_permissions ON board_members(board_id, user_id, can_view);

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_board_members_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_board_members_updated_at
    BEFORE UPDATE ON board_members
    FOR EACH ROW
    EXECUTE FUNCTION update_board_members_updated_at();

-- Función para crear automáticamente al owner como admin del tablero
CREATE OR REPLACE FUNCTION create_board_owner_member()
RETURNS TRIGGER AS $$
BEGIN
    -- Solo si el tablero tiene owner_id y no existe ya el miembro
    IF NEW.owner_id IS NOT NULL THEN
        INSERT INTO board_members (
            board_id, user_id, 
            can_view, can_create_cards, can_edit_cards, can_move_cards, 
            can_delete_cards, can_manage_labels, can_add_members, 
            can_remove_members, can_edit_board, invited_by
        ) VALUES (
            NEW.id, NEW.owner_id,
            TRUE, TRUE, TRUE, TRUE, 
            TRUE, TRUE, TRUE, 
            TRUE, TRUE, NEW.owner_id
        )
        ON CONFLICT (board_id, user_id) DO UPDATE SET
            can_view = TRUE,
            can_create_cards = TRUE,
            can_edit_cards = TRUE,
            can_move_cards = TRUE,
            can_delete_cards = TRUE,
            can_manage_labels = TRUE,
            can_add_members = TRUE,
            can_remove_members = TRUE,
            can_edit_board = TRUE,
            updated_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger que se ejecuta después de insertar/actualizar un tablero
CREATE TRIGGER trigger_create_board_owner_member
    AFTER INSERT OR UPDATE OF owner_id ON boards
    FOR EACH ROW
    EXECUTE FUNCTION create_board_owner_member();

-- Vista para obtener permisos de usuario fácilmente
CREATE OR REPLACE VIEW user_board_permissions AS
SELECT 
    bm.board_id,
    bm.user_id,
    b.name as board_name,
    u.email as user_email,
    (b.owner_id = bm.user_id) as is_owner,
    bm.can_view,
    bm.can_create_cards,
    bm.can_edit_cards,
    bm.can_move_cards,
    bm.can_delete_cards,
    bm.can_manage_labels,
    bm.can_add_members,
    bm.can_remove_members,
    bm.can_edit_board,
    bm.joined_at,
    bm.updated_at
FROM board_members bm
INNER JOIN boards b ON bm.board_id = b.id
INNER JOIN usuarios u ON bm.user_id = u.id;

-- Roles predefinidos para facilitar la asignación
CREATE TABLE IF NOT EXISTS permission_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    can_view BOOLEAN DEFAULT TRUE,
    can_create_cards BOOLEAN DEFAULT FALSE,
    can_edit_cards BOOLEAN DEFAULT FALSE,
    can_move_cards BOOLEAN DEFAULT FALSE,
    can_delete_cards BOOLEAN DEFAULT FALSE,
    can_manage_labels BOOLEAN DEFAULT FALSE,
    can_add_members BOOLEAN DEFAULT FALSE,
    can_remove_members BOOLEAN DEFAULT FALSE,
    can_edit_board BOOLEAN DEFAULT FALSE
);

-- Insertar roles predefinidos
INSERT INTO permission_roles (name, description, can_view, can_create_cards, can_edit_cards, can_move_cards, can_delete_cards, can_manage_labels, can_add_members, can_remove_members, can_edit_board) VALUES
('viewer', 'Solo puede ver el tablero', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
('editor', 'Puede crear y editar tarjetas', TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
('contributor', 'Editor + puede gestionar etiquetas', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, FALSE),
('moderator', 'Contributor + gestión de usuarios', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE),
('admin', 'Todos los permisos excepto eliminar tablero', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE)
ON CONFLICT (name) DO NOTHING;

-- Actualizar tableros existentes para asignar owner_id (opcional, ajustar según necesidad)
-- UPDATE boards SET owner_id = 1 WHERE owner_id IS NULL; -- Asignar al primer usuario

-- Verificaciones
SELECT 'Columna owner_id añadida a boards' as verificacion WHERE EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'boards' AND column_name = 'owner_id'
);

SELECT 'Tabla board_members creada' as verificacion WHERE EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'board_members'
);

SELECT 'Tabla permission_roles creada' as verificacion WHERE EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'permission_roles'
);

SELECT 'Vista user_board_permissions creada' as verificacion WHERE EXISTS (
    SELECT FROM information_schema.views 
    WHERE table_schema = 'public' AND table_name = 'user_board_permissions'
);