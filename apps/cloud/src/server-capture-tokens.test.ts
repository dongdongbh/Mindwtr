import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppData } from '@mindwtr/core';
import { BEARER_TOKEN_PATTERN } from './server-config';
import { startCloudServer } from './server';
import { toRateLimitRoute } from './server-auth';
import { CAPTURE_TOKENS_DIR_NAME, MAX_CAPTURE_TOKENS_PER_NAMESPACE } from './server-capture-tokens';

const OWNER_TOKEN = 'capture-token-owner-test-token-1234567890';
const OTHER_TOKEN = 'capture-token-other-test-token-1234567890';
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const AUDIO_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const BOUNDARY = 'mindwtr-capture-token-test-boundary';

type Harness = { url: string; dataDir: string; stopServer: () => void; stop: () => void };
let harness: Harness;

const startHarness = async (
    allowedAuthTokens: Set<string> | null,
    existingDataDir?: string,
    maxPerWindow?: number,
): Promise<Harness> => {
    const dataDir = existingDataDir ?? mkdtempSync(join(tmpdir(), 'mindwtr-cloud-capture-tokens-'));
    const server = await startCloudServer({ host: '127.0.0.1', port: 0, dataDir, allowedAuthTokens, maxPerWindow });
    return {
        url: `http://127.0.0.1:${server.port}`,
        dataDir,
        stopServer: () => server.stop(),
        stop: () => {
            server.stop();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
};

const createToken = async (owner: string, label?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${harness.url}/v1/capture-tokens`, {
        method: 'POST',
        headers: { ...bearer(owner), 'content-type': 'application/json' },
        body: label === undefined ? '' : JSON.stringify({ label }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const listTokens = async (owner: string): Promise<Response> => fetch(`${harness.url}/v1/capture-tokens`, { headers: bearer(owner) });

const deleteToken = async (owner: string, id: string): Promise<Response> => (
    fetch(`${harness.url}/v1/capture-tokens/${id}`, { method: 'DELETE', headers: bearer(owner) })
);

const postJsonCapture = (token: string, transcription: string): Promise<Response> => fetch(`${harness.url}/v1/capture`, {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify({ transcription }),
});

const postAudioCapture = (token: string, transcription: string): Promise<Response> => {
    const encoder = new TextEncoder();
    const head = encoder.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="transcription"\r\n\r\n${transcription}\r\n`
        + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="audio"; filename="recording.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
    return fetch(`${harness.url}/v1/capture`, {
        method: 'POST',
        headers: { ...bearer(token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        body: new Blob([head, AUDIO_BYTES, tail]),
    });
};

const readData = async (owner: string): Promise<AppData> => {
    const response = await fetch(`${harness.url}/v1/data`, { headers: bearer(owner) });
    return (await response.json()) as AppData;
};

describe('capture-only tokens (allowlist mode)', () => {
    beforeEach(async () => {
        harness = await startHarness(new Set([OWNER_TOKEN, OTHER_TOKEN]));
    });
    afterEach(() => harness.stop());

    test('create → capture JSON and audio as the owner, stored by digest, never in clear', async () => {
        const created = await createToken(OWNER_TOKEN, 'Pebble ring');
        expect(created.status).toBe(201);
        const token = String(created.body.token);
        expect(token.startsWith('mwc_')).toBe(true);
        expect(token).toHaveLength(47);
        expect(BEARER_TOKEN_PATTERN.test(token)).toBe(true);
        expect(String(created.body.label)).toBe('Pebble ring');
        expect(typeof created.body.id).toBe('string');
        expect(typeof created.body.createdAt).toBe('string');

        const tokenFile = join(harness.dataDir, CAPTURE_TOKENS_DIR_NAME, `${sha256(token)}.json`);
        expect(existsSync(tokenFile)).toBe(true);
        const stored = JSON.parse(readFileSync(tokenFile, 'utf8')) as Record<string, unknown>;
        expect(stored).toEqual({
            namespaceKey: sha256(OWNER_TOKEN),
            id: created.body.id,
            label: 'Pebble ring',
            createdAt: created.body.createdAt,
        });
        expect(readFileSync(tokenFile, 'utf8')).not.toContain(token);
        // Allowlist mode creates the account document lazily; token creation reserves it.
        expect(existsSync(join(harness.dataDir, `${sha256(OWNER_TOKEN)}.json`))).toBe(true);
        expect(readdirSync(join(harness.dataDir, CAPTURE_TOKENS_DIR_NAME)).some((name) => name.includes(token))).toBe(false);

        const captured: string[] = [];
        const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            captured.push(String(chunk));
            return true;
        });
        let jsonCapture: Response;
        let audioCapture: Response;
        try {
            jsonCapture = await postJsonCapture(token, 'Buy oat milk');
            audioCapture = await postAudioCapture(token, 'Call the dentist');
        } finally {
            stdoutSpy.mockRestore();
        }
        expect(jsonCapture.status).toBe(201);
        expect(audioCapture.status).toBe(201);
        const audioBody = (await audioCapture.json()) as { attachment: { cloudKey: string } | null };
        expect(audioBody.attachment?.cloudKey).toBeTruthy();

        const data = await readData(OWNER_TOKEN);
        expect(data.tasks.map((task) => task.title).sort()).toEqual(['Buy oat milk', 'Call the dentist']);
        const audioDownload = await fetch(`${harness.url}/v1/${audioBody.attachment!.cloudKey}`, { headers: bearer(OWNER_TOKEN) });
        expect(audioDownload.status).toBe(200);
        expect(new Uint8Array(await audioDownload.arrayBuffer())).toEqual(AUDIO_BYTES);

        const lines = captured.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const accepted = lines.filter((line) => line.message === 'Capture webhook request accepted');
        expect(accepted.map((line) => line.context.tokenScope)).toEqual(['capture', 'capture']);
        expect(captured.join('')).not.toContain(token);
        expect(captured.join('')).not.toContain('Buy oat milk');
    });

    test('a capture token is refused with 403 everywhere except POST /v1/capture', async () => {
        const token = String((await createToken(OWNER_TOKEN)).body.token);
        const attempts: Array<[string, string, RequestInit]> = [
            ['GET', '/v1/data', {}],
            ['POST', '/v1/tasks', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) }],
            ['GET', '/v1/capture-tokens', {}],
            ['POST', '/v1/capture-tokens', { headers: { 'content-type': 'application/json' }, body: '{}' }],
            ['DELETE', '/v1/capture-tokens/some-id', {}],
            ['GET', '/v1/capture', {}],
        ];
        for (const [method, path, init] of attempts) {
            const response = await fetch(`${harness.url}${path}`, {
                ...init,
                method,
                headers: { ...bearer(token), ...((init.headers as Record<string, string> | undefined) ?? {}) },
            });
            expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 403`);
            expect(await response.json()).toEqual({ error: 'Capture-only token' });
        }
        // Nothing above created a namespace for the capture token's own digest.
        expect(existsSync(join(harness.dataDir, `${sha256(token)}.json`))).toBe(false);
    });

    test('list shows id, label and createdAt only, sorted by creation; delete revokes', async () => {
        const first = await createToken(OWNER_TOKEN, 'first');
        const second = await createToken(OWNER_TOKEN, 'second');
        await createToken(OTHER_TOKEN, 'someone else');

        const listed = (await (await listTokens(OWNER_TOKEN)).json()) as { tokens: Array<Record<string, unknown>> };
        expect(listed.tokens.map((item) => Object.keys(item).sort())).toEqual([['createdAt', 'id', 'label'], ['createdAt', 'id', 'label']]);
        expect(listed.tokens.map((item) => item.id).sort()).toEqual([first.body.id, second.body.id].sort());
        const createdAts = listed.tokens.map((item) => String(item.createdAt));
        expect(createdAts).toEqual([...createdAts].sort());

        const token = String(first.body.token);
        expect((await postJsonCapture(token, 'before revoke')).status).toBe(201);

        // Another account's full token cannot revoke it, and it keeps working.
        expect((await deleteToken(OTHER_TOKEN, String(first.body.id))).status).toBe(404);
        expect((await postJsonCapture(token, 'still works')).status).toBe(201);

        expect((await deleteToken(OWNER_TOKEN, String(first.body.id))).status).toBe(204);
        expect((await deleteToken(OWNER_TOKEN, String(first.body.id))).status).toBe(404);
        expect((await postJsonCapture(token, 'after revoke')).status).toBe(401);
        const remaining = (await (await listTokens(OWNER_TOKEN)).json()) as { tokens: Array<Record<string, unknown>> };
        expect(remaining.tokens.map((item) => item.id)).toEqual([second.body.id]);
    });

    test('a capture token dies with its owner: allowlist removal and a deleted namespace', async () => {
        const token = String((await createToken(OWNER_TOKEN)).body.token);
        expect((await postJsonCapture(token, 'ok')).status).toBe(201);

        // Orphan: the owner's namespace document is gone.
        const namespaceFile = join(harness.dataDir, `${sha256(OWNER_TOKEN)}.json`);
        rmSync(namespaceFile);
        rmSync(join(harness.dataDir, sha256(OWNER_TOKEN)), { recursive: true, force: true });
        expect((await postJsonCapture(token, 'orphan')).status).toBe(403);
        expect(existsSync(namespaceFile)).toBe(false);

        // Allowlist: restart with the owner removed; the token file still exists.
        harness.stopServer();
        harness = await startHarness(new Set([OTHER_TOKEN]), harness.dataDir);
        expect(existsSync(join(harness.dataDir, CAPTURE_TOKENS_DIR_NAME, `${sha256(token)}.json`))).toBe(true);
        expect((await postJsonCapture(token, 'unlisted owner')).status).toBe(401);
    });

    test('caps at 20 tokens per account and rejects a bad label', async () => {
        for (let index = 0; index < MAX_CAPTURE_TOKENS_PER_NAMESPACE; index += 1) {
            expect((await createToken(OWNER_TOKEN, `token ${index}`)).status).toBe(201);
        }
        const overflow = await createToken(OWNER_TOKEN, 'one too many');
        expect(overflow.status).toBe(409);
        expect(overflow.body).toEqual({ error: 'Capture token limit reached' });
        // The cap is per account.
        expect((await createToken(OTHER_TOKEN)).status).toBe(201);

        const badLabel = await fetch(`${harness.url}/v1/capture-tokens`, {
            method: 'POST',
            headers: { ...bearer(OTHER_TOKEN), 'content-type': 'application/json' },
            body: JSON.stringify({ label: 42 }),
        });
        expect(badLabel.status).toBe(400);
        const longLabel = await createToken(OTHER_TOKEN, `a\u0000b${'x'.repeat(100)}`);
        expect(longLabel.status).toBe(201);
        expect(String(longLabel.body.label)).toHaveLength(64);
        expect(String(longLabel.body.label).startsWith('a b')).toBe(true);
    });

    test('garbage in the token directory is treated as no token, never a crash', async () => {
        const dir = join(harness.dataDir, CAPTURE_TOKENS_DIR_NAME);
        mkdirSync(dir, { recursive: true });
        const garbageToken = 'mwc_garbage-token-for-the-test-1234567890';
        writeFileSync(join(dir, `${sha256(garbageToken)}.json`), 'not json at all');
        const wrongShape = 'mwc_wrong-shape-token-for-the-test-1234567890';
        writeFileSync(join(dir, `${sha256(wrongShape)}.json`), JSON.stringify({ namespaceKey: 'nope', id: 1 }));
        writeFileSync(join(dir, 'README.txt'), 'hello');

        expect((await postJsonCapture(garbageToken, 'x')).status).toBe(401);
        expect((await postJsonCapture(wrongShape, 'x')).status).toBe(401);
        // Listing and creating still work for a real account with the junk present.
        expect((await listTokens(OWNER_TOKEN)).status).toBe(200);
        expect((await createToken(OWNER_TOKEN)).status).toBe(201);
    });

    test('the delete route shares one rate-limit bucket regardless of id', () => {
        expect(toRateLimitRoute('/v1/capture-tokens/private-id')).toBe('/v1/capture-tokens/:id');
        expect(toRateLimitRoute('/v1/capture-tokens')).toBe('/v1/capture-tokens');
    });

    test('unsupported methods and ids', async () => {
        const patch = await fetch(`${harness.url}/v1/capture-tokens`, { method: 'PATCH', headers: bearer(OWNER_TOKEN) });
        expect(patch.status).toBe(405);
        const getOne = await fetch(`${harness.url}/v1/capture-tokens/abc`, { headers: bearer(OWNER_TOKEN) });
        expect(getOne.status).toBe(405);
        expect((await deleteToken(OWNER_TOKEN, 'a/b')).status).toBe(404);
        const noAuth = await fetch(`${harness.url}/v1/capture-tokens`);
        expect(noAuth.status).toBe(401);
    });
});

describe('capture-only tokens (any-token mode)', () => {
    beforeEach(async () => {
        harness = await startHarness(null);
    });
    afterEach(() => harness.stop());

    test('a brand-new full token can create a capture token before any data write', async () => {
        const freshOwner = 'fresh-any-token-owner-1234567890abcdef';
        expect(existsSync(join(harness.dataDir, `${sha256(freshOwner)}.json`))).toBe(false);
        const created = await createToken(freshOwner, 'first thing');
        expect(created.status).toBe(201);
        // Admission reserved the owner's empty namespace, so the capture token is not an orphan.
        expect(existsSync(join(harness.dataDir, `${sha256(freshOwner)}.json`))).toBe(true);
        expect((await postJsonCapture(String(created.body.token), 'hello')).status).toBe(201);
        expect((await readData(freshOwner)).tasks.map((task) => task.title)).toEqual(['hello']);
        // The capture token never got a namespace of its own.
        expect(existsSync(join(harness.dataDir, `${sha256(String(created.body.token))}.json`))).toBe(false);
    });
});

describe('capture-only tokens (rate limiting)', () => {
    beforeEach(async () => {
        // Two requests per window per bucket, so the third shows which bucket was counted.
        harness = await startHarness(new Set([OWNER_TOKEN, OTHER_TOKEN]), undefined, 2);
    });
    afterEach(() => harness.stop());

    test('a capture token spends its owner account bucket, not one of its own', async () => {
        const token = String((await createToken(OWNER_TOKEN)).body.token);
        // One capture from each token fills the owner's POST /v1/capture bucket...
        expect((await postJsonCapture(OWNER_TOKEN, 'from the full token')).status).toBe(201);
        expect((await postJsonCapture(token, 'from the capture token')).status).toBe(201);
        // ...so the next one is refused whichever token sends it.
        expect((await postJsonCapture(token, 'over the limit')).status).toBe(429);
        expect((await postJsonCapture(OWNER_TOKEN, 'also over the limit')).status).toBe(429);
        // Other routes and other accounts keep their own buckets.
        expect((await listTokens(OWNER_TOKEN)).status).toBe(200);
        expect((await postJsonCapture(OTHER_TOKEN, 'another account')).status).toBe(201);
    });
});
