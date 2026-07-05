export type AttachmentType = "audio" | "image" | "document";

export interface MessageAttachment {
  id: number;
  message_id: number;
  type: AttachmentType;
  storage_path: string;
  meta: Record<string, unknown>; // mime, размер, транскрипция/OCR-текст и т.п.
  created_at: Date;
}
