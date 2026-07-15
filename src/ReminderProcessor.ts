import type { ReminderRepository } from "./repositories/ReminderRepository";
import type { DialogRepository } from "./repositories/DialogRepository";
import type { BotRepository } from "./repositories/BotRepository";
import type { MessageRepository } from "./repositories/MessageRepository";
import type { ProcessRepository } from "./repositories/ProcessRepository";
import type { TaskRepository } from "./repositories/TaskRepository";
import type { ILLMRequester } from "./entities/LLMContract";
import type { ReminderManager } from "./managers/ReminderManager";
import { TelegramAdapter } from "./channels/TelegramAdapter";

const CHECK_INTERVAL_MS = 15_000;

// "Умный" follow-up: сперва решает, нужно ли вообще писать (по контексту переписки), и только
// если да — генерирует текст. Если клиент явно просил отстать, разговор логически закрыт, или
// повторный пинг сейчас будет неуместен — should_send=false, и напоминание просто не отправляется.
// goal — цель ТЕКУЩЕГО шага сценария (task.title): без неё модель пишет абстрактное "просто хотел
// напомнить о разговоре" вместо конкретного мягкого подталкивания к тому, что реально нужно узнать.
function buildReminderPrompt(goal: string): string {
  return `Ты — менеджер по продажам. Клиент не отвечал какое-то время на последнее сообщение бота.
Сейчас цель разговора: «${goal}».

Разберись по истории переписки ниже, уместно ли сейчас мягко напомнить о себе.

НЕ отправляй напоминание (should_send: false), если по контексту видно, что:
- клиент прямо или косвенно попросил его не беспокоить / отстать / больше не писать;
- разговор выглядит логически завершённым (клиент попрощался, поблагодарил и не ожидает продолжения, отказался от покупки);
- напоминание уже отправлялось недавно и будет выглядеть навязчиво (например, подряд несколько похожих сообщений без ответа);
- любая другая причина, по которой здравомыслящий менеджер сейчас бы не стал писать снова.

Если отправляешь (should_send: true), текст в reminder_text должен быть:
- КОРОТКИЙ — одна фраза, максимум две;
- живой и мягкий, БЕЗ канцелярита и штампов вроде «просто хотел напомнить», «надеюсь, у вас всё хорошо», «буду рад помочь», «если у вас есть вопросы»;
- конкретно подталкивающий именно к цели «${goal}» — как естественное продолжение разговора, а не отдельное дежурное уведомление;
- НЕ дублирующий дословно/по смыслу предыдущие сообщения бота из истории — если бот уже спрашивал это, сформулируй иначе, короче, мягче.

Ответь ТОЛЬКО в формате JSON: {"should_send": true|false, "reminder_text": "текст напоминания или null"}`;
}

export class ReminderProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Обработка одного напоминания (LLM-вызов + отправка) может занять дольше CHECK_INTERVAL_MS —
  // без этого флага следующий тик подхватит то же самое ещё не обновлённое напоминание и
  // отправит его повторно (дубли клиенту). Гарантируем, что тики не выполняются параллельно.
  private running = false;

  constructor(
    private reminderRepo: ReminderRepository,
    private dialogRepo: DialogRepository,
    private botRepo: BotRepository,
    private messageRepo: MessageRepository,
    private processRepo: ProcessRepository,
    private taskRepo: TaskRepository,
    private llmRequester: ILLMRequester,
    private reminderManager: ReminderManager
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((err) => console.error("ReminderProcessor tick failed:", err))
        .finally(() => { this.running = false; });
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
      const goal = await this.loadCurrentTaskTitle(dialog);
      if (!goal) {
        // Задача текущего шага не нашлась (сценарий пересобрали, диалог "осиротел") —
        // без цели напоминание получится таким же бессмысленным, как раньше. Пропускаем шаг.
        await this.reminderManager.advance(reminder.id, dialog.id, bot.id, reminder.step_order);
        continue;
      }

      const rawResponse = await this.llmRequester.request(
        buildReminderPrompt(goal),
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

  // task.title — цель шага простым текстом (см. миграцию accepts_image/title). Если процесс/задача
  // не находятся (например, сценарий пересобрали после того, как reminder был запланирован) — null.
  private async loadCurrentTaskTitle(dialog: { bot_id: number; current_process: number; current_task_id: string }): Promise<string | null> {
    const process = await this.processRepo.findByBotAndNumber(dialog.bot_id, dialog.current_process);
    if (!process) return null;
    const task = await this.taskRepo.findByProcessAndNumber(process.id, dialog.current_task_id);
    return task?.title?.trim() || null;
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
