import { sql } from "../db/connection";
import type { CrmLead } from "../entities/Crm";

export class CrmLeadRepository {
  // Накопительный upsert: новые поля (name/phone/information) дополняют то, что уже собрано,
  // а не перетирают — за весь диалог данные приходят по кусочкам, шаг за шагом
  async upsert(
    dialogId: number,
    fields: { name?: string; phone?: string; information?: Record<string, unknown> }
  ): Promise<CrmLead> {
    const [row] = await sql<CrmLead[]>`
      INSERT INTO crm_leads (dialog_id, name, phone, information)
      VALUES (${dialogId}, ${fields.name ?? null}, ${fields.phone ?? null}, ${sql.json((fields.information ?? {}) as any)})
      ON CONFLICT (dialog_id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, crm_leads.name),
        phone = COALESCE(EXCLUDED.phone, crm_leads.phone),
        information = crm_leads.information || EXCLUDED.information
      RETURNING *
    `;
    return row!;
  }

  async findByDialogId(dialogId: number): Promise<CrmLead | null> {
    const [row] = await sql<CrmLead[]>`
      SELECT * FROM crm_leads WHERE dialog_id = ${dialogId}
    `;
    return row ?? null;
  }

  async markProcessed(id: number): Promise<void> {
    await sql`UPDATE crm_leads SET processed = true WHERE id = ${id}`;
  }
}
