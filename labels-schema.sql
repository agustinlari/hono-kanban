-- Script SQL para crear el sistema de etiquetas
-- Ejecutar este script en tu base de datos PostgreSQL

-- Tabla de etiquetas por tablero
CREATE TABLE IF NOT EXISTS labels (
    id SERIAL PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(7) NOT NULL, -- Hex color like '#FF5733'  
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(board_id, name) -- No permitir etiquetas duplicadas por tablero
);

-- Tabla de relación many-to-many entre tarjetas y etiquetas
CREATE TABLE IF NOT EXISTS card_labels (
    id SERIAL PRIMARY KEY,
    card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(card_id, label_id) -- Evitar duplicados
);

-- Índices para mejorar rendimiento
CREATE INDEX IF NOT EXISTS idx_labels_board_id ON labels(board_id);
CREATE INDEX IF NOT EXISTS idx_card_labels_card_id ON card_labels(card_id);
CREATE INDEX IF NOT EXISTS idx_card_labels_label_id ON card_labels(label_id);

-- Trigger para actualizar updated_at en labels
CREATE OR REPLACE FUNCTION update_labels_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_labels_updated_at
    BEFORE UPDATE ON labels
    FOR EACH ROW
    EXECUTE FUNCTION update_labels_updated_at();

-- Datos de ejemplo de colores predefinidos para Trello-like labels
-- Colores típicos de Trello
INSERT INTO labels (board_id, name, color) VALUES 
(1, 'Urgente', '#EB5A46'),      -- Rojo
(1, 'En Progreso', '#F2D600'),  -- Amarillo  
(1, 'Completado', '#61BD4F'),   -- Verde
(1, 'Bug', '#FF9F1A'),          -- Naranja
(1, 'Feature', '#0079BF'),      -- Azul
(1, 'Revisión', '#C377E0')      -- Púrpura
ON CONFLICT (board_id, name) DO NOTHING;

-- Verificar que las tablas se crearon correctamente
SELECT 'Tabla labels creada' as verificacion WHERE EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'labels'
);

SELECT 'Tabla card_labels creada' as verificacion WHERE EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'card_labels'
);