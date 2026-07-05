import { useEffect, useRef, useState } from "react";
import {
  listScenarios,
  deleteScenario,
  getScenario,
  listRagDocuments,
  uploadRagDocument,
  deleteRagDocument,
  updateBotCompanyName,
  type Bot,
  type Scenario,
  type RagDocument,
} from "./api";
import { ChainBuilder } from "./ChainBuilder";
import { ScenarioPromptsView } from "./ScenarioPromptsView";

export function BotDetail({ bot, onBack }: { bot: Bot; onBack: () => void }) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [editingScenario, setEditingScenario] = useState<Scenario | null>(null);
  const [promptsScenario, setPromptsScenario] = useState<Scenario | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [companyName, setCompanyName] = useState(bot.company_name);

  async function handleDelete(scenario: Scenario) {
    if (!confirm(`Удалить сценарий «${scenario.name}»? Это удалит все его процессы и шаги.`)) return;
    setDeletingId(scenario.id);
    try {
      await deleteScenario(scenario.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось удалить");
    } finally {
      setDeletingId(null);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setScenarios(await listScenarios(bot.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  async function openConstructor(scenario: Scenario) {
    try {
      setEditingScenario(await getScenario(scenario.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось открыть конструктор");
    }
  }

  useEffect(() => {
    load();
  }, [bot.id]);

  return (
    <main className="max-w-4xl mx-auto px-6 py-10">
      <button onClick={onBack} className="text-sm text-slate-500 hover:text-red-600 mb-4 transition-colors">
        ← Назад к ботам
      </button>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">🤖 Бот #{bot.id}</h1>
          <p className="text-slate-500 mt-1">Сценарии · всего {scenarios.length}</p>
        </div>
        <button
          onClick={() => setShowGenerate(true)}
          className="bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg px-5 py-2.5 transition-colors"
        >
          ✨ Сгенерировать цепочку
        </button>
      </div>

      <CompanyNameField botId={bot.id} companyName={companyName} onSaved={setCompanyName} />

      {loading && <p className="text-slate-400">Загрузка…</p>}
      {error && <p className="text-red-600">{error}</p>}

      {!loading && !error && scenarios.length === 0 && (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-400">
          Нет сценариев. Постройте цепочку в конструкторе — система сама напишет промпты.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {scenarios.map((s) => (
          <ScenarioCard
            key={s.id}
            scenario={s}
            onOpenPrompts={() => setPromptsScenario(s)}
            onOpenConstructor={() => openConstructor(s)}
            onDelete={() => handleDelete(s)}
            deleting={deletingId === s.id}
          />
        ))}
      </div>

      {showGenerate && (
        <ChainBuilder
          botId={bot.id}
          companyName={companyName}
          onClose={() => setShowGenerate(false)}
          onGenerated={() => {
            setShowGenerate(false);
            load();
          }}
        />
      )}

      {editingScenario && (
        <ChainBuilder
          botId={bot.id}
          companyName={companyName}
          scenario={editingScenario}
          onClose={() => setEditingScenario(null)}
          onGenerated={() => {
            setEditingScenario(null);
            load();
          }}
        />
      )}

      {promptsScenario && (
        <ScenarioPromptsView scenario={promptsScenario} onClose={() => setPromptsScenario(null)} />
      )}

      <RagDocumentsSection botId={bot.id} />
    </main>
  );
}

function CompanyNameField({
  botId,
  companyName,
  onSaved,
}: {
  botId: number;
  companyName: string;
  onSaved: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(companyName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!value.trim()) return setError("Название не может быть пустым");
    setSaving(true);
    setError(null);
    try {
      await updateBotCompanyName(botId, value.trim());
      onSaved(value.trim());
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="mb-6 flex items-center gap-2 text-sm">
        <span className="text-slate-500">Компания:</span>
        {companyName ? (
          <span className="font-medium text-slate-900">{companyName}</span>
        ) : (
          <span className="text-amber-600">не задана — конструктор цепочек не заработает без неё</span>
        )}
        <button onClick={() => setEditing(true)} className="text-red-600 hover:text-red-700 font-medium">
          {companyName ? "изменить" : "задать"}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6 flex items-center gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="напр. Papl.by"
        className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-red-500"
        autoFocus
      />
      <button
        onClick={handleSave}
        disabled={saving}
        className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-3 py-1.5"
      >
        {saving ? "Сохраняем…" : "Сохранить"}
      </button>
      <button onClick={() => setEditing(false)} className="text-sm text-slate-400 hover:text-slate-600">
        Отмена
      </button>
      {error && <span className="text-red-600 text-sm">{error}</span>}
    </div>
  );
}

function RagDocumentsSection({ botId }: { botId: number }) {
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDocuments(await listRagDocuments(botId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [botId]);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadRagDocument(botId, file);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить документ");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(doc: RagDocument) {
    if (!confirm(`Удалить документ «${doc.filename}»?`)) return;
    setDeletingId(doc.id);
    try {
      await deleteRagDocument(doc.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось удалить");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">📄 База знаний (RAG)</h2>
          <p className="text-slate-500 text-sm mt-1">PDF-документы · всего {documents.length}</p>
        </div>
        <label className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold rounded-lg px-5 py-2.5 transition-colors cursor-pointer">
          {uploading ? "Загружаем…" : "+ Загрузить PDF"}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            disabled={uploading}
            onChange={handleFileSelected}
          />
        </label>
      </div>

      {loading && <p className="text-slate-400">Загрузка…</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}

      {!loading && !error && documents.length === 0 && (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-400">
          Пока нет загруженных документов. Загрузите PDF, чтобы бот отвечал на вопросы по его содержимому.
        </div>
      )}

      <div className="flex flex-col gap-2">
        {documents.map((doc) => (
          <div
            key={doc.id}
            className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between"
          >
            <div>
              <div className="font-medium text-slate-900">{doc.filename}</div>
              <div className="text-xs text-slate-400 mt-0.5">{new Date(doc.created_at).toLocaleString("ru-RU")}</div>
            </div>
            <button
              onClick={() => handleDelete(doc)}
              disabled={deletingId === doc.id}
              className="text-sm text-slate-400 hover:text-red-600 disabled:opacity-50 transition-colors"
            >
              {deletingId === doc.id ? "Удаляем…" : "Удалить"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}


function ScenarioCard({
  scenario,
  onOpenPrompts,
  onOpenConstructor,
  onDelete,
  deleting,
}: {
  scenario: Scenario;
  onOpenPrompts: () => void;
  onOpenConstructor: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 hover:shadow-md transition-shadow flex items-center justify-between">
      <div>
        <div className="font-semibold text-slate-900">{scenario.name}</div>
        <div className="text-sm text-slate-400 mt-1">
          Процессов: {scenario.process_ids.length} · {new Date(scenario.created_at).toLocaleDateString("ru-RU")}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <button onClick={onOpenPrompts} className="text-sm text-slate-500 hover:text-red-600 transition-colors">
          📄 Промпты
        </button>
        <button onClick={onOpenConstructor} className="text-sm text-slate-500 hover:text-red-600 transition-colors">
          🧩 Конструктор
        </button>
        <button
          onClick={onDelete}
          disabled={deleting}
          className="text-sm text-slate-400 hover:text-red-600 disabled:opacity-50 transition-colors"
        >
          {deleting ? "Удаляем…" : "Удалить"}
        </button>
      </div>
    </div>
  );
}
