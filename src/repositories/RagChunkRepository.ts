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

  // Top-K чанков, ближайших по смыслу к queryEmbedding, среди документов конкретного бота.
  // maxDistance отсекает нерелевантные чанки: для служебных реплик («да», «2016») ближайший
  // чанк далеко (>0.75), и без порога мы подклеивали бы мусор каталога, сбивая модель/маршрутизацию.
  async searchByBot(botId: number, queryEmbedding: number[], topK: number, maxDistance = 2): Promise<RagChunk[]> {
    const vec = toVectorLiteral(queryEmbedding);
    return sql<RagChunk[]>`
      SELECT rc.* FROM rag_chunks rc
      JOIN rag_documents rd ON rd.id = rc.document_id
      WHERE rd.bot_id = ${botId}
        AND (rc.embedding <=> ${vec}::vector) <= ${maxDistance}
      ORDER BY rc.embedding <=> ${vec}::vector
      LIMIT ${topK}
    `;
  }
}
