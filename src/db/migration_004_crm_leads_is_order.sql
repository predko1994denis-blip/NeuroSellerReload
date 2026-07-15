-- Применить в Supabase SQL Editor: помечаем лиды, у которых диалог реально дошёл до
-- успешного завершения (не fallback после исчерпанных попыток) — это и есть "заказ".
ALTER TABLE crm_leads
ADD COLUMN IF NOT EXISTS is_order BOOLEAN NOT NULL DEFAULT false;
