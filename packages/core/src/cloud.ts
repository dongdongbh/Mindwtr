import {
    DEFAULT_TIMEOUT_MS,
    assertConnectionAllowed,
    createProgressStream,
    discardResponseBody,
    fetchWithTimeout,
    fetchWithTimeoutAndConsume,
    isAbortError,
    MAX_ERROR_BODY_BYTES,
    MAX_DOWNLOAD_BYTES,
    MAX_SYNC_DOCUMENT_BYTES,
    readResponseBody,
    readResponseText,
    ResponseTooLargeError,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
    toUint8Array,
} from './http-utils';
import { getCloudBaseUrl } from './attachment-paths';
import type { ClockSkewWarning, MergeStats } from './sync-types';
import { buildHttpRemoteFileFingerprint, type RemoteFileMetadata, type RemoteJsonWriteResult } from './webdav';

/** The self-hosted server's published iCalendar feed (#952). */
export type CloudCalendarFeed = {
    createdAt: string;
    path: string;
    token: string;
};

/** Authenticated endpoint that reads, rotates and revokes the feed token. */
export const getCloudCalendarFeedEndpoint = (cloudUrl: string): string => (
    `${getCloudBaseUrl(cloudUrl)}/calendar/feed`
);

/** The subscription URL itself. Derived from the configured sync URL rather than
 *  the server's root so a server behind a path-prefixed reverse proxy still works. */
export const buildCloudCalendarFeedUrl = (cloudUrl: string, token: string): string => (
    `${getCloudBaseUrl(cloudUrl)}/calendar/${token}.ics`
);

// Single source of truth for the cloud sync bearer-token shape, shared by the
// cloud server (apps/cloud/src/server-config.ts re-exports it as
// BEARER_TOKEN_PATTERN) and the desktop/mobile self-hosted settings forms so
// client and server can never validate a token differently.
export const CLOUD_SYNC_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{20,512}$/;

export function isValidCloudSyncToken(token: string): boolean {
    return CLOUD_SYNC_TOKEN_PATTERN.test(token.trim());
}

export interface CloudOptions {
    /** Download ceiling for this call. Defaults to the per-attachment cap; the sync
     *  document is not an attachment and passes MAX_SYNC_DOCUMENT_BYTES instead. */
    maxBytes?: number;
    token?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetcher?: typeof fetch;
    onProgress?: (loaded: number, total: number) => void;
    allowInsecureHttp?: boolean;
}

export type CloudJsonWriteResult = RemoteJsonWriteResult & {
    stats?: MergeStats;
    clockSkewWarning?: ClockSkewWarning | null;
    serverMergedRemoteData?: boolean;
};

function buildHeaders(options: CloudOptions): Record<string, string> {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
    }
    return headers;
}

const CLOUD_HTTPS_ERROR = 'Cloud sync requires HTTPS for public URLs (HTTP allowed for localhost, private IPs, and local hostnames).';
const CLOUD_TIMEOUT_ERROR = 'Cloud request timed out';

export class CloudHttpError extends Error {
    status: number;
    statusCode: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'CloudHttpError';
        this.status = status;
        this.statusCode = status;
    }
}

const cloudHttpError = (label: string, res: Response): CloudHttpError => {
    const hint = res.status === 405 ? ' — this URL may not be a Mindwtr sync server (check host and port)' : '';
    return new CloudHttpError(`${label} failed (${res.status}): ${res.statusText}${hint}`, res.status);
};

const assertCloudUrl = (url: string, options: CloudOptions): void => {
    assertConnectionAllowed(url, CLOUD_HTTPS_ERROR, {
        ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
        allowAndroidEmulator: true,
        allowInsecureHttp: options.allowInsecureHttp,
    });
};

const metadataFromHeaders = (headers: Headers): RemoteFileMetadata => {
    const etag = headers.get('etag');
    const lastModified = headers.get('last-modified');
    const contentLength = headers.get('content-length');
    return {
        exists: true,
        fingerprint: buildHttpRemoteFileFingerprint('cloud', { etag, lastModified, contentLength }),
        etag,
        lastModified,
        contentLength,
    };
};

const parseCloudJsonWriteBody = async (
    res: Response,
    signal?: AbortSignal,
): Promise<Partial<CloudJsonWriteResult>> => {
    const text = await readResponseText(res, MAX_ERROR_BODY_BYTES, signal).catch(() => '');
    const normalized = text.startsWith('\uFEFF') ? text.slice(1).trim() : text.trim();
    if (!normalized) return {};
    try {
        const parsed = JSON.parse(normalized) as Record<string, unknown>;
        const remoteFingerprint = typeof parsed.remoteFingerprint === 'string' && parsed.remoteFingerprint.trim()
            ? parsed.remoteFingerprint
            : undefined;
        const etag = typeof parsed.etag === 'string' ? parsed.etag : undefined;
        const lastModified = typeof parsed.lastModified === 'string' ? parsed.lastModified : undefined;
        const contentLength = typeof parsed.contentLength === 'string' ? parsed.contentLength : undefined;
        return {
            ...(remoteFingerprint ? { fingerprint: remoteFingerprint } : {}),
            ...(etag !== undefined ? { etag } : {}),
            ...(lastModified !== undefined ? { lastModified } : {}),
            ...(contentLength !== undefined ? { contentLength } : {}),
            ...(parsed.stats && typeof parsed.stats === 'object' ? { stats: parsed.stats as MergeStats } : {}),
            ...(parsed.clockSkewWarning && typeof parsed.clockSkewWarning === 'object'
                ? { clockSkewWarning: parsed.clockSkewWarning as ClockSkewWarning }
                : parsed.clockSkewWarning === null
                    ? { clockSkewWarning: null }
                    : {}),
            ...(typeof parsed.serverMergedRemoteData === 'boolean'
                ? { serverMergedRemoteData: parsed.serverMergedRemoteData }
                : {}),
        };
    } catch {
        return {};
    }
};

export async function cloudGetJson<T>(
    url: string,
    options: CloudOptions = {},
): Promise<T | null> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    return await fetchWithTimeoutAndConsume(
        url,
        {
            method: 'GET',
            headers: buildHeaders(options),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
        async (res, signal) => {
            if (res.status === 404) return null;
            if (!res.ok) throw cloudHttpError('Cloud GET', res);

            const text = await readResponseText(res, options.maxBytes ?? MAX_SYNC_DOCUMENT_BYTES, signal);
            try {
                return JSON.parse(text) as T;
            } catch (error) {
                if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) {
                    throw new Error(
                        'Cloud GET failed: server returned HTML instead of Mindwtr sync data — check the Self-Hosted URL, host, and port',
                    );
                }
                throw new Error(`Cloud GET failed: invalid JSON (${(error as Error).message})`);
            }
        },
    );
}

export async function cloudRequestJson<T>(
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    options: CloudOptions = {},
): Promise<T | null> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    if (body !== undefined) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    return await fetchWithTimeoutAndConsume(
        url,
        {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
        async (res, signal) => {
            // Success bodies are real entities and may be large; only an error body is
            // truncated down to message size.
            const text = res.ok
                ? await readResponseText(res, MAX_SYNC_DOCUMENT_BYTES, signal)
                : await readResponseText(res, MAX_ERROR_BODY_BYTES, signal).catch(() => '');
            if (!res.ok) {
                let serverMessage = '';
                try {
                    const parsed = JSON.parse(text) as Record<string, unknown>;
                    if (typeof parsed.error === 'string') serverMessage = parsed.error;
                } catch {
                    // Non-JSON error body; fall back to the status line.
                }
                throw new CloudHttpError(
                    serverMessage || `Cloud ${method} failed (${res.status}): ${res.statusText}`,
                    res.status,
                );
            }
            if (!text.trim()) return null;
            try {
                return JSON.parse(text) as T;
            } catch (error) {
                throw new Error(`Cloud ${method} failed: invalid JSON (${(error as Error).message})`);
            }
        },
    );
}

export async function cloudHeadJson(
    url: string,
    options: CloudOptions = {},
): Promise<RemoteFileMetadata> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        {
            method: 'HEAD',
            headers: buildHeaders(options),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
    );

    if (res.status === 404) {
        return {
            exists: false,
            fingerprint: null,
            etag: null,
            lastModified: null,
            contentLength: null,
        };
    }
    if (!res.ok) {
        throw cloudHttpError('Cloud HEAD', res);
    }

    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    const contentLength = res.headers.get('content-length');
    return {
        exists: true,
        fingerprint: buildHttpRemoteFileFingerprint('cloud', { etag, lastModified, contentLength }),
        etag,
        lastModified,
        contentLength,
    };
}

export async function cloudPutJson(
    url: string,
    data: unknown,
    options: CloudOptions = {},
): Promise<CloudJsonWriteResult> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';

    return await fetchWithTimeoutAndConsume(
        url,
        {
            method: 'PUT',
            headers,
            body: JSON.stringify(data, null, 2),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
        async (res, signal) => {
            if (!res.ok) throw cloudHttpError('Cloud PUT', res);
            const metadata = metadataFromHeaders(res.headers);
            const body = await parseCloudJsonWriteBody(res, signal);
            return {
                ...metadata,
                ...body,
                exists: true,
                fingerprint: body.fingerprint ?? metadata.fingerprint,
            };
        },
    );
}

export async function cloudPutFile(
    url: string,
    data: ArrayBuffer | Uint8Array | Blob,
    contentType: string,
    options: CloudOptions = {},
): Promise<void> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    headers['Content-Type'] = contentType || 'application/octet-stream';

    let body: BodyInit = data instanceof Uint8Array ? new Uint8Array(data) : data;
    if (options.onProgress) {
        const bytes = await toUint8Array(data);
        const stream = createProgressStream(bytes, options.onProgress);
        body = stream ?? bytes;
        if (!headers['Content-Length']) {
            headers['Content-Length'] = String(bytes.length);
        }
    }

    await fetchWithTimeoutAndConsume(
        url,
        {
            method: 'PUT',
            headers,
            body,
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
        async (res, signal) => {
            if (!res.ok) throw cloudHttpError('Cloud File PUT', res);
            await discardResponseBody(res, signal);
        },
    );
}

export async function cloudGetFile(
    url: string,
    options: CloudOptions = {},
): Promise<ArrayBuffer> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    return await fetchWithTimeoutAndConsume(
        url,
        {
            method: 'GET',
            headers: buildHeaders(options),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
        async (res, signal) => {
            if (!res.ok) throw cloudHttpError('Cloud File GET', res);
            return await readResponseBody(res, options.onProgress, options.maxBytes ?? MAX_DOWNLOAD_BYTES, signal);
        },
    );
}

export type CloudAttachmentPresenceOptions = CloudOptions & {
    /**
     * Can this caller's transport stop reading a response body once it has seen the
     * headers? Desktop's streaming fetch can; React Native's XHR transport
     * (apps/mobile/lib/background-safe-fetch.ts) cannot — it buffers the whole reply
     * before the promise resolves. Only a caller that answers `true` may use the
     * GET fallback below, because for everyone else that "cheap probe" is a full
     * download of every attachment.
     */
    partialBodyReads?: boolean;
    /** Called when the server has no HEAD route and this caller cannot fall back, so the
     *  caller can say so once instead of silently proving nothing. */
    onHeadUnsupported?: () => void;
};

/**
 * #1119 follow-up: does the self-hosted server still hold this attachment blob?
 * `true` yes, `false` definitively no, `null` could not tell — and only `false` may ever
 * be acted on (see `attachment-presence-repair.ts`).
 *
 * HEAD is the real probe. Servers older than the release that added
 * `HEAD /v1/attachments/:path` answer 405 Method Not Allowed, which is not an answer, so a
 * caller whose transport can abandon a body early retries as a GET with a one-byte ceiling:
 * `readResponseBody` rejects on the declared content-length and cancels before a single
 * chunk is read. A caller that cannot do that gets `null` — one wasted request rather than
 * a full download of the whole library.
 */
export async function cloudAttachmentExists(
    url: string,
    options: CloudAttachmentPresenceOptions = {},
): Promise<boolean | null> {
    try {
        return (await cloudHeadJson(url, options)).exists;
    } catch (error) {
        if (isAbortError(error)) throw error;
        if (!(error instanceof CloudHttpError) || error.status !== 405) return null;
        if (!options.partialBodyReads) {
            options.onHeadUnsupported?.();
            return null;
        }
    }
    try {
        await cloudGetFile(url, { ...options, maxBytes: 1, onProgress: undefined });
        return true;
    } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof ResponseTooLargeError) return true;
        return error instanceof CloudHttpError && error.status === 404 ? false : null;
    }
}

export async function cloudDeleteFile(
    url: string,
    options: CloudOptions = {},
): Promise<void> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    await fetchWithTimeoutAndConsume(
        url,
        {
            method: 'DELETE',
            headers: buildHeaders(options),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
        async (res, signal) => {
            if (!res.ok && res.status !== 404) throw cloudHttpError('Cloud DELETE', res);
            await discardResponseBody(res, signal);
        },
    );
}
