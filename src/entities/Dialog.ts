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
  created_at: Date;
}
