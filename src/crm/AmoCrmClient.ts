// Тонкий клиент к AmoCRM REST API. Предполагается долгоживущий access_token
// (выпуск/рефреш OAuth-токена — вопрос настройки интеграции, не входит в этот слой).
export class AmoCrmClient {
  constructor(
    private subdomain: string,
    private accessToken: string
  ) {}

  private baseUrl(): string {
    return `https://${this.subdomain}.amocrm.ru/api/v4`;
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`AmoCRM ${method} ${path} failed: ${res.status} ${errorBody}`);
    }
    return res.json() as Promise<T>;
  }

  async findContactByPhone(phone: string): Promise<number | null> {
    const data = await this.request<{ _embedded?: { contacts?: { id: number }[] } }>(
      `/contacts?query=${encodeURIComponent(phone)}`,
      "GET"
    ).catch(() => null);
    const contact = data?._embedded?.contacts?.[0];
    return contact ? contact.id : null;
  }

  async createContact(name: string, phone: string): Promise<number> {
    const data = await this.request<{ _embedded: { contacts: { id: number }[] } }>("/contacts", "POST", [
      {
        name,
        custom_fields_values: [
          {
            field_code: "PHONE",
            values: [{ value: phone }],
          },
        ],
      },
    ]);
    return data._embedded.contacts[0]!.id;
  }

  async createLead(contactId: number, name: string): Promise<number> {
    const data = await this.request<{ _embedded: { leads: { id: number }[] } }>("/leads", "POST", [
      {
        name,
        _embedded: { contacts: [{ id: contactId }] },
      },
    ]);
    return data._embedded.leads[0]!.id;
  }

  async createTask(leadId: number, managerId: number, text: string): Promise<void> {
    await this.request("/tasks", "POST", [
      {
        text,
        entity_type: "leads",
        entity_id: leadId,
        responsible_user_id: managerId,
        complete_till: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      },
    ]);
  }
}
