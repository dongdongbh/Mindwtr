import {
    DEFAULT_TIMEOUT_MS,
    assertConnectionAllowed,
    createProgressStream,
    discardResponseBody,
    fetchWithTimeout,
    fetchWithTimeoutAndConsume,
    isAbortError,
    isHostResponseTooLargeError,
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
import { logWarn } from './logger';
import type { ClockSkewWarning, MergeStats } from './sync-types';
import { buildHttpRemoteFileFingerprint, type RemoteFileMetadata, type RemoteJsonWriteResult } from './webdav';


export type CloudCalendarFeed = {
    createdAt: string;
    path: string;
    token: string;
};


export const getCloudCalendarFeedEndpoint = (cloudUrl: string): string => (
    `${getCloudBaseUrl(cloudUrl)}/calendar/feed`
);


export const buildCloudCalendarFeedUrl = (cloudUrl: string, token: string): string => (
    `${getCloudBaseUrl(cloudUrl)}/calendar/${token}.ics`
);


export const CLOUD_SYNC_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{20,512}$/;

export function isValidCloudSyncToken(token: string): boolean {
    return CLOUD_SYNC_TOKEN_PATTERN.test(token.trim());
}

export interface CloudOptions {


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

export type CloudJsonReadResult<T> = {
    data: T | null;
    metadata: RemoteFileMetadata;
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


    refusalText?: string;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'CloudHttpError';
        this.status = status;
        this.statusCode = status;
    }
}


const BLOCKED_ATTACHMENT_CONTENT_PREFIX = 'Blocked ';


export const isBlockedAttachmentContentRefusal = (error: unknown): boolean => {
    const raw = (error as { refusalText?: unknown } | null | undefined)?.refusalText;
    if (typeof raw !== 'string') return false;
    const trimmed = raw.trim();

    if (!trimmed.startsWith('{')) return false;
    try {
        const parsed = JSON.parse(trimmed) as { error?: unknown };
        return typeof parsed.error === 'string'
            && parsed.error.startsWith(BLOCKED_ATTACHMENT_CONTENT_PREFIX);
    } catch {
        return false;
    }
};

const cloudHttpError = (label: string, res: Response): CloudHttpError => {
    const hint = res.status === 405 ? ' — this URL may not be a Mindwtr sync server (check host and port)' : '';
    return new CloudHttpError(`${label} failed (${res.status}): ${res.statusText}${hint}`, res.status);
};


const cloudDataTooLargeError = async (res: Response, bodyBytes: number, signal?: AbortSignal): Promise<CloudHttpError> => {
    const text = await readResponseText(res, MAX_ERROR_BODY_BYTES, signal).catch(() => '');
    let limitBytes: number | undefined;
    try {
        const parsed = JSON.parse(text) as { limitBytes?: unknown };
        if (Number.isSafeInteger(parsed.limitBytes)) limitBytes = parsed.limitBytes as number;
    } catch {

    }
    logWarn('Cloud sync data refused as too large', {
        scope: 'cloud',
        category: 'sync',
        context: { releaseCheck: 'v1.3.5/cloud-data-body-limit', status: res.status, limitBytes, bodyBytes },
    });
    const limit = limitBytes === undefined ? '' : ` (${limitBytes} bytes)`;
    const proxy = limitBytes === undefined ? ' (and any proxy body limit)' : '';
    return new CloudHttpError(
        `Cloud PUT failed (413): the sync data (${bodyBytes} bytes) is larger than the server's limit${limit}. `
        + `Raise MINDWTR_CLOUD_MAX_DATA_BODY_BYTES on the server${proxy}.`,
        res.status,
    );
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

export async function cloudGetJsonWithMetadata<T>(
    url: string,
    options: CloudOptions = {},
): Promise<CloudJsonReadResult<T>> {
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
            if (res.status === 404) {
                return {
                    data: null,
                    metadata: {
                        exists: false,
                        fingerprint: null,
                        etag: null,
                        lastModified: null,
                        contentLength: null,
                    },
                };
            }
            if (!res.ok) throw cloudHttpError('Cloud GET', res);

            const text = await readResponseText(res, options.maxBytes ?? MAX_SYNC_DOCUMENT_BYTES, signal);
            try {
                return {
                    data: JSON.parse(text) as T,
                    metadata: metadataFromHeaders(res.headers),
                };
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

export async function cloudGetJson<T>(
    url: string,
    options: CloudOptions = {},
): Promise<T | null> {
    return (await cloudGetJsonWithMetadata<T>(url, options)).data;
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


            const text = res.ok
                ? await readResponseText(res, MAX_SYNC_DOCUMENT_BYTES, signal)
                : await readResponseText(res, MAX_ERROR_BODY_BYTES, signal).catch(() => '');
            if (!res.ok) {
                let serverMessage = '';
                try {
                    const parsed = JSON.parse(text) as Record<string, unknown>;
                    if (typeof parsed.error === 'string') serverMessage = parsed.error;
                } catch {

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
    const payload = JSON.stringify(data, null, 2);

    return await fetchWithTimeoutAndConsume(
        url,
        {
            method: 'PUT',
            headers,
            body: payload,
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
        async (res, signal) => {
            if (res.status === 413) {
                throw await cloudDataTooLargeError(res, new TextEncoder().encode(payload).byteLength, signal);
            }
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
            if (!res.ok) {
                const error = cloudHttpError('Cloud File PUT', res);


                if (res.status === 400) {
                    error.refusalText = await readResponseText(res, MAX_ERROR_BODY_BYTES, signal)
                        .catch(() => '');
                }
                throw error;
            }
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


    partialBodyReads?: boolean;


    onHeadUnsupported?: () => void;
};


export async function cloudAttachmentExists(
    url: string,
    options: CloudAttachmentPresenceOptions = {},
): Promise<boolean | null> {
    try {
        return (await cloudHeadJson(url, options)).exists;
    } catch (error) {
        if (isHostResponseTooLargeError(error)) throw error;
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
        if (isHostResponseTooLargeError(error)) throw error;
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
