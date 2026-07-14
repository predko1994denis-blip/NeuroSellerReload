import { useEffect, useRef, useState } from "react";
import {
  listScenarios,
  deleteScenario,
  getScenario,
  listRagDocuments,
  uploadRagDocument,
  deleteRagDocument,
  updateBotCompanyName,
  updateBotRagEnabled,
  listFeedback,
  setFeedbackResolved,
  type Bot,
  type Scenario,
  type RagDocument,
  type FeedbackItem,
} from "./api";
import { ChainBuilder } from "./ChainBuilder";
import { ScenarioPromptsView } from "./ScenarioPromptsView";
import { getSession } from "./auth";

export function BotDetail({ bot, onBack }: { bot: Bot; onBack: () => void }) {
  // Редактирование сценариев/промптов — только для настройщика (admin). Менеджер их не трогает.
  const isAdmin = getSession()?.role === "admin";
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [editingScenario, setEditingScenario] = useState<Scenario | null>(null);
  const [promptsScenario, setPromptsScenario] = useState<Scenario | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [companyName, setCompanyName] = useState(bot.company_name);
  const [showFeedback, setShowFeedback] = useState(false);
  const [unresolvedCount, setUnresolvedCount] = useState<number | null>(null);

  async function loadFeedbackCount() {
    if (!isAdmin) return;
    try {
      const items = await listFeedback(bot.id);
      setUnresolvedCount(items.filter((f) => !f.resolved).length);
    } catch {
      // тихо игнорируем — это просто счётчик на кнопке
    }
  }

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
    loadFeedbackCount();
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
        {isAdmin && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowFeedback(true)}
              className="relative border border-slate-300 text-slate-700 font-medium rounded-lg px-4 py-2.5 hover:bg-slate-50 transition-colors"
            >
              📝 Пометки менеджера
              {!!unresolvedCount && (
                <span className="absolute -top-2 -right-2 bg-amber-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {unresolvedCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setShowGenerate(true)}
              className="bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg px-5 py-2.5 transition-colors"
            >
              ✨ Сгенерировать цепочку
            </button>
          </div>
        )}
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
            isAdmin={isAdmin}
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

      {showFeedback && (
        <FeedbackPanel
          botId={bot.id}
          onClose={() => setShowFeedback(false)}
          onChanged={loadFeedbackCount}
        />
      )}

      <RagDocumentsSection botId={bot.id} initialRagEnabled={bot.rag_enabled} />
    </main>
  );
}

function FeedbackPanel({ botId, onClose, onChanged }: { botId: number; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await listFeedback(botId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [botId]);

  async function toggle(id: number, resolved: boolean) {
    setBusyId(id);
    try {
      await setFeedbackResolved(id, resolved);
      await load();
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  const visible = showResolved ? items : items.filter((f) => !f.resolved);
  const unresolvedCount = items.filter((f) => !f.resolved).length;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-bold text-slate-900">📝 Пометки менеджера</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {unresolvedCount === 0 ? "Всё разобрано" : `Не разобрано: ${unresolvedCount}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
              показывать разобранные
            </label>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && <p className="text-slate-400 text-sm">Загрузка…</p>}
          {error && <p className="text-red-600 text-sm">{error}</p>}

          {!loading && !error && visible.length === 0 && (
            <div className="text-center text-slate-400 py-10">
              {items.length === 0 ? "Пока нет пометок от менеджера." : "Все пометки разобраны 🎉"}
            </div>
          )}

          <div className="flex flex-col gap-3">
            {visible.map((f) => (
              <div
                key={f.id}
                className={
                  "rounded-xl border p-4 " +
                  (f.resolved ? "border-slate-200 bg-slate-50 opacity-60" : "border-amber-200 bg-amber-50/50")
                }
              >
                {f.user_message && (
                  <div className="text-xs text-slate-500 mb-2">
                    <span className="font-medium">Клиент:</span> {f.user_message}
                  </div>
                )}
                <div className="text-xs text-slate-500 mb-2">
                  <span className="font-medium">Ответил бот:</span> {f.original_answer}
                </div>
                <div className="text-xs text-amber-800 bg-amber-100 rounded-lg px-3 py-2">
                  <span className="font-semibold">Менеджер: </span>
                  {f.suggested_answer}
                </div>
                <div className="flex items-center justify-between mt-3">
                  <span className="text-[11px] text-slate-400">
                    {new Date(f.created_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <button
                    onClick={() => toggle(f.id, !f.resolved)}
                    disabled={busyId === f.id}
                    className={
                      "text-xs font-medium rounded-lg px-3 py-1.5 disabled:opacity-50 transition-colors " +
                      (f.resolved
                        ? "border border-slate-300 text-slate-600 hover:bg-slate-100"
                        : "bg-emerald-600 hover:bg-emerald-700 text-white")
                    }
                  >
                    {f.resolved ? "↺ вернуть в работу" : "✓ разобрано"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
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

function RagDocumentsSection({ botId, initialRagEnabled }: { botId: number; initialRagEnabled: boolean }) {
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [ragEnabled, setRagEnabled] = useState(initialRagEnabled);
  const [togglingRag, setTogglingRag] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function toggleRag() {
    const next = !ragEnabled;
    setTogglingRag(true);
    setError(null);
    setRagEnabled(next); // оптимистично
    try {
      await updateBotRagEnabled(botId, next);
    } catch (err) {
      setRagEnabled(!next); // откат при ошибке
      setError(err instanceof Error ? err.message : "Не удалось переключить RAG");
    } finally {
      setTogglingRag(false);
    }
  }

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
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleRag}
            disabled={togglingRag}
            title={ragEnabled ? "RAG включён — бот использует документы" : "RAG выключен — документы игнорируются"}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium border transition-colors disabled:opacity-50 ${
              ragEnabled
                ? "bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
                : "bg-slate-50 border-slate-300 text-slate-500 hover:bg-slate-100"
            }`}
          >
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${ragEnabled ? "bg-emerald-500" : "bg-slate-400"}`} />
            RAG {ragEnabled ? "включён" : "выключен"}
          </button>
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
      </div>

      {!ragEnabled && documents.length > 0 && (
        <p className="text-amber-600 text-sm mb-3">
          ⚠️ RAG выключен — загруженные документы сейчас игнорируются ботом. Включите переключатель выше, чтобы бот отвечал по ним.
        </p>
      )}

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
  isAdmin,
  onOpenPrompts,
  onOpenConstructor,
  onDelete,
  deleting,
}: {
  scenario: Scenario;
  isAdmin: boolean;
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
        {isAdmin && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
