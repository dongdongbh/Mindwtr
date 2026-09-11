import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform, Switch } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppleRemindersImportSection } from './apple-reminders-import-section';

const reminders = vi.hoisted(() => ({
  getAppleReminderLists: vi.fn(),
  importAppleRemindersIntoInbox: vi.fn(),
  loadAppleRemindersImportSettings: vi.fn(),
  requestAppleRemindersPermission: vi.fn(),
  saveAppleRemindersImportSettings: vi.fn(),
}));

vi.mock('@/lib/apple-reminders-import', () => reminders);
vi.mock('@/lib/data-transfer', () => ({ createMobileRecoverySnapshot: vi.fn() }));
vi.mock('@/lib/settings-utils', () => ({ logSettingsError: vi.fn() }));

const settings = {
  deleteImportedReminders: false,
  selectedListId: 'list-1',
  selectedListTitle: 'Inbox',
};

const importResult = {
  deleteFailedCount: 0,
  deletedCount: 0,
  failedCount: 0,
  importedCount: 1,
  skippedCompletedCount: 0,
  skippedDuplicateCount: 0,
  skippedEmptyTitleCount: 0,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('AppleRemindersImportSection workspace busy boundary', () => {
  let renderer: ReactTestRenderer;
  const onBusyChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (Platform as { OS: string }).OS = 'ios';
    reminders.loadAppleRemindersImportSettings.mockResolvedValue(settings);
    reminders.saveAppleRemindersImportSettings.mockResolvedValue(undefined);
  });

  const renderSection = async () => {
    await act(async () => {
      renderer = create(
        <AppleRemindersImportSection
          addTask={vi.fn()}
          disabled={false}
          onBusyChange={onBusyChange}
          showToast={vi.fn()}
          tc={{} as never}
          tr={(key) => key}
        />,
      );
      await Promise.resolve();
    });
  };

  it('stays busy for the full reminder import operation', async () => {
    const pendingImport = deferred<typeof importResult>();
    reminders.importAppleRemindersIntoInbox.mockReturnValue(pendingImport.promise);
    await renderSection();
    onBusyChange.mockClear();

    await act(async () => {
      renderer.root.findByProps({ testID: 'apple-reminders-import-row' }).props.onPress();
      await Promise.resolve();
    });

    expect(reminders.importAppleRemindersIntoInbox).toHaveBeenCalledOnce();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      pendingImport.resolve(importResult);
      await pendingImport.promise;
    });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('stays busy while reminder list preferences are being written', async () => {
    const pendingSave = deferred<void>();
    reminders.saveAppleRemindersImportSettings.mockReturnValue(pendingSave.promise);
    await renderSection();
    onBusyChange.mockClear();

    await act(async () => {
      renderer.root.findByType(Switch).props.onValueChange(true);
      await Promise.resolve();
    });

    expect(reminders.saveAppleRemindersImportSettings).toHaveBeenCalledOnce();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      pendingSave.resolve();
      await pendingSave.promise;
    });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
});
