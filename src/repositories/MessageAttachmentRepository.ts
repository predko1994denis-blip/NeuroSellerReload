import { sql } from "../db/connection";
import type { AttachmentType, MessageAttachment } from "../entities/MessageAttachment";

export class MessageAttachmentRepository {
  async create(
    messageId: number,
    type: AttachmentType,
    storagePath: string,
    meta: Record<string, unknown> = {}
  ): Promise<MessageAttachment> {
    const [row] = await sql<MessageAttachment[]>`
      INSERT INTO message_attachments (message_id, type, storage_path, meta)
      VALUES (${messageId}, ${type}, ${storagePath}, ${sql.json(meta as any)})
      RETURNING *
    `;
    return row!;
  }

  async findByMessageId(messageId: number): Promise<MessageAttachment[]> {
    return sql<MessageAttachment[]>`
      SELECT * FROM message_attachments WHERE message_id = ${messageId}
    `;
  }
}
