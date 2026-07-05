export class EmbeddingClient {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.openai.com/v1",
    private model: string = "text-embedding-3-small"
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding request failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0]!.embedding;
  }
}
