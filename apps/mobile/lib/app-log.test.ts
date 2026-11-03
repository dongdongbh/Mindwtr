import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  settings: {
    diagnostics: {
      loggingEnabled: true,
    },
  },
};

const breadcrumbState = vi.hoisted(() => ({ value: [] as string[] }));

const legacyFileSystemMocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const documentDirectory = 'file://document/';
  const logDir = 'file://document/logs';

  return {
    documentDirectory: documentDirectory as string | null,
    files,
    deleteAsync: vi.fn(async (uri: string) => {
      files.delete(uri);
      directories.delete(uri);
    }),
    getInfoAsync: vi.fn(async (uri: string) => ({
      exists: files.has(uri) || directories.has(uri),
      isDirectory: directories.has(uri),
      size: files.get(uri)?.length ?? 0,
    })),
    makeDirectoryAsync: vi.fn(async (uri: string) => {
      directories.add(uri);
    }),
    readAsStringAsync: vi.fn(async (uri: string) => files.get(uri) ?? ''),
    reset: () => {
      files.clear();
      directories.clear();
      directories.add(logDir);
      legacyFileSystemMocks.documentDirectory = documentDirectory;
    },
    writeAsStringAsync: vi.fn(async (uri: string, contents: string) => {
      files.set(uri, contents);
    }),
  };
});


vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  return mockCore(importOriginal, () => storeState, {
    getBreadcrumbs: () => breadcrumbState.value,
  });
});

vi.mock('expo-file-system', () => ({
  Directory: class Directory {
    exists = false;
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    create() {}
    delete() {}
  },
  File: class File {
    exists = false;
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    create() {}
    delete() {}
    text = async () => '';
    write() {}
  },
  Paths: {},
}));

vi.mock('expo-file-system/legacy', () => legacyFileSystemMocks);

import {
  __appLogTestUtils,
  clearLog,
  collectFeedbackDiagnostics,
  ensureLogFilePath,
  getLogPath,
  LOCAL_FATAL_CRASH_RELEASE_CHECK,
  logInfo,
  logError,
  readRecentLogText,
  recoverRetainedFatalCrash,
  setLogBackend,
  setupGlobalErrorLogging,
  type LogBackend,
} from './app-log';
import {
  createLocalFatalCrashCapture,
  type LocalFatalCrashCapture,
  type LocalFatalCrashStorage,
  type RetainedFatalCrashEntry,
} from './mobile-crash-capture';

const retainedCrashEntry: RetainedFatalCrashEntry = {
  ts: '2026-09-14T12:34:56.000Z',
  level: 'error',
  scope: 'fatal-recovery',
  message: 'Cannot read properties of undefined (property omitted)',
  stack: 'at renderTask (index.android.bundle:123:45)',
  context: {
    platform: 'android',
    appVersion: '1.3.1',
    buildVersion: '144',
    exceptionType: 'TypeError',
  },
};

const createRetainedCrashCapture = (initial: RetainedFatalCrashEntry | null = retainedCrashEntry) => {
  let retained = initial;
  const serialized = () => retained ? `${JSON.stringify(retained)}\n` : null;
  const capture: LocalFatalCrashCapture = {
    capture: vi.fn(),
    clear: vi.fn(() => {
      retained = null;
    }),
    clearIfUnchanged: vi.fn((identity: string) => {
      if (serialized() !== identity) return false;
      retained = null;
      return true;
    }),
    getPath: vi.fn(() => retained ? 'file://document/logs/mindwtr-fatal-js-crash.json' : null),
    read: vi.fn(() => retained),
    readSnapshot: vi.fn(() => {
      const identity = serialized();
      return retained && identity ? { entry: retained, identity } : null;
    }),
    readText: vi.fn(serialized),
  };
  return { capture, retained: () => retained };
};

describe('app-log', () => {
  const backend: Required<LogBackend> = {
    appendLogLine: vi.fn(async () => 'file://test.log'),
    getLogPath: vi.fn(async () => 'file://test.log'),
    ensureLogFilePath: vi.fn(async () => 'file://test.log'),
    clearLog: vi.fn(async () => undefined),
  };

  beforeEach(async () => {
    __appLogTestUtils.resetGlobalErrorLogging();
    await clearLog();
    __appLogTestUtils.resetGlobalErrorLogging();
    vi.stubGlobal('__DEV__', true);
    vi.clearAllMocks();
    legacyFileSystemMocks.reset();
    breadcrumbState.value = [];
    storeState.settings = {
      diagnostics: {
        loggingEnabled: true,
      },
    };
    setLogBackend(backend);
  });

  afterEach(() => {
    setLogBackend(null);
    __appLogTestUtils.resetGlobalErrorLogging();
    vi.unstubAllGlobals();
  });

  it('routes log writes through an injected backend', async () => {
    await expect(logInfo('Hello', { scope: 'sync' })).resolves.toBe('file://test.log');
    expect(backend.appendLogLine).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        scope: 'sync',
        message: 'Hello',
      }),
      { force: undefined },
    );
  });

  it('serializes overlapping log writes so adjacent diagnostic events are not lost', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    let markFirstWriteStarted: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writeOrder: string[] = [];
    setLogBackend({
      appendLogLine: vi.fn(async (entry) => {
        writeOrder.push(`start:${entry.message}`);
        if (entry.message === 'Notification opened event') {
          markFirstWriteStarted?.();
          await firstWriteReleased;
        }
        writeOrder.push(`finish:${entry.message}`);
        return 'file://test.log';
      }),
    });

    const receiptWrite = logInfo('Notification opened event', { scope: 'notifications' });
    await firstWriteStarted;
    const outcomeWrite = logInfo('Complete action applied', { scope: 'notifications' });
    await Promise.resolve();

    expect(writeOrder).toEqual(['start:Notification opened event']);

    releaseFirstWrite?.();
    await Promise.all([receiptWrite, outcomeWrite]);

    expect(writeOrder).toEqual([
      'start:Notification opened event',
      'finish:Notification opened event',
      'start:Complete action applied',
      'finish:Complete action applied',
    ]);
  });

  it('preserves the logging-enabled guard when a custom backend is installed', async () => {
    storeState.settings = {
      diagnostics: {
        loggingEnabled: false,
      },
    };

    await expect(logInfo('Hello', { scope: 'sync' })).resolves.toBeNull();
    expect(backend.appendLogLine).not.toHaveBeenCalled();

    await expect(logInfo('Forced', { scope: 'sync', force: true })).resolves.toBe('file://test.log');
    expect(backend.appendLogLine).toHaveBeenCalledTimes(1);
  });

  it('adds a content-free feedback snapshot when debug logging is disabled', async () => {
    setLogBackend(null);
    vi.stubGlobal('__DEV__', false);
    storeState.settings = {
      diagnostics: {
        loggingEnabled: false,
      },
    };
    breadcrumbState.value = ['123:view:calendar'];

    const diagnostics = await collectFeedbackDiagnostics();

    expect(diagnostics).toContain('"scope":"feedback"');
    expect(diagnostics).toContain('"message":"Feedback diagnostics snapshot"');
    expect(diagnostics).toContain('"debugLoggingEnabled":"false"');
    expect(diagnostics).toContain('123:view:calendar');
    await expect(readRecentLogText()).resolves.toBeNull();
  });

  it('retains sanitized session errors without enabling disk logging', async () => {
    storeState.settings.diagnostics.loggingEnabled = false;
    await logError(new Error('Request failed token=private-secret'), { scope: 'sync' });
    await logInfo('File picker requested', { scope: 'sync' });
    expect(backend.appendLogLine).not.toHaveBeenCalled();
    const diagnostics = await collectFeedbackDiagnostics();
    expect(diagnostics).toContain('Request failed');
    expect(diagnostics).toContain('File picker requested');
    expect(diagnostics).not.toContain('private-secret');
        expect(diagnostics).toContain('v1.3.0/feedback-diagnostics');
    expect(backend.appendLogLine).not.toHaveBeenCalled();
    await clearLog();
    expect(await collectFeedbackDiagnostics()).not.toContain('Request failed');
  });

  it('delegates log file helpers to the injected backend', async () => {
    await expect(getLogPath()).resolves.toBe('file://test.log');
    await expect(ensureLogFilePath()).resolves.toBe('file://test.log');
    await clearLog();

    expect(backend.getLogPath).toHaveBeenCalledTimes(1);
    expect(backend.ensureLogFilePath).toHaveBeenCalledTimes(1);
    expect(backend.clearLog).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy Expo file-system fallback without warning when the primary log file is unavailable', async () => {
    setLogBackend(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(logInfo('Hello', { scope: 'sync' })).resolves.toBe('file://document/logs/mindwtr.log');
      expect(legacyFileSystemMocks.writeAsStringAsync).toHaveBeenCalledWith(
        'file://document/logs/mindwtr.log',
        expect.stringContaining('Hello'),
        { encoding: 'utf8' },
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to the dev console when Expo Go cannot provide a writable log file', async () => {
    setLogBackend(null);
    legacyFileSystemMocks.documentDirectory = null;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(logInfo('Hello console', { scope: 'sync' })).resolves.toBeNull();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('[Mindwtr sync] Hello console'));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('append log line failed'));
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('captures fatal evidence before the default handler even when disk logging is disabled', () => {
    storeState.settings.diagnostics.loggingEnabled = false;
    const order: string[] = [];
    const crashCapture = {
      capture: vi.fn(() => {
        order.push('capture');
      }),
    };
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    vi.stubGlobal('ErrorUtils', {
      getGlobalHandler: () => (error: unknown, isFatal?: boolean) => {
        expect(error).toBe(fatalError);
        expect(isFatal).toBe(true);
        order.push('default');
        throw new Error('default handler terminated');
      },
      setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => {
        installedHandler = handler;
      },
    });
    const fatalError = new TypeError("Cannot read properties of undefined (reading 'status')");

    (setupGlobalErrorLogging as unknown as (options: { crashCapture: typeof crashCapture }) => void)({ crashCapture });

    expect(() => installedHandler?.(fatalError, true)).toThrow('default handler terminated');
    expect(crashCapture.capture).toHaveBeenCalledWith(fatalError);
    expect(order).toEqual(['capture', 'default']);
    expect(backend.appendLogLine).not.toHaveBeenCalled();
  });

  it('delegates a fatal error exactly once when local capture throws', () => {
    const fatalError = new Error('fatal');
    Object.defineProperty(fatalError, 'message', {
      get: () => { throw new Error('hostile message getter'); },
    });
    const defaultHandler = vi.fn((_error: unknown, _isFatal?: boolean) => {
      throw new Error('default handler terminated');
    });
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    vi.stubGlobal('ErrorUtils', {
      getGlobalHandler: () => defaultHandler,
      setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => {
        installedHandler = handler;
      },
    });
    const crashCapture = createRetainedCrashCapture(null).capture;
    vi.mocked(crashCapture.capture).mockImplementation(() => {
      throw new Error('slot unavailable');
    });

    setupGlobalErrorLogging({ crashCapture });
    expect(() => installedHandler?.(fatalError, true)).toThrow('default handler terminated');

    expect(crashCapture.capture).toHaveBeenCalledOnce();
    expect(defaultHandler).toHaveBeenCalledOnce();
    expect(defaultHandler.mock.calls[0]?.[0]).toBe(fatalError);
    expect(defaultHandler.mock.calls[0]?.[1]).toBe(true);
  });

  it('does not write the fatal slot for nonfatal global errors', () => {
    const error = new Error('recoverable');
    const defaultHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    vi.stubGlobal('ErrorUtils', {
      getGlobalHandler: () => defaultHandler,
      setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => {
        installedHandler = handler;
      },
    });
    const crashCapture = createRetainedCrashCapture(null).capture;

    setupGlobalErrorLogging({ crashCapture });
    installedHandler?.(error, false);

    expect(crashCapture.capture).not.toHaveBeenCalled();
    expect(defaultHandler).toHaveBeenCalledOnce();
    expect(defaultHandler).toHaveBeenCalledWith(error, false);
  });

  it('still installs and delegates when synchronous file-system capture is unavailable', () => {
    const fatalError = new Error('fatal');
    const defaultHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    vi.stubGlobal('ErrorUtils', {
      getGlobalHandler: () => defaultHandler,
      setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => {
        installedHandler = handler;
      },
    });

    setupGlobalErrorLogging({ crashCapture: null });
    installedHandler?.(fatalError, true);

    expect(defaultHandler).toHaveBeenCalledOnce();
    expect(defaultHandler).toHaveBeenCalledWith(fatalError, true);
  });

  it('recovers a retained crash through a forced serialized append before clearing it', async () => {
    storeState.settings.diagnostics.loggingEnabled = false;
    const retained = createRetainedCrashCapture();
    __appLogTestUtils.setLocalFatalCrashCapture(retained.capture);

    await expect(recoverRetainedFatalCrash()).resolves.toBe(true);

    expect(backend.appendLogLine).toHaveBeenNthCalledWith(1, retainedCrashEntry, { force: true });
    expect(backend.appendLogLine).toHaveBeenNthCalledWith(2, expect.objectContaining({
      level: 'info',
      scope: 'diagnostics',
      message: 'Retained fatal JavaScript crash recovered',
      context: {
        releaseCheck: LOCAL_FATAL_CRASH_RELEASE_CHECK,
        count: '1',
      },
    }), { force: true });
    expect(retained.capture.clearIfUnchanged).toHaveBeenCalledOnce();
    expect(retained.retained()).toBeNull();
  });

  it('retains a failed recovery and exposes the crash slot to Settings log sharing', async () => {
    const retained = createRetainedCrashCapture();
    __appLogTestUtils.setLocalFatalCrashCapture(retained.capture);
    vi.mocked(backend.appendLogLine).mockResolvedValue(null);

    await expect(recoverRetainedFatalCrash()).resolves.toBe(false);
    await expect(ensureLogFilePath()).resolves.toBe('file://document/logs/mindwtr-fatal-js-crash.json');

    expect(retained.capture.clearIfUnchanged).not.toHaveBeenCalled();
    expect(retained.retained()).toEqual(retainedCrashEntry);
  });

  it('retains the slot when the recovery proof cannot be appended', async () => {
    const retained = createRetainedCrashCapture();
    __appLogTestUtils.setLocalFatalCrashCapture(retained.capture);
    vi.mocked(backend.appendLogLine)
      .mockResolvedValueOnce('file://test.log')
      .mockResolvedValueOnce(null);

    await expect(recoverRetainedFatalCrash()).resolves.toBe(false);

    expect(backend.appendLogLine).toHaveBeenCalledTimes(2);
    expect(retained.capture.clearIfUnchanged).not.toHaveBeenCalled();
    expect(retained.retained()).toEqual(retainedCrashEntry);
  });

  it('includes a retained crash in explicit feedback diagnostics after a failed import', async () => {
    const retained = createRetainedCrashCapture();
    __appLogTestUtils.setLocalFatalCrashCapture(retained.capture);
    vi.mocked(backend.appendLogLine).mockResolvedValue(null);

    const diagnostics = await collectFeedbackDiagnostics();

    expect(diagnostics).toContain('Cannot read properties of undefined (property omitted)');
    expect(diagnostics).not.toContain(LOCAL_FATAL_CRASH_RELEASE_CHECK);
    expect(retained.capture.clearIfUnchanged).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous retained-crash imports', async () => {
    const retained = createRetainedCrashCapture();
    __appLogTestUtils.setLocalFatalCrashCapture(retained.capture);
    let releaseAppend: (() => void) | undefined;
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    vi.mocked(backend.appendLogLine).mockImplementation(async () => {
      await appendReleased;
      return 'file://test.log';
    });

    const first = recoverRetainedFatalCrash();
    const second = recoverRetainedFatalCrash();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(backend.appendLogLine).toHaveBeenCalledTimes(1);

    releaseAppend?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(backend.appendLogLine).toHaveBeenCalledTimes(2);
    expect(retained.capture.clearIfUnchanged).toHaveBeenCalledOnce();
  });

  it('does not clear a newer fatal crash written during awaited recovery', async () => {
    let stored: string | null = null;
    const storage: LocalFatalCrashStorage = {
      clearTextSync: () => { stored = null; },
      getPath: () => stored ? 'file://document/logs/mindwtr-fatal-js-crash.json' : null,
      readTextSync: () => stored,
      writeTextSync: (value) => { stored = value; },
    };
    let timestamp = '2026-09-14T12:34:56.000Z';
    const capture = createLocalFatalCrashCapture(storage, { platform: 'android' }, {
      now: () => new Date(timestamp),
    });
    capture.capture(new TypeError("Cannot read properties of undefined (reading 'first')"));
    __appLogTestUtils.setLocalFatalCrashCapture(capture);
    let markDetailStarted: (() => void) | undefined;
    let releaseDetail: (() => void) | undefined;
    const detailStarted = new Promise<void>((resolve) => { markDetailStarted = resolve; });
    const detailReleased = new Promise<void>((resolve) => { releaseDetail = resolve; });
    vi.mocked(backend.appendLogLine).mockImplementation(async (entry) => {
      if (entry.scope === 'fatal-recovery') {
        markDetailStarted?.();
        await detailReleased;
      }
      return 'file://test.log';
    });

    const recovery = recoverRetainedFatalCrash();
    await detailStarted;
    timestamp = '2026-09-14T12:35:56.000Z';
    capture.capture(new RangeError('Maximum call stack size exceeded'));
    releaseDetail?.();

    await expect(recovery).resolves.toBe(true);
    expect(capture.read()).toMatchObject({
      ts: '2026-09-14T12:35:56.000Z',
      message: 'Maximum call stack size exceeded',
    });
  });

  it('clears the retained crash slot with the normal diagnostics log', async () => {
    const retained = createRetainedCrashCapture();
    __appLogTestUtils.setLocalFatalCrashCapture(retained.capture);

    await clearLog();

    expect(backend.clearLog).toHaveBeenCalledOnce();
    expect(retained.capture.clear).toHaveBeenCalledOnce();
    expect(retained.retained()).toBeNull();
  });
});
