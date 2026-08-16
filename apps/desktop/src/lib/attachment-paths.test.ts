import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    isLocalAttachmentPath,
    normalizeAttachmentPathForUrl,
    resolveAttachmentOpenTarget,
    resolveAttachmentReadPath,
    toAttachmentBrowserUrl,
} from './attachment-paths';

const existsMock = vi.fn<(path: string) => Promise<boolean>>();
vi.mock('@tauri-apps/plugin-fs', () => ({
    exists: (path: string) => existsMock(path),
}));
vi.mock('./managed-paths', () => ({
    getManagedPath: async (...segments: string[]) => ['/new-profile', ...segments].join('/'),
}));

describe('attachment path helpers', () => {
    it('treats file URIs and Windows paths as local attachments', () => {
        expect(isLocalAttachmentPath('file:///C:/Users/demo/Documents/spec.pdf')).toBe(true);
        expect(isLocalAttachmentPath('C:\\Users\\demo\\Documents\\spec.pdf')).toBe(true);
        expect(isLocalAttachmentPath('https://example.com/spec.pdf')).toBe(false);
    });

    it('strips file URIs into native open targets', () => {
        expect(resolveAttachmentOpenTarget('file:///C:/Users/demo/My%20Doc.pdf')).toBe('C:/Users/demo/My Doc.pdf');
        expect(resolveAttachmentOpenTarget('file:///tmp/demo.txt')).toBe('/tmp/demo.txt');
    });

    it('normalizes Windows paths for browser file URLs', () => {
        expect(normalizeAttachmentPathForUrl('C:\\Users\\demo\\file.png')).toBe('C:/Users/demo/file.png');
        expect(toAttachmentBrowserUrl('C:\\Users\\demo\\file.png')).toBe('file:///C:/Users/demo/file.png');
    });

    it('preserves non-file URLs', () => {
        expect(toAttachmentBrowserUrl('https://example.com/file.pdf')).toBe('https://example.com/file.pdf');
    });
});

describe('resolveAttachmentReadPath', () => {
    beforeEach(() => {
        existsMock.mockReset();
    });

    it('keeps the recorded path whenever it still resolves', async () => {
        existsMock.mockResolvedValue(true);
        expect(await resolveAttachmentReadPath('/old-profile/attachments/a1.pdf'))
            .toBe('/old-profile/attachments/a1.pdf');
        expect(existsMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the current managed dir when the recorded path is stale', async () => {
        // #1038: a moved portable profile strands every absolute attachment URI
        // even though the file travelled along inside attachments/.
        existsMock.mockImplementation(async (path) => path === '/new-profile/attachments/a1.pdf');
        expect(await resolveAttachmentReadPath('/old-profile/attachments/a1.pdf'))
            .toBe('/new-profile/attachments/a1.pdf');
    });

    it('treats an out-of-scope probe error as a miss', async () => {
        existsMock.mockImplementation(async (path) => {
            if (path !== '/new-profile/attachments/a1.pdf') throw new Error('forbidden path');
            return true;
        });
        expect(await resolveAttachmentReadPath('file:///old-profile/attachments/a1.pdf'))
            .toBe('/new-profile/attachments/a1.pdf');
    });

    it('leaves a genuinely missing link target alone and never probes remote URLs', async () => {
        existsMock.mockResolvedValue(false);
        expect(await resolveAttachmentReadPath('/home/demo/report.pdf')).toBe('/home/demo/report.pdf');
        existsMock.mockClear();
        expect(await resolveAttachmentReadPath('https://example.com/file.pdf'))
            .toBe('https://example.com/file.pdf');
        expect(existsMock).not.toHaveBeenCalled();
    });
});
