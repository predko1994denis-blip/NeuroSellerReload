import type { CrmLeadRepository } from "../repositories/CrmLeadRepository";
import type { CrmSettingsRepository } from "../repositories/CrmSettingsRepository";
import type { ParsedResponse } from "../entities/LLMContract";
import { AmoCrmClient } from "../crm/AmoCrmClient";

export class CRMManager {
  constructor(
    private crmLeadRepo: CrmLeadRepository,
    private crmSettingsRepo: CrmSettingsRepository
  ) {}

  // Вызывается на каждом шаге диалога — копит то, что LLM уже успела узнать о лиде
  async saveLeadData(dialogId: number, parsed: ParsedResponse): Promise<void> {
    const { response_text, current_task_completed, next_task, next_process, greeted, tasks, name, phone, ...rest } = parsed;

    if (!name && !phone && Object.keys(rest).length === 0) return; // ничего лидового в этом ответе

    await this.crmLeadRepo.upsert(dialogId, { name, phone, information: rest });
  }

  // Вызывается, когда диалог завершён (is_active=false) — финальный экспорт в AmoCRM
  async sendToAmoCrm(dialogId: number, botId: number): Promise<void> {
    const lead = await this.crmLeadRepo.findByDialogId(dialogId);
    if (!lead || lead.processed) return;

    const settings = await this.crmSettingsRepo.findByBotId(botId);
    if (!settings) return; // у бота не настроена CRM-интеграция

    const client = new AmoCrmClient(settings.amocrm_subdomain, settings.amocrm_access_token);

    const name = lead.name ?? "Без имени";
    let contactId = lead.phone ? await client.findContactByPhone(lead.phone) : null;
    if (!contactId) {
      contactId = await client.createContact(name, lead.phone ?? "");
    }

    const leadId = await client.createLead(contactId, name);
    await client.createTask(leadId, settings.manager_id, "Связаться с лидом из NeuroSeller");

    await this.crmLeadRepo.markProcessed(lead.id);
  }
}
