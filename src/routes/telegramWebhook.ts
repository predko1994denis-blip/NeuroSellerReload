import type { BotRepository } from "../repositories/BotRepository";
import type { MessageHandler } from "../MessageHandler";
import { TelegramAdapter, extractChatIdAndText, type TelegramUpdate } from "../channels/TelegramAdapter";

// URL вебхука содержит telegram_token бота — это и секрет (Telegram сам его не угадает),
// и способ узнать, какому боту (botId) пришло сообщение, без доп. параметров в запросе.
export async function handleTelegramWebhook(
  request: Request,
  botRepo: BotRepository,
  messageHandler: MessageHandler
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.pathname.split("/").pop();
  if (!token) return new Response("Not found", { status: 404 });

  const bot = await botRepo.findByTelegramToken(token);
  if (!bot) return new Response("Not found", { status: 404 });

  const update = (await request.json()) as TelegramUpdate;
  const extracted = extractChatIdAndText(update);
  if (!extracted) return new Response("OK"); // не текстовое сообщение — игнорируем, но 200 для Telegram

  const adapter = new TelegramAdapter(bot.telegram_token);

  // ВАЖНО: всегда отвечаем Telegram 200, даже при ошибке. Иначе Telegram считает доставку
  // неуспешной и повторно шлёт ТО ЖЕ САМОЕ сообщение с нарастающим интервалом — эти ретраи
  // встают в общую очередь обработки чата и блокируют все следующие сообщения того же чата
  // (например, /clear), пока не перестанут падать.
  // «Печатает…» в шапке чата на всё время обработки — LLM-вызовы могут занять несколько секунд,
  // а индикатор Telegram сам гаснет через ~5 сек, поэтому обновляем его периодически.
  adapter.sendChatAction(extracted.chatId, "typing").catch(() => {});
  const typingTimer = setInterval(() => {
    adapter.sendChatAction(extracted.chatId, "typing").catch(() => {});
  }, 4000);

  try {
    const image = extracted.photoFileId ? await adapter.downloadPhoto(extracted.photoFileId) : undefined;
    // processMessage возвращает массив пузырей: [ответ по базе, реплика сценария] — шлём по очереди.
    const messages = await messageHandler.processMessage(bot.id, extracted.chatId, extracted.text, image);
    clearInterval(typingTimer);
    for (const msg of messages) {
      await adapter.sendMessage(extracted.chatId, msg);
    }
  } catch (err) {
    clearInterval(typingTimer);
    console.error("Ошибка обработки сообщения Telegram:", err);
    await adapter
      .sendMessage(extracted.chatId, "Сейчас небольшие технические неполадки — напишите, пожалуйста, чуть позже.")
      .catch((sendErr) => console.error("Не удалось отправить сообщение об ошибке:", sendErr));
  }

  return new Response("OK");
}
