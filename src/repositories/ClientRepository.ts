import { sql } from "../db/connection";
import type { Client } from "../entities/Client";

export class ClientRepository {
  async create(email: string, passwordHash: string, companyName: string): Promise<Client> {
    const [row] = await sql<Client[]>`
      INSERT INTO clients (email, password_hash, company_name)
      VALUES (${email}, ${passwordHash}, ${companyName})
      RETURNING *
    `;
    return row!;
  }

  async findByEmail(email: string): Promise<Client | null> {
    const [row] = await sql<Client[]>`
      SELECT * FROM clients WHERE email = ${email}
    `;
    return row ?? null;
  }

  async findById(id: number): Promise<Client | null> {
    const [row] = await sql<Client[]>`
      SELECT * FROM clients WHERE id = ${id}
    `;
    return row ?? null;
  }

  async findAll(): Promise<Client[]> {
    return sql<Client[]>`
      SELECT * FROM clients ORDER BY created_at DESC
    `;
  }
}
