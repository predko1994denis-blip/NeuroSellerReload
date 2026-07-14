import { sql } from "../db/connection";
import type { Dialog } from "../entities/Dialog";

export class DialogRepository {
  async findById(id: number): Promise<Dialog | null> {
    const [row] = await sql<Dialog[]>`
      SELECT * FROM dialogs WHERE id = ${id}
    `;
    return row ?? null;
  }

  // Список диалогов бота для портала менеджера: id, чат, активность, кол-во сообщений и время последнего.
  async findByBotId(botId: number): Promise<
    { id: number; chat_id: string; is_active: boolean; created_at: Date; message_count: number; last_message_at: Date | null; taken_over_by: number | null }[]
  > {
    return sql`
      SELECT d.id, d.chat_id, d.is_active, d.created_at, d.taken_over_by,
             COUNT(m.id)::int AS message_count,
             MAX(m.created_at) AS last_message_at
      FROM dialogs d
      LEFT JOIN messages m ON m.dialog_id = d.id
      WHERE d.bot_id = ${botId}
      GROUP BY d.id
      ORDER BY COALESCE(MAX(m.created_at), d.created_at) DESC
    ` as unknown as Promise<
      { id: number; chat_id: string; is_active: boolean; created_at: Date; message_count: number; last_message_at: Date | null; taken_over_by: number | null }[]
    >;
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

  // Память об интересе клиента. sql.json сериализует массив в НАСТОЯЩИЙ jsonb-массив
  // (наивный `${JSON.stringify(x)}::jsonb` давал двойную кодировку — jsonb-строку вместо массива).
  async setMentionedProducts(id: number, products: string[]): Promise<void> {
    await sql`UPDATE dialogs SET mentioned_products = ${sql.json(products)} WHERE id = ${id}`;
  }

  // Slot-filling: сохраняем накопленные известные данные клиента (структурный jsonb-объект).
  async setKnown(id: number, known: Record<string, string>): Promise<void> {
    await sql`UPDATE dialogs SET known = ${sql.json(known)} WHERE id = ${id}`;
  }

  // Перехват диалога менеджером: userId — кто взял управление, null — отпустить обратно боту.
  async setTakenOverBy(id: number, userId: number | null): Promise<Dialog> {
    const [row] = await sql<Dialog[]>`
      UPDATE dialogs SET taken_over_by = ${userId} WHERE id = ${id} RETURNING *
    `;
    return row!;
  }

  // Каскадно удаляет messages/reminders/crm_leads этого диалога (ON DELETE CASCADE в схеме)
  async delete(id: number): Promise<void> {
    await sql`DELETE FROM dialogs WHERE id = ${id}`;
  }
}
