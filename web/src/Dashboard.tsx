import { useEffect, useState } from "react";
import { clearSession, getSession } from "./auth";
import { listClients, registerClient, type Company } from "./api";
import { Header } from "./Header";
import { CompanyDetail } from "./CompanyDetail";

export function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const session = getSession();
  const isAdmin = session?.role === "admin";

  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await listClients();
      setCompanies(list);
      // У менеджера всегда ровно одна компания — не показываем список из одного элемента,
      // сразу открываем её.
      if (!isAdmin && list[0]) setSelectedCompany(list[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      <Header
        right={
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-500">{isAdmin ? "Настройщик" : "Менеджер"}</span>
            <button
              onClick={() => {
                clearSession();
                onLoggedOut();
              }}
              className="text-sm font-medium text-slate-600 hover:text-red-600 transition-colors"
            >
              Выйти
            </button>
          </div>
        }
      />

      {selectedCompany ? (
        <CompanyDetail company={selectedCompany} onBack={isAdmin ? () => setSelectedCompany(null) : undefined} />
      ) : !isAdmin ? (
        // Менеджер: единственная компания открывается автоматически (см. load()),
        // тут только короткий загрузочный экран или ошибка.
        <main className="max-w-4xl mx-auto px-6 py-16 text-center">
          {loading && <p className="text-slate-400">Загрузка…</p>}
          {error && <p className="text-red-600">{error}</p>}
        </main>
      ) : (
        <main className="max-w-4xl mx-auto px-6 py-10">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Компании</h1>
              <p className="text-slate-500 mt-1">Всего: {companies.length}</p>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg px-5 py-2.5 transition-colors"
            >
              + Новая компания
            </button>
          </div>

          {loading && <p className="text-slate-400">Загрузка…</p>}
          {error && <p className="text-red-600">{error}</p>}

          {!loading && !error && companies.length === 0 && (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-400">
              Пока нет компаний. Создайте первую.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {companies.map((c) => (
              <CompanyCard key={c.id} company={c} onClick={() => setSelectedCompany(c)} />
            ))}
          </div>
        </main>
      )}

      {showCreate && (
        <CreateCompanyModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function CompanyCard({ company, onClick }: { company: Company; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 hover:shadow-md transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="font-semibold text-slate-900">{company.email}</div>
          <div className="text-sm text-slate-400 mt-1">
            ID {company.id} · создана {new Date(company.created_at).toLocaleDateString("ru-RU")}
          </div>
        </div>
        <span className="text-xs font-medium text-slate-400 bg-slate-100 rounded-full px-2.5 py-1">
          0 ботов
        </span>
      </div>
    </div>
  );
}

function CreateCompanyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await registerClient(email, password);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка создания");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">Новая компания</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
            ×
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="text-sm font-medium text-slate-700">
            Email компании
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="company@example.com"
              className="mt-1 w-full border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Пароль для входа менеджера
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              className="mt-1 w-full border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
            />
          </label>
          <p className="text-xs text-slate-400">
            Менеджер компании сможет войти, используя этот email и пароль.
          </p>
          {error && <div className="text-red-600 text-sm">{error}</div>}
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
