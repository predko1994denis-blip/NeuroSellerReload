import type { DialogRepository } from "./repositories/DialogRepository";
import type { ProcessRepository } from "./repositories/ProcessRepository";
import type { TaskRepository } from "./repositories/TaskRepository";
import type { MessageRepository } from "./repositories/MessageRepository";
import type { BotRepository } from "./repositories/BotRepository";
import type { Dialog } from "./entities/Dialog";
import type { Task } from "./entities/Task";
import type { ILLMRequester, IResponseParser, ParsedResponse, LLMHistoryItem, LLMRequestPayload } from "./entities/LLMContract";
import type { ReminderManager } from "./managers/ReminderManager";
import type { CRMManager } from "./managers/CRMManager";
import type { RagSearchManager } from "./managers/RagSearchManager";
import type { ImageStepReader } from "./managers/ImageStepReader";

const MAX_FOLLOWUP_ITERATIONS = 10;
const IMAGE_NOT_ACCEPTED_REPLY = "Пожалуйста, опишите это текстом — на этом шаге я пока не умею читать фото.";

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
    private ragSearchManager: RagSearchManager,
    private imageStepReader: ImageStepReader
  ) {}

  // image — если клиент прислал фото (text в этом случае — подпись к нему, может быть пустой строкой).
  // Возвращает МАССИВ сообщений-пузырей: обычно [ответ по базе, реплика сценария] или [реплика].
  async processMessage(
    botId: number,
    chatId: string,
    text: string,
    image?: { buffer: Buffer; mimeType: string }
  ): Promise<string[]> {
    const lockKey = `${botId}:${chatId}`;
    const previous = this.locks.get(lockKey) ?? Promise.resolve();
    const run = previous.then(() => this.processMessageLocked(botId, chatId, text, image));
    this.locks.set(lockKey, run.catch(() => {}));
    return run;
  }

  private async processMessageLocked(
    botId: number,
    chatId: string,
    text: string,
    image?: { buffer: Buffer; mimeType: string }
  ): Promise<string[]> {
    if (!image && text.trim() === "/clear") {
      const active = await this.dialogRepo.findActiveByChatAndBot(chatId, botId);
      if (active) {
        await this.dialogRepo.delete(active.id); // каскадно удаляет messages/reminders/crm_leads
      }
      return ["Диалог удалён. Напишите что-нибудь, чтобы начать заново."];
    }

    let dialog = await this.getOrCreateDialog(botId, chatId);
    await this.reminderManager.cancel(dialog.id); // юзер ответил — старый таймер follow-up больше не нужен

    // Диалог перехвачен менеджером из UI: бот молчит совсем, только сохраняем сообщение клиента,
    // чтобы менеджер увидел его в переписке. FSM/LLM не трогаем, пока менеджер не отпустит диалог.
    if (dialog.taken_over_by !== null) {
      await this.messageRepo.create(dialog.id, "user", text);
      return [];
    }

    // greeted управляется системой, а не ответом LLM (промпты не обязаны возвращать это поле):
    // ровно один раз, для самого первого запроса нового диалога, отправляем greeted=false,
    // сразу помечаем диалог поприветствованным — все последующие вызовы получат уже true.
    const greetedForThisRequest = dialog.greeted;
    if (!dialog.greeted) {
      dialog = await this.dialogRepo.update(dialog.id, { greeted: true });
    }

    let task = await this.loadTask(dialog);

    // Клиент прислал фото. Если текущий шаг его не ждёт — вежливо просим текст и НЕ трогаем
    // FSM/попытки (как будто сообщения не было). Если ждёт — "читаем" фото в обычный текст
    // (goal шага + подпись клиента) и дальше ведём диалог ровно так же, как при вводе текстом.
    if (image) {
      if (!task.accepts_image) {
        return [IMAGE_NOT_ACCEPTED_REPLY];
      }
      try {
        text = await this.imageStepReader.read(image.buffer, image.mimeType, task.title, text);
      } catch (err) {
        console.error("ImageStepReader.read failed:", err);
        return ["Не получилось разобрать фото — попробуйте переслать ещё раз или опишите текстом."];
      }
    }

    const history = await this.messageRepo.findByDialogId(dialog.id);
    const historyItems = history.map((m) => ({ role: m.role, content: m.content ?? "" }));

    // ── ОТДЕЛ 1: «Справочная» ── отдельным фокусным вызовом отвечает на вопрос по базе (или "").
    // Пропускаем, если у текущего шага включён rag_enabled — он сам сверяется с базой в своём
    // промпте, и параллельный вызов «Справочной» по той же базе даёт задвоенный уточняющий вопрос.
    const ragAnswer = task.rag_enabled ? "" : await this.answerFromRag(botId, text, task.model, historyItems);

    // Прошлый ход мог быть [ВНЕ ЗАДАЧ]-отказом с вопросом «помочь с другим или прервать?» —
    // такой обмен не попадает в history, поэтому короткое "да"/"нет" клиента передаём через
    // known на этот ОДИН ход, затем сразу гасим, чтобы не путать будущие ходы.
    const known = dialog.known ?? {};
    if (known.__stop_offer === "true") {
      const { __stop_offer: _drop, ...rest } = known;
      await this.dialogRepo.setKnown(dialog.id, rest);
      dialog.known = rest;
    }

    // ── ОТДЕЛ 2: «Менеджер» ── ведёт свою задачу сценария (без RAG-логики, только known).
    let parsed = await this.requestParsed(
      await this.buildSystemPrompt(task, botId, text),
      {
        latest_user_message: text,
        greeted: greetedForThisRequest,
        known,
        history: historyItems,
      },
      task.model,
      task.temperature
    );
    await this.crmManager.saveLeadData(dialog.id, parsed);
    await this.absorbKnown(dialog, parsed); // копим известные данные клиента (slot-filling)

    if (this.shouldHoldForConfirmation(task, parsed, dialog, historyItems)) {
      (parsed as { next_process?: number | null }).next_process = null;
      parsed.current_task_completed = false;
    }

    // Сохранение текущего обмена (сообщение клиента + ответ справки) в историю. Вынесено в хелпер,
    // потому что для out-of-scope мы его НЕ вызываем — такой обмен в историю не попадает.
    const saveTurn = async () => {
      await this.messageRepo.create(dialog.id, "user", text);
      if (ragAnswer) await this.messageRepo.create(dialog.id, "assistant", ragAnswer); // пузырь 1 → в историю
    };

    // «Стоп» из блока [ВНЕ ЗАДАЧ / СТОП]: клиент попросил остановиться → завершаем диалог этой
    // репликой, без переходов. Частичный лид в CRM не шлём — клиент сам прервал.
    if ((parsed as { abort?: unknown }).abort === true) {
      let stopText = parsed.response_text;
      if (greetedForThisRequest) stopText = this.stripLeadingGreeting(stopText);
      await saveTurn();
      if (stopText) await this.messageRepo.create(dialog.id, "assistant", stopText);
      await this.dialogRepo.update(dialog.id, { is_active: false });
      return [ragAnswer, stopText].filter((m): m is string => !!m && m.trim().length > 0);
    }

    // «Вне задач»: клиент попросил non-goal (напр. статус заказа). Отвечаем отказом + вопросом шага,
    // но этот обмен в историю НЕ сохраняем — иначе на следующих ходах модель зацикливается на отказе
    // (проверено: триггер — сам non-goal вопрос в истории). Шаг остаётся, попытку не считаем.
    if ((parsed as { out_of_scope?: unknown }).out_of_scope === true) {
      let msg = parsed.response_text;
      if (greetedForThisRequest) msg = this.stripLeadingGreeting(msg);
      await this.dialogRepo.setKnown(dialog.id, { ...known, __stop_offer: "true" });
      return [ragAnswer, msg].filter((m): m is string => !!m && m.trim().length > 0);
    }

    await saveTurn();

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

      const followSystemPrompt = await this.buildSystemPrompt(task, botId, text);

      // Ответ предыдущего шага ещё НЕ записан в БД (сохраняется один раз после цикла). Без него
      // follow-up шаг не видит, что имя уже обработано, и «начинает заново» — здоровается и
      // спрашивает обобщённо вместо подтверждения товара. Подмешиваем его в историю запроса.
      const followHistoryForReq = followHistory.map((m) => ({ role: m.role, content: m.content ?? "" }));
      if (responseText) followHistoryForReq.push({ role: "assistant" as const, content: responseText });

      parsed = await this.requestParsed(
        followSystemPrompt,
        {
          latest_user_message: "",
          greeted: dialog.greeted,
          known: dialog.known ?? {},
          history: followHistoryForReq,
        },
        task.model,
        task.temperature
      );
      responseText = parsed.response_text;
      await this.crmManager.saveLeadData(dialog.id, parsed);
      await this.absorbKnown(dialog, parsed);

      // Роутер подтвердил товар, но лезет в ветку → держим на этом шаге, показываем подтверждение.
      if (this.shouldHoldForConfirmation(task, parsed, dialog, followHistoryForReq)) {
        (parsed as { next_process?: number | null }).next_process = null;
        parsed.current_task_completed = false;
      }

      switched = await this.applyTransition(dialog, task, parsed, true);
      dialog = switched.dialog;
    }

    // Диалог уже был поприветствован до этого запроса → срезаем повторное «Здравствуйте! Я помощник…»,
    // если gemini его всё же вставила (промпт-правило greeted=true не всегда держится на flash-модели).
    if (greetedForThisRequest) responseText = this.stripLeadingGreeting(responseText);

    await this.messageRepo.create(dialog.id, "assistant", responseText);

    if (!dialog.is_active) {
      this.crmManager.sendToAmoCrm(dialog.id, botId).catch((err) => console.error("sendToAmoCrm failed:", err));
    } else {
      await this.reminderManager.scheduleFirst(dialog.id, botId);
    }

    // Пузыри по порядку: [ответ по базе] + [реплика сценария]. Пустые отбрасываем.
    return [ragAnswer, responseText].filter((m): m is string => !!m && m.trim().length > 0);
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

  // Промпт шага сценария. По умолчанию RAG сюда не подмешивается — на вопросы по базе отвечает
  // отдельная «Справочная» первым сообщением. Исключение — шаги с rag_enabled (см. конструктор,
  // "сверяться с базой знаний"): им отдельно подмешивается контекст из базы под ПОСЛЕДНЕЕ сообщение
  // клиента, чтобы шаг мог проверить "есть ли это вообще" перед тем, как считать цель достигнутой.
  private async buildSystemPrompt(task: Task, botId: number, latestUserText: string): Promise<string> {
    if (!task.rag_enabled || !latestUserText.trim()) return task.task_description;

    let ragContext: string | null = null;
    try {
      ragContext = await this.ragSearchManager.buildContext(botId, latestUserText);
    } catch (err) {
      console.error("RAG buildContext failed (шаг с rag_enabled):", err);
    }
    if (!ragContext) return task.task_description;

    return `${task.task_description}\n\nКОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ ПО ПОСЛЕДНЕМУ СООБЩЕНИЮ КЛИЕНТА:\n${ragContext}`;
  }

  // Срезает ведущее приветствие/самопредставление из ответа (для случая, когда клиент уже был
  // поприветствован, а модель зачем-то поздоровалась снова). Если приветствия нет — возвращает как есть.
  private stripLeadingGreeting(text: string): string {
    if (!text) return text;
    let t = text.replace(/^[\s"'«]+/, "");
    const greetRe = /^(здравствуйте|здравствуй|приветствую|привет|добрый день|добрый вечер|доброе утро|доброго времени(?: суток)?)[\s!,.…—-]*/i;
    const m = t.match(greetRe);
    if (!m) return text; // приветствия нет — ничего не трогаем
    t = t.slice(m[0].length);
    // За приветствием часто идёт «Я <…> помощник <…>.» — убираем это одно предложение. Точку внутри
    // (домен «Papl.by») за конец не считаем: концом служит [.!?] перед пробелом и заглавной буквой.
    t = t.replace(/^я\s+[^!?]*?помощник[^!?]*?[.!?]+(?=\s+[А-ЯЁA-Z])/i, "");
    t = t.replace(/^[\s—-]+/, "");
    if (!t) return text; // весь текст был приветствием — лучше оставить исходное, чем пусто
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Запрос к «Менеджеру» + разбор с одним авто-ретраем: gemini изредка отдаёт оборванный/битый JSON.
  // Парсер сперва пробует спасти ответ; если и это не вышло — повторяем запрос один раз (свежая
  // генерация почти всегда валидна). Так единичный сбой модели не роняет диалог в «тех.неполадки».
  private async requestParsed(
    systemPrompt: string,
    payload: LLMRequestPayload,
    model: string,
    temperature: number
  ): Promise<ParsedResponse> {
    let lastErr: unknown;
    // 4 попытки с нарастающей паузой: эндпоинт Gemini у OpenRouter периодически отдаёт
    // finish_reason=error (rate-limit/сбой ~50% случаев). request внутри try, чтобы ретраить и это.
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const raw = await this.llmRequester.request(systemPrompt, payload, model, temperature);
        return this.responseParser.parse(raw);
      } catch (err) {
        lastErr = err;
        console.error(`LLM/parse failed (attempt ${attempt}/4):`, err instanceof Error ? err.message : err);
        if (attempt < 4) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    throw lastErr;
  }

  // «Справочная»: единственная задача — ответить на вопрос клиента по базе знаний. Отдельный
  // фокусный вызов (без логики сценария) → на слабой модели куда надёжнее, чем всё в одном шаге.
  // Возвращает готовый текст ответа ИЛИ "" (если вопроса по базе нет / базы нет / ответа нет-нет).
  private async answerFromRag(
    botId: number,
    text: string,
    model: string,
    history: LLMHistoryItem[]
  ): Promise<string> {
    const bot = await this.botRepo.findById(botId);
    if (!bot?.rag_enabled) return "";

    // Non-goals (с чем бот не помогает) справка ПРОПУСКАЕТ — их ведёт шаг через [ВНЕ ЗАДАЧ],
    // иначе на «статус заказа» вылезает двойной пузырь (справка + шаг про одно и то же).
    const nonGoals = await this.botRepo.getNonGoals(botId);
    const nonGoalsRule = nonGoals.length
      ? `\nВАЖНО (высший приоритет): если вопрос клиента про то, с чем бот НЕ помогает (${nonGoals.join("; ")}) — НЕ отвечай, верни ровно слово: НЕТ. Это обработает отдельный шаг, не ты.`
      : "";

    let ragContext: string | null = null;
    try {
      ragContext = await this.ragSearchManager.buildContext(botId, text);
    } catch (err) {
      console.error("RAG buildContext failed (answerFromRag):", err);
      return "";
    }
    if (!ragContext) return ""; // нет релевантной базы — вопроса по базе нет

    const sys = `Ты — «Справочная» бота компании Papl.by. ТВОЯ ЕДИНСТВЕННАЯ ЗАДАЧА — ответить на вопрос клиента по базе знаний ниже. НЕ веди диалог, не задавай вопросов, не собирай данные, не здоровайся.
Отвечай ЖИВО и по-человечески, как вежливый менеджер на «вы», тепло. 1–2 короткие фразы.
НИКОГДА не задавай уточняющих вопросов (например «для какой марки/модели?», «какой год?») — уточнять данные будет менеджер на следующем шаге, не ты. Твоё дело — только факт из базы.${nonGoalsRule}
Правила:
- В базе есть ИМЕННО запрошенное (наличие/цена/срок) → подтверди это ЕСТЕСТВЕННОЙ фразой. НЕ копируй сырую строку каталога с внутренними кодами/артикулами (например «VW-PB6-FR-RH-2011») — перескажи понятными словами: что за товар, цена, срок. Пример тона: «Да, есть — фара передняя правая на Volkswagen Passat B6 (2005–2011), 340 руб., под заказ 5–7 дней.»
- Клиент назвал товар БЕЗ уточнений (без модели авто), а в базе он есть под разные авто/варианты → дай ОБЩИЙ ответ, НЕ спрашивая модель: «Да, масляные фильтры есть в наличии, от 12.90 руб.». Модель уточнит менеджер дальше.
- Клиент спрашивает про АССОРТИМЕНТ/ОХВАТ («на какие авто есть запчасти?», «что у вас есть?», «какие товары в наличии?») → это ВОПРОС: перечисли из базы марки/модели или категории, которые есть. НЕ возвращай НЕТ.
- Клиент О ЧЁМ-ТО СПРАШИВАЕТ (товар, цена, срок, доставка, оплата, гарантия, услуги, ремонт, установка, условия работы — что угодно), но точного ответа в базе НЕТ → НЕ молчи: вежливо и по-человечески скажи, что точно не знаешь / этого нет, и предложи уточнить у менеджера (напр. «Точнее по этому подскажет менеджер при оформлении» или «Нет, установкой и ремонтом мы не занимаемся — только продаём запчасти»). Вежливый ответ ЛУЧШЕ, чем оставить без ответа. НЕ подсовывай смежное, не выдумывай числа.
- НЕТ возвращай ТОЛЬКО когда клиент вообще НИ О ЧЁМ не спросил: просто поздоровался, назвал имя, сказал «да», или лишь обозначил, какой товар хочет («меня интересует X», «хочу X», «нужен X», «давайте оформим X»). Тогда ответь ровно одним словом: НЕТ. Если же клиент задал ЛЮБОЙ вопрос (даже про услуги/ремонт/гарантию, даже если ответа в базе нет) — это вопрос, отвечай по правилам выше, а не НЕТ.
Ответь ПРОСТЫМ ТЕКСТОМ — только сам ответ клиенту (или слово НЕТ). Без JSON, без кавычек, без пояснений.

База знаний:
${ragContext}`;

    try {
      const raw = await this.llmRequester.requestText(sys, text, model, 0.5);
      const answer = raw.trim();
      // Сентинел «НЕТ» = вопроса по базе не было → пузырь Справочной не показываем.
      if (!answer || answer === "НЕТ" || answer.toUpperCase() === "НЕТ") return "";
      return answer;
    } catch (err) {
      console.error("answerFromRag failed:", err);
      return "";
    }
  }

  // Нормализует known из БД/ответа: jsonb-объект приходит объектом, строку (старые данные) распарсим.
  // Оставляем только строковые значения (слоты — простые «ключ: значение»).
  private toKnown(v: unknown): Record<string, string> {
    let obj: unknown = v;
    if (typeof obj === "string") {
      try { obj = JSON.parse(obj); } catch { return {}; }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) out[k] = val.trim();
    }
    return out;
  }

  // Вливает known_updates из ответа LLM в накопленный known диалога и сохраняет, если что-то новое.
  // Держит dialog.known в синхроне — его читают следующие шаги (payload.known).
  private async absorbKnown(dialog: Dialog, parsed: ParsedResponse): Promise<void> {
    const updates = this.toKnown((parsed as { known_updates?: unknown }).known_updates);
    if (Object.keys(updates).length === 0) return;
    const current = this.toKnown(dialog.known);
    const merged = { ...current, ...updates };
    const changed = Object.keys(merged).some((k) => merged[k] !== current[k]);
    if (changed) {
      await this.dialogRepo.setKnown(dialog.id, merged);
      dialog.known = merged;
    }
  }

  // Стоп-точка подтверждения товара на роутере. Модель НАДЁЖНО пишет «Правильно понимаю,
  // вас интересует X?», но упорно ставит next_process (уходит в ветку) — и подтверждение
  // затирается следующим шагом. Ловим этот случай и НЕ даём уйти: показываем вопрос, ждём
  // ответ клиента. На следующий ход (последняя реплика бота — уже подтверждение) не держим.
  private shouldHoldForConfirmation(task: Task, parsed: ParsedResponse, _dialog: Dialog, history: { role: string; content: string }[]): boolean {
    const isRouter = task.task_description.includes('"next_process"');
    const routing = typeof (parsed as { next_process?: unknown }).next_process === "number";
    // Ориентируемся на САМ текст роутера (он пишет подтверждение стабильно), а не на ключ known —
    // ключи модель называет по-разному («product»/«товар»), а формулировку подтверждения держит.
    const CONFIRM = /правильно (понима|ли я понял)|вас интересует[^?]{0,80}\?/i;
    const isConfirmation = CONFIRM.test(parsed.response_text ?? "");
    const lastBot = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
    const alreadyAsked = CONFIRM.test(lastBot);
    return isRouter && routing && isConfirmation && !alreadyAsked;
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
      // is_fallback=true — это "не разобрались, менеджер свяжется", НЕ настоящий заказ.
      // is_fallback=false — все параметры собраны штатно, это и есть заказ.
      // dialog.known на этот момент уже содержит все накопленные за диалог слоты (absorbKnown
      // отработал раньше в этом же ходе) — это и есть полная картина для "Заказов", а не
      // по-кусочный upsert() в crm_leads.information.
      await this.crmManager.markCompletion(dialog.id, !task.is_fallback, this.toKnown(dialog.known));
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
