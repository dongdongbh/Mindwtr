import { describe, expect, it, vi } from 'vitest';

import {
    createLocalAttachmentFs,
    createManagedAttachmentSourcePredicate,
    resolveFileBackendPath,
    writeFileSafelyAbsolute,
    yieldToRenderer,
} from './sync-service-utils';

const sourceGuardMocks = vi.hoisted(() => ({
    dataDir: vi.fn(async () => '/os-data'),
    getManagedDataDir: vi.fn(async () => '/os-data/mindwtr'),
    logWarn: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/path', () => ({ dataDir: sourceGuardMocks.dataDir }));
vi.mock('./managed-paths', () => ({ getManagedDataDir: sourceGuardMocks.getManagedDataDir }));
vi.mock('./app-log', () => ({ logWarn: sourceGuardMocks.logWarn }));

const BASE_DATA_DIR = '/os-data';
const MANAGED_DIR = '/new-profile/attachments';
const STALE_URI = '/old-profile/attachments/a1.pdf';
const MANAGED_FILE = `${MANAGED_DIR}/a1.pdf`;

const createFs = (files: Record<string, Uint8Array>) => {
    const exists = vi.fn(async (path: string) => path in files);
    const readFile = vi.fn(async (path: string) => {
        const bytes = files[path];
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
    });
    return { exists, readFile };
};

describe('createLocalAttachmentFs managed-dir fallback', () => {
    it('recovers a stale portable path from the current managed dir', async () => {
        // #1038: moving a portable profile leaves every stored URI pointing at
        // the previous location while the file travelled inside attachments/.
        const bytes = new Uint8Array([1, 2, 3]);
        const { exists, readFile } = createFs({ [MANAGED_FILE]: bytes });
        const logSyncWarning = vi.fn();
        const fs = createLocalAttachmentFs(logSyncWarning, {
            baseDataDir: BASE_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile,
            managedAttachmentsDir: MANAGED_DIR,
        });

        const attachment = { id: 'a1' };
        expect(await fs.localFilePresence(STALE_URI, attachment)).toBe('present');
        expect(await fs.localFileExists(STALE_URI, attachment)).toBe(true);
        expect(await fs.readLocalFile(STALE_URI, attachment)).toBe(bytes);
    });

    it('still reports a genuinely missing file as missing', async () => {
        const { exists, readFile } = createFs({});
        const fs = createLocalAttachmentFs(vi.fn(), {
            baseDataDir: BASE_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile,
            managedAttachmentsDir: MANAGED_DIR,
        });

        const attachment = { id: 'report' };
        expect(await fs.localFilePresence('/home/demo/report.pdf', attachment)).toBe('confirmed-not-found');
        expect(await fs.localFileExists('/home/demo/report.pdf', attachment)).toBe(false);
        await expect(fs.readLocalFile('/home/demo/report.pdf', attachment)).rejects.toThrow();
    });

    it('leaves callers without a managed dir on the recorded path only', async () => {
        const { exists, readFile } = createFs({ [MANAGED_FILE]: new Uint8Array([1]) });
        const fs = createLocalAttachmentFs(vi.fn(), {
            baseDataDir: BASE_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile,
        });

        expect(await fs.localFileExists(STALE_URI, { id: 'a1' })).toBe(false);
    });

    it('does not treat a path that only shares the data-dir prefix as managed', async () => {
        const outsidePath = `${BASE_DATA_DIR}-archive/a1.pdf`;
        const bytes = new Uint8Array([1, 2, 3]);
        const { exists, readFile } = createFs({ [outsidePath]: bytes });
        const fs = createLocalAttachmentFs(vi.fn(), {
            baseDataDir: BASE_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile,
        });

        const attachment = { id: 'a1' };
        expect(await fs.localFileExists(outsidePath, attachment)).toBe(true);
        expect(await fs.readLocalFile(outsidePath, attachment)).toBe(bytes);
        expect(exists).toHaveBeenCalledWith(outsidePath);
        expect(readFile).toHaveBeenCalledWith(outsidePath);
    });

    it('does not fall back to a managed file owned by a different attachment', async () => {
        const { exists, readFile } = createFs({ [MANAGED_FILE]: new Uint8Array([1]) });
        const fs = createLocalAttachmentFs(vi.fn(), {
            baseDataDir: BASE_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile,
            managedAttachmentsDir: MANAGED_DIR,
        });

        expect(await fs.localFileExists(STALE_URI, { id: 'different-id' })).toBe(false);
        await expect(fs.readLocalFile(STALE_URI, { id: 'different-id' })).rejects.toThrow();
        expect(exists).not.toHaveBeenCalledWith(MANAGED_FILE);
    });

    it('uses a successful managed fallback after the recorded-path probe errors', async () => {
        const exists = vi.fn(async (path: string) => {
            if (path === STALE_URI) throw new Error('portable path unavailable');
            return path === MANAGED_FILE;
        });
        const fs = createLocalAttachmentFs(vi.fn(), {
            baseDataDir: BASE_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile: vi.fn(),
            managedAttachmentsDir: MANAGED_DIR,
        });

        await expect(fs.localFilePresence(STALE_URI, { id: 'a1' })).resolves.toBe('present');
    });

    it('reports unreadable when any candidate errors and no fallback proves presence', async () => {
        const exists = vi.fn(async (path: string) => {
            if (path === MANAGED_FILE) throw new Error('managed storage denied');
            return false;
        });
        const fs = createLocalAttachmentFs(vi.fn(), {
            baseDataDir: BASE_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile: vi.fn(),
            managedAttachmentsDir: MANAGED_DIR,
        });

        await expect(fs.localFilePresence(STALE_URI, { id: 'a1' })).resolves.toBe('unreadable');
    });
});

// #1245 moved an installed Windows/macOS profile's managed folders from <root>/
// down into <root>/data/. Unlike the relocated portable profile of #1038 the
// stale path sits INSIDE the OS data dir, the one shape the old fallback skipped:
// presence said "present" while stat and read still failed, which pins the
// attachment as a pending upload and stops every remote write for the device.
describe('createLocalAttachmentFs flat-root fallback after the profile folder move', () => {
    const OS_DATA_DIR = '/Roaming';
    const MOVED_ATTACHMENTS_DIR = '/Roaming/mindwtr/data/attachments';

    const createMovedFs = (files: Record<string, Uint8Array>) => {
        const exists = vi.fn(async (path: string, options?: { baseDir: unknown }) => (
            !options && path in files
        ));
        const readFile = vi.fn(async (path: string, options?: { baseDir: unknown }) => {
            const bytes = options ? undefined : files[path];
            if (!bytes) throw new Error(`missing ${path}`);
            return bytes;
        });
        const stat = vi.fn(async (path: string, options?: { baseDir: unknown }) => {
            const bytes = options ? undefined : files[path];
            if (!bytes) throw new Error(`missing ${path}`);
            return { mtime: new Date(1700000000000), size: bytes.length };
        });
        return { exists, readFile, stat };
    };

    const createMovedAttachmentFs = (files: Record<string, Uint8Array>) => {
        const { exists, readFile, stat } = createMovedFs(files);
        const fs = createLocalAttachmentFs(vi.fn(), {
            baseDataDir: OS_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile,
            stat,
            managedAttachmentsDir: MOVED_ATTACHMENTS_DIR,
        });
        return { fs, exists, readFile, stat };
    };

    it('reads, stats and confirms a stale flat-root attachment that now lives under data/', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const moved = `${MOVED_ATTACHMENTS_DIR}/a1.pdf`;
        const { fs } = createMovedAttachmentFs({ [moved]: bytes });

        const attachment = { id: 'a1' };
        const stale = '/Roaming/mindwtr/attachments/a1.pdf';
        expect(await fs.localFilePresence(stale, attachment)).toBe('present');
        expect(await fs.readLocalFile(stale, attachment)).toBe(bytes);
        expect(await fs.statLocalFile(stale, attachment)).toEqual({ mtimeMs: 1700000000000, size: 3 });
    });

    it('recovers an audio capture whose file name is not the attachment id', async () => {
        const bytes = new Uint8Array([4, 5]);
        const moved = '/Roaming/mindwtr/data/audio-captures/mindwtr-audio-1756-abc.wav';
        const { fs } = createMovedAttachmentFs({ [moved]: bytes });

        const attachment = { id: 'attachment-uuid' };
        const stale = '/Roaming/mindwtr/audio-captures/mindwtr-audio-1756-abc.wav';
        expect(await fs.localFilePresence(stale, attachment)).toBe('present');
        expect(await fs.readLocalFile(stale, attachment)).toBe(bytes);
        expect(await fs.statLocalFile(stale, attachment)).toEqual({ mtimeMs: 1700000000000, size: 2 });
    });

    it('never re-homes a path that escapes the managed data dir', async () => {
        const { fs, exists } = createMovedAttachmentFs({});

        const hostile = '/Roaming/mindwtr/attachments/../../../secrets.toml';
        expect(await fs.localFilePresence(hostile, { id: 'a1' })).toBe('confirmed-not-found');
        expect(exists.mock.calls.every(([path]) => !String(path).includes('secrets.toml') || String(path).includes('..')))
            .toBe(true);
        expect(exists).toHaveBeenCalledTimes(1);
    });

    it('leaves a folder the move did not touch on its recorded path', async () => {
        const pasted = '/Roaming/mindwtr/quick-add-images/pasted-1.png';
        const { fs, exists } = createMovedAttachmentFs({});

        expect(await fs.localFilePresence(pasted, { id: 'a1' })).toBe('confirmed-not-found');
        expect(exists).toHaveBeenCalledTimes(1);
    });
});

// R-1: an attachment `uri` arrives over sync, so the upload guard decides which local
// files a hostile sync store can make this device publish. Only the folders desktop
// ever wrote attachment bytes into may be read, never the OS data folder or config.
describe('createManagedAttachmentSourcePredicate', () => {
    const guardFor = async (osDataDir: string, managedDataDir: string) => {
        sourceGuardMocks.dataDir.mockResolvedValue(osDataDir);
        sourceGuardMocks.getManagedDataDir.mockResolvedValue(managedDataDir);
        sourceGuardMocks.logWarn.mockClear();
        return await createManagedAttachmentSourcePredicate();
    };

    it('refuses secrets.toml and other files of the profile or of other apps (POSIX)', async () => {
        const canUpload = await guardFor('/home/alice/.local/share', '/home/alice/.local/share/mindwtr');
        for (const hostile of [
            '/home/alice/.local/share/mindwtr/config/secrets.toml',
            '/home/alice/.local/share/mindwtr/secrets.toml',
            '/home/alice/.local/share/mindwtr/data/mindwtr.db',
            '/home/alice/.local/share/mindwtr/mindwtr.db',
            '/home/alice/.local/share/keyrings/login.keyring',
            '/home/alice/.local/share/OtherApp/x',
            'file:///home/alice/.local/share/OtherApp/x',
            '/home/alice/.local/share/mindwtr/attachments/../config/secrets.toml',
            '/home/alice/.local/share/mindwtr/attachments-old/x.png',
            '/home/alice/.ssh/id_rsa',
        ]) {
            expect(canUpload(hostile), hostile).toBe(false);
        }
    });

    it('refuses secrets.toml on a migrated Windows profile and other apps under %APPDATA%', async () => {
        const canUpload = await guardFor(
            'C:\\Users\\Alice\\AppData\\Roaming',
            'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\data',
        );
        for (const hostile of [
            'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\config\\secrets.toml',
            'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\secrets.toml',
            'file:///C:/Users/Alice/AppData/Roaming/mindwtr/config/secrets.toml',
            'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\data\\mindwtr.db',
            'C:\\Users\\Alice\\AppData\\Roaming\\OtherApp\\x',
            'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\data\\attachments\\..\\..\\config\\secrets.toml',
        ]) {
            expect(canUpload(hostile), hostile).toBe(false);
        }
    });

    it('allows every folder desktop has written attachment bytes into', async () => {
        // Windows/macOS after #1245: managed dir is <data>/mindwtr/data; files recorded
        // before the move keep their flat-root path, and quick-add-images never moved.
        const migrated = await guardFor(
            'C:\\Users\\Alice\\AppData\\Roaming',
            'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\data',
        );
        for (const root of ['C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\data', 'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr']) {
            for (const dir of ['attachments', 'audio-captures', 'quick-add-images']) {
                const path = `${root}\\${dir}\\file.bin`;
                expect(migrated(path), path).toBe(true);
            }
        }
        expect(migrated('file:///C:/Users/Alice/AppData/Roaming/mindwtr/data/attachments/a1.pdf')).toBe(true);

        // Portable profile (#855): the profile's own folders, plus the installed copy's.
        const portable = await guardFor('/home/alice/.local/share', '/media/usb/Mindwtr/data');
        for (const path of [
            '/media/usb/Mindwtr/data/attachments/a1.pdf',
            '/media/usb/Mindwtr/data/audio-captures/rec.wav',
            '/media/usb/Mindwtr/data/quick-add-images/paste.png',
            '/home/alice/.local/share/mindwtr/attachments/a1.pdf',
        ]) {
            expect(portable(path), path).toBe(true);
        }
        expect(portable('/media/usb/Mindwtr/config/secrets.toml')).toBe(false);
    });

    it('allows the old shared attachment folder in the OS data folder, and nothing else there', async () => {
        // Before 02a9aafa2, sync downloads went to <OS data>/attachments with absolute URIs.
        const canUpload = await guardFor('C:\\Users\\Alice\\AppData\\Roaming', 'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\data');
        const id = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
        expect(canUpload(`C:\\Users\\Alice\\AppData\\Roaming\\attachments\\${id}.pdf`)).toBe(true);
        expect(canUpload(`file:///C:/Users/Alice/AppData/Roaming/attachments/${id}.pdf`)).toBe(true);
        // The folder name is generic: other apps' files there, or anything in a subfolder, stay refused.
        expect(canUpload('C:\\Users\\Alice\\AppData\\Roaming\\attachments\\a1.pdf')).toBe(false);
        expect(canUpload(`C:\\Users\\Alice\\AppData\\Roaming\\attachments\\other\\${id}.pdf`)).toBe(false);
        const linux = await guardFor('/home/alice/.local/share', '/home/alice/.local/share/mindwtr');
        expect(linux(`/home/alice/.local/share/attachments/${id}`)).toBe(true);
        expect(linux('/home/alice/.local/share/attachments/notes.txt')).toBe(false);
        expect(canUpload('C:\\Users\\Alice\\AppData\\Roaming\\audio-captures\\rec.wav')).toBe(false);
        expect(canUpload('C:\\Users\\Alice\\AppData\\Roaming\\secrets.toml')).toBe(false);
        expect(canUpload('C:\\Users\\Alice\\AppData\\Roaming\\attachments\\..\\mindwtr\\config\\secrets.toml')).toBe(false);
    });

    it('compares folders without case on Windows and macOS, with case on Linux', async () => {
        // Windows and macOS file systems ignore case by default, so a stored URI may differ
        // from the managed root only in case (drive letter, user name, folder name).
        const windows = await guardFor('C:\\Users\\Alice\\AppData\\Roaming', 'C:\\Users\\Alice\\AppData\\Roaming\\mindwtr\\data');
        expect(windows('file:///c:/Users/alice/AppData/Roaming/mindwtr/data/attachments/a1.pdf')).toBe(true);
        expect(windows('c:\\users\\alice\\appdata\\roaming\\Mindwtr\\Attachments\\a1.pdf')).toBe(true);
        expect(windows('c:/users/alice/appdata/roaming/MINDWTR/config/secrets.toml')).toBe(false);

        const mac = await guardFor('/Users/Alice/Library/Application Support', '/Users/Alice/Library/Application Support/mindwtr/data');
        expect(mac('/Users/alice/Library/Application Support/Mindwtr/data/Attachments/a1.pdf')).toBe(true);
        expect(mac('/users/alice/library/application support/mindwtr/config/secrets.toml')).toBe(false);

        const linux = await guardFor('/home/alice/.local/share', '/home/alice/.local/share/mindwtr');
        expect(linux('/home/alice/.local/share/mindwtr/attachments/a1.pdf')).toBe(true);
        expect(linux('/home/alice/.local/share/Mindwtr/attachments/a1.pdf')).toBe(false);
        expect(linux('/home/Alice/.local/share/mindwtr/attachments/a1.pdf')).toBe(false);
    });

    it('logs one refusal reason per pass and never the refused path', async () => {
        const canUpload = await guardFor('/os-data', '/os-data/mindwtr');
        canUpload('/os-data/mindwtr/config/secrets.toml');
        canUpload('/os-data/OtherApp/private-name.txt');
        expect(sourceGuardMocks.logWarn).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(sourceGuardMocks.logWarn.mock.calls);
        expect(logged).toContain('v1.3.5/attachment-source-guard');
        expect(logged).not.toContain('secrets');
        expect(logged).not.toContain('os-data');
        expect(canUpload('/os-data/mindwtr/attachments/a1.pdf')).toBe(true);
    });
});

describe('resolveFileBackendPath', () => {
    const join = vi.fn(async (...paths: string[]) => paths.join('/'));

    it('resolves an ordinary cloudKey under the sync folder', async () => {
        await expect(resolveFileBackendPath(join, '/sync', 'attachments/a1.pdf'))
            .resolves.toBe('/sync/attachments/a1.pdf');
    });

    // SEC-08: a cloudKey arrives over sync, so it is attacker-controlled input to a
    // filesystem write/delete. Escaping the sync folder must fail loudly — both callers
    // treat a rejection as a failed transfer, never as a completed one.
    it('refuses a cloudKey that escapes the sync folder', async () => {
        for (const hostile of ['attachments/../../escape.txt', 'attachments\\..\\..\\escape.txt', '../escape.txt', 'attachments/a\0.pdf']) {
            await expect(resolveFileBackendPath(join, '/sync', hostile)).rejects.toThrow(/outside the sync folder|invalid/i);
        }
    });
});

// #1057: attachment downloads must be write-temp-then-rename so a cut connection
// can never leave a truncated file at the real target path that a later sync would
// mistake for new content.
describe('writeFileSafelyAbsolute', () => {
    it('never touches the target path until the temp write has fully succeeded', async () => {
        const target = '/managed/attachments/a1.pdf';
        const previousBytes = new Uint8Array([9, 9, 9]);
        const files = new Map<string, Uint8Array>([[target, previousBytes]]);
        const writeFile = vi.fn(async (path: string, data: Uint8Array) => {
            if (path === target) throw new Error('should never write the target directly on the happy path');
            files.set(path, data);
        });
        const rename = vi.fn(async (from: string, to: string) => {
            files.set(to, files.get(from)!);
            files.delete(from);
        });
        const remove = vi.fn(async (path: string) => { files.delete(path); });

        await writeFileSafelyAbsolute(target, new Uint8Array([1, 2, 3]), { writeFile, rename, remove });

        expect(files.get(target)).toEqual(new Uint8Array([1, 2, 3]));
        // The first writeFile call landed on a temp path, not the target.
        expect(writeFile.mock.calls[0]?.[0]).toMatch(
            /^\/managed\/attachments\/\.mindwtr-attachment-write-[0-9a-z]+-[0-9a-f]{12}\.tmp$/,
        );
    });

    it('a failed temp write leaves the previously-downloaded file completely untouched', async () => {
        const target = '/managed/attachments/a1.pdf';
        const previousBytes = new Uint8Array([9, 9, 9]);
        const files = new Map<string, Uint8Array>([[target, previousBytes]]);
        const tempWriteError = new Error('connection cut mid-download');
        const writeFile = vi.fn(async (path: string, data: Uint8Array) => {
            if (path !== target) throw tempWriteError;
            files.set(path, data);
        });
        const rename = vi.fn();
        const remove = vi.fn();

        await expect(
            writeFileSafelyAbsolute(target, new Uint8Array([1, 2, 3]), { writeFile, rename, remove }),
        ).rejects.toThrow(tempWriteError);

        // The interrupted download never reached the rename step, so the file that
        // was there before this sync pass is exactly as it was — never truncated,
        // never partially overwritten.
        expect(files.get(target)).toEqual(previousBytes);
        expect(rename).not.toHaveBeenCalled();
    });
});

describe('yieldToRenderer', () => {
    it('continues on a timer when a hidden window never delivers an animation frame (#1392)', async () => {
        vi.useFakeTimers();
        const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
        try {
            const result = yieldToRenderer();
            await vi.advanceTimersByTimeAsync(100);
            await expect(result).resolves.toBe('timer');
        } finally {
            raf.mockRestore();
            vi.useRealTimers();
        }
    });

    it('continues at the next frame when one arrives first', async () => {
        const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(0);
            return 1;
        });
        try {
            await expect(yieldToRenderer()).resolves.toBe('frame');
        } finally {
            raf.mockRestore();
        }
    });
});
