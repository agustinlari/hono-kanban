-- Migration: Add card assignments functionality
-- Execute this script on your remote database

-- Create card_assignments table to link users to cards
CREATE TABLE IF NOT EXISTS card_assignments (
    id SERIAL PRIMARY KEY,
    card_id UUID NOT NULL,
    user_id INTEGER NOT NULL,
    assigned_by INTEGER NOT NULL, -- Usuario que realizó la asignación
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Foreign keys
    CONSTRAINT fk_card_assignments_card 
        FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
    CONSTRAINT fk_card_assignments_user 
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_card_assignments_assigned_by 
        FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE CASCADE,
    
    -- Evitar asignaciones duplicadas
    UNIQUE(card_id, user_id)
);

-- Índices para mejorar performance
CREATE INDEX IF NOT EXISTS idx_card_assignments_card_id ON card_assignments(card_id);
CREATE INDEX IF NOT EXISTS idx_card_assignments_user_id ON card_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_card_assignments_assigned_at ON card_assignments(assigned_at);

-- Comentarios para documentar
COMMENT ON TABLE card_assignments IS 'Tabla que vincula usuarios asignados a tarjetas';
COMMENT ON COLUMN card_assignments.card_id IS 'ID de la tarjeta';
COMMENT ON COLUMN card_assignments.user_id IS 'ID del usuario asignado';
COMMENT ON COLUMN card_assignments.assigned_by IS 'ID del usuario que realizó la asignación';
COMMENT ON COLUMN card_assignments.assigned_at IS 'Fecha y hora de la asignación';

-- Verificar que la tabla fue creada correctamente
SELECT 
    table_name,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns 
WHERE table_name = 'card_assignments'
ORDER BY ordinal_position;