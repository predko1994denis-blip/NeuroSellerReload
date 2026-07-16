import { sql } from "../db/connection";
import type { Task } from "../entities/Task";

export class TaskRepository {
  async create(task: Omit<Task, "id" | "created_at">): Promise<Task> {
    const [row] = await sql<Task[]>`
      INSERT INTO tasks (
        process_id, task_number, task_description, task_type,
        model, temperature, max_attempts, required, is_fallback, accepts_image, rag_enabled, title, context_strategy_id
      )
      VALUES (
        ${task.process_id}, ${task.task_number}, ${task.task_description}, ${task.task_type},
        ${task.model}, ${task.temperature}, ${task.max_attempts}, ${task.required}, ${task.is_fallback}, ${task.accepts_image}, ${task.rag_enabled}, ${task.title}, ${task.context_strategy_id}
      )
      RETURNING *
    `;
    return row!;
  }

  async findByProcessAndNumber(processId: number, taskNumber: string): Promise<Task | null> {
    const [row] = await sql<Task[]>`
      SELECT * FROM tasks WHERE process_id = ${processId} AND task_number = ${taskNumber}
    `;
    return row ?? null;
  }

  async findByProcessId(processId: number): Promise<Task[]> {
    return sql<Task[]>`
      SELECT * FROM tasks WHERE process_id = ${processId} ORDER BY task_number
    `;
  }

  async findById(id: number): Promise<Task | null> {
    const [row] = await sql<Task[]>`SELECT * FROM tasks WHERE id = ${id}`;
    return row ?? null;
  }

  async updateDescription(id: number, taskDescription: string): Promise<Task> {
    const [row] = await sql<Task[]>`
      UPDATE tasks SET task_description = ${taskDescription} WHERE id = ${id} RETURNING *
    `;
    return row!;
  }
}
