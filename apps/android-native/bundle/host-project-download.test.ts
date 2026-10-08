import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { nativeProjectFileAvailabilityInitialURL, prepareNativeProjectFileAvailability, type NativeFileChannels } from './host-attachments';
import { setSha256HexProvider } from '../../../packages/core/src/attachment-hash';
import { defaultSyncCryptoPrimitives } from '../../../packages/core/src/sync-crypto';
import { bytesToBase64 } from '../../../packages/core/src/base64-bytes';
import { createMemoryFileSystem, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';
import type { Attachment } from '../../../packages/core/src/types';

const ID = '40500000-1111-4111-8111-111111111111', REQUEST = '40500000-2222-4222-8222-222222222222';
const TOKEN = '40500000-3333-4333-8333-333333333333', BYTES = new Uint8Array([0, 255, 128, 7]);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; setSha256HexProvider(null); });
const attachment = (changes: Partial<Attachment> = {}): Attachment => ({ id: ID, kind: 'file', title: 'Original.txt', uri: '',
    cloudKey: `attachments/${ID}.txt`, fileHash: hash(BYTES).toUpperCase(), contentRev: 7, localStatus: 'missing',
    createdAt: '2026-10-07T12:00:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z', ...changes });
const fixture = () => {
    const memory = createMemoryFileSystem(), requests: string[] = [], operations: string[] = [], secrets: string[] = [];
    const sources: { metadata: unknown; base64: string }[] = [];
    let wire = BYTES, onSource = () => {};
    setSha256HexProvider((bytes) => hash(bytes));
    globalThis.fetch = (async (url, init) => {
        requests.push(String(url)); expect(init?.method).toBe('GET');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
        return new Response(wire.slice(), { status: 200 });
    }) as typeof fetch;
    const channels: NativeFileChannels = { directories: { document: DOCUMENTS, cache: CACHE },
        files: async (request) => { operations.push(String(request.op)); if (request.op === 'getInfo') return memory.fs.getInfo(String(request.uri)); throw new Error('No raw mutation/read'); },
        installer: async () => { throw new Error('No installer authority'); }, deleteNow: () => { throw new Error('No deletion authority'); } };
    const config = (changes: Record<string, unknown>) => JSON.stringify({ backend: 'cloud', url: 'https://synthetic.invalid/v1/data/', provider: null,
        allowInsecureHttp: 'false', encryptionStateJSON: null, ...changes });
    const bindings = { crypto: defaultSyncCryptoPrimitives,
        getLegacyValue: async () => { throw new Error('Secure hit must not migrate/read legacy'); },
        getSecret: async (account: string) => { secrets.push(account); return 'synthetic-token'; },
        prepareSource: (metadata: string, base64: string) => { sources.push({ metadata: JSON.parse(metadata), base64 }); onSource(); return JSON.stringify({ kind: 'prepared-source', sourceToken: TOKEN }); } };
    const run = (selected = attachment(), changes: Record<string, unknown> = {}, signal = new AbortController().signal, extra: Record<string, unknown> = {}) =>
        prepareNativeProjectFileAvailability(JSON.stringify({ version: 1, requestId: REQUEST, attachmentJSON: JSON.stringify(selected),
            targetURI: `${MANAGED}${ID}.txt`, rawConfigJSON: config(changes), ...extra }), bindings, channels, signal);
    return { memory, requests, operations, secrets, sources, run, wire: (bytes: Uint8Array) => { wire = bytes; }, source: (work: () => void) => { onSource = work; } };
};
describe('private selected Project plaintext producer', () => {
    it('binds the exact shared preflight URL and measured bytes without Task data or publication', async () => {
        const f = fixture(), original = attachment(), captured = JSON.stringify(original);
        expect(await f.run(original)).toEqual({ version: 1, requestId: REQUEST, status: 'prepared', sourceToken: TOKEN, sha256: hash(BYTES), size: BYTES.length });
        expect(f.requests).toEqual([nativeProjectFileAvailabilityInitialURL(captured, 'https://synthetic.invalid/v1/data/')]);
        expect(f.requests).toEqual([`https://synthetic.invalid/v1/attachments/${ID}.txt`]);
        expect(f.secrets).toEqual(['mindwtr_cloud_token']); expect(f.operations).toEqual(['getInfo']);
        expect(f.sources).toEqual([{ metadata: { version: 1, attachmentId: ID, targetURI: `${MANAGED}${ID}.txt`, expectation: { kind: 'absent' }, sha256: hash(BYTES), size: BYTES.length }, base64: bytesToBase64(BYTES) }]);
        expect(JSON.stringify(original)).toBe(captured); expect(f.memory.files.size).toBe(0);
    });
    it.each(['enable', 'disable', 'change-passphrase'])('refuses incomplete %s before proof or GET', async (kind) => {
        const f = fixture(); await expect(f.run(attachment(), { encryptionStateJSON: JSON.stringify({ state: 'off', incompleteTransition: kind }) })).rejects.toThrow('SYNC_ENCRYPTION_TRANSITION_INCOMPLETE');
        expect(f.operations).toEqual([]); expect(f.secrets).toEqual([]); expect(f.requests).toEqual([]); expect(f.sources).toEqual([]);
    });
    it.each([{ provider: 'dropbox' }, { backend: 'webdav' }])('refuses unsupported captured config before IO', async (changes) => {
        const f = fixture(); await expect(f.run(attachment(), changes)).rejects.toThrow(); expect(f.requests).toEqual([]); expect(f.operations).toEqual([]);
    });
    it('refuses a same-URI available selection and extra Task authority before IO', async () => {
        const f = fixture(); await expect(f.run(attachment({ uri: `${MANAGED}${ID}.txt`, localStatus: 'available' }))).rejects.toThrow('INVALID_INPUT');
        await expect(f.run(attachment(), {}, undefined, { taskID: 'fabricated' })).rejects.toThrow('INVALID_INPUT');
        expect(f.operations).toEqual([]); expect(f.requests).toEqual([]);
    });
    it('rejects wrong hash and size before native source creation', async () => {
        const f = fixture(); expect((await f.run(attachment({ fileHash: 'a'.repeat(64) }))).status).toBe('unavailable');
        expect((await f.run(attachment({ size: 1 }))).status).toBe('unavailable'); expect(f.sources).toEqual([]); expect(f.memory.files.size).toBe(0);
    });
    it('retains callback evidence while late cancellation rejects the response', async () => {
        const f = fixture(), controller = new AbortController(); f.source(() => controller.abort(new Error('synthetic cancellation')));
        await expect(f.run(attachment(), {}, controller.signal)).rejects.toThrow('synthetic cancellation');
        expect(f.sources).toHaveLength(1); expect(f.memory.files.size).toBe(0);
    });
});
