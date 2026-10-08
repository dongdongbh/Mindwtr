import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
import {
    createNativeTaskAttachmentPreparation, prepareNativeTaskAttachmentAvailability,
    prepareNativeTaskAttachmentAvailabilityPreflight, type NativeFileChannels,
} from './host-attachments';
import { computeSha256Hex, setSha256HexProvider } from '../../../packages/core/src/attachment-hash';
import { getAttachmentDownloadIdentity, getAttachmentDownloadFileName } from '../../../packages/core/src/mobile-attachment-availability';
import { bytesToBase64 } from '../../../packages/core/src/base64-bytes';
import { defaultSyncCryptoPrimitives, encryptSyncArtifact, SYNC_CRYPTO_DEFAULT_KDF_PARAMS } from '../../../packages/core/src/sync-crypto';
import { createMemoryFileSystem, CACHE, DOCUMENTS, MANAGED } from '../../../packages/core/src/__fixtures__/mobile-attachment-fakes';
import type { Attachment } from '../../../packages/core/src/types';

const AT = '2026-10-07T00:00:00.000Z';
const REQUEST = '00000000-0000-4000-8000-000000000362';
const SESSION = '00000000-0000-4000-8000-000000000363';
const TOKEN = '00000000-0000-4000-8000-000000000364';
const BYTES = new Uint8Array([0, 1, 127, 128, 255]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const attachment = (changes: Partial<Attachment> = {}): Attachment => ({ id: 'baseline362', kind: 'file', title: 'Fixture.txt',
    uri: '', cloudKey: 'attachments/baseline362.txt', localStatus: 'missing', createdAt: AT, updatedAt: AT, ...changes });
const input = (selected = attachment()) => ({ version: 1, taskID: 'task362',
    beforePayloadJSON: JSON.stringify({ version: 2, taskID: 'task362', attachmentsOwned: true,
        attachmentsBase: [selected], attachments: [selected], opaque: { notes: 'Retain 文' } }),
    requestJSON: JSON.stringify({ version: 1, requestId: REQUEST, sessionID: SESSION, generation: 0,
        attachmentId: selected.id, identity: getAttachmentDownloadIdentity(selected) }),
});
const rawConfig = (changes: Record<string, unknown> = {}) => JSON.stringify({ backend: 'webdav',
    url: 'https://synthetic.invalid/dav/data.json', username: 'fixture', allowInsecureHttp: null, encryptionStateJSON: null, ...changes });
const cloudConfig = (changes: Record<string, unknown> = {}) => JSON.stringify({ backend: 'cloud',
    url: 'https://synthetic.invalid/v1/data', provider: null, allowInsecureHttp: 'false', encryptionStateJSON: null, ...changes });
const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; setSha256HexProvider(null); });

const fixture = () => {
    const memory = createMemoryFileSystem();
    const fileCalls: string[] = [], secretCalls: string[] = [], legacyCalls: string[] = [];
    const sources: { metadata: Record<string, unknown>; base64: string }[] = [];
    const requests: { url: string; authorization: string | null }[] = [];
    let wire = BYTES, status = 200, sourceReply = JSON.stringify({ kind: 'prepared-source', sourceToken: TOKEN });
    let secretValue: string | null = 'synthetic-credential', secretFailure: Error | null = null;
    let keyValue: string | null = null;
    let sourceAction = () => {};
    const stableHashes: Uint8Array[] = [];
    setSha256HexProvider((bytes) => { stableHashes.push(bytes.slice()); return digest(bytes); });
    globalThis.fetch = (async (url, init) => {
        requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
        return new Response(wire.slice(), { status });
    }) as typeof fetch;
    const channels: NativeFileChannels = { directories: { document: DOCUMENTS, cache: CACHE },
        files: async (request) => {
            const op = String(request.op), uri = String(request.uri ?? ''); fileCalls.push(op);
            if (op === 'getInfo') return memory.fs.getInfo(uri);
            if (op === 'readBytes') return memory.fs.readBytes(uri);
            throw new Error('Selected preparation attempted a mutation or provider replacement');
        }, installer: async () => { throw new Error('Selected preparation must not install'); },
        deleteNow: () => { throw new Error('Selected preparation must not delete'); },
    };
    const bindings = { rawConfigJSON: rawConfig(), crypto: defaultSyncCryptoPrimitives,
        getLegacyValue: async (name: string) => { legacyCalls.push(name); return 'legacy-credential'; },
        getSecret: async (account: string) => {
            secretCalls.push(account); if (secretFailure) throw secretFailure;
            return account === 'mindwtr_sync_encryption_key_v1' ? keyValue : secretValue;
        },
        prepareSource: (json: string, base64: string) => { sources.push({ metadata: JSON.parse(json), base64 }); sourceAction(); return sourceReply; },
    };
    const run = (selected = attachment(), changes: Record<string, unknown> = {}, signal = new AbortController().signal) =>
        prepareNativeTaskAttachmentAvailability(JSON.stringify({ ...input(selected), rawConfigJSON: rawConfig(changes) }), bindings, channels, signal);
    const runConfig = (captured: string, selected = attachment()) => prepareNativeTaskAttachmentAvailability(
        JSON.stringify({ ...input(selected), rawConfigJSON: captured }), bindings, channels, new AbortController().signal);
    return { memory, fileCalls, secretCalls, legacyCalls, sources, requests, stableHashes, channels, bindings, run, runConfig,
        wire: (bytes: Uint8Array) => { wire = bytes; }, status: (value: number) => { status = value; },
        secret: (value: string | null) => { secretValue = value; }, failure: (value: Error) => { secretFailure = value; },
        key: (value: string | null) => { keyValue = value; }, reply: (value: string) => { sourceReply = value; },
        onSource: (action: () => void) => { sourceAction = action; } };
};

describe('selected Task Download private JS producer', () => {
    it('binds the shared selfhosted endpoint and preserves the original attachment identity', async () => {
        const f = fixture(), selected = attachment({ fileHash: digest(BYTES) });
        const preflight = await prepareNativeTaskAttachmentAvailabilityPreflight(JSON.stringify({ ...input(selected),
            cloudURL: 'https://synthetic.invalid/v1/data/', cloudProvider: null, encryptionStateJSON: null, managedDirectoryURI: MANAGED }));
        expect(preflight.initialURL).toBe('https://synthetic.invalid/v1/attachments/baseline362.txt');
        expect(preflight.attachmentJSON).toBe(JSON.stringify(selected));
        expect((await f.runConfig(cloudConfig(), selected)).status).toBe('prepared');
        expect(f.requests).toEqual([{ url: preflight.initialURL, authorization: 'Bearer synthetic-credential' }]);
        expect(f.secretCalls).toEqual(['mindwtr_cloud_token']); expect(f.legacyCalls).toEqual([]);
        expect(f.sources[0].base64).toBe(bytesToBase64(BYTES)); expect(f.sources[0].metadata.attachmentId).toBe(selected.id);
        expect(f.fileCalls).toEqual(['getInfo']); expect(f.memory.files.size).toBe(0);
    });

    it('reads a missing secure cloud token from legacy without migrating or sharing WebDAV authority', async () => {
        const f = fixture(); f.secret(null);
        expect((await f.runConfig(cloudConfig({ provider: ' selfhosted ' }))).status).toBe('prepared');
        expect(f.secretCalls).toEqual(['mindwtr_cloud_token']); expect(f.legacyCalls).toEqual(['@mindwtr_cloud_token']);
        expect(f.requests[0].authorization).toBe('Bearer legacy-credential'); expect(f.memory.files.size).toBe(0);
    });

    it.each(['dropbox', 'cloudkit', 'file', 'unknown'])('rejects captured unsupported cloud provider %s before IO', async (provider) => {
        const f = fixture(); await expect(f.runConfig(cloudConfig({ provider }))).rejects.toThrow('INVALID_INPUT');
        expect(f.fileCalls).toEqual([]); expect(f.secretCalls).toEqual([]); expect(f.requests).toEqual([]); expect(f.sources).toEqual([]);
        await expect(prepareNativeTaskAttachmentAvailabilityPreflight(JSON.stringify({ ...input(),
            cloudURL: 'https://synthetic.invalid/v1/data', cloudProvider: provider, encryptionStateJSON: null, managedDirectoryURI: MANAGED }))).rejects.toThrow('INVALID_INPUT');
    });

    it.each(['enable', 'disable', 'change-passphrase'])('refuses incomplete cloud transition %s before any IO', async (kind) => {
        const f = fixture(), state = JSON.stringify({ state: 'off', incompleteTransition: kind });
        await expect(prepareNativeTaskAttachmentAvailabilityPreflight(JSON.stringify({ ...input(),
            cloudURL: 'https://synthetic.invalid/v1/data', cloudProvider: 'selfhosted', encryptionStateJSON: state,
            managedDirectoryURI: MANAGED }))).rejects.toThrow('SYNC_ENCRYPTION_TRANSITION_INCOMPLETE');
        await expect(f.runConfig(cloudConfig({ encryptionStateJSON: state }))).rejects.toThrow('SYNC_ENCRYPTION_TRANSITION_INCOMPLETE');
        expect(f.fileCalls).toEqual([]); expect(f.secretCalls).toEqual([]); expect(f.requests).toEqual([]); expect(f.sources).toEqual([]);
    });

    it.each(['enabled', 'remote-encrypted-no-key', 'remote-plaintext', 'off'])('retains complete encryption posture %s for plaintext cloud availability', async (posture) => {
        const f = fixture(); f.key(bytesToBase64(new Uint8Array(32).fill(7)));
        const state = JSON.stringify({ state: posture, discoveredSalt: '01'.repeat(16), discoveredParams: SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
            ...(posture === 'off' ? { partlyEncryptedScope: JSON.stringify(['webdav', 'https://other.invalid', 'synthetic']) } : {}) });
        const captured = cloudConfig({ encryptionStateJSON: state });
        expect((await f.runConfig(captured)).status).toBe('prepared'); expect(f.bindings.rawConfigJSON).toBe(rawConfig());
        expect(f.sources[0].base64).toBe(bytesToBase64(BYTES)); expect(f.sources[0].metadata.sha256).toBe(digest(BYTES));
        expect(f.requests).toHaveLength(1); expect(f.legacyCalls).toEqual([]); expect(f.memory.files.size).toBe(0);
    });

    it('binds the shared endpoint and exact download filename without URI extension fallback', async () => {
        const selected = attachment({ cloudKey: 'attachments/', title: 'No extension', uri: MANAGED + 'old.pdf' });
        const result = await prepareNativeTaskAttachmentAvailabilityPreflight(JSON.stringify({ ...input(selected),
            webdavURL: 'https://synthetic.invalid/dav/DATA.JSON/', managedDirectoryURI: MANAGED }));
        expect(result).toEqual({ version: 1, requestId: REQUEST, attachmentJSON: JSON.stringify(selected),
            initialURL: 'https://synthetic.invalid/dav/attachments/', targetURI: MANAGED + selected.id });
        expect(getAttachmentDownloadFileName(attachment())).toBe('baseline362.txt');
        expect(getAttachmentDownloadFileName(attachment({ cloudKey: 'attachments/', title: 'Fixture.pdf' }))).toBe('baseline362.pdf');
    });

    it.each(['extra', 'request', 'identity', 'payload', 'version', 'directory'])('rejects closed preflight grammar: %s', async (mutation) => {
        const value: Record<string, unknown> = { ...input(), webdavURL: 'https://synthetic.invalid/dav', managedDirectoryURI: MANAGED };
        if (mutation === 'extra') value.extra = true;
        if (mutation === 'request') value.requestJSON = JSON.stringify({ ...JSON.parse(value.requestJSON as string), extra: true });
        if (mutation === 'identity') value.requestJSON = JSON.stringify({ ...JSON.parse(value.requestJSON as string), identity: 'stale' });
        if (mutation === 'payload') value.beforePayloadJSON = '{}';
        if (mutation === 'version') value.version = '1';
        if (mutation === 'directory') value.managedDirectoryURI = 'https://synthetic.invalid/';
        await expect(prepareNativeTaskAttachmentAvailabilityPreflight(JSON.stringify(value))).rejects.toThrow('INVALID_INPUT');
    });

    it('returns prepared bytes and keeps Task metadata, stores and stable SHA provider untouched', async () => {
        const f = fixture(), selected = attachment(), before = JSON.stringify(selected);
        const result = await f.run(selected);
        expect(result).toEqual({ version: 1, requestId: REQUEST, status: 'prepared', attachmentJSON: JSON.stringify({ ...selected,
            uri: MANAGED + 'baseline362.txt', localStatus: 'available', fileHash: digest(BYTES) }), sourceToken: TOKEN, sha256: digest(BYTES), size: BYTES.length });
        expect(f.sources).toEqual([{ metadata: { version: 1, attachmentId: selected.id, targetURI: MANAGED + 'baseline362.txt',
            expectation: { kind: 'absent' }, sha256: digest(BYTES), size: BYTES.length }, base64: bytesToBase64(BYTES) }]);
        expect(f.secretCalls).toEqual(['mindwtr_webdav_password']); expect(f.legacyCalls).toEqual([]);
        expect(f.fileCalls).toEqual(['getInfo']); expect(f.memory.files.size).toBe(0);
        expect(JSON.stringify(selected)).toBe(before); expect(await computeSha256Hex(BYTES)).toBe(digest(BYTES));
        expect(f.stableHashes).toHaveLength(2);
    });

    it.each([null, ''])('uses legacy only for an actual missing secure value: %s', async (value) => {
        const f = fixture(); f.secret(value); await f.run();
        expect(f.legacyCalls).toEqual(value === null ? ['@mindwtr_webdav_password'] : []);
        expect(f.requests[0].authorization).toBe('Basic ' + Buffer.from('fixture:' + (value === null ? 'legacy-credential' : '')).toString('base64'));
    });

    it('propagates secure failure without legacy fallback, HTTP, source or global SHA replacement', async () => {
        const f = fixture(), failure = new Error('synthetic inaccessible item'); f.failure(failure);
        await expect(f.run()).rejects.toBe(failure); expect(f.legacyCalls).toEqual([]);
        expect(f.requests).toEqual([]); expect(f.sources).toEqual([]);
        expect(await computeSha256Hex(BYTES)).toBe(digest(BYTES));
    });

    it.each(['off', null])('refuses unsupported stored backend %s before file/secret/network work', async (backend) => {
        const f = fixture(); expect(await f.run(attachment(), { backend })).toEqual({ version: 1, requestId: REQUEST, status: 'unavailable' });
        expect(f.fileCalls).toEqual([]); expect(f.secretCalls).toEqual([]); expect(f.requests).toEqual([]); expect(f.sources).toEqual([]);
    });

    it('rejects a cloud backend supplied with the WebDAV configuration grammar before IO', async () => {
        const f = fixture(); await expect(f.run(attachment(), { backend: 'cloud' })).rejects.toThrow('INVALID_INPUT');
        expect(f.fileCalls).toEqual([]); expect(f.secretCalls).toEqual([]); expect(f.requests).toEqual([]); expect(f.sources).toEqual([]);
    });

    it('caches secure/fallback reads within one invocation and does not reuse them across factories', async () => {
        const f = fixture(); f.secret(null);
        const selected = createNativeTaskAttachmentPreparation(f.bindings, f.channels);
        await selected.prepareAttachmentAvailableDetailed(attachment());
        await selected.prepareAttachmentAvailableDetailed(attachment()); // second callback is refused; reads remain cached
        expect(f.secretCalls).toEqual(['mindwtr_webdav_password']); expect(f.legacyCalls).toEqual(['@mindwtr_webdav_password']);
        await f.run(); expect(f.secretCalls).toEqual(['mindwtr_webdav_password', 'mindwtr_webdav_password']);
    });

    it('uses verified present bytes as borrowed resolution without HTTP/source', async () => {
        const f = fixture(); f.memory.put(MANAGED + 'baseline362.txt', BYTES);
        const selected = attachment({ fileHash: digest(BYTES) });
        expect((await f.run(selected)).status).toBe('available'); expect(f.sources).toEqual([]); expect(f.requests).toEqual([]);
        expect(f.fileCalls).toEqual(['getInfo', 'readBytes']);
    });

    it('preserves a hashless present target as generation conflict', async () => {
        const f = fixture(); f.memory.put(MANAGED + 'baseline362.txt', BYTES);
        expect(await f.run()).toEqual({ version: 1, requestId: REQUEST, status: 'generation-conflict' });
        expect(f.sources).toEqual([]); expect(f.requests).toEqual([]); expect(f.memory.read(MANAGED + 'baseline362.txt')).toEqual(BYTES);
    });

    it('serializes terminal404 lifecycle removals without an installed/source claim', async () => {
        const f = fixture(); f.status(404); const result = await f.run(attachment({ fileHash: digest(BYTES) }));
        expect(result.status).toBe('unrecoverable'); const resolved = JSON.parse((result as { attachmentJSON: string }).attachmentJSON);
        expect(Object.hasOwn(resolved, 'cloudKey')).toBe(false); expect(Object.hasOwn(resolved, 'fileHash')).toBe(false);
        expect(resolved.localStatus).toBe('missing'); expect(resolved.deletedAt).toBe(resolved.updatedAt); expect(f.sources).toEqual([]);
    });

    it('refuses wrong plaintext integrity before the callback', async () => {
        const f = fixture(); expect((await f.run(attachment({ fileHash: 'a'.repeat(64) }))).status).toBe('unavailable'); expect(f.sources).toEqual([]);
    });

    it.each(['{}', '{', '!MindwtrNativeError:fixed source refusal', JSON.stringify({ kind: 'prepared-source', sourceToken: TOKEN, extra: true })])('never installs after a malformed/refused callback', async (reply) => {
        const f = fixture(); f.reply(reply); expect((await f.run()).status).toBe('unavailable');
        expect(f.fileCalls).toEqual(['getInfo']); expect(f.memory.files.size).toBe(0);
        expect(await computeSha256Hex(BYTES)).toBe(digest(BYTES));
    });

    it('rejects late cancellation after source creation without losing the adapter callback evidence', async () => {
        const f = fixture(), controller = new AbortController(); f.onSource(() => controller.abort(new Error('synthetic cancellation')));
        await expect(f.run(attachment(), {}, controller.signal)).rejects.toThrow('synthetic cancellation');
        expect(f.sources).toHaveLength(1); expect(f.memory.files.size).toBe(0); expect(await computeSha256Hex(BYTES)).toBe(digest(BYTES));
    });

    it('does not hand off when already cancelled', async () => {
        const f = fixture(), controller = new AbortController(); controller.abort();
        await expect(f.run(attachment(), {}, controller.signal)).rejects.toThrow();
        expect(f.secretCalls).toEqual([]); expect(f.fileCalls).toEqual([]); expect(f.sources).toEqual([]);
    });

    it('accepts empty plaintext and bounds the callback at exact8MiB', async () => {
        for (const length of [0, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) {
            const f = fixture(); f.wire(new Uint8Array(length)); const result = await f.run();
            expect(result.status).toBe(length > 8 * 1024 * 1024 ? 'unavailable' : 'prepared');
            expect(f.sources.length).toBe(length > 8 * 1024 * 1024 ? 0 : 1);
            if (f.sources.length) expect(f.sources[0].base64.length).toBe(Math.ceil(length / 3) * 4);
        }
    });

    it('opens already-unlocked ciphertext and hands off only its plaintext digest/bytes', async () => {
        const f = fixture(); const material = { key: new Uint8Array(32).fill(7), salt: new Uint8Array(16).fill(1), params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS };
        f.wire(await encryptSyncArtifact(BYTES, material)); f.key(bytesToBase64(material.key));
        const state = JSON.stringify({ state: 'enabled', discoveredSalt: Buffer.from(material.salt).toString('hex'), discoveredParams: material.params });
        expect((await f.run(attachment(), { encryptionStateJSON: state })).status).toBe('prepared');
        expect(f.sources[0].base64).toBe(bytesToBase64(BYTES)); expect(f.sources[0].metadata.sha256).toBe(digest(BYTES));
        expect(f.secretCalls).toEqual(['mindwtr_webdav_password', 'mindwtr_sync_encryption_key_v1']);
    });

    it.each(['{', JSON.stringify({ state: 'enabled' })])('does not silently treat corrupt or missing material as plaintext', async (state) => {
        const f = fixture(); expect((await f.run(attachment(), { encryptionStateJSON: state })).status).toBe('unavailable'); expect(f.sources).toEqual([]);
    });

    it.each([{ extra: true }, { url: 12 }])('rejects malformed captured configuration before IO without replacing SHA', async (changes) => {
        const f = fixture(); await expect(f.run(attachment(), changes)).rejects.toThrow('INVALID_INPUT');
        expect(f.secretCalls).toEqual([]); expect(f.requests).toEqual([]); expect(f.fileCalls).toEqual([]);
        expect(await computeSha256Hex(BYTES)).toBe(digest(BYTES));
    });

    it('does not pass ciphertext through when no unlocked material is stored', async () => {
        const f = fixture(); const material = { key: new Uint8Array(32).fill(7), salt: new Uint8Array(16).fill(1), params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS };
        f.wire(await encryptSyncArtifact(BYTES, material));
        expect((await f.run()).status).toBe('unavailable'); expect(f.sources).toEqual([]);
        expect(f.secretCalls).toEqual(['mindwtr_webdav_password']);
    });

    it('refuses AES authentication failure without a source or key/credential mutation', async () => {
        const f = fixture(); const material = { key: new Uint8Array(32).fill(7), salt: new Uint8Array(16).fill(1), params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS };
        f.wire(await encryptSyncArtifact(BYTES, material)); f.key(bytesToBase64(new Uint8Array(32).fill(9)));
        const state = JSON.stringify({ state: 'enabled', discoveredSalt: Buffer.from(material.salt).toString('hex'), discoveredParams: material.params });
        expect((await f.run(attachment(), { encryptionStateJSON: state })).status).toBe('unavailable'); expect(f.sources).toEqual([]);
        expect(f.secretCalls).toEqual(['mindwtr_webdav_password', 'mindwtr_sync_encryption_key_v1']);
    });

    it('uses the actual polyfill shared mailbox/body framing and settles a refused body before the next preparation', async () => {
        const built = await build({ stdin: { contents: `
            import { prepareNativeTaskAttachmentAvailability, nativeFileChannels } from './host-attachments';
            import { setSha256HexProvider } from '../../../packages/core/src/attachment-hash';
            import { createHostSyncCrypto } from './host-sync';
            setSha256HexProvider(bytes => globalThis.__mindwtrFileCall({op:'sha256'}, bytes));
            globalThis.runSelected = (json, callback) => prepareNativeTaskAttachmentAvailability(json, {
              getLegacyValue: async key => JSON.parse(globalThis.__mindwtrNative.kvGet(key))[0],
              getSecret: account => globalThis.__mindwtrSyncSecrets.getSecret(account),
              crypto: createHostSyncCrypto(globalThis.__mindwtrCryptoCall), prepareSource: callback,
            }, nativeFileChannels(), new AbortController().signal);
        `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2020' });
        const answers: string[] = [], bodies: string[] = [], calls: string[] = [];
        const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
        let sequence = 0, refused = false;
        const answer = (name: string, value: Record<string, unknown>, body?: string) => {
            const id = `${name}-${++sequence}`; answers.push(JSON.stringify({ id, ...value }));
            if (body !== undefined) bodies.push(body); return id;
        };
        const state: Record<string, any> = { __mindwtrHostPlatform: 'ios', __mindwtrNative: {
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(1)),
            log: () => { throw new Error('Selected path must not log detailed errors'); },
            fileDirectories: () => JSON.stringify({ document: DOCUMENTS, cache: CACHE }),
            fileCall: (json: string) => {
                const request = JSON.parse(json); calls.push(request.op);
                if (request.op === 'getInfo') return answer('file', { value: { exists: false } });
                if (request.op === 'sha256') return answer('file', { value: digest(new Uint8Array(Buffer.from(request.base64, 'base64'))) });
                throw new Error('Unexpected selected raw file operation');
            }, installerCall: () => { throw new Error('No selected installer call'); }, fileAbort: () => {}, fileDeleteNow: () => { throw new Error('No selected delete'); },
            secretCall: (json: string) => {
                const request = JSON.parse(json); expect(request).toEqual({ op: 'get', key: 'mindwtr_webdav_password' });
                calls.push('secret'); return answer('secret', { value: 'synthetic-credential' });
            }, kvGet: () => { throw new Error('Secure hit must not read legacy KV'); },
            netFetch: (json: string) => {
                const request = JSON.parse(json); expect(request.method).toBe('GET');
                expect(request.url).toBe('https://synthetic.invalid/dav/attachments/baseline362.txt');
                expect(new Map(request.headers).get('authorization')).toBe('Basic ' + Buffer.from('fixture:synthetic-credential').toString('base64'));
                calls.push('GET'); return answer('net', { status: 200, url: request.url, headers: [], body: true }, bytesToBase64(bytes));
            }, netAbort: () => {}, ioNext: () => answers.shift() ?? '',
            ioBody: () => { const body = bodies.shift()!; if (!refused) { refused = true; return '!MindwtrNativeError:fixed unavailable'; } return body; },
        } };
        vm.runInNewContext(readFileSync(import.meta.dir + '/host-polyfills.js', 'utf8'), state);
        vm.runInNewContext(built.outputFiles[0].text, state);
        const prepare = async () => {
            let result: any, failure: unknown, done = false;
            state.runSelected(JSON.stringify({ ...input(), rawConfigJSON: rawConfig() }), (metadata: string, base64: string) => {
                expect(JSON.parse(metadata).sha256).toBe(digest(bytes)); expect(Buffer.from(base64, 'base64')).toEqual(Buffer.from(bytes));
                return JSON.stringify({ kind: 'prepared-source', sourceToken: TOKEN });
            }).then((value: unknown) => { result = value; done = true; }, (error: unknown) => { failure = error; done = true; });
            for (let step = 0; step < 200 && !done; step++) { state.__pumpTimers(); await new Promise((resolve) => setTimeout(resolve, 1)); }
            expect(done).toBe(true); if (failure) throw failure; return result;
        };
        expect((await prepare()).status).toBe('unavailable');
        const result = await prepare(); expect(result.status).toBe('prepared'); expect(result.size).toBe(256);
        expect(calls).toEqual(['secret', 'getInfo', 'GET', 'secret', 'getInfo', 'GET', 'sha256']);
        expect(state.__pumpTimers()).toBe(0); expect(answers).toEqual([]); expect(bodies).toEqual([]);
    });
});
