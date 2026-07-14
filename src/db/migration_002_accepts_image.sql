-- Применить в Supabase SQL Editor: шаги сценария теперь можно пометить как принимающие фото
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS accepts_image BOOLEAN NOT NULL DEFAULT false;

-- Цель шага (title) раньше нигде не переживала генерацию — нужна в рантайме, чтобы ImageStepReader
-- знал, что именно извлекать из фото, не гадая по огромному системному промпту задачи.
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
