-- Migration: Add start_date and due_date fields to cards table (SAFE VERSION)
-- Execute this script on your remote database
-- This version checks if columns already exist before adding them

-- Add date columns to cards table only if they don't exist
DO $$ 
BEGIN
    -- Check if start_date column exists
    IF NOT EXISTS (
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='cards' AND column_name='start_date'
    ) THEN
        ALTER TABLE cards ADD COLUMN start_date TIMESTAMP WITH TIME ZONE NULL;
        RAISE NOTICE 'Added start_date column to cards table';
    ELSE
        RAISE NOTICE 'start_date column already exists in cards table';
    END IF;

    -- Check if due_date column exists
    IF NOT EXISTS (
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='cards' AND column_name='due_date'
    ) THEN
        ALTER TABLE cards ADD COLUMN due_date TIMESTAMP WITH TIME ZONE NULL;
        RAISE NOTICE 'Added due_date column to cards table';
    ELSE
        RAISE NOTICE 'due_date column already exists in cards table';
    END IF;
END $$;

-- Add indexes for performance when filtering by dates (only if they don't exist)
CREATE INDEX IF NOT EXISTS idx_cards_start_date ON cards(start_date);
CREATE INDEX IF NOT EXISTS idx_cards_due_date ON cards(due_date);

-- Add comments to document the change
COMMENT ON COLUMN cards.start_date IS 'Fecha de inicio de la tarjeta';
COMMENT ON COLUMN cards.due_date IS 'Fecha de vencimiento de la tarjeta';

-- Add check constraint to ensure start_date is not after due_date (only if it doesn't exist)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT constraint_name 
        FROM information_schema.check_constraints 
        WHERE constraint_name='chk_card_dates'
    ) THEN
        ALTER TABLE cards 
        ADD CONSTRAINT chk_card_dates 
        CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);
        RAISE NOTICE 'Added chk_card_dates constraint';
    ELSE
        RAISE NOTICE 'chk_card_dates constraint already exists';
    END IF;
END $$;

-- Verify the columns were added
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'cards' AND column_name IN ('start_date', 'due_date');