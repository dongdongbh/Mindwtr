import { describe, expect, it } from 'vitest';
import { DropboxConflictError, uploadDropboxAppData, uploadDropboxFile } from './dropbox-sync';

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

describe('desktop dropbox-sync conflict parsing', () => {
    const appData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };

    it('treats nested path/conflict as conflict', async () => {
        const fetcher = async () => buildResponse(409, '{"error":{".tag":"path","path":{".tag":"conflict"}}}');
        await expect(uploadDropboxAppData('token', appData, 'rev-1', fetcher as typeof fetch))
            .rejects
            .toBeInstanceOf(DropboxConflictError);
    });

    it('does not treat path/not_found as conflict', async () => {
        const fetcher = async () => buildResponse(409, '{"error":{".tag":"path","path":{".tag":"not_found"}}}');
        await expect(uploadDropboxAppData('token', appData, 'rev-1', fetcher as typeof fetch))
            .rejects
            .toThrow('Dropbox upload failed: HTTP 409');
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
});
