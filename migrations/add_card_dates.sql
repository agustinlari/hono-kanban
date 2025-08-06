-- Migration: Add start_date and due_date fields to cards table
-- Execute this script on your remote database

-- Add date columns to cards table
ALTER TABLE cards 
ADD COLUMN start_date TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN due_date TIMESTAMP WITH TIME ZONE NULL;

-- Add indexes for performance when filtering by dates
CREATE INDEX idx_cards_start_date ON cards(start_date);
CREATE INDEX idx_cards_due_date ON cards(due_date);

-- Add a comment to document the change
COMMENT ON COLUMN cards.start_date IS 'Fecha de inicio de la tarjeta';
COMMENT ON COLUMN cards.due_date IS 'Fecha de vencimiento de la tarjeta';

-- Optional: Add check constraint to ensure start_date is not after due_date
ALTER TABLE cards 
ADD CONSTRAINT chk_card_dates 
CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);