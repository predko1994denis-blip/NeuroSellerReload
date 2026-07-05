import { sql } from "../db/connection";
import type { Reminder } from "../entities/Reminder";

export class ReminderRepository {
  // один активный reminder на диалог — новый просто перезатирает старый (юзер ответил/задача сменилась)
  async upsert(dialogId: number, stepOrder: number, nextFireAt: Date): Promise<Reminder> {
    const [row] = await sql<Reminder[]>`
      INSERT INTO reminders (dialog_id, step_order, next_fire_at)
      VALUES (${dialogId}, ${stepOrder}, ${nextFireAt})
      ON CONFLICT (dialog_id) DO UPDATE SET step_order = ${stepOrder}, next_fire_at = ${nextFireAt}
      RETURNING *
    `;
    return row!;
  }

  async cancelByDialogId(dialogId: number): Promise<void> {
    await sql`DELETE FROM reminders WHERE dialog_id = ${dialogId}`;
  }

  async delete(id: number): Promise<void> {
    await sql`DELETE FROM reminders WHERE id = ${id}`;
  }

  async findDue(now: Date): Promise<Reminder[]> {
    return sql<Reminder[]>`
      SELECT * FROM reminders WHERE next_fire_at <= ${now}
    `;
  }
}
