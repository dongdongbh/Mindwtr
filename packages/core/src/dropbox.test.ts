import { describe, expect, it } from 'vitest';
import {
    deleteDropboxFileVersioned,
    downloadDropboxAppData,
    downloadDropboxFileVersioned,
    DropboxConflictError,
    uploadDropboxAppData,
    uploadDropboxFileVersioned,
} from './dropbox';
import { deriveSyncKeyMaterial } from './sync-crypto';
import type { AppData } from './types';

const FAST_KDF = { mKib: 8, t: 1, p: 1 };

/** Minimal in-memory fake of the two Dropbox endpoints these functions call, keyed by
 * `path` from the `Dropbox-API-Arg` header — enough to round-trip upload/download. */
function createFakeDropbox() {
    const files = new Map<string, Uint8Array>();
    const fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const arg = JSON.parse((init?.headers as Record<string, string>)['Dropbox-API-Arg']) as { path: string };
        const target = String(url);
        if (target.includes('/download')) {
            const bytes = files.get(arg.path);
            if (!bytes) {
                return { ok: false, status: 409, headers: { get: () => null } as unknown as Headers, text: async () => '' } as Response;
            }
            return {
                ok: true,
                status: 200,
                headers: { get: (name: string) => (name === 'dropbox-api-result' ? JSON.stringify({ rev: 'rev1' }) : null) } as unknown as Headers,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                text: async () => new TextDecoder().decode(bytes),
            } as Response;
        }
        // upload
        const bodyBytes = init!.body instanceof ArrayBuffer
            ? new Uint8Array(init!.body)
            : new TextEncoder().encode(init!.body as string);
        files.set(arg.path, bodyBytes);
        return {
            ok: true,
            status: 200,
            headers: { get: () => null } as unknown as Headers,
            json: async () => ({ rev: 'rev1' }),
            text: async () => '',
        } as Response;
    };
    return { files, fetcher };
}

describe('dropbox sync-document encryption', () => {
    it('encrypts on upload to the .enc path and decrypts on download, leaving the plain path untouched', async () => {
        const { files, fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(1), FAST_KDF);
        const data: AppData = { tasks: [] } as unknown as AppData;

        await uploadDropboxAppData('token', data, null, fetcher, { material });
        expect(files.has('/data.json.enc')).toBe(true);
        expect(files.has('/data.json')).toBe(false);

        const result = await downloadDropboxAppData('token', fetcher, { material });
        expect(result.data).toEqual(data);
    });

    it('off-state path is unchanged: plain JSON at /data.json, no encryption params needed', async () => {
        const { files, fetcher } = createFakeDropbox();
        const data: AppData = { tasks: [] } as unknown as AppData;
        await uploadDropboxAppData('token', data, null, fetcher);
        expect(files.has('/data.json')).toBe(true);
        expect(new TextDecoder().decode(files.get('/data.json')!)).toBe(JSON.stringify(data));
        const result = await downloadDropboxAppData('token', fetcher);
        expect(result.data).toEqual(data);
    });

    it('an off-state device discovers an encrypted-but-plaintext-deleted remote instead of treating it as empty', async () => {
        const { files, fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(2), FAST_KDF);
        await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, null, fetcher, { material });
        expect(files.has('/data.json')).toBe(false); // plain path genuinely gone

        const result = await downloadDropboxAppData('token', fetcher); // no material — this device is 'off'
        expect(result.data).toBeNull();
        expect(result.encryptedNoKey).toBeDefined();
        expect(result.encryptedNoKey!.salt.length).toBe(16);
    });

    // The other direction of the same one-extra-probe rule: a peer disabled encryption, so
    // `/data.json.enc` is gone and `/data.json` is back. "Empty remote" here would push this
    // device's whole store into a fresh generation and fork the two silently.
    it('an enabled device reports a peer-disabled (plaintext-restored) remote instead of treating it as empty', async () => {
        const { files, fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(4), FAST_KDF);
        await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, null, fetcher); // the peer's plaintext write
        expect(files.has('/data.json.enc')).toBe(false);

        const result = await downloadDropboxAppData('token', fetcher, { material });
        expect(result.data).toBeNull();
        expect(result.remotePlaintext).toBe(true);
    });

    it('an enabled device still reports an empty remote when neither path exists', async () => {
        const { fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(5), FAST_KDF);
        const result = await downloadDropboxAppData('token', fetcher, { material });
        expect(result.data).toBeNull();
        expect(result.remotePlaintext).toBeUndefined();
    });

    it('a wrong key fails closed on download instead of returning garbage', async () => {
        const { fetcher } = createFakeDropbox();
        const material = await deriveSyncKeyMaterial('pw', new Uint8Array(16).fill(3), FAST_KDF);
        await uploadDropboxAppData('token', { tasks: [] } as unknown as AppData, null, fetcher, { material });
        const wrongMaterial = await deriveSyncKeyMaterial('other-pw', material.salt, FAST_KDF);
        await expect(downloadDropboxAppData('token', fetcher, { material: wrongMaterial })).rejects.toThrow();
    });
});

describe('versioned Dropbox transition byte operations', () => {
    it('returns bytes and revision from the same download response', async () => {
        const result = await downloadDropboxFileVersioned('token', '/attachments/a.bin', async () => (
            new Response(new Uint8Array([1, 2]), {
                status: 200,
                headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'abc123456' }) },
            })
        ));
        expect(result).toEqual({ bytes: new Uint8Array([1, 2]), version: 'abc123456' });
    });

    it('uses add for create and update(rev) for replacement', async () => {
        const args: unknown[] = [];
        const fetcher = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
            args.push(JSON.parse(new Headers(init?.headers).get('dropbox-api-arg') ?? '{}'));
            return Response.json({ rev: 'next-rev' });
        };
        await uploadDropboxFileVersioned('token', '/a.bin', new Uint8Array([1]), null, fetcher);
        await uploadDropboxFileVersioned('token', '/a.bin', new Uint8Array([2]), 'old-rev', fetcher);
        expect(args).toEqual([
            expect.objectContaining({ mode: { '.tag': 'add' }, autorename: false, strict_conflict: true }),
            expect.objectContaining({ mode: { '.tag': 'update', update: 'old-rev' }, autorename: false, strict_conflict: true }),
        ]);
    });

    it('sends parent_rev on delete and maps stale revisions to conflict', async () => {
        let body: unknown;
        const fetcher = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
            body = JSON.parse(String(init?.body));
            return new Response(null, { status: 409 });
        };
        await expect(deleteDropboxFileVersioned('token', '/a.bin', 'old-rev', fetcher))
            .rejects.toBeInstanceOf(DropboxConflictError);
        expect(body).toEqual({ path: '/a.bin', parent_rev: 'old-rev' });
    });
});
