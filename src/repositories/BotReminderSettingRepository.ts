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

  // Полностью заменяет цепочку шагов бота — проще и надёжнее, чем разбирать точечные
  // add/remove/reorder с фронта. Настройщик редактирует весь список и сохраняет разом.
  async replaceForBot(botId: number, steps: { stepOrder: number; delayMinutes: number }[]): Promise<BotReminderSetting[]> {
    return sql.begin(async (tx) => {
      await tx`DELETE FROM bot_reminder_settings WHERE bot_id = ${botId}`;
      const rows: BotReminderSetting[] = [];
      for (const s of steps) {
        const [row] = await tx<BotReminderSetting[]>`
          INSERT INTO bot_reminder_settings (bot_id, step_order, delay_minutes)
          VALUES (${botId}, ${s.stepOrder}, ${s.delayMinutes})
          RETURNING *
        `;
        rows.push(row!);
      }
      return rows;
    });
  }
}
