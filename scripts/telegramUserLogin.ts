// Одноразовый интерактивный логин обычного Telegram-аккаунта (MTProto, не Bot API).
// Запуск: bun scripts/telegramUserLogin.ts
// Нужны TELEGRAM_API_ID и TELEGRAM_API_HASH в .env (my.telegram.org → API development tools).
// В конце скрипт напечатает session string — сохрани его в .env как TELEGRAM_USER_SESSION,
// дальше бот подключается этой строкой без повторного ввода кода.
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import input from "input";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error("Нужны TELEGRAM_API_ID и TELEGRAM_API_HASH в .env");
  process.exit(1);
}

const session = new StringSession("");

async function main() {
  const client = new TelegramClient(session, apiId, apiHash!, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => await input.text("Номер телефона (формат +375...): "),
    password: async () => await input.text("Пароль двухфакторки (Enter, если не включена): "),
    phoneCode: async () => await input.text("Код из Telegram/SMS: "),
    onError: (err) => console.error("Ошибка логина:", err),
  });

  console.log("\nУспешный вход!\n");
  console.log("Сохрани это значение в .env как TELEGRAM_USER_SESSION:\n");
  console.log(client.session.save());
  console.log();

  await client.disconnect();
  process.exit(0);
}

main();
