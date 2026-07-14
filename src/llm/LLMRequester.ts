import type { ILLMRequester, LLMRequestPayload } from "../entities/LLMContract";

const MAX_TOKENS = 3000;

export class LLMRequester implements ILLMRequester {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.openai.com/v1"
  ) {}

  async request(
    systemPrompt: string,
    payload: LLMRequestPayload,
    model: string,
    temperature: number
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: MAX_TOKENS,
        // Отключаем «мышление» gemini-2.5-flash: reasoning-токены съедают бюджет max_tokens и
        // обрывают JSON-ответ. Нам нужен только короткий структурированный вывод, не рассуждения.
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          // OpenAI требует, чтобы слово "json" буквально присутствовало в сообщениях
          // при response_format: json_object — гарантируем это здесь, не полагаясь на текст промпта.
          { role: "system", content: `${systemPrompt}\n\nВсегда отвечай строго валидным JSON-объектом.` },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`LLM request failed: ${res.status} ${errorBody}`);
    }

    const data = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: string } }[] };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    // OpenRouter/Gemini иногда отдают HTTP 200, но с finish_reason=error (rate-limit/сбой провайдера,
    // впрыснутый в поток) и оборванным content. Считаем это ошибкой → сработает ретрай выше.
    if (choice?.finish_reason === "error" || typeof content !== "string" || !content.trim()) {
      throw new Error(`LLM ответ с ошибкой провайдера (finish_reason=${choice?.finish_reason ?? "none"})`);
    }
    return content;
  }

  async requestText(
    systemPrompt: string,
    userMessage: string,
    model: string,
    temperature: number
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: MAX_TOKENS,
        reasoning: { enabled: false }, // без «мышления» — иначе reasoning-токены обрывают ответ
        // Без response_format — ответ приходит простым текстом, парсить нечего.
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`LLM text request failed: ${res.status} ${errorBody}`);
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}
