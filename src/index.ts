import { BotRepository } from "./repositories/BotRepository";
import { ProcessRepository } from "./repositories/ProcessRepository";
import { TaskRepository } from "./repositories/TaskRepository";
import { DialogRepository } from "./repositories/DialogRepository";
import { MessageRepository } from "./repositories/MessageRepository";
import { ReminderRepository } from "./repositories/ReminderRepository";
import { BotReminderSettingRepository } from "./repositories/BotReminderSettingRepository";
import { CrmLeadRepository } from "./repositories/CrmLeadRepository";
import { CrmSettingsRepository } from "./repositories/CrmSettingsRepository";
import { RagDocumentRepository } from "./repositories/RagDocumentRepository";
import { RagChunkRepository } from "./repositories/RagChunkRepository";
import { LLMRequester } from "./llm/LLMRequester";
import { ResponseParser } from "./llm/ResponseParser";
import { EmbeddingClient } from "./llm/EmbeddingClient";
import { MessageHandler } from "./MessageHandler";
import { ReminderManager } from "./managers/ReminderManager";
import { CRMManager } from "./managers/CRMManager";
import { RagIngestionManager } from "./managers/RagIngestionManager";
import { RagSearchManager } from "./managers/RagSearchManager";
import { ProcessGenerator } from "./managers/ProcessGenerator";
import { ScenarioRepository } from "./repositories/ScenarioRepository";
import { ClientRepository } from "./repositories/ClientRepository";
import { TokenRepository } from "./repositories/TokenRepository";
import { UserRepository } from "./repositories/UserRepository";
import { ReminderProcessor } from "./ReminderProcessor";
import { handleTelegramWebhook } from "./routes/telegramWebhook";
import { handleAdminApi } from "./routes/adminApi";

const botRepo = new BotRepository();
const processRepo = new ProcessRepository();
const taskRepo = new TaskRepository();
const dialogRepo = new DialogRepository();
const messageRepo = new MessageRepository();
const reminderRepo = new ReminderRepository();
const botReminderSettingRepo = new BotReminderSettingRepository();
const crmLeadRepo = new CrmLeadRepository();
const crmSettingsRepo = new CrmSettingsRepository();
const ragDocumentRepo = new RagDocumentRepository();
const ragChunkRepo = new RagChunkRepository();
const clientRepo = new ClientRepository();
const tokenRepo = new TokenRepository();
const userRepo = new UserRepository();

const llmRequester = new LLMRequester(process.env.LLM_API_KEY!, process.env.LLM_BASE_URL);
const responseParser = new ResponseParser();
const embeddingClient = new EmbeddingClient(process.env.LLM_API_KEY!, process.env.LLM_BASE_URL);
const reminderManager = new ReminderManager(reminderRepo, botReminderSettingRepo);
const crmManager = new CRMManager(crmLeadRepo, crmSettingsRepo);
const ragIngestionManager = new RagIngestionManager(ragDocumentRepo, ragChunkRepo, embeddingClient);
const ragSearchManager = new RagSearchManager(ragChunkRepo, embeddingClient);
const processGenerator = new ProcessGenerator(process.env.LLM_API_KEY!, process.env.LLM_BASE_URL);
const scenarioRepo = new ScenarioRepository();

const messageHandler = new MessageHandler(
  dialogRepo,
  processRepo,
  taskRepo,
  messageRepo,
  botRepo,
  llmRequester,
  responseParser,
  reminderManager,
  crmManager,
  ragSearchManager
);

const reminderProcessor = new ReminderProcessor(
  reminderRepo,
  dialogRepo,
  botRepo,
  messageRepo,
  llmRequester,
  reminderManager
);
reminderProcessor.start();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/webhook/telegram/") && request.method === "POST") {
      return handleTelegramWebhook(request, botRepo, messageHandler);
    }

    const adminResponse = await handleAdminApi(request, {
      clientRepo,
      tokenRepo,
      userRepo,
      botRepo,
      processRepo,
      taskRepo,
      ragIngestionManager,
      ragDocumentRepo,
      processGenerator,
      scenarioRepo,
    });
    if (adminResponse) return withCors(adminResponse);

    return new Response("Not found", { status: 404 });
  },
});

console.log(`NeuroSeller running on port ${process.env.PORT ?? 3000}`);
