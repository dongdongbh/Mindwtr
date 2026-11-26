import { logInfo } from './app-log';
import { invokeNative } from './tauri-invoke';

export const isLocalWebdavFolder = (folder?: string): folder is string => {
    if (!folder) return false;
    try {
        const url = new URL(folder);
        return ['http:', 'https:'].includes(url.protocol)
            && ['127.0.0.1', '[::1]'].includes(url.hostname)
            && url.pathname.startsWith('/webdav/data/')
            && (!url.pathname.replace(/\/+$/, '').toLowerCase().endsWith('.json') || url.pathname.endsWith('/data.json'))
            && !url.username && !url.password && !url.search && !url.hash;
    } catch {
        return false;
    }
};

let reportedNativeRead = false;

export const localWebdavFetch = (folder: string, fallback: typeof fetch): typeof fetch => async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const signal = init?.signal ?? request?.signal;
    const method = init?.method ?? request?.method ?? 'GET';
    const checkAbort = () => {
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    };
    const headers = new Headers(init?.headers ?? request?.headers);
    const authorization = headers.get('authorization');
    if (!authorization?.startsWith('Basic ')) return fallback(input, init);
    checkAbort();
    headers.delete('authorization');
    const url = request?.url ?? String(input);
    const upload = init?.body ?? request?.body;
    const body = upload ? Array.from(new Uint8Array(await new Response(upload).arrayBuffer())) : [];
    checkAbort();
    const rid = await invokeNative<number>('local_webdav_prepare', {
        request: { folder, url, method, authorization, headers: Object.fromEntries(headers), body },
    });
    let close: Promise<void> | undefined;
    const dispose = () => { close ??= invokeNative<void>('local_webdav_close', { rid }).catch(() => undefined); };
    signal?.addEventListener('abort', dispose, { once: true });
    let frame: Uint8Array<ArrayBuffer>;
    try {
        checkAbort();
        frame = new Uint8Array(await invokeNative<ArrayBuffer>('local_webdav_send', { rid }));
        checkAbort();
    } finally {
        signal?.removeEventListener('abort', dispose);
        dispose();
        await close;
    }
    const split = frame.indexOf(10);
    if (split < 0) throw new Error('Invalid native WebDAV response');
    const [status, responseHeaders] = JSON.parse(new TextDecoder().decode(frame.subarray(0, split))) as [number, Record<string, string>];
    const empty = method === 'HEAD' || [204, 205, 304].includes(status);
    const response = new Response(empty ? null : frame.subarray(split + 1), { status, headers: responseHeaders });
    Object.defineProperty(response, 'url', { value: url });
    if (!reportedNativeRead && method === 'GET' && response.ok) {
        reportedNativeRead = true;
        void logInfo('Local WebDAV native read completed', {
            scope: 'sync', force: true, extra: { releaseCheck: 'v1.3.10/local-webdav-native', outcome: 'received' },
        });
    }
    return response;
};
