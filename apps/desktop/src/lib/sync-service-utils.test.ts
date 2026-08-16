import { describe, expect, it, vi } from 'vitest';

import { createLocalAttachmentFs } from './sync-service-utils';

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

        expect(await fs.localFileExists(STALE_URI)).toBe(true);
        expect(await fs.readLocalFile(STALE_URI)).toBe(bytes);
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

        expect(await fs.localFileExists('/home/demo/report.pdf')).toBe(false);
        await expect(fs.readLocalFile('/home/demo/report.pdf')).rejects.toThrow();
    });

    it('leaves callers without a managed dir on the recorded path only', async () => {
        const { exists, readFile } = createFs({ [MANAGED_FILE]: new Uint8Array([1]) });
        const fs = createLocalAttachmentFs(vi.fn(), {
            baseDataDir: BASE_DATA_DIR,
            dataBaseDir: 'data',
            exists,
            readFile,
        });

        expect(await fs.localFileExists(STALE_URI)).toBe(false);
    });
});
