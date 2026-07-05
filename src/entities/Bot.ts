export interface Bot {
  id: number;
  client_id: number;
  telegram_token: string;
  company_name: string;
  rag_enabled: boolean;
  teacher_mode_enabled: boolean;
  created_at: Date;
}
