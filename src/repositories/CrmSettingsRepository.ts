import { sql } from "../db/connection";
import type { CrmSettings } from "../entities/Crm";

export class CrmSettingsRepository {
  async findByBotId(botId: number): Promise<CrmSettings | null> {
    const [row] = await sql<CrmSettings[]>`
      SELECT * FROM crm_settings WHERE bot_id = ${botId}
    `;
    return row ?? null;
  }
}
