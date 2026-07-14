// Превращает фото, присланное клиентом на шаге сценария, в обычный текст — дальше это
// "прочитанное" значение идёт в ту же цепочку (rules/known/валидация), что и текстовое
// сообщение. Сам шаг не знает, что источник был картинкой, а не клавиатурой.
export class ImageStepReader {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.openai.com/v1",
    private model: string = process.env.GENERATION_MODEL ?? "openai/gpt-4o"
  ) {}

  async read(image: Buffer, mimeType: string, goal: string, caption?: string): Promise<string> {
    const prompt = this.buildPrompt(goal, caption);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Чтение фото не удалось: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }

  private buildPrompt(goal: string, caption?: string): string {
    const captionLine = caption?.trim()
      ? `\nПодпись клиента к фото: «${caption.trim()}».`
      : "";
    return `Ты помогаешь менеджеру собрать информацию от клиента по фото вместо текста. Цель этого шага диалога: «${goal}».${captionLine}
Извлеки из фото ТОЛЬКО ту информацию, которая реально видна и относится к этой цели (например: номер, название, показания, текст на упаковке/документе и т.п.). Если на фото есть подпись клиента — учти её вместе с картинкой как единое сообщение.
Ответь так, как будто это написал сам клиент текстом — просто и по делу, без пояснений от себя, без markdown, без вступлений.
Если по фото невозможно понять ничего относящегося к цели — опиши в одном предложении, что видно на фото, простыми словами (не выдумывай).`;
  }
}
