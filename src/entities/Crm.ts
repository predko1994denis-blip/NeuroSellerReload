export interface CrmSettings {
  id: number;
  bot_id: number;
  amocrm_subdomain: string;
  amocrm_access_token: string;
  manager_id: number;
  created_at: Date;
}

export interface CrmLead {
  id: number;
  dialog_id: number;
  name: string | null;
  phone: string | null;
  information: Record<string, unknown>;
  processed: boolean;
  is_order: boolean;
  created_at: Date;
}

// Заказ — это лид (crm_leads) с is_order=true, показанный вместе с номером бота/чата диалога,
// к которому он относится (нужно для экрана "Заказы", чтобы скоупить по bot_id).
export interface Order extends CrmLead {
  bot_id: number;
  chat_id: string;
}
