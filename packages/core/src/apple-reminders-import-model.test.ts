import { describe, expect, it } from 'vitest';

import {
  classifyAppleReminderForImport,
  normalizeAppleRemindersImportSettings,
} from './apple-reminders-import-model';

describe('classifyAppleReminderForImport', () => {
  it('skips completed before empty title, identity and invalid fallback dates', () => {
    expect(classifyAppleReminderForImport({
      completed: true, title: ' ', creationDate: new Date(NaN),
    }, 'list', new Set())).toEqual({ kind: 'completed' });
  });

  it('skips empty trimmed titles before duplicate identity and fallback dates', () => {
    expect(classifyAppleReminderForImport({
      id: 'known', title: '\t\n ', creationDate: new Date(NaN),
    }, 'list', new Set(['known']))).toEqual({ kind: 'empty-title' });
  });

  it('skips duplicates before producing an Inbox seed', () => {
    expect(classifyAppleReminderForImport({
      id: ' known ', title: ' Task ', notes: ' Notes ', creationDate: new Date(NaN),
    }, 'list', new Set(['known']))).toEqual({ kind: 'duplicate' });
  });

  it('maps only the trimmed title and notes to Inbox and canonicalizes UUID capture IDs', () => {
    expect(classifyAppleReminderForImport({
      id: ' AABBCCDD-1234-5678-9ABC-0123456789EF ',
      title: ' Buy milk ', notes: ' 2% ', completed: false,
      creationDate: new Date('2026-10-01T00:00:00Z'),
      startDate: '2026-10-02', dueDate: '2026-10-03',
    }, 'list', new Set())).toEqual({
      kind: 'candidate',
      importKey: 'AABBCCDD-1234-5678-9ABC-0123456789EF',
      sourceId: 'AABBCCDD-1234-5678-9ABC-0123456789EF',
      captureId: 'aabbccdd-1234-5678-9abc-0123456789ef',
      title: 'Buy milk',
      props: { status: 'inbox', description: '2%' },
    });
  });

  it('uses only literal true for completion and omits empty notes', () => {
    expect(classifyAppleReminderForImport({
      id: 'legacy', title: ' Task ', notes: ' ', completed: 'true',
    }, 'list', new Set())).toEqual({
      kind: 'candidate', importKey: 'legacy', sourceId: 'legacy',
      title: 'Task', props: { status: 'inbox' },
    });
  });

  it.each([
    'not-a-uuid',
    'aabbccdd-1234-5678-9abc-0123456789ef-extra',
    'aabbccdd123456789abc0123456789ef',
    '列表:🧪:e\u0301:é',
  ])('preserves a non-UUID source registry identity: %s', (id) => {
    expect(classifyAppleReminderForImport({ id, title: ' Task ' }, 'list', new Set())).toEqual({
      kind: 'candidate', importKey: id, sourceId: id,
      title: 'Task', props: { status: 'inbox' },
    });
  });

  it('preserves the exact colon-joined fallback, supplied Date ISO and trimmed string fields', () => {
    const source = {
      id: ' ', title: ' 标题:🧪 ', notes: ' café:e\u0301 ',
      creationDate: new Date('2026-10-01T03:04:05.006+02:00'),
      startDate: ' local:date ', dueDate: new Date('2026-10-03T00:00:00Z'),
    };
    const importKey = 'fallback:list:one:标题:🧪:café:e\u0301:2026-10-01T01:04:05.006Z:local:date:2026-10-03T00:00:00.000Z';
    expect(classifyAppleReminderForImport(source, 'list:one', new Set())).toEqual({
      kind: 'candidate', importKey, title: '标题:🧪',
      props: { status: 'inbox', description: 'café:e\u0301' },
    });
    expect(classifyAppleReminderForImport(source, 'list:one', new Set([importKey])))
      .toEqual({ kind: 'duplicate' });
  });

  it('keeps empty fallback slots for nonstring fields and absent dates', () => {
    expect(classifyAppleReminderForImport({
      id: 42, title: ' Task ', notes: {}, creationDate: 42, startDate: null,
    }, 'list', new Set())).toEqual({
      kind: 'candidate', importKey: 'fallback:list:Task::::', title: 'Task',
      props: { status: 'inbox' },
    });
  });

  it('preserves invalid Date failure only when fallback identity needs that Date', () => {
    expect(() => classifyAppleReminderForImport({
      title: 'Task', creationDate: new Date(NaN),
    }, 'list', new Set())).toThrow(RangeError);
    expect(classifyAppleReminderForImport({
      id: 'source', title: 'Task', creationDate: new Date(NaN),
    }, 'list', new Set())).toMatchObject({ kind: 'candidate', importKey: 'source' });
  });
});

describe('normalizeAppleRemindersImportSettings', () => {
  it.each([undefined, null, false, 0, '', 'invalid', []])('preserves defaults for %j', (value) => {
    expect(normalizeAppleRemindersImportSettings(value)).toEqual({
      importedReminderIds: [], deleteImportedReminders: false, autoImportOnOpen: false,
    });
  });

  it('trims selected values and imported IDs, deduplicates in order and accepts literal booleans', () => {
    expect(normalizeAppleRemindersImportSettings({
      selectedListId: ' list ', selectedListTitle: ' 标题 ',
      importedReminderIds: [' source ', 'source', '', null, 42, '🧪', ' 🧪 '],
      deleteImportedReminders: true, autoImportOnOpen: true,
    })).toEqual({
      selectedListId: 'list', selectedListTitle: '标题', importedReminderIds: ['source', '🧪'],
      deleteImportedReminders: true, autoImportOnOpen: true,
    });
  });

  it('omits invalid selections and ignores truthy nonboolean switches', () => {
    expect(normalizeAppleRemindersImportSettings({
      selectedListId: ' ', selectedListTitle: 42, importedReminderIds: 'source',
      deleteImportedReminders: 1, autoImportOnOpen: 'true',
    })).toEqual({
      importedReminderIds: [], deleteImportedReminders: false, autoImportOnOpen: false,
    });
  });
});
