import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storeState } = vi.hoisted(() => ({
  storeState: { addTask: vi.fn(async () => ({ success: true })) },
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const useTaskStore = Object.assign((selector?: (state: typeof storeState) => unknown) => (
    selector ? selector(storeState) : storeState
  ), { getState: () => storeState });
  return { ...actual, useTaskStore };
});

const importMocks = vi.hoisted(() => ({
  runAppleRemindersAutoImport: vi.fn(),
  requestAppleRemindersPermission: vi.fn(),
}));
vi.mock('@/lib/apple-reminders-import', () => importMocks);


const appStateListeners = vi.hoisted(() => ({ current: [] as ((state: string) => void)[] }));
vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    AppState: {
      currentState: 'active',
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appStateListeners.current.push(listener);
        return {
          remove: () => {
            appStateListeners.current = appStateListeners.current.filter((entry) => entry !== listener);
          },
        };
      },
    },
  };
});
const foreground = async () => {
  await act(async () => {
    appStateListeners.current.forEach((listener) => listener('active'));
    await Promise.resolve();
  });
};

const logMocks = vi.hoisted(() => ({
  logError: vi.fn(async () => undefined),
  logInfo: vi.fn(async () => undefined),
}));
vi.mock('@/lib/app-log', () => logMocks);
vi.mock('@/lib/data-transfer', () => ({ createMobileRecoverySnapshot: vi.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import { useRootLayoutAppleRemindersAutoImport } from './use-root-layout-apple-reminders';

const emptyResult = {
  importedCount: 0,
  deletedCount: 0,
  deleteFailedCount: 0,
  skippedDuplicateCount: 0,
  skippedCompletedCount: 0,
  skippedEmptyTitleCount: 0,
  failedCount: 0,
};

const showToast = vi.fn();

function Harness({ canonicalDataReady = true, disabled = false }: { canonicalDataReady?: boolean; disabled?: boolean }) {
  useRootLayoutAppleRemindersAutoImport({ canonicalDataReady, disabled, showToast, t: (key: string) => key });
  return null;
}

const mount = async (props: { canonicalDataReady?: boolean; disabled?: boolean } = {}) => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<Harness {...props} />);
    await Promise.resolve();
  });
  return tree;
};

describe('useRootLayoutAppleRemindersAutoImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    appStateListeners.current = [];
    importMocks.runAppleRemindersAutoImport.mockResolvedValue(null);
  });


  it('writes no log line on a foreground where nothing was imported', async () => {
    importMocks.runAppleRemindersAutoImport.mockResolvedValue({ ...emptyResult, skippedDuplicateCount: 3 });
    const tree = await mount();

    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledOnce();
    expect(logMocks.logInfo).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });


  it('hands the import ways to flush and resolve the pending task save', async () => {
    const tree = await mount();

    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledWith(
      expect.objectContaining({
        flushPendingSave: expect.any(Function),
        getTaskById: expect.any(Function),
      }),
    );
    act(() => tree.unmount());
  });

  it('shows the import toast without retaining the confirmed release diagnostic', async () => {
    importMocks.runAppleRemindersAutoImport.mockResolvedValue({ ...emptyResult, importedCount: 2 });
    const tree = await mount();

    expect(logMocks.logInfo).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });
  it('does not run before canonical data is ready or while it is disabled', async () => {
    const notReady = await mount({ canonicalDataReady: false });
    const disabled = await mount({ disabled: true });

    await foreground();

    expect(importMocks.runAppleRemindersAutoImport).not.toHaveBeenCalled();
    act(() => { notReady.unmount(); disabled.unmount(); });
  });


  it('runs once canonical data arrives after the startup snapshot', async () => {
    const tree = await mount({ canonicalDataReady: false });
    await act(async () => {
      tree.update(<Harness canonicalDataReady />);
      await Promise.resolve();
    });

    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });


  it('waits 30 seconds between runs', async () => {
    vi.useFakeTimers();
    const tree = await mount();
    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledOnce();

    await foreground();
    await foreground();
    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    await foreground();
    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('never starts a second run while one is still in flight', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    importMocks.runAppleRemindersAutoImport.mockReturnValue(new Promise((resolve) => {
      release = () => resolve(null);
    }));
    const tree = await mount();
    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await foreground();
    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledOnce();

    await act(async () => { release(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await foreground();
    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });


  it('swallows an import failure without a toast and keeps running later', async () => {
    vi.useFakeTimers();
    importMocks.runAppleRemindersAutoImport.mockRejectedValueOnce(new Error('reminders unavailable'));
    const tree = await mount();

    expect(logMocks.logError).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();

    importMocks.runAppleRemindersAutoImport.mockResolvedValue({ ...emptyResult, importedCount: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    await foreground();
    expect(importMocks.runAppleRemindersAutoImport).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('never asks for the Reminders permission itself', async () => {
    const tree = await mount();
    await foreground();

    expect(importMocks.requestAppleRemindersPermission).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('stops listening once the screen goes away', async () => {
    const tree = await mount();
    act(() => tree.unmount());

    expect(appStateListeners.current).toHaveLength(0);
  });
});
