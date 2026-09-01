import { describe, expect, test } from 'bun:test';
import { dirname } from 'path';
import {
    durablyPublishFile,
    durablyRemoveDirectory,
    durablyRemoveFile,
    ensureDurableDirectory,
    ensureDirectoryWithinRoot,
    ensureWritableDir,
    normalizeAttachmentRelativePath,
    probeExistingWritableDir,
    type DurableDirectoryFileSystem,
    type DurableFileSystem,
    type DurableRemovalFileSystem,
    type WritableDirectoryProbeFileSystem,
} from './server-storage';
import { ATTACHMENT_PATH_MAX_LENGTH, ATTACHMENT_PATH_MAX_SEGMENTS } from './server-config';

type DirectoryFailureStage =
    | 'mkdir'
    | 'verify-directory'
    | 'realpath'
    | 'open-parent'
    | 'fsync-parent'
    | 'close-parent';

type FailureStage =
    | 'open-temp'
    | 'write-temp'
    | 'fsync-temp'
    | 'close-temp'
    | 'rename'
    | 'open-parent'
    | 'fsync-parent'
    | 'close-parent';

type RemovalFailureStage =
    | 'unlink'
    | 'rmdir'
    | 'open-parent'
    | 'fsync-parent'
    | 'close-parent';

function createDurableFileSystem(failureStage?: FailureStage) {
    const events: FailureStage[] = [];
    const files = new Map<string, string>([['/cloud/data.json', 'old']]);
    const handles = new Map<number, { kind: 'temp' | 'parent'; path: string }>();
    let nextHandle = 1;

    const enter = (stage: FailureStage): void => {
        events.push(stage);
        if (failureStage === stage) {
            throw new Error(`injected ${stage} failure`);
        }
    };

    const fileSystem: DurableFileSystem = {
        openSync(path, flags, mode) {
            const kind = flags === 'wx' ? 'temp' : 'parent';
            enter(kind === 'temp' ? 'open-temp' : 'open-parent');
            if (kind === 'temp') {
                expect(mode).toBe(0o600);
                if (files.has(path)) throw new Error('exclusive create collision');
                files.set(path, '');
            } else {
                expect(path).toBe(dirname('/cloud/data.json'));
            }
            const handle = nextHandle++;
            handles.set(handle, { kind, path });
            return handle;
        },
        writeFileSync(handle, data) {
            enter('write-temp');
            const openHandle = handles.get(handle);
            if (!openHandle || openHandle.kind !== 'temp') throw new Error('invalid temp handle');
            files.set(openHandle.path, typeof data === 'string' ? data : new TextDecoder().decode(data));
        },
        fsyncSync(handle) {
            const openHandle = handles.get(handle);
            if (!openHandle) throw new Error('invalid sync handle');
            enter(openHandle.kind === 'temp' ? 'fsync-temp' : 'fsync-parent');
        },
        closeSync(handle) {
            const openHandle = handles.get(handle);
            if (!openHandle) throw new Error('invalid close handle');
            enter(openHandle.kind === 'temp' ? 'close-temp' : 'close-parent');
            handles.delete(handle);
        },
        renameSync(source, destination) {
            enter('rename');
            const contents = files.get(source);
            if (contents === undefined) throw new Error('missing temp file');
            files.set(destination, contents);
            files.delete(source);
        },
        existsSync(path) {
            return files.has(path);
        },
        unlinkSync(path) {
            files.delete(path);
        },
    };

    return { events, fileSystem, files };
}

describe('durablyPublishFile', () => {
    test('syncs the temporary file and parent directory before acknowledging success', () => {
        const harness = createDurableFileSystem();

        expect(durablyPublishFile('/cloud/data.json', 'new', {
            fileSystem: harness.fileSystem,
            tempName: '.data.json.test.tmp',
        })).toBe(true);

        expect(harness.events).toEqual([
            'open-temp',
            'write-temp',
            'fsync-temp',
            'close-temp',
            'rename',
            'open-parent',
            'fsync-parent',
            'close-parent',
        ]);
        expect(harness.files.get('/cloud/data.json')).toBe('new');
        expect([...harness.files.keys()].filter((path) => path.endsWith('.tmp'))).toEqual([]);
    });

    for (const failureStage of [
        'open-temp',
        'write-temp',
        'fsync-temp',
        'close-temp',
        'rename',
        'open-parent',
        'fsync-parent',
        'close-parent',
    ] satisfies FailureStage[]) {
        test(`does not acknowledge success when ${failureStage} fails`, () => {
            const harness = createDurableFileSystem(failureStage);

            expect(() => durablyPublishFile('/cloud/data.json', 'new', {
                fileSystem: harness.fileSystem,
                tempName: '.data.json.test.tmp',
            })).toThrow(`injected ${failureStage} failure`);

            const publicationCompleted = failureStage === 'open-parent'
                || failureStage === 'fsync-parent'
                || failureStage === 'close-parent';
            expect(harness.files.get('/cloud/data.json')).toBe(publicationCompleted ? 'new' : 'old');
            expect([...harness.files.keys()].filter((path) => path.endsWith('.tmp'))).toEqual([]);
        });
    }

    test('aborts and cleans the temp file when the pre-publication safety check fails', () => {
        const harness = createDurableFileSystem();

        expect(durablyPublishFile('/cloud/data.json', 'new', {
            beforeRename: () => false,
            fileSystem: harness.fileSystem,
            tempName: '.data.json.test.tmp',
        })).toBe(false);

        expect(harness.events).toEqual([
            'open-temp',
            'write-temp',
            'fsync-temp',
            'close-temp',
        ]);
        expect(harness.files.get('/cloud/data.json')).toBe('old');
        expect([...harness.files.keys()].filter((path) => path.endsWith('.tmp'))).toEqual([]);
    });
});

function createDurableRemovalFileSystem(
    initialEntries: string[],
    failureStage?: RemovalFailureStage,
    failureCount = Number.POSITIVE_INFINITY,
) {
    const entries = new Set(initialEntries);
    const events: string[] = [];
    const handles = new Map<number, string>();
    let nextHandle = 1;
    let remainingFailures = failureCount;

    const enter = (stage: RemovalFailureStage, path: string): void => {
        events.push(`${stage}:${path}`);
        if (failureStage === stage && remainingFailures > 0) {
            remainingFailures -= 1;
            throw Object.assign(new Error(`injected ${stage} failure`), { code: 'EIO' });
        }
    };

    const fileSystem: DurableRemovalFileSystem = {
        existsSync: (path) => entries.has(path),
        unlinkSync(path) {
            enter('unlink', path);
            entries.delete(path);
        },
        rmdirSync(path) {
            enter('rmdir', path);
            entries.delete(path);
        },
        openSync(path) {
            enter('open-parent', path);
            const handle = nextHandle++;
            handles.set(handle, path);
            return handle;
        },
        fsyncSync(handle) {
            const path = handles.get(handle);
            if (!path) throw new Error('invalid directory handle');
            enter('fsync-parent', path);
        },
        closeSync(handle) {
            const path = handles.get(handle);
            if (!path) throw new Error('invalid directory handle');
            enter('close-parent', path);
            handles.delete(handle);
        },
    };

    return { entries, events, fileSystem };
}

describe('durable attachment removal', () => {
    test('unlinks a file and syncs its parent before acknowledging deletion', () => {
        const harness = createDurableRemovalFileSystem(['/cloud', '/cloud/file.bin']);

        expect(durablyRemoveFile('/cloud/file.bin', harness.fileSystem)).toBe(true);

        expect(harness.events).toEqual([
            'unlink:/cloud/file.bin',
            'open-parent:/cloud',
            'fsync-parent:/cloud',
            'close-parent:/cloud',
        ]);
        expect(harness.entries.has('/cloud/file.bin')).toBe(false);
    });

    test('removes an empty directory and syncs its parent before acknowledging pruning', () => {
        const harness = createDurableRemovalFileSystem(['/cloud', '/cloud/empty']);

        expect(durablyRemoveDirectory('/cloud/empty', harness.fileSystem)).toBe(true);

        expect(harness.events).toEqual([
            'rmdir:/cloud/empty',
            'open-parent:/cloud',
            'fsync-parent:/cloud',
            'close-parent:/cloud',
        ]);
        expect(harness.entries.has('/cloud/empty')).toBe(false);
    });

    test('re-establishes deletion durability on retry after the file is already absent', () => {
        const harness = createDurableRemovalFileSystem(
            ['/cloud', '/cloud/file.bin'],
            'fsync-parent',
            1,
        );

        expect(() => durablyRemoveFile('/cloud/file.bin', harness.fileSystem))
            .toThrow('injected fsync-parent failure');
        expect(harness.entries.has('/cloud/file.bin')).toBe(false);

        expect(durablyRemoveFile('/cloud/file.bin', harness.fileSystem)).toBe(false);
        expect(harness.events).toEqual([
            'unlink:/cloud/file.bin',
            'open-parent:/cloud',
            'fsync-parent:/cloud',
            'close-parent:/cloud',
            'open-parent:/cloud',
            'fsync-parent:/cloud',
            'close-parent:/cloud',
        ]);
    });

    for (const failureStage of [
        'unlink',
        'open-parent',
        'fsync-parent',
        'close-parent',
    ] satisfies RemovalFailureStage[]) {
        test(`does not acknowledge file deletion when ${failureStage} fails`, () => {
            const harness = createDurableRemovalFileSystem(
                ['/cloud', '/cloud/file.bin'],
                failureStage,
            );

            expect(() => durablyRemoveFile('/cloud/file.bin', harness.fileSystem))
                .toThrow(`injected ${failureStage} failure`);
        });
    }

    test('does not acknowledge directory pruning when rmdir fails', () => {
        const harness = createDurableRemovalFileSystem(['/cloud', '/cloud/empty'], 'rmdir');

        expect(() => durablyRemoveDirectory('/cloud/empty', harness.fileSystem))
            .toThrow('injected rmdir failure');
    });
});

function createDurableDirectoryFileSystem(
    initialDirectories: string[],
    failureStage?: DirectoryFailureStage,
    failureCount = Number.POSITIVE_INFINITY,
) {
    const directories = new Set(initialDirectories);
    const createdDirectories = new Set<string>();
    const events: string[] = [];
    const handles = new Map<number, string>();
    let nextHandle = 1;
    let remainingFailures = failureCount;

    const failAt = (stage: DirectoryFailureStage): void => {
        if (failureStage === stage && remainingFailures > 0) {
            remainingFailures -= 1;
            throw Object.assign(new Error(`injected ${stage} failure`), { code: 'EIO' });
        }
    };

    const fileSystem: DurableDirectoryFileSystem = {
        lstatSync(path) {
            if (!directories.has(path)) {
                throw Object.assign(new Error('missing directory'), { code: 'ENOENT' });
            }
            if (createdDirectories.has(path)) failAt('verify-directory');
            return {
                isDirectory: () => true,
                isSymbolicLink: () => false,
            };
        },
        mkdirSync(path) {
            failAt('mkdir');
            events.push(`mkdir:${path}`);
            directories.add(path);
            createdDirectories.add(path);
        },
        realpathSync(path) {
            failAt('realpath');
            if (!directories.has(path)) throw new Error('missing directory');
            return path;
        },
        openSync(path) {
            failAt('open-parent');
            events.push(`open-parent:${path}`);
            const handle = nextHandle++;
            handles.set(handle, path);
            return handle;
        },
        fsyncSync(handle) {
            const path = handles.get(handle);
            if (!path) throw new Error('invalid directory handle');
            failAt('fsync-parent');
            events.push(`fsync-parent:${path}`);
        },
        closeSync(handle) {
            const path = handles.get(handle);
            if (!path) throw new Error('invalid directory handle');
            failAt('close-parent');
            events.push(`close-parent:${path}`);
            handles.delete(handle);
        },
    };

    return { directories, events, fileSystem };
}

describe('ensureDurableDirectory', () => {
    test('durably creates a fresh configured data root from its nearest existing ancestor', () => {
        const harness = createDurableDirectoryFileSystem(['/cloud']);

        expect(ensureDurableDirectory(
            '/cloud/configured/data',
            harness.fileSystem,
        )).toBe('/cloud/configured/data');

        expect(harness.events).toEqual([
            'mkdir:/cloud/configured',
            'open-parent:/cloud',
            'fsync-parent:/cloud',
            'close-parent:/cloud',
            'mkdir:/cloud/configured/data',
            'open-parent:/cloud/configured',
            'fsync-parent:/cloud/configured',
            'close-parent:/cloud/configured',
        ]);
    });

    test('durably creates the first namespace directory entry', () => {
        const harness = createDurableDirectoryFileSystem(['/cloud/data']);

        expect(ensureDurableDirectory(
            '/cloud/data/namespace',
            harness.fileSystem,
        )).toBe('/cloud/data/namespace');

        expect(harness.events).toEqual([
            'mkdir:/cloud/data/namespace',
            'open-parent:/cloud/data',
            'fsync-parent:/cloud/data',
            'close-parent:/cloud/data',
        ]);
    });

    test('durably creates every nested namespace directory entry', () => {
        const harness = createDurableDirectoryFileSystem(['/cloud/data']);

        expect(ensureDurableDirectory(
            '/cloud/data/namespace/attachments/projects/task',
            harness.fileSystem,
        )).toBe('/cloud/data/namespace/attachments/projects/task');

        expect(harness.events).toEqual([
            'mkdir:/cloud/data/namespace',
            'open-parent:/cloud/data',
            'fsync-parent:/cloud/data',
            'close-parent:/cloud/data',
            'mkdir:/cloud/data/namespace/attachments',
            'open-parent:/cloud/data/namespace',
            'fsync-parent:/cloud/data/namespace',
            'close-parent:/cloud/data/namespace',
            'mkdir:/cloud/data/namespace/attachments/projects',
            'open-parent:/cloud/data/namespace/attachments',
            'fsync-parent:/cloud/data/namespace/attachments',
            'close-parent:/cloud/data/namespace/attachments',
            'mkdir:/cloud/data/namespace/attachments/projects/task',
            'open-parent:/cloud/data/namespace/attachments/projects',
            'fsync-parent:/cloud/data/namespace/attachments/projects',
            'close-parent:/cloud/data/namespace/attachments/projects',
        ]);
    });

    // S4: only first creation pays the durability barrier. A retry that finds the
    // target already visible (mkdir succeeded, the earlier parent fsync did not)
    // must not re-sync — see the fast-path comment on ensureDurableDirectory.
    test('does not re-sync an already-visible directory entry on retry after a prior parent fsync failure', () => {
        const harness = createDurableDirectoryFileSystem(['/cloud'], 'fsync-parent', 1);

        expect(() => ensureDurableDirectory(
            '/cloud/data',
            harness.fileSystem,
        )).toThrow('injected fsync-parent failure');
        expect(harness.directories.has('/cloud/data')).toBe(true);

        expect(ensureDurableDirectory(
            '/cloud/data',
            harness.fileSystem,
        )).toBe('/cloud/data');

        expect(harness.events).toEqual([
            'mkdir:/cloud/data',
            'open-parent:/cloud',
            'close-parent:/cloud',
        ]);
    });

    // S4: every lock acquisition and every GET/HEAD /v1/data reaches this same
    // already-durable-directory case. It must be free of filesystem durability
    // calls entirely, not just cheaper than creation.
    test('does not touch the parent at all when the target directory already exists', () => {
        const harness = createDurableDirectoryFileSystem(['/cloud', '/cloud/data']);

        expect(ensureDurableDirectory(
            '/cloud/data',
            harness.fileSystem,
        )).toBe('/cloud/data');

        expect(harness.events).toEqual([]);
    });

    for (const failureStage of [
        'mkdir',
        'verify-directory',
        'realpath',
        'open-parent',
        'fsync-parent',
        'close-parent',
    ] satisfies DirectoryFailureStage[]) {
        test(`does not acknowledge directory durability when ${failureStage} fails`, () => {
            const harness = createDurableDirectoryFileSystem(['/cloud'], failureStage);

            expect(() => ensureDurableDirectory(
                '/cloud/data',
                harness.fileSystem,
            )).toThrow(`injected ${failureStage} failure`);
        });
    }
});

type WritableProbeFailureStage = 'open' | 'write' | 'fsync' | 'close' | 'unlink';

function createWritableDirectoryProbeFileSystem(
    initialFiles: string[] = [],
    failureStage?: WritableProbeFailureStage,
) {
    const events: string[] = [];
    const files = new Set(initialFiles);
    const handles = new Map<number, string>();
    let nextHandle = 1;

    const failAt = (stage: WritableProbeFailureStage): void => {
        if (failureStage === stage) throw new Error(`injected ${stage} failure`);
    };

    const fileSystem: WritableDirectoryProbeFileSystem = {
        openSync(path, flags, mode) {
            events.push(`open:${path}`);
            failAt('open');
            expect(flags).toBe('wx');
            expect(mode).toBe(0o600);
            if (files.has(path)) {
                throw Object.assign(new Error('probe collision'), { code: 'EEXIST' });
            }
            files.add(path);
            const handle = nextHandle++;
            handles.set(handle, path);
            return handle;
        },
        writeFileSync(handle, data) {
            events.push(`write:${handles.get(handle) ?? 'unknown'}`);
            failAt('write');
            expect(data).toBe('ok');
        },
        fsyncSync(handle) {
            events.push(`fsync:${handles.get(handle) ?? 'unknown'}`);
            failAt('fsync');
        },
        closeSync(handle) {
            const path = handles.get(handle) ?? 'unknown';
            events.push(`close:${path}`);
            failAt('close');
            handles.delete(handle);
        },
        unlinkSync(path) {
            events.push(`unlink:${path}`);
            failAt('unlink');
            files.delete(path);
        },
    };

    return { events, files, handles, fileSystem };
}

describe('ensureWritableDir', () => {
    test('uses a unique private probe file for every readiness check and removes it', () => {
        const directoryHarness = createDurableDirectoryFileSystem(['/cloud', '/cloud/data']);
        const probeHarness = createWritableDirectoryProbeFileSystem();
        const probeIds = ['first', 'second'];

        for (const probeId of probeIds) {
            expect(ensureWritableDir('/cloud/data', {
                directoryFileSystem: directoryHarness.fileSystem,
                probeFileSystem: probeHarness.fileSystem,
                createProbeId: () => probeId,
            })).toBe(true);
        }

        expect(probeHarness.events).toEqual([
            'open:/cloud/data/.mindwtr-write-probe-first.tmp',
            'write:/cloud/data/.mindwtr-write-probe-first.tmp',
            'fsync:/cloud/data/.mindwtr-write-probe-first.tmp',
            'close:/cloud/data/.mindwtr-write-probe-first.tmp',
            'unlink:/cloud/data/.mindwtr-write-probe-first.tmp',
            'open:/cloud/data/.mindwtr-write-probe-second.tmp',
            'write:/cloud/data/.mindwtr-write-probe-second.tmp',
            'fsync:/cloud/data/.mindwtr-write-probe-second.tmp',
            'close:/cloud/data/.mindwtr-write-probe-second.tmp',
            'unlink:/cloud/data/.mindwtr-write-probe-second.tmp',
        ]);
        expect([...probeHarness.files]).toEqual([]);
        expect([...probeHarness.handles.keys()]).toEqual([]);
    });

    test('fails closed and cleans its probe when durable sync fails', () => {
        const directoryHarness = createDurableDirectoryFileSystem(['/cloud', '/cloud/data']);
        const probeHarness = createWritableDirectoryProbeFileSystem([], 'fsync');
        const probePath = '/cloud/data/.mindwtr-write-probe-fsync-failed.tmp';

        expect(ensureWritableDir('/cloud/data', {
            directoryFileSystem: directoryHarness.fileSystem,
            probeFileSystem: probeHarness.fileSystem,
            createProbeId: () => 'fsync-failed',
        })).toBe(false);

        expect(probeHarness.events).toEqual([
            `open:${probePath}`,
            `write:${probePath}`,
            `fsync:${probePath}`,
            `close:${probePath}`,
            `unlink:${probePath}`,
        ]);
        expect([...probeHarness.files]).toEqual([]);
        expect([...probeHarness.handles.keys()]).toEqual([]);
    });

    test('cleans its own probe file when the write fails', () => {
        const directoryHarness = createDurableDirectoryFileSystem(['/cloud', '/cloud/data']);
        const probeHarness = createWritableDirectoryProbeFileSystem([], 'write');
        const probePath = '/cloud/data/.mindwtr-write-probe-failed.tmp';

        expect(ensureWritableDir('/cloud/data', {
            directoryFileSystem: directoryHarness.fileSystem,
            probeFileSystem: probeHarness.fileSystem,
            createProbeId: () => 'failed',
        })).toBe(false);

        expect(probeHarness.events).toEqual([
            `open:${probePath}`,
            `write:${probePath}`,
            `close:${probePath}`,
            `unlink:${probePath}`,
        ]);
        expect([...probeHarness.files]).toEqual([]);
        expect([...probeHarness.handles.keys()]).toEqual([]);
    });

    test('never deletes a colliding probe file it did not create', () => {
        const directoryHarness = createDurableDirectoryFileSystem(['/cloud', '/cloud/data']);
        const probePath = '/cloud/data/.mindwtr-write-probe-collision.tmp';
        const probeHarness = createWritableDirectoryProbeFileSystem([probePath]);

        expect(ensureWritableDir('/cloud/data', {
            directoryFileSystem: directoryHarness.fileSystem,
            probeFileSystem: probeHarness.fileSystem,
            createProbeId: () => 'collision',
        })).toBe(false);

        expect(probeHarness.events).toEqual([`open:${probePath}`]);
        expect([...probeHarness.files]).toEqual([probePath]);
    });

    test('fails closed before creating a probe when the configured directory is unsafe', () => {
        const directoryHarness = createDurableDirectoryFileSystem(['/cloud'], 'verify-directory');
        const probeHarness = createWritableDirectoryProbeFileSystem();

        expect(ensureWritableDir('/cloud/data', {
            directoryFileSystem: directoryHarness.fileSystem,
            probeFileSystem: probeHarness.fileSystem,
            createProbeId: () => 'unused',
        })).toBe(false);

        expect(probeHarness.events).toEqual([]);
    });

    test('readiness probe never creates a missing configured directory', () => {
        const directoryHarness = createDurableDirectoryFileSystem(['/cloud']);
        const probeHarness = createWritableDirectoryProbeFileSystem();

        expect(probeExistingWritableDir('/cloud/data', {
            directoryFileSystem: directoryHarness.fileSystem,
            probeFileSystem: probeHarness.fileSystem,
            createProbeId: () => 'unused',
        })).toBe(false);

        expect(directoryHarness.directories.has('/cloud/data')).toBe(false);
        expect(directoryHarness.events).toEqual([]);
        expect(probeHarness.events).toEqual([]);
    });
});

describe('ensureDirectoryWithinRoot', () => {
    test('durably publishes the first attachment directory entry', () => {
        const harness = createDurableDirectoryFileSystem(['/cloud']);

        expect(ensureDirectoryWithinRoot(
            '/cloud',
            '/cloud/namespace',
            true,
            harness.fileSystem,
        )).toBe(true);

        expect(harness.events).toEqual([
            'mkdir:/cloud/namespace',
            'open-parent:/cloud',
            'fsync-parent:/cloud',
            'close-parent:/cloud',
        ]);
    });

    test('durably publishes every nested attachment directory entry', () => {
        const harness = createDurableDirectoryFileSystem([
            '/cloud',
            '/cloud/namespace',
            '/cloud/namespace/attachments',
        ]);

        expect(ensureDirectoryWithinRoot(
            '/cloud/namespace/attachments',
            '/cloud/namespace/attachments/projects/task',
            true,
            harness.fileSystem,
        )).toBe(true);

        expect(harness.events).toEqual([
            'mkdir:/cloud/namespace/attachments/projects',
            'open-parent:/cloud/namespace/attachments',
            'fsync-parent:/cloud/namespace/attachments',
            'close-parent:/cloud/namespace/attachments',
            'mkdir:/cloud/namespace/attachments/projects/task',
            'open-parent:/cloud/namespace/attachments/projects',
            'fsync-parent:/cloud/namespace/attachments/projects',
            'close-parent:/cloud/namespace/attachments/projects',
        ]);
    });
});

describe('normalizeAttachmentRelativePath path bounds (S5)', () => {
    test('accepts a real-shaped cloudKey (attachments/<uuid>.ext)', () => {
        expect(normalizeAttachmentRelativePath('attachments/3fa85f64-5717-4562-b3fc-2c963f66afa6.pdf'))
            .toBe('attachments/3fa85f64-5717-4562-b3fc-2c963f66afa6.pdf');
    });

    test(`accepts exactly ${ATTACHMENT_PATH_MAX_SEGMENTS} segments`, () => {
        const path = Array.from({ length: ATTACHMENT_PATH_MAX_SEGMENTS }, (_, i) => `seg${i}`).join('/');
        expect(normalizeAttachmentRelativePath(path)).toBe(path);
    });

    test(`rejects ${ATTACHMENT_PATH_MAX_SEGMENTS + 1} segments`, () => {
        const path = Array.from({ length: ATTACHMENT_PATH_MAX_SEGMENTS + 1 }, (_, i) => `seg${i}`).join('/');
        expect(normalizeAttachmentRelativePath(path)).toBeNull();
    });

    test(`rejects thousands of segments (the O(depth^2) DoS shape)`, () => {
        const path = Array.from({ length: 5000 }, (_, i) => `s${i}`).join('/');
        expect(normalizeAttachmentRelativePath(path)).toBeNull();
    });

    test(`accepts exactly ${ATTACHMENT_PATH_MAX_LENGTH} characters`, () => {
        const path = `a${'b'.repeat(ATTACHMENT_PATH_MAX_LENGTH - 1)}`;
        expect(path.length).toBe(ATTACHMENT_PATH_MAX_LENGTH);
        expect(normalizeAttachmentRelativePath(path)).toBe(path);
    });

    test(`rejects ${ATTACHMENT_PATH_MAX_LENGTH + 1} characters`, () => {
        const path = `a${'b'.repeat(ATTACHMENT_PATH_MAX_LENGTH)}`;
        expect(path.length).toBe(ATTACHMENT_PATH_MAX_LENGTH + 1);
        expect(normalizeAttachmentRelativePath(path)).toBeNull();
    });
});
