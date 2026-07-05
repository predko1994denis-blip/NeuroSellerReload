import type { IResponseParser, ParsedResponse } from "../entities/LLMContract";

export class ResponseParser implements IResponseParser {
  parse(rawResponse: string): ParsedResponse {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawResponse);
    } catch {
      throw new Error(`LLM вернула не-JSON ответ: ${rawResponse}`);
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

    if (typeof responseText !== "string") {
      throw new Error(`В ответе LLM нет response_text/bot_message: ${rawResponse}`);
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
