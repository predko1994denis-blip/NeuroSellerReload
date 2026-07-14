import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import type { IChannelAdapter } from "../entities/ChannelAdapter";

// Канал через ОБЫЧНЫЙ Telegram-аккаунт (MTProto user-сессия), а не через Bot API.
// В отличие от TelegramAdapter (вебхук, событие приходит от Telegram само) здесь нужно самим
// держать постоянное соединение и слушать новые сообщения — почему и есть отдельный listen().
export class TelegramUserAdapter implements IChannelAdapter {
  private client: TelegramClient;

  constructor(sessionString: string, apiId: number, apiHash: string) {
    this.client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: 5,
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.client.sendMessage(chatId, { message: text });
  }

  // Слушает входящие ЛИЧНЫЕ сообщения (группы/каналы и свои же исходящие игнорируем — это
  // личный аккаунт человека, а не бот в чате сообщества). onMessage решает, что ответить.
  async listen(
    onMessage: (chatId: string, text: string, image?: { buffer: Buffer; mimeType: string }) => Promise<void>
  ): Promise<void> {
    await this.client.connect();

    this.client.addEventHandler(async (event: NewMessageEvent) => {
      const message = event.message;
      if (!message.isPrivate) return;

      const chatId = message.chatId?.toString();
      if (!chatId) return;

      let image: { buffer: Buffer; mimeType: string } | undefined;
      if (message.photo) {
        const media = await message.downloadMedia();
        if (Buffer.isBuffer(media)) image = { buffer: media, mimeType: "image/jpeg" };
      }

      const text = message.text ?? "";
      if (!text && !image) return;

      await onMessage(chatId, text, image);
    }, new NewMessage({ incoming: true }));
  }
}
