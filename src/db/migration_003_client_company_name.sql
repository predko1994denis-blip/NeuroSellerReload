-- Применить в Supabase SQL Editor: у компании (client) появляется отображаемое название,
-- отдельное от email (email — это логин менеджера, не для публичного показа).
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS company_name TEXT NOT NULL DEFAULT '';
