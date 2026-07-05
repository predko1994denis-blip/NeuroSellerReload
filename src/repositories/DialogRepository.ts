import { sql } from "../db/connection";
import type { Dialog } from "../entities/Dialog";

export class DialogRepository {
  async findById(id: number): Promise<Dialog | null> {
    const [row] = await sql<Dialog[]>`
      SELECT * FROM dialogs WHERE id = ${id}
    `;
    return row ?? null;
  }

  async findActiveByChatAndBot(chatId: string, botId: number): Promise<Dialog | null> {
    const [row] = await sql<Dialog[]>`
      SELECT * FROM dialogs
      WHERE chat_id = ${chatId} AND bot_id = ${botId} AND is_active = true
    `;
    return row ?? null;
  }

  async create(botId: number, chatId: string, currentProcess: number, currentTaskId: string): Promise<Dialog> {
    const [row] = await sql<Dialog[]>`
      INSERT INTO dialogs (bot_id, chat_id, current_process, current_task_id, process_tasks, task_attempts)
      VALUES (${botId}, ${chatId}, ${currentProcess}, ${currentTaskId}, '{}', '{}')
      RETURNING *
    `;
    return row!;
  }

  async update(id: number, fields: Partial<Pick<Dialog,
    "current_process" | "current_task_id" | "process_tasks" | "task_attempts" | "is_active" | "greeted"
  >>): Promise<Dialog> {
    const [row] = await sql<Dialog[]>`
      UPDATE dialogs SET ${sql(fields)} WHERE id = ${id} RETURNING *
    `;
    return row!;
  }

  // Каскадно удаляет messages/reminders/crm_leads этого диалога (ON DELETE CASCADE в схеме)
  async delete(id: number): Promise<void> {
    await sql`DELETE FROM dialogs WHERE id = ${id}`;
  }
}
