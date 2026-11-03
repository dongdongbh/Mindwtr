import { describe, expect, spyOn, test } from 'bun:test';
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    renameSync,
    rmSync,
    rmdirSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppData, Attachment, Project, Task } from '@mindwtr/core';
import {
    appendPendingRemoteAttachmentDeletes,
    collectPendingRemoteDeletesForProjectPurge,
    collectReferencedAttachmentCloudKeys,
    collectRetainedAttachmentCloudKeysForProjectPurge,
    garbageCollectOrphanAttachments,
    getAttachmentCloudKey,
    handleAttachmentPathRequest,
} from './server-attachments';
import type { DurableRemovalFileSystem } from './server-storage';

const iso = '2026-01-01T00:00:00.000Z';

const makeTask = (overrides: Pick<Task, 'id' | 'title'> & Partial<Task>): Task => ({
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
});

const makeProject = (overrides: Pick<Project, 'id' | 'title'> & Partial<Project>): Project => ({
    status: 'active',
    color: '#6B7280',
    order: 0,
    tagIds: [],
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
});

const makeFileAttachment = (overrides: Pick<Attachment, 'id'> & Partial<Attachment>): Attachment => ({
    kind: 'file',
    title: 'file',
    uri: '',
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
});

const emptyAppData = (): AppData => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} });


const expireFile = (path: string): void => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(path, staleTime, staleTime);
};

const createRemovalFileSystem = (
    shouldFail: (stage: 'unlink' | 'rmdir' | 'open-parent' | 'fsync-parent' | 'close-parent', path: string) => boolean,
) => {
    const events: string[] = [];
    const handles = new Map<number, string>();
    const enter = (
        stage: 'unlink' | 'rmdir' | 'open-parent' | 'fsync-parent' | 'close-parent',
        path: string,
    ) => {
        events.push(`${stage}:${path}`);
        if (shouldFail(stage, path)) {
            throw Object.assign(new Error(`injected ${stage} failure`), { code: 'EIO' });
        }
    };
    const fileSystem: DurableRemovalFileSystem = {
        existsSync,
        unlinkSync(path) {
            enter('unlink', path);
            unlinkSync(path);
        },
        rmdirSync(path) {
            enter('rmdir', path);
            rmdirSync(path);
        },
        openSync(path) {
            enter('open-parent', path);
            const handle = openSync(path, 'r');
            handles.set(handle, path);
            return handle;
        },
        fsyncSync(handle) {
            const path = handles.get(handle);
            if (!path) throw new Error('invalid directory handle');
            enter('fsync-parent', path);
            fsyncSync(handle);
        },
        closeSync(handle) {
            const path = handles.get(handle);
            if (!path) throw new Error('invalid directory handle');
            enter('close-parent', path);
            handles.delete(handle);
            closeSync(handle);
        },
    };
    return { events, fileSystem };
};

describe('getAttachmentCloudKey', () => {
    test('normalizes the cloud key for file attachments only', () => {
        expect(getAttachmentCloudKey(makeFileAttachment({ id: 'a1', cloudKey: 'folder/file.bin' }))).toBe('folder/file.bin');
        expect(getAttachmentCloudKey(makeFileAttachment({ id: 'a2', cloudKey: undefined }))).toBeNull();
        expect(getAttachmentCloudKey(makeFileAttachment({ id: 'a3', kind: 'link', uri: 'https://example.com', cloudKey: 'ignored' }))).toBeNull();
        expect(getAttachmentCloudKey(makeFileAttachment({ id: 'a4', cloudKey: '../escape' }))).toBeNull();
    });
});

describe('collectReferencedAttachmentCloudKeys', () => {
    test('only counts non-deleted file attachments on non-purged owners', () => {
        const data = emptyAppData();
        data.tasks = [
            makeTask({
                id: 'live-task',
                title: 'Live',
                attachments: [makeFileAttachment({ id: 'ta1', cloudKey: 'live-task/keep.bin' })],
            }),
            makeTask({
                id: 'purged-task',
                title: 'Purged',
                purgedAt: iso,
                attachments: [makeFileAttachment({ id: 'ta2', cloudKey: 'purged-task/excluded.bin' })],
            }),
        ];
        data.projects = [
            makeProject({
                id: 'live-project',
                title: 'Live',
                attachments: [
                    makeFileAttachment({ id: 'pa1', cloudKey: 'live-project/keep.bin' }),
                    makeFileAttachment({ id: 'pa2', cloudKey: 'live-project/deleted-attachment.bin', deletedAt: iso }),
                    { id: 'pa3', kind: 'link', title: 'link', uri: 'https://example.com', createdAt: iso, updatedAt: iso },
                ],
            }),
        ];

        const referenced = collectReferencedAttachmentCloudKeys(data);
        expect(referenced).toEqual(new Set(['live-task/keep.bin', 'live-project/keep.bin']));
    });


    test('retains attachments belonging to a soft-deleted-but-not-purged owner', () => {
        const data = emptyAppData();
        data.tasks = [
            makeTask({
                id: 'trashed-task',
                title: 'Trashed',
                deletedAt: iso,
                attachments: [makeFileAttachment({ id: 'ta1', cloudKey: 'trashed-task/keep.bin' })],
            }),
        ];
        data.projects = [
            makeProject({
                id: 'trashed-project',
                title: 'Trashed',
                deletedAt: iso,
                attachments: [makeFileAttachment({ id: 'pa1', cloudKey: 'trashed-project/keep.bin' })],
            }),
        ];

        const referenced = collectReferencedAttachmentCloudKeys(data);
        expect(referenced).toEqual(new Set(['trashed-task/keep.bin', 'trashed-project/keep.bin']));
    });
});

describe('collectRetainedAttachmentCloudKeysForProjectPurge', () => {
    test('excludes the purging project and any already-purged project, keeps everything else', () => {
        const data = emptyAppData();
        data.projects = [
            makeProject({ id: 'purging', title: 'Purging', attachments: [makeFileAttachment({ id: 'a1', cloudKey: 'shared.bin' })] }),
            makeProject({ id: 'sibling', title: 'Sibling', attachments: [makeFileAttachment({ id: 'a2', cloudKey: 'shared.bin' })] }),
            makeProject({
                id: 'already-purged',
                title: 'Already purged',
                purgedAt: iso,
                attachments: [makeFileAttachment({ id: 'a3', cloudKey: 'already-purged-only.bin' })],
            }),
        ];
        data.tasks = [
            makeTask({ id: 'live-task', title: 'Live', attachments: [makeFileAttachment({ id: 'a4', cloudKey: 'from-task.bin' })] }),
            makeTask({
                id: 'purged-task',
                title: 'Purged',
                purgedAt: iso,
                attachments: [makeFileAttachment({ id: 'a5', cloudKey: 'purged-task-only.bin' })],
            }),
        ];

        const retained = collectRetainedAttachmentCloudKeysForProjectPurge(data, 'purging');


        expect(retained).toEqual(new Set(['shared.bin', 'from-task.bin']));
    });
});

describe('collectPendingRemoteDeletesForProjectPurge', () => {
    test('queues only cloud keys that become unreferenced once the project is purged, deduplicated', () => {
        const purgingProject = makeProject({
            id: 'purging',
            title: 'Purging',
            attachments: [
                makeFileAttachment({ id: 'a1', cloudKey: 'shared.bin', title: 'Shared' }),
                makeFileAttachment({ id: 'a2', cloudKey: 'orphan.bin', title: 'Orphan' }),
                makeFileAttachment({ id: 'a3', cloudKey: 'orphan.bin', title: 'Orphan duplicate' }),
                { id: 'a4', kind: 'link', title: 'Link', uri: 'https://example.com', createdAt: iso, updatedAt: iso },
            ],
        });
        const data = emptyAppData();
        data.projects = [
            purgingProject,
            makeProject({ id: 'sibling', title: 'Sibling', attachments: [makeFileAttachment({ id: 'b1', cloudKey: 'shared.bin' })] }),
        ];

        const pending = collectPendingRemoteDeletesForProjectPurge(purgingProject, data);
        expect(pending).toEqual([{ cloudKey: 'orphan.bin' }]);
    });
});

describe('appendPendingRemoteAttachmentDeletes', () => {
    test('keeps the existing entry on a cloud-key collision and appends genuinely new ones', () => {
        const settings: AppData['settings'] = {
            attachments: {
                pendingRemoteDeletes: [{ cloudKey: 'existing.bin', title: 'Existing', attempts: 2 }],
            },
        };
        const merged = appendPendingRemoteAttachmentDeletes(settings, [
            { cloudKey: 'existing.bin', title: 'Should not override' },
            { cloudKey: 'new.bin', title: 'New' },
        ]);
        expect(merged.attachments?.pendingRemoteDeletes).toEqual([
            { cloudKey: 'existing.bin', title: 'Existing', attempts: 2 },
            { cloudKey: 'new.bin', title: 'New' },
        ]);
    });

    test('returns the same settings reference when there is nothing to append', () => {
        const settings: AppData['settings'] = {};
        expect(appendPendingRemoteAttachmentDeletes(settings, [])).toBe(settings);
    });
});

describe('garbageCollectOrphanAttachments', () => {
    let sandbox = '';

    const withSandbox = (fn: (dataDir: string) => void) => {
        sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-attachment-gc-'));
        try {
            fn(sandbox);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
            sandbox = '';
        }
    };

    test('is a no-op and creates nothing when the namespace has no attachments directory yet', () => {
        withSandbox((dataDir) => {
            const key = 'no-attachments-yet';
            const result = garbageCollectOrphanAttachments(dataDir, key, emptyAppData());
            expect(result).toEqual({ deleted: 0, errors: [], kept: 0, scanned: 0 });
            expect(existsSync(join(dataDir, key))).toBe(false);
        });
    });

    test('refuses to scan through a symlinked attachments root', () => {
        withSandbox((dataDir) => {
            const key = 'symlinked-root';
            const outside = join(dataDir, '..', 'outside-gc');
            mkdirSync(outside, { recursive: true });
            mkdirSync(join(dataDir, key), { recursive: true });
            symlinkSync(outside, join(dataDir, key, 'attachments'), 'dir');

            const result = garbageCollectOrphanAttachments(dataDir, key, emptyAppData());
            expect(result).toEqual({
                deleted: 0,
                errors: ['attachment root is not a normal directory'],
                kept: 0,
                scanned: 0,
            });

            rmSync(outside, { recursive: true, force: true });
        });
    });

    test('deletes only unreferenced files past the GC grace window, keeps referenced and fresh ones, and prunes directories emptied by the deletion', () => {
        withSandbox((dataDir) => {
            const key = 'gc-key';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            mkdirSync(join(attachmentsRoot, 'mixed'), { recursive: true });
            mkdirSync(join(attachmentsRoot, 'stale-only'), { recursive: true });
            mkdirSync(join(attachmentsRoot, 'fresh-only'), { recursive: true });

            const referencedPath = join(attachmentsRoot, 'mixed', 'referenced.bin');
            const staleSiblingPath = join(attachmentsRoot, 'mixed', 'stale-sibling.bin');
            const staleOnlyPath = join(attachmentsRoot, 'stale-only', 'stale.bin');
            const freshOnlyPath = join(attachmentsRoot, 'fresh-only', 'fresh.bin');
            writeFileSync(referencedPath, 'referenced');
            writeFileSync(staleSiblingPath, 'stale-sibling');
            writeFileSync(staleOnlyPath, 'stale');
            writeFileSync(freshOnlyPath, 'fresh');
            expireFile(staleSiblingPath);
            expireFile(staleOnlyPath);


            const data = emptyAppData();
            data.tasks = [makeTask({
                id: 't1',
                title: 'Task',
                attachments: [makeFileAttachment({ id: 'a1', cloudKey: 'mixed/referenced.bin' })],
            })];

            const result = garbageCollectOrphanAttachments(dataDir, key, data);
            expect(result.deleted).toBe(2);
            expect(result.kept).toBe(2);
            expect(result.scanned).toBe(4);
            expect(result.errors).toEqual([]);
            expect(existsSync(referencedPath)).toBe(true);
            expect(existsSync(staleSiblingPath)).toBe(false);
            expect(existsSync(staleOnlyPath)).toBe(false);
            expect(existsSync(freshOnlyPath)).toBe(true);


            expect(existsSync(join(attachmentsRoot, 'mixed'))).toBe(true);
            expect(existsSync(join(attachmentsRoot, 'stale-only'))).toBe(false);
            expect(existsSync(join(attachmentsRoot, 'fresh-only'))).toBe(true);
        });
    });

    test('retains both current and historical nested bytes for a prefixed capture key', () => {
        withSandbox((dataDir) => {
            const key = 'capture-history';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            const currentPath = join(attachmentsRoot, 'recording.m4a');
            const historicalPath = join(attachmentsRoot, 'attachments', 'recording.m4a');
            mkdirSync(join(attachmentsRoot, 'attachments'), { recursive: true });
            writeFileSync(currentPath, 'current recording');
            writeFileSync(historicalPath, 'historical recording');
            expireFile(currentPath);
            expireFile(historicalPath);
            const data = emptyAppData();
            data.tasks = [makeTask({
                id: 'capture-task',
                title: 'Capture',
                attachments: [makeFileAttachment({ id: 'recording', cloudKey: 'attachments/recording.m4a' })],
            })];

            const result = garbageCollectOrphanAttachments(dataDir, key, data);

            expect(result).toEqual({ deleted: 0, errors: [], kept: 2, scanned: 2 });
            expect(existsSync(currentPath)).toBe(true);
            expect(existsSync(historicalPath)).toBe(true);
        });
    });

    test('keeps standard keys on live and restorable owners but deletes purged and explicitly deleted references', () => {
        withSandbox((dataDir) => {
            const key = 'owner-lifecycle';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            mkdirSync(attachmentsRoot, { recursive: true });
            const names = ['live-task.bin', 'trash-task.bin', 'trash-project.bin', 'purged-project.bin', 'deleted-attachment.bin'];
            for (const name of names) {
                const filePath = join(attachmentsRoot, name);
                writeFileSync(filePath, name);
                expireFile(filePath);
            }
            const data = emptyAppData();
            data.tasks = [
                makeTask({ id: 'live', title: 'Live', attachments: [makeFileAttachment({ id: 'a1', cloudKey: 'attachments/live-task.bin' })] }),
                makeTask({ id: 'trash', title: 'Trash', deletedAt: iso, attachments: [makeFileAttachment({ id: 'a2', cloudKey: 'attachments/trash-task.bin' })] }),
            ];
            data.projects = [
                makeProject({ id: 'trash-project', title: 'Trash', deletedAt: iso, attachments: [makeFileAttachment({ id: 'a3', cloudKey: 'attachments/trash-project.bin' })] }),
                makeProject({ id: 'purged', title: 'Purged', purgedAt: iso, attachments: [makeFileAttachment({ id: 'a4', cloudKey: 'attachments/purged-project.bin' })] }),
                makeProject({ id: 'deleted-attachment', title: 'Active', attachments: [makeFileAttachment({ id: 'a5', cloudKey: 'attachments/deleted-attachment.bin', deletedAt: iso })] }),
            ];

            const result = garbageCollectOrphanAttachments(dataDir, key, data);

            expect(result).toEqual({ deleted: 2, errors: [], kept: 3, scanned: 5 });
            for (const name of names.slice(0, 3)) expect(existsSync(join(attachmentsRoot, name))).toBe(true);
            for (const name of names.slice(3)) expect(existsSync(join(attachmentsRoot, name))).toBe(false);
        });
    });

    test('ignores a traversal-shaped stored key and logs retention without a path or namespace', () => {
        withSandbox((dataDir) => {
            const key = 'private-namespace';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            mkdirSync(attachmentsRoot, { recursive: true });
            const retainedPath = join(attachmentsRoot, 'retained.bin');
            const orphanPath = join(attachmentsRoot, 'orphan.bin');
            writeFileSync(retainedPath, 'private attachment bytes');
            writeFileSync(orphanPath, 'orphan');
            expireFile(retainedPath);
            expireFile(orphanPath);
            const data = emptyAppData();
            data.tasks = [makeTask({
                id: 'privacy-fixture',
                title: 'Fixture',
                attachments: [
                    makeFileAttachment({ id: 'retained', cloudKey: 'attachments/retained.bin' }),
                    makeFileAttachment({ id: 'invalid', cloudKey: 'attachments/../orphan.bin' }),
                ],
            })];
            const captured: string[] = [];
            const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
                captured.push(String(chunk));
                return true;
            });
            let result: ReturnType<typeof garbageCollectOrphanAttachments>;
            try {
                result = garbageCollectOrphanAttachments(dataDir, key, data);
            } finally {
                stdoutSpy.mockRestore();
            }

            expect(result).toEqual({ deleted: 1, errors: [], kept: 1, scanned: 2 });
            expect(existsSync(retainedPath)).toBe(true);
            expect(existsSync(orphanPath)).toBe(false);
            const lines = captured.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
            expect(lines).toHaveLength(1);
            expect(lines[0].message).toBe('Referenced attachment files retained during cleanup');
            expect(lines[0].context).toEqual({
                count: 1,
                operation: 'orphan-gc',
                outcome: 'complete',
                releaseCheck: 'v1.3.1/cloud-attachment-gc-retention',
            });
            expect(captured.join('')).not.toContain(key);
            expect(captured.join('')).not.toContain(dataDir);
            expect(captured.join('')).not.toContain('retained.bin');
            expect(captured.join('')).not.toContain('private attachment bytes');
        });
    });


    test('reports a batched directory publish failure without discarding files it already unlinked', () => {
        withSandbox((dataDir) => {
            const key = 'gc-file-durability-failure';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            const stalePath = join(attachmentsRoot, 'mixed', 'stale.bin');
            const retainedPath = join(attachmentsRoot, 'mixed', 'retained.bin');
            mkdirSync(join(attachmentsRoot, 'mixed'), { recursive: true });
            writeFileSync(stalePath, 'stale');
            writeFileSync(retainedPath, 'retained');
            expireFile(stalePath);
            const data = emptyAppData();
            data.tasks = [makeTask({
                id: 'retained-task',
                title: 'Retained',
                attachments: [makeFileAttachment({ id: 'retained', cloudKey: 'mixed/retained.bin' })],
            })];
            const removal = createRemovalFileSystem((stage, path) => (
                stage === 'fsync-parent' && path === join(attachmentsRoot, 'mixed')
            ));

            const result = garbageCollectOrphanAttachments(
                dataDir,
                key,
                data,
                removal.fileSystem,
            );

            expect(result.deleted).toBe(1);
            expect(result.errors).toHaveLength(1);

            expect(result.errors[0]).toBe('mixed: EIO');
            expect(existsSync(stalePath)).toBe(false);
            expect(existsSync(retainedPath)).toBe(true);
        });
    });

    test('re-publishes a directory after a prior batched publish failure, without repeating the earlier deletion', () => {
        withSandbox((dataDir) => {
            const key = 'gc-file-durability-retry';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            const mixedDir = join(attachmentsRoot, 'mixed');
            const stalePath = join(mixedDir, 'stale.bin');
            const retainedPath = join(mixedDir, 'retained.bin');
            mkdirSync(mixedDir, { recursive: true });
            writeFileSync(stalePath, 'stale');
            writeFileSync(retainedPath, 'retained');
            expireFile(stalePath);
            const data = emptyAppData();
            data.tasks = [makeTask({
                id: 'retained-task',
                title: 'Retained',
                attachments: [makeFileAttachment({ id: 'retained', cloudKey: 'mixed/retained.bin' })],
            })];
            let failMixedFsync = true;
            const removal = createRemovalFileSystem((stage, path) => {
                if (stage !== 'fsync-parent' || path !== mixedDir || !failMixedFsync) return false;
                failMixedFsync = false;
                return true;
            });

            const first = garbageCollectOrphanAttachments(dataDir, key, data, removal.fileSystem);
            expect(first.deleted).toBe(1);
            expect(first.errors).toHaveLength(1);
            expect(existsSync(stalePath)).toBe(false);
            expect(existsSync(retainedPath)).toBe(true);
            const retryEventStart = removal.events.length;

            const second = garbageCollectOrphanAttachments(dataDir, key, data, removal.fileSystem);

            expect(second.errors).toEqual([]);
            expect(second.deleted).toBe(0);
            expect(removal.events.slice(retryEventStart)).toContain(`fsync-parent:${mixedDir}`);
        });
    });

    test("reports the attachments root's batched publish failure after pruning an emptied subdirectory", () => {
        withSandbox((dataDir) => {
            const key = 'gc-directory-durability-failure';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            const staleOnlyDir = join(attachmentsRoot, 'stale-only');
            const stalePath = join(staleOnlyDir, 'stale.bin');
            mkdirSync(staleOnlyDir, { recursive: true });
            writeFileSync(stalePath, 'stale');
            expireFile(stalePath);
            const removal = createRemovalFileSystem((stage, path) => (
                stage === 'fsync-parent' && path === attachmentsRoot
            ));

            const result = garbageCollectOrphanAttachments(
                dataDir,
                key,
                emptyAppData(),
                removal.fileSystem,
            );

            expect(result.deleted).toBe(1);
            expect(result.errors).toHaveLength(1);

            expect(result.errors[0]).toBe('.: EIO');
            expect(existsSync(staleOnlyDir)).toBe(false);
        });
    });


    test('reports removal failures by error code, never by the raw fs error message that could carry an absolute path', () => {
        withSandbox((dataDir) => {
            const key = 'gc-path-leak-key';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            const leakyDir = join(attachmentsRoot, 'leaky');
            const stalePath = join(leakyDir, 'stale.bin');
            mkdirSync(leakyDir, { recursive: true });
            writeFileSync(stalePath, 'stale');
            expireFile(stalePath);
            const removalFileSystem: DurableRemovalFileSystem = {
                existsSync,
                unlinkSync: () => {
                    throw Object.assign(
                        new Error(`EACCES: permission denied, unlink '${stalePath}'`),
                        { code: 'EACCES' },
                    );
                },
                rmdirSync,
                openSync: (path) => openSync(path, 'r'),
                fsyncSync,
                closeSync,
            };

            const result = garbageCollectOrphanAttachments(dataDir, key, emptyAppData(), removalFileSystem);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toBe('leaky/stale.bin: EACCES');
            expect(result.errors[0]).not.toContain(dataDir);
            expect(result.errors[0]).not.toContain(stalePath);
            expect(result.errors[0]).not.toContain('permission denied');
        });
    });


    test('fsyncs a directory exactly once per pass no matter how many stale files it removes', () => {
        withSandbox((dataDir) => {
            const key = 'gc-batch-fsync-key';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            const batchDir = join(attachmentsRoot, 'batch');
            mkdirSync(batchDir, { recursive: true });
            const stalePaths = ['a.bin', 'b.bin', 'c.bin'].map((name) => join(batchDir, name));
            for (const stalePath of stalePaths) {
                writeFileSync(stalePath, 'stale');
                expireFile(stalePath);
            }
            const removal = createRemovalFileSystem(() => false);

            const result = garbageCollectOrphanAttachments(dataDir, key, emptyAppData(), removal.fileSystem);

            expect(result.deleted).toBe(3);
            expect(result.errors).toEqual([]);
            const batchDirFsyncs = removal.events.filter((event) => event === `fsync-parent:${batchDir}`);
            expect(batchDirFsyncs).toHaveLength(1);
        });
    });


    test('still fsyncs the directory once when one removal fails and a sibling in the same directory succeeds', () => {
        withSandbox((dataDir) => {
            const key = 'gc-partial-failure-key';
            const attachmentsRoot = join(dataDir, key, 'attachments');
            const mixedDir = join(attachmentsRoot, 'mixed');
            const failingPath = join(mixedDir, 'fails.bin');
            const succeedingPath = join(mixedDir, 'succeeds.bin');
            mkdirSync(mixedDir, { recursive: true });
            writeFileSync(failingPath, 'stale');
            writeFileSync(succeedingPath, 'stale');
            expireFile(failingPath);
            expireFile(succeedingPath);
            const removal = createRemovalFileSystem((stage, path) => stage === 'unlink' && path === failingPath);

            const result = garbageCollectOrphanAttachments(dataDir, key, emptyAppData(), removal.fileSystem);

            expect(result.deleted).toBe(1);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toBe('mixed/fails.bin: EIO');
            expect(existsSync(failingPath)).toBe(true);
            expect(existsSync(succeedingPath)).toBe(false);
            const mixedDirFsyncs = removal.events.filter((event) => event === `fsync-parent:${mixedDir}`);
            expect(mixedDirFsyncs).toHaveLength(1);
        });
    });
});

describe('handleAttachmentPathRequest DELETE', () => {
    test('returns 500 instead of acknowledging a deletion whose parent fsync fails', async () => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-attachment-delete-'));
        try {
            const rootRealPath = join(sandbox, 'attachments');
            const filePath = join(rootRealPath, 'file.bin');
            mkdirSync(rootRealPath, { recursive: true });
            writeFileSync(filePath, 'attachment');
            const removal = createRemovalFileSystem((stage) => stage === 'fsync-parent');

            const response = await handleAttachmentPathRequest(
                new Request('http://localhost/v1/attachments/file.bin', { method: 'DELETE' }),
                '/v1/attachments/file.bin',
                { rootRealPath, filePath },
                {
                    maxAttachmentBytes: 1024,
                    abortSignal: new AbortController().signal,
                    removalFileSystem: removal.fileSystem,
                },
            );

            expect(response.status).toBe(500);
            expect(existsSync(filePath)).toBe(false);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});


describe('handleAttachmentPathRequest HEAD', () => {
    const withSandbox = async (
        run: (paths: { rootRealPath: string; filePath: string }) => Promise<void>,
    ): Promise<void> => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-attachment-head-'));
        try {
            const rootRealPath = join(sandbox, 'attachments');
            mkdirSync(rootRealPath, { recursive: true });
            await run({ rootRealPath, filePath: join(rootRealPath, 'file.bin') });
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    };

    const head = (paths: { rootRealPath: string; filePath: string }) => handleAttachmentPathRequest(
        new Request('http://localhost/v1/attachments/file.bin', { method: 'HEAD' }),
        '/v1/attachments/file.bin',
        paths,
        { maxAttachmentBytes: 1024, abortSignal: new AbortController().signal },
    );

    test('reports a stored attachment with its size and no body', async () => {
        await withSandbox(async (paths) => {
            writeFileSync(paths.filePath, 'attachment');

            const response = await head(paths);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-length')).toBe(String('attachment'.length));
            expect(response.headers.get('content-type')).toBe('application/octet-stream');
            expect(await response.arrayBuffer()).toHaveLength(0);
        });
    });

    test('answers 404 for an attachment that is not there', async () => {
        await withSandbox(async (paths) => {
            const response = await head(paths);
            expect(response.status).toBe(404);
        });
    });

    test('agrees with GET about status and size', async () => {
        await withSandbox(async (paths) => {
            writeFileSync(paths.filePath, 'attachment');
            const getResponse = await handleAttachmentPathRequest(
                new Request('http://localhost/v1/attachments/file.bin'),
                '/v1/attachments/file.bin',
                paths,
                { maxAttachmentBytes: 1024, abortSignal: new AbortController().signal },
            );
            const headResponse = await head(paths);

            expect(headResponse.status).toBe(getResponse.status);
            expect(headResponse.headers.get('content-length'))
                .toBe(String((await getResponse.arrayBuffer()).byteLength));
        });
    });

    test('never leaves the attachment root, even through a symlink', async () => {
        await withSandbox(async (paths) => {
            const outside = join(paths.rootRealPath, '..', 'outside.bin');
            writeFileSync(outside, 'secret');
            symlinkSync(outside, paths.filePath);

            const response = await head(paths);

            expect(response.status).toBe(400);
        });
    });
});

describe('historical capture audio reads', () => {
    const withHistoricalFile = async (
        run: (paths: { sandbox: string; rootRealPath: string; filePath: string; historicalPath: string; dataFilePath: string }) => Promise<void>,
    ): Promise<void> => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-historical-audio-'));
        try {
            const rootRealPath = join(sandbox, 'attachments');
            const filePath = join(rootRealPath, 'recording.m4a');
            const historicalPath = join(rootRealPath, 'attachments', 'recording.m4a');
            const dataFilePath = join(sandbox, 'data.json');
            mkdirSync(join(rootRealPath, 'attachments'), { recursive: true });
            writeFileSync(historicalPath, 'historical bytes');
            await run({ sandbox, rootRealPath, filePath, historicalPath, dataFilePath });
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    };

    const read = (
        method: 'GET' | 'HEAD',
        paths: { rootRealPath: string; filePath: string; dataFilePath: string },
        assertStorageRoot?: () => void,
    ): Promise<Response> => handleAttachmentPathRequest(
        new Request('http://localhost/v1/attachments/recording.m4a', { method }),
        '/v1/attachments/recording.m4a',
        { rootRealPath: paths.rootRealPath, filePath: paths.filePath },
        {
            maxAttachmentBytes: 1024,
            abortSignal: new AbortController().signal,
            historicalDataFilePath: paths.dataFilePath,
            assertStorageRoot,
        },
    );

    const referencedData = (): AppData => {
        const data = emptyAppData();
        data.tasks = [makeTask({
            id: 'historical-task',
            title: 'Capture',
            attachments: [makeFileAttachment({ id: 'recording', cloudKey: 'attachments/recording.m4a' })],
        })];
        return data;
    };

    test('a restorable project can read its historical recording', async () => {
        await withHistoricalFile(async (paths) => {
            const data = emptyAppData();
            data.projects = [makeProject({
                id: 'trashed-project',
                title: 'Restorable',
                deletedAt: iso,
                attachments: [makeFileAttachment({ id: 'recording', cloudKey: 'attachments/recording.m4a' })],
            })];
            writeFileSync(paths.dataFilePath, JSON.stringify(data));

            const get = await read('GET', paths);
            const head = await read('HEAD', paths);
            expect(get.status).toBe(200);
            expect(await get.text()).toBe('historical bytes');
            expect(head.status).toBe(200);
            expect(head.headers.get('content-length')).toBe(String('historical bytes'.length));
            expect(existsSync(paths.historicalPath)).toBe(true);
            expect(existsSync(paths.filePath)).toBe(false);
        });
    });

    test('missing, unrelated, deleted, and purged references cannot authorize a historical read', async () => {
        const cases: Array<[string, AppData]> = [
            ['missing', emptyAppData()],
            ['unrelated', (() => { const data = referencedData(); data.tasks[0].attachments![0].cloudKey = 'attachments/other.m4a'; return data; })()],
            ['deleted attachment', (() => { const data = referencedData(); data.tasks[0].attachments![0].deletedAt = iso; return data; })()],
            ['purged task', (() => { const data = referencedData(); data.tasks[0].purgedAt = iso; return data; })()],
            ['purged project', (() => {
                const data = emptyAppData();
                data.projects = [makeProject({
                    id: 'purged-project', title: 'Purged', purgedAt: iso,
                    attachments: [makeFileAttachment({ id: 'recording', cloudKey: 'attachments/recording.m4a' })],
                })];
                return data;
            })()],
        ];
        for (const [name, data] of cases) {
            await withHistoricalFile(async (paths) => {
                writeFileSync(paths.dataFilePath, JSON.stringify(data));
                const response = await read('GET', paths);
                expect(`${name}: ${response.status}`).toBe(`${name}: 404`);
                expect(existsSync(paths.historicalPath)).toBe(true);
            });
        }
    });

    test('a canonical file wins, including when its directory or broken symlink prevents a read', async () => {
        await withHistoricalFile(async (paths) => {

            writeFileSync(paths.dataFilePath, 'invalid JSON fixture');
            writeFileSync(paths.filePath, 'current bytes');
            const current = await read('GET', paths);
            expect(current.status).toBe(200);
            expect(await current.text()).toBe('current bytes');

            unlinkSync(paths.filePath);
            mkdirSync(paths.filePath);
            expect((await read('GET', paths)).status).toBe(500);
            rmdirSync(paths.filePath);
            symlinkSync(join(paths.rootRealPath, 'missing.m4a'), paths.filePath);
            expect((await read('GET', paths)).status).toBe(500);
            expect(existsSync(paths.historicalPath)).toBe(true);
        });
    });

    test('legacy directory and leaf symlinks are rejected even if they point within the root', async () => {
        for (const targetInsideRoot of [false, true]) {
            await withHistoricalFile(async (paths) => {
                writeFileSync(paths.dataFilePath, JSON.stringify(referencedData()));
                const targetDir = targetInsideRoot
                    ? join(paths.rootRealPath, 'other')
                    : join(paths.sandbox, 'outside');
                mkdirSync(targetDir);
                writeFileSync(join(targetDir, 'recording.m4a'), 'linked bytes');
                const historicalDir = join(paths.rootRealPath, 'attachments');
                unlinkSync(paths.historicalPath);
                rmdirSync(historicalDir);
                symlinkSync(targetDir, historicalDir, 'dir');
                const throughDirectory = await read('GET', paths);
                expect(throughDirectory.status).toBe(400);
                expect(await throughDirectory.text()).not.toContain('linked bytes');

                unlinkSync(historicalDir);
                mkdirSync(historicalDir);
                symlinkSync(join(targetDir, 'recording.m4a'), paths.historicalPath);
                const throughLeaf = await read('GET', paths);
                expect(throughLeaf.status).toBe(400);
                expect(await throughLeaf.text()).not.toContain('linked bytes');
                expect(existsSync(join(targetDir, 'recording.m4a'))).toBe(true);
            });
        }
    });

    test('a malformed resolved path and lost storage authority never read historical bytes', async () => {
        await withHistoricalFile(async (paths) => {
            writeFileSync(paths.dataFilePath, JSON.stringify(referencedData()));
            const malformed = await read('GET', { ...paths, filePath: join(paths.rootRealPath, '..', 'escape.m4a') });
            expect(malformed.status).toBe(404);

            let checks = 0;
            const displaced = `${paths.sandbox}-displaced`;
            const assertStorageRoot = () => {
                checks += 1;
                if (checks === 3) {
                    renameSync(paths.sandbox, displaced);
                    mkdirSync(paths.sandbox);
                    writeFileSync(join(paths.sandbox, 'replacement-sentinel'), 'fresh root');
                    throw new Error('storage root replaced after metadata access');
                }
            };
            try {
                await expect(read('GET', paths, assertStorageRoot)).rejects.toThrow('storage root replaced after metadata access');
                expect(existsSync(join(displaced, 'attachments', 'attachments', 'recording.m4a'))).toBe(true);
                expect(existsSync(join(paths.sandbox, 'attachments', 'attachments', 'recording.m4a'))).toBe(false);
            } finally {
                if (existsSync(displaced)) {
                    rmSync(paths.sandbox, { recursive: true, force: true });
                    renameSync(displaced, paths.sandbox);
                }
            }
        });
    });
});
