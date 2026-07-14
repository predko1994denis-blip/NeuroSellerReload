// Контракт между MessageHandler и LLM-слоем (реализация LLMRequester/ResponseParser — следующий шаг)

export interface LLMHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequestPayload {
  latest_user_message: string;
  greeted: boolean;
  known?: Record<string, string>; // уже известные о клиенте данные (слоты: имя, авто, год, товар...)
  history: LLMHistoryItem[];
}

// То, что распарсил ResponseParser из ответа LLM (после применения алиасов
// bot_message -> response_text, completed -> current_task_completed)
export interface ParsedResponse {
  response_text: string;
  current_task_completed: boolean;
  name?: string;
  phone?: string;
  next_task?: string; // "2.1"
  next_process?: number;
  greeted?: boolean;
  tasks?: Record<string, { completed: boolean } & Record<string, unknown>>;
  [key: string]: unknown; // прочие кастомные поля задачи
}

export interface ILLMRequester {
  request(systemPrompt: string, payload: LLMRequestPayload, model: string, temperature: number): Promise<string>;
  // Простой текстовый вызов (без JSON-режима) — для «Справочной», где ответ это просто текст.
  requestText(systemPrompt: string, userMessage: string, model: string, temperature: number): Promise<string>;
}

export interface IResponseParser {
  parse(rawResponse: string): ParsedResponse;
}
