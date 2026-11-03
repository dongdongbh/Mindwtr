import { buildSomedaySectionsSettingsUpdate, flushPendingSave, planSomedaySectionCreate, runStoreCommand, useTaskStore } from '@mindwtr/core';


export async function createSomedaySection(title: string): Promise<string | null> {


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
