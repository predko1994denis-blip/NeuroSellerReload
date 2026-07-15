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

  // Атомарно "захватывает" все созревшие напоминания: одним запросом отбирает их с блокировкой строк
  // (FOR UPDATE SKIP LOCKED — параллельный процесс эти же строки пропустит, а не продублирует) и тут же
  // отодвигает next_fire_at на час вперёд как метку "взято в обработку". Так во время деплоя, когда
  // Railway короткое время держит старый и новый контейнер разом, одно напоминание не уйдёт клиенту
  // дважды. Реальный next_fire_at (или удаление) проставит advance() после обработки; если процесс
  // упадёт на середине — напоминание не потеряется, а повторится через час (безопасный запас).
  async claimDue(now: Date): Promise<Reminder[]> {
    return sql<Reminder[]>`
      UPDATE reminders SET next_fire_at = ${now}::timestamptz + interval '1 hour'
      WHERE id IN (
        SELECT id FROM reminders WHERE next_fire_at <= ${now}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
  }
}
