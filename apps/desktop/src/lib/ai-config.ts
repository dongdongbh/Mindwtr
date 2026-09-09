import type { AIProviderConfig, AIProviderId, AppData } from '@mindwtr/core';
import {
    buildAIConfig as buildCoreAIConfig,
    buildCopilotConfig as buildCoreCopilotConfig,
    getAIKeyStorageKey,
} from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { logError, logInfo } from './app-log';
import { invokeNative } from './tauri-invoke';

const AI_SECRET_KEY = 'mindwtr-ai-key-secret';

type Fetcher = typeof fetch;

let cachedTauriFetch: Fetcher | null | undefined;

const loadTauriFetch = async (): Promise<Fetcher | null> => {
    if (cachedTauriFetch !== undefined) return cachedTauriFetch;
    if (!isTauriRuntime()) {
        cachedTauriFetch = null;
        return cachedTauriFetch;
    }
    try {
        const mod: { fetch?: unknown } = await import('@tauri-apps/plugin-http');
        cachedTauriFetch = typeof mod.fetch === 'function' ? mod.fetch as Fetcher : null;
    } catch (error) {
        void logError(error, { scope: 'ai', step: 'loadHttpFetch' });
        cachedTauriFetch = null;
    }
    return cachedTauriFetch;
};

const withDesktopFetch = async (config: AIProviderConfig): Promise<AIProviderConfig> => {
    const fetcher = await loadTauriFetch();
    return {
        ...config,
        ...(fetcher ? { fetcher } : {}),
        onRequestStop: (reason) => {
            void logInfo('AI request stopped without retry', {
                scope: 'ai',
                extra: {
                    releaseCheck: 'v1.3.0/ai-request-stop-once',
                    outcome: reason,
                    provider: config.provider,
                    timeoutMs: config.timeoutMs,
                },
            }).catch(() => undefined);
        },
    };
};

const getSessionSecretBytes = (): Uint8Array | null => {
    if (typeof sessionStorage === 'undefined') return null;
    const existing = sessionStorage.getItem(AI_SECRET_KEY);
    if (existing) {
        try {
            return base64ToBytes(existing);
        } catch {
            sessionStorage.removeItem(AI_SECRET_KEY);
        }
    }
    if (typeof crypto === 'undefined' || !crypto.getRandomValues) return null;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    sessionStorage.setItem(AI_SECRET_KEY, bytesToBase64(bytes));
    return bytes;
};

const getSessionKey = async (): Promise<CryptoKey | null> => {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const bytes = getSessionSecretBytes();
    if (!bytes) return null;
    try {
        return await crypto.subtle.importKey('raw', toArrayBuffer(bytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    } catch {
        return null;
    }
};

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    bytes.forEach((b) => {
        binary += String.fromCharCode(b);
    });
    return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
};

const toArrayBufferView = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    return new Uint8Array(toArrayBuffer(bytes)) as Uint8Array<ArrayBuffer>;
};

const loadLocalKey = async (provider: AIProviderId): Promise<string> => {
    if (typeof localStorage === 'undefined') return '';
    const stored = localStorage.getItem(getAIKeyStorageKey(provider));
    if (!stored) return '';
    const secretKey = await getSessionKey();
    if (!secretKey) return '';
    try {
        const [ivEncoded, payloadEncoded] = stored.split(':');
        if (!ivEncoded || !payloadEncoded) return '';
        const iv = toArrayBufferView(base64ToBytes(ivEncoded));
        const payload = base64ToBytes(payloadEncoded);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, secretKey, toArrayBuffer(payload));
        return new TextDecoder().decode(new Uint8Array(decrypted));
    } catch {
        return '';
    }
};

const saveLocalKey = async (provider: AIProviderId, value: string): Promise<void> => {
    if (typeof localStorage === 'undefined') return;
    const key = getAIKeyStorageKey(provider);
    if (!value) {
        localStorage.removeItem(key);
        return;
    }
    const secretKey = await getSessionKey();
    if (!secretKey) {
        localStorage.removeItem(key);
        return;
    }
    if (typeof crypto === 'undefined' || !crypto.getRandomValues || !crypto.subtle) {
        localStorage.removeItem(key);
        return;
    }
    const iv = toArrayBufferView(crypto.getRandomValues(new Uint8Array(12)));
    const bytes = new TextEncoder().encode(value);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secretKey, toArrayBuffer(bytes));
    const payload = new Uint8Array(encrypted);
    localStorage.setItem(key, `${bytesToBase64(iv)}:${bytesToBase64(payload)}`);
};

export async function loadAIKey(provider: AIProviderId): Promise<string> {
    if (isTauriRuntime()) {
        try {
            const value = await invokeNative<string | null>('get_ai_key', { provider });
            if (typeof value === 'string') return value;
        } catch (error) {
            void logError(error, { scope: 'ai', step: 'loadKey' });
            return '';
        }
    }
    return await loadLocalKey(provider);
}

export async function saveAIKey(provider: AIProviderId, value: string): Promise<void> {
    if (isTauriRuntime()) {
        try {
            await invokeNative('set_ai_key', { provider, value: value || null });
            return;
        } catch (error) {
            void logError(error, { scope: 'ai', step: 'saveKey' });
            return;
        }
    }
    await saveLocalKey(provider, value);
}

export function isAIKeyRequired(settings: AppData['settings'] | undefined): boolean {
    const config = buildCoreAIConfig(settings ?? {}, '');
    return !(config.provider === 'openai' && Boolean(config.endpoint));
}

export async function buildAIConfig(settings: AppData['settings'] | undefined, apiKey: string): Promise<AIProviderConfig> {
    return withDesktopFetch(buildCoreAIConfig(settings ?? {}, apiKey));
}

export async function buildCopilotConfig(settings: AppData['settings'] | undefined, apiKey: string): Promise<AIProviderConfig> {
    return withDesktopFetch(buildCoreCopilotConfig(settings ?? {}, apiKey));
}
