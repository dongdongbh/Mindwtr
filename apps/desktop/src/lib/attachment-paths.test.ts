import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    isLocalAttachmentPath,
    normalizeAttachmentPathForUrl,
    resolveAttachmentOpenTarget,
    resolveAttachmentReadPath,
    toAttachmentBrowserUrl,
} from './attachment-paths';

const existsMock = vi.fn<(path: string) => Promise<boolean>>();
const managedDataDirMock = vi.fn<() => Promise<string>>();
vi.mock('@tauri-apps/plugin-fs', () => ({
    exists: (path: string) => existsMock(path),
}));
vi.mock('./managed-paths', () => ({
    getManagedDataDir: () => managedDataDirMock(),
    getManagedPath: async (...segments: string[]) => [await managedDataDirMock(), ...segments].join('/'),
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
        managedDataDirMock.mockReset();
        managedDataDirMock.mockResolvedValue('/new-profile');
    });

    it.each([
        '\\\\host\\share\\report.pdf',
        '//host/share/report.pdf',
        '\\\\?\\UNC\\host\\share\\report.pdf',
        '\\\\.\\C:\\report.pdf',
        'file://host/share/report.pdf',
        'file:////host/share/report.pdf',
        'file:///%2fhost/share/report.pdf',
        'file:///%5c%5chost/share/report.pdf',
        'C:\\report.pdf:payload.cmd',
        'C:\\NUL.pdf',
        'C:\\CON .txt',
        'C:\\report.cmd.\\safe.pdf',
    ])('rejects %s before probing the filesystem', async (uri) => {
        await expect(resolveAttachmentReadPath(uri, 'remote')).rejects.toThrow('Only local file paths');
        expect(existsMock).not.toHaveBeenCalled();
        expect(managedDataDirMock).not.toHaveBeenCalled();
    });

    it('keeps the recorded path whenever it still resolves', async () => {
        existsMock.mockResolvedValue(true);
        expect(await resolveAttachmentReadPath('/old-profile/attachments/a1.pdf', 'a1'))
            .toBe('/old-profile/attachments/a1.pdf');
        expect(existsMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the current managed dir when the recorded path is stale', async () => {


        existsMock.mockImplementation(async (path) => path === '/new-profile/attachments/a1.pdf');
        expect(await resolveAttachmentReadPath('/old-profile/attachments/a1.pdf', 'a1'))
            .toBe('/new-profile/attachments/a1.pdf');
    });

    it('treats an out-of-scope probe error as a miss', async () => {
        existsMock.mockImplementation(async (path) => {
            if (path !== '/new-profile/attachments/a1.pdf') throw new Error('forbidden path');
            return true;
        });
        expect(await resolveAttachmentReadPath('file:///old-profile/attachments/a1.pdf', 'a1'))
            .toBe('/new-profile/attachments/a1.pdf');
    });

    it('leaves a genuinely missing link target alone and never probes remote URLs', async () => {
        existsMock.mockResolvedValue(false);
        expect(await resolveAttachmentReadPath('/home/demo/report.pdf', 'report')).toBe('/home/demo/report.pdf');
        existsMock.mockClear();
        expect(await resolveAttachmentReadPath('https://example.com/file.pdf', 'remote'))
            .toBe('https://example.com/file.pdf');
        expect(existsMock).not.toHaveBeenCalled();
    });

    it('does not reuse a managed file whose name belongs to another attachment', async () => {
        existsMock.mockImplementation(async (path) => path === '/new-profile/attachments/a1.pdf');

        expect(await resolveAttachmentReadPath('/old-profile/attachments/a1.pdf', 'different-id'))
            .toBe('/old-profile/attachments/a1.pdf');
        expect(existsMock).toHaveBeenCalledTimes(1);
    });


    it('re-homes a capture recorded at the flat profile root into the data subfolder', async () => {
        managedDataDirMock.mockResolvedValue('/os-data/mindwtr/data');
        const moved = '/os-data/mindwtr/data/audio-captures/mindwtr-audio-1756-abc.wav';
        existsMock.mockImplementation(async (path) => path === moved);

        expect(await resolveAttachmentReadPath('/os-data/mindwtr/audio-captures/mindwtr-audio-1756-abc.wav', 'attachment-uuid'))
            .toBe(moved);
    });

    it('re-homes a flat-root attachment whose file name is not the attachment id', async () => {
        managedDataDirMock.mockResolvedValue('/os-data/mindwtr/data');
        const moved = '/os-data/mindwtr/data/attachments/report.pdf';
        existsMock.mockImplementation(async (path) => path === moved);

        expect(await resolveAttachmentReadPath('/os-data/mindwtr/attachments/report.pdf', 'attachment-uuid'))
            .toBe(moved);
    });

    it('refuses to re-home a path that escapes the managed data dir', async () => {
        managedDataDirMock.mockResolvedValue('/os-data/mindwtr/data');
        existsMock.mockResolvedValue(false);
        const hostile = '/os-data/mindwtr/attachments/../../../secrets.toml';

        expect(await resolveAttachmentReadPath(hostile, 'attachment-uuid')).toBe(hostile);
        expect(existsMock).toHaveBeenCalledTimes(1);
    });

    it('leaves folders outside the moved set on the recorded path', async () => {
        managedDataDirMock.mockResolvedValue('/os-data/mindwtr/data');
        existsMock.mockResolvedValue(false);
        const pasted = '/os-data/mindwtr/quick-add-images/pasted-1.png';

        expect(await resolveAttachmentReadPath(pasted, 'attachment-uuid')).toBe(pasted);
        expect(existsMock).toHaveBeenCalledTimes(1);
    });
});
