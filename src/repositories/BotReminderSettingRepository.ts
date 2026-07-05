import { sql } from "../db/connection";
import type { BotReminderSetting } from "../entities/Reminder";

export class BotReminderSettingRepository {
  async findByBotId(botId: number): Promise<BotReminderSetting[]> {
    return sql<BotReminderSetting[]>`
      SELECT * FROM bot_reminder_settings WHERE bot_id = ${botId} ORDER BY step_order ASC
    `;
  }

  async findStep(botId: number, stepOrder: number): Promise<BotReminderSetting | null> {
    const [row] = await sql<BotReminderSetting[]>`
      SELECT * FROM bot_reminder_settings WHERE bot_id = ${botId} AND step_order = ${stepOrder}
    `;
    return row ?? null;
  }
}
