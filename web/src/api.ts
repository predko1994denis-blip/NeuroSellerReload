const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export interface LoginResponse {
  token: string;
  role: "admin" | "manager";
  client_id: number | null;
}

export async function login(loginValue: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: loginValue, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Не удалось войти");
  }
  return res.json();
}

function authHeaders(): Record<string, string> {
  const raw = localStorage.getItem("neuroseller_auth");
  const token = raw ? (JSON.parse(raw).token as string) : "";
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

export interface Company {
  id: number;
  email: string;
  created_at: string;
}

export async function listClients(): Promise<Company[]> {
  const res = await fetch(`${API_BASE_URL}/api/clients`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Не удалось загрузить компании");
  }
  return res.json();
}

export interface Bot {
  id: number;
  client_id: number;
  token_tail: string;
  company_name: string;
  rag_enabled: boolean;
  teacher_mode_enabled: boolean;
  created_at: string;
}

export async function listBots(clientId: number): Promise<Bot[]> {
  const res = await fetch(`${API_BASE_URL}/api/bots?client_id=${clientId}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Не удалось загрузить ботов");
  }
  return res.json();
}

export async function updateBotCompanyName(botId: number, companyName: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/bots/${botId}/company-name`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ company_name: companyName }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось обновить название компании");
}

export interface CreateBotResponse {
  id: number;
  webhook_set: boolean;
}

export async function createBot(
  telegramToken: string,
  clientId: number,
  companyName: string
): Promise<CreateBotResponse> {
  const res = await fetch(`${API_BASE_URL}/api/bots/create`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ telegram_token: telegramToken, client_id: clientId, company_name: companyName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Не удалось создать бота");
  }
  return res.json();
}

export interface Process {
  id: number;
  bot_id: number;
  process_number: number;
  name: string;
  created_at: string;
}

export interface Task {
  id: number;
  process_id: number;
  task_number: string;
  task_description: string;
  task_type: "simple" | "analytical" | "completion";
  model: string;
  temperature: number;
  max_attempts: number;
  title?: string;
}

export async function listProcesses(botId: number): Promise<Process[]> {
  const res = await fetch(`${API_BASE_URL}/api/processes?bot_id=${botId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось загрузить процессы");
  return res.json();
}

export async function listTasks(processId: number): Promise<Task[]> {
  const res = await fetch(`${API_BASE_URL}/api/tasks?process_id=${processId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось загрузить задачи");
  return res.json();
}

export async function deleteProcess(processId: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/processes/${processId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось удалить процесс");
}

export interface GenerateProcessResponse {
  process: Process;
  tasks: Task[];
}

export type StepRuleType = "example" | "validation" | "custom";

export interface StepRule {
  type: StepRuleType;
  text: string;
}

export interface StepInput {
  goal: string;
  required: boolean;
  maxAttempts: number;
  fieldName?: string;
  rules?: StepRule[];
}

export async function generateProcess(
  botId: number,
  name: string,
  companyName: string,
  steps: StepInput[]
): Promise<GenerateProcessResponse> {
  const res = await fetch(`${API_BASE_URL}/api/processes/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ bot_id: botId, name, company_name: companyName, steps }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось сгенерировать цепочку");
  return res.json();
}

export interface ProcessInput {
  name: string;
  steps: StepInput[];
  router?: { branches: { condition: string; target: number }[] };
}

export interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

// 10 стилевых параметров общения бота — применяются ко всем НЕ-завершающим промптам сценария.
export interface ScenarioStyle {
  formality: number; // 1 разговорный — 5 деловой
  gender: "м" | "ж"; // грамматический род бота при самоописании ("я понял" / "я поняла")
  address: "ты" | "вы";
  warmth: number; // 1-5
  responseLength: number; // 1 кратко — 5 развёрнуто
  emoji: number; // 1 нет — 2 умеренно — 3 активно
  energy: number; // 1 спокойный — 5 напористый
  initiative: number; // 1 реактивный — 5 проактивный
  humor: number; // 1 серьёзный — 5 с юмором
  confidence: number; // 1 осторожный — 5 уверенный
  structure: number; // 1 сплошной текст — 5 структурировано
}

export const DEFAULT_SCENARIO_STYLE: ScenarioStyle = {
  formality: 3,
  gender: "м",
  address: "вы",
  warmth: 4,
  responseLength: 2,
  emoji: 2,
  energy: 3,
  initiative: 3,
  humor: 2,
  confidence: 4,
  structure: 2,
};

export interface Scenario {
  id: number;
  bot_id: number;
  name: string;
  company_name: string;
  graph: GraphData;
  style: ScenarioStyle | null;
  goals: string[];
  non_goals: string[];
  process_ids: number[];
  created_at: string;
}

export async function generateScenario(
  botId: number,
  companyName: string,
  processes: ProcessInput[],
  graph: GraphData,
  style: ScenarioStyle,
  name?: string,
  goals?: string[],
  nonGoals?: string[]
): Promise<{ scenario_id: number; processes: { id: number; name: string; process_number: number }[] }> {
  const res = await fetch(`${API_BASE_URL}/api/scenarios/generate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ bot_id: botId, company_name: companyName, processes, graph, style, name, goals, non_goals: nonGoals }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось сгенерировать сценарий");
  return res.json();
}

export async function listScenarios(botId: number): Promise<Scenario[]> {
  const res = await fetch(`${API_BASE_URL}/api/scenarios?bot_id=${botId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось загрузить сценарии");
  return res.json();
}

export async function getScenario(id: number): Promise<Scenario> {
  const res = await fetch(`${API_BASE_URL}/api/scenarios/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось загрузить сценарий");
  return res.json();
}

export async function regenerateScenario(
  id: number,
  companyName: string,
  processes: ProcessInput[],
  graph: GraphData,
  style: ScenarioStyle,
  name?: string,
  force?: boolean,
  goals?: string[],
  nonGoals?: string[]
): Promise<{
  scenario_id: number;
  processes: { id: number; name: string; process_number: number }[];
  reused_steps?: number;
}> {
  const res = await fetch(`${API_BASE_URL}/api/scenarios/${id}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ company_name: companyName, processes, graph, style, name, force, goals, non_goals: nonGoals }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось пересобрать сценарий");
  return res.json();
}

export async function deleteScenario(id: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/scenarios/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось удалить сценарий");
}

export async function updateTaskDescription(taskId: number, description: string): Promise<Task> {
  const res = await fetch(`${API_BASE_URL}/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ task_description: description }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось сохранить промпт");
  return res.json();
}

export interface RagDocument {
  id: number;
  bot_id: number;
  filename: string;
  created_at: string;
}

function authToken(): string {
  const raw = localStorage.getItem("neuroseller_auth");
  return raw ? (JSON.parse(raw).token as string) : "";
}

export async function listRagDocuments(botId: number): Promise<RagDocument[]> {
  const res = await fetch(`${API_BASE_URL}/api/rag/documents?bot_id=${botId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось загрузить документы");
  return res.json();
}

export async function uploadRagDocument(botId: number, file: File): Promise<void> {
  const form = new FormData();
  form.append("bot_id", String(botId));
  form.append("file", file);
  const res = await fetch(`${API_BASE_URL}/api/rag/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken()}` },
    body: form,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось загрузить документ");
}

export async function deleteRagDocument(documentId: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/rag/documents/${documentId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Не удалось удалить документ");
}

export interface RegisterClientResponse {
  client_id: number;
  user_id: number;
  token: string;
}

export async function registerClient(email: string, password: string): Promise<RegisterClientResponse> {
  const res = await fetch(`${API_BASE_URL}/api/clients/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Не удалось создать компанию");
  }
  return res.json();
}
