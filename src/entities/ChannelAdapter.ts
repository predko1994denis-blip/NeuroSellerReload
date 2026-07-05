// Единый интерфейс отправки ответа клиенту — не важно, через какой канал.
// Приём входящих сообщений всё равно канало-специфичен (разный формат webhook),
// поэтому универсализируем только исходящую сторону + сам MessageHandler.
export interface IChannelAdapter {
  sendMessage(chatId: string, text: string): Promise<void>;
}
