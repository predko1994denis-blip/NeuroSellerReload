export interface RagDocument {
  id: number;
  bot_id: number;
  filename: string;
  raw_text: string;
  created_at: Date;
}

export type RagDocumentSummary = Omit<RagDocument, "raw_text">;

export interface RagChunk {
  id: number;
  document_id: number;
  content: string;
  embedding: number[];
  created_at: Date;
}
