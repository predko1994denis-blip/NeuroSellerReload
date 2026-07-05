CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, -- null = admin, видит все компании
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bots (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  telegram_token TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  rag_enabled BOOLEAN NOT NULL DEFAULT false,
  teacher_mode_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE processes (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  process_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, process_number)
);

CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  task_number TEXT NOT NULL, -- "X.Y", напр. "1.0"
  task_description TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('simple', 'analytical', 'completion')),
  model TEXT NOT NULL,
  temperature REAL NOT NULL DEFAULT 0.7,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  required BOOLEAN NOT NULL DEFAULT true, -- при исчерпании попыток обязательный шаг ведёт в fallback, необязательный — просто дальше
  is_fallback BOOLEAN NOT NULL DEFAULT false, -- true у completion-задачи для случая "не смогли собрать обязательные данные"
  context_strategy_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (process_id, task_number)
);

CREATE TABLE dialogs (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  current_process INTEGER NOT NULL,
  current_task_id TEXT NOT NULL,
  process_tasks JSONB NOT NULL DEFAULT '{}',
  task_attempts JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  greeted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- быстрый поиск активного диалога юзера в боте (главный запрос всего флоу)
CREATE INDEX idx_dialogs_active_lookup ON dialogs (bot_id, chat_id) WHERE is_active = true;

CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  dialog_id INTEGER NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_dialog_id ON messages (dialog_id);

CREATE TABLE bot_reminder_settings (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL, -- порядок в цепочке: 1, 2, 3...
  delay_minutes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, step_order)
);

CREATE TABLE reminders (
  id SERIAL PRIMARY KEY,
  dialog_id INTEGER NOT NULL UNIQUE REFERENCES dialogs(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL, -- какой шаг цепочки сработает следующим
  next_fire_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ReminderProcessor каждые 15 сек ищет именно по этому условию
CREATE INDEX idx_reminders_due ON reminders (next_fire_at);

CREATE TABLE crm_settings (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
  amocrm_subdomain TEXT NOT NULL,
  amocrm_access_token TEXT NOT NULL,
  manager_id BIGINT NOT NULL, -- responsible_user_id в AmoCRM
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crm_leads (
  id SERIAL PRIMARY KEY,
  dialog_id INTEGER NOT NULL UNIQUE REFERENCES dialogs(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  information JSONB NOT NULL DEFAULT '{}', -- прочие кастомные поля из ответов LLM
  processed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rag_documents (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rag_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL, -- text-embedding-3-small
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Без индекса cosine-поиск делает full scan — нормально для сотен/тысяч чанков.
-- При росте базы знаний (десятки тысяч+) сюда нужен HNSW/IVFFlat индекс.
CREATE INDEX idx_rag_chunks_document_id ON rag_chunks (document_id);

CREATE TABLE scenarios (
  id SERIAL PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company_name TEXT NOT NULL,
  graph JSONB NOT NULL, -- {nodes, edges} конструктора, чтобы можно было открыть и отредактировать снова
  style JSONB, -- 10 стилевых параметров (ScenarioStyle); null = использовать дефолтный пресет
  goals JSONB NOT NULL DEFAULT '[]', -- явный список целей сценария, задаётся пользователем в общих настройках
  non_goals JSONB NOT NULL DEFAULT '[]', -- явный список того, с чем бот НЕ помогает — пограничные случаи для защиты темы
  generation_cache JSONB NOT NULL DEFAULT '{}', -- отпечаток шага -> сгенерированный текст, для инкрементальной пересборки
  process_ids INTEGER[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE message_attachments (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('audio', 'image', 'document')),
  storage_path TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
