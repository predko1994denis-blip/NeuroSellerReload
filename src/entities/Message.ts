export type MessageRole = "user" | "assistant";

export interface Message {
  id: number;
  dialog_id: number;
  role: MessageRole;
  content: string | null; // текст; может быть null, если сообщение состоит только из вложения
  created_at: Date;
}
