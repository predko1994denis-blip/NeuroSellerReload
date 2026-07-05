import type { TaskType } from "../entities/Task";

// Гибкое правило шага — вместо фиксированного набора полей пользователь добавляет
// сколько угодно правил произвольного типа через "+" в конструкторе.
export interface StepRule {
  type: "example" | "validation" | "custom";
  text: string;
}

export interface StepInput {
  goal: string;
  required: boolean;
  maxAttempts: number;
  fieldName?: string; // техническое имя JSON-поля, не правило — если не задано, модель придумает сама
  rules?: StepRule[];
}

// Кеш генерации для инкрементальной пересборки: если содержимое шага не изменилось с прошлого
// раза, переиспользуем уже сгенерированный текст вместо нового вызова LLM.
export class GenerationCache {
  private hits = 0;

  constructor(private record: Record<string, string> = {}) {}

  get(key: string): string | undefined {
    const value = this.record[key];
    if (value) this.hits++;
    return value;
  }

  set(key: string, value: string): void {
    this.record[key] = value;
  }

  get hitCount(): number {
    return this.hits;
  }

  toRecord(): Record<string, string> {
    return this.record;
  }
}

// Детерминированная сериализация: одинаковый вход всегда даёт одинаковую строку, независимо
// от порядка ключей. ВАЖНО: нельзя использовать JSON.stringify(x, Object.keys(x).sort()) —
// массив во втором аргументе это replacer-белый-список, который рекурсивно ВЫРЕЗАЕТ все вложенные
// поля (step.goal, style.*, branches[].condition), из-за чего отпечаток терял почти всё содержимое
// и разные шаги схлопывались в один ключ кеша. Сортируем ключи рекурсивно вручную.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

function fingerprint(parts: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(parts));
}

function buildRulesBlock(rules: StepRule[] | undefined): string {
  if (!rules || rules.length === 0) return "";
  const lines = rules.map((r) => {
    if (r.type === "example") {
      return `- ПРИМЕР ОТ ПОЛЬЗОВАТЕЛЯ: «${r.text}». Разверни это в 2-3 полноценных примера в стиле пары «сообщение клиента → JSON», аналогичных по смыслу и формату (не копируй буквально, придумай похожие вариации), чтобы промпту было понятно, что именно относится к данным этого шага.`;
    }
    if (r.type === "validation") {
      return `- ВАЛИДАЦИЯ: «${r.text}». Заложи это как строгое правило проверки — если данные не соответствуют условию, считай их неполученными (completed: false) и вежливо попроси уточнить/поправить.`;
    }
    return `- ДОПОЛНИТЕЛЬНОЕ ПРАВИЛО (учесть буквально и обязательно): ${r.text}`;
  });
  return `\nПРАВИЛА ОТ ПОЛЬЗОВАТЕЛЯ ДЛЯ ЭТОГО ШАГА (обязательны к исполнению):\n${lines.join("\n")}\n`;
}

// Формирует блок "защита цели" — не даёт модели уводить диалог на темы за пределами
// заданных целей всего сценария (например, клиент передумал на середине диалога).
function buildTopicGuardBlock(
  scenarioGoals: string[],
  canExit: boolean = false,
  nonGoals: string[] = []
): string {
  if (scenarioGoals.length === 0 && nonGoals.length === 0) return "";
  const list = scenarioGoals.map((g) => `- ${g}`).join("\n");
  // Пример тона строим из РЕАЛЬНОЙ первой цели сценария, а не из захардкоженной темы —
  // так блок остаётся уместным для любой тематики (авто, медицина, недвижимость и т.д.).
  const helpWith = scenarioGoals[0] ?? "то, ради чего создан этот бот";
  const nonGoalHint = nonGoals[0] ?? "с посторонним запросом";
  const nonGoalsBlock = nonGoals.length > 0
    ? `С этим ты ТОЧНО НЕ помогаешь (легко спутать с целями выше, но это не твоя задача — если запрос похож на один из пунктов, это всегда не в тему):\n${nonGoals.map((g) => `- ${g}`).join("\n")}`
    : "";
  const exitInstruction = canExit
    ? `\n- Поскольку этот шаг умеет завершать диалог (в контракте есть next_process): при явно нецелевом запросе верни current_task_completed=true БЕЗ next_process (не выбирай ветку силой и не уточняй по чужой теме) — система сама корректно завершит диалог.`
    : "";
  return `[Защита цели]
Ты помогаешь клиенту ТОЛЬКО с этим:
${list || "(см. ниже, с чем ты НЕ помогаешь)"}
${nonGoalsBlock}
- Если клиент просит что-то вне этого списка — не игнорируй его вопрос молча и не задавай сразу свой. Сначала коротко и по-человечески признай, что с ЭТИМ помочь не можешь, затем предложи именно свою помощь как ПРЕДЛОЖЕНИЕ-ВОПРОС, назвав КОНКРЕТНЫЕ цели из списка выше («интересует <цель из списка>?» / если целей несколько — «вам <цель А> или <цель Б>?»). НЕ спрашивай общими словами «что желаете / что хотите купить» — всегда привязывай предложение к конкретным целям сценария. Пример тона (адаптируй под свою тему): «${nonGoalHint} — не подскажу, я помогаю: ${helpWith}. Такое интересно?». Не отвечай на нецелевой вопрос по существу.
- ВАЖНО: нецелевой вопрос и ответ на текущий шаг — НЕЗАВИСИМЫ. Если клиент в ОДНОМ сообщении и задал лишнее, И заодно дал ответ на текущий шаг (например «Денис, а есть вакансии?» — тут есть и имя, и посторонний вопрос) — обработай ОБА: извлеки данные шага (completed=true), а нецелевое коротко отклони. НЕ переспрашивай то, что клиент уже назвал в этом же сообщении.
- Если клиент посреди уже начатого целевого диалога хочет сменить цель — не переключайся сам, вежливо предложи сначала закончить текущее.${exitInstruction}`;
}

export interface GeneratedTask {
  task_number: string;
  task_type: TaskType;
  title: string;
  task_description: string;
  is_fallback?: boolean;
}

// 10 стилевых параметров общения бота — применяются ко всем НЕ-завершающим промптам.
// Пользователь может подкрутить их в конструкторе; если не задано — используется DEFAULT_STYLE.
export interface ScenarioStyle {
  formality: number; // 1 разговорный — 5 деловой
  gender: "м" | "ж"; // грамматический род бота при самоописании ("я понял" / "я поняла")
  address: "ты" | "вы";
  warmth: number; // 1 нейтральный/холодный — 5 очень тёплый
  responseLength: number; // 1 кратко — 5 развёрнуто
  emoji: number; // 1 не использует — 2 умеренно — 3 активно
  energy: number; // 1 спокойный — 5 напористый
  initiative: number; // 1 реактивный — 5 проактивный
  humor: number; // 1 серьёзный — 5 с юмором
  confidence: number; // 1 осторожный — 5 уверенный
  structure: number; // 1 сплошной текст — 5 структурировано (списки)
}

// Стандартный пресет: тёплый, но не приторный менеджер, лаконичный, без давления —
// нейтральная база, подходящая большинству продающих ботов.
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

const SCALE_5 = ["крайне низкий", "низкий", "средний", "высокий", "крайне высокий"];

function scaleWord(value: number): string {
  return SCALE_5[Math.min(5, Math.max(1, Math.round(value))) - 1]!;
}

// Превращает 10 ползунков в готовый текстовый блок для мета-промпта.
function buildStyleBlock(style: ScenarioStyle): string {
  const emojiWord = ["не использует эмодзи", "использует эмодзи умеренно (0-1 на сообщение)", "использует эмодзи активно"][
    Math.min(3, Math.max(1, Math.round(style.emoji))) - 1
  ];
  return `СТИЛЬ ОБЩЕНИЯ БОТА (соблюдай единообразно во всех репликах):
- Формальность: ${scaleWord(style.formality)} (${style.formality}/5) — 1 значит максимально разговорный тон, 5 значит деловой.
- Грамматический род бота при самоописании: ${style.gender === "ж" ? "женский (например «я поняла», «рада помочь», «уточнила»)" : "мужской (например «я понял», «рад помочь», «уточнил»)"}. Соблюдай этот род во всех глаголах прошедшего времени от первого лица.
- Обращение к клиенту: строго на "${style.address}".
- Теплота/дружелюбие: ${scaleWord(style.warmth)} (${style.warmth}/5).
- Длина ответов: ${scaleWord(style.responseLength)} (${style.responseLength}/5) — 1 значит односложно и коротко, 5 значит развёрнуто и подробно.
- Эмодзи: ${emojiWord}.
- Энергичность/напор в продвижении к цели: ${scaleWord(style.energy)} (${style.energy}/5) — 1 значит мягко и ненавязчиво, 5 значит настойчиво.
- Инициативность: ${scaleWord(style.initiative)} (${style.initiative}/5) — 1 значит только отвечает, 5 значит сам предлагает следующий шаг.
- Юмор/игривость: ${scaleWord(style.humor)} (${style.humor}/5) — 1 значит полностью серьёзно, 5 значит с шутками и лёгкостью.
- Уверенность подачи: ${scaleWord(style.confidence)} (${style.confidence}/5) — 1 значит осторожные формулировки ("возможно, стоит..."), 5 значит уверенные ("сделайте так").
- Структура ответа: ${scaleWord(style.structure)} (${style.structure}/5) — 1 значит сплошной текст, 5 значит списки/пункты (но помни про краткость для чата).`;
}

const GENERATION_MAX_TOKENS = 2000;

// ============================================================================
// ЕДИНЫЙ КАРКАС ПРОМПТА (детерминированная сборка в коде — гарантирует единообразие).
// LLM генерирует ТОЛЬКО творческую часть (распознавание + примеры) как структурированный
// JSON; всё остальное (роль, стиль, защита цели, FSM-правила, контракт) собирается кодом
// и потому идентично во всех шагах любой цепочки.
// ============================================================================

type StepKind = "collection" | "completion" | "router" | "routedStep";

// Один пример «реплика клиента → ответ бота», который прислала LLM в структурированном виде.
// Код сам отрендерит его в точный JSON-контракт с нужным именем поля — LLM не пишет сырой JSON.
interface BodyExample {
  client: string; // что написал клиент ("" = шаг только что активировался)
  bot_message: string; // что бот отвечает
  data?: string; // извлечённое значение поля (для collection); "" если не собрано
  completed?: boolean; // collection: собраны ли данные шага
  next_process?: number | null; // router/routedStep: выбранная ветка или null
}

interface StepBody {
  field_name?: string; // snake_case имя поля данных (только для collection)
  recognition?: string; // как распознавать этот тип данных (collection/routedStep)
  examples: BodyExample[];
}

// Роль — фиксированный шаблон, одинаковый для всех шагов, отличается только целью.
function buildRoleBlock(companyName: string, goal: string, kind: StepKind): string {
  const base = `[Роль]\nТы — цифровой помощник компании ${companyName} в Telegram. Общайся живо и по-человечески, как настоящий менеджер, а не как робот. Бот говорит от лица ${companyName}, не выдумывай себе имя.`;
  if (kind === "completion") return `${base}\nЭто ЗАВЕРШАЮЩИЙ шаг диалога. Твоя задача: ${goal}`;
  if (kind === "router") return `${base}\nТвоя задача на этом шаге: понять намерение клиента и направить диалог в нужную ветку.${goal ? ` Ориентир: ${goal}` : ""}`;
  if (kind === "routedStep") return `${base}\nТвоя задача на этом шаге: ${goal} — и по ответу клиента сразу решить, в какую ветку вести диалог дальше.`;
  return `${base}\nТвоя задача на этом шаге: ${goal}`;
}

// Общие правила речи — идентичны везде.
const SPEECH_RULES = `[Как писать]
- Пиши КОРОТКО, одна-две фразы. Живой человек в переписке не пишет абзацами.
- Никакого канцелярита («Пожалуйста, сообщите…», «Для удобства предоставьте…»). Только простые человеческие фразы.
- Не остри и не паясничай. На сомнение/вопрос клиента отвечай просто и по делу.
- Реагируй на реплику клиента, а не на скрипт: если он шутит/сомневается/спрашивает «зачем?» — сперва коротко ответь на это, потом мягко вернись к цели.
- Используй контекст, не абстрактные заглушки: называй предмет разговора конкретно из history, не вставляй деревянные слова-заглушки («товар/изделие/продукт/объект/услуга»), если из контекста уже ясно, о чём речь — подставляй то, что клиент реально назвал.
- Обращайся по имени, если оно известно, — но естественно, не в каждом сообщении.`;

// Технические FSM-правила — идентичны везде.
const FSM_RULES = `[Технические правила (соблюдай строго)]
- ПУСТОЙ latest_user_message = шаг только что стал активным, нового сообщения от клиента ещё нет. СРАЗУ проактивно задай вопрос этого шага, коротко и по-человечески. Нельзя молчать, прощаться или писать «если что — пишите» / «есть ещё вопросы?».
- greeted=true → никогда не здоровайся снова. greeted=false и шаг это подразумевает → поздоровайся один раз.
- Не начинай заново: если данные шага уже собраны — не задавай вопрос шага снова.
- Не повторяй свой предыдущий вопрос дословно (сверяйся с history) — переформулируй.
- Не благодари канцелярски («Спасибо за информацию», «Записал»). Живое короткое подтверждение по имени можно.
- НЕ ВЫДУМЫВАЙ факты, которых тебе не давали: цены, наличие, сроки, характеристики товара, часы работы, адреса, телефоны, скидки, любые конкретные обещания. Если клиент спрашивает такое, а у тебя нет этих данных — честно скажи, что точную информацию уточнит менеджер/человек, и вернись к своей цели. Не сочиняй числа, каналы связи или условия «чтобы красиво закрыть» вопрос.
- bot_message — единственное поле, которое видит пользователь. Весь текст для клиента (вопрос, приветствие, отказ, прощание) всегда в bot_message, и оно никогда не пустое, если есть что сказать.
- Отвечай ТОЛЬКО одним строгим JSON-объектом, без markdown и текста вне JSON.`;

// Правила распознавания данных — идентичны для всех шагов, собирающих данные.
const RECOGNITION_RULES = `[Распознавание данных — общие правила]
- Принимай ответ в любой естественной форме, извлекай суть, отбрасывай вводные слова, не требуй идеальной формы.
- Проверяй ВСЮ history: если нужные для шага данные клиент уже называл раньше (даже мимоходом, отвечая на другой вопрос) — не переспрашивай, сразу считай данные собранными с этим значением.
- Здравый смысл: если ответ явно нереалистичен для этого типа данных (например, неправдоподобный год, телефон из 3 цифр, отрицательное количество) — не принимай слепо, вежливо уточни; но не блокируй, если клиент осознанно подтверждает необычное значение.`;

// Поведение при отказе — зависит только от обязательности и лимита попыток.
function buildRefusalRules(required: boolean, maxAttempts: number): string {
  return `[Поведение при отказе/уклонении]
- Считай попытки по history, максимум = ${maxAttempts}. Отличай явный отказ («не скажу») от встречного вопроса/паузы («а зачем?», «подожди») — на встречный вопрос сперва коротко ответь, потом вернись к цели.
${required
  ? `- Шаг ОБЯЗАТЕЛЬНЫЙ: при отказе мягко объясни выгоду (одной фразой) и вернись к вопросу другой формулировкой. Не пропускай шаг, пока попытки не исчерпаны.`
  : `- Шаг НЕОБЯЗАТЕЛЬНЫЙ: как только клиент говорит «не знаю»/«не помню»/не может ответить (даже с первой попытки) — сразу completed=true с пустым полем и current_task_completed=true, bot_message ведёт диалог дальше. Не переспрашивай.`}
- Каждая повторная попытка отличается формулировкой и углом захода.`;
}

// Логика подтверждения — идентична, самогейтится по цели шага.
const CONFIRMATION_RULES = `[Если цель шага — показать данные и получить подтверждение («всё верно?»)]
- Первый показ сводки: completed=false, bot_message = сводка + вопрос «Всё верно?». Не ставь completed=true в этом же ответе.
- Клиент поправил данные: прими правку, покажи обновлённую сводку ещё раз, completed=false.
- Клиент просто согласился («да», «верно», «ок») с уже показанной сводкой: completed=true СРАЗУ, без повторного «всё подтверждаете?».`;

// Правила ветвления — для router/routedStep.
function buildRoutingRules(branches: { condition: string; targetProcessNumber: number }[]): string {
  const routes = branches.map((b) => `- Если ${b.condition} → next_process: ${b.targetProcessNumber}`).join("\n");
  return `[Ветвление — определи подходящее условие]
${routes}
- Пока не ясно, какое условие подходит — next_process=null и один короткий уточняющий вопрос, который помогает выбрать РОВНО между условиями выше. Не предлагай других тем/вариантов, которых нет в списке.
- Как только ясно — next_process = нужное число, bot_message пустой (следующий шаг сам заговорит).
- Клиент уклоняется («хз», «не знаю») — не придумывай третий вариант, просто напомни доступные условия другими словами.
- Синхронизация: current_task_completed=true ТОЛЬКО одновременно с числовым next_process; если next_process=null — current_task_completed=false.`;
}

// Контракт [Формат ответа] — фиксированный, с правильным именем поля.
function buildFormatBlock(kind: StepKind, fieldName: string): string {
  if (kind === "completion") {
    return `[Формат ответа]\n{"completed": boolean, "bot_message": string, "current_task_completed": boolean}\nПоле текста для клиента ВСЕГДА называется строго "bot_message". Отвечай одним JSON-объектом, без markdown.`;
  }
  if (kind === "router" || kind === "routedStep") {
    return `[Формат ответа]\n{"bot_message": string, "next_process": number|null, "current_task_completed": boolean}\nПоле текста для клиента ВСЕГДА называется строго "bot_message". Отвечай одним JSON-объектом, без markdown.`;
  }
  return `[Формат ответа]\n{"completed": boolean, "${fieldName}": string, "bot_message": string, "current_task_completed": boolean}\nПоле текста для клиента ВСЕГДА называется строго "bot_message". Отвечай одним JSON-объектом, без markdown.`;
}

// Санитайзер имени поля: только латиница/цифры/подчёркивания, начинается с буквы.
function sanitizeFieldName(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return /^[a-z][a-z0-9_]*$/.test(cleaned) ? cleaned : fallback;
}

function jsonStr(v: string): string {
  return JSON.stringify(v);
}

// Рендерит структурированный пример LLM в точную строку "СООБЩЕНИЕ → JSON" под контракт шага.
function renderExample(ex: BodyExample, kind: StepKind, fieldName: string): string {
  const clientLabel = ex.client && ex.client.trim() ? `СООБЩЕНИЕ КЛИЕНТА: «${ex.client}»` : `(пустое сообщение — шаг только что активировался)`;
  if (kind === "completion") {
    return `${clientLabel} → {"completed": true, "bot_message": ${jsonStr(ex.bot_message)}, "current_task_completed": true}`;
  }
  if (kind === "router" || kind === "routedStep") {
    const np = ex.next_process ?? null;
    const done = np !== null;
    return `${clientLabel} → {"bot_message": ${jsonStr(ex.bot_message)}, "next_process": ${np === null ? "null" : np}, "current_task_completed": ${done}}`;
  }
  const done = ex.completed === true;
  return `${clientLabel} → {"completed": ${done}, ${jsonStr(fieldName)}: ${jsonStr(ex.data ?? "")}, "bot_message": ${jsonStr(ex.bot_message)}, "current_task_completed": ${done}}`;
}

// Собирает финальный system-промпт шага из фиксированных блоков + творческой части от LLM.
function assembleStepPrompt(params: {
  kind: StepKind;
  companyName: string;
  goal: string;
  style: ScenarioStyle;
  scenarioGoals: string[];
  nonGoals: string[];
  required: boolean;
  maxAttempts: number;
  rules?: StepRule[];
  branches?: { condition: string; targetProcessNumber: number }[];
  body: StepBody;
  fieldName: string;
}): string {
  const { kind, companyName, goal, style, scenarioGoals, nonGoals, required, maxAttempts, rules, branches, body, fieldName } = params;
  const canExit = kind === "router" || kind === "routedStep";
  const parts: string[] = [];

  parts.push(buildRoleBlock(companyName, goal, kind));
  parts.push(buildStyleBlock(style));
  parts.push(SPEECH_RULES);

  const guard = buildTopicGuardBlock(scenarioGoals, canExit, nonGoals);
  if (guard.trim()) parts.push(guard.trim());

  if (canExit && branches) parts.push(buildRoutingRules(branches));

  if (kind === "collection" || kind === "routedStep") {
    if (body.recognition && body.recognition.trim()) {
      parts.push(`[Как распознавать ответ на этом шаге]\n${body.recognition.trim()}`);
    }
    parts.push(RECOGNITION_RULES);
  }

  if (kind === "collection") {
    parts.push(buildRefusalRules(required, maxAttempts));
    parts.push(CONFIRMATION_RULES);
  }

  const userRules = buildRulesBlock(rules);
  if (userRules.trim()) parts.push(userRules.trim());

  parts.push(FSM_RULES);

  const examples = body.examples.map((ex) => `- ${renderExample(ex, kind, fieldName)}`).join("\n");
  parts.push(`[Примеры «сообщение клиента → ответ»]\n${examples}`);

  parts.push(buildFormatBlock(kind, fieldName));

  return parts.join("\n\n");
}

// Мета-промпт, который просит LLM выдать ТОЛЬКО творческую часть шага структурированным JSON.
// Всё остальное (роль, стиль, правила, контракт) добавит код — здесь только распознавание и примеры.
function buildBodyMetaPrompt(params: {
  kind: StepKind;
  companyName: string;
  goal: string;
  required: boolean;
  branches?: { condition: string; targetProcessNumber: number }[];
  rules?: StepRule[];
}): string {
  const { kind, companyName, goal, required, branches, rules } = params;
  const userRules = buildRulesBlock(rules);
  const branchList = branches ? branches.map((b) => `- «${b.condition}» → ${b.targetProcessNumber}`).join("\n") : "";

  const common = `Ты помогаешь настроить диалогового бота-продавца компании ${companyName} (Telegram).
Тебе нужно придумать ТОЛЬКО содержательную часть ОДНОГО шага диалога: живые примеры «реплика клиента → ответ бота» (и, где нужно, как распознавать данные). Общую рамку (роль, стиль, правила, формат) добавит система — тебе её писать НЕ надо.
Отвечай СТРОГО одним JSON-объектом (без markdown, без текста вне JSON). Реплики бота — короткие, живые, по-человечески, без канцелярита, строго по теме этого шага и этого бренда.${userRules ? `\n${userRules}` : ""}`;

  if (kind === "completion") {
    return `${common}

Это ЗАВЕРШАЮЩИЙ шаг. Цель: ${goal}
Верни JSON:
{
  "examples": [
    {"client": "", "bot_message": "тёплое прощание: сообщить, что менеджер скоро свяжется, и попрощаться"},
    {"client": "а когда со мной свяжутся?", "bot_message": "коротко ответить и попрощаться"},
    {"client": "нецелевой вопрос (например про вакансии)", "bot_message": "мягко сказать, что с этим не поможешь, и попрощаться"}
  ]
}
Все примеры — это финал, данные не собираются.`;
  }

  if (kind === "router") {
    return `${common}

Это шаг-РОУТЕР: он не собирает данные, а по сообщению клиента определяет, в какую ветку вести диалог.
Ветки (условие → номер): ${branchList ? `\n${branchList}` : "(заданы системой)"}
Верни JSON:
{
  "recognition": "1-2 предложения: как по словам клиента понять, какая ветка подходит",
  "examples": [
    {"client": "реплика под ветку 1", "next_process": <номер ветки 1>, "bot_message": ""},
    {"client": "реплика под другую ветку", "next_process": <её номер>, "bot_message": ""},
    {"client": "непонятная реплика", "next_process": null, "bot_message": "короткий уточняющий вопрос строго между перечисленными ветками"}
  ]
}
Когда ветка ясна — next_process = её номер, bot_message пустой. Когда неясно — next_process=null и уточняющий вопрос.`;
  }

  if (kind === "routedStep") {
    return `${common}

Это шаг, который ОДНОВРЕМЕННО выясняет нужное для цели «${goal}» И по ответу клиента направляет в ветку.
Ветки (условие → номер): ${branchList ? `\n${branchList}` : "(заданы системой)"}
Верни JSON:
{
  "recognition": "1-2 предложения: как из ответа клиента понять нужное и выбрать ветку",
  "examples": [
    {"client": "реплика, ведущая в ветку 1", "next_process": <номер>, "bot_message": ""},
    {"client": "реплика, ведущая в другую ветку", "next_process": <номер>, "bot_message": ""},
    {"client": "непонятная реплика", "next_process": null, "bot_message": "короткий уточняющий вопрос строго между ветками"}
  ]
}`;
  }

  // collection
  return `${common}

Обычный шаг сбора данных. Цель: ${goal}
Обязательный шаг: ${required}.
Верни JSON:
{
  "field_name": "короткое имя JSON-поля латиницей snake_case (например client_name, phone, car_model) под эти данные",
  "recognition": "1-2 предложения: как извлекать суть именно этого типа данных из ответа клиента",
  "examples": [
    {"client": "клиент даёт данные", "data": "извлечённое значение", "bot_message": "живое короткое подтверждение/мостик дальше", "completed": true},
    {"client": "встречный вопрос (зачем?)", "data": "", "bot_message": "коротко объяснить и вернуться к вопросу", "completed": false},
    {"client": "не помню / тупик", "data": "", "bot_message": "переформулировать вопрос этого же шага другими словами", "completed": false},
    {"client": "клиент В ОДНОМ сообщении даёт ответ на шаг И задаёт нецелевой вопрос (например «Денис, а есть вакансии?»)", "data": "извлечённое значение из этого же сообщения (например Денис)", "bot_message": "коротко отклонить нецелевое и подтвердить/двинуться дальше — НЕ переспрашивая уже данное", "completed": true}
  ]
}
data — только извлечённое значение (не текст сообщения). Последний пример показывает, что нецелевой вопрос НЕ мешает засчитать данные, если клиент их дал в том же сообщении. Примеры — под тему этого бота и цель шага.`;
}

// Модель иногда игнорирует "верни только текст" и оборачивает ответ в markdown-код или
// в JSON-объект вида {"content": "..."} / {"system_prompt": "..."}. Снимаем такие обёртки
// программно, не полагаясь на дисциплину модели.
function sanitizeGeneratedPrompt(raw: string): string {
  let text = raw.trim();

  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  if (fenced) text = fenced[1]!.trim();

  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const obj = JSON.parse(text);
      const unwrapped = obj.content ?? obj.system_prompt ?? obj.prompt ?? obj.text;
      if (typeof unwrapped === "string" && unwrapped.trim()) {
        return sanitizeGeneratedPrompt(unwrapped);
      }
    } catch {
      // не JSON — оставляем текст как есть
    }
  }

  return text;
}

export class ProcessGenerator {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.openai.com/v1",
    // Генерация промптов происходит редко (не на каждое сообщение бота) — экономить тут не нужно,
    // имеет смысл ставить самую умную доступную модель через GENERATION_MODEL.
    private model: string = process.env.GENERATION_MODEL ?? "openai/gpt-4o"
  ) {}

  private async callLLMOnce(systemPrompt: string, errorLabel: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.7,
        max_tokens: GENERATION_MAX_TOKENS,
        messages: [{ role: "system", content: systemPrompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Генерация "${errorLabel}" не удалась: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`LLM не вернула промпт для "${errorLabel}"`);
    }
    return sanitizeGeneratedPrompt(content.trim());
  }

  // Запрашивает у LLM ТОЛЬКО творческую часть шага (JSON: field_name/recognition/examples).
  // До 3 попыток — модель иногда обрывает JSON или добавляет лишний текст. Каркас промпта
  // добавит код, поэтому здесь важен именно валидный разобранный JSON, а не готовый текст.
  private async callLLMJson(metaPrompt: string, errorLabel: string, kind: StepKind): Promise<StepBody> {
    let lastRaw = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      lastRaw = await this.callLLMOnce(metaPrompt, errorLabel);
      try {
        const parsed = JSON.parse(lastRaw) as StepBody;
        if (Array.isArray(parsed.examples) && parsed.examples.length >= 2) return parsed;
      } catch {
        // не JSON — пробуем ещё раз
      }
    }
    // Крайний случай: не удалось получить валидный JSON. Возвращаем минимальный запасной набор,
    // чтобы шаг всё равно собрался (каркас + хотя бы один пример), а не уронил всю генерацию.
    return {
      field_name: undefined,
      recognition: undefined,
      examples: [
        kind === "completion"
          ? { client: "", bot_message: "Спасибо! Менеджер скоро свяжется с вами. Хорошего дня!" }
          : kind === "router" || kind === "routedStep"
            ? { client: "", bot_message: "Подскажите, пожалуйста, что вам удобнее?", next_process: null }
            : { client: "", bot_message: "Подскажите, пожалуйста, нужную информацию.", data: "", completed: false },
      ],
    };
  }

  private async generateOne(
    companyName: string,
    step: StepInput,
    isCompletion: boolean,
    style: ScenarioStyle,
    scenarioGoals: string[],
    cache?: GenerationCache,
    nonGoals: string[] = []
  ): Promise<string> {
    const key = fingerprint({ kind: "stepV2", companyName, step, isCompletion, style, scenarioGoals, nonGoals });
    const cached = cache?.get(key);
    if (cached) return cached;

    const kind: StepKind = isCompletion ? "completion" : "collection";
    const body = await this.callLLMJson(
      buildBodyMetaPrompt({ kind, companyName, goal: step.goal, required: step.required, rules: step.rules }),
      step.goal,
      kind
    );
    const fieldName = sanitizeFieldName(body.field_name ?? step.fieldName, "value");
    const text = assembleStepPrompt({
      kind,
      companyName,
      goal: step.goal,
      style,
      scenarioGoals,
      nonGoals,
      required: step.required,
      maxAttempts: step.maxAttempts,
      rules: step.rules,
      body,
      fieldName,
    });
    cache?.set(key, text);
    return text;
  }

  // Промпт чистого роутера (без сбора данных) — используется, когда у процесса нет своих шагов,
  // а сразу идёт ветвление (например, самый первый узел сценария — сам развилка).
  async generateRouter(
    companyName: string,
    branches: { condition: string; targetProcessNumber: number }[],
    style: ScenarioStyle,
    scenarioGoals: string[],
    cache?: GenerationCache,
    nonGoals: string[] = []
  ): Promise<string> {
    const key = fingerprint({ kind: "routerV2", companyName, branches, style, scenarioGoals, nonGoals });
    const cached = cache?.get(key);
    if (cached) return cached;

    const body = await this.callLLMJson(
      buildBodyMetaPrompt({ kind: "router", companyName, goal: "", required: true, branches }),
      "роутер ветвления",
      "router"
    );
    const text = assembleStepPrompt({
      kind: "router",
      companyName,
      goal: "",
      style,
      scenarioGoals,
      nonGoals,
      required: true,
      maxAttempts: 3,
      branches,
      body,
      fieldName: "value",
    });
    cache?.set(key, text);
    return text;
  }

  // Промпт последнего шага, СОВМЕЩЁННОГО с ветвлением — один промпт вместо двух отдельных задач.
  async generateRoutedStep(
    companyName: string,
    step: StepInput,
    branches: { condition: string; targetProcessNumber: number }[],
    style: ScenarioStyle,
    scenarioGoals: string[],
    cache?: GenerationCache,
    nonGoals: string[] = []
  ): Promise<string> {
    const key = fingerprint({ kind: "routedStepV2", companyName, step, branches, style, scenarioGoals, nonGoals });
    const cached = cache?.get(key);
    if (cached) return cached;

    const body = await this.callLLMJson(
      buildBodyMetaPrompt({ kind: "routedStep", companyName, goal: step.goal, required: step.required, branches, rules: step.rules }),
      `${step.goal} + ветвление`,
      "routedStep"
    );
    const text = assembleStepPrompt({
      kind: "routedStep",
      companyName,
      goal: step.goal,
      style,
      scenarioGoals,
      nonGoals,
      required: step.required,
      maxAttempts: step.maxAttempts,
      rules: step.rules,
      branches,
      body,
      fieldName: "value",
    });
    cache?.set(key, text);
    return text;
  }

  // Запасной промпт на случай, если обязательный шаг так и не дал результата за все попытки
  // (клиент не смог/не захотел ответить, или роутер не смог понять направление). Не рисуется
  // в конструкторе (не часть графа) — но существует в БД, чтобы MessageHandler мог вежливо
  // завершить диалог вместо тихого обрыва/зацикливания на новый диалог. Стиль и защита цели сюда
  // намеренно НЕ передаются — завершающие промпты всегда живые и тёплые, тему уже не защищают.
  private generateFallbackCompletion(companyName: string, scenarioGoals: string[] = [], cache?: GenerationCache): Promise<string> {
    const goalsHint = scenarioGoals.length > 0
      ? ` Этот бот реально помогает клиенту вот с чем: ${scenarioGoals.join("; ")}. Если по контексту похоже, что запрос клиента вообще не про это (то есть он просил что-то, что бот не умеет решить, а не просто "не разобрались") — в ответе явно и по-человечески скажи, с чем конкретно ты можешь помочь вместо формального "не удалось определить запрос".`
      : "";
    const fallbackStep: StepInput = {
      goal: `Завершить диалог после нескольких неудачных попыток получить от клиента нужную информацию, ИЛИ если запрос клиента оказался вне того, с чем вообще может помочь этот бот. Не извиняться формально и не звучать как робот — сказать по-человечески и пригласить написать снова по теме, с которой бот может помочь.${goalsHint}`,
      required: true,
      maxAttempts: 1,
      rules: [
        {
          type: "custom",
          text: "Ответ должен звучать тепло и без сожалений, как реальный человек: например «Похоже, пока не разобрались вместе — ничего страшного! Напишите, как только будете готовы, и мы продолжим». Не использовать канцелярские фразы вроде «к сожалению, не удалось определить ваш запрос».",
        },
      ],
    };
    return this.generateOne(companyName, fallbackStep, true, DEFAULT_SCENARIO_STYLE, [], cache);
  }

  // Обычный линейный процесс без ветвления: по одному промпту на шаг, последний — completion.
  // В конце всегда добавляется скрытый fallback-completion — на случай, если один из
  // обязательных шагов так и не соберёт данные за все попытки. style применяется ко всем
  // НЕ-завершающим шагам; scenarioGoals — список ВСЕХ целей сценария для защиты темы.
  // cache — если передан, шаги с неизменившимся отпечатком берутся из кеша без вызова LLM.
  async generate(
    companyName: string,
    steps: StepInput[],
    style: ScenarioStyle = DEFAULT_SCENARIO_STYLE,
    scenarioGoals: string[] = [],
    cache?: GenerationCache,
    nonGoals: string[] = []
  ): Promise<GeneratedTask[]> {
    if (steps.length === 0) throw new Error("Нужен хотя бы один шаг");

    const [descriptions, fallback] = await Promise.all([
      Promise.all(steps.map((step, i) => this.generateOne(companyName, step, i === steps.length - 1, style, scenarioGoals, cache, nonGoals))),
      this.generateFallbackCompletion(companyName, scenarioGoals, cache),
    ]);

    const tasks: GeneratedTask[] = steps.map((step, i) => ({
      task_number: `1.${i}`,
      task_type: i === steps.length - 1 ? "completion" : "simple",
      title: step.goal,
      task_description: descriptions[i]!,
    }));
    tasks.push({
      task_number: `1.${steps.length}`,
      task_type: "completion",
      title: "Не удалось собрать данные",
      task_description: fallback,
      is_fallback: true,
    });
    return tasks;
  }

  // Процесс с ветвлением: если у процесса есть свои шаги, ПОСЛЕДНИЙ шаг объединяется с роутером
  // в один промпт (а не идёт отдельной лишней задачей после). Если шагов нет — сам процесс
  // это просто чистый роутер. В конце всегда добавляется скрытый fallback-completion —
  // на случай, если роутер так и не определится с веткой.
  async generateWithBranching(
    companyName: string,
    steps: StepInput[],
    branches: { condition: string; targetProcessNumber: number }[],
    style: ScenarioStyle = DEFAULT_SCENARIO_STYLE,
    scenarioGoals: string[] = [],
    cache?: GenerationCache,
    nonGoals: string[] = []
  ): Promise<GeneratedTask[]> {
    if (steps.length === 0) {
      const [prompt, fallback] = await Promise.all([
        this.generateRouter(companyName, branches, style, scenarioGoals, cache, nonGoals),
        this.generateFallbackCompletion(companyName, scenarioGoals, cache),
      ]);
      return [
        { task_number: "1.0", task_type: "simple", title: "Определить направление", task_description: prompt },
        { task_number: "1.1", task_type: "completion", title: "Не удалось определить направление", task_description: fallback, is_fallback: true },
      ];
    }

    const leading = steps.slice(0, -1);
    const last = steps[steps.length - 1]!;

    const [leadingDescriptions, routedDescription, fallback] = await Promise.all([
      Promise.all(leading.map((step) => this.generateOne(companyName, step, false, style, scenarioGoals, cache, nonGoals))),
      this.generateRoutedStep(companyName, last, branches, style, scenarioGoals, cache, nonGoals),
      this.generateFallbackCompletion(companyName, scenarioGoals, cache),
    ]);

    const tasks: GeneratedTask[] = leading.map((step, i) => ({
      task_number: `1.${i}`,
      task_type: "simple",
      title: step.goal,
      task_description: leadingDescriptions[i]!,
    }));
    tasks.push({
      task_number: `1.${leading.length}`,
      task_type: "simple",
      title: last.goal,
      task_description: routedDescription,
    });
    tasks.push({
      task_number: `1.${leading.length + 1}`,
      task_type: "completion",
      title: "Не удалось определить направление",
      task_description: fallback,
      is_fallback: true,
    });
    return tasks;
  }
}
