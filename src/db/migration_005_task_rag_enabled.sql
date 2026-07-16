-- Применить в Supabase SQL Editor: шаг сценария можно пометить как сверяющийся с базой знаний
-- (RAG) перед тем, как считать цель достигнутой — см. buildRagBlock в ProcessGenerator.
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS rag_enabled BOOLEAN NOT NULL DEFAULT false;
