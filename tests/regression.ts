// Регрессионный прогон поведения бота: гоняет реальный MessageHandler против прод-БД + LLM,
// плюс проверки универсальности мета-промпта (генерация под другие домены).
// Запуск: bun tests/regression.ts   (нужны env LLM_API_KEY, LLM_BASE_URL, DATABASE_URL)
//
// Смысл: после КАЖДОЙ правки промпта/движка прогоняем это и смотрим таблицу «кейс → прошёл/нет».
// Выкатываем только если всё зелёное — тогда фиксы не ломают старое.
import { BotRepository } from "../src/repositories/BotRepository";
import { ProcessRepository } from "../src/repositories/ProcessRepository";
import { TaskRepository } from "../src/repositories/TaskRepository";
import { DialogRepository } from "../src/repositories/DialogRepository";
import { MessageRepository } from "../src/repositories/MessageRepository";
import { ReminderRepository } from "../src/repositories/ReminderRepository";
import { BotReminderSettingRepository } from "../src/repositories/BotReminderSettingRepository";
import { CrmLeadRepository } from "../src/repositories/CrmLeadRepository";
import { CrmSettingsRepository } from "../src/repositories/CrmSettingsRepository";
import { RagChunkRepository } from "../src/repositories/RagChunkRepository";
import { LLMRequester } from "../src/llm/LLMRequester";
import { ResponseParser } from "../src/llm/ResponseParser";
import { EmbeddingClient } from "../src/llm/EmbeddingClient";
import { ReminderManager } from "../src/managers/ReminderManager";
import { CRMManager } from "../src/managers/CRMManager";
import { RagSearchManager } from "../src/managers/RagSearchManager";
import { ProcessGenerator } from "../src/managers/ProcessGenerator";
import { ImageStepReader } from "../src/managers/ImageStepReader";
import { MessageHandler } from "../src/MessageHandler";
import { sql } from "../src/db/connection";

const BOT_ID = 1;
const key = process.env.LLM_API_KEY!;
const base = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";

const mh = new MessageHandler(
  new DialogRepository(), new ProcessRepository(), new TaskRepository(), new MessageRepository(),
  new BotRepository(), new LLMRequester(key, base), new ResponseParser(),
  new ReminderManager(new ReminderRepository(), new BotReminderSettingRepository()),
  new CRMManager(new CrmLeadRepository(), new CrmSettingsRepository()),
  new RagSearchManager(new RagChunkRepository(), new EmbeddingClient(key, base)),
  new ImageStepReader(key, base)
);
const pg = new ProcessGenerator(key, base);

// Прогоняет свежий диалог: /clear → сообщения → возвращает ответы бота и итоговый known.
async function convo(chatId: string, msgs: string[]): Promise<{ responses: string[]; known: Record<string, string> }> {
  await mh.processMessage(BOT_ID, chatId, "/clear");
  const responses: string[] = [];
  // processMessage теперь возвращает массив пузырей — склеиваем в одну строку хода для проверок.
  for (const m of msgs) responses.push((await mh.processMessage(BOT_ID, chatId, m)).join(" | "));
  const rows = await sql<{ known: Record<string, string> }[]>`
    SELECT known FROM dialogs WHERE bot_id = ${BOT_ID} AND chat_id = ${chatId} ORDER BY id DESC LIMIT 1`;
  const known = rows[0]?.known ?? {};
  await mh.processMessage(BOT_ID, chatId, "/clear");
  return { responses, known: typeof known === "string" ? JSON.parse(known) : known };
}

type Result = { pass: boolean; detail: string };
const checks: { name: string; run: () => Promise<Result> }[] = [];
const has = (s: string, re: RegExp) => re.test(s);

// ── Поведение диалога (реальный MessageHandler) ──────────────────────────────

checks.push({ name: "1. RAG: цена/наличие товара из базы", run: async () => {
  const { responses } = await convo("REG-1", ["привет", "Есть воздушный фильтр на Ладу Весту?"]);
  const r = responses[1] ?? "";
  return { pass: has(r, /фильтр/i) && has(r, /32|наличи|заказ/i), detail: r.slice(0, 90) };
}});

checks.push({ name: "2. Не здоровается повторно", run: async () => {
  const { responses } = await convo("REG-2", ["привет", "Есть воздушный фильтр на Весту?"]);
  const r = responses[1] ?? "";
  return { pass: !has(r, /^\s*(привет|здравствуй|добрый (день|вечер|утро))/i), detail: r.slice(0, 90) };
}});

checks.push({ name: "3. Честность: товара нет в базе (BMW X5)", run: async () => {
  const { responses } = await convo("REG-3", ["привет", "Есть тормозные диски на BMW X5?"]);
  const r = responses[1] ?? "";
  return { pass: has(r, /не подскаж|не знаю|нет .{0,25}(баз|информац|данн)|в базе .{0,10}нет|нет в наш/i), detail: r.slice(0, 90) };
}});

checks.push({ name: "4. Честность: стоимости доставки нет (не подсовывает срок)", run: async () => {
  const { responses } = await convo("REG-4", ["привет", "сколько стоит доставка в Гродно?"]);
  const r = responses[1] ?? "";
  const saysNoCost = has(r, /(стоимост|цен|сколько).{0,30}(нет|не знаю|не подскаж|не наш)|нет .{0,20}(стоимост|цен)|не подскаж/i);
  return { pass: saysNoCost, detail: r.slice(0, 100) };
}});

checks.push({ name: "5. Подтверждение товара на роутере (после имени)", run: async () => {
  const { responses } = await convo("REG-5", ["привет", "Есть воздушный фильтр на Ладу Весту?", "Денис"]);
  const r = responses[2] ?? "";
  return { pass: has(r, /фильтр/i) && has(r, /правильно|верно|интересует|оформл/i), detail: r.slice(0, 100) };
}});

checks.push({ name: "6. Маршрут в авто-ветку на «да» (спрашивает год/марку, не контакт)", run: async () => {
  const { responses } = await convo("REG-6", ["привет", "Есть воздушный фильтр на Ладу Весту?", "Денис", "да"]);
  const r = responses[3] ?? "";
  return { pass: has(r, /год|марк|модел/i) && !has(r, /телефон|вайбер|телеграм|связ/i), detail: r.slice(0, 100) };
}});

checks.push({ name: "7. Slot-filling: known пишет товар + авто", run: async () => {
  const { known } = await convo("REG-7", ["привет", "Денис. Есть фара передняя правая на фольсваген пассат?"]);
  const j = JSON.stringify(known);
  return { pass: has(j, /passat|пассат/i) && has(j, /фара|product|товар/i), detail: j.slice(0, 120) };
}});

checks.push({ name: "8. Марку не переспрашивает, если авто уже известно", run: async () => {
  const { responses } = await convo("REG-8", ["привет", "Есть крыло переднее на ладу весту?", "Денис", "да"]);
  const r = responses[3] ?? "";
  // не должен спрашивать «какая марка/модель» вслепую; ок если знает Весту или уже спрашивает год
  const blindAsk = has(r, /кака[яют].{0,20}(марк|модел)/i) && !has(r, /vesta|веста/i);
  return { pass: !blindAsk, detail: r.slice(0, 100) };
}});

// ── Универсальность мета-промпта (генерация под другие домены) ────────────────

// Только однозначно авто-специфичные термины. «артикул/SKU» НЕ включаем — они встречаются
// в универсальной инструкции «без внутренних кодов/артикулов» и легитимны для любого товара.
const AUTO_LEAK = /марк[аи]\/модел|car_model|car_year|car_make|воздушн(ый|ого) фильтр|крыло|бампер|\bLada\b|\bВеста\b|\bPassat\b/i;

checks.push({ name: "9. Универсальность: стоматология без авто-утечек", run: async () => {
  const t = await pg.generate("Стоматология «Улыбка»",
    [{ goal: "Узнать нужную услугу", required: true, maxAttempts: 3, fieldName: "service" }, { goal: "Попрощаться", required: false, maxAttempts: 1 }],
    undefined, [], undefined, [], ["имя", "услуга", "дата визита", "телефон"]);
  const d = t[0]!.task_description;
  const leak = d.match(AUTO_LEAK);
  return { pass: !leak, detail: leak ? `утечка: «${leak[0]}»` : "чисто" };
}});

checks.push({ name: "10. Универсальность: недвижимость без авто-утечек", run: async () => {
  const t = await pg.generate("Агентство «Дом»",
    [{ goal: "Узнать желаемый район", required: true, maxAttempts: 3, fieldName: "district" }, { goal: "Попрощаться", required: false, maxAttempts: 1 }],
    undefined, [], undefined, [], ["имя", "район", "бюджет", "телефон"]);
  const d = t[0]!.task_description;
  const leak = d.match(AUTO_LEAK);
  return { pass: !leak, detail: leak ? `утечка: «${leak[0]}»` : "чисто" };
}});

checks.push({ name: "11. Универсальность: скелет на месте (приоритеты, known, контракт)", run: async () => {
  const t = await pg.generate("Кофейня «Зерно»",
    [{ goal: "Узнать любимый напиток", required: true, maxAttempts: 3, fieldName: "drink" }, { goal: "Попрощаться", required: false, maxAttempts: 1 }],
    undefined, [], undefined, [], ["имя", "напиток", "время"]);
  const d = t[0]!.task_description;
  const ok = has(d, /Как действовать/) && has(d, /Копи в known/) && has(d, /known_updates/) && has(d, /честно/i);
  return { pass: ok, detail: ok ? "все блоки есть" : "не хватает блоков скелета" };
}});

checks.push({ name: "12. Доставка Минск: не выдаёт мин.сумму 30 BYN как стоимость", run: async () => {
  const { responses } = await convo("REG-12", ["привет", "сколько стоит доставка по Минску?"]);
  const r = responses[1] ?? "";
  const hallucinatesCost = /доставк[аи][^.]{0,35}стоит[^.]{0,12}30|стоимость доставки[^.]{0,18}30/i.test(r);
  return { pass: !hallucinatesCost, detail: r.slice(0, 100) };
}});

checks.push({ name: "13. Без кринжа (не представляется повторно / не извиняется)", run: async () => {
  const { responses } = await convo("REG-13", ["привет", "Денис, есть фара передняя правая на фольсваген пассат?"]);
  const r = responses[1] ?? "";
  const cringe = /я помощник|прошу прощени|извин|вы уже спрашивали/i.test(r);
  return { pass: !cringe, detail: r.slice(0, 100) };
}});

// ── Прогон ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Регресс-прогон (модель диалога — из БД). Кейсов: ${checks.length}\n`);
  let passed = 0;
  for (const c of checks) {
    try {
      const r = await c.run();
      if (r.pass) passed++;
      console.log(`${r.pass ? "✅" : "❌"} ${c.name}\n     → ${r.detail}`);
    } catch (e) {
      console.log(`💥 ${c.name}\n     → ошибка: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  console.log(`\nИТОГ: ${passed}/${checks.length} прошло`);
  process.exit(0);
}
main();
