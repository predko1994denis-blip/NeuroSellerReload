import { sql } from "../db/connection";
import type { Message, MessageRole } from "../entities/Message";

export class MessageRepository {
  async create(dialogId: number, role: MessageRole, content: string | null): Promise<Message> {
    const [row] = await sql<Message[]>`
      INSERT INTO messages (dialog_id, role, content)
      VALUES (${dialogId}, ${role}, ${content})
      RETURNING *
    `;
    return row!;
  }

  async findByDialogId(dialogId: number): Promise<Message[]> {
    return sql<Message[]>`
      SELECT * FROM messages WHERE dialog_id = ${dialogId} ORDER BY created_at ASC
    `;
  }
}
