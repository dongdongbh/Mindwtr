import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStoreCommand, runSyncStoreSave, type Attachment, type Task } from '@mindwtr/core';

const invokeMock = vi.hoisted(() => vi.fn());
const updateTaskMock = vi.hoisted(() => vi.fn());
const updateProjectMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
    _allTasks: [] as unknown[],
    _allProjects: [] as unknown[],
    updateTask: (...args: unknown[]) => updateTaskMock(...args),
    updateProject: (...args: unknown[]) => updateProjectMock(...args),
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@mindwtr/core')>()),
    useTaskStore: { getState: () => storeState },
}));

vi.mock('./tauri-invoke', () => ({
    invokeNative: invokeMock,
    invokeNativeOr: vi.fn(),
}));

vi.mock('./app-log', () => ({
    logInfo: vi.fn(async () => null),
    logWarn: logWarnMock,
}));

import { migratePortableAttachments } from './portable-migration';

const LEGACY_DIR = '/home/u/.local/share/mindwtr/attachments';
const MANAGED_DIR = '/media/stick/Mindwtr/data/attachments';

const setTauriRuntime = (enabled: boolean) => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        writable: true,
        value: enabled ? {} : undefined,
    });
};

// Attachment file names are `<id>.<ext>` — the property platform.rs's
// normalize_open_path relies on to re-home a stale URI (#1038).
const fileAttachment = (id: string, dir: string): Attachment => ({
    id,
    kind: 'file',
    name: `${id}.pdf`,
    uri: `${dir}/${id}.pdf`,
} as unknown as Attachment);

const taskWith = (id: string, attachments: Attachment[]): Task => ({
    id,
    title: id,
    attachments,
} as unknown as Task);

const migrationResult = (migratedFileNames: string[]) => ({
    isPortable: true,
    legacyAttachmentsDir: LEGACY_DIR,
    managedAttachmentsDir: MANAGED_DIR,
    migratedFileNames,
});

beforeEach(() => {
    setTauriRuntime(true);
    storeState._allTasks = [];
    storeState._allProjects = [];
});

afterEach(() => {
    setTauriRuntime(false);
    invokeMock.mockReset();
    updateTaskMock.mockReset();
    updateProjectMock.mockReset();
    logWarnMock.mockReset();
});

describe('migratePortableAttachments', () => {
    it('rewrites legacy attachment URIs into the portable profile', async () => {
        storeState._allTasks = [taskWith('task-1', [fileAttachment('att-1', LEGACY_DIR)])];
        invokeMock.mockResolvedValue(migrationResult(['att-1.pdf']));
        updateTaskMock.mockResolvedValue(undefined);

        await migratePortableAttachments();

        expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
            attachments: [expect.objectContaining({ id: 'att-1', uri: `${MANAGED_DIR}/att-1.pdf` })],
        });
    });

    it('leaves the rest of the store alone when one rewrite rejects mid-loop', async () => {
        storeState._allTasks = [
            taskWith('task-1', [fileAttachment('att-1', LEGACY_DIR)]),
            taskWith('task-2', [fileAttachment('att-2', LEGACY_DIR)]),
        ];
        invokeMock.mockResolvedValue(migrationResult(['att-1.pdf', 'att-2.pdf']));
        // Write through to the fixture store so the assertions below see the
        // real half-migrated state, not just the calls that were attempted.
        updateTaskMock.mockImplementation(async (taskId: string, patch: Partial<Task>) => {
            if (taskId === 'task-2') throw new Error('write failed');
            storeState._allTasks = storeState._allTasks.map((task) => (
                (task as Task).id === taskId ? { ...(task as Task), ...patch } : task
            ));
        });

        // A rejected rewrite must not take down app startup.
        await expect(migratePortableAttachments()).resolves.toBeUndefined();

        expect(logWarnMock).toHaveBeenCalledWith(
            'Portable attachment migration failed',
            expect.anything()
        );
        const rewritten = (storeState._allTasks[0] as Task).attachments?.[0] as Attachment;
        expect(rewritten.uri).toBe(`${MANAGED_DIR}/att-1.pdf`);

        // The files are already moved, so every attachment the loop did not
        // reach still points at the legacy dir. Those stay openable only
        // because the recorded file name is `<attachment id>.<ext>` and
        // platform.rs's normalize_open_path retries that name in the managed
        // attachments dir (#1038) — the coupling this asserts.
        const stranded = (storeState._allTasks[1] as Task).attachments?.[0] as Attachment;
        expect(stranded.uri).toBe(`${LEGACY_DIR}/att-2.pdf`);
        expect(stranded.uri.split('/').pop()).toBe(`${stranded.id}.pdf`);
    });

    it('rewrites the attachment list a sync save published while the rewrite waited', async () => {
        storeState._allTasks = [taskWith('task-1', [fileAttachment('att-1', LEGACY_DIR)])];
        invokeMock.mockResolvedValue(migrationResult(['att-1.pdf']));
        // updateTask as the store runs it: a command behind the write gate.
        updateTaskMock.mockImplementation((taskId: string, patch: Partial<Task>) => runStoreCommand(async () => {
            storeState._allTasks = storeState._allTasks.map((task) => ((task as Task).id === taskId ? { ...(task as Task), ...patch } : task));
        }));
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        // Another device's attachment, published by a sync save that holds the gate when the migration writes.
        const save = runSyncStoreSave(async () => {
            await held;
            storeState._allTasks = [taskWith('task-1', [fileAttachment('att-1', LEGACY_DIR), fileAttachment('att-sib', MANAGED_DIR)])];
        });
        const migrated = migratePortableAttachments();
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();
        await save;
        await migrated;

        expect(((storeState._allTasks[0] as Task).attachments ?? []).map((item) => item.uri)).toEqual([
            `${MANAGED_DIR}/att-1.pdf`, `${MANAGED_DIR}/att-sib.pdf`,
        ]);
    });

    it('does nothing when the install is not portable', async () => {
        storeState._allTasks = [taskWith('task-1', [fileAttachment('att-1', LEGACY_DIR)])];
        invokeMock.mockResolvedValue({ ...migrationResult([]), isPortable: false });

        await migratePortableAttachments();

        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(updateTaskMock).not.toHaveBeenCalled();
    });

    it('does not ask the backend to move anything when no URI is in the legacy dir', async () => {
        storeState._allTasks = [taskWith('task-1', [fileAttachment('att-1', MANAGED_DIR)])];
        invokeMock.mockResolvedValue(migrationResult([]));

        await migratePortableAttachments();

        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenCalledWith('migrate_portable_attachments', { fileNames: [] });
        expect(updateTaskMock).not.toHaveBeenCalled();
    });
});
