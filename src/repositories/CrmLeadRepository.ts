import { sql } from "../db/connection";
import type { CrmLead, Order } from "../entities/Crm";

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

  // Вызывается ровно в момент, когда MessageHandler решает, что диалог завершён (is_active=false).
  // isOrder=true только для настоящего completion, false для fallback/abort (см. вызов в MessageHandler).
  // information перезаписывается ПОЛНОСТЬЮ снимком dialog.known (накопленные слоты за весь диалог) —
  // а не постепенным upsert()-накоплением по кусочкам, где в поле мог осесть сырой known_updates
  // только последнего хода. Создаёт строку, если её ещё не было (диалог завершился без единого upsert).
  async finalizeOrder(dialogId: number, isOrder: boolean, information: Record<string, unknown>): Promise<void> {
    await sql`
      INSERT INTO crm_leads (dialog_id, information, is_order)
      VALUES (${dialogId}, ${sql.json(information as any)}, ${isOrder})
      ON CONFLICT (dialog_id) DO UPDATE SET
        information = ${sql.json(information as any)},
        is_order = ${isOrder}
    `;
  }

  // Заказы бота — только успешно завершённые лиды, вместе с bot_id/chat_id диалога (для UI/скоупа).
  async listOrdersByBotId(botId: number): Promise<Order[]> {
    return sql<Order[]>`
      SELECT l.*, d.bot_id, d.chat_id
      FROM crm_leads l
      INNER JOIN dialogs d ON d.id = l.dialog_id
      WHERE d.bot_id = ${botId} AND l.is_order = true
      ORDER BY l.created_at DESC
    `;
  }
}
