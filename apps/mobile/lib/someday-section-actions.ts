import { sortViewSectionDefinitions, useTaskStore } from '@mindwtr/core';

const makeSomedaySectionId = () => (
  `someday-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
);

/** The one mobile write path used by every Someday section creation picker. */
export async function createSomedaySection(title: string): Promise<string | null> {
  const trimmed = title.trim();
  if (!trimmed) return null;

  const taskState = useTaskStore.getState();
  const settings = taskState.settings;
  const currentSections = sortViewSectionDefinitions(settings?.gtd?.viewSections?.someday);
  const existing = currentSections.find(
    (section) => section.title.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return existing.id;

  const id = makeSomedaySectionId();
  const maxOrder = currentSections.reduce(
    (maximum, section) => Number.isFinite(section.order) ? Math.max(maximum, section.order) : maximum,
    -1,
  );
  await taskState.updateSettings({
    gtd: {
      ...(settings?.gtd ?? {}),
      viewSections: {
        ...(settings?.gtd?.viewSections ?? {}),
        someday: [...currentSections, { id, title: trimmed, order: maxOrder + 1 }],
      },
    },
  });
  return id;
}
