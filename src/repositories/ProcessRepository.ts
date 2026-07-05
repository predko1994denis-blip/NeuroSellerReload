import { sql } from "../db/connection";
import type { Process } from "../entities/Process";

export class ProcessRepository {
  async create(botId: number, processNumber: number, name: string): Promise<Process> {
    const [row] = await sql<Process[]>`
      INSERT INTO processes (bot_id, process_number, name)
      VALUES (${botId}, ${processNumber}, ${name})
      RETURNING *
    `;
    return row!;
  }

  async findById(id: number): Promise<Process | null> {
    const [row] = await sql<Process[]>`
      SELECT * FROM processes WHERE id = ${id}
    `;
    return row ?? null;
  }

  async findByBotId(botId: number): Promise<Process[]> {
    return sql<Process[]>`
      SELECT * FROM processes WHERE bot_id = ${botId} ORDER BY process_number
    `;
  }

  async findByBotAndNumber(botId: number, processNumber: number): Promise<Process | null> {
    const [row] = await sql<Process[]>`
      SELECT * FROM processes WHERE bot_id = ${botId} AND process_number = ${processNumber}
    `;
    return row ?? null;
  }

  // Стартовый процесс бота — не обязательно с номером 1 (номер мог освободиться после удаления)
  async findFirstByBotId(botId: number): Promise<Process | null> {
    const [row] = await sql<Process[]>`
      SELECT * FROM processes WHERE bot_id = ${botId} ORDER BY process_number ASC LIMIT 1
    `;
    return row ?? null;
  }

  // Каскадно удаляет tasks этого процесса (ON DELETE CASCADE в схеме)
  async delete(id: number): Promise<void> {
    await sql`DELETE FROM processes WHERE id = ${id}`;
  }
}
