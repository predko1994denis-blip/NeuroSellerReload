import type { RagDocumentRepository } from "../repositories/RagDocumentRepository";
import type { RagChunkRepository } from "../repositories/RagChunkRepository";
import type { EmbeddingClient } from "../llm/EmbeddingClient";

const MAX_CHUNK_SIZE = 800;
const MIN_CHUNK_SIZE = 200;

export class RagIngestionManager {
  constructor(
    private documentRepo: RagDocumentRepository,
    private chunkRepo: RagChunkRepository,
    private embeddingClient: EmbeddingClient
  ) {}

  async ingest(botId: number, filename: string, rawText: string): Promise<void> {
    const document = await this.documentRepo.create(botId, filename, rawText);
    const chunks = this.splitIntoChunks(rawText);

    for (const chunk of chunks) {
      const embedding = await this.embeddingClient.embed(chunk);
      await this.chunkRepo.create(document.id, chunk, embedding);
    }
  }

  // Режем по абзацам (границы смысла), а не по фиксированной длине:
  // 1) длинные абзацы дробим по предложениям, чтобы не превышать MAX_CHUNK_SIZE
  // 2) короткие соседние абзацы склеиваем, чтобы не оставлять чанки без контекста
  private splitIntoChunks(text: string): string[] {
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const pieces: string[] = [];
    for (const paragraph of paragraphs) {
      if (paragraph.length <= MAX_CHUNK_SIZE) {
        pieces.push(paragraph);
      } else {
        pieces.push(...this.splitBySentences(paragraph));
      }
    }

    return this.mergeShortPieces(pieces);
  }

  private splitBySentences(paragraph: string): string[] {
    const sentences = paragraph.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) ?? [paragraph];
    const chunks: string[] = [];
    let current = "";

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      if (current.length + trimmed.length + 1 > MAX_CHUNK_SIZE && current.length > 0) {
        chunks.push(current);
        current = trimmed;
      } else {
        current = current ? `${current} ${trimmed}` : trimmed;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private mergeShortPieces(pieces: string[]): string[] {
    const merged: string[] = [];
    let current = "";

    for (const piece of pieces) {
      if (!current) {
        current = piece;
        continue;
      }
      if (current.length < MIN_CHUNK_SIZE && current.length + piece.length + 2 <= MAX_CHUNK_SIZE) {
        current = `${current}\n\n${piece}`;
      } else {
        merged.push(current);
        current = piece;
      }
    }
    if (current) merged.push(current);
    return merged;
  }
}
