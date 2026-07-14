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

  // Скачивает фото по file_id: сперва узнаём file_path через getFile, потом качаем сами байты.
  async downloadPhoto(fileId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const infoRes = await fetch(`https://api.telegram.org/bot${this.botToken}/getFile?file_id=${fileId}`);
    if (!infoRes.ok) {
      throw new Error(`Telegram getFile failed: ${infoRes.status} ${await infoRes.text()}`);
    }
    const info = (await infoRes.json()) as { result?: { file_path?: string } };
    const filePath = info.result?.file_path;
    if (!filePath) throw new Error("Telegram getFile: file_path отсутствует в ответе");

    const fileRes = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`);
    if (!fileRes.ok) {
      throw new Error(`Telegram file download failed: ${fileRes.status}`);
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const ext = filePath.split(".").pop()?.toLowerCase();
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return { buffer, mimeType };
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

// Минимальная структура Telegram webhook update — текст ИЛИ фото (с необязательной подписью)
export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    caption?: string;
    photo?: { file_id: string; width: number; height: number }[];
  };
}

export interface ExtractedMessage {
  chatId: string;
  text: string;
  photoFileId?: string; // задан, если сообщение — фото (text в этом случае — подпись, может быть пустой)
}

export function extractChatIdAndText(update: TelegramUpdate): ExtractedMessage | null {
  const message = update.message;
  if (!message) return null;

  // Telegram присылает фото массивом size-вариантов от меньшего к большему — берём самое крупное.
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    return { chatId: String(message.chat.id), text: message.caption ?? "", photoFileId: largest.file_id };
  }

  if (typeof message.text !== "string") return null;
  return { chatId: String(message.chat.id), text: message.text };
}
