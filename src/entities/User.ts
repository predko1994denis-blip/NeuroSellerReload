export type UserRole = "admin" | "manager";

export interface User {
  id: number;
  client_id: number | null; // null = admin, видит все компании
  login: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
}
