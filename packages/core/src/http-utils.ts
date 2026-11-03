import { DEFAULT_MAX_FILE_SIZE_BYTES } from './attachment-validation';
import { logWarn } from './logger';

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


export const MAX_DOWNLOAD_BYTES = 2 * DEFAULT_MAX_FILE_SIZE_BYTES;


export const MAX_SYNC_DOCUMENT_BYTES = 1024 * 1024 * 1024;


export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export class ResponseTooLargeError extends Error {
    readonly limitBytes: number;

    constructor(limitBytes: number) {
        super(`Response exceeds the ${limitBytes} byte download limit`);
        this.name = 'ResponseTooLargeError';
        this.limitBytes = limitBytes;
    }
}


export const isHostResponseTooLargeError = (
    error: unknown,
): error is Error & { code: 'response-too-large'; limitBytes: number } => {
    if (!(error instanceof Error)) return false;
    const fields = error as Error & { code?: unknown; limitBytes?: unknown };
    return fields.code === 'response-too-large'
        && typeof fields.limitBytes === 'number'
        && Number.isSafeInteger(fields.limitBytes)
        && fields.limitBytes > 0;
};

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


    }
};


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


export const readDecodedResponseText = async (
    res: Response,
    limitBytes: number,
    signal?: AbortSignal,
): Promise<string | null> => {
    const bytes = (res as { mindwtrDecodedTextBytes?: unknown }).mindwtrDecodedTextBytes;
    if (typeof bytes !== 'number') return null;
    if (bytes > limitBytes) throw new ResponseTooLargeError(limitBytes);
    return await waitForAbort(res.text(), signal);
};


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
    const decoded = await readDecodedResponseText(res, limitBytes, signal);
    if (decoded !== null) return decoded;
    if (res.body || typeof res.arrayBuffer === 'function') {
        return new TextDecoder().decode(await readResponseBody(res, undefined, limitBytes, signal));
    }
    const text = await waitForAbort(res.text(), signal);
    if (text.length > limitBytes) throw new ResponseTooLargeError(limitBytes);
    return text;
};


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


const NO_REDIRECT_METHODS = new Set(['PUT', 'POST', 'PATCH', 'DELETE']);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);


export const refuseWriteRedirect = (context: { releaseCheck: string; method: string; status: number }): never => {
    logWarn('Write request redirect refused', { scope: 'http', category: 'network', context });
    throw new TypeError('fetch failed: unexpected redirect');
};

const UNRESERVED_CHAR = /^[A-Za-z0-9\-._~]$/;

const PATH_OR_QUERY_CHAR = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$/;


const normalizePercentEncoding = (text: string): string => {
    let normalized = '';
    for (let index = 0; index < text.length;) {
        const escape = text.slice(index, index + 3);
        if (/^%[0-9A-Fa-f]{2}$/.test(escape)) {
            const decoded = String.fromCharCode(parseInt(escape.slice(1), 16));
            normalized += UNRESERVED_CHAR.test(decoded) ? decoded : escape.toUpperCase();
            index += 3;
            continue;
        }
        const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
        if (PATH_OR_QUERY_CHAR.test(char)) {
            normalized += char;
        } else {
            try {
                normalized += encodeURIComponent(char);
            } catch {
                normalized += char;
            }
        }
        index += char.length;
    }
    return normalized;
};


const encodePunycode = (label: string): string => {
    const base = 36;
    const tMin = 1;
    const tMax = 26;
    const digit = (value: number) => String.fromCharCode(value + (value < 26 ? 97 : 22));
    const adapt = (delta: number, points: number, first: boolean): number => {
        let scaled = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
        scaled += Math.floor(scaled / points);
        let k = 0;
        for (; scaled > ((base - tMin) * tMax) / 2; k += base) {
            scaled = Math.floor(scaled / (base - tMin));
        }
        return k + Math.floor(((base - tMin + 1) * scaled) / (scaled + 38));
    };
    const codePoints = Array.from(label, (char) => char.codePointAt(0) ?? 0);
    let output = codePoints.filter((point) => point < 0x80).map((point) => String.fromCharCode(point)).join('');
    const basicCount = output.length;
    if (basicCount > 0) output += '-';
    let handled = basicCount;
    let next = 0x80;
    let delta = 0;
    let bias = 72;
    while (handled < codePoints.length) {
        const smallest = Math.min(...codePoints.filter((point) => point >= next));
        delta += (smallest - next) * (handled + 1);
        next = smallest;
        for (const point of codePoints) {
            if (point < next) delta += 1;
            if (point !== next) continue;
            let q = delta;
            for (let k = base; ; k += base) {
                const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
                if (q < t) break;
                output += digit(t + ((q - t) % (base - t)));
                q = Math.floor((q - t) / (base - t));
            }
            output += digit(q);
            bias = adapt(delta, handled + 1, handled === basicCount);
            delta = 0;
            handled += 1;
        }
        delta += 1;
        next += 1;
    }
    return output;
};


const asciiHostname = (host: string): string => (typeof host.normalize === 'function' ? host.normalize('NFC') : host)
    .split(/[.。．｡]/)
    .map((label) => {
        if (!/[\u0080-\uffff]/.test(label)) return label;
        if (label.length > 63) throw new RangeError('host label too long');
        return `xn--${encodePunycode(label)}`;
    })
    .join('.');


const removeDotSegments = (path: string): string => {
    const segments = path.split('/');
    const kept: string[] = [];
    segments.forEach((segment, index) => {
        if (segment === '.' || segment === '..') {
            if (segment === '..' && kept.length > 1) kept.pop();
            if (index === segments.length - 1) kept.push('');
            return;
        }
        kept.push(segment);
    });
    return kept.join('/') || '/';
};


const parseIpv6Groups = (text: string): number[] | null => {
    if (!text) return [];
    const groups: number[] = [];
    const pieces = text.split(':');
    for (const [index, piece] of pieces.entries()) {
        const ipv4 = index === pieces.length - 1 && piece.includes('.') ? parseIpv4Host(piece) : null;
        if (ipv4) {
            groups.push(ipv4[0] * 256 + ipv4[1], ipv4[2] * 256 + ipv4[3]);
        } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
            groups.push(parseInt(piece, 16));
        } else {
            return null;
        }
    }
    return groups;
};


const canonicalIpv6 = (literal: string): string => {
    const zoneAt = literal.indexOf('%');
    const address = zoneAt < 0 ? literal : literal.slice(0, zoneAt);
    const zone = zoneAt < 0 ? '' : literal.slice(zoneAt);
    const halves = address.split('::');
    if (halves.length > 2) return `[${literal}]`;
    const head = parseIpv6Groups(halves[0]);
    const tail = halves.length === 2 ? parseIpv6Groups(halves[1]) : [];
    if (!head || !tail) return `[${literal}]`;
    const missing = 8 - head.length - tail.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) return `[${literal}]`;
    const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];

    if (!zone && groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
        return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
    }
    return `[${groups.map((group) => group.toString(16)).join(':')}${zone}]`;
};


const numericIpv4Host = (host: string): string | null => {
    const parts = host.split('.');
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    if (parts.length > 4 || !/^(0x[0-9a-f]*|\d+)$/.test(parts[parts.length - 1])) return null;
    const values = parts.map((part) => {
        if (/^0x[0-9a-f]*$/.test(part)) return parseInt(part.slice(2) || '0', 16);
        if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
        return /^(0|[1-9]\d*)$/.test(part) ? Number(part) : NaN;
    });
    const last = values.pop() ?? NaN;
    if (values.some((value) => !(value <= 255)) || !(last < 256 ** (4 - values.length))) return null;
    const address = values.reduce((sum, value, index) => sum + value * 256 ** (3 - index), last);
    return [3, 2, 1, 0].map((shift) => Math.floor(address / 256 ** shift) % 256).join('.');
};


const comparableHttpUrl = (rawUrl: string): string | null => {

    const trimmed = rawUrl.trim();

    encodeURI(trimmed);
    const queryAt = trimmed.search(/[?#]/);
    const url = queryAt < 0
        ? trimmed.replace(/\\/g, '/')
        : `${trimmed.slice(0, queryAt).replace(/\\/g, '/')}${trimmed.slice(queryAt)}`;
    const match = url.match(/^(https?):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i);
    if (!match) return null;
    const scheme = match[1].toLowerCase();
    const authority = match[2].slice(match[2].lastIndexOf('@') + 1).toLowerCase();
    const portMatch = authority.match(/:(\d*)$/);
    const encodedHost = portMatch ? authority.slice(0, -portMatch[0].length) : authority;
    const ipv6 = encodedHost.match(/^\[(.*)\]$/);

    let host = encodedHost;
    try {
        host = decodeURIComponent(encodedHost).toLowerCase();
    } catch {

    }
    const comparableHost = ipv6 ? canonicalIpv6(ipv6[1]) : numericIpv4Host(host) ?? asciiHostname(host);
    const port = portMatch?.[1] ? Number(portMatch[1]) : null;
    const comparablePort = port === null || port === (scheme === 'https' ? 443 : 80) ? '' : String(port);
    const path = removeDotSegments(normalizePercentEncoding(match[3] || '/'));
    const query = normalizePercentEncoding(match[4] ?? '');
    return `${scheme}://${comparableHost}:${comparablePort}${path}?${query}`;
};


export const isAnsweredFromAnotherUrl = (requestedUrl: string, answeredUrl: unknown): boolean => {
    if (typeof answeredUrl !== 'string' || !answeredUrl) return false;
    try {
        const requested = comparableHttpUrl(requestedUrl);
        const answered = comparableHttpUrl(answeredUrl);
        return requested !== null && answered !== null && requested !== answered;
    } catch {
        logWarn('Write redirect check skipped: a URL could not be compared', { scope: 'http', category: 'network' });
        return false;
    }
};


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
        if (requestInit.redirect === 'error') {
            const handedBack = REDIRECT_STATUSES.has(response.status);
            if (handedBack || isAnsweredFromAnotherUrl(url, response.url)) {
                cancelUnlockedResponseBody(response);
                refuseWriteRedirect({
                    releaseCheck: handedBack ? 'v1.3.3/fetch-redirect-refused' : 'v1.3.4/fetch-redirect-refused-ios',
                    method: (init.method ?? 'GET').toUpperCase(),
                    status: response.status,
                });
            }
        }
        try {
            return await waitForAbort(
                consume(response, signal),
                signal,
                () => cancelUnlockedResponseBody(response),
            );
        } finally {


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
