import { sql } from "../db/connection";
import type { RagChunk } from "../entities/Rag";

// pgvector принимает текстовый литерал вида '[0.1,0.2,...]' с касом ::vector
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class RagChunkRepository {
  async create(documentId: number, content: string, embedding: number[]): Promise<RagChunk> {
    const [row] = await sql<RagChunk[]>`
      INSERT INTO rag_chunks (document_id, content, embedding)
      VALUES (${documentId}, ${content}, ${toVectorLiteral(embedding)}::vector)
      RETURNING *
    `;
    return row!;
  }

  // Top-K чанков, ближайших по смыслу к queryEmbedding, среди документов конкретного бота
  async searchByBot(botId: number, queryEmbedding: number[], topK: number): Promise<RagChunk[]> {
    return sql<RagChunk[]>`
      SELECT rc.* FROM rag_chunks rc
      JOIN rag_documents rd ON rd.id = rc.document_id
      WHERE rd.bot_id = ${botId}
      ORDER BY rc.embedding <=> ${toVectorLiteral(queryEmbedding)}::vector
      LIMIT ${topK}
    `;
  }
}
