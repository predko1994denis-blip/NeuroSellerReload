import { sql } from "../db/connection";

export interface MessageFeedback {
  id: number;
  message_id: number;
  suggested_answer: string;
  created_by: number | null;
  created_at: Date;
  resolved: boolean;
}

// Пометка + контекст для экрана настройщика: сам плохой ответ бота, предшествующее
// сообщение клиента (что спровоцировало ответ) и в каком диалоге это было.
export interface MessageFeedbackWithContext extends MessageFeedback {
  original_answer: string;
  user_message: string | null;
  dialog_id: number;
}

export class MessageFeedbackRepository {
  // Одна пометка на сообщение: если менеджер правит — перезаписываем, а не плодим дубли.
  // Правка сбрасывает resolved — раз текст снова другой, настройщику стоит взглянуть заново.
  async upsert(messageId: number, suggestedAnswer: string, createdBy: number | null): Promise<MessageFeedback> {
    const [existing] = await sql<MessageFeedback[]>`
      SELECT * FROM message_feedback WHERE message_id = ${messageId} LIMIT 1
    `;
    if (existing) {
      const [row] = await sql<MessageFeedback[]>`
        UPDATE message_feedback
        SET suggested_answer = ${suggestedAnswer}, created_by = ${createdBy}, created_at = now(), resolved = false
        WHERE id = ${existing.id}
        RETURNING *
      `;
      return row!;
    }
    const [row] = await sql<MessageFeedback[]>`
      INSERT INTO message_feedback (message_id, suggested_answer, created_by)
      VALUES (${messageId}, ${suggestedAnswer}, ${createdBy})
      RETURNING *
    `;
    return row!;
  }

  async delete(messageId: number): Promise<void> {
    await sql`DELETE FROM message_feedback WHERE message_id = ${messageId}`;
  }

  async setResolved(id: number, resolved: boolean): Promise<MessageFeedback> {
    const [row] = await sql<MessageFeedback[]>`
      UPDATE message_feedback SET resolved = ${resolved} WHERE id = ${id} RETURNING *
    `;
    return row!;
  }

  // Пометки для всех сообщений диалога — чтобы фронт показал их рядом с репликами.
  async findByDialogId(dialogId: number): Promise<MessageFeedback[]> {
    return sql<MessageFeedback[]>`
      SELECT f.* FROM message_feedback f
      JOIN messages m ON m.id = f.message_id
      WHERE m.dialog_id = ${dialogId}
    `;
  }

  // Все пометки бота (для экрана настройщика) — с контекстом: что ответил бот и на что.
  // Неразобранные сначала, внутри группы — свежие сначала.
  async findAllByBotId(botId: number): Promise<MessageFeedbackWithContext[]> {
    return sql<MessageFeedbackWithContext[]>`
      SELECT
        f.id, f.message_id, f.suggested_answer, f.created_by, f.created_at, f.resolved,
        m.content AS original_answer,
        m.dialog_id,
        (
          SELECT content FROM messages
          WHERE dialog_id = m.dialog_id AND id < m.id AND role = 'user'
          ORDER BY id DESC LIMIT 1
        ) AS user_message
      FROM message_feedback f
      JOIN messages m ON m.id = f.message_id
      JOIN dialogs d ON d.id = m.dialog_id
      WHERE d.bot_id = ${botId}
      ORDER BY f.resolved ASC, f.created_at DESC
    `;
  }
}
