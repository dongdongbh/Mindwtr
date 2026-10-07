import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createRateLimiter } from './server-rate-limit';
import { withNamespace, type ServerConfig } from './server-request';
import { isBodyReadError, readJsonBody } from './server-storage';

const TOKEN = 'admission-body-token-1234567890';

/** A chunked body that never ends on its own; `cancelled` resolves when the reader gives up. */
const endlessChunkedPut = () => {
    let markCancelled: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
    const chunk = new Uint8Array(1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            controller.enqueue(chunk);
        },
        cancel() {
            markCancelled();
        },
    });
    const req = new Request('http://localhost/v1/data', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body,
        duplex: 'half',
    } as RequestInit);
    return { req, cancelled };
};

const within = <T>(promise: Promise<T>, ms: number) => Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
]);

describe('withNamespace body read before admission', () => {
    let dataDir = '';

    afterEach(() => {
        if (dataDir) rmSync(dataDir, { recursive: true, force: true });
        dataDir = '';
    });

    const config = (overrides: Partial<ServerConfig>): ServerConfig => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-admission-'));
        return {
            allowedAuthTokens: null,
            dataDir,
            maxAnyTokenNamespaces: 5,
            rateLimiter: createRateLimiter({ windowMs: 60_000, maxKeys: 100 }),
            maxPerWindow: 100,
            unauthorizedResponse: () => new Response(null, { status: 401 }),
            initializeNamespace: () => undefined,
            runWithNamespaceAdmission: (handler) => handler(),
            readBodyBeforeAdmission: (req, signal) => readJsonBody(req, 10_000, signal),
            ...overrides,
        };
    };

    test('caps a chunked upload while admission is still waiting', async () => {
        let releaseAdmission: () => void = () => undefined;
        const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
        const { req, cancelled } = endlessChunkedPut();
        let handlerBody: unknown;
        const response = withNamespace(req, new URL(req.url), config({
            runWithNamespaceAdmission: async (handler) => {
                await admissionGate;
                return handler();
            },
        }), async (ctx) => {
            handlerBody = await ctx.body;
            return new Response('ok');
        });

        expect(await within(cancelled, 2_000)).toBe(true);
        releaseAdmission();
        expect((await response)?.status).toBe(200);
        expect(isBodyReadError(handlerBody)).toBe(true);
        if (!isBodyReadError(handlerBody)) throw new Error('Expected body read error');
        expect(handlerBody.__mindwtrError.status).toBe(413);
    });

    test('a body read that fails during blocked admission is not an unhandled rejection', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const { req } = endlessChunkedPut();
            const response = await withNamespace(req, new URL(req.url), config({
                runWithNamespaceAdmission: async (handler) => {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    return handler();
                },
                readBodyBeforeAdmission: () => Promise.reject(new Error('stream failed')),
            }), async (ctx) => {
                try {
                    await ctx.body;
                    return new Response('unexpected');
                } catch (error) {
                    return new Response((error as Error).message, { status: 500 });
                }
            });
            expect(response?.status).toBe(500);
            expect(await response?.text()).toBe('stream failed');
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    test('cancels the body read when admission refuses the namespace', async () => {
        const { req, cancelled } = endlessChunkedPut();
        const response = await withNamespace(req, new URL(req.url), config({
            maxAnyTokenNamespaces: 0,
            readBodyBeforeAdmission: (request, signal) => readJsonBody(request, 1_000_000_000, signal),
        }), async () => new Response('unreachable'));

        expect(response?.status).toBe(403);
        expect(await within(cancelled, 2_000)).toBe(true);
    });
});
