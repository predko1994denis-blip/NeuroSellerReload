import type { ReminderRepository } from "./repositories/ReminderRepository";
import type { DialogRepository } from "./repositories/DialogRepository";
import type { BotRepository } from "./repositories/BotRepository";
import type { MessageRepository } from "./repositories/MessageRepository";
import type { ILLMRequester } from "./entities/LLMContract";
import type { ReminderManager } from "./managers/ReminderManager";
import { TelegramAdapter } from "./channels/TelegramAdapter";

const CHECK_INTERVAL_MS = 15_000;

// "Умный" follow-up: сперва решает, нужно ли вообще писать (по контексту переписки), и только
// если да — генерирует текст. Если клиент явно просил отстать, разговор логически закрыт, или
// повторный пинг сейчас будет неуместен — should_send=false, и напоминание просто не отправляется.
const REMINDER_SYSTEM_PROMPT = `Ты — менеджер по продажам. Клиент не отвечал какое-то время на последнее сообщение бота.
Разберись по истории переписки ниже, уместно ли сейчас написать вежливое напоминание (follow-up).

НЕ отправляй напоминание (should_send: false), если по контексту видно, что:
- клиент прямо или косвенно попросил его не беспокоить / отстать / больше не писать;
- разговор выглядит логически завершённым (клиент попрощался, поблагодарил и не ожидает продолжения, отказался от покупки);
- напоминание уже отправлялось недавно и будет выглядеть навязчиво (например, подряд несколько похожих сообщений без ответа);
- любая другая причина, по которой здравомыслящий менеджер сейчас бы не стал писать снова.

В остальных случаях — should_send: true, и текст короткого вежливого напоминания в reminder_text.

Ответь ТОЛЬКО в формате JSON: {"should_send": true|false, "reminder_text": "текст напоминания или null"}`;

export class ReminderProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private reminderRepo: ReminderRepository,
    private dialogRepo: DialogRepository,
    private botRepo: BotRepository,
    private messageRepo: MessageRepository,
    private llmRequester: ILLMRequester,
    private reminderManager: ReminderManager
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error("ReminderProcessor tick failed:", err));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const due = await this.reminderRepo.findDue(new Date());

    for (const reminder of due) {
      const dialog = await this.dialogRepo.findById(reminder.dialog_id);
      if (!dialog || !dialog.is_active) {
        await this.reminderRepo.delete(reminder.id);
        continue;
      }

      const bot = await this.botRepo.findById(dialog.bot_id);
      if (!bot) {
        await this.reminderRepo.delete(reminder.id);
        continue;
      }

      const history = await this.messageRepo.findByDialogId(dialog.id);

      const rawResponse = await this.llmRequester.request(
        REMINDER_SYSTEM_PROMPT,
        {
          latest_user_message: "",
          greeted: dialog.greeted,
          history: history.map((m) => ({ role: m.role, content: m.content ?? "" })),
        },
        "gpt-4o-mini",
        0.7
      );

      const decision = this.parseDecision(rawResponse);

      if (decision.shouldSend) {
        const adapter = new TelegramAdapter(bot.telegram_token);
        await adapter.sendMessage(dialog.chat_id, decision.reminderText!);
        await this.messageRepo.create(dialog.id, "assistant", decision.reminderText!);
      }
      // shouldSend=false — тихо пропускаем этот шаг, но цепочка идёт дальше: если ситуация
      // изменится к следующему шагу (или он окажется последним), решение будет приниматься заново.

      await this.reminderManager.advance(reminder.id, dialog.id, bot.id, reminder.step_order);
    }
  }

  private parseDecision(rawResponse: string): { shouldSend: boolean; reminderText: string | null } {
    const parsed = JSON.parse(rawResponse);
    if (typeof parsed.should_send !== "boolean") {
      throw new Error(`LLM не вернула should_send: ${rawResponse}`);
    }
    if (parsed.should_send && typeof parsed.reminder_text !== "string") {
      throw new Error(`LLM вернула should_send=true без reminder_text: ${rawResponse}`);
    }
    return { shouldSend: parsed.should_send, reminderText: parsed.reminder_text ?? null };
  }
}
