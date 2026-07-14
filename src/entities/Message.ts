export type MessageRole = "user" | "assistant";

export interface Message {
  id: number;
  dialog_id: number;
  role: MessageRole;
  content: string | null; // текст; может быть null, если сообщение состоит только из вложения
  created_at: Date;
  sent_by: number | null; // заполнено, если сообщение отправил менеджер вручную (перехват), не бот
}
