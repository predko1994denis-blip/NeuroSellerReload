import type { RagChunkRepository } from "../repositories/RagChunkRepository";
import type { EmbeddingClient } from "../llm/EmbeddingClient";

const TOP_K = 3;

export class RagSearchManager {
  constructor(
    private chunkRepo: RagChunkRepository,
    private embeddingClient: EmbeddingClient
  ) {}

  // Возвращает готовый текстовый блок для подклейки в system prompt, либо null, если ничего не нашли
  async buildContext(botId: number, queryText: string): Promise<string | null> {
    const queryEmbedding = await this.embeddingClient.embed(queryText);
    const chunks = await this.chunkRepo.searchByBot(botId, queryEmbedding, TOP_K);
    if (chunks.length === 0) return null;

    return `Контекст из базы знаний:\n${chunks.map((c) => `- ${c.content}`).join("\n")}`;
  }
}
