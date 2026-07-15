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
import { PdfVisionExtractor } from "./managers/PdfVisionExtractor";
import { ImageStepReader } from "./managers/ImageStepReader";
import { RagSearchManager } from "./managers/RagSearchManager";
import { ProcessGenerator } from "./managers/ProcessGenerator";
import { ScenarioRepository } from "./repositories/ScenarioRepository";
import { MessageFeedbackRepository } from "./repositories/MessageFeedbackRepository";
import { ClientRepository } from "./repositories/ClientRepository";
import { TokenRepository } from "./repositories/TokenRepository";
import { UserRepository } from "./repositories/UserRepository";
import { ReminderProcessor } from "./ReminderProcessor";
import { handleTelegramWebhook } from "./routes/telegramWebhook";
import { handleAdminApi } from "./routes/adminApi";
import { TelegramUserAdapter } from "./channels/TelegramUserAdapter";

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
const pdfVisionExtractor = new PdfVisionExtractor(process.env.LLM_API_KEY!, process.env.LLM_BASE_URL);
const imageStepReader = new ImageStepReader(process.env.LLM_API_KEY!, process.env.LLM_BASE_URL);
const ragSearchManager = new RagSearchManager(ragChunkRepo, embeddingClient);
const processGenerator = new ProcessGenerator(process.env.LLM_API_KEY!, process.env.LLM_BASE_URL);
const scenarioRepo = new ScenarioRepository();
const messageFeedbackRepo = new MessageFeedbackRepository();

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
  ragSearchManager,
  imageStepReader
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

// Тестовый канал: обычный (не-бот) Telegram-аккаунт через MTProto user-сессию. Активируется,
// только если в .env заданы все три переменные — иначе просто не запускается, без ошибок.
const userSession = process.env.TELEGRAM_USER_SESSION;
const userApiId = process.env.TELEGRAM_API_ID;
const userApiHash = process.env.TELEGRAM_API_HASH;
const userBotId = process.env.TELEGRAM_USER_BOT_ID;
if (userSession && userApiId && userApiHash && userBotId) {
  const telegramUserAdapter = new TelegramUserAdapter(userSession, Number(userApiId), userApiHash);
  const botIdNum = Number(userBotId);
  telegramUserAdapter
    .listen(async (chatId, text, image) => {
      try {
        const messages = await messageHandler.processMessage(botIdNum, chatId, text, image);
        for (const msg of messages) {
          await telegramUserAdapter.sendMessage(chatId, msg);
        }
      } catch (err) {
        console.error("Ошибка обработки сообщения (Telegram user-аккаунт):", err);
        await telegramUserAdapter
          .sendMessage(chatId, "Сейчас небольшие технические неполадки — напишите, пожалуйста, чуть позже.")
          .catch((sendErr) => console.error("Не удалось отправить сообщение об ошибке:", sendErr));
      }
    })
    .then(() => console.log("Telegram user-аккаунт подключён как канал"))
    .catch((err) => console.error("Не удалось подключить Telegram user-аккаунт:", err));
}

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
      pdfVisionExtractor,
      ragDocumentRepo,
      processGenerator,
      scenarioRepo,
      dialogRepo,
      messageRepo,
      messageFeedbackRepo,
      botReminderSettingRepo,
    });
    if (adminResponse) return withCors(adminResponse);

    return new Response("Not found", { status: 404 });
  },
});

console.log(`NeuroSeller running on port ${process.env.PORT ?? 3000}`);
