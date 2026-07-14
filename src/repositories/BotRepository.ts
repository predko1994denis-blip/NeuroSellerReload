import { sql } from "../db/connection";
import type { Bot } from "../entities/Bot";

export class BotRepository {
  async create(clientId: number, telegramToken: string, companyName: string): Promise<Bot> {
    const [row] = await sql<Bot[]>`
      INSERT INTO bots (client_id, telegram_token, company_name)
      VALUES (${clientId}, ${telegramToken}, ${companyName})
      RETURNING *
    `;
    return row!;
  }

  async findById(id: number): Promise<Bot | null> {
    const [row] = await sql<Bot[]>`
      SELECT * FROM bots WHERE id = ${id}
    `;
    return row ?? null;
  }

  async findByTelegramToken(token: string): Promise<Bot | null> {
    const [row] = await sql<Bot[]>`
      SELECT * FROM bots WHERE telegram_token = ${token}
    `;
    return row ?? null;
  }

  async findByClientId(clientId: number): Promise<Bot[]> {
    return sql<Bot[]>`
      SELECT * FROM bots WHERE client_id = ${clientId} ORDER BY created_at DESC
    `;
  }

  async updateCompanyName(id: number, companyName: string): Promise<Bot> {
    const [row] = await sql<Bot[]>`
      UPDATE bots SET company_name = ${companyName} WHERE id = ${id} RETURNING *
    `;
    return row!;
  }

  async updateRagEnabled(id: number, ragEnabled: boolean): Promise<Bot> {
    const [row] = await sql<Bot[]>`
      UPDATE bots SET rag_enabled = ${ragEnabled} WHERE id = ${id} RETURNING *
    `;
    return row!;
  }

  // Список non-goals сценария (с чем бот НЕ помогает) — для справки: такие вопросы она пропускает,
  // их ведёт шаг через блок [ВНЕ ЗАДАЧ]. Пусто, если сценария/списка нет.
  async getNonGoals(botId: number): Promise<string[]> {
    const [row] = await sql<{ non_goals: unknown }[]>`
      SELECT non_goals FROM scenarios WHERE bot_id = ${botId} LIMIT 1
    `;
    const ng = row?.non_goals;
    return Array.isArray(ng) ? ng.filter((g): g is string => typeof g === "string" && g.trim().length > 0) : [];
  }
}
