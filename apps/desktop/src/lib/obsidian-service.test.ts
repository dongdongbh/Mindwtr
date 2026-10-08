import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObsidianSourceRef } from '@mindwtr/core';

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
const fsExistsMock = vi.hoisted(() => vi.fn());
const fsReadDirMock = vi.hoisted(() => vi.fn());
const fsReadTextFileMock = vi.hoisted(() => vi.fn());
const fsStatMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', async () => {
    return {
        SERIALIZE_TO_IPC_FN: '__TAURI_TO_IPC_KEY__',
        Channel: class {},
        PluginListener: class {
            async unregister() {
                return undefined;
            }
        },
        Resource: class {},
        addPluginListener: async () => ({
            unregister: async () => undefined,
        }),
        checkPermissions: async () => undefined,
        convertFileSrc: (filePath: string) => filePath,
        invoke: invokeMock,
        isTauri: () => true,
        requestPermissions: async () => undefined,
        transformCallback: () => 1,
    };
});

vi.mock('@tauri-apps/api/event', async () => {
    return {
        listen: listenMock,
        emit: async () => undefined,
        emitTo: async () => undefined,
        once: async () => () => undefined,
        TauriEvent: {},
    };
});

vi.mock('@tauri-apps/plugin-fs', async () => {
    return {
        exists: fsExistsMock,
        readDir: fsReadDirMock,
        readTextFile: fsReadTextFileMock,
        stat: fsStatMock,
    };
});

vi.mock('./app-log', async () => {
    return {
        isDiagnosticsEnabled: () => false,
        sanitizeLogMessage: (value: string) => value,
        getLogPath: async () => null,
        clearLog: async () => undefined,
        logInfo: async () => null,
        logWarn: logWarnMock,
        logError: async () => null,
        logSyncError: async () => null,
    };
});

import { ObsidianService, formatScanFoldersInput, parseScanFoldersInput } from './obsidian-service';

const setTauriRuntime = (enabled: boolean) => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        writable: true,
        value: enabled ? {} : undefined,
    });
};

const sourceRef: ObsidianSourceRef = {
    vaultName: 'My Vault',
    vaultPath: '/Vault',
    relativeFilePath: 'Projects/Alpha Plan.md',
    lineNumber: 12,
    fileModifiedAt: '2026-03-14T12:00:00.000Z',
    noteTags: [],
};

afterEach(() => {
    localStorage.clear();
    setTauriRuntime(false);
    invokeMock.mockReset();
    listenMock.mockReset();
    logWarnMock.mockReset();
    fsExistsMock.mockReset();
    fsReadDirMock.mockReset();
    fsReadTextFileMock.mockReset();
    fsStatMock.mockReset();
    vi.restoreAllMocks();
});

describe('obsidian-service helpers', () => {
    it('parses scan folder input into normalized relative folders', () => {
        expect(parseScanFoldersInput('Projects\nInbox, /, ./Area/../Daily')).toEqual([
            'Projects',
            'Inbox',
            '/',
            'Daily',
        ]);
    });

    it('formats scan folders into a stable editable string', () => {
        expect(formatScanFoldersInput(['Projects', '/', 'Projects', 'Daily/Notes'])).toBe('Projects, /, Daily/Notes');
    });

    it('builds Obsidian URIs with encoded vault and file names', () => {
        expect(ObsidianService.buildObsidianUri(sourceRef)).toBe(
            'obsidian://open?vault=My%20Vault&file=Projects%2FAlpha%20Plan'
        );
    });

    it('opens obsidian URIs through the browser when not running in Tauri', async () => {
        const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

        await ObsidianService.openTaskInObsidian(sourceRef);

        expect(openSpy).toHaveBeenCalledWith(
            'obsidian://open?vault=My%20Vault&file=Projects%2FAlpha%20Plan',
            '_blank',
            'noopener,noreferrer'
        );
    });

    it('checks the vault marker through the desktop backend in Tauri', async () => {
        setTauriRuntime(true);
        invokeMock.mockResolvedValueOnce(true);

        await expect(ObsidianService.hasVaultMarker('/Vault')).resolves.toBe(true);

        expect(invokeMock).toHaveBeenCalledWith('check_obsidian_vault_marker', {
            vaultPath: '/Vault',
        });
    });

    it('treats vault marker lookup failures as unknown instead of surfacing a UI error', async () => {
        setTauriRuntime(true);
        invokeMock.mockRejectedValue(new Error('forbidden'));

        await expect(ObsidianService.hasVaultMarker('/Vault')).resolves.toBeNull();
        await expect(ObsidianService.inspectVault('/Vault')).resolves.toEqual({
            hasObsidianDir: null,
        });
        expect(logWarnMock).toHaveBeenCalledTimes(2);
    });

    it('re-expands the vault scope and retries transient forbidden path scan errors', async () => {
        setTauriRuntime(true);
        invokeMock.mockResolvedValue(true);
        fsExistsMock
            .mockRejectedValueOnce(new Error('Forbidden path: /Vault'))
            .mockResolvedValue(true);
        fsStatMock.mockResolvedValue({
            mtime: new Date('2026-03-14T12:00:00.000Z'),
            size: 0,
            isFile: false,
            isDirectory: true,
        });
        fsReadDirMock.mockResolvedValue([]);

        const result = await ObsidianService.scanVault({
            vaultPath: '/Vault',
            vaultName: 'Vault',
            scanFolders: ['/'],
            inboxFile: 'Mindwtr/Inbox.md',
            requiredInlineTag: '',
            taskNotesIncludeArchived: false,
            dataviewMetadataEnabled: false,
            newTaskFormat: 'auto',
            lastScannedAt: null,
            enabled: true,
        });

        expect(invokeMock).toHaveBeenCalledWith('expand_obsidian_vault_scope', {
            vaultPath: '/Vault',
        });
        expect(fsExistsMock).toHaveBeenCalledTimes(2);
        expect(result.scannedFileCount).toBe(0);
        expect(result.tasks).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    it('starts and stops the native Obsidian watcher in Tauri', async () => {
        setTauriRuntime(true);
        const unlistenChanged = vi.fn();
        const unlistenError = vi.fn();
        listenMock
            .mockResolvedValueOnce(unlistenChanged)
            .mockResolvedValueOnce(unlistenError);
        invokeMock.mockResolvedValue(undefined);

        await ObsidianService.startWatcher({
            vaultPath: '/Vault',
            vaultName: 'Vault',
            scanFolders: ['/'],
            inboxFile: 'Mindwtr/Inbox.md',
            requiredInlineTag: '',
            taskNotesIncludeArchived: false,
            dataviewMetadataEnabled: false,
            newTaskFormat: 'auto',
            lastScannedAt: null,
            enabled: true,
        }, {
            onFilesChanged: vi.fn(),
            onError: vi.fn(),
        });

        expect(listenMock).toHaveBeenCalledTimes(2);
        expect(invokeMock).toHaveBeenCalledWith('start_obsidian_watcher', { vaultPath: '/Vault' });

        await ObsidianService.stopWatcher();

        expect(unlistenChanged).toHaveBeenCalledTimes(1);
        expect(unlistenError).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenLastCalledWith('stop_obsidian_watcher');
    });

    it('invokes the desktop write commands for inline and tasknotes flows', async () => {
        setTauriRuntime(true);
        invokeMock.mockResolvedValue(undefined);

        await ObsidianService.toggleTask({
            vaultPath: '/Vault',
            relativeFilePath: 'Inbox.md',
            lineNumber: 14,
            taskText: 'Follow up',
            setCompleted: true,
        });
        await ObsidianService.createTask({
            vaultPath: '/Vault',
            relativeFilePath: 'Mindwtr/Inbox.md',
            taskText: 'Capture task',
        });
        await ObsidianService.toggleTaskNotesTask({
            vaultPath: '/Vault',
            relativeFilePath: 'TaskNotes/Capture.md',
            setCompleted: true,
        });
        await ObsidianService.createTaskNotesTask({
            vaultPath: '/Vault',
            folder: 'TaskNotes',
            title: 'Capture task note',
        });

        expect(invokeMock).toHaveBeenNthCalledWith(1, 'obsidian_toggle_task', {
            vaultPath: '/Vault',
            relativeFilePath: 'Inbox.md',
            lineNumber: 14,
            taskText: 'Follow up',
            setCompleted: true,
        });
        expect(invokeMock).toHaveBeenNthCalledWith(2, 'obsidian_create_task', {
            vaultPath: '/Vault',
            relativeFilePath: 'Mindwtr/Inbox.md',
            taskText: 'Capture task',
        });
        expect(invokeMock).toHaveBeenNthCalledWith(3, 'obsidian_toggle_tasknotes', {
            vaultPath: '/Vault',
            relativeFilePath: 'TaskNotes/Capture.md',
            setCompleted: true,
        });
        expect(invokeMock).toHaveBeenNthCalledWith(4, 'obsidian_create_tasknotes', {
            vaultPath: '/Vault',
            folder: 'TaskNotes',
            title: 'Capture task note',
        });
    });
});


it('adds the configured inline tag once at the creation boundary', async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue(undefined);
    for (const [taskText, expected] of [['Capture', 'Capture #task'], ['Capture #task/work', 'Capture #task/work']]) {
        await ObsidianService.createTask({ vaultPath: '/Vault', relativeFilePath: 'Inbox.md', taskText, requiredInlineTag: '#task' });
        expect(invokeMock).toHaveBeenLastCalledWith('obsidian_create_task', {
            vaultPath: '/Vault', relativeFilePath: 'Inbox.md', taskText: expected,
        });
    }
});
