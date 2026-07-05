import type { LoginResponse } from "./api";

const STORAGE_KEY = "neuroseller_auth";

export function saveSession(session: LoginResponse): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function getSession(): LoginResponse | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
