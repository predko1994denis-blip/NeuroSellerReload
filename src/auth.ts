import type { TokenRepository } from "./repositories/TokenRepository";
import type { UserRepository } from "./repositories/UserRepository";
import type { UserRole } from "./entities/User";

export class AuthError extends Error {}

export interface AuthContext {
  userId: number;
  role: UserRole;
  clientId: number | null; // null = admin, видит все компании
}

// Проверяет "Authorization: Bearer <token>" и возвращает контекст пользователя
export async function authenticate(
  request: Request,
  tokenRepo: TokenRepository,
  userRepo: UserRepository
): Promise<AuthContext> {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) throw new AuthError("Missing Authorization header");

  const found = await tokenRepo.findByToken(token);
  if (!found) throw new AuthError("Invalid token");

  const user = await userRepo.findById(found.user_id);
  if (!user) throw new AuthError("Invalid token");

  return { userId: user.id, role: user.role, clientId: user.client_id };
}

// Гейт «только admin»: редактирование сценариев/промптов доступно лишь настройщику (admin).
// manager (владелец компании) может смотреть диалоги/стату и давать фидбек, но НЕ править промпты.
export function requireAdmin(auth: AuthContext): void {
  if (auth.role !== "admin") throw new AuthError("Недостаточно прав: редактирование доступно только администратору");
}

// Возвращает client_id для фильтрации данных, либо null, если роль admin (видит всё без фильтра)
export function scopeClientId(auth: AuthContext, requestedClientId?: number): number | null {
  if (auth.role === "admin") return requestedClientId ?? null;
  if (!auth.clientId) throw new AuthError("Manager без привязанной компании");
  return auth.clientId;
}
