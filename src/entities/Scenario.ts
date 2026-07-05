export interface Scenario {
  id: number;
  bot_id: number;
  name: string;
  company_name: string;
  graph: unknown; // {nodes, edges} — сырые данные конструктора
  style: unknown; // ScenarioStyle | null
  goals: string[]; // явный список целей сценария, задаётся пользователем
  non_goals: string[]; // явный список того, с чем бот НЕ помогает — пограничные случаи
  generation_cache: Record<string, string>; // отпечаток шага -> сгенерированный текст
  process_ids: number[];
  created_at: Date;
}
