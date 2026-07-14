import { createRequire } from "module";
import { dirname, join } from "path";

// Текстовый фолбэк-извлекатель на pdfjs-dist (той же версии, что использует рендер в
// PdfVisionExtractor — иначе воркеры pdfjs конфликтуют в одном процессе). Читает текст
// линейно (getTextContent) — таблицы получаются кашей, но для прозы годится. Используется,
// только когда основной vision-путь недоступен (нет ключа/сети).

function resolveStandardFontDataUrl(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("pdfjs-dist/package.json");
    return join(dirname(pkg), "standard_fonts") + "/";
  } catch {
    return undefined;
  }
}

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: resolveStandardFontDataUrl(),
    isEvalSupported: false,
  }).promise;

  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((it) => ("str" in it && typeof it.str === "string" ? it.str : ""))
      .join(" ")
      .trim();
    if (line) parts.push(line);
  }

  await doc.destroy();
  return parts.join("\n\n");
}
