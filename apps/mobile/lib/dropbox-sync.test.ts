import { describe, expect, it } from 'vitest';
import {
    deleteDropboxFile,
    DropboxConflictError,
    DropboxFileNotFoundError,
    DropboxUnauthorizedError,
    downloadDropboxAppData,
    downloadDropboxFile,
    testDropboxAccess,
    uploadDropboxAppData,
    uploadDropboxFile,
} from './dropbox-sync';

const buildResponse = (
    status: number,
    body: string,
    headers: Record<string, string> = {}
): Response => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
    } as Headers,
    text: async () => body,
    json: async () => {
        try {
            return JSON.parse(body);
        } catch {
            return {};
        }
    },
} as unknown as Response);

describe('dropbox-sync', () => {
    it('treats 409 download as first-sync empty remote', async () => {
        const fetcher = async () => buildResponse(409, '{"error_summary":"path/not_found/.."}');
        const result = await downloadDropboxAppData('token', fetcher as typeof fetch);
        expect(result.data).toBeNull();
        expect(result.rev).toBeNull();
    });

    it('downloads and parses app data + rev', async () => {
        const payload = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
        const fetcher = async () => buildResponse(
            200,
            JSON.stringify(payload),
            { 'dropbox-api-result': '{"rev":"0153abc"}' }
        );
        const result = await downloadDropboxAppData('token', fetcher as typeof fetch);
        expect(result.data).toEqual(payload);
        expect(result.rev).toBe('0153abc');
    });

    it('throws conflict error when upload returns 409', async () => {
        const fetcher = async () => buildResponse(409, '{"error":{".tag":"path"}}');
        await expect(
            uploadDropboxAppData('token', { tasks: [], projects: [], sections: [], areas: [], settings: {} }, 'rev-1', fetcher as typeof fetch)
        ).rejects.toBeInstanceOf(DropboxConflictError);
    });

    it('throws conflict error when upload returns nested path/conflict', async () => {
        const fetcher = async () => buildResponse(409, '{"error":{".tag":"path","path":{".tag":"conflict"}}}');
        await expect(
            uploadDropboxAppData('token', { tasks: [], projects: [], sections: [], areas: [], settings: {} }, 'rev-1', fetcher as typeof fetch)
        ).rejects.toBeInstanceOf(DropboxConflictError);
    });

    it('does not classify path/not_found as conflict', async () => {
        const fetcher = async () => buildResponse(409, '{"error":{".tag":"path","path":{".tag":"not_found"}}}');
        await expect(
            uploadDropboxAppData('token', { tasks: [], projects: [], sections: [], areas: [], settings: {} }, 'rev-1', fetcher as typeof fetch)
        ).rejects.toThrow('Dropbox upload failed: HTTP 409');
    });

    it('throws unauthorized error when account probe returns 401', async () => {
        const fetcher = async () => buildResponse(401, '{"error_summary":"expired_access_token/.."}');
        await expect(testDropboxAccess('token', fetcher as typeof fetch)).rejects.toBeInstanceOf(DropboxUnauthorizedError);
    });

    it('accepts 409 metadata response as valid auth for first sync', async () => {
        const fetcher = async () => buildResponse(409, '{"error_summary":"path/not_found/.."}');
        await expect(testDropboxAccess('token', fetcher as typeof fetch)).resolves.toBeUndefined();
    });

    it('throws DropboxFileNotFoundError when attachment download returns 409', async () => {
        const fetcher = async () => buildResponse(409, '{"error_summary":"path/not_found/.."}');
        await expect(downloadDropboxFile('token', '/attachments/a.bin', fetcher as typeof fetch)).rejects.toBeInstanceOf(DropboxFileNotFoundError);
    });

    it('uploads attachment file with overwrite mode', async () => {
        const fetcher = async () => buildResponse(200, '{"rev":"rev-file"}');
        const result = await uploadDropboxFile('token', 'attachments/a.bin', new Uint8Array([1, 2, 3]), 'application/octet-stream', fetcher as typeof fetch);
        expect(result.rev).toBe('rev-file');
    });

    it('uploads attachment files as binary octet-stream regardless of source mime type', async () => {
        let requestInit: RequestInit | undefined;
        const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
            requestInit = init;
            return buildResponse(200, '{"rev":"rev-file"}');
        };

        await uploadDropboxFile('token', 'attachments/a.wav', new Uint8Array([1, 2, 3]), 'audio/wav', fetcher as typeof fetch);

        expect((requestInit?.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    });

    it('treats delete 409 as success', async () => {
        const fetcher = async () => buildResponse(409, '{"error_summary":"path_lookup/not_found/.."}');
        await expect(deleteDropboxFile('token', '/attachments/a.bin', fetcher as typeof fetch)).resolves.toBeUndefined();
    });
});
