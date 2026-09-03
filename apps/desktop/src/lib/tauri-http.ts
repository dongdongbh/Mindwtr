import { useTaskStore, type AppSettings } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';

type TauriHttpFetch = typeof fetch;
type TauriFetchInit = RequestInit & {
    proxy?: {
        all?: string;
    };
};

export const normalizeProxyUrl = (value: unknown): string => (
    typeof value === 'string' ? value.trim() : ''
);

export const isSupportedProxyUrl = (value: string): boolean => {
    const trimmed = normalizeProxyUrl(value);
    if (!trimmed) return true;
    try {
        const protocol = new URL(trimmed).protocol;
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
};

export const getConfiguredProxyUrl = (settings?: AppSettings): string => (
    normalizeProxyUrl(settings?.network?.proxyUrl)
);

export const withTauriHttpProxy = (
    baseFetch: TauriHttpFetch,
    proxyUrl: string,
): TauriHttpFetch => {
    const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
    if (!normalizedProxyUrl) return baseFetch;

    return ((input: Parameters<TauriHttpFetch>[0], init?: Parameters<TauriHttpFetch>[1]) => {
        const nextInit: TauriFetchInit = {
            ...(init ?? {}),
            proxy: {
                ...((init as TauriFetchInit | undefined)?.proxy ?? {}),
                all: normalizedProxyUrl,
            },
        };
        return baseFetch(input, nextInit);
    }) as TauriHttpFetch;
};

/**
 * `@tauri-apps/plugin-http` builds its response body from a `ReadableStream` whose
 * `start` pumps IPC channel messages into the controller and calls `controller.close()`
 * when the terminator message arrives. That stream has no `cancel` handler, so
 * cancelling it does not stop the Rust side: the channel keeps firing and the late
 * `close()` throws `ReadableStreamDefaultController is not in a state where it can be
 * closed` out of the callback, landing in the user log as an `error` line
 * (node_modules/@tauri-apps/plugin-http/dist-js/index.js:134).
 *
 * Core cancels any body a consumer left unread (`cancelUnlockedResponseBody`), which is
 * every HEAD presence check and every status-only miss, so a normal WebDAV cycle wrote
 * two of those lines. This pass-through drains the plugin stream on cancel instead of
 * cancelling it: the bytes were already on their way over the channel either way, so the
 * traffic is identical and the plugin's `close()` lands on a healthy stream.
 */
const discardStream = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
    void (async () => {
        try {
            while (!(await reader.read()).done) {
                // Discard; the plugin sends these regardless of our interest.
            }
        } catch {
            // A transport failure after we stopped caring is not interesting.
        }
    })();
};

/** Statuses the fetch spec forbids a body on; `new Response(stream, { status })` throws a
 *  TypeError for these, and WebDAV answers DELETE (and some PUT/MKCOL) with 204. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const drainInsteadOfCancel = (reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> => (
    new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                controller.close();
                return;
            }
            controller.enqueue(value);
        },
        cancel() {
            discardStream(reader);
        },
    })
);

export const withCancelSafeBody = (baseFetch: TauriHttpFetch): TauriHttpFetch => (
    (async (input: Parameters<TauriHttpFetch>[0], init?: Parameters<TauriHttpFetch>[1]) => {
        const res = await baseFetch(input, init);
        const body = res.body;
        if (!body) return res;

        const reader = body.getReader();
        // `url` and `headers` are read-only on Response; the plugin sets them the same way.
        const rebuild = (nextBody: ReadableStream<Uint8Array> | null): Response => {
            const wrapped = new Response(nextBody, { status: res.status, statusText: res.statusText });
            Object.defineProperty(wrapped, 'url', { value: res.url });
            Object.defineProperty(wrapped, 'headers', { value: res.headers });
            return wrapped;
        };

        if (NULL_BODY_STATUSES.has(res.status)) {
            discardStream(reader);
            return rebuild(null);
        }
        try {
            return rebuild(drainInsteadOfCancel(reader));
        } catch (error) {
            // Any other status the Response constructor refuses a body on: keep the request
            // working rather than turning a served response into a thrown error.
            if (!(error instanceof TypeError)) throw error;
            discardStream(reader);
            return rebuild(null);
        }
    }) as TauriHttpFetch
);

// Native sync (self-hosted cloud, WebDAV, Dropbox token calls) runs through a
// reqwest client in src-tauri, not the plugin fetch above, so the saved proxy
// must be mirrored into config.toml for it (#864). `undefined` means the
// setting was never configured — leave the native config untouched; an empty
// string is an explicit clear.
export const syncNativeProxyUrl = async (proxyUrl: string | undefined): Promise<void> => {
    if (!isTauriRuntime()) return;
    if (proxyUrl === undefined) return;
    await invokeNative('set_network_proxy', { proxyUrl: normalizeProxyUrl(proxyUrl) });
};

export const getTauriHttpFetch = async (): Promise<TauriHttpFetch | undefined> => {
    if (!isTauriRuntime()) return undefined;
    const mod = await import('@tauri-apps/plugin-http');
    const proxyUrl = getConfiguredProxyUrl(useTaskStore.getState().settings);
    return withCancelSafeBody(withTauriHttpProxy(mod.fetch, proxyUrl));
};
