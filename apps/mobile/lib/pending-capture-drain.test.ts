import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMobileBackgroundSyncRunner } from '@mindwtr/core/mobile-background-sync';
import { peekPendingNotificationCompletions } from '../modules/notification-open-intents';
import { drainPendingCapturesInBackground } from './pending-capture-drain';

const order = vi.hoisted(() => [] as string[]);
const noopStorage = vi.hoisted(() => ({ name: 'noop' }));
const mobileStorage = vi.hoisted(() => ({ name: 'mobile' }));
const logWarn = vi.hoisted(() => vi.fn(async () => undefined));

const core = vi.hoisted(() => {
  const state = {
    adapter: null as unknown,
    sandbox: false,
    store: {
      error: null as string | null,
      _allTasks: [],
      tasks: [], projects: [], areas: [], people: [], settings: {},
      addTask: vi.fn(), updateTask: vi.fn(), addProject: vi.fn(),
      fetchData: vi.fn(async () => { order.push('fetchData'); }),
    },
  };
  return {
    state,
    noopStorage: null as unknown,
    flushPendingSave: vi.fn(async () => { order.push('flush'); }),
    getStorageAdapter: vi.fn(() => state.adapter),
    setStorageAdapter: vi.fn((adapter: unknown) => { state.adapter = adapter; order.push('setStorageAdapter'); }),
    isSandboxMode: vi.fn(() => state.sandbox),
    isWorkspaceTransitionActive: vi.fn(() => false),
    useTaskStore: { getState: () => state.store },
  };
});
const reactNative = vi.hoisted(() => ({ AppState: { currentState: 'background' as string } }));
const fileSystem = vi.hoisted(() => ({
  documentDirectory: 'file:///docs/',
  getInfoAsync: vi.fn(async () => ({ exists: true })),
  readDirectoryAsync: vi.fn(async () => ['a.json'] as string[]),
}));
const ingest = vi.hoisted(() => ({
  ingestPendingCaptures: vi.fn(async (_deps: Record<string, unknown>) => { order.push('ingest'); return 1; }),
}));
const reconcile = vi.hoisted(() => vi.fn(async (_reason: string) => { order.push('reminders'); }));

vi.mock('react-native', () => reactNative);
vi.mock('@mindwtr/core', () => ({ ...core, noopStorage }));
vi.mock('./app-log', () => ({ logInfo: vi.fn(), logWarn }));
vi.mock('./file-system', () => fileSystem);
vi.mock('./pending-capture-persistence', () => ({ flushPendingTaskActionSave: vi.fn() }));
vi.mock('./pending-captures', () => ({ ...ingest, PENDING_CAPTURES_DIRECTORY: 'pending-captures' }));
vi.mock('../modules/notification-open-intents', () => ({ peekPendingNotificationCompletions: vi.fn(async () => []) }));
vi.mock('./notification-completion-drain', () => ({ replayNotificationCompletions: vi.fn(async () => 0) }));
vi.mock('./storage-adapter', () => ({ mobileStorage }));
vi.mock('./notification-service-local', () => ({ reconcileLocalMobileNotificationsInBackground: reconcile }));


describe('background capture drain (#1257)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    core.state.adapter = noopStorage;
    core.state.sandbox = false;
    core.state.store.error = null;
    reactNative.AppState.currentState = 'background';
    fileSystem.readDirectoryAsync.mockResolvedValue(['a.json']);
    vi.mocked(peekPendingNotificationCompletions).mockResolvedValue([]);
    ingest.ingestPendingCaptures.mockImplementation(async () => { order.push('ingest'); return 1; });
    reconcile.mockImplementation(async () => { order.push('reminders'); });
  });

  it('connects storage and loads the store before the first write in a headless runtime', async () => {
    await expect(drainPendingCapturesInBackground('capture')).resolves.toBe(1);
    expect(core.setStorageAdapter).toHaveBeenCalledWith(mobileStorage);
    expect(order).toEqual(['setStorageAdapter', 'flush', 'fetchData', 'ingest', 'reminders']);
    expect(ingest.ingestPendingCaptures.mock.calls[0]?.[0]).not.toHaveProperty('transcribeAudio');
  });

  it('keeps the storage a live app already connected', async () => {
    core.state.adapter = mobileStorage;
    await drainPendingCapturesInBackground('scheduled');
    expect(core.setStorageAdapter).not.toHaveBeenCalled();
    expect(order).toEqual(['flush', 'fetchData', 'ingest', 'reminders']);
  });

  it('does no work for an empty queue', async () => {
    fileSystem.readDirectoryAsync.mockResolvedValue(['a.json.tmp']);
    await expect(drainPendingCapturesInBackground('scheduled')).resolves.toBe(0);
    expect(order).toEqual([]);
  });

  it.each([true, false])('isolates unreadable reminder receipts from capture files (captures=%s)', async (hasCaptures) => {
    const privateError = 'Malformed private receipt contents';
    vi.mocked(peekPendingNotificationCompletions).mockRejectedValueOnce(new Error(privateError));
    fileSystem.readDirectoryAsync.mockResolvedValue(hasCaptures ? ['a.json'] : []);
    await expect(drainPendingCapturesInBackground('capture')).resolves.toBe(hasCaptures ? 1 : 0);
    expect(order).toEqual(hasCaptures ? ['setStorageAdapter', 'flush', 'fetchData', 'ingest', 'reminders'] : []);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('retained for retry'), { scope: 'notifications' });
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(privateError);
  });

  it.each([
    ['the app is visible', () => { reactNative.AppState.currentState = 'active'; }],
    ['the sandbox workspace is open', () => { core.state.sandbox = true; }],
  ])('leaves the queue alone when %s', async (_label, arrange) => {
    arrange();
    await expect(drainPendingCapturesInBackground('capture')).resolves.toBe(0);
    expect(ingest.ingestPendingCaptures).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('awaits reminder reconciliation after durable ingestion', async () => {
    let finish!: () => void;
    reconcile.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let done = false;
    const drain = drainPendingCapturesInBackground('capture').then(() => { done = true; });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('capture'));
    expect(done).toBe(false);
    finish();
    await drain;
  });

  it('does not reconcile when no capture was persisted', async () => {
    ingest.ingestPendingCaptures.mockResolvedValueOnce(0);
    await drainPendingCapturesInBackground('capture');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('never writes into a store that failed to load', async () => {
    core.state.store.fetchData.mockImplementationOnce(async () => { core.state.store.error = 'load failed'; });
    await expect(drainPendingCapturesInBackground('capture')).resolves.toBe(0);
    expect(ingest.ingestPendingCaptures).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reconciles a persisted capture before a background sync that stalls', async () => {
    let finish!: (value: { success: boolean }) => void;
    const network = new Promise<{ success: boolean }>((resolve) => { finish = resolve; });
    const runner = createMobileBackgroundSyncRunner({
      storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
      log: { info: vi.fn(), warn: vi.fn() },
      sync: {
        getConfigurationStatus: async () => ({ backend: 'webdav', configured: true }),
        performSync: () => { order.push('network'); return network; },
        abort: vi.fn(), setRequestDeadline: vi.fn(),
      },
      flushPendingSave: async () => undefined,
      drainPendingCaptures: drainPendingCapturesInBackground,
      quiesceStorage: async () => undefined,
      timersPaused: () => true,
      onAppStateChange: () => ({ remove: () => undefined }),
    });
    const run = runner.runCapture();
    await vi.waitFor(() => expect(order).toContain('network'));
    expect(order).toEqual(['setStorageAdapter', 'flush', 'fetchData', 'ingest', 'reminders', 'network']);
    finish({ success: true });
    await run;
  });
});
