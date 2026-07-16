import type { ClientRepository } from "../repositories/ClientRepository";
import type { TokenRepository } from "../repositories/TokenRepository";
import type { UserRepository } from "../repositories/UserRepository";
import type { BotRepository } from "../repositories/BotRepository";
import type { ProcessRepository } from "../repositories/ProcessRepository";
import type { TaskRepository } from "../repositories/TaskRepository";
import type { RagIngestionManager } from "../managers/RagIngestionManager";
import type { RagDocumentRepository } from "../repositories/RagDocumentRepository";
import type { ProcessGenerator, StepInput, ScenarioStyle } from "../managers/ProcessGenerator";
import { DEFAULT_SCENARIO_STYLE, GenerationCache } from "../managers/ProcessGenerator";
import type { ScenarioRepository } from "../repositories/ScenarioRepository";
import type { DialogRepository } from "../repositories/DialogRepository";
import type { MessageRepository } from "../repositories/MessageRepository";
import type { MessageFeedbackRepository } from "../repositories/MessageFeedbackRepository";
import type { BotReminderSettingRepository } from "../repositories/BotReminderSettingRepository";
import type { CrmLeadRepository } from "../repositories/CrmLeadRepository";
import { authenticate, scopeClientId, requireAdmin, AuthError } from "../auth";
import { setTelegramWebhook, TelegramAdapter } from "../channels/TelegramAdapter";
import { extractTextFromPdf } from "../managers/PdfTextExtractor";
import type { PdfVisionExtractor } from "../managers/PdfVisionExtractor";

const BOT_MODEL = process.env.BOT_MODEL ?? "openai/gpt-4o-mini";

export interface AdminApiDeps {
  clientRepo: ClientRepository;
  tokenRepo: TokenRepository;
  userRepo: UserRepository;
  botRepo: BotRepository;
  processRepo: ProcessRepository;
  taskRepo: TaskRepository;
  ragIngestionManager: RagIngestionManager;
  ragDocumentRepo: RagDocumentRepository;
  pdfVisionExtractor: PdfVisionExtractor;
  processGenerator: ProcessGenerator;
  scenarioRepo: ScenarioRepository;
  dialogRepo: DialogRepository;
  messageRepo: MessageRepository;
  messageFeedbackRepo: MessageFeedbackRepository;
  botReminderSettingRepo: BotReminderSettingRepository;
  crmLeadRepo: CrmLeadRepository;
}

interface ScenarioProcessInput {
  name: string;
  steps: StepInput[];
  router?: { branches: { condition: string; target: number }[] };
}

// Общая логика: генерирует и сохраняет процессы+задачи по массиву processes. Возвращает
// созданные { id, name, process_number } — используется и при первой генерации, и при regenerate.
async function generateAndSaveProcesses(
  deps: AdminApiDeps,
  botId: number,
  companyName: string,
  processes: ScenarioProcessInput[],
  baseNumber: number,
  style: ScenarioStyle,
  cache: GenerationCache,
  userGoals: string[] = [],
  nonGoals: string[] = []
): Promise<{ id: number; name: string; process_number: number }[]> {
  const numberOf = (index: number) => baseNumber + index;

  // Целей сценария (список того, что реально может дать клиенту этот бот) — задаётся пользователем
  // явно в общих настройках сценария. Если не задан, для обратной совместимости выводим из
  // шагов/условий ветвлений (старое поведение) — передаётся в каждый промпт для защиты темы.
  const scenarioGoals = userGoals.length > 0
    ? userGoals
    : [
        ...processes.flatMap((p) => p.steps.map((s) => s.goal)),
        ...processes.flatMap((p) => p.router?.branches.map((b) => b.condition) ?? []),
      ].filter((g, i, arr) => g && arr.indexOf(g) === i);

  // Слоты сценария (slot-filling): что бот собирает по ходу ВСЕХ шагов — список меток данных.
  // Передаётся в каждый шаг, чтобы модель извлекала любые упомянутые данные в known_updates.
  // Чистим цель до сущности: срезаем глаголы и выкидываем чисто-действенные шаги (поздороваться/
  // попрощаться/показать) — они данные не собирают и в списке сущностей не нужны. Товар — сквозной.
  const cleanSlot = (goal: string): string | null => {
    const g = goal.trim();
    if (/^(поздоров|поприветств|попрощ|показать|сообщ|подтверд)/i.test(g) && !/узнать|выяснить|уточнить|собрать/i.test(g)) return null;
    return g.replace(/^(поздороваться и\s+|поприветствовать и\s+)?(узнать|выяснить|уточнить|собрать|спросить|получить)\s+/i, "").trim() || null;
  };
  const slots = [
    ...processes.flatMap((p) => p.steps.map((s) => cleanSlot(s.goal))),
    "интересующий товар (что клиент хочет купить)",
  ].filter((g, i, arr): g is string => !!g && arr.indexOf(g) === i);

  // cache: если содержимое шага (цель/правила/попытки) не изменилось с прошлой генерации
  // этого сценария, шаг переиспользует старый текст вместо нового вызова LLM (инкремент).
  const generatedPerProcess = await Promise.all(
    processes.map((proc) => {
      const hasRouter = !!proc.router && proc.router.branches.length > 0;
      return hasRouter
        ? deps.processGenerator.generateWithBranching(
            companyName,
            proc.steps,
            proc.router!.branches.map((b) => ({ condition: b.condition, targetProcessNumber: numberOf(b.target) })),
            style,
            scenarioGoals,
            cache,
            nonGoals,
            slots
          )
        : deps.processGenerator.generate(companyName, proc.steps, style, scenarioGoals, cache, nonGoals, slots);
    })
  );

  return Promise.all(
    processes.map(async (proc, pi) => {
      const generated = generatedPerProcess[pi]!;
      const processRow = await deps.processRepo.create(botId, numberOf(pi), proc.name);

      for (let i = 0; i < generated.length; i++) {
        const t = generated[i]!;
        await deps.taskRepo.create({
          process_id: processRow.id,
          task_number: t.task_number,
          task_description: t.task_description,
          task_type: t.task_type,
          model: BOT_MODEL,
          temperature: 0.7,
          max_attempts: proc.steps[i]?.maxAttempts ?? 3,
          required: proc.steps[i]?.required ?? true,
          is_fallback: t.is_fallback ?? false,
          accepts_image: proc.steps[i]?.acceptsImage ?? false,
          rag_enabled: proc.steps[i]?.ragEnabled ?? false,
          title: t.title,
          context_strategy_id: null,
        });
      }

      return { id: processRow.id, name: processRow.name, process_number: processRow.process_number };
    })
  );
}

// Проверяет, что бот существует и принадлежит текущему пользователю (admin — любому)
async function assertBotAccess(deps: AdminApiDeps, botId: number, auth: { role: string; clientId: number | null }) {
  const bot = await deps.botRepo.findById(botId);
  if (!bot || (auth.role !== "admin" && bot.client_id !== auth.clientId)) {
    throw new Error("Бот не найден");
  }
  return bot;
}

// Проверяет доступ к диалогу: диалог существует и его бот принадлежит пользователю (admin — любому)
async function assertDialogAccess(deps: AdminApiDeps, dialogId: number, auth: { role: string; clientId: number | null }) {
  const dialog = await deps.dialogRepo.findById(dialogId);
  if (!dialog) throw new Error("Диалог не найден");
  await assertBotAccess(deps, dialog.bot_id, auth); // бросит, если бот не принадлежит клиенту
  return dialog;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// Возвращает Response, если путь/метод обработан этим роутером, иначе null (пусть решает следующий роутер)
export async function handleAdminApi(request: Request, deps: AdminApiDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;

  try {
    if (pathname === "/api/clients/register" && request.method === "POST") {
      return await registerClient(request, deps);
    }
    if (pathname === "/api/clients" && request.method === "GET") {
      return await listClients(request, deps);
    }
    if (pathname === "/api/auth/login" && request.method === "POST") {
      return await login(request, deps);
    }
    if (pathname === "/api/bots/create" && request.method === "POST") {
      return await createBot(request, deps);
    }
    if (pathname === "/api/bots" && request.method === "GET") {
      return await listBots(request, deps);
    }
    if (pathname.startsWith("/api/bots/") && pathname.endsWith("/company-name") && request.method === "PATCH") {
      const id = Number(pathname.split("/")[3]);
      return await updateBotCompanyName(id, request, deps);
    }
    if (pathname.startsWith("/api/bots/") && pathname.endsWith("/rag-enabled") && request.method === "PATCH") {
      const id = Number(pathname.split("/")[3]);
      return await updateBotRagEnabled(id, request, deps);
    }
    if (pathname.match(/^\/api\/bots\/\d+\/reminder-settings$/) && request.method === "GET") {
      const id = Number(pathname.split("/")[3]);
      return await listReminderSettings(id, request, deps);
    }
    if (pathname.match(/^\/api\/bots\/\d+\/reminder-settings$/) && request.method === "PUT") {
      const id = Number(pathname.split("/")[3]);
      return await updateReminderSettings(id, request, deps);
    }
    if (pathname === "/api/processes/create" && request.method === "POST") {
      return await createProcess(request, deps);
    }
    if (pathname === "/api/processes/generate" && request.method === "POST") {
      return await generateProcess(request, deps);
    }
    if (pathname === "/api/scenarios/generate" && request.method === "POST") {
      return await generateScenario(request, deps);
    }
    if (pathname === "/api/scenarios" && request.method === "GET") {
      return await listScenarios(request, deps);
    }
    if (pathname.match(/^\/api\/scenarios\/\d+$/) && request.method === "GET") {
      const id = Number(pathname.split("/").pop());
      return await getScenario(id, request, deps);
    }
    if (pathname.match(/^\/api\/scenarios\/\d+$/) && request.method === "PUT") {
      const id = Number(pathname.split("/").pop());
      return await regenerateScenario(id, request, deps);
    }
    if (pathname.match(/^\/api\/scenarios\/\d+$/) && request.method === "DELETE") {
      const id = Number(pathname.split("/").pop());
      return await deleteScenario(id, request, deps);
    }
    if (pathname.match(/^\/api\/tasks\/\d+$/) && request.method === "PATCH") {
      const id = Number(pathname.split("/").pop());
      return await updateTaskDescription(id, request, deps);
    }
    if (pathname === "/api/processes" && request.method === "GET") {
      return await listProcesses(request, deps);
    }
    if (pathname.startsWith("/api/processes/") && request.method === "DELETE") {
      const id = Number(pathname.split("/").pop());
      return await deleteProcess(id, request, deps);
    }
    if (pathname === "/api/tasks/create" && request.method === "POST") {
      return await createTask(request, deps);
    }
    if (pathname === "/api/tasks" && request.method === "GET") {
      return await listTasks(request, deps);
    }
    if (pathname === "/api/rag/upload" && request.method === "POST") {
      return await uploadRagDocument(request, deps);
    }
    if (pathname === "/api/rag/documents" && request.method === "GET") {
      return await listRagDocuments(request, deps);
    }
    if (pathname.startsWith("/api/rag/documents/") && request.method === "DELETE") {
      const id = Number(pathname.split("/").pop());
      return await deleteRagDocument(id, request, deps);
    }
    if (pathname === "/api/dialogs" && request.method === "GET") {
      return await listDialogs(request, deps);
    }
    if (pathname === "/api/orders" && request.method === "GET") {
      return await listOrders(request, deps);
    }
    if (pathname.match(/^\/api\/dialogs\/\d+\/messages$/) && request.method === "GET") {
      const id = Number(pathname.split("/")[3]);
      return await getDialogMessages(id, request, deps);
    }
    if (pathname.match(/^\/api\/dialogs\/\d+$/) && request.method === "PATCH") {
      const id = Number(pathname.split("/").pop());
      return await updateDialog(id, request, deps);
    }
    if (pathname.match(/^\/api\/dialogs\/\d+\/takeover$/) && request.method === "POST") {
      const id = Number(pathname.split("/")[3]);
      return await takeoverDialog(id, request, deps);
    }
    if (pathname.match(/^\/api\/dialogs\/\d+\/release$/) && request.method === "POST") {
      const id = Number(pathname.split("/")[3]);
      return await releaseDialog(id, request, deps);
    }
    if (pathname.match(/^\/api\/dialogs\/\d+\/send$/) && request.method === "POST") {
      const id = Number(pathname.split("/")[3]);
      return await sendDialogMessage(id, request, deps);
    }
    if (pathname.match(/^\/api\/messages\/\d+\/feedback$/) && request.method === "POST") {
      const id = Number(pathname.split("/")[3]);
      return await saveMessageFeedback(id, request, deps);
    }
    if (pathname.match(/^\/api\/messages\/\d+\/feedback$/) && request.method === "DELETE") {
      const id = Number(pathname.split("/")[3]);
      return await deleteMessageFeedback(id, request, deps);
    }
    if (pathname === "/api/feedback" && request.method === "GET") {
      return await listFeedback(request, deps);
    }
    if (pathname.match(/^\/api\/feedback\/\d+\/resolved$/) && request.method === "PATCH") {
      const id = Number(pathname.split("/")[3]);
      return await setFeedbackResolved(id, request, deps);
    }
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, 401);
    if (err instanceof Error) return json({ error: err.message }, 400);
    throw err;
  }

  return null;
}

async function issueToken(deps: AdminApiDeps, userId: number): Promise<string> {
  const token = crypto.randomUUID();
  await deps.tokenRepo.create(userId, token);
  return token;
}

async function registerClient(request: Request, deps: AdminApiDeps): Promise<Response> {
  // Создавать компании и их логины может только настройщик (admin) — публичной регистрации нет.
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);

  const body = (await request.json()) as { email?: string; password?: string; company_name?: string };
  if (!body.email || !body.password) throw new Error("email и password обязательны");

  const existing = await deps.clientRepo.findByEmail(body.email);
  if (existing) throw new Error("Клиент с таким email уже существует");

  const passwordHash = await Bun.password.hash(body.password);
  const client = await deps.clientRepo.create(body.email, passwordHash, body.company_name?.trim() ?? "");

  // Регистрация компании сразу создаёт её первого пользователя — менеджера с тем же логином
  const user = await deps.userRepo.create(body.email, passwordHash, "manager", client.id);
  const token = await issueToken(deps, user.id);

  return json({ client_id: client.id, user_id: user.id, token });
}

async function listClients(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);

  // admin видит все компании, manager — только свою
  const clients = auth.role === "admin"
    ? await deps.clientRepo.findAll()
    : auth.clientId
      ? [await deps.clientRepo.findById(auth.clientId)].filter((c) => c !== null)
      : [];

  // не отдаём password_hash наружу
  const safe = clients.map((c) => ({ id: c!.id, email: c!.email, company_name: c!.company_name, created_at: c!.created_at }));
  return json(safe);
}

async function login(request: Request, deps: AdminApiDeps): Promise<Response> {
  const body = (await request.json()) as { login?: string; password?: string };
  if (!body.login || !body.password) throw new Error("login и password обязательны");

  const user = await deps.userRepo.findByLogin(body.login);
  if (!user) throw new AuthError("Неверный логин или пароль");

  const valid = await Bun.password.verify(body.password, user.password_hash);
  if (!valid) throw new AuthError("Неверный логин или пароль");

  const token = await issueToken(deps, user.id);
  return json({ token, role: user.role, client_id: user.client_id });
}

async function createBot(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth); // ботов заводит только настройщик
  const body = (await request.json()) as { telegram_token?: string; client_id?: number; company_name?: string };
  if (!body.telegram_token) throw new Error("telegram_token обязателен");

  const clientId = scopeClientId(auth, body.client_id);
  if (!clientId) throw new Error("client_id обязателен");

  const bot = await deps.botRepo.create(clientId, body.telegram_token, body.company_name?.trim() ?? "");

  // Сразу регистрируем webhook, чтобы бот начал принимать сообщения.
  // Если WEBHOOK_BASE_URL не задан — бот создастся, но webhook нужно будет поставить отдельно.
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  let webhookSet = false;
  if (baseUrl) {
    try {
      await setTelegramWebhook(body.telegram_token, `${baseUrl}/webhook/telegram/${body.telegram_token}`);
      webhookSet = true;
    } catch {
      // невалидный токен / Telegram недоступен — бот всё равно создан, фронт покажет статус
      webhookSet = false;
    }
  }

  return json({ ...bot, webhook_set: webhookSet });
}

async function listBots(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const url = new URL(request.url);
  const requestedClientId = url.searchParams.get("client_id");

  const clientId = scopeClientId(auth, requestedClientId ? Number(requestedClientId) : undefined);
  if (!clientId) throw new Error("client_id обязателен");

  const bots = await deps.botRepo.findByClientId(clientId);
  // токен — секрет, наружу отдаём только хвост для опознания
  const safe = bots.map((b) => ({
    id: b.id,
    client_id: b.client_id,
    token_tail: b.telegram_token.slice(-6),
    company_name: b.company_name,
    rag_enabled: b.rag_enabled,
    teacher_mode_enabled: b.teacher_mode_enabled,
    created_at: b.created_at,
  }));
  return json(safe);
}

async function updateBotCompanyName(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const body = (await request.json()) as { company_name?: string };
  if (!body.company_name?.trim()) throw new Error("company_name обязателен");

  await assertBotAccess(deps, id, auth);

  const bot = await deps.botRepo.updateCompanyName(id, body.company_name.trim());
  return json({ id: bot.id, company_name: bot.company_name });
}

async function updateBotRagEnabled(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const body = (await request.json()) as { rag_enabled?: boolean };
  if (typeof body.rag_enabled !== "boolean") throw new Error("rag_enabled (boolean) обязателен");

  await assertBotAccess(deps, id, auth);

  const bot = await deps.botRepo.updateRagEnabled(id, body.rag_enabled);
  return json({ id: bot.id, rag_enabled: bot.rag_enabled });
}

async function listReminderSettings(botId: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  await assertBotAccess(deps, botId, auth);

  const steps = await deps.botReminderSettingRepo.findByBotId(botId);
  return json(steps.map((s) => ({ step_order: s.step_order, delay_minutes: s.delay_minutes })));
}

async function updateReminderSettings(botId: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  await assertBotAccess(deps, botId, auth);

  const body = (await request.json()) as { steps?: { delay_minutes?: number }[] };
  if (!Array.isArray(body.steps)) throw new Error("steps (массив) обязателен");
  for (const s of body.steps) {
    if (!s.delay_minutes || s.delay_minutes <= 0) throw new Error("У каждого шага delay_minutes должен быть > 0");
  }

  const steps = body.steps.map((s, i) => ({ stepOrder: i + 1, delayMinutes: s.delay_minutes! }));
  const saved = await deps.botReminderSettingRepo.replaceForBot(botId, steps);
  return json(saved.map((s) => ({ step_order: s.step_order, delay_minutes: s.delay_minutes })));
}

async function createProcess(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);
  const body = (await request.json()) as { bot_id?: number; process_number?: number; name?: string };
  if (!body.bot_id || !body.process_number || !body.name) {
    throw new Error("bot_id, process_number и name обязательны");
  }

  const bot = await deps.botRepo.findById(body.bot_id);
  if (!bot || (auth.role !== "admin" && bot.client_id !== auth.clientId)) throw new Error("Бот не найден");

  const process = await deps.processRepo.create(body.bot_id, body.process_number, body.name);
  return json(process);
}

// Генерация цепочки задач: один LLM-вызов на КАЖДЫЙ шаг (параллельно) + сохранение в БД
async function generateProcess(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);
  const body = (await request.json()) as {
    bot_id?: number;
    name?: string;
    company_name?: string;
    steps?: StepInput[];
  };
  if (!body.bot_id || !body.name || !body.company_name || !body.steps || body.steps.length === 0) {
    throw new Error("bot_id, name, company_name и steps (хотя бы один) обязательны");
  }
  for (const s of body.steps) {
    if (!s.goal || typeof s.required !== "boolean" || !s.maxAttempts) {
      throw new Error("У каждого шага обязательны goal, required и maxAttempts");
    }
  }

  await assertBotAccess(deps, body.bot_id, auth);

  // следующий свободный номер процесса для этого бота
  const existing = await deps.processRepo.findByBotId(body.bot_id);
  const nextNumber = existing.reduce((max, p) => Math.max(max, p.process_number), 0) + 1;

  const generated = await deps.processGenerator.generate(body.company_name, body.steps);

  const process = await deps.processRepo.create(body.bot_id, nextNumber, body.name);

  const createdTasks = [];
  for (let i = 0; i < generated.length; i++) {
    const t = generated[i]!;
    const task = await deps.taskRepo.create({
      process_id: process.id,
      task_number: t.task_number,
      task_description: t.task_description,
      task_type: t.task_type,
      model: BOT_MODEL,
      temperature: 0.7,
      max_attempts: body.steps[i]!.maxAttempts,
      required: body.steps[i]!.required,
      is_fallback: t.is_fallback ?? false,
      accepts_image: body.steps[i]!.acceptsImage ?? false,
      rag_enabled: body.steps[i]!.ragEnabled ?? false,
      title: t.title,
      context_strategy_id: null,
    });
    createdTasks.push({ ...task, title: t.title });
  }

  return json({ process, tasks: createdTasks });
}

// Генерация СЦЕНАРИЯ с ветвлением: несколько процессов, роутеры направляют через next_process.
// Каждый процесс: { name, steps[], router?: { branches: [{condition, target}] } }, где target —
// индекс целевого процесса в массиве processes. graph — сырые nodes/edges конструктора,
// сохраняются, чтобы сценарий можно было открыть снова и отредактировать визуально.
async function generateScenario(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);
  const body = (await request.json()) as {
    bot_id?: number;
    name?: string;
    company_name?: string;
    processes?: ScenarioProcessInput[];
    graph?: unknown;
    style?: Partial<ScenarioStyle>;
    goals?: string[];
    non_goals?: string[];
  };
  if (!body.bot_id || !body.company_name || !body.processes || body.processes.length === 0) {
    throw new Error("bot_id, company_name и processes (хотя бы один) обязательны");
  }

  await assertBotAccess(deps, body.bot_id, auth);

  const style: ScenarioStyle = { ...DEFAULT_SCENARIO_STYLE, ...body.style };
  const goals = (body.goals ?? []).map((g) => g.trim()).filter(Boolean);
  const nonGoals = (body.non_goals ?? []).map((g) => g.trim()).filter(Boolean);

  const existing = await deps.processRepo.findByBotId(body.bot_id);
  const baseNumber = existing.reduce((max, p) => Math.max(max, p.process_number), 0) + 1;

  const cache = new GenerationCache();
  const createdProcesses = await generateAndSaveProcesses(
    deps,
    body.bot_id,
    body.company_name,
    body.processes,
    baseNumber,
    style,
    cache,
    goals,
    nonGoals
  );

  const scenario = await deps.scenarioRepo.create(
    body.bot_id,
    body.name?.trim() || body.processes[0]!.name,
    body.company_name,
    body.graph ?? { nodes: [], edges: [] },
    createdProcesses.map((p) => p.id),
    style,
    cache.toRecord(),
    goals,
    nonGoals
  );

  return json({ scenario_id: scenario.id, processes: createdProcesses });
}

async function listScenarios(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const url = new URL(request.url);
  const botId = Number(url.searchParams.get("bot_id"));
  if (!botId) throw new Error("bot_id обязателен");

  await assertBotAccess(deps, botId, auth);
  const scenarios = await deps.scenarioRepo.findByBotId(botId);
  return json(scenarios.map((s) => ({ id: s.id, bot_id: s.bot_id, name: s.name, company_name: s.company_name, style: s.style, process_ids: s.process_ids, created_at: s.created_at })));
}

async function getScenario(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const scenario = await deps.scenarioRepo.findById(id);
  if (!scenario) throw new Error("Сценарий не найден");
  await assertBotAccess(deps, scenario.bot_id, auth);
  return json(scenario);
}

// Пересобирает сценарий: удаляет старые процессы/задачи, генерирует заново по новому графу.
async function regenerateScenario(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);
  const scenario = await deps.scenarioRepo.findById(id);
  if (!scenario) throw new Error("Сценарий не найден");
  await assertBotAccess(deps, scenario.bot_id, auth);

  const body = (await request.json()) as {
    name?: string;
    company_name?: string;
    processes?: ScenarioProcessInput[];
    graph?: unknown;
    style?: Partial<ScenarioStyle>;
    goals?: string[];
    non_goals?: string[];
    force?: boolean; // true = игнорировать кеш, регенерировать все шаги заново (напр. после фикса мета-промпта)
  };
  if (!body.company_name || !body.processes || body.processes.length === 0) {
    throw new Error("company_name и processes (хотя бы один) обязательны");
  }

  const style: ScenarioStyle = {
    ...DEFAULT_SCENARIO_STYLE,
    ...(scenario.style as Partial<ScenarioStyle> | null),
    ...body.style,
  };
  const goals = (body.goals ?? scenario.goals ?? []).map((g) => g.trim()).filter(Boolean);
  const nonGoals = (body.non_goals ?? scenario.non_goals ?? []).map((g) => g.trim()).filter(Boolean);

  // старые процессы этого сценария удаляем (каскадно удалит их задачи), номера процессов
  // переиспользуем с той же базовой точки, что и раньше — просто пересчитываем заново
  for (const pid of scenario.process_ids) {
    await deps.processRepo.delete(pid).catch(() => {});
  }

  const existing = await deps.processRepo.findByBotId(scenario.bot_id);
  const baseNumber = existing.reduce((max, p) => Math.max(max, p.process_number), 0) + 1;

  // Кеш из прошлой генерации: шаги, у которых цель/правила/попытки/стиль не поменялись,
  // переиспользуют старый текст вместо нового вызова LLM — регенерируются только новые/изменённые.
  // force=true игнорирует кеш полностью (например, после правки самого мета-промпта на бэкенде,
  // когда отпечаток шага не поменялся, но сгенерированный текст должен обновиться).
  const cache = new GenerationCache(body.force ? {} : scenario.generation_cache);
  const createdProcesses = await generateAndSaveProcesses(
    deps,
    scenario.bot_id,
    body.company_name,
    body.processes,
    baseNumber,
    style,
    cache,
    goals,
    nonGoals
  );

  const updated = await deps.scenarioRepo.update(
    id,
    body.graph ?? scenario.graph,
    createdProcesses.map((p) => p.id),
    style,
    cache.toRecord(),
    goals,
    nonGoals
  );

  return json({ scenario_id: updated.id, processes: createdProcesses, reused_steps: cache.hitCount });
}

async function deleteScenario(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);
  const scenario = await deps.scenarioRepo.findById(id);
  if (!scenario) throw new Error("Сценарий не найден");
  await assertBotAccess(deps, scenario.bot_id, auth);

  for (const pid of scenario.process_ids) {
    await deps.processRepo.delete(pid).catch(() => {});
  }
  await deps.scenarioRepo.delete(id);
  return json({ ok: true });
}

async function updateTaskDescription(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);
  const body = (await request.json()) as { task_description?: string };
  if (!body.task_description?.trim()) throw new Error("task_description обязателен");

  const task = await deps.taskRepo.findById(id);
  if (!task) throw new Error("Задача не найдена");
  const process = await deps.processRepo.findById(task.process_id);
  if (!process) throw new Error("Задача не найдена");
  await assertBotAccess(deps, process.bot_id, auth);

  const updated = await deps.taskRepo.updateDescription(id, body.task_description.trim());
  return json(updated);
}

async function listProcesses(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const url = new URL(request.url);
  const botId = Number(url.searchParams.get("bot_id"));
  if (!botId) throw new Error("bot_id обязателен");

  await assertBotAccess(deps, botId, auth);
  const processes = await deps.processRepo.findByBotId(botId);
  return json(processes);
}

async function deleteProcess(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);
  if (!id) throw new Error("Некорректный id процесса");

  const process = await deps.processRepo.findById(id);
  if (!process) throw new Error("Процесс не найден");
  await assertBotAccess(deps, process.bot_id, auth);

  await deps.processRepo.delete(id);
  return json({ ok: true });
}

async function listTasks(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const url = new URL(request.url);
  const processId = Number(url.searchParams.get("process_id"));
  if (!processId) throw new Error("process_id обязателен");

  const process = await deps.processRepo.findById(processId);
  if (!process) throw new Error("Процесс не найден");
  await assertBotAccess(deps, process.bot_id, auth);

  const tasks = await deps.taskRepo.findByProcessId(processId);
  return json(tasks);
}

async function createTask(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);
  const body = (await request.json()) as {
    process_id?: number;
    task_number?: string;
    task_description?: string;
    task_type?: "simple" | "analytical" | "completion";
    model?: string;
    temperature?: number;
    max_attempts?: number;
    context_strategy_id?: number | null;
  };
  if (!body.process_id || !body.task_number || !body.task_description || !body.task_type || !body.model) {
    throw new Error("process_id, task_number, task_description, task_type и model обязательны");
  }

  const process = await deps.processRepo.findById(body.process_id);
  if (!process) throw new Error("Процесс не найден");
  const bot = await deps.botRepo.findById(process.bot_id);
  if (!bot || (auth.role !== "admin" && bot.client_id !== auth.clientId)) throw new Error("Процесс не найден");

  const task = await deps.taskRepo.create({
    process_id: body.process_id,
    task_number: body.task_number,
    task_description: body.task_description,
    task_type: body.task_type,
    model: body.model,
    temperature: body.temperature ?? 0.7,
    max_attempts: body.max_attempts ?? 3,
    required: true,
    is_fallback: false,
    accepts_image: false,
    rag_enabled: false,
    title: "",
    context_strategy_id: body.context_strategy_id ?? null,
  });
  return json(task);
}

async function uploadRagDocument(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const form = await request.formData();

  const botId = Number(form.get("bot_id"));
  const file = form.get("file");
  if (!botId || !(file instanceof File)) {
    throw new Error("bot_id и file (PDF) обязательны");
  }
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("Поддерживаются только PDF-файлы");
  }

  await assertBotAccess(deps, botId, auth);

  const buffer = Buffer.from(await file.arrayBuffer());

  // Основной путь — «прочитать глазами» (vision), корректно берёт таблицы/прайсы.
  // Фолбэк — старый линейный парсер: если рендер/vision по любой причине упадёт
  // (нет системных либ, лимит ключа и т.п.), загрузка всё равно не сломается.
  let text = "";
  try {
    text = await deps.pdfVisionExtractor.extract(buffer);
  } catch (err) {
    console.error("PDF vision-извлечение не удалось, откат к pdf-parse:", err);
  }
  if (!text.trim()) {
    text = await extractTextFromPdf(buffer);
  }

  await deps.ragIngestionManager.ingest(botId, file.name, text);
  return json({ ok: true });
}

async function listRagDocuments(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const url = new URL(request.url);
  const botId = Number(url.searchParams.get("bot_id"));
  if (!botId) throw new Error("bot_id обязателен");

  await assertBotAccess(deps, botId, auth);

  const documents = await deps.ragDocumentRepo.findByBotId(botId);
  return json(documents);
}

async function deleteRagDocument(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const document = await deps.ragDocumentRepo.findById(id);
  if (!document) throw new Error("Документ не найден");

  await assertBotAccess(deps, document.bot_id, auth);

  await deps.ragDocumentRepo.delete(id);
  return json({ ok: true });
}

// ── Портал менеджера: диалоги и пометки сообщений ──

// GET /api/dialogs?bot_id= — список диалогов бота (скоуп по компании).
async function listDialogs(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const url = new URL(request.url);
  const botId = Number(url.searchParams.get("bot_id"));
  if (!botId) throw new Error("bot_id обязателен");

  await assertBotAccess(deps, botId, auth);
  const dialogs = await deps.dialogRepo.findByBotId(botId);
  return json(dialogs);
}

// GET /api/orders?bot_id= — заказы (лиды с полностью собранными данными), доступно и
// настройщику, и менеджеру этой компании (та же проверка доступа, что и у диалогов).
async function listOrders(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const url = new URL(request.url);
  const botId = Number(url.searchParams.get("bot_id"));
  if (!botId) throw new Error("bot_id обязателен");

  await assertBotAccess(deps, botId, auth);
  const orders = await deps.crmLeadRepo.listOrdersByBotId(botId);
  return json(orders);
}

// GET /api/dialogs/:id/messages — сообщения диалога + пометки менеджера.
async function getDialogMessages(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  await assertDialogAccess(deps, id, auth);

  const messages = await deps.messageRepo.findByDialogId(id);
  const feedback = await deps.messageFeedbackRepo.findByDialogId(id);
  const feedbackByMessage: Record<number, string> = {};
  for (const f of feedback) feedbackByMessage[f.message_id] = f.suggested_answer;

  return json(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content ?? "",
      created_at: m.created_at,
      feedback: feedbackByMessage[m.id] ?? null,
      sent_by: m.sent_by,
    }))
  );
}

// PATCH /api/dialogs/:id — переключить «завершён/активен» вручную (доступно и менеджеру).
async function updateDialog(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  await assertDialogAccess(deps, id, auth);

  const body = (await request.json()) as { is_active?: boolean };
  if (typeof body.is_active !== "boolean") throw new Error("is_active обязателен");

  const dialog = await deps.dialogRepo.update(id, { is_active: body.is_active });
  // Завершённый диалог не должен оставаться «висеть» перехваченным — иначе следующий клиент
  // того же чата попадёт в новый диалог, а старый останется заблокирован для бота навсегда.
  if (!body.is_active && dialog.taken_over_by !== null) {
    await deps.dialogRepo.setTakenOverBy(id, null);
  }
  return json({ ok: true, is_active: dialog.is_active });
}

// POST /api/dialogs/:id/takeover — менеджер перехватывает диалог: бот перестаёт отвечать автоматически.
async function takeoverDialog(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  await assertDialogAccess(deps, id, auth);

  const dialog = await deps.dialogRepo.setTakenOverBy(id, auth.userId);
  return json({ ok: true, taken_over_by: dialog.taken_over_by });
}

// POST /api/dialogs/:id/release — отдать управление обратно боту.
async function releaseDialog(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  await assertDialogAccess(deps, id, auth);

  const dialog = await deps.dialogRepo.setTakenOverBy(id, null);
  return json({ ok: true, taken_over_by: dialog.taken_over_by });
}

// POST /api/dialogs/:id/send — менеджер пишет клиенту напрямую (только пока диалог перехвачен).
async function sendDialogMessage(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const dialog = await assertDialogAccess(deps, id, auth);
  if (dialog.taken_over_by === null) {
    throw new Error("Сначала перехватите диалог, прежде чем писать клиенту");
  }

  const body = (await request.json()) as { text?: string };
  const text = (body.text ?? "").trim();
  if (!text) throw new Error("text обязателен");

  const bot = await deps.botRepo.findById(dialog.bot_id);
  if (!bot) throw new Error("Бот не найден");

  await new TelegramAdapter(bot.telegram_token).sendMessage(dialog.chat_id, text);
  const message = await deps.messageRepo.create(id, "assistant", text, auth.userId);
  return json({ ok: true, message_id: message.id });
}

// POST /api/messages/:id/feedback — сохранить «как надо было ответить» для сообщения бота.
async function saveMessageFeedback(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const message = await deps.messageRepo.findById(id);
  if (!message) throw new Error("Сообщение не найдено");
  await assertDialogAccess(deps, message.dialog_id, auth);

  const body = (await request.json()) as { suggested_answer?: string };
  const suggested = (body.suggested_answer ?? "").trim();
  if (!suggested) throw new Error("suggested_answer обязателен");

  const fb = await deps.messageFeedbackRepo.upsert(id, suggested, auth.userId);
  return json({ ok: true, feedback: fb.suggested_answer });
}

// DELETE /api/messages/:id/feedback — снять пометку.
async function deleteMessageFeedback(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  const message = await deps.messageRepo.findById(id);
  if (!message) throw new Error("Сообщение не найдено");
  await assertDialogAccess(deps, message.dialog_id, auth);

  await deps.messageFeedbackRepo.delete(id);
  return json({ ok: true });
}

// GET /api/feedback?bot_id= — все пометки менеджера по боту, с контекстом. Только настройщик.
async function listFeedback(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);

  const url = new URL(request.url);
  const botId = Number(url.searchParams.get("bot_id"));
  if (!botId) throw new Error("bot_id обязателен");

  await assertBotAccess(deps, botId, auth);
  const feedback = await deps.messageFeedbackRepo.findAllByBotId(botId);
  return json(feedback);
}

// PATCH /api/feedback/:id/resolved — отметить пометку разобранной / вернуть в работу.
async function setFeedbackResolved(id: number, request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
  requireAdmin(auth);

  const body = (await request.json()) as { resolved?: boolean };
  const fb = await deps.messageFeedbackRepo.setResolved(id, !!body.resolved);
  return json({ ok: true, resolved: fb.resolved });
}
