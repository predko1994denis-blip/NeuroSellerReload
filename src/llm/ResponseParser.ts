import type { IResponseParser, ParsedResponse } from "../entities/LLMContract";

export class ResponseParser implements IResponseParser {
  // Пытается достать валидный JSON-объект из «грязного» ответа: снимает markdown-обёртку и берёт
  // подстроку от первой { до последней }. Возвращает объект или null (не спасли — пусть ретрай/ошибка).
  private static salvageJson(raw: string): Record<string, unknown> | null {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      const obj = JSON.parse(s.slice(start, end + 1));
      return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  parse(rawResponse: string): ParsedResponse {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawResponse);
    } catch {
      // Спасаем частые кейсы: модель обернула в ```json … ``` или добавила текст до/после объекта.
      // Вытаскиваем подстроку от первой { до последней } и пробуем ещё раз.
      const salvaged = ResponseParser.salvageJson(rawResponse);
      if (salvaged) {
        json = salvaged;
      } else {
        throw new Error(`LLM вернула не-JSON ответ: ${rawResponse}`);
      }
    }

    // Алиасы: модель иногда называет поле сообщения по-другому (final_message, message, text,
    // farewell и т.п.), нормализуем до канонических имён. Список расширен намеренно — живой диалог
    // не должен падать из-за того, что LLM переименовала поле; лучше принять любое разумное имя.
    const MESSAGE_ALIASES = [
      "response_text",
      "bot_message",
      "final_message",
      "farewell_message",
      "message",
      "text",
      "reply",
      "answer",
      "farewell",
    ];
    let responseText: unknown = undefined;
    for (const alias of MESSAGE_ALIASES) {
      if (typeof json[alias] === "string") {
        responseText = json[alias];
        break;
      }
    }
    // Крайний случай: явного поля сообщения нет, но есть ровно одно строковое поле (кроме служебных) —
    // считаем его сообщением, лишь бы не уронить диалог.
    if (typeof responseText !== "string") {
      const stringFields = Object.entries(json).filter(
        ([k, v]) => typeof v === "string" && k !== "next_process"
      );
      if (stringFields.length === 1) responseText = stringFields[0]![1];
    }

    const taskCompleted = json.current_task_completed ?? json.completed;

    // Пустой/отсутствующий bot_message — это НЕ ошибка: роутер при тихой маршрутизации возвращает
    // bot_message=null + next_process (говорит следующий шаг). Раньше это роняло диалог в
    // «технические неполадки». Дефолтим в "" — follow-up продолжит и следующий шаг заговорит.
    if (typeof responseText !== "string") {
      responseText = "";
    }
    if (typeof taskCompleted !== "boolean") {
      throw new Error(`В ответе LLM нет current_task_completed/completed: ${rawResponse}`);
    }

    const {
      response_text,
      bot_message,
      final_message,
      farewell_message,
      message,
      text,
      reply,
      answer,
      farewell,
      current_task_completed,
      completed,
      ...rest
    } = json;

    return {
      ...rest,
      response_text: responseText,
      current_task_completed: taskCompleted,
    } as ParsedResponse;
  }
}
