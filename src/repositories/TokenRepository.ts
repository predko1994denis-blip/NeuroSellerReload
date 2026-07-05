import { sql } from "../db/connection";
import type { Token } from "../entities/Token";

export class TokenRepository {
  async create(userId: number, token: string): Promise<Token> {
    const [row] = await sql<Token[]>`
      INSERT INTO tokens (user_id, token)
      VALUES (${userId}, ${token})
      RETURNING *
    `;
    return row!;
  }

  async findByToken(token: string): Promise<Token | null> {
    const [row] = await sql<Token[]>`
      SELECT * FROM tokens WHERE token = ${token}
    `;
    return row ?? null;
  }
}
