import { sql } from "../db/connection";
import type { User, UserRole } from "../entities/User";

export class UserRepository {
  async create(login: string, passwordHash: string, role: UserRole, clientId: number | null): Promise<User> {
    const [row] = await sql<User[]>`
      INSERT INTO users (login, password_hash, role, client_id)
      VALUES (${login}, ${passwordHash}, ${role}, ${clientId})
      RETURNING *
    `;
    return row!;
  }

  async findByLogin(login: string): Promise<User | null> {
    const [row] = await sql<User[]>`
      SELECT * FROM users WHERE login = ${login}
    `;
    return row ?? null;
  }

  async findById(id: number): Promise<User | null> {
    const [row] = await sql<User[]>`
      SELECT * FROM users WHERE id = ${id}
    `;
    return row ?? null;
  }
}
