import { DEFAULT_MAX_FILE_SIZE_BYTES } from './attachment-validation';

export type InsecureUrlOptions = {
    allowAndroidEmulator?: boolean;
    allowAndroidEmulatorInDev?: boolean;
    allowLocalHostnames?: boolean;
    allowPrivateIpRanges?: boolean;
};

export type ConnectionAllowedOptions = InsecureUrlOptions & {
    allowInsecureHttp?: boolean;
};

export const DEFAULT_TIMEOUT_MS = 30_000;

export const SYNC_LOCAL_INSECURE_URL_OPTIONS: InsecureUrlOptions = {
    allowAndroidEmulatorInDev: true,
    allowLocalHostnames: true,
    allowPrivateIpRanges: true,
};

type Ipv4Octets = [number, number, number, number];

type UrlSecurityParts = {
    hostname: string;
    protocol: string;
};

export const isAbortError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null || !('name' in error)) return false;
    const name = (error as { name?: unknown }).name;
    return name === 'AbortError';
};

const createAbortError = (message: string): Error => {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
};

const getAbortSignalReason = (signal: AbortSignal, fallbackMessage: string): Error => {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    if (typeof reason === 'string' && reason.trim()) return createAbortError(reason);
    return createAbortError(fallbackMessage);
};

const waitForAbort = async <T>(
    operation: PromiseLike<T> | T,
    signal?: AbortSignal,
    onAbort?: () => void,
): Promise<T> => {
    const promise = Promise.resolve(operation);
    if (!signal) return promise;
    if (signal.aborted) {
        // The operation may already have been invoked by the caller before the
        // signal check. Observe its eventual rejection even though cancellation
        // wins this race, otherwise an abort-aware fetcher can surface it as an
        // unhandled rejection after the bounded call has returned.
        void promise.catch(() => undefined);
        onAbort?.();
        throw getAbortSignalReason(signal, 'Request cancelled');
    }

    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', handleAbort);
            callback();
        };
        const handleAbort = () => finish(() => {
            onAbort?.();
            reject(getAbortSignalReason(signal, 'Request cancelled'));
        });
        signal.addEventListener('abort', handleAbort, { once: true });
        promise.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error)),
        );
    });
};

const getCause = (value: unknown): unknown => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return undefined;
    }
    return (value as { cause?: unknown }).cause;
};

const getErrorLikeMessage = (value: unknown): string => {
    if (value instanceof Error) return value.message;
    if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
        const message = (value as { message?: unknown }).message;
        if (typeof message === 'string') return message;
    }
    return typeof value === 'string' ? value : '';
};

const appendErrorCauseChain = (error: unknown): unknown => {
    if (!(error instanceof Error)) return error;

    const rootMessage = error.message;
    const causes: string[] = [];
    const seen = new Set<unknown>([error]);
    let cause = getCause(error);

    while (cause !== undefined && cause !== null && !seen.has(cause)) {
        seen.add(cause);
        const detail = getErrorLikeMessage(cause).trim();
        if (detail && detail !== rootMessage && !causes.includes(detail)) {
            causes.push(detail);
        }
        cause = getCause(cause);
    }

    if (causes.length === 0 || rootMessage.includes('(caused by:')) {
        return error;
    }

    const message = `${rootMessage} (caused by: ${causes.join(' -> ')})`;
    try {
        error.message = message;
        return error;
    } catch {
        const enriched = new Error(message);
        enriched.name = error.name;
        (enriched as Error & { cause?: unknown }).cause = error;
        return enriched;
    }
};

const parseIpv4Host = (host: string): Ipv4Octets | null => {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of parts) {
        if (!/^\d+$/.test(part)) return null;
        const value = Number(part);
        if (!Number.isInteger(value) || value < 0 || value > 255) return null;
        octets.push(value);
    }
    return [octets[0], octets[1], octets[2], octets[3]];
};

const extractHostnameFromAuthority = (authority: string): string => {
    const atIndex = authority.lastIndexOf('@');
    const hostPort = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
    if (hostPort.startsWith('[')) {
        const endBracket = hostPort.indexOf(']');
        return endBracket > 0 ? hostPort.slice(1, endBracket).toLowerCase() : '';
    }
    return (hostPort.split(':')[0] ?? '').toLowerCase();
};

const parseUrlSecurityParts = (rawUrl: string): UrlSecurityParts | null => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    let protocol = '';
    let hostname = '';
    try {
        const parsed = new URL(trimmed);
        protocol = String(parsed.protocol || '').toLowerCase();
        hostname = typeof parsed.hostname === 'string' ? parsed.hostname.toLowerCase() : '';
    } catch {
        // Fall back below. Some React Native URL shims parse the protocol but
        // do not expose hostname for plain local HTTP names.
    }

    const authorityMatch = trimmed.match(/^([a-z][a-z0-9.+-]*:)?\/\/([^/?#]*)/i);
    if (!protocol && authorityMatch?.[1]) {
        protocol = authorityMatch[1].toLowerCase();
    }
    if (!hostname && authorityMatch) {
        hostname = extractHostnameFromAuthority(authorityMatch[2] ?? '');
    }

    if ((protocol === 'http:' || protocol === 'https:') && !hostname) return null;
    return protocol ? { hostname, protocol } : null;
};

const isLikelyLocalHostname = (host: string): boolean => {
    if (!host) return false;
    if (host.includes('.')) {
        return host.endsWith('.local')
            || host.endsWith('.localdomain')
            || host.endsWith('.home.arpa');
    }
    return /^[a-z0-9-]+$/i.test(host);
};

const isPrivateIpv6Host = (host: string): boolean => {
    const normalized = host.toLowerCase();
    return normalized === '::1'
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || normalized.startsWith('fe80:');
};

export const isAllowedInsecureUrl = (rawUrl: string, options: InsecureUrlOptions = {}): boolean => {
    const parsed = parseUrlSecurityParts(rawUrl);
    if (!parsed) return false;
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'http:') return false;
    const host =
        parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
            ? parsed.hostname.slice(1, -1)
            : parsed.hostname;
    if (host === 'localhost' || host === '::1') return true;
    const ipv4 = parseIpv4Host(host);
    if (ipv4 && ipv4[0] === 127) return true;
    if (options.allowPrivateIpRanges && ipv4) {
        const [first, second] = ipv4;
        if (first === 10) return true;
        if (first === 172 && second >= 16 && second <= 31) return true;
        if (first === 192 && second === 168) return true;
        if (first === 100 && second >= 64 && second <= 127) return true;
    }
    if (options.allowPrivateIpRanges && host.includes(':') && isPrivateIpv6Host(host)) return true;
    if (options.allowLocalHostnames && !ipv4 && isLikelyLocalHostname(host)) return true;
    if (host === '10.0.2.2') {
        if (options.allowAndroidEmulator) return true;
        if (options.allowAndroidEmulatorInDev) {
            const isDev =
                typeof globalThis !== 'undefined' && (globalThis as { __DEV__?: boolean }).__DEV__ === true;
            return isDev;
        }
    }
    return false;
};

export const isConnectionAllowed = (rawUrl: string, options: ConnectionAllowedOptions = {}): boolean => {
    if (isAllowedInsecureUrl(rawUrl, options)) return true;
    // Explicit user opt-in (#920): the app cannot tell a private DNS/VPN/Tailscale
    // hostname from a public one, so the toggle vouches for the host. Callers warn
    // via isManualInsecureOverride when this branch is what admitted the URL.
    if (!options.allowInsecureHttp) return false;
    return parseUrlSecurityParts(rawUrl)?.protocol === 'http:';
};

export const assertConnectionAllowed = (url: string, message: string, options?: ConnectionAllowedOptions) => {
    if (!isConnectionAllowed(url, options)) {
        throw new Error(message);
    }
};

export const assertSecureUrl = assertConnectionAllowed;

export const toUint8Array = async (
    data: ArrayBuffer | Uint8Array | Blob
): Promise<Uint8Array<ArrayBuffer>> => {
    // Vitest/browser/native callers can hand us a typed array created in a
    // different JavaScript realm, where `instanceof Uint8Array` is false.
    // ArrayBuffer.isView is realm-safe and keeps those bytes on the binary
    // path instead of incorrectly treating the view as a Blob.
    if (ArrayBuffer.isView(data)) {
        const view = data as Uint8Array;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(await data.arrayBuffer());
};

export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
    if (bytes.buffer instanceof ArrayBuffer) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return new Uint8Array(bytes).buffer;
};

export const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
    if (total <= 0) {
        total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return merged;
};

/**
 * Ceiling on anything we download from a sync remote. 2x the per-attachment upload
 * cap because the same getters also fetch the sync document itself, which is not an
 * attachment and so is not bounded by that cap -- it needs headroom above it.
 */
export const MAX_DOWNLOAD_BYTES = 2 * DEFAULT_MAX_FILE_SIZE_BYTES;

/**
 * Ceiling for the sync document itself, which is a whole library and has nothing to do
 * with the per-attachment cap -- a big library legitimately exceeds it. Well above any
 * plausible library (a 100k-task export is single-digit MB) while still bounding what a
 * hostile or broken server can make us allocate.
 */
export const MAX_SYNC_DOCUMENT_BYTES = 1024 * 1024 * 1024;

/** An HTTP error body only ever becomes a message suffix, so it needs a much smaller
 *  ceiling than a document -- and it is attacker-controlled on every failure path. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export class ResponseTooLargeError extends Error {
    readonly limitBytes: number;

    constructor(limitBytes: number) {
        super(`Response exceeds the ${limitBytes} byte download limit`);
        this.name = 'ResponseTooLargeError';
        this.limitBytes = limitBytes;
    }
}

const cancelUnlockedResponseBody = (res: Response): void => {
    const body = res.body;
    if (!body || body.locked || res.bodyUsed) return;
    try {
        if (typeof body.cancel === 'function') {
            void body.cancel().catch(() => undefined);
            return;
        }
        const reader = body.getReader?.();
        void reader?.cancel().catch(() => undefined);
    } catch {
        // Cancellation is best-effort; the original protocol/consumer failure
        // remains authoritative.
    }
};

/**
 * Reads a response body with a hard byte ceiling. A server-declared Content-Length is
 * only ever used to reject early and to report progress -- never to size an allocation,
 * so a lying or absent header still aborts once the running total passes the limit.
 */
export const readResponseBody = async (
    res: Response,
    onProgress?: (loaded: number, total: number) => void,
    limitBytes: number = MAX_DOWNLOAD_BYTES,
    signal?: AbortSignal,
): Promise<ArrayBuffer> => {
    const declared = Number(res.headers?.get('content-length') || 0);
    const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (total > limitBytes) {
        cancelUnlockedResponseBody(res);
        throw new ResponseTooLargeError(limitBytes);
    }

    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
        const buffer = await waitForAbort(res.arrayBuffer(), signal);
        if (buffer.byteLength > limitBytes) throw new ResponseTooLargeError(limitBytes);
        return buffer;
    }

    const reader = body.getReader();
    const cancelReader = () => {
        try {
            void reader.cancel().catch(() => undefined);
        } catch {
            // A transport abort remains authoritative even if a test double or
            // native stream throws synchronously while acknowledging cancellation.
        }
    };
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
        while (true) {
            const { done, value } = await waitForAbort(reader.read(), signal, cancelReader);
            if (done) break;
            if (!value) continue;
            received += value.length;
            if (received > limitBytes) throw new ResponseTooLargeError(limitBytes);
            chunks.push(value);
            onProgress?.(received, total);
        }
    } catch (error) {
        cancelReader();
        throw error;
    }
    return toArrayBuffer(concatChunks(chunks, received));
};

/** Text counterpart of {@link readResponseBody}: `res.text()` is unbounded. Streams when
 *  the response exposes a body or arrayBuffer, so a lying content-length still aborts
 *  mid-read; a response offering only `text()` is length-checked after the fact. */
export const readResponseText = async (
    res: Response,
    limitBytes: number,
    signal?: AbortSignal,
): Promise<string> => {
    const declared = Number(res.headers?.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > limitBytes) {
        cancelUnlockedResponseBody(res);
        throw new ResponseTooLargeError(limitBytes);
    }
    if (res.body || typeof res.arrayBuffer === 'function') {
        return new TextDecoder().decode(await readResponseBody(res, undefined, limitBytes, signal));
    }
    const text = await waitForAbort(res.text(), signal);
    if (text.length > limitBytes) throw new ResponseTooLargeError(limitBytes);
    return text;
};

/** Consume and discard a response while retaining the caller's timeout/abort lifetime. */
export const discardResponseBody = async (
    res: Response,
    signal?: AbortSignal,
    limitBytes: number = MAX_ERROR_BODY_BYTES,
): Promise<void> => {
    if (res.body || typeof res.arrayBuffer === 'function') {
        await readResponseBody(res, undefined, limitBytes, signal);
        return;
    }
    await readResponseText(res, limitBytes, signal);
};

export const createProgressStream = (bytes: Uint8Array, onProgress: (loaded: number, total: number) => void) => {
    if (typeof ReadableStream !== 'function') return null;
    const total = bytes.length;
    const chunkSize = 64 * 1024;
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= total) {
                controller.close();
                return;
            }
            const nextChunk = bytes.slice(offset, Math.min(total, offset + chunkSize));
            offset += nextChunk.length;
            controller.enqueue(nextChunk);
            onProgress(offset, total);
        },
    });
};

/**
 * Methods whose request carries a body worth stealing. `fetch` drops the Authorization
 * header cross-origin but replays the BODY, so a compromised endpoint answering a PUT
 * with `307 Location: attacker.example` would be handed the whole sync document. Reads
 * keep the default `follow` -- WebDAV servers legitimately 301 collection URLs.
 * Known ceiling: React Native's XHR-backed fetch ignores `redirect`, so this only binds
 * on undici/browser fetch (desktop, cloud, MCP).
 */
const NO_REDIRECT_METHODS = new Set(['PUT', 'POST', 'PATCH', 'DELETE']);

/** Appended to a timeout message when the timer fired far later than its delay:
 *  the app was suspended by the OS with the request in flight. Sync treats it
 *  like a dropped connection (retry later, no failure banner). */
export const SUSPENDED_REQUEST_MESSAGE = 'the request was interrupted while the app was suspended';
const SUSPENDED_REQUEST_FACTOR = 3;

export const fetchWithTimeoutAndConsume = async <T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    fetcher: typeof fetch,
    timeoutMessage: string,
    consume: (response: Response, signal?: AbortSignal) => PromiseLike<T> | T,
): Promise<T> => {
    const abortController = typeof AbortController === 'function' ? new AbortController() : null;
    let didTimeout = false;
    let firedAfterSuspension = false;
    const startedAt = Date.now();
    const timeoutId = abortController
        ? setTimeout(() => {
            didTimeout = true;
            // A timer that fires hours late means the OS froze the process with
            // the request in flight (Android cached-app freezer, doze); the
            // socket is dead and the "timeout" is really an interruption.
            firedAfterSuspension = Date.now() - startedAt > timeoutMs * SUSPENDED_REQUEST_FACTOR;
            abortController.abort(createAbortError(timeoutMessage));
        }, timeoutMs)
        : null;

    const signal = abortController?.signal ?? init.signal ?? undefined;
    const externalSignal = init.signal;
    let externalAbortListener: (() => void) | null = null;
    if (abortController && externalSignal) {
        if (externalSignal.aborted) {
            abortController.abort(getAbortSignalReason(externalSignal, 'Request cancelled'));
        } else {
            externalAbortListener = () => {
                abortController.abort(getAbortSignalReason(externalSignal, 'Request cancelled'));
            };
            externalSignal.addEventListener('abort', externalAbortListener, { once: true });
        }
    }

    try {
        const requestInit: RequestInit & { duplex?: 'half' } = { ...init, signal };
        if (NO_REDIRECT_METHODS.has((init.method ?? 'GET').toUpperCase())) {
            requestInit.redirect = 'error';
        }
        const body = requestInit.body;
        const isReadableStreamBody = typeof ReadableStream === 'function'
            && body instanceof ReadableStream;
        if (isReadableStreamBody) {
            requestInit.duplex = 'half';
        }
        const response = await waitForAbort(fetcher(url, requestInit), signal);
        try {
            return await waitForAbort(
                consume(response, signal),
                signal,
                () => cancelUnlockedResponseBody(response),
            );
        } finally {
            // Status-only consumers can return normally for expected misses (404,
            // Dropbox metadata 409) without ever locking the response stream. Close
            // that body as eagerly as rejection/abort paths so the connection cannot
            // stay occupied by an unbounded or malicious error payload.
            cancelUnlockedResponseBody(response);
        }
    } catch (error) {
        if (isAbortError(error)) {
            if (didTimeout) {
                throw new Error(firedAfterSuspension
                    ? `${timeoutMessage}; ${SUSPENDED_REQUEST_MESSAGE}`
                    : timeoutMessage);
            }
            if (externalSignal?.aborted) {
                throw getAbortSignalReason(externalSignal, 'Request cancelled');
            }
            throw new Error(timeoutMessage);
        }
        throw appendErrorCauseChain(error);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (externalSignal && externalAbortListener) {
            externalSignal.removeEventListener('abort', externalAbortListener);
        }
    }
};

/** Header-only compatibility helper. Callers that consume a response body must use
 * `fetchWithTimeoutAndConsume` so the request timeout and external abort listener stay
 * active until that consumption settles. */
export const fetchWithTimeout = (
    url: string,
    init: RequestInit,
    timeoutMs: number,
    fetcher: typeof fetch,
    timeoutMessage: string,
): Promise<Response> => fetchWithTimeoutAndConsume(
    url,
    init,
    timeoutMs,
    fetcher,
    timeoutMessage,
    (response) => response,
);
