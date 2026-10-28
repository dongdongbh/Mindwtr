import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const writeTextFileMock = vi.hoisted(() => vi.fn());
const getManagedPathMock = vi.hoisted(() => vi.fn());
const readTextFileMock = vi.hoisted(() => vi.fn());
const saveDialogMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-fs', async () => {
    return {
        mkdir: mkdirMock,
        readTextFile: readTextFileMock,
        remove: vi.fn(),
        writeTextFile: writeTextFileMock,
    };
});

vi.mock('@tauri-apps/plugin-dialog', async () => {
    return { save: saveDialogMock };
});

vi.mock('@tauri-apps/api/path', async () => {
    return {
        join: async (...segments: string[]) => segments.join('/'),
    };
});

vi.mock('./tauri-invoke', async () => {
    return {
        invokeNative: invokeMock,
        invokeNativeOr: vi.fn(),
    };
});

vi.mock('./managed-paths', async () => {
    return {
        getDeviceManagedPath: getManagedPathMock,
    };
});

import { getLogPath, logInfo, saveLogCopy } from './app-log';

const setTauriRuntime = (enabled: boolean) => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        writable: true,
        value: enabled ? {} : undefined,
    });
};

afterEach(() => {
    setTauriRuntime(false);
    invokeMock.mockReset();
    mkdirMock.mockReset();
    writeTextFileMock.mockReset();
    getManagedPathMock.mockReset();
    readTextFileMock.mockReset();
    saveDialogMock.mockReset();
});

describe('getLogPath', () => {
    it('prefers the path reported by the backend', async () => {
        setTauriRuntime(true);
        const redirected =
            'C:\\Users\\a\\AppData\\Local\\Packages\\pfn\\LocalCache\\Roaming\\mindwtr\\logs\\mindwtr.log';
        invokeMock.mockResolvedValue(redirected);

        const path = await getLogPath();

        expect(path).toBe(redirected);
        expect(invokeMock).toHaveBeenCalledWith('get_log_file_path');
        expect(getManagedPathMock).not.toHaveBeenCalled();
    });

    it('falls back to the computed path when the command is unavailable', async () => {
        setTauriRuntime(true);
        invokeMock.mockRejectedValue(new Error('command unavailable'));
        getManagedPathMock.mockResolvedValue('/data/logs/mindwtr.log');

        const path = await getLogPath();

        expect(path).toBe('/data/logs/mindwtr.log');
        expect(getManagedPathMock).toHaveBeenCalledWith('logs', 'mindwtr.log');
    });
});

describe('appendLogLine', () => {
    it('appends through the native command when it is available', async () => {
        setTauriRuntime(true);
        invokeMock.mockResolvedValue('/data/logs/mindwtr.log');

        const path = await logInfo('hello', { force: true });

        expect(path).toBe('/data/logs/mindwtr.log');
        expect(invokeMock).toHaveBeenCalledWith('append_log_line', {
            line: expect.stringContaining('"message":"hello"'),
        });
        expect(writeTextFileMock).not.toHaveBeenCalled();
    });

    it('falls back to an appending write when the native command is unavailable', async () => {
        setTauriRuntime(true);
        invokeMock.mockRejectedValue(new Error('command unavailable'));
        getManagedPathMock.mockResolvedValue('/data/logs');
        mkdirMock.mockResolvedValue(undefined);
        writeTextFileMock.mockResolvedValue(undefined);

        const path = await logInfo('hello', { force: true });

        expect(path).toBe('/data/logs/mindwtr.log');
        expect(writeTextFileMock).toHaveBeenCalledWith(
            '/data/logs/mindwtr.log',
            expect.stringContaining('"message":"hello"'),
            { append: true }
        );
    });

    it('never rewrites the log file when the appending write fails', async () => {
        setTauriRuntime(true);
        invokeMock.mockRejectedValue(new Error('command unavailable'));
        getManagedPathMock.mockResolvedValue('/data/logs');
        mkdirMock.mockResolvedValue(undefined);
        // A write without `append` replaces the whole file: losing every line
        // logged so far to save this one is never the right trade.
        writeTextFileMock.mockImplementation(async (_path, _contents, options) => {
            if (!options?.append) throw new Error('would have truncated the log');
            throw new Error('append unavailable');
        });

        const path = await logInfo('hello', { force: true });

        expect(path).toBeNull();
        expect(writeTextFileMock).toHaveBeenCalledTimes(1);
        expect(writeTextFileMock).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            { append: true }
        );
    });

    it('does nothing outside the Tauri runtime', async () => {
        setTauriRuntime(false);

        expect(await logInfo('hello', { force: true })).toBeNull();
        expect(invokeMock).not.toHaveBeenCalled();
        expect(writeTextFileMock).not.toHaveBeenCalled();
    });
});

describe('saveLogCopy', () => {
    const logPath = '/data/logs/mindwtr.log';
    const withLogFiles = (files: Record<string, string>) => {
        setTauriRuntime(true);
        invokeMock.mockResolvedValue(logPath);
        readTextFileMock.mockImplementation(async (path: string) => {
            if (path in files) return files[path];
            throw new Error('not found');
        });
    };

    it('writes the rotated history then the current log to the file the tester picked', async () => {
        withLogFiles({ [`${logPath}.1`]: 'older line\n', [logPath]: 'newer line\n' });
        saveDialogMock.mockResolvedValue('/home/a/Desktop/mindwtr.log');

        expect(await saveLogCopy()).toBe('saved');
        expect(saveDialogMock).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'mindwtr.log' }));
        expect(writeTextFileMock).toHaveBeenCalledWith('/home/a/Desktop/mindwtr.log', 'older line\nnewer line\n');
    });

    it('reports a missing log without opening a dialog', async () => {
        withLogFiles({ [logPath]: '  \n' });

        expect(await saveLogCopy()).toBe('missing');
        expect(saveDialogMock).not.toHaveBeenCalled();
    });

    it('writes nothing when the dialog is cancelled', async () => {
        withLogFiles({ [logPath]: 'a line\n' });
        saveDialogMock.mockResolvedValue(null);

        expect(await saveLogCopy()).toBe('cancelled');
        expect(writeTextFileMock).not.toHaveBeenCalled();
    });
});
