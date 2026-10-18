import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({
  settings: {
    gtd: {
      viewSections: { someday: [] as Array<{ id: string; title: string; order: number }> },
    },
  },
  updateSettings: vi.fn().mockResolvedValue(undefined),
  flushPendingSave: vi.fn().mockResolvedValue(undefined),
  persistenceFailure: null as null | { message: string; failedAt: string; retrying: boolean },
  retryPersistence: vi.fn(async () => { storeState.persistenceFailure = null; }),
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
  // The section list edits are core's own logic.
  ...(({ buildSomedaySectionsSettingsUpdate, planSomedaySectionCreate, runStoreCommand, sortViewSectionDefinitions }) => ({
    buildSomedaySectionsSettingsUpdate, planSomedaySectionCreate, runStoreCommand, sortViewSectionDefinitions,
  }))(await importOriginal<typeof import('@mindwtr/core')>()),
  flushPendingSave: storeState.flushPendingSave,
  useTaskStore: {
    getState: () => storeState,
  },
}));

import { createSomedaySection } from './someday-section-actions';

describe('createSomedaySection', () => {
  beforeEach(() => {
    storeState.settings = { gtd: { viewSections: { someday: [] } } };
    storeState.updateSettings.mockClear();
    storeState.flushPendingSave.mockReset().mockResolvedValue(undefined);
    storeState.retryPersistence.mockClear();
    storeState.persistenceFailure = null;
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
    expect(storeState.flushPendingSave).toHaveBeenCalledOnce();
  });

  it('retries a failed durable creation without inserting a duplicate definition', async () => {
    storeState.updateSettings.mockImplementationOnce(async (updates) => {
      storeState.settings = updates;
    });
    storeState.flushPendingSave.mockImplementationOnce(async () => {
      storeState.persistenceFailure = { message: 'disk full', failedAt: 'now', retrying: false };
      throw new Error('disk full');
    });

    await expect(createSomedaySection('Books to read')).rejects.toThrow('disk full');
    expect(storeState.settings.gtd.viewSections.someday).toHaveLength(1);

    const existingId = storeState.settings.gtd.viewSections.someday[0].id;
    await expect(createSomedaySection('Books to read')).resolves.toBe(existingId);
    expect(storeState.updateSettings).toHaveBeenCalledOnce();
    expect(storeState.flushPendingSave).toHaveBeenCalledTimes(2);
    expect(storeState.retryPersistence).toHaveBeenCalledOnce();
  });

  it('keeps every stored entry as it is, in stored order, including ones this build cannot show', async () => {
    // A newer app's entry this build cannot show.
    const folder = { kind: 'folder', children: ['books'] } as unknown as { id: string; title: string; order: number };
    const books = { id: 'books', title: 'Books to read', order: 1 };
    const films = { id: 'films', title: 'Films', order: 0 };
    storeState.settings = { gtd: { viewSections: { someday: [books, folder, films] } } };

    const createdId = await createSomedaySection('Career ideas');

    expect(storeState.updateSettings).toHaveBeenCalledWith({
      gtd: { viewSections: { someday: [books, folder, films, { id: createdId, title: 'Career ideas', order: 2 }] } },
    });
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
