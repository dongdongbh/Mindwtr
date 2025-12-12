export interface WebDavOptions {
    username?: string;
    password?: string;
    headers?: Record<string, string>;
}

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
    const btoaFn = (globalThis as any).btoa as ((input: string) => string) | undefined;
    if (typeof btoaFn === 'function') {
        try {
            return btoaFn(unescape(encodeURIComponent(value)));
        } catch {
            // fall through
        }
    }

    const encoder = (globalThis as any).TextEncoder as typeof TextEncoder | undefined;
    if (typeof encoder === 'function') {
        return bytesToBase64(new encoder().encode(value));
    }

    const bytes = new Uint8Array(value.split('').map((c) => c.charCodeAt(0) & 0xff));
    return bytesToBase64(bytes);
}

function buildHeaders(options: WebDavOptions): Record<string, string> {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (options.username && typeof options.password === 'string') {
        headers.Authorization = `Basic ${encodeBase64Utf8(`${options.username}:${options.password}`)}`;
    }
    return headers;
}

export async function webdavGetJson<T>(
    url: string,
    options: WebDavOptions = {}
): Promise<T | null> {
    const res = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(options),
    });

    if (res.status === 404) return null;
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`WebDAV GET failed (${res.status}): ${text || res.statusText}`);
    }

    const text = await res.text();
    return JSON.parse(text) as T;
}

export async function webdavPutJson(
    url: string,
    data: unknown,
    options: WebDavOptions = {}
): Promise<void> {
    const headers = buildHeaders(options);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';

    const res = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(data, null, 2),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`WebDAV PUT failed (${res.status}): ${text || res.statusText}`);
    }
}

