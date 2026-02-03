-- Migration: Add packages functionality
-- Execute this script on your remote database

-- Create packages table for physical shipping packages
CREATE TABLE IF NOT EXISTS packages (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50),                    -- Código visible del paquete
    height NUMERIC,                      -- Alto en cm
    width NUMERIC,                       -- Ancho en cm
    depth NUMERIC,                       -- Fondo en cm
    weight NUMERIC,                      -- Peso en kg
    is_consolidated BOOLEAN DEFAULT false, -- Es el paquete consolidado (pallet)
    notes TEXT,                          -- Notas adicionales
    created_by INTEGER,                  -- Usuario que creó el paquete
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Foreign keys
    CONSTRAINT fk_packages_created_by
        FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE SET NULL
);

-- Create cards_packages junction table for M:N relationship
CREATE TABLE IF NOT EXISTS cards_packages (
    id SERIAL PRIMARY KEY,
    card_id UUID NOT NULL,
    package_id INTEGER NOT NULL,
    linked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    linked_by INTEGER,                   -- Usuario que vinculó el paquete

    -- Foreign keys
    CONSTRAINT fk_cards_packages_card
        FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
    CONSTRAINT fk_cards_packages_package
        FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE,
    CONSTRAINT fk_cards_packages_linked_by
        FOREIGN KEY (linked_by) REFERENCES usuarios(id) ON DELETE SET NULL,

    -- Evitar duplicados
    UNIQUE(card_id, package_id)
);

-- Índices para mejorar performance
CREATE INDEX IF NOT EXISTS idx_packages_code ON packages(code);
CREATE INDEX IF NOT EXISTS idx_packages_is_consolidated ON packages(is_consolidated);
CREATE INDEX IF NOT EXISTS idx_packages_created_at ON packages(created_at);

CREATE INDEX IF NOT EXISTS idx_cards_packages_card_id ON cards_packages(card_id);
CREATE INDEX IF NOT EXISTS idx_cards_packages_package_id ON cards_packages(package_id);

-- Comentarios para documentar
COMMENT ON TABLE packages IS 'Paquetes físicos para envío (bultos, pallets)';
COMMENT ON COLUMN packages.code IS 'Código visible del paquete';
COMMENT ON COLUMN packages.height IS 'Alto en centímetros';
COMMENT ON COLUMN packages.width IS 'Ancho en centímetros';
COMMENT ON COLUMN packages.depth IS 'Fondo/profundidad en centímetros';
COMMENT ON COLUMN packages.weight IS 'Peso en kilogramos';
COMMENT ON COLUMN packages.is_consolidated IS 'Indica si es el paquete consolidado (pallet final)';
COMMENT ON COLUMN packages.notes IS 'Notas adicionales sobre el paquete';

COMMENT ON TABLE cards_packages IS 'Tabla de unión entre tarjetas y paquetes (M:N)';
COMMENT ON COLUMN cards_packages.card_id IS 'ID de la tarjeta';
COMMENT ON COLUMN cards_packages.package_id IS 'ID del paquete';
COMMENT ON COLUMN cards_packages.linked_by IS 'Usuario que vinculó el paquete a la tarjeta';

-- Verificar que las tablas fueron creadas correctamente
SELECT
    table_name,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name IN ('packages', 'cards_packages')
ORDER BY table_name, ordinal_position;
