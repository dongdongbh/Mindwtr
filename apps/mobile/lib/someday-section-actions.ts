import { buildSomedaySectionsSettingsUpdate, flushPendingSave, planSomedaySectionCreate, runStoreCommand, useTaskStore } from '@mindwtr/core';

/** The one mobile write path used by every Someday section creation picker. */
export async function createSomedaySection(title: string): Promise<string | null> {
  // Core's plan keeps every stored entry as it is, in stored order, and appends the new one. It reads the
  // settings as stored when the write is admitted, so a sync save's newer sections and keys stay.
  const plan = await runStoreCommand(async () => {
    const taskState = useTaskStore.getState();
    const settings = taskState.settings;
    const next = planSomedaySectionCreate(settings?.gtd?.viewSections?.someday, title);
    if (next.kind === 'create') await taskState.updateSettings(buildSomedaySectionsSettingsUpdate(settings, next.sections));
    return next;
  });
  if (plan.kind === 'blank') return null;
  if (plan.kind === 'existing') {
    if (useTaskStore.getState().persistenceFailure) {
      await useTaskStore.getState().retryPersistence();
    }
    await flushPendingSave();
    if (useTaskStore.getState().persistenceFailure) throw new Error('Someday section save incomplete');
    return plan.id;
  }

  await flushPendingSave();
  if (useTaskStore.getState().persistenceFailure) throw new Error('Someday section save incomplete');
  return plan.id;
}
