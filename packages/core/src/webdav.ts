import {
    DEFAULT_TIMEOUT_MS,
    assertConnectionAllowed,
    createProgressStream,
    discardResponseBody,
    fetchWithTimeout,
    fetchWithTimeoutAndConsume,
    MAX_ERROR_BODY_BYTES,
    MAX_DOWNLOAD_BYTES,
    MAX_SYNC_DOCUMENT_BYTES,
    readResponseBody,
    readResponseText,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
    toUint8Array,
} from './http-utils';
import { logWarn } from './logger';
import {
    decryptRemoteArtifactOrThrow,
    detectForeignSaltArtifact,
    isPlaintextSyncArtifact,
    SyncEncryptionTerminalError,
    SyncEncryptionRemoteVersionUnavailableError,
    syncEncryptedArtifactName,
} from './sync-encryption';
import { encryptSyncArtifact, inspectSyncArtifact, SyncCryptoUnsupportedError, type SyncCryptoPrimitives, type SyncKeyMaterial } from './sync-crypto';

export interface WebDavOptions {
    /** Download ceiling for this call. Defaults to the per-attachment cap; the sync
     *  document is not an attachment and passes MAX_SYNC_DOCUMENT_BYTES instead. */
    maxBytes?: number;
    username?: string;
    password?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
    allowInsecureHttp?: boolean;
    allowWeakFingerprint?: boolean;
    /** Internal one-shot write mode. A legacy plaintext document without a usable
     * generation cannot safely retry after an ambiguous response. */
    disableParentCollectionRetry?: boolean;
}

export type RemoteFileMetadata = {
    exists: boolean;
    fingerprint: string | null;
    etag: string | null;
    lastModified: string | null;
    contentLength: string | null;
};

export type RemoteJsonWriteResult = RemoteFileMetadata;

export type WebDavDocumentVersion = {
    exists: boolean;
    /** A syntactically valid strong ETag, or null when the server did not supply one. */
    strongEtag: string | null;
};

export const WEBDAV_REMOTE_WRITE_CONFLICT = 'WEBDAV_REMOTE_WRITE_CONFLICT';

export class WebDavRemoteWriteConflictError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`${WEBDAV_REMOTE_WRITE_CONFLICT}: WebDAV document changed before replacement (${status})`);
        this.name = 'WebDavRemoteWriteConflictError';
        this.status = status;
    }
}

export const isWebdavRemoteWriteConflictError = (error: unknown): boolean => (
    error instanceof WebDavRemoteWriteConflictError
    || (error instanceof Error ? error.message : String(error ?? '')).includes(WEBDAV_REMOTE_WRITE_CONFLICT)
);

const WEBDAV_VERSION_MARKER = 'mindwtr-webdav-version';

class WebDavSyncDocumentReadError extends Error {
    constructor(message: string, readonly documentVersion: WebDavDocumentVersion) {
        super(message);
        this.name = 'WebDavSyncDocumentReadError';
    }
}

/** Accept only RFC-style strong entity tags. Weak, unquoted, empty, or control-bearing
 * values are not safe compare-and-swap validators. */
export const normalizeStrongWebdavEtag = (raw: string | null | undefined): string | null => {
    const value = raw?.trim() ?? '';
    if (value.length < 2 || /^W\//i.test(value) || value[0] !== '"' || value[value.length - 1] !== '"') {
        return null;
    }
    const opaque = value.slice(1, -1);
    for (const char of opaque) {
        const code = char.charCodeAt(0);
        if (char === '"' || code < 0x21 || code === 0x7f) return null;
    }
    return value;
};

/** Native WebDAV appends the same marker to invalid-JSON errors so the renderer can
 * preserve the GET validator before the shared repair path catches the error. */
export const getWebdavDocumentVersionFromError = (error: unknown): WebDavDocumentVersion | null => {
    if (error instanceof WebDavSyncDocumentReadError) return error.documentVersion;
    const message = error instanceof Error ? error.message : String(error ?? '');
    const match = new RegExp(`\\[${WEBDAV_VERSION_MARKER}:(missing|existing)(?::(none|"[^"]*"))?\\]`).exec(message);
    if (!match) return null;
    if (match[1] === 'missing') return { exists: false, strongEtag: null };
    return { exists: true, strongEtag: normalizeStrongWebdavEtag(match[2] === 'none' ? null : match[2]) };
};

const MAX_WEBDAV_MKCOL_DEPTH = 32;

function bytesToBase64(bytes: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i] ?? 0;
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];

        const hasB1 = typeof b1 === 'number';
        const hasB2 = typeof b2 === 'number';

        const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);

        out += alphabet[(triplet >> 18) & 0x3f];
        out += alphabet[(triplet >> 12) & 0x3f];
        out += hasB1 ? alphabet[(triplet >> 6) & 0x3f] : '=';
        out += hasB2 ? alphabet[triplet & 0x3f] : '=';
    }
    return out;
}

function encodeBase64Utf8(value: string): string {
    const Encoder = typeof TextEncoder === 'function' ? TextEncoder : undefined;
    if (Encoder) {
        return bytesToBase64(new Encoder().encode(value));
    }

    try {
        const encoded = encodeURIComponent(value);
        const bytes: number[] = [];
        for (let i = 0; i < encoded.length; i++) {
            const ch = encoded[i];
            if (ch === '%') {
                const hex = encoded.slice(i + 1, i + 3);
                bytes.push(Number.parseInt(hex, 16));
                i += 2;
            } else {
                bytes.push(ch.charCodeAt(0));
            }
        }
        return bytesToBase64(new Uint8Array(bytes));
    } catch {
        const bytes = new Uint8Array(value.split('').map((c) => c.charCodeAt(0) & 0xff));
        return bytesToBase64(bytes);
    }
}

function buildHeaders(options: WebDavOptions): Record<string, string> {
    // Android's fetch (OkHttp) adds `Accept-Encoding: gzip` on its own, and a
    // compressing proxy in front of the server (nginx, Cloudflare) then serves
    // `data.json` with a weak `W/"…"` ETag while the octet-stream probe file
    // keeps a strong one. Desktop's reqwest never asks for compression, so the
    // same server passed there and failed only on Android (#1056). Conditional
    // writes need the strong ETag, so ask for the bytes as stored.
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity', ...(options.headers || {}) };
    if (options.username && typeof options.password === 'string') {
        headers.Authorization = `Basic ${encodeBase64Utf8(`${options.username}:${options.password}`)}`;
    }
    return headers;
}

function buildReadHeaders(options: WebDavOptions): Record<string, string> {
    const headers = buildHeaders(options);
    headers['Cache-Control'] = 'no-cache';
    headers.Pragma = 'no-cache';
    return headers;
}

function buildReadRequestInit(options: WebDavOptions, method: 'GET' | 'HEAD'): RequestInit {
    const init: RequestInit = {
        method,
        headers: buildReadHeaders(options),
    };
    if (options.signal) {
        init.signal = options.signal;
    }
    return init;
}

const WEBDAV_HTTPS_ERROR = 'WebDAV requires HTTPS for public URLs (HTTP allowed for localhost, private IPs, and local hostnames).';
const WEBDAV_TIMEOUT_ERROR = 'WebDAV request timed out';
const WEBDAV_AUTOMKCOL_HEADER = 'X-NC-WebDAV-AutoMkcol';
const UTF8_BOM = '\uFEFF';
const warnedWeakFingerprintSources = new Set<string>();

type HttpRemoteFileFingerprintOptions = {
    allowWeakFingerprint?: boolean;
    warnOnWeakFingerprint?: boolean;
    warnOnceKey?: string;
};

// Nextcloud/ownCloud users paste the browser address of the Files app
// (…/apps/files/… or …?dir=/Folder) instead of the WebDAV endpoint; every
// request then 404s with an unactionable "MKCOL failed (404)" (#1084).
// Kept under 200 chars: the desktop probe toast slices reasons to 200.
const WEBDAV_WEB_UI_URL_ERROR = 'This looks like the Nextcloud/ownCloud web page address, not a WebDAV address. Copy the WebDAV URL from Files → File settings (like https://server/remote.php/dav/files/USERNAME/).';

const looksLikeWebUiUrl = (url: string): boolean => {
    try {
        const parsed = new URL(url);
        if (parsed.pathname.includes('/remote.php/')) return false;
        return parsed.pathname.includes('/apps/files') || parsed.searchParams.has('dir');
    } catch {
        return false;
    }
};

const assertWebdavUrl = (url: string, options: WebDavOptions): void => {
    assertConnectionAllowed(url, WEBDAV_HTTPS_ERROR, {
        ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
        allowInsecureHttp: options.allowInsecureHttp,
    });
    if (looksLikeWebUiUrl(url)) {
        throw new Error(WEBDAV_WEB_UI_URL_ERROR);
    }
};

export const buildHttpRemoteFileFingerprint = (
    source: string,
    metadata: Pick<RemoteFileMetadata, 'etag' | 'lastModified' | 'contentLength'>,
    options: HttpRemoteFileFingerprintOptions = {},
): string | null => {
    const etag = metadata.etag?.trim() || '';
    const lastModified = metadata.lastModified?.trim() || '';
    const contentLength = metadata.contentLength?.trim() || '';
    if (etag) {
        return `${source}:v1:etag=${etag}`;
    }
    if (lastModified && contentLength) {
        if (options.allowWeakFingerprint === false) {
            return null;
        }
        const shouldWarn = options.warnOnWeakFingerprint ?? source === 'webdav';
        const warnOnceKey = options.warnOnceKey ?? source;
        if (shouldWarn && !warnedWeakFingerprintSources.has(warnOnceKey)) {
            warnedWeakFingerprintSources.add(warnOnceKey);
            logWarn('WebDAV server did not provide ETag; using Last-Modified and Content-Length for fast sync fingerprint', {
                scope: 'sync',
                category: 'network',
                context: { source, warnOnceKey },
            });
        }
        return `${source}:v1:mtime=${lastModified}:len=${contentLength}`;
    }
    return null;
};

const metadataFromHeaders = (source: string, headers: Headers, options: HttpRemoteFileFingerprintOptions = {}): RemoteFileMetadata => {
    const etag = headers.get('etag');
    const lastModified = headers.get('last-modified');
    const contentLength = headers.get('content-length');
    return {
        exists: true,
        fingerprint: buildHttpRemoteFileFingerprint(source, { etag, lastModified, contentLength }, options),
        etag,
        lastModified,
        contentLength,
    };
};

const getWebdavWeakFingerprintWarningKey = (url: string): string => {
    try {
        const parsed = new URL(url);
        parsed.username = '';
        parsed.password = '';
        parsed.hash = '';
        parsed.protocol = parsed.protocol.toLowerCase();
        parsed.hostname = parsed.hostname.toLowerCase();
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        return `webdav:${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch {
        return `webdav:${url.trim().replace(/\/+$/, '').toLowerCase()}`;
    }
};

export const __webdavTestUtils = {
    resetWeakFingerprintWarnings: () => warnedWeakFingerprintSources.clear(),
};

const getWebdavParentCollectionUrl = (url: string): string | null => {
    try {
        const parsed = new URL(url);
        const trimmedPath = parsed.pathname.replace(/\/+$/, '');
        const lastSlash = trimmedPath.lastIndexOf('/');
        if (lastSlash <= 0) return null;
        parsed.pathname = trimmedPath.slice(0, lastSlash);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
};

const normalizeWebdavCollectionUrl = (url: string): string => {
    try {
        const parsed = new URL(url);
        parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
        return parsed.toString();
    } catch {
        return `${url.replace(/\/+$/, '')}/`;
    }
};

const createWebdavCollection = async (
    url: string,
    options: WebDavOptions,
): Promise<Response> => {
    const fetcher = options.fetcher ?? fetch;
    return fetchWithTimeoutAndConsume(
        normalizeWebdavCollectionUrl(url),
        { method: 'MKCOL', headers: buildHeaders(options) },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
        async (response, signal) => {
            await discardResponseBody(response, signal);
            return response;
        },
    );
};

const webdavCollectionExists = async (
    url: string,
    options: WebDavOptions,
): Promise<boolean> => {
    const fetcher = options.fetcher ?? fetch;
    return await fetchWithTimeoutAndConsume(
        normalizeWebdavCollectionUrl(url),
        {
            method: 'PROPFIND',
            headers: {
                Depth: '0',
                ...buildHeaders(options),
            },
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
        async (res, signal) => {
            if (res.status === 404) {
                await discardResponseBody(res, signal);
                return false;
            }
            if (res.ok || res.status === 405) {
                await discardResponseBody(res, signal);
                return true;
            }
            const error = new Error(`WebDAV PROPFIND failed (${res.status})`);
            (error as { status?: number }).status = res.status;
            throw error;
        },
    );
};

const probeWebdavCollectionExists = async (
    url: string,
    options: WebDavOptions,
): Promise<boolean> => {
    try {
        return await webdavCollectionExists(url, options);
    } catch {
        return false;
    }
};

const isWebdavMkcolConflictError = (error: unknown): boolean => (
    error instanceof Error && error.message === 'WebDAV MKCOL failed (409)'
);

const ensureWebdavParentCollectionsBeforePut = async (
    url: string,
    options: WebDavOptions = {},
): Promise<void> => {
    try {
        await ensureWebdavParentCollections(url, options);
    } catch (error) {
        // Some WebDAV servers report an ambiguous MKCOL 409 for an existing
        // collection that cannot be verified with PROPFIND. Retry the PUT and
        // let that final response decide whether the upload can proceed.
        if (!isWebdavMkcolConflictError(error)) {
            throw error;
        }
    }
};

const ensureWebdavCollectionExists = async (
    url: string,
    options: WebDavOptions = {},
): Promise<void> => {
    const pendingChildren: string[] = [];
    let currentUrl = url;

    while (true) {
        const res = await createWebdavCollection(currentUrl, options);
        if (res.ok || res.status === 405) {
            break;
        }
        if (res.status === 409 && await probeWebdavCollectionExists(currentUrl, options)) {
            break;
        }
        if (res.status !== 409) {
            throw new Error(`WebDAV MKCOL failed (${res.status})`);
        }
        if (pendingChildren.length >= MAX_WEBDAV_MKCOL_DEPTH) {
            throw new Error('WebDAV MKCOL failed (max depth exceeded)');
        }
        const parentUrl = getWebdavParentCollectionUrl(currentUrl);
        if (!parentUrl || parentUrl === currentUrl) {
            throw new Error(`WebDAV MKCOL failed (${res.status})`);
        }
        pendingChildren.push(currentUrl);
        currentUrl = parentUrl;
    }

    while (pendingChildren.length > 0) {
        const childUrl = pendingChildren.pop()!;
        const res = await createWebdavCollection(childUrl, options);
        if (res.ok || res.status === 405) {
            continue;
        }
        if (res.status === 409 && await probeWebdavCollectionExists(childUrl, options)) {
            continue;
        }
        throw new Error(`WebDAV MKCOL failed (${res.status})`);
    }
};

const ensureWebdavParentCollections = async (
    url: string,
    options: WebDavOptions = {},
): Promise<void> => {
    const parentUrl = getWebdavParentCollectionUrl(url);
    if (!parentUrl) return;
    await ensureWebdavCollectionExists(parentUrl, options);
};

const parseOptionalWebdavJson = <T>(text: string): T | null => {
    const normalizedBody = text.startsWith(UTF8_BOM) ? text.slice(1).trim() : text.trim();
    if (!normalizedBody) return null;
    try {
        return JSON.parse(normalizedBody) as T;
    } catch (error) {
        throw new Error(`WebDAV GET failed: invalid JSON (${(error as Error).message})`);
    }
};

export async function webdavGetJson<T>(
    url: string,
    options: WebDavOptions = {}
): Promise<T | null> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    return await fetchWithTimeoutAndConsume(
        url,
        buildReadRequestInit(options, 'GET'),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
        async (res, signal) => {
            if (res.status === 404) return null;
            if (!res.ok) {
                const text = await readResponseText(res, MAX_ERROR_BODY_BYTES, signal).catch(() => '');
                const error = new Error(`WebDAV GET failed (${res.status}): ${text || res.statusText}`);
                (error as { status?: number }).status = res.status;
                throw error;
            }

            const text = await readResponseText(res, options.maxBytes ?? MAX_SYNC_DOCUMENT_BYTES, signal);
            return parseOptionalWebdavJson<T>(text);
        },
    );
}

export async function webdavPutJson(
    url: string,
    data: unknown,
    options: WebDavOptions = {}
): Promise<RemoteJsonWriteResult> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    headers[WEBDAV_AUTOMKCOL_HEADER] = headers[WEBDAV_AUTOMKCOL_HEADER] || '1';

    const payload = JSON.stringify(data, null, 2);
    const sendPut = async (): Promise<WebDavPutResponse> => fetchWebdavPutAndConsumeError(
        url,
        {
            method: 'PUT',
            headers,
            body: payload,
            signal: options.signal,
        },
        fetcher,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let res = await sendPut();
    if (
        !options.disableParentCollectionRetry
        && !res.ok
        && (res.status === 404 || res.status === 409)
    ) {
        await ensureWebdavParentCollectionsBeforePut(url, options);
        res = await sendPut();
    }

    if (!res.ok) {
        const isConditionalWrite = Object.keys(headers).some((name) => {
            const normalized = name.toLowerCase();
            return normalized === 'if-match' || normalized === 'if-none-match';
        });
        if (isConditionalWrite && (res.status === 409 || res.status === 412)) {
            throw new WebDavRemoteWriteConflictError(res.status);
        }
        const error = new Error(`WebDAV PUT failed (${res.status}): ${res.errorText || res.statusText}`);
        (error as { status?: number }).status = res.status;
        throw error;
    }
    return metadataFromHeaders('webdav', res.headers, {
        allowWeakFingerprint: options.allowWeakFingerprint,
        warnOnceKey: getWebdavWeakFingerprintWarningKey(url),
    });
}

type WebDavVersionedBytes = WebDavDocumentVersion & { bytes: Uint8Array | null };

type WebDavPutResponse = {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Headers;
    errorText: string;
};

const fetchWebdavPutAndConsumeError = async (
    url: string,
    init: RequestInit,
    fetcher: typeof fetch,
    timeoutMs: number,
): Promise<WebDavPutResponse> => fetchWithTimeoutAndConsume(
    url,
    init,
    timeoutMs,
    fetcher,
    WEBDAV_TIMEOUT_ERROR,
    async (response, signal) => {
        const errorText = response.ok
            ? (await discardResponseBody(response, signal), '')
            : await readResponseText(response, MAX_ERROR_BODY_BYTES, signal).catch((error) => {
                if (signal?.aborted) throw error;
                return '';
            });
        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            errorText,
        };
    },
);

/** One GET supplies both document bytes and the strong validator governing the later PUT. */
async function webdavGetVersionedBytesOrNull(
    url: string,
    options: WebDavOptions,
): Promise<WebDavVersionedBytes> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    return await fetchWithTimeoutAndConsume(
        url,
        buildReadRequestInit(options, 'GET'),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
        async (res, signal) => {
            if (res.status === 404) return { bytes: null, exists: false, strongEtag: null };
            if (!res.ok) {
                const text = await readResponseText(res, MAX_ERROR_BODY_BYTES, signal).catch(() => '');
                const error = new Error(`WebDAV GET failed (${res.status}): ${text || res.statusText}`);
                (error as { status?: number }).status = res.status;
                throw error;
            }
            return {
                bytes: new Uint8Array(await readResponseBody(res, undefined, MAX_SYNC_DOCUMENT_BYTES, signal)),
                exists: true,
                strongEtag: normalizeStrongWebdavEtag(res.headers.get('etag')),
            };
        },
    );
}

const withWebdavDocumentWriteCondition = (
    options: WebDavOptions,
    expectedEtag: string | null,
): WebDavOptions => {
    const headers = Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(([name]) => {
            const normalized = name.toLowerCase();
            return normalized !== 'if-match' && normalized !== 'if-none-match';
        }),
    );
    if (expectedEtag === null) {
        headers['If-None-Match'] = '*';
    } else {
        const strongEtag = normalizeStrongWebdavEtag(expectedEtag);
        if (!strongEtag) throw new Error('WebDAV replacement requires a valid strong ETag');
        headers['If-Match'] = strongEtag;
    }
    return { ...options, headers };
};

async function putWebdavBytes(
    url: string,
    bytes: Uint8Array,
    options: WebDavOptions,
): Promise<RemoteJsonWriteResult> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    headers['Content-Type'] = 'application/octet-stream';
    headers[WEBDAV_AUTOMKCOL_HEADER] = headers[WEBDAV_AUTOMKCOL_HEADER] || '1';
    const body = new Uint8Array(bytes);
    const sendPut = async (): Promise<WebDavPutResponse> => fetchWebdavPutAndConsumeError(
        url,
        { method: 'PUT', headers, body, signal: options.signal },
        fetcher,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let res = await sendPut();
    if (
        !options.disableParentCollectionRetry
        && !res.ok
        && (res.status === 404 || res.status === 409)
    ) {
        await ensureWebdavParentCollectionsBeforePut(url, options);
        res = await sendPut();
    }
    if (!res.ok) {
        if (res.status === 409 || res.status === 412) {
            throw new WebDavRemoteWriteConflictError(res.status);
        }
        const error = new Error(`WebDAV PUT failed (${res.status}): ${res.errorText || res.statusText}`);
        (error as { status?: number }).status = res.status;
        throw error;
    }
    return metadataFromHeaders('webdav', res.headers, {
        allowWeakFingerprint: options.allowWeakFingerprint,
        warnOnceKey: getWebdavWeakFingerprintWarningKey(url),
    });
}

export type WebDavSyncDataOptions = WebDavOptions & {
    /** Full key material (key + salt + params, e.g. from the local key cache combined
     *  with the locally-recorded salt/params). Omitting this is the encryption-off path
     *  and is byte-for-byte identical to calling webdavGetJson/webdavPutJson directly —
     *  same URL, same request shape, same errors (backward-compat invariant #1). */
    material?: SyncKeyMaterial;
    cryptoPrims?: SyncCryptoPrimitives;
    /** null creates only if absent; a strong ETag replaces only that exact generation.
     * Required by webdavPutSyncDocument and ignored by reads. */
    expectedEtag?: string | null;
    /** Explicit compatibility path for an existing plaintext document on a
     * provider that supplies no strong ETag. Callers must reread and compare the
     * remote snapshot immediately before writing. It is deliberately one-shot
     * and is rejected whenever encryption material is present. */
    legacyUnconditionalPlaintext?: boolean;
};

export type WebDavSyncDataResult<T> = WebDavDocumentVersion & (
    | { state: 'data'; data: T | null }
    /** The remote has a valid `.enc` (or, defensively, plain-named ciphertext) artifact
     *  this call has no key for. Callers persist this via
     *  sync-encryption.ts's markRemoteEncryptionDiscovered and must not treat it as
     *  "no data" or attempt any repair/rotation. */
    | { state: 'encrypted-no-key'; salt: Uint8Array; params: import('./sync-crypto').SyncCryptoKdfParams }
    /** This call has a key, the `.enc` artifact is gone, and a plaintext document is in its
     *  place: a peer disabled encryption at the sync location. Callers persist this via
     *  sync-encryption.ts's markRemotePlaintextDiscovered and abort the cycle — merging would
     *  fork the folder, and writing plaintext would let whoever removed the ciphertext strip
     *  encryption from every device. */
    | { state: 'remote-plaintext' }
);

const unexpectedWebdavArtifact = (message: string): never => {
    throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(message));
};

/**
 * Encryption-aware sync-document read. `url` is always the PLAIN document URL — this
 * function derives the `.enc` URL itself when `material` is supplied.
 *
 * Detection of a peer that already enabled encryption (decision #2): only probed when
 * `material` is absent AND the plain read comes back empty/missing, which is exactly
 * the "nothing here" shape a first-sync or a post-enable plaintext-deleted remote both
 * produce — an existing, steadily-syncing plaintext installation's plain read succeeds
 * every cycle and never reaches the probe, so it costs that install nothing (invariant
 * #1). A plain-named body that fails JSON.parse is also inspected for MWENC1 magic
 * before falling back to the existing "invalid JSON" error, per decision #4: ciphertext
 * is never treated as corrupt JSON to repair.
 */
export async function webdavGetSyncDocument<T>(
    url: string,
    options: WebDavSyncDataOptions = {},
): Promise<WebDavSyncDataResult<T>> {
    const { material, cryptoPrims, expectedEtag: _expectedEtag, ...webdavOptions } = options;
    if (material) {
        const remote = await webdavGetVersionedBytesOrNull(syncEncryptedArtifactName(url), webdavOptions);
        if (!remote.bytes) {
            // Mirror of the off-state probe below, in the other direction, and gated the same
            // way: only the "nothing at my name" shape pays for it, so a healthy encrypted
            // install never reaches it.
            const plain = await webdavGetVersionedBytesOrNull(url, webdavOptions);
            if (isPlaintextSyncArtifact(plain.bytes)) {
                return { state: 'remote-plaintext', exists: true, strongEtag: plain.strongEtag };
            }
            if (plain.bytes?.some((byte) => byte > 0x20)) {
                return unexpectedWebdavArtifact(
                    'Ciphertext or an unsupported artifact was found at the plaintext WebDAV artifact name',
                );
            }
            return { state: 'data', data: null, exists: false, strongEtag: null };
        }
        // Sealed under another salt = this device's key is for a different encryption
        // generation; report it as a no-key discovery (which can prompt for the passphrase)
        // instead of decrypting into a dead-end Auth failure.
        const foreign = detectForeignSaltArtifact(remote.bytes, material);
        if (foreign) return { state: 'encrypted-no-key', salt: foreign.salt, params: foreign.params, exists: true, strongEtag: remote.strongEtag };
        const plaintext = await decryptRemoteArtifactOrThrow(remote.bytes, material.key, cryptoPrims);
        try {
            return {
                state: 'data',
                data: JSON.parse(new TextDecoder().decode(plaintext)) as T,
                exists: true,
                strongEtag: remote.strongEtag,
            };
        } catch (error) {
            throw new WebDavSyncDocumentReadError(
                `WebDAV GET failed: invalid JSON (${(error as Error).message})`,
                { exists: true, strongEtag: remote.strongEtag },
            );
        }
    }

    const remote = await webdavGetVersionedBytesOrNull(url, webdavOptions);
    if (remote.bytes) {
        const inspected = inspectSyncArtifact(remote.bytes);
        if (inspected.kind === 'encrypted') {
            return {
                state: 'encrypted-no-key',
                salt: inspected.salt,
                params: inspected.params,
                exists: true,
                strongEtag: remote.strongEtag,
            };
        }
        if (inspected.kind === 'unsupported') {
            return unexpectedWebdavArtifact(inspected.reason);
        }
        const text = new TextDecoder().decode(remote.bytes);
        const normalizedBody = text.startsWith(UTF8_BOM) ? text.slice(1).trim() : text.trim();
        if (normalizedBody) {
            try {
                return {
                    state: 'data',
                    data: JSON.parse(normalizedBody) as T,
                    exists: true,
                    strongEtag: remote.strongEtag,
                };
            } catch (error) {
                throw new WebDavSyncDocumentReadError(
                    `WebDAV GET failed: invalid JSON (${(error as Error).message})`,
                    { exists: true, strongEtag: remote.strongEtag },
                );
            }
        }
    }

    const encrypted = await webdavGetVersionedBytesOrNull(syncEncryptedArtifactName(url), webdavOptions);
    if (encrypted.bytes) {
        const inspected = inspectSyncArtifact(encrypted.bytes);
        if (inspected.kind === 'encrypted') {
            return {
                state: 'encrypted-no-key',
                salt: inspected.salt,
                params: inspected.params,
                exists: true,
                strongEtag: encrypted.strongEtag,
            };
        }
        if (inspected.kind === 'unsupported') {
            return unexpectedWebdavArtifact(inspected.reason);
        }
        if (encrypted.bytes.some((byte) => byte > 0x20)) {
            return unexpectedWebdavArtifact(
                'Plaintext was found at the encrypted WebDAV artifact name',
            );
        }
    }
    return { state: 'data', data: null, exists: remote.exists, strongEtag: remote.strongEtag };
}

export async function webdavPutSyncDocument(
    url: string,
    data: unknown,
    options: WebDavSyncDataOptions = {},
): Promise<RemoteJsonWriteResult> {
    const legacyPlaintext = options.legacyUnconditionalPlaintext === true;
    if (!legacyPlaintext && !Object.prototype.hasOwnProperty.call(options, 'expectedEtag')) {
        throw new Error('WebDAV sync-document write requires an expected ETag or an explicit create condition');
    }
    const {
        material,
        cryptoPrims,
        expectedEtag = null,
        legacyUnconditionalPlaintext: _legacyUnconditionalPlaintext,
        ...webdavOptions
    } = options;
    if (legacyPlaintext) {
        if (material) {
            throw new SyncEncryptionRemoteVersionUnavailableError('Encrypted WebDAV sync document');
        }
        if (Object.prototype.hasOwnProperty.call(options, 'expectedEtag')) {
            throw new Error('Legacy WebDAV plaintext write cannot also carry a conditional generation');
        }
        return webdavPutJson(url, data, {
            ...webdavOptions,
            disableParentCollectionRetry: true,
        });
    }
    const conditionalOptions = withWebdavDocumentWriteCondition(webdavOptions, expectedEtag);
    if (!material) {
        return webdavPutJson(url, data, conditionalOptions);
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(data, null, 2));
    const sealed = await encryptSyncArtifact(plaintext, material, cryptoPrims);
    return putWebdavBytes(syncEncryptedArtifactName(url), sealed, conditionalOptions);
}

export async function webdavMakeDirectory(
    url: string,
    options: WebDavOptions = {}
): Promise<void> {
    assertWebdavUrl(url, options);
    await ensureWebdavCollectionExists(url, options);
}

export async function webdavPutFile(
    url: string,
    data: ArrayBuffer | Uint8Array | Blob,
    contentType: string,
    options: WebDavOptions = {}
): Promise<void> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const payloadBytes = await toUint8Array(data);
    const buildRequest = (): { headers: Record<string, string>; body: BodyInit } => {
        const headers = buildHeaders(options);
        headers['Content-Type'] = contentType || 'application/octet-stream';
        headers[WEBDAV_AUTOMKCOL_HEADER] = headers[WEBDAV_AUTOMKCOL_HEADER] || '1';

        const bodyBytes = new Uint8Array(payloadBytes);
        let body: BodyInit = bodyBytes;
        if (options.onProgress) {
            const stream = createProgressStream(bodyBytes, options.onProgress);
            body = stream ?? bodyBytes;
            if (!headers['Content-Length']) {
                headers['Content-Length'] = String(bodyBytes.length);
            }
        }

        return { body, headers };
    };
    const sendPut = async (): Promise<Response> => {
        const { headers, body } = buildRequest();
        return fetchWithTimeoutAndConsume(
            url,
            { method: 'PUT', headers, body, signal: options.signal },
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            fetcher,
            WEBDAV_TIMEOUT_ERROR,
            async (response, signal) => {
                await discardResponseBody(response, signal);
                return response;
            },
        );
    };

    let res = await sendPut();
    if (!res.ok && (res.status === 404 || res.status === 409)) {
        await ensureWebdavParentCollectionsBeforePut(url, options);
        res = await sendPut();
    }

    if (!res.ok) {
        const error = new Error(`WebDAV File PUT failed (${res.status})`);
        (error as { status?: number }).status = res.status;
        throw error;
    }
}

/** Versioned byte read for encryption transitions. The strong ETag comes from the same
 * GET response as the bytes; an existing response without one is returned explicitly so
 * the transition can refuse an unsafe mutation. */
export async function webdavGetFileVersionedWithServerTime(
    url: string,
    options: WebDavOptions = {},
): Promise<{ bytes: Uint8Array | null; version: string | null; serverNowMs: number | null }> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    return await fetchWithTimeoutAndConsume(
        url,
        buildReadRequestInit(options, 'GET'),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
        async (res, signal) => {
            const parsedServerNow = Date.parse(res.headers.get('date') ?? '');
            const serverNowMs = Number.isFinite(parsedServerNow) ? parsedServerNow : null;
            if (res.status === 404) return { bytes: null, version: null, serverNowMs };
            if (!res.ok) {
                const error = new Error(`WebDAV File GET failed (${res.status})`);
                (error as { status?: number }).status = res.status;
                throw error;
            }
            return {
                bytes: new Uint8Array(await readResponseBody(
                    res,
                    options.onProgress,
                    options.maxBytes ?? MAX_DOWNLOAD_BYTES,
                    signal,
                )),
                version: normalizeStrongWebdavEtag(res.headers.get('etag')),
                serverNowMs,
            };
        },
    );
}

/** Compatibility shape for transition callers that only need bytes + strong generation. */
export async function webdavGetFileVersioned(
    url: string,
    options: WebDavOptions = {},
): Promise<{ bytes: Uint8Array | null; version: string | null }> {
    const { bytes, version } = await webdavGetFileVersionedWithServerTime(url, options);
    return { bytes, version };
}

const webdavStrongEtagProbeUrl = (documentUrl: string): string => {
    const probeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const suffixStart = documentUrl.search(/[?#]/);
    const documentPath = suffixStart === -1 ? documentUrl : documentUrl.slice(0, suffixStart);
    const suffix = suffixStart === -1 ? '' : documentUrl.slice(suffixStart);
    return `${documentPath}.mindwtr-etag-probe-${probeId}${suffix}`;
};

const WEBDAV_CONDITIONAL_PROBE_PAYLOADS = {
    initial: 'mindwtr strong-etag capability probe v1',
    replacement: 'mindwtr strong-etag capability probe v2',
    stale: 'mindwtr stale conditional-write probe',
} as const;
const WEBDAV_CONDITIONAL_PROBE_PAYLOAD_SET = new Set<string>(
    Object.values(WEBDAV_CONDITIONAL_PROBE_PAYLOADS),
);

const requireWebdavConditionalConflict = async (
    operation: () => Promise<void>,
    capability: string,
): Promise<void> => {
    try {
        await operation();
    } catch (error) {
        if (isWebdavRemoteWriteConflictError(error)) return;
        throw error;
    }
    throw new SyncEncryptionRemoteVersionUnavailableError(capability);
};

const webdavProbeBytesEqual = (left: Uint8Array | null, right: Uint8Array): boolean => {
    if (!left || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
};

const removeAccidentalWebdavProbeResidue = async (
    documentUrl: string,
    current: { bytes: Uint8Array | null; version: string | null },
    options: WebDavOptions,
): Promise<boolean> => {
    if (
        !current.bytes
        || !WEBDAV_CONDITIONAL_PROBE_PAYLOAD_SET.has(new TextDecoder().decode(current.bytes))
    ) {
        return false;
    }
    if (!current.version) {
        throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV capability-probe residue');
    }
    // A short-lived Android URL fallback regression could serialize the unique probe URL
    // back to data.json. Remove only our three byte-exact probe bodies, and only against
    // the generation read with those bytes, so a concurrent repair wins instead.
    await webdavDeleteFileVersioned(documentUrl, current.version, options);
    return true;
};

const assertWebdavConditionalWriteSupport = async (
    documentUrl: string,
    options: WebDavOptions,
): Promise<void> => {
    const probeUrl = webdavStrongEtagProbeUrl(documentUrl);
    const initialBytes = new TextEncoder().encode(WEBDAV_CONDITIONAL_PROBE_PAYLOADS.initial);
    const replacementBytes = new TextEncoder().encode(WEBDAV_CONDITIONAL_PROBE_PAYLOADS.replacement);
    const staleBytes = new TextEncoder().encode(WEBDAV_CONDITIONAL_PROBE_PAYLOADS.stale);
    let created = false;
    let hasSafeProbeVersion = false;

    try {
        await webdavPutFileVersioned(
            probeUrl,
            initialBytes,
            'application/octet-stream',
            null,
            options,
        );
        created = true;
        const initial = await webdavGetFileVersioned(probeUrl, options);
        if (!webdavProbeBytesEqual(initial.bytes, initialBytes) || !initial.version) {
            throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV capability probe');
        }
        const initialVersion = initial.version;
        hasSafeProbeVersion = true;

        await requireWebdavConditionalConflict(
            () => webdavPutFileVersioned(
                probeUrl,
                replacementBytes,
                'application/octet-stream',
                null,
                options,
            ),
            'WebDAV If-None-Match enforcement',
        );

        await webdavPutFileVersioned(
            probeUrl,
            replacementBytes,
            'application/octet-stream',
            initialVersion,
            options,
        );
        const replacement = await webdavGetFileVersioned(probeUrl, options);
        if (
            !webdavProbeBytesEqual(replacement.bytes, replacementBytes)
            || !replacement.version
            || replacement.version === initialVersion
        ) {
            throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV If-Match replacement');
        }

        await requireWebdavConditionalConflict(
            () => webdavPutFileVersioned(
                probeUrl,
                staleBytes,
                'application/octet-stream',
                initialVersion,
                options,
            ),
            'WebDAV stale If-Match enforcement',
        );

        await requireWebdavConditionalConflict(
            () => webdavDeleteFileVersioned(probeUrl, initialVersion, options),
            'WebDAV stale If-Match delete enforcement',
        );
        const retained = await webdavGetFileVersioned(probeUrl, options);
        if (
            !webdavProbeBytesEqual(retained.bytes, replacementBytes)
            || retained.version !== replacement.version
        ) {
            throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV conditional delete retention');
        }
        await webdavDeleteFileVersioned(probeUrl, retained.version, options);
        created = false;
    } finally {
        if (created && hasSafeProbeVersion) {
            // Cleanup is never unconditional. Reread because a server that ignored one of
            // the deliberate conflicts may have advanced the unique probe generation.
            const latest = await webdavGetFileVersioned(probeUrl, options).catch(() => null);
            if (latest?.bytes && latest.version) {
                await webdavDeleteFileVersioned(probeUrl, latest.version, options).catch(() => undefined);
            }
        }
    }
};

export type WebdavSyncCompatibility = 'strong-etag' | 'legacy-plaintext';

export type WebdavSyncCompatibilityPolicy = {
    requireStrongEtag?: boolean;
};

/** Validates the ordinary plaintext endpoint and reports whether it supports the full
 * generation contract. Legacy mode is observational only. When encryption requires
 * strong ETags, an absent data.json runs the unique conditional-write probe instead of
 * being mistaken for a legacy server; existing unversioned bytes still fail before any write. */
export async function probeWebdavSyncCompatibility(
    documentUrl: string,
    options: WebDavOptions = {},
    policy: WebdavSyncCompatibilityPolicy = {},
): Promise<WebdavSyncCompatibility> {
    const documentOptions = {
        ...options,
        maxBytes: options.maxBytes ?? MAX_SYNC_DOCUMENT_BYTES,
    };
    const current = await webdavGetFileVersioned(documentUrl, documentOptions);
    if (current.bytes === null) {
        if (!policy.requireStrongEtag) return 'legacy-plaintext';
        await assertWebdavConditionalWriteSupport(documentUrl, documentOptions);
        return 'strong-etag';
    }
    if (await removeAccidentalWebdavProbeResidue(documentUrl, current, documentOptions)) {
        if (!policy.requireStrongEtag) return 'legacy-plaintext';
        await assertWebdavConditionalWriteSupport(documentUrl, documentOptions);
        return 'strong-etag';
    }
    parseOptionalWebdavJson(new TextDecoder().decode(current.bytes));
    if (!current.version) {
        if (policy.requireStrongEtag) {
            throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV data.json');
        }
        return 'legacy-plaintext';
    }
    await assertWebdavConditionalWriteSupport(documentUrl, documentOptions);
    return 'strong-etag';
}

/** Preflights the generation contract required by encrypted WebDAV sync and encryption
 * transitions. An existing document must carry a strong ETag. A unique probe then proves
 * create-only, stale-replacement, and stale-delete conditions are enforced, not merely accepted as headers.
 * Cleanup rereads and conditionally deletes the probe; it never issues an unguarded delete. */
export async function assertWebdavStrongEtagSupport(
    documentUrl: string,
    options: WebDavOptions = {},
): Promise<void> {
    const documentOptions = {
        ...options,
        maxBytes: options.maxBytes ?? MAX_SYNC_DOCUMENT_BYTES,
    };
    const current = await webdavGetFileVersioned(documentUrl, documentOptions);
    if (await removeAccidentalWebdavProbeResidue(documentUrl, current, documentOptions)) {
        await assertWebdavConditionalWriteSupport(documentUrl, documentOptions);
        return;
    }
    if (current.bytes !== null) {
        if (!current.version) throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV data.json');
        // Preserve the previous Test Connection contract: the exact GET that proves a
        // strong generation must also prove that every non-empty data.json body is JSON.
        // Empty/whitespace-only bodies remain accepted, including after a UTF-8 BOM.
        parseOptionalWebdavJson(new TextDecoder().decode(current.bytes));
    }
    await assertWebdavConditionalWriteSupport(documentUrl, documentOptions);
}

/** CAS byte write used only by encryption transitions. `null` is create-only. */
export async function webdavPutFileVersioned(
    url: string,
    data: ArrayBuffer | Uint8Array | Blob,
    contentType: string,
    expectedEtag: string | null,
    options: WebDavOptions = {},
): Promise<void> {
    try {
        await webdavPutFile(
            url,
            data,
            contentType,
            withWebdavDocumentWriteCondition(options, expectedEtag),
        );
    } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        if (status === 409 || status === 412) throw new WebDavRemoteWriteConflictError(status);
        throw error;
    }
}

export async function webdavFileExists(
    url: string,
    options: WebDavOptions = {}
): Promise<boolean> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        buildReadRequestInit(options, 'HEAD'),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
    );

    if (res.status === 404) return false;
    if (res.status === 405) return true;
    if (!res.ok) {
        const error = new Error(`WebDAV HEAD failed (${res.status})`);
        (error as { status?: number }).status = res.status;
        throw error;
    }
    return true;
}

export async function webdavHeadFile(
    url: string,
    options: WebDavOptions = {}
): Promise<RemoteFileMetadata> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        buildReadRequestInit(options, 'HEAD'),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
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
        const error = new Error(`WebDAV HEAD failed (${res.status})`);
        (error as { status?: number }).status = res.status;
        throw error;
    }
    return metadataFromHeaders('webdav', res.headers, {
        allowWeakFingerprint: options.allowWeakFingerprint,
        warnOnceKey: getWebdavWeakFingerprintWarningKey(url),
        warnOnWeakFingerprint: true,
    });
}

export async function webdavGetFile(
    url: string,
    options: WebDavOptions = {}
): Promise<ArrayBuffer> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    return await fetchWithTimeoutAndConsume(
        url,
        buildReadRequestInit(options, 'GET'),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
        async (res, signal) => {
            if (!res.ok) {
                const error = new Error(`WebDAV File GET failed (${res.status})`);
                (error as { status?: number }).status = res.status;
                throw error;
            }

            return await readResponseBody(res, options.onProgress, options.maxBytes ?? MAX_DOWNLOAD_BYTES, signal);
        },
    );
}

export async function webdavDeleteFile(
    url: string,
    options: WebDavOptions = {}
): Promise<void> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    await fetchWithTimeoutAndConsume(
        url,
        { method: 'DELETE', headers: buildHeaders(options) },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
        async (res, signal) => {
            if (!res.ok && res.status !== 404) throw new Error(`WebDAV DELETE failed (${res.status})`);
            await discardResponseBody(res, signal);
        },
    );
}

/** Conditional delete for an artifact whose strong ETag was captured by the transition
 * read. Missing or changed targets are conflicts, never idempotent success. */
export async function webdavDeleteFileVersioned(
    url: string,
    expectedEtag: string,
    options: WebDavOptions = {},
): Promise<void> {
    assertWebdavUrl(url, options);
    const strongEtag = normalizeStrongWebdavEtag(expectedEtag);
    if (!strongEtag) throw new Error('WebDAV conditional delete requires a valid strong ETag');
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    headers['If-Match'] = strongEtag;
    await fetchWithTimeoutAndConsume(
        url,
        { method: 'DELETE', headers },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
        async (res, signal) => {
            if (res.status === 404 || res.status === 409 || res.status === 412) {
                throw new WebDavRemoteWriteConflictError(res.status);
            }
            if (!res.ok) throw new Error(`WebDAV DELETE failed (${res.status})`);
            await discardResponseBody(res, signal);
        },
    );
}
