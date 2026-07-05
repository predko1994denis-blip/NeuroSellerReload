import type { ReminderRepository } from "./repositories/ReminderRepository";
import type { DialogRepository } from "./repositories/DialogRepository";
import type { BotRepository } from "./repositories/BotRepository";
import type { MessageRepository } from "./repositories/MessageRepository";
import type { ILLMRequester } from "./entities/LLMContract";
import type { ReminderManager } from "./managers/ReminderManager";
import { TelegramAdapter } from "./channels/TelegramAdapter";

const CHECK_INTERVAL_MS = 15_000;

// Хардкодный промпт — follow-up не "умный", он просто генерирует текст напоминания по истории диалога
const REMINDER_SYSTEM_PROMPT = `Ты — менеджер по продажам. Клиент не ответил на предыдущее сообщение.
Напиши короткое вежливое напоминание (follow-up), основываясь на истории переписки ниже.
Ответь только в формате JSON: {"reminder_text": "текст напоминания"}`;

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

      const reminderText = this.extractReminderText(rawResponse);

      const adapter = new TelegramAdapter(bot.telegram_token);
      await adapter.sendMessage(dialog.chat_id, reminderText);
      await this.messageRepo.create(dialog.id, "assistant", reminderText);

      await this.reminderManager.advance(reminder.id, dialog.id, bot.id, reminder.step_order);
    }
  }

  private extractReminderText(rawResponse: string): string {
    const parsed = JSON.parse(rawResponse);
    if (typeof parsed.reminder_text !== "string") {
      throw new Error(`LLM не вернула reminder_text: ${rawResponse}`);
    }
    return parsed.reminder_text;
  }
}
