import type { ReminderRepository } from "../repositories/ReminderRepository";
import type { BotReminderSettingRepository } from "../repositories/BotReminderSettingRepository";

export class ReminderManager {
  constructor(
    private reminderRepo: ReminderRepository,
    private settingRepo: BotReminderSettingRepository
  ) {}

  // Вызывается после каждого ответа бота, пока диалог активен — ставит первый шаг цепочки
  async scheduleFirst(dialogId: number, botId: number): Promise<void> {
    const firstStep = await this.settingRepo.findStep(botId, 1);
    if (!firstStep) return; // у бота не настроены follow-up'ы — ничего не делаем

    const nextFireAt = new Date(Date.now() + firstStep.delay_minutes * 60_000);
    await this.reminderRepo.upsert(dialogId, firstStep.step_order, nextFireAt);
  }

  // Юзер ответил — текущий запланированный reminder больше не нужен
  async cancel(dialogId: number): Promise<void> {
    await this.reminderRepo.cancelByDialogId(dialogId);
  }

  // Reminder сработал — переходим к следующему шагу цепочки, если он есть, иначе цепочка закончилась
  async advance(reminderId: number, dialogId: number, botId: number, currentStepOrder: number): Promise<void> {
    const nextStep = await this.settingRepo.findStep(botId, currentStepOrder + 1);
    if (!nextStep) {
      await this.reminderRepo.delete(reminderId);
      return;
    }
    const nextFireAt = new Date(Date.now() + nextStep.delay_minutes * 60_000);
    await this.reminderRepo.upsert(dialogId, nextStep.step_order, nextFireAt);
  }
}
