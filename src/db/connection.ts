import postgres from "postgres";

// DATABASE_URL подставится позже, когда появится Supabase-проект
export const sql = postgres(process.env.DATABASE_URL!, {
  ssl: "require",
});
