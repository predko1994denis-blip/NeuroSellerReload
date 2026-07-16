import { useEffect, useState } from "react";
import { listBots, createBot, type Bot, type Company } from "./api";
import { BotDetail } from "./BotDetail";
import { ManagerBotView } from "./ManagerBotView";
import { getSession } from "./auth";

export function CompanyDetail({ company, onBack }: { company: Company; onBack?: () => void }) {
  const isAdmin = getSession()?.role === "admin";
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await listBots(company.id);
      setBots(list);
      // У менеджера обычно один бот — не заставляем выбирать его из списка.
      if (!isAdmin && list.length === 1) setSelectedBot(list[0]!);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [company.id]);

  if (selectedBot) {
    // Настройщик — полный конструктор; менеджер — только диалоги/стата/пометки.
    // Если у менеджера всего один бот — назад возвращаться некуда, кнопку не показываем.
    const canGoBack = isAdmin || bots.length > 1;
    return isAdmin ? (
      <BotDetail bot={selectedBot} onBack={() => setSelectedBot(null)} />
    ) : (
      <ManagerBotView bot={selectedBot} onBack={canGoBack ? () => setSelectedBot(null) : undefined} />
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-6 py-10">
      {onBack && (
        <button onClick={onBack} className="text-sm text-slate-500 hover:text-red-600 mb-4 transition-colors">
          ← Назад к компаниям
        </button>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{isAdmin ? company.email : "Ваши боты"}</h1>
          <p className="text-slate-500 mt-1">{isAdmin ? `Ботов: ${bots.length}` : ""}</p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowCreate(true)}
            className="bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg px-5 py-2.5 transition-colors"
          >
            + Новый бот
          </button>
        )}
      </div>

      {loading && <p className="text-slate-400">Загрузка…</p>}
      {error && <p className="text-red-600">{error}</p>}

      {!loading && !error && bots.length === 0 && (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-400">
          Пока нет ботов.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {bots.map((b) => (
          <BotCard key={b.id} bot={b} isAdmin={isAdmin} onClick={() => setSelectedBot(b)} />
        ))}
      </div>

      {showCreate && (
        <CreateBotModal
          clientId={company.id}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </main>
  );
}

function BotCard({ bot, isAdmin, onClick }: { bot: Bot; isAdmin: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 hover:shadow-md hover:border-slate-300 transition-all cursor-pointer"
    >
      <div className="flex items-start justify-between">
        <div className="font-semibold text-slate-900">
          {bot.company_name || "Бот"}
        </div>
        {isAdmin && (
          <div className="flex flex-col items-end gap-1">
            <span className={`text-xs font-medium rounded-full px-2.5 py-1 ${bot.rag_enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>
              RAG {bot.rag_enabled ? "вкл" : "выкл"}
            </span>
          </div>
        )}
      </div>
      {isAdmin && <div className="text-sm text-slate-400 mt-1 font-mono">…{bot.token_tail}</div>}
    </div>
  );
}

function CreateBotModal({
  clientId,
  onClose,
  onCreated,
}: {
  clientId: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [token, setToken] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWarning(null);
    setLoading(true);
    try {
      const result = await createBot(token.trim(), clientId, companyName.trim());
      if (!result.webhook_set) {
        setWarning("Бот создан, но webhook не установился — проверьте токен.");
        setTimeout(onCreated, 1500);
      } else {
        onCreated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка создания");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">Новый бот</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
            ×
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="text-sm font-medium text-slate-700">
            Название компании
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
              placeholder="напр. Papl.by"
              className="mt-1 w-full border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Telegram Bot Token
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              placeholder="123456:ABC-DEF..."
              className="mt-1 w-full border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 font-mono text-sm"
            />
          </label>
          <p className="text-xs text-slate-400">
            Токен получите у @BotFather в Telegram. Название компании используется во всех промптах бота. Webhook настроится автоматически.
          </p>
          {error && <div className="text-red-600 text-sm">{error}</div>}
          {warning && <div className="text-amber-600 text-sm">{warning}</div>}
          <div className="flex gap-3 mt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-slate-300 text-slate-700 font-medium rounded-lg px-4 py-2.5 hover:bg-slate-50 transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2.5 transition-colors"
            >
              {loading ? "Создаём…" : "Создать"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
