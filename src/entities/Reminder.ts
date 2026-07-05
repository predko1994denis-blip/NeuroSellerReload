export interface BotReminderSetting {
  id: number;
  bot_id: number;
  step_order: number;
  delay_minutes: number;
  created_at: Date;
}

export interface Reminder {
  id: number;
  dialog_id: number;
  step_order: number;
  next_fire_at: Date;
  created_at: Date;
}
