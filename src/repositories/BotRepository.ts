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
}
