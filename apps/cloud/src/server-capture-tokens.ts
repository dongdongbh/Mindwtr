import { randomBytes } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { generateUUID } from '@mindwtr/core';
import { tokenToKey } from './server-auth';
import { errorResponse, jsonResponse, logInfo } from './server-config';
import {
    durablyPublishFile,
    durablyRemoveFile,
    ensureDurableDirectory,
    isBodyReadError,
    readJsonBody,
} from './server-storage';

/**
 * Capture-only tokens (#1178): a second secret for an account that the server
 * accepts on POST /v1/capture and nowhere else. One file per token under
 * `<dataDir>/capture-tokens/<sha256hex(token)>.json`; the clear token is shown
 * once at creation and never stored or logged.
 */
export const CAPTURE_TOKENS_DIR_NAME = 'capture-tokens';
export const CAPTURE_TOKENS_ROUTE_PATH = '/v1/capture-tokens';
export const MAX_CAPTURE_TOKENS_PER_NAMESPACE = 20;
const MAX_CAPTURE_TOKEN_LABEL_LENGTH = 64;
const CAPTURE_TOKEN_PREFIX = 'mwc_';
const CAPTURE_TOKEN_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const NAMESPACE_KEY_PATTERN = /^[a-f0-9]{64}$/;

export type CaptureTokenRecord = {
    namespaceKey: string;
    id: string;
    label: string;
    createdAt: string;
};

export type TokenScope = 'full' | 'capture';

const captureTokensDir = (dataDir: string): string => join(dataDir, CAPTURE_TOKENS_DIR_NAME);

/** Parses one token file. Anything that is not the exact stored shape is treated
 *  as absent: a hand-edited or foreign file must never crash auth or grant access. */
function readCaptureTokenFile(filePath: string): CaptureTokenRecord | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.namespaceKey !== 'string' || !NAMESPACE_KEY_PATTERN.test(record.namespaceKey)) return null;
    if (typeof record.id !== 'string' || !record.id) return null;
    if (typeof record.createdAt !== 'string' || !record.createdAt) return null;
    return {
        namespaceKey: record.namespaceKey,
        id: record.id,
        label: typeof record.label === 'string' ? record.label : '',
        createdAt: record.createdAt,
    };
}

/** One `existsSync` plus one small read, keyed by the token digest. Full-token
 *  requests pay only the `existsSync`. */
export function lookupCaptureToken(dataDir: string, token: string): CaptureTokenRecord | null {
    const filePath = join(captureTokensDir(dataDir), `${tokenToKey(token)}.json`);
    if (!existsSync(filePath)) return null;
    return readCaptureTokenFile(filePath);
}

/** Every token file that belongs to `namespaceKey`, with its path. Bounded by the
 *  directory size, which the per-namespace cap keeps small on a self-hosted server. */
function listNamespaceTokenFiles(dataDir: string, namespaceKey: string): Array<{ filePath: string; record: CaptureTokenRecord }> {
    const dir = captureTokensDir(dataDir);
    if (!existsSync(dir)) return [];
    const entries: Array<{ filePath: string; record: CaptureTokenRecord }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !CAPTURE_TOKEN_FILE_PATTERN.test(entry.name)) continue;
        const filePath = join(dir, entry.name);
        const record = readCaptureTokenFile(filePath);
        if (record && record.namespaceKey === namespaceKey) entries.push({ filePath, record });
    }
    return entries.sort((a, b) => (
        a.record.createdAt.localeCompare(b.record.createdAt) || a.record.id.localeCompare(b.record.id)
    ));
}

const publicView = (record: CaptureTokenRecord) => ({
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
});

/** `mwc_` + 43 base64url characters from 32 random bytes; passes BEARER_TOKEN_PATTERN. */
const generateCaptureToken = (): string => `${CAPTURE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

const sanitizeLabel = (value: unknown): string | Response => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return errorResponse('Invalid label', 400);
    // eslint-disable-next-line no-control-regex -- Stripping C0/C1 controls is the point.
    return value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTURE_TOKEN_LABEL_LENGTH);
};

export type CaptureTokensRequestOptions = {
    dataDir: string;
    /** Namespace key of the full token, as resolved by withNamespace. */
    key: string;
    filePath: string;
    /** Reserves the owner's empty document (same helper admission uses). */
    initializeNamespace: (filePath: string) => Promise<void> | void;
    maxBodyBytes: number;
    abortSignal: AbortSignal;
    assertStorageRoot: () => void;
    withWriteLock: <T>(key: string, handler: () => Promise<T>) => Promise<T>;
};

/**
 * Route body for /v1/capture-tokens and /v1/capture-tokens/:id, once withNamespace
 * has authenticated a FULL token (a capture token is refused there with 403).
 */
export async function handleCaptureTokensRequest(
    req: Request,
    pathname: string,
    options: CaptureTokensRequestOptions,
): Promise<Response> {
    if (pathname === CAPTURE_TOKENS_ROUTE_PATH) {
        if (req.method === 'GET') {
            return jsonResponse({ tokens: listNamespaceTokenFiles(options.dataDir, options.key).map((entry) => publicView(entry.record)) });
        }
        if (req.method === 'POST') {
            const body = await readJsonBody(req, options.maxBodyBytes, options.abortSignal);
            if (isBodyReadError(body)) {
                const err = body.__mindwtrError;
                return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
            }
            if (body !== null && (typeof body !== 'object' || Array.isArray(body))) return errorResponse('Invalid JSON body');
            const label = sanitizeLabel((body as Record<string, unknown> | null)?.label);
            if (label instanceof Response) return label;
            return await options.withWriteLock(options.key, async () => createCaptureToken(options, label));
        }
        return errorResponse('Method not allowed', 405);
    }

    const id = pathname.slice(`${CAPTURE_TOKENS_ROUTE_PATH}/`.length);
    if (!id || id.includes('/')) return errorResponse('Not found', 404);
    if (req.method !== 'DELETE') return errorResponse('Method not allowed', 405);
    return await options.withWriteLock(options.key, async () => {
        // Match on id AND namespace: another account's full token must never revoke
        // (or even learn about) this account's tokens.
        const match = listNamespaceTokenFiles(options.dataDir, options.key).find((entry) => entry.record.id === id);
        if (!match) return errorResponse('Not found', 404);
        options.assertStorageRoot();
        durablyRemoveFile(match.filePath);
        return new Response(null, { status: 204 });
    });
}

async function createCaptureToken(options: CaptureTokensRequestOptions, label: string): Promise<Response> {
    if (listNamespaceTokenFiles(options.dataDir, options.key).length >= MAX_CAPTURE_TOKENS_PER_NAMESPACE) {
        return errorResponse('Capture token limit reached', 409);
    }
    options.assertStorageRoot();
    // Allowlist mode creates an account's document lazily on its first write, and a
    // capture token is only honoured while that document exists (withNamespace's
    // orphan check), so reserve it here the way any-token admission already did.
    if (!existsSync(options.filePath)) await options.initializeNamespace(options.filePath);
    const dir = ensureDurableDirectory(captureTokensDir(options.dataDir));
    if (!dir) return errorResponse('Failed to store capture token', 500);
    const token = generateCaptureToken();
    const record: CaptureTokenRecord = {
        namespaceKey: options.key,
        id: generateUUID(),
        label,
        createdAt: new Date().toISOString(),
    };
    if (!durablyPublishFile(join(dir, `${tokenToKey(token)}.json`), JSON.stringify(record))) {
        return errorResponse('Failed to store capture token', 500);
    }
    // Nothing identifying: no id, label, digest or token.
    logInfo('Capture token created', { releaseCheck: 'v1.2.9/cloud-capture-token', tokenScope: 'capture' });
    return jsonResponse({ ...publicView(record), token }, { status: 201 });
}
