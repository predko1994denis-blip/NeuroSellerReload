import { useState } from "react";
import { login } from "./api";
import { saveSession } from "./auth";
import { Header } from "./Header";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session = await login(loginValue, password);
      saveSession(session);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка входа");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <div className="flex justify-center mt-24 px-4">
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 w-full max-w-sm bg-white p-8 rounded-2xl shadow-sm border border-slate-200"
        >
          <h2 className="text-xl font-bold text-slate-900 mb-2">Вход</h2>
          <input
            placeholder="Логин"
            value={loginValue}
            onChange={(e) => setLoginValue(e.target.value)}
            autoComplete="username"
            className="border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
          />
          <input
            placeholder="Пароль"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
          />
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <button
            type="submit"
            disabled={loading}
            className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2.5 transition-colors"
          >
            {loading ? "Входим..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
