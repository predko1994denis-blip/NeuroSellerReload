import { sql } from "../db/connection";
import type { Scenario } from "../entities/Scenario";

export class ScenarioRepository {
  async create(
    botId: number,
    name: string,
    companyName: string,
    graph: unknown,
    processIds: number[],
    style: unknown = null,
    generationCache: Record<string, string> = {},
    goals: string[] = [],
    nonGoals: string[] = []
  ): Promise<Scenario> {
    const [row] = await sql<Scenario[]>`
      INSERT INTO scenarios (bot_id, name, company_name, graph, style, goals, non_goals, generation_cache, process_ids)
      VALUES (${botId}, ${name}, ${companyName}, ${sql.json(graph as any)}, ${style ? sql.json(style as any) : null}, ${sql.json(goals as any)}, ${sql.json(nonGoals as any)}, ${sql.json(generationCache as any)}, ${processIds})
      RETURNING *
    `;
    return row!;
  }

  async findByBotId(botId: number): Promise<Scenario[]> {
    return sql<Scenario[]>`
      SELECT * FROM scenarios WHERE bot_id = ${botId} ORDER BY created_at DESC
    `;
  }

  async findById(id: number): Promise<Scenario | null> {
    const [row] = await sql<Scenario[]>`SELECT * FROM scenarios WHERE id = ${id}`;
    return row ?? null;
  }

  async update(
    id: number,
    graph: unknown,
    processIds: number[],
    style: unknown = null,
    generationCache: Record<string, string> = {},
    goals: string[] = [],
    nonGoals: string[] = []
  ): Promise<Scenario> {
    const [row] = await sql<Scenario[]>`
      UPDATE scenarios SET
        graph = ${sql.json(graph as any)},
        style = ${style ? sql.json(style as any) : null},
        goals = ${sql.json(goals as any)},
        non_goals = ${sql.json(nonGoals as any)},
        generation_cache = ${sql.json(generationCache as any)},
        process_ids = ${processIds}
      WHERE id = ${id}
      RETURNING *
    `;
    return row!;
  }

  async delete(id: number): Promise<void> {
    await sql`DELETE FROM scenarios WHERE id = ${id}`;
  }
}
