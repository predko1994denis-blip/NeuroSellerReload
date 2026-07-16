export type TaskType = "simple" | "analytical" | "completion";

export interface Task {
  id: number;
  process_id: number;
  task_number: string; // формат "X.Y", например "1.0", "2.1"
  task_description: string; // system prompt этой задачи
  task_type: TaskType;
  model: string;
  temperature: number;
  max_attempts: number;
  required: boolean;
  is_fallback: boolean;
  accepts_image: boolean;
  rag_enabled: boolean;
  title: string;
  context_strategy_id: number | null;
  created_at: Date;
}
