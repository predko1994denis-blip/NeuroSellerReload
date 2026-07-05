import type { DialogRepository } from "./repositories/DialogRepository";
import type { ProcessRepository } from "./repositories/ProcessRepository";
import type { TaskRepository } from "./repositories/TaskRepository";
import type { MessageRepository } from "./repositories/MessageRepository";
import type { BotRepository } from "./repositories/BotRepository";
import type { Dialog } from "./entities/Dialog";
import type { Task } from "./entities/Task";
import type { ILLMRequester, IResponseParser, ParsedResponse } from "./entities/LLMContract";
import type { ReminderManager } from "./managers/ReminderManager";
import type { CRMManager } from "./managers/CRMManager";
import type { RagSearchManager } from "./managers/RagSearchManager";

const MAX_FOLLOWUP_ITERATIONS = 10;

export class MessageHandler {
  // лок по "botId:chatId" — не даём двум сообщениям одного юзера обрабатываться параллельно
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private dialogRepo: DialogRepository,
    private processRepo: ProcessRepository,
    private taskRepo: TaskRepository,
    private messageRepo: MessageRepository,
    private botRepo: BotRepository,
    private llmRequester: ILLMRequester,
    private responseParser: IResponseParser,
    private reminderManager: ReminderManager,
    private crmManager: CRMManager,
    private ragSearchManager: RagSearchManager
  ) {}

  async processMessage(botId: number, chatId: string, text: string): Promise<string> {
    const lockKey = `${botId}:${chatId}`;
    const previous = this.locks.get(lockKey) ?? Promise.resolve();
    const run = previous.then(() => this.processMessageLocked(botId, chatId, text));
    this.locks.set(lockKey, run.catch(() => {}));
    return run;
  }

  private async processMessageLocked(botId: number, chatId: string, text: string): Promise<string> {
    if (text.trim() === "/clear") {
      const active = await this.dialogRepo.findActiveByChatAndBot(chatId, botId);
      if (active) {
        await this.dialogRepo.delete(active.id); // каскадно удаляет messages/reminders/crm_leads
      }
      return "Диалог удалён. Напишите что-нибудь, чтобы начать заново.";
    }

    let dialog = await this.getOrCreateDialog(botId, chatId);
    await this.reminderManager.cancel(dialog.id); // юзер ответил — старый таймер follow-up больше не нужен

    // greeted управляется системой, а не ответом LLM (промпты не обязаны возвращать это поле):
    // ровно один раз, для самого первого запроса нового диалога, отправляем greeted=false,
    // сразу помечаем диалог поприветствованным — все последующие вызовы получат уже true.
    const greetedForThisRequest = dialog.greeted;
    if (!dialog.greeted) {
      dialog = await this.dialogRepo.update(dialog.id, { greeted: true });
    }

    let task = await this.loadTask(dialog);
    const history = await this.messageRepo.findByDialogId(dialog.id);
    const systemPrompt = await this.buildSystemPrompt(botId, task, text);

    const rawResponse = await this.llmRequester.request(
      systemPrompt,
      {
        latest_user_message: text,
        greeted: greetedForThisRequest,
        history: history.map((m) => ({ role: m.role, content: m.content ?? "" })),
      },
      task.model,
      task.temperature
    );
    let parsed = this.responseParser.parse(rawResponse);
    await this.crmManager.saveLeadData(dialog.id, parsed);

    await this.messageRepo.create(dialog.id, "user", text);

    // Пустая history значит, что это самое первое сообщение диалога — бот задаёт вопрос
    // задачи 1.0 впервые. Это не проваленная попытка юзера, поэтому не считаем её.
    const isFirstAskOnThisTask = history.length === 0;
    let switched = await this.applyTransition(dialog, task, parsed, isFirstAskOnThisTask);
    let responseText = parsed.response_text;
    dialog = switched.dialog;

    // Follow-up: если задача переключилась, делаем доп. LLM-запросы без нового сообщения юзера,
    // пока не наткнёмся на задачу, которая ничего сама не закрывает (или не превысим лимит итераций)
    let iterations = 0;
    while (switched.taskChanged && dialog.is_active && iterations < MAX_FOLLOWUP_ITERATIONS) {
      iterations++;
      task = await this.loadTask(dialog);
      const followHistory = await this.messageRepo.findByDialogId(dialog.id);

      const followRaw = await this.llmRequester.request(
        task.task_description,
        {
          latest_user_message: "",
          greeted: dialog.greeted,
          history: followHistory.map((m) => ({ role: m.role, content: m.content ?? "" })),
        },
        task.model,
        task.temperature
      );
      parsed = this.responseParser.parse(followRaw);
      responseText = parsed.response_text;
      await this.crmManager.saveLeadData(dialog.id, parsed);

      switched = await this.applyTransition(dialog, task, parsed, true);
      dialog = switched.dialog;
    }

    await this.messageRepo.create(dialog.id, "assistant", responseText);

    if (!dialog.is_active) {
      this.crmManager.sendToAmoCrm(dialog.id, botId).catch((err) => console.error("sendToAmoCrm failed:", err));
    } else {
      await this.reminderManager.scheduleFirst(dialog.id, botId);
    }

    return responseText;
  }

  private async getOrCreateDialog(botId: number, chatId: string): Promise<Dialog> {
    const existing = await this.dialogRepo.findActiveByChatAndBot(chatId, botId);
    if (existing) return existing;

    const firstProcess = await this.processRepo.findFirstByBotId(botId);
    if (!firstProcess) {
      throw new Error(`У бота ${botId} не настроен ни один процесс`);
    }
    const tasks = await this.taskRepo.findByProcessId(firstProcess.id);
    const firstTask = tasks[0];
    if (!firstTask) {
      throw new Error(`У процесса ${firstProcess.id} нет ни одной задачи`);
    }

    return this.dialogRepo.create(botId, chatId, firstProcess.process_number, firstTask.task_number);
  }

  private async buildSystemPrompt(botId: number, task: Task, userMessage: string): Promise<string> {
    const bot = await this.botRepo.findById(botId);
    if (!bot?.rag_enabled) return task.task_description;

    const ragContext = await this.ragSearchManager.buildContext(botId, userMessage);
    return ragContext ? `${task.task_description}\n\n${ragContext}` : task.task_description;
  }

  private async loadTask(dialog: Dialog): Promise<Task> {
    const process = await this.processRepo.findByBotAndNumber(dialog.bot_id, dialog.current_process);
    if (!process) {
      throw new Error(`Процесс №${dialog.current_process} не найден для бота ${dialog.bot_id}`);
    }
    const task = await this.taskRepo.findByProcessAndNumber(process.id, dialog.current_task_id);
    if (!task) {
      throw new Error(`Задача ${dialog.current_task_id} не найдена в процессе ${process.id}`);
    }
    return task;
  }

  // Двигает FSM по результату ответа LLM. Возвращает обновлённый dialog и флаг "задача сменилась"
  // (от этого флага зависит, нужен ли follow-up LLM-запрос без нового сообщения юзера).
  private async applyTransition(
    dialog: Dialog,
    task: Task,
    parsed: ParsedResponse,
    skipAttemptCounting: boolean = false
  ): Promise<{ dialog: Dialog; taskChanged: boolean }> {
    const processTasks = { ...dialog.process_tasks };
    const taskAttempts = { ...dialog.task_attempts };

    // Переход в другой процесс полностью сбрасывает прогресс — это явное решение LLM, не наша эвристика.
    // Роутер может вернуть next_process: null, если ещё не понятно, куда вести — это не переход.
    if (parsed.next_process !== undefined && parsed.next_process !== null && parsed.next_process !== dialog.current_process) {
      const newProcess = await this.processRepo.findByBotAndNumber(dialog.bot_id, parsed.next_process);
      if (!newProcess) {
        throw new Error(`Процесс №${parsed.next_process} не найден для бота ${dialog.bot_id}`);
      }
      const newTasks = await this.taskRepo.findByProcessId(newProcess.id);
      const firstTask = newTasks[0];
      if (!firstTask) {
        throw new Error(`У процесса ${newProcess.id} нет ни одной задачи`);
      }
      const updated = await this.dialogRepo.update(dialog.id, {
        current_process: newProcess.process_number,
        current_task_id: firstTask.task_number,
        process_tasks: {},
        task_attempts: {},
        greeted: parsed.greeted ?? dialog.greeted,
      });
      return { dialog: updated, taskChanged: true };
    }

    if (task.task_type === "analytical" && parsed.tasks) {
      for (const [taskNumber, result] of Object.entries(parsed.tasks)) {
        if (result.completed) processTasks[taskNumber] = true;
      }
    } else if (parsed.current_task_completed) {
      processTasks[task.task_number] = true;
    } else if (skipAttemptCounting) {
      // Follow-up-вызов без сообщения юзера ИЛИ самое первое сообщение нового диалога —
      // бот просто впервые озвучивает вопрос задачи. Это не проваленная попытка юзера,
      // поэтому не увеличиваем счётчик и не форсируем переход.
      return { dialog, taskChanged: false };
    } else {
      const attempts = (taskAttempts[task.task_number] ?? 0) + 1;
      taskAttempts[task.task_number] = attempts;

      if (attempts < task.max_attempts) {
        const updated = await this.dialogRepo.update(dialog.id, {
          task_attempts: taskAttempts,
          greeted: parsed.greeted ?? dialog.greeted,
        });
        return { dialog: updated, taskChanged: false };
      }

      // Попытки исчерпаны. Обязательный шаг без права пропуска — уходим в fallback-completion
      // ("не разобрались, менеджер свяжется"), а не притворяемся, что шаг выполнен.
      if (task.required) {
        const fallback = await this.findFallbackTask(task.process_id);
        if (fallback) {
          const updated = await this.dialogRepo.update(dialog.id, {
            current_task_id: fallback.task_number,
            task_attempts: taskAttempts,
            greeted: parsed.greeted ?? dialog.greeted,
          });
          return { dialog: updated, taskChanged: true };
        }
      }
      // Необязательный шаг (или fallback не сгенерирован) — сдаёмся на этом шаге,
      // идём дальше по порядку, как обычно при успешном завершении.
      processTasks[task.task_number] = true;
    }

    if (task.task_type === "completion") {
      const updated = await this.dialogRepo.update(dialog.id, {
        process_tasks: processTasks,
        task_attempts: taskAttempts,
        is_active: false,
        greeted: parsed.greeted ?? dialog.greeted,
      });
      return { dialog: updated, taskChanged: false };
    }

    const nextTaskNumber = parsed.next_task ?? (await this.findNextTaskNumber(task, processTasks));
    if (!nextTaskNumber) {
      // Нет явного next_task и нет незавершённых задач — переходим на completion, если она есть
      const completionTask = await this.findCompletionTask(task.process_id);
      if (completionTask) {
        const updated = await this.dialogRepo.update(dialog.id, {
          process_tasks: processTasks,
          task_attempts: taskAttempts,
          current_task_id: completionTask.task_number,
          greeted: parsed.greeted ?? dialog.greeted,
        });
        return { dialog: updated, taskChanged: true };
      }
      // Обычного completion в процессе нет (например, это чистый роутер, который должен был
      // уйти через next_process, но LLM вернула completed:true без него) — уходим в fallback,
      // а не молча обрываем диалог без единого сообщения.
      const fallback = await this.findFallbackTask(task.process_id);
      if (fallback) {
        const updated = await this.dialogRepo.update(dialog.id, {
          process_tasks: processTasks,
          task_attempts: taskAttempts,
          current_task_id: fallback.task_number,
          greeted: parsed.greeted ?? dialog.greeted,
        });
        return { dialog: updated, taskChanged: true };
      }
      const updated = await this.dialogRepo.update(dialog.id, {
        process_tasks: processTasks,
        task_attempts: taskAttempts,
        is_active: false,
        greeted: parsed.greeted ?? dialog.greeted,
      });
      return { dialog: updated, taskChanged: false };
    }

    const taskChanged = nextTaskNumber !== task.task_number;
    const updated = await this.dialogRepo.update(dialog.id, {
      process_tasks: processTasks,
      task_attempts: taskAttempts,
      current_task_id: nextTaskNumber,
      greeted: parsed.greeted ?? dialog.greeted,
    });
    return { dialog: updated, taskChanged };
  }

  private async findNextTaskNumber(currentTask: Task, processTasks: Record<string, boolean>): Promise<string | null> {
    const tasks = await this.taskRepo.findByProcessId(currentTask.process_id);
    const sorted = tasks.slice().sort((a, b) => a.task_number.localeCompare(b.task_number));
    const next = sorted.find((t) => t.task_number !== currentTask.task_number && !processTasks[t.task_number] && t.task_type !== "completion");
    return next ? next.task_number : null;
  }

  private async findCompletionTask(processId: number): Promise<Task | null> {
    const tasks = await this.taskRepo.findByProcessId(processId);
    return tasks.find((t) => t.task_type === "completion" && !t.is_fallback) ?? null;
  }

  private async findFallbackTask(processId: number): Promise<Task | null> {
    const tasks = await this.taskRepo.findByProcessId(processId);
    return tasks.find((t) => t.task_type === "completion" && t.is_fallback) ?? null;
  }
}
