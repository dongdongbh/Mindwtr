import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({
  settings: {
    gtd: {
      viewSections: { someday: [] as Array<{ id: string; title: string; order: number }> },
    },
  },
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@mindwtr/core', () => ({
  sortViewSectionDefinitions: (definitions: typeof storeState.settings.gtd.viewSections.someday = []) => (
    [...definitions].sort((left, right) => left.order - right.order)
  ),
  useTaskStore: {
    getState: () => storeState,
  },
}));

import { createSomedaySection } from './someday-section-actions';

describe('createSomedaySection', () => {
  beforeEach(() => {
    storeState.settings = { gtd: { viewSections: { someday: [] } } };
    storeState.updateSettings.mockClear();
  });

  it('creates the first definition consumed by the mobile Someday section grouping', async () => {
    const createdId = await createSomedaySection('Books to read');

    expect(createdId).toEqual(expect.any(String));
    expect(storeState.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        viewSections: {
          someday: [expect.objectContaining({ id: createdId, title: 'Books to read', order: 0 })],
        },
      }),
    }));
  });

  it('appends later definitions without rewriting the existing section', async () => {
    storeState.settings = {
      gtd: {
        viewSections: { someday: [{ id: 'books', title: 'Books to read', order: 0 }] },
      },
    };

    await createSomedaySection('Career ideas');

    expect(storeState.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        viewSections: {
          someday: [
            { id: 'books', title: 'Books to read', order: 0 },
            expect.objectContaining({ title: 'Career ideas', order: 1 }),
          ],
        },
      }),
    }));
  });
});
