export interface Client {
  id: number;
  email: string;
  password_hash: string;
  company_name: string;
  created_at: Date;
}
