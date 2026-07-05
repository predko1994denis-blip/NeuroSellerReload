import { sql } from "../db/connection";
import type { RagDocument, RagDocumentSummary } from "../entities/Rag";

export class RagDocumentRepository {
  async create(botId: number, filename: string, rawText: string): Promise<RagDocument> {
    const [row] = await sql<RagDocument[]>`
      INSERT INTO rag_documents (bot_id, filename, raw_text)
      VALUES (${botId}, ${filename}, ${rawText})
      RETURNING *
    `;
    return row!;
  }

  async findByBotId(botId: number): Promise<RagDocumentSummary[]> {
    return sql<RagDocumentSummary[]>`
      SELECT id, bot_id, filename, created_at FROM rag_documents WHERE bot_id = ${botId} ORDER BY created_at DESC
    `;
  }

  async findById(id: number): Promise<RagDocument | null> {
    const [row] = await sql<RagDocument[]>`SELECT * FROM rag_documents WHERE id = ${id}`;
    return row ?? null;
  }

  async delete(id: number): Promise<void> {
    await sql`DELETE FROM rag_documents WHERE id = ${id}`;
  }
}
