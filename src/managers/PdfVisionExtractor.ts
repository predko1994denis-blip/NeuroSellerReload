import { createRequire } from "module";
import { dirname, join } from "path";

// Извлечение текста из PDF «глазами»: каждая страница рендерится в картинку (pdfjs + @napi-rs/canvas,
// self-contained, без системных либ) и отдаётся зрячей LLM, которая транскрибирует её в чистый текст.
// В отличие от линейного парсинга это корректно читает ТАБЛИЦЫ, прайс-листы, много-колоночные макеты.

const MAX_PAGES = 25; // предохранитель от разорительных документов
const RENDER_SCALE = 2; // баланс читаемости текста и размера картинки/токенов

function resolveStandardFontDataUrl(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("pdfjs-dist/package.json");
    return join(dirname(pkg), "standard_fonts") + "/";
  } catch {
    return undefined;
  }
}

// Фабрика offscreen-канвасов для pdfjs в Node: pdfjs сам создаёт вспомогательные канвасы
// (маски, паттерны) во время рендера — отдаём ему @napi-rs/canvas.
function makeCanvasFactory(canvasMod: typeof import("@napi-rs/canvas")) {
  return class {
    create(width: number, height: number) {
      const canvas = canvasMod.createCanvas(Math.ceil(width) || 1, Math.ceil(height) || 1);
      return { canvas, context: canvas.getContext("2d") };
    }
    reset(cc: { canvas: any }, width: number, height: number) {
      cc.canvas.width = Math.ceil(width) || 1;
      cc.canvas.height = Math.ceil(height) || 1;
    }
    destroy(cc: { canvas: any; context: any }) {
      cc.canvas.width = 0;
      cc.canvas.height = 0;
      cc.canvas = null;
      cc.context = null;
    }
  };
}

const TRANSCRIBE_PROMPT = `Ты — точный OCR-транскриптор. Перепиши ВСЁ содержимое этой страницы в чистый текст (на языке оригинала), ничего не выдумывая и не комментируя.
Правила:
- Таблицы разворачивай ПОСТРОЧНО: каждая строка таблицы — одна запись, все значения её колонок подряд через « — » в том же порядке, что и в шапке таблицы (формат: «значение колонки 1 — значение колонки 2 — … — значение последней колонки»). НЕ сваливай колонки в кучу и не теряй столбцы.
- Сохраняй заголовки разделов и подписи.
- Не добавляй пояснений, преамбул («Вот транскрипция…»), markdown-заборов. Только сам текст страницы.
- Если страница пустая или без текста — верни пустую строку.`;

export class PdfVisionExtractor {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.openai.com/v1",
    private model: string = process.env.GENERATION_MODEL ?? "openai/gpt-4o"
  ) {}

  async extract(buffer: Buffer): Promise<string> {
    const canvasMod = await import("@napi-rs/canvas");
    // pdfjs ожидает эти конструкторы в глобальной области — берём их из @napi-rs/canvas.
    const g = globalThis as Record<string, unknown>;
    g.DOMMatrix ??= (canvasMod as any).DOMMatrix;
    g.Path2D ??= (canvasMod as any).Path2D;
    g.ImageData ??= (canvasMod as any).ImageData;

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const CanvasFactory = makeCanvasFactory(canvasMod);

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: resolveStandardFontDataUrl(),
      isEvalSupported: false,
      CanvasFactory: CanvasFactory as any,
    }).promise;

    const pages: string[] = [];
    const total = Math.min(doc.numPages, MAX_PAGES);
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await page.render({ canvasContext: context as any, viewport, canvas: canvas as any }).promise;
      const png = canvas.toBuffer("image/png");
      page.cleanup();

      const text = await this.transcribePage(png);
      if (text.trim()) pages.push(text.trim());
    }

    await doc.destroy();
    return pages.join("\n\n");
  }

  private async transcribePage(png: Buffer): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: TRANSCRIBE_PROMPT },
              { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Транскрипция страницы не удалась: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}
