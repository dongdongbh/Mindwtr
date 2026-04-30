import {
    DEFAULT_TIMEOUT_MS,
    assertSecureUrl,
    concatChunks,
    createProgressStream,
    fetchWithTimeout,
    toArrayBuffer,
    toUint8Array,
} from './http-utils';

export interface WebDavOptions {
    username?: string;
    password?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    fetcher?: typeof fetch;
    onProgress?: (loaded: number, total: number) => void;
    allowInsecureHttp?: boolean;
}

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
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (options.username && typeof options.password === 'string') {
        headers.Authorization = `Basic ${encodeBase64Utf8(`${options.username}:${options.password}`)}`;
    }
    return headers;
}

const WEBDAV_HTTPS_ERROR = 'WebDAV requires HTTPS for public URLs (HTTP allowed for localhost, private IPs, and local hostnames).';
const WEBDAV_INSECURE_OPTIONS = { allowAndroidEmulatorInDev: true, allowLocalHostnames: true, allowPrivateIpRanges: true };
const WEBDAV_TIMEOUT_ERROR = 'WebDAV request timed out';
const WEBDAV_AUTOMKCOL_HEADER = 'X-NC-WebDAV-AutoMkcol';
const UTF8_BOM = '\uFEFF';

const assertWebdavUrl = (url: string, options: WebDavOptions): void => {
    if (options.allowInsecureHttp) return;
    assertSecureUrl(url, WEBDAV_HTTPS_ERROR, WEBDAV_INSECURE_OPTIONS);
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
    return fetchWithTimeout(
        normalizeWebdavCollectionUrl(url),
        { method: 'MKCOL', headers: buildHeaders(options) },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
    );
};

const webdavCollectionExists = async (
    url: string,
    options: WebDavOptions,
): Promise<boolean> => {
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
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
    );

    if (res.status === 404) return false;
    if (res.ok || res.status === 405) return true;
    const error = new Error(`WebDAV PROPFIND failed (${res.status})`);
    (error as { status?: number }).status = res.status;
    throw error;
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

export async function webdavGetJson<T>(
    url: string,
    options: WebDavOptions = {}
): Promise<T | null> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        {
            method: 'GET',
            headers: buildHeaders(options),
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
    );

    if (res.status === 404) return null;
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = new Error(`WebDAV GET failed (${res.status}): ${text || res.statusText}`);
        (error as { status?: number }).status = res.status;
        throw error;
    }

    const text = await res.text();
    const normalizedBody = text.startsWith(UTF8_BOM) ? text.slice(1).trim() : text.trim();
    if (!normalizedBody) return null;
    try {
        return JSON.parse(normalizedBody) as T;
    } catch (error) {
        throw new Error(`WebDAV GET failed: invalid JSON (${(error as Error).message})`);
    }
}

export async function webdavPutJson(
    url: string,
    data: unknown,
    options: WebDavOptions = {}
): Promise<void> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    headers[WEBDAV_AUTOMKCOL_HEADER] = headers[WEBDAV_AUTOMKCOL_HEADER] || '1';

    const payload = JSON.stringify(data, null, 2);
    const sendPut = async (): Promise<Response> => fetchWithTimeout(
        url,
        {
            method: 'PUT',
            headers,
            body: payload,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
    );

    let res = await sendPut();
    if (!res.ok && (res.status === 404 || res.status === 409)) {
        await ensureWebdavParentCollectionsBeforePut(url, options);
        res = await sendPut();
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = new Error(`WebDAV PUT failed (${res.status}): ${text || res.statusText}`);
        (error as { status?: number }).status = res.status;
        throw error;
    }
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
        return fetchWithTimeout(
            url,
            { method: 'PUT', headers, body },
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            fetcher,
            WEBDAV_TIMEOUT_ERROR,
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

export async function webdavFileExists(
    url: string,
    options: WebDavOptions = {}
): Promise<boolean> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        { method: 'HEAD', headers: buildHeaders(options) },
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

export async function webdavGetFile(
    url: string,
    options: WebDavOptions = {}
): Promise<ArrayBuffer> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        { method: 'GET', headers: buildHeaders(options) },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
    );

    if (!res.ok) {
        const error = new Error(`WebDAV File GET failed (${res.status})`);
        (error as { status?: number }).status = res.status;
        throw error;
    }

    const onProgress = options.onProgress;
    if (!onProgress || !res.body || typeof res.body.getReader !== 'function') {
        return await res.arrayBuffer();
    }

    const reader = res.body.getReader();
    const total = Number(res.headers.get('content-length') || 0);
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            received += value.length;
            onProgress(received, total);
        }
    }
    const merged = concatChunks(chunks, total || received);
    return toArrayBuffer(merged);
}

export async function webdavDeleteFile(
    url: string,
    options: WebDavOptions = {}
): Promise<void> {
    assertWebdavUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        { method: 'DELETE', headers: buildHeaders(options) },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        WEBDAV_TIMEOUT_ERROR,
    );

    if (!res.ok && res.status !== 404) {
        throw new Error(`WebDAV DELETE failed (${res.status})`);
    }
}
