import { sql } from "../db/connection";
import type { Message, MessageRole } from "../entities/Message";

export class MessageRepository {
  async create(dialogId: number, role: MessageRole, content: string | null, sentBy: number | null = null): Promise<Message> {
    const [row] = await sql<Message[]>`
      INSERT INTO messages (dialog_id, role, content, sent_by)
      VALUES (${dialogId}, ${role}, ${content}, ${sentBy})
      RETURNING *
    `;
    return row!;
  }

  async findByDialogId(dialogId: number): Promise<Message[]> {
    return sql<Message[]>`
      SELECT * FROM messages WHERE dialog_id = ${dialogId} ORDER BY created_at ASC, id ASC
    `;
  }

  async findById(id: number): Promise<Message | null> {
    const [row] = await sql<Message[]>`SELECT * FROM messages WHERE id = ${id}`;
    return row ?? null;
  }
}
