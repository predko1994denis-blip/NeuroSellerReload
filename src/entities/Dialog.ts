export interface Dialog {
  id: number;
  bot_id: number;
  chat_id: string;
  current_process: number;
  current_task_id: string; // например "1.0"
  process_tasks: Record<string, boolean>; // какие task_number завершены
  task_attempts: Record<string, number>; // сколько раз спрашивали задачу
  is_active: boolean;
  greeted: boolean;
  mentioned_products: string[]; // legacy: товары, которые клиент упоминал (заменяется на known)
  known: Record<string, string>; // slot-filling: уже известные данные клиента (имя, авто, год, товар...)
  created_at: Date;
  taken_over_by: number | null; // менеджер перехватил диалог — FSM/LLM не отвечает, пока не отпущен
}
