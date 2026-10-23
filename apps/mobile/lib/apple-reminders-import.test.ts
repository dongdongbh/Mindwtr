import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

const {
  mockGetItem,
  mockSetItem,
  mockGetCalendarsAsync,
  mockGetRemindersAsync,
  mockDeleteReminderAsync,
  mockGetRemindersPermissionsAsync,
  mockRequestRemindersPermissionsAsync,
  mockPlatform,
  mockCreateRecoverySnapshot,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockGetItem: vi.fn(async () => null as string | null),
  mockSetItem: vi.fn(async () => undefined),
  mockGetCalendarsAsync: vi.fn(async () => []),
  mockGetRemindersAsync: vi.fn(async () => []),
  mockDeleteReminderAsync: vi.fn(async () => undefined),
  mockGetRemindersPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  mockRequestRemindersPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  mockPlatform: { OS: 'ios' },
  mockCreateRecoverySnapshot: vi.fn(async () => 'snapshot.json'),
  mockLogWarn: vi.fn(async () => undefined),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: mockGetItem,
    setItem: mockSetItem,
  },
}));

vi.mock('react-native', () => ({
  Platform: mockPlatform,
}));

vi.mock('expo-calendar', () => ({
  EntityTypes: { REMINDER: 'reminder' },
  getCalendarsAsync: mockGetCalendarsAsync,
  getRemindersAsync: mockGetRemindersAsync,
  deleteReminderAsync: mockDeleteReminderAsync,
  getRemindersPermissionsAsync: mockGetRemindersPermissionsAsync,
  requestRemindersPermissionsAsync: mockRequestRemindersPermissionsAsync,
}));

vi.mock('./app-log', () => ({
  logWarn: mockLogWarn,
}));

// eslint-disable-next-line import/first
import {
  APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
  type AppleRemindersImportOptions,
  getAppleReminderLists,
  importAppleRemindersIntoInbox as importAppleRemindersIntoInboxRaw,
  loadAppleRemindersImportSettings,
  requestAppleRemindersPermission,
  runAppleRemindersAutoImport,
  updateAppleRemindersImportSettings,
} from './apple-reminders-import';

const liveTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: 'Imported reminder',
  status: 'inbox',
  tags: [],
  contexts: [],
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  ...overrides,
});

type ImportTestOptions = Omit<AppleRemindersImportOptions, 'flushPendingSave' | 'getTaskById'>
  & Partial<Pick<AppleRemindersImportOptions, 'flushPendingSave' | 'getTaskById'>>;

const importAppleRemindersIntoInbox = (options: ImportTestOptions) => importAppleRemindersIntoInboxRaw({
  flushPendingSave: async () => undefined,
  getTaskById: (id) => liveTask(id),
  ...options,
});

describe('apple-reminders-import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.OS = 'ios';
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
    mockGetCalendarsAsync.mockResolvedValue([]);
    mockGetRemindersAsync.mockResolvedValue([]);
    mockDeleteReminderAsync.mockResolvedValue(undefined);
    mockGetRemindersPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockRequestRemindersPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockCreateRecoverySnapshot.mockResolvedValue('snapshot.json');
  });

  it('loads reminder lists from iOS reminder calendars', async () => {
    mockGetCalendarsAsync.mockResolvedValue([
      { id: 'work', title: 'Work', color: '#2563eb' },
      { id: '', title: 'Broken' },
      { id: 'inbox', name: 'Inbox' },
    ] as any);

    await expect(getAppleReminderLists()).resolves.toEqual([
      { id: 'inbox', title: 'Inbox', color: undefined },
      { id: 'work', title: 'Work', color: '#2563eb' },
    ]);
    expect(mockGetCalendarsAsync).toHaveBeenCalledWith('reminder');
  });

  it('imports incomplete reminders into Inbox and preserves notes', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: ' Buy milk ', notes: ' 2% ', completed: false },
      { id: 'rem-2', title: 'Done item', completed: true },
      { id: 'rem-3', title: '   ', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      listId: 'list-1',
    })).resolves.toEqual({
      importedCount: 1,
      deletedCount: 0,
      deleteFailedCount: 0,
      skippedDuplicateCount: 0,
      skippedCompletedCount: 1,
      skippedEmptyTitleCount: 1,
      failedCount: 0,
    });

    expect(addTask).toHaveBeenCalledWith('Buy milk', {
      status: 'inbox',
      description: '2%',
    });
    expect(mockCreateRecoverySnapshot).toHaveBeenCalledOnce();
    expect(mockCreateRecoverySnapshot.mock.invocationCallOrder[0]).toBeLessThan(addTask.mock.invocationCallOrder[0]);
    // The import owns the imported-id list only: the list choice and both
    // switches belong to the settings screen.
    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        importedReminderIds: ['rem-1'],
        deleteImportedReminders: false,
        autoImportOnOpen: false,
      }),
    );
  });

  it('re-reads the source ID after a held first snapshot while retaining the earlier registry identity', async () => {
    const originalId = 'AABBCCDD-1234-5678-9ABC-0123456789EF';
    const changedId = '11223344-1234-5678-9ABC-0123456789EF';
    const reminder = { id: originalId, title: ' Task ', notes: ' Notes ', completed: false };
    mockGetRemindersAsync.mockResolvedValue([reminder] as any);
    let releaseSnapshot!: () => void;
    let snapshotEntered!: () => void;
    const heldSnapshot = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const enteredSnapshot = new Promise<void>((resolve) => { snapshotEntered = resolve; });
    const createRecoverySnapshot = vi.fn(async () => {
      snapshotEntered();
      await heldSnapshot;
      return 'snapshot.json';
    });
    const addTask = vi.fn(async () => ({ success: true, id: changedId.toLowerCase() }));

    const importing = importAppleRemindersIntoInbox({
      addTask, createRecoverySnapshot, listId: 'list-1', deleteImportedReminders: true,
    });
    await enteredSnapshot;
    expect(addTask).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockDeleteReminderAsync).not.toHaveBeenCalled();
    reminder.id = changedId;
    releaseSnapshot();

    await expect(importing).resolves.toMatchObject({ importedCount: 1, deletedCount: 1, failedCount: 0 });
    expect(addTask).toHaveBeenCalledWith('Task', { status: 'inbox', description: 'Notes' }, {
      captureId: changedId.toLowerCase(),
    });
    expect(mockSetItem).toHaveBeenCalledWith(APPLE_REMINDERS_IMPORT_SETTINGS_KEY, JSON.stringify({
      importedReminderIds: [originalId], deleteImportedReminders: false, autoImportOnOpen: false,
    }));
    expect(mockDeleteReminderAsync).toHaveBeenCalledWith(changedId);
  });

  it('deletes reminders only after their Inbox task is created when enabled', async () => {
    const addTask = vi.fn()
      .mockResolvedValueOnce({ success: true, id: 'task-id' })
      .mockResolvedValueOnce({ success: false });
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'Imported task', completed: false },
      { id: 'rem-2', title: 'Failed task', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      listId: 'list-1',
      deleteImportedReminders: true,
    })).resolves.toEqual({
      importedCount: 1,
      deletedCount: 1,
      deleteFailedCount: 0,
      skippedDuplicateCount: 0,
      skippedCompletedCount: 0,
      skippedEmptyTitleCount: 0,
      failedCount: 1,
    });

    expect(mockDeleteReminderAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteReminderAsync).toHaveBeenCalledWith('rem-1');
    expect(mockCreateRecoverySnapshot.mock.invocationCallOrder[0]).toBeLessThan(addTask.mock.invocationCallOrder[0]);
    expect(addTask.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteReminderAsync.mock.invocationCallOrder[0]);
    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        importedReminderIds: ['rem-1'],
        deleteImportedReminders: false,
        autoImportOnOpen: false,
      }),
    );
  });

  it('keeps imported reminder IDs when deleting from Apple Reminders fails', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
    mockDeleteReminderAsync.mockRejectedValue(new Error('delete failed'));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'Imported task', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      listId: 'list-1',
      deleteImportedReminders: true,
    })).resolves.toMatchObject({
      importedCount: 1,
      deletedCount: 0,
      deleteFailedCount: 1,
      failedCount: 0,
    });

    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        importedReminderIds: ['rem-1'],
        deleteImportedReminders: false,
        autoImportOnOpen: false,
      }),
    );
  });

  it('skips reminders that were imported before', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
    mockGetItem.mockResolvedValue(JSON.stringify({
      selectedListId: 'list-1',
      deleteImportedReminders: false,
      importedReminderIds: ['rem-1', 'fallback:list-1:Floating thought:note:::'],
    }));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'Already imported', completed: false },
      { title: 'Floating thought', notes: 'note', completed: false },
      { id: 'rem-2', title: 'New idea', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      listId: 'list-1',
    })).resolves.toMatchObject({
      importedCount: 1,
      skippedDuplicateCount: 2,
      failedCount: 0,
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('New idea', { status: 'inbox' });
    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        selectedListId: 'list-1',
        importedReminderIds: ['rem-1', 'fallback:list-1:Floating thought:note:::', 'rem-2'],
        deleteImportedReminders: false,
        autoImportOnOpen: false,
      }),
    );
  });

  // The import runs on every foreground now (#1238), so iOS can end the app in
  // the middle of it. Every reminder already added must be written down before
  // the next one is attempted, or the next run adds it a second time.
  it('saves the imported ids after each add, so an interrupted run cannot re-import', async () => {
    const addTask = vi.fn()
      .mockResolvedValueOnce({ success: true, id: 'task-1' })
      .mockRejectedValueOnce(new Error('app closed'));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'First', completed: false },
      { id: 'rem-2', title: 'Second', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      listId: 'list-1',
    })).rejects.toThrow('app closed');

    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        importedReminderIds: ['rem-1'],
        deleteImportedReminders: false,
        autoImportOnOpen: false,
      }),
    );
  });

  // core's addTask only queues a debounced snapshot, so a reminder is not
  // really imported until that save is on disk. Recording the id first would
  // make a kill inside that gap skip the reminder forever.
  it('records the id and deletes the reminder only after the task save is durable', async () => {
    const order: string[] = [];
    const addTask = vi.fn(async () => { order.push('addTask'); return { success: true, id: 'task-1' }; });
    const flushPendingSave = vi.fn(async () => { order.push('flush'); });
    const getTaskById = vi.fn((id: string) => {
      order.push('lookup');
      return liveTask(id);
    });
    mockSetItem.mockImplementation((async () => { order.push('setItem'); }) as never);
    mockDeleteReminderAsync.mockImplementation((async () => { order.push('deleteReminder'); }) as never);
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'First', completed: false },
    ] as any);

    await importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      flushPendingSave,
      getTaskById,
      listId: 'list-1',
      deleteImportedReminders: true,
    });

    expect(order).toEqual(['addTask', 'flush', 'lookup', 'setItem', 'deleteReminder']);
  });

  it('leaves the reminder untouched and stops when the task save cannot be flushed', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-1' }));
    const flushPendingSave = vi.fn(async () => { throw new Error('save failed'); });
    const getTaskById = vi.fn((id: string) => liveTask(id));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'First', completed: false },
      { id: 'rem-2', title: 'Second', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      flushPendingSave,
      getTaskById,
      listId: 'list-1',
      deleteImportedReminders: true,
    })).resolves.toMatchObject({ importedCount: 0, deletedCount: 0, failedCount: 1 });

    // Nothing recorded, nothing deleted, and the run stops rather than piling
    // up more tasks that cannot be saved either.
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockDeleteReminderAsync).not.toHaveBeenCalled();
    expect(getTaskById).not.toHaveBeenCalled();
    expect(addTask).toHaveBeenCalledTimes(1);
  });

  it('keeps a settings change the user makes while the import runs', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({
      selectedListId: 'list-1',
      importedReminderIds: [],
      deleteImportedReminders: true,
      autoImportOnOpen: true,
    }));
    const addTask = vi.fn(async () => {
      // The user turns both switches off on the settings screen mid-import.
      mockGetItem.mockResolvedValue(JSON.stringify({
        selectedListId: 'list-1',
        importedReminderIds: [],
        deleteImportedReminders: false,
        autoImportOnOpen: false,
      }));
      return { success: true, id: 'task-1' };
    });
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'First', completed: false },
    ] as any);

    await importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      listId: 'list-1',
      deleteImportedReminders: true,
    });

    const calls = (mockSetItem as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.parse(String(calls[calls.length - 1]?.[1]))).toEqual({
      selectedListId: 'list-1',
      importedReminderIds: ['rem-1'],
      deleteImportedReminders: false,
      autoImportOnOpen: false,
    });
  });

  it('accepts a live UUID replay after flush and records the reminder once', async () => {
    const reminderId = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
    const taskId = reminderId.toLowerCase();
    const addTask = vi.fn(async () => ({ success: true, id: taskId }));
    const getTaskById = vi.fn((id: string) => liveTask(id));
    mockGetRemindersAsync.mockResolvedValue([
      { id: reminderId, title: 'Modern id', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      getTaskById,
      listId: 'list-1',
      deleteImportedReminders: true,
    })).resolves.toMatchObject({ importedCount: 1, deletedCount: 1, failedCount: 0 });

    expect(addTask).toHaveBeenCalledWith(
      'Modern id',
      { status: 'inbox' },
      { captureId: taskId },
    );
    expect(getTaskById).toHaveBeenCalledWith(taskId);
    expect(mockSetItem).toHaveBeenCalledOnce();
    expect(mockDeleteReminderAsync).toHaveBeenCalledWith(reminderId);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('resolves a non-UUID import by the generated task id', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'generated-task-id' }));
    const getTaskById = vi.fn((id: string) => liveTask(id));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-legacy', title: 'Legacy id', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      getTaskById,
      listId: 'list-1',
    })).resolves.toMatchObject({ importedCount: 1, failedCount: 0 });

    expect(addTask).toHaveBeenCalledWith('Legacy id', { status: 'inbox' });
    expect(getTaskById).toHaveBeenCalledWith('generated-task-id');
  });

  it.each([
    ['deleted', { deletedAt: '2026-09-22T00:00:00.000Z' }],
    ['purged', {
      deletedAt: '2026-09-22T00:00:00.000Z',
      purgedAt: '2026-09-22T01:00:00.000Z',
    }],
  ])('keeps a %s UUID replay in Apple Reminders when core resolves a tombstone', async (_state, tombstone) => {
    const reminderId = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
    const taskId = reminderId.toLowerCase();
    const flushPendingSave = vi.fn(async () => undefined);
    const getTaskById = vi.fn(() => liveTask(taskId, tombstone));
    mockGetRemindersAsync.mockResolvedValue([
      { id: reminderId, title: 'Replay', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask: vi.fn(async () => ({ success: true, id: taskId })),
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      flushPendingSave,
      getTaskById,
      listId: 'list-1',
      deleteImportedReminders: true,
    })).resolves.toMatchObject({
      importedCount: 0,
      deletedCount: 0,
      failedCount: 1,
    });

    expect(flushPendingSave).toHaveBeenCalledOnce();
    expect(getTaskById).toHaveBeenCalledWith(taskId);
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockDeleteReminderAsync).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith('Apple Reminders import kept source because the resolved task is not live', {
      scope: 'import',
      extra: { releaseCheck: 'v1.3.2/reminder-live-import-guard' },
    });
  });

  it('keeps the source reminder when a successful add returns no task id', async () => {
    const flushPendingSave = vi.fn(async () => undefined);
    const getTaskById = vi.fn((id: string) => liveTask(id));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-legacy', title: 'Missing result id', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask: vi.fn(async () => ({ success: true })),
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      flushPendingSave,
      getTaskById,
      listId: 'list-1',
      deleteImportedReminders: true,
    })).resolves.toMatchObject({ importedCount: 0, deletedCount: 0, failedCount: 1 });

    expect(flushPendingSave).toHaveBeenCalledOnce();
    expect(getTaskById).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockDeleteReminderAsync).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith('Apple Reminders import kept source because the resolved task is not live', {
      scope: 'import',
      extra: { releaseCheck: 'v1.3.2/reminder-live-import-guard' },
    });
  });

  it('queues a settings write behind a running import', async () => {
    let releaseAdd!: () => void;
    const addTask = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseAdd = resolve; });
      return { success: true, id: 'task-1' };
    });
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'First', completed: false },
    ] as any);
    // Mirror what the app stores so each read sees the previous write.
    mockSetItem.mockImplementation((async (_key: string, value: string) => {
      mockGetItem.mockResolvedValue(value);
    }) as never);

    const importing = importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      listId: 'list-1',
    });
    await vi.waitFor(() => expect(addTask).toHaveBeenCalled());
    let flipped: Promise<unknown> | undefined;
    try {
      flipped = updateAppleRemindersImportSettings((current) => ({ ...current, autoImportOnOpen: true }));
    } finally {
      // Always let the import finish: a wedged import would wedge the queue.
      releaseAdd();
    }
    await importing;
    await flipped;

    await expect(loadAppleRemindersImportSettings()).resolves.toEqual({
      importedReminderIds: ['rem-1'],
      deleteImportedReminders: false,
      autoImportOnOpen: true,
    });
  });

  it('does not create a recovery snapshot when there is nothing to import', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'Done item', completed: true },
      { id: 'rem-2', title: '   ', completed: false },
    ] as any);

    await importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      listId: 'list-1',
    });

    expect(mockCreateRecoverySnapshot).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not import or delete reminders when the recovery snapshot fails', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
    mockCreateRecoverySnapshot.mockRejectedValue(new Error('snapshot failed'));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'Imported task', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      deleteImportedReminders: true,
      listId: 'list-1',
    })).rejects.toThrow('snapshot failed');

    expect(addTask).not.toHaveBeenCalled();
    expect(mockDeleteReminderAsync).not.toHaveBeenCalled();
  });

  it('keeps malformed stored settings from breaking import state', async () => {
    mockGetItem.mockResolvedValue('{bad json');

    await expect(loadAppleRemindersImportSettings()).resolves.toEqual({
      importedReminderIds: [],
      deleteImportedReminders: false,
      autoImportOnOpen: false,
    });
  });

  it('reports unavailable reminders permissions outside iOS', async () => {
    mockPlatform.OS = 'android';

    await expect(requestAppleRemindersPermission()).resolves.toBe('unavailable');
    expect(mockRequestRemindersPermissionsAsync).not.toHaveBeenCalled();
  });

  describe('runAppleRemindersAutoImport', () => {
    const stored = (extra: Record<string, unknown>) => JSON.stringify({
      selectedListId: 'list-1',
      selectedListTitle: 'Capture',
      importedReminderIds: [],
      deleteImportedReminders: false,
      ...extra,
    });
    const options = () => ({
      addTask: vi.fn(async () => ({ success: true, id: 'task-id' })) as never,
      createRecoverySnapshot: mockCreateRecoverySnapshot,
      flushPendingSave: vi.fn(async () => undefined),
      getTaskById: (id: string) => liveTask(id),
    });

    it('does nothing when the toggle is off or no list is chosen', async () => {
      mockGetItem.mockResolvedValue(stored({ autoImportOnOpen: false }));
      await expect(runAppleRemindersAutoImport(options())).resolves.toBeNull();
      mockGetItem.mockResolvedValue(stored({ autoImportOnOpen: true, selectedListId: undefined }));
      await expect(runAppleRemindersAutoImport(options())).resolves.toBeNull();
      expect(mockGetRemindersAsync).not.toHaveBeenCalled();
    });

    it('never prompts for permission and skips when access is missing', async () => {
      mockGetItem.mockResolvedValue(stored({ autoImportOnOpen: true }));
      mockGetRemindersPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
      await expect(runAppleRemindersAutoImport(options())).resolves.toBeNull();
      expect(mockRequestRemindersPermissionsAsync).not.toHaveBeenCalled();
      expect(mockGetRemindersAsync).not.toHaveBeenCalled();
    });

    it('imports the chosen list with the saved delete choice and keeps the toggle', async () => {
      mockGetItem.mockResolvedValue(stored({ autoImportOnOpen: true, deleteImportedReminders: true }));
      mockGetRemindersAsync.mockResolvedValue([{ id: 'r-1', title: 'Buy milk', completed: false }] as never);
      const opts = options();
      const result = await runAppleRemindersAutoImport(opts);
      expect(result?.importedCount).toBe(1);
      expect(opts.addTask).toHaveBeenCalledWith('Buy milk', { status: 'inbox' });
      expect(mockDeleteReminderAsync).toHaveBeenCalledWith('r-1');
      const calls = (mockSetItem as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const saved = JSON.parse(String(calls[calls.length - 1]?.[1]));
      expect(saved).toMatchObject({ autoImportOnOpen: true, importedReminderIds: ['r-1'] });
    });

    it('serializes overlapping imports so a reminder is added once', async () => {
      mockGetItem.mockResolvedValue(stored({ autoImportOnOpen: true }));
      mockGetRemindersAsync.mockResolvedValue([{ id: 'r-2', title: 'Call bank', completed: false }] as never);
      // Persisted ids must be visible to the second run: mirror what the app stores.
      mockSetItem.mockImplementation((async (_key: string, value: string) => {
        mockGetItem.mockResolvedValue(value);
      }) as never);
      const opts = options();
      const [first, second] = await Promise.all([
        runAppleRemindersAutoImport(opts),
        runAppleRemindersAutoImport(opts),
      ]);
      expect((first?.importedCount ?? 0) + (second?.importedCount ?? 0)).toBe(1);
      expect(opts.addTask).toHaveBeenCalledTimes(1);
    });
  });
});
