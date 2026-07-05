import type { IChannelAdapter } from "../entities/ChannelAdapter";

export class TelegramAdapter implements IChannelAdapter {
  constructor(private botToken: string) {}

  async sendMessage(chatId: string, text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
    }
  }
}

// Регистрирует webhook у Telegram, чтобы апдейты шли на наш бэкенд.
// URL содержит сам токен бота — по нему webhook-роут определяет, какому боту пришло сообщение.
export async function setTelegramWebhook(botToken: string, webhookUrl: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram setWebhook failed: ${res.status} ${body}`);
  }
}

// Минимальная структура Telegram webhook update — нас интересует только текстовое сообщение
export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

export function extractChatIdAndText(update: TelegramUpdate): { chatId: string; text: string } | null {
  const message = update.message;
  if (!message || typeof message.text !== "string") return null;
  return { chatId: String(message.chat.id), text: message.text };
}
