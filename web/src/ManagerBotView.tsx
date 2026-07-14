import { useEffect, useRef, useState } from "react";
import {
  listDialogs,
  getDialogMessages,
  saveMessageFeedback,
  deleteMessageFeedback,
  setDialogActive,
  takeoverDialog,
  releaseDialog,
  sendDialogMessage,
  type Bot,
  type DialogSummary,
  type DialogMessage,
} from "./api";

type Tab = "dialogs" | "stats";

export function ManagerBotView({ bot, onBack }: { bot: Bot; onBack?: () => void }) {
  const [tab, setTab] = useState<Tab>("dialogs");

  return (
    <main className="max-w-6xl mx-auto px-6 py-8 ns-fade-in">
      {onBack && (
        <button
          onClick={onBack}
          className="text-sm text-slate-400 hover:text-slate-700 mb-5 transition-colors inline-flex items-center gap-1"
        >
          ← Назад к ботам
        </button>
      )}

      {/* Шапка + сегмент-табы */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <h1 className="text-xl font-bold text-slate-900 leading-tight">{bot.company_name || "Ваш бот"}</h1>

        <div className="inline-flex bg-slate-100 rounded-xl p-1">
          <SegTab active={tab === "dialogs"} onClick={() => setTab("dialogs")}>
            Диалоги
          </SegTab>
          <SegTab active={tab === "stats"} onClick={() => setTab("stats")}>
            Статистика
          </SegTab>
        </div>
      </div>

      {tab === "dialogs" ? <DialogsTab botId={bot.id} /> : <StatsStub botId={bot.id} />}
    </main>
  );
}

function SegTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "text-sm font-medium rounded-lg px-4 py-1.5 transition-all " +
        (active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700")
      }
    >
      {children}
    </button>
  );
}

/* ─────────────── Диалоги ─────────────── */

function DialogsTab({ botId }: { botId: number }) {
  const [dialogs, setDialogs] = useState<DialogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Тихая перезагрузка списка (без спиннера) — для поллинга и после действий (перехват/статус).
  function reloadDialogsSilently() {
    listDialogs(botId)
      .then((d) => setDialogs(d))
      .catch(() => {});
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    listDialogs(botId)
      .then((d) => {
        setDialogs(d);
        setSelectedId((cur) => cur ?? d[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Ошибка"))
      .finally(() => setLoading(false));
  }, [botId]);

  // Лёгкий поллинг списка — чтобы новые диалоги/статусы перехвата появлялись без ручного обновления.
  useEffect(() => {
    const t = setInterval(reloadDialogsSilently, 6000);
    return () => clearInterval(t);
  }, [botId]);

  if (loading) return <PanelSkeleton />;
  if (error) return <ErrorBox text={error} />;
  if (dialogs.length === 0)
    return (
      <EmptyBox emoji="💬" title="Пока нет диалогов" subtitle="Как только клиенты напишут боту — диалоги появятся здесь." />
    );

  // Стабильная нумерация: №1 — самый первый диалог (по времени создания), независимо от сортировки списка.
  const numById = new Map<number, number>();
  [...dialogs]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .forEach((d, i) => numById.set(d.id, i + 1));

  return (
    <div className="grid grid-cols-[300px_1fr] gap-4 h-[72vh]">
      {/* Список диалогов */}
      <aside className="bg-white rounded-2xl border border-slate-200 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">Диалоги</span>
          <span className="text-xs font-medium text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">
            {dialogs.length}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto ns-scroll p-2 flex flex-col gap-1">
          {dialogs.map((d) => (
            <DialogListItem
              key={d.id}
              d={d}
              num={numById.get(d.id)!}
              active={selectedId === d.id}
              onClick={() => setSelectedId(d.id)}
            />
          ))}
        </div>
      </aside>

      {/* Переписка */}
      <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col">
        {selectedId ? (
          <Transcript
            dialog={dialogs.find((d) => d.id === selectedId)!}
            num={numById.get(selectedId)!}
            onDialogChanged={reloadDialogsSilently}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400">Выберите диалог</div>
        )}
      </section>
    </div>
  );
}

function DialogListItem({ d, num, active, onClick }: { d: DialogSummary; num: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        "text-left rounded-xl p-2.5 transition-colors flex items-center gap-3 " +
        (active ? "bg-red-50 ring-1 ring-red-200" : "hover:bg-slate-50")
      }
    >
      <div className="relative shrink-0">
        <div
          className={
            "w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm " +
            (active ? "bg-red-600 text-white" : "bg-slate-200 text-slate-600")
          }
        >
          {num}
        </div>
        <span
          className={
            "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white " +
            (d.is_active ? "bg-emerald-500" : "bg-slate-300")
          }
          title={d.is_active ? "активен" : "завершён"}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={"text-sm truncate flex items-center gap-1 " + (active ? "font-semibold text-slate-900" : "font-medium text-slate-700")}>
            Диалог {num}
            {d.taken_over_by !== null && <span title="Перехвачен">🖐️</span>}
          </span>
          <span className="text-[11px] text-slate-400 shrink-0">{relativeTime(d.last_message_at ?? d.created_at)}</span>
        </div>
        <div className="text-xs text-slate-400 mt-0.5">{d.message_count} сообщ.</div>
      </div>
    </button>
  );
}

function Transcript({
  dialog,
  num,
  onDialogChanged,
}: {
  dialog: DialogSummary;
  num: number;
  onDialogChanged: () => void;
}) {
  const [messages, setMessages] = useState<DialogMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [takenOver, setTakenOver] = useState(dialog.taken_over_by !== null);
  const [isActive, setIsActive] = useState(dialog.is_active);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  function reload(scrollToBottom = false) {
    setLoading(true);
    getDialogMessages(dialog.id)
      .then((m) => {
        setMessages(m);
        if (scrollToBottom) requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setTakenOver(dialog.taken_over_by !== null);
    setIsActive(dialog.is_active);
    reload(true);
  }, [dialog.id]);

  // Поллинг переписки — чтобы видеть новые сообщения клиента, пока диалог открыт (особенно важно
  // во время перехвата: бот молчит, и без опроса менеджер не узнает, что клиент уже ответил).
  useEffect(() => {
    const t = setInterval(() => reload(), 3000);
    return () => clearInterval(t);
  }, [dialog.id]);

  const markedCount = messages.filter((m) => m.feedback).length;

  async function handleToggleActive() {
    const next = !isActive;
    // Завершение — необратимо в том смысле, что следующее сообщение клиента продолжит НЕ этот
    // диалог, а начнёт новый с нуля. Предупреждаем перед выключением, чтобы не щёлкнуть случайно.
    if (!next && !confirm("Пометить диалог завершённым? Если клиент напишет снова, начнётся НОВЫЙ диалог с нуля — этот продолжить будет нельзя.")) {
      return;
    }
    setBusy(true);
    try {
      await setDialogActive(dialog.id, next);
      setIsActive(next);
      if (!next) setTakenOver(false); // сервер сам отпускает перехват при завершении — синхронизируем локально
      onDialogChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleTakeover() {
    setBusy(true);
    try {
      await takeoverDialog(dialog.id);
      setTakenOver(true);
      onDialogChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleRelease() {
    setBusy(true);
    try {
      await releaseDialog(dialog.id);
      setTakenOver(false);
      onDialogChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Шапка переписки */}
      <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3 shrink-0">
        <div className="w-9 h-9 rounded-full bg-red-600 text-white flex items-center justify-center font-bold text-sm shrink-0">
          {num}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-800 truncate">Диалог {num}</div>
          <div className="text-xs text-slate-400 truncate">
            {dialog.message_count} сообщений
            {markedCount > 0 && <span className="text-amber-600"> · {markedCount} отмечено</span>}
          </div>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-slate-500 shrink-0 cursor-pointer">
          <input type="checkbox" checked={isActive} onChange={handleToggleActive} disabled={busy} />
          {isActive ? "активен" : "завершён"}
        </label>

        {takenOver ? (
          <button
            onClick={handleRelease}
            disabled={busy}
            className="text-xs font-medium rounded-full px-3 py-1.5 shrink-0 bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50 transition-colors"
          >
            🖐️ Отпустить
          </button>
        ) : (
          <button
            onClick={handleTakeover}
            disabled={busy}
            className="text-xs font-medium rounded-full px-3 py-1.5 shrink-0 border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            🖐️ Перехватить
          </button>
        )}
      </div>

      {takenOver && (
        <div className="px-5 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-800">
          Диалог перехвачен — бот не отвечает автоматически, пока вы не нажмёте «Отпустить».
        </div>
      )}

      {/* Лента сообщений */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto ns-scroll px-5 py-4 bg-slate-50/50">
        {loading && messages.length === 0 ? (
          <div className="text-slate-400 text-sm">Загрузка…</div>
        ) : (
          <div className="flex flex-col gap-1">
            {withDayDividers(messages).map((item, i) =>
              item.type === "divider" ? (
                <DayDivider key={"d" + i} label={item.label} />
              ) : (
                <MessageBubble key={item.message.id} message={item.message} onChanged={reload} />
              )
            )}
          </div>
        )}
      </div>

      {takenOver && <Composer dialogId={dialog.id} onSent={() => reload(true)} />}
    </>
  );
}

function Composer({ dialogId, onSent }: { dialogId: number; onSent: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      await sendDialogMessage(dialogId, trimmed);
      setText("");
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка отправки");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="px-5 py-3 border-t border-slate-100 shrink-0">
      {error && <div className="text-xs text-red-600 mb-1.5">{error}</div>}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Написать клиенту от имени бота…"
          className="flex-1 text-sm border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 resize-none"
        />
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium rounded-xl px-4 py-2 shrink-0 transition-colors"
        >
          {sending ? "…" : "Отправить"}
        </button>
      </div>
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center my-3">
      <span className="text-[11px] font-medium text-slate-400 bg-white border border-slate-200 rounded-full px-3 py-1">
        {label}
      </span>
    </div>
  );
}

function MessageBubble({ message, onChanged }: { message: DialogMessage; onChanged: () => void }) {
  const isBot = message.role === "assistant";
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.feedback ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await saveMessageFeedback(message.id, text.trim());
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await deleteMessageFeedback(message.id);
      setText("");
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  const isOperator = message.sent_by !== null;

  return (
    <div className={"group flex flex-col mb-2 " + (isBot ? "items-start" : "items-end")}>
      {isOperator && <span className="text-[10px] font-medium text-slate-400 mb-0.5 ml-1">🧑‍💼 оператор</span>}
      <div className={"flex items-end gap-2 max-w-[80%] " + (isBot ? "" : "flex-row-reverse")}>
        <div
          className={
            "rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ns-pop-in " +
            (isBot
              ? "bg-white border border-slate-200 text-slate-800 rounded-bl-md shadow-sm"
              : "bg-red-600 text-white rounded-br-md shadow-sm")
          }
        >
          {message.content}
        </div>
        <span className="text-[10px] text-slate-300 shrink-0 pb-1">{timeLabel(message.created_at)}</span>
      </div>

      {/* Пометки — только на ответах бота */}
      {isBot && (
        <div className="mt-1 ml-0 max-w-[80%] w-full">
          {message.feedback && !editing && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
              <span className="text-amber-500 shrink-0">✎</span>
              <div className="flex-1">
                <div className="font-semibold text-amber-700 mb-0.5">Как надо было ответить</div>
                <div className="whitespace-pre-wrap">{message.feedback}</div>
                <div className="mt-1.5 flex gap-3">
                  <button onClick={() => setEditing(true)} className="text-amber-600 hover:text-amber-800 font-medium">
                    изменить
                  </button>
                  <button onClick={remove} disabled={saving} className="text-amber-600/70 hover:text-amber-800">
                    снять
                  </button>
                </div>
              </div>
            </div>
          )}

          {!message.feedback && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-slate-400 hover:text-red-600 transition-all opacity-0 group-hover:opacity-100 inline-flex items-center gap-1"
            >
              👎 отметить — ответил не так
            </button>
          )}

          {editing && (
            <div className="flex flex-col gap-1.5 mt-1 ns-fade-in">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={2}
                autoFocus
                placeholder="Как бот должен был ответить?"
                className="w-full text-sm border border-amber-300 bg-amber-50/50 rounded-xl px-3 py-2 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100 resize-y"
              />
              <div className="flex gap-2">
                <button
                  onClick={save}
                  disabled={saving || !text.trim()}
                  className="text-xs bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-medium rounded-lg px-3 py-1.5"
                >
                  {saving ? "Сохраняем…" : "Сохранить"}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setText(message.feedback ?? "");
                  }}
                  className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1.5"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────── Статистика (рыба) ─────────────── */

function StatsStub({ botId }: { botId: number }) {
  const [dialogs, setDialogs] = useState<DialogSummary[] | null>(null);
  useEffect(() => {
    listDialogs(botId)
      .then(setDialogs)
      .catch(() => setDialogs([]));
  }, [botId]);

  const total = dialogs?.length ?? null;
  const messages = dialogs ? dialogs.reduce((s, d) => s + d.message_count, 0) : null;
  const active = dialogs ? dialogs.filter((d) => d.is_active).length : null;

  return (
    <div className="ns-fade-in">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        <StatCard icon="💬" label="Диалогов" value={total} live />
        <StatCard icon="✉️" label="Сообщений" value={messages} live />
        <StatCard icon="🟢" label="Активных" value={active} live />
        <StatCard icon="⏱️" label="Ср. ответ" value={null} />
      </div>

      <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-14 text-center">
        <div className="text-4xl mb-3">📊</div>
        <div className="text-slate-700 font-semibold">Подробная статистика скоро</div>
        <div className="text-slate-400 text-sm mt-1 max-w-md mx-auto">
          Здесь появятся графики по диалогам, конверсии в заявку, времени ответа и качеству ответов бота.
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, live }: { icon: string; label: string; value: number | null; live?: boolean }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="text-xl mb-1.5">{icon}</div>
      <div className="text-2xl font-bold text-slate-900">
        {value === null ? <span className="text-slate-300">—</span> : value.toLocaleString("ru-RU")}
      </div>
      <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-1">
        {label}
        {!live && value === null && (
          <span className="text-[9px] bg-slate-100 text-slate-400 rounded px-1 py-0.5">скоро</span>
        )}
      </div>
    </div>
  );
}

/* ─────────────── Вспомогательное ─────────────── */

function PanelSkeleton() {
  return (
    <div className="grid grid-cols-[300px_1fr] gap-4 h-[72vh]">
      <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-col gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-14 rounded-xl bg-slate-100 animate-pulse" />
        ))}
      </div>
      <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={"h-10 rounded-2xl bg-slate-100 animate-pulse " + (i % 2 ? "self-end w-1/3" : "w-1/2")} />
        ))}
      </div>
    </div>
  );
}

function EmptyBox({ emoji, title, subtitle }: { emoji: string; title: string; subtitle: string }) {
  return (
    <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-16 text-center">
      <div className="text-4xl mb-3">{emoji}</div>
      <div className="text-slate-700 font-semibold">{title}</div>
      <div className="text-slate-400 text-sm mt-1 max-w-sm mx-auto">{subtitle}</div>
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return <div className="bg-red-50 border border-red-200 text-red-700 rounded-2xl p-4 text-sm">{text}</div>;
}

type Item = { type: "divider"; label: string } | { type: "message"; message: DialogMessage };

function withDayDividers(messages: DialogMessage[]): Item[] {
  const out: Item[] = [];
  let lastDay = "";
  for (const m of messages) {
    const day = dayLabel(m.created_at);
    if (day !== lastDay) {
      out.push({ type: "divider", label: day });
      lastDay = day;
    }
    out.push({ type: "message", message: m });
  }
  return out;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} д`;
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Сегодня";
  if (same(d, yesterday)) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
