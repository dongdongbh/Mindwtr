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


const discardStream = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
    void (async () => {
        try {
            while (!(await reader.read()).done) continue;
        } catch {

        }
    })();
};


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


            if (!(error instanceof TypeError)) throw error;
            discardStream(reader);
            return rebuild(null);
        }
    }) as TauriHttpFetch
);


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
