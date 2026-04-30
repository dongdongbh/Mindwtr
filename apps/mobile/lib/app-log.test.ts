import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  settings: {
    diagnostics: {
      loggingEnabled: true,
    },
  },
};

vi.mock('@mindwtr/core', () => ({
  getBreadcrumbs: () => [],
  sanitizeForLog: (value: string) => value,
  sanitizeLogContext: (value?: Record<string, unknown>) => (
    value
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
      : undefined
  ),
  sanitizeUrl: (value: string) => value,
  useTaskStore: {
    getState: () => storeState,
  },
}));

import { clearLog, ensureLogFilePath, getLogPath, logInfo, setLogBackend, type LogBackend } from './app-log';

describe('app-log', () => {
  const backend: Required<LogBackend> = {
    appendLogLine: vi.fn(async () => 'file://test.log'),
    getLogPath: vi.fn(async () => 'file://test.log'),
    ensureLogFilePath: vi.fn(async () => 'file://test.log'),
    clearLog: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storeState.settings = {
      diagnostics: {
        loggingEnabled: true,
      },
    };
    setLogBackend(backend);
  });

  afterEach(() => {
    setLogBackend(null);
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

  it('delegates log file helpers to the injected backend', async () => {
    await expect(getLogPath()).resolves.toBe('file://test.log');
    await expect(ensureLogFilePath()).resolves.toBe('file://test.log');
    await clearLog();

    expect(backend.getLogPath).toHaveBeenCalledTimes(1);
    expect(backend.ensureLogFilePath).toHaveBeenCalledTimes(1);
    expect(backend.clearLog).toHaveBeenCalledTimes(1);
  });
});
