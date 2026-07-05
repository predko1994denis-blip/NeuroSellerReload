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
  created_at: Date;
}
