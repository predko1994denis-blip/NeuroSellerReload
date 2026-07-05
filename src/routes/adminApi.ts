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
import { authenticate, scopeClientId, AuthError } from "../auth";
import { setTelegramWebhook } from "../channels/TelegramAdapter";
import { extractTextFromPdf } from "../managers/PdfTextExtractor";

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
  processGenerator: ProcessGenerator;
  scenarioRepo: ScenarioRepository;
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
            nonGoals
          )
        : deps.processGenerator.generate(companyName, proc.steps, style, scenarioGoals, cache, nonGoals);
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
  const body = (await request.json()) as { email?: string; password?: string };
  if (!body.email || !body.password) throw new Error("email и password обязательны");

  const existing = await deps.clientRepo.findByEmail(body.email);
  if (existing) throw new Error("Клиент с таким email уже существует");

  const passwordHash = await Bun.password.hash(body.password);
  const client = await deps.clientRepo.create(body.email, passwordHash);

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
  const safe = clients.map((c) => ({ id: c!.id, email: c!.email, created_at: c!.created_at }));
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

async function createProcess(request: Request, deps: AdminApiDeps): Promise<Response> {
  const auth = await authenticate(request, deps.tokenRepo, deps.userRepo);
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
  const text = await extractTextFromPdf(buffer);

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
