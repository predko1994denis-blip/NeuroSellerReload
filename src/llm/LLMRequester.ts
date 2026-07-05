import type { ILLMRequester, LLMRequestPayload } from "../entities/LLMContract";

const MAX_TOKENS = 1000;

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

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("LLM response has no message content");
    }
    return content;
  }
}
