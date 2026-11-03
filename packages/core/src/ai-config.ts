import type { AppData } from './types';
import type { AIProviderConfig, AIProviderId, AIRequestExtraBodyParams } from './ai/types';
import { isSandboxMode } from './sandbox';
import type { SyncSecretStoragePort, SyncSecretVault } from './sync-secret-storage';
import { COPILOT_REASONING_EFFORT, DEFAULT_ANTHROPIC_THINKING_BUDGET, DEFAULT_GEMINI_THINKING_BUDGET, DEFAULT_REASONING_EFFORT, getDefaultAIConfig, getDefaultCopilotModel } from './ai/catalog';

const AI_KEY_PREFIX = 'mindwtr-ai-key';
const OPENAI_CHAT_COMPLETIONS_PATH = '/chat/completions';
const OPENAI_TRANSCRIBE_PATH = '/audio/transcriptions';
const OPENAI_TRANSCRIBE_URL = `https://api.openai.com/v1${OPENAI_TRANSCRIBE_PATH}`;

export const AI_REQUEST_TIMEOUT_OPTIONS = [30, 60, 120, 300] as const;

export const resolveAIRequestTimeoutSeconds = (value: unknown): number => (
    AI_REQUEST_TIMEOUT_OPTIONS.some((option) => option === value) ? value as number : 30
);

export function getAIKeyStorageKey(provider: AIProviderId): string {
    return `${AI_KEY_PREFIX}:${provider}`;
}

type KeyValueStorageSync = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

type KeyValueStorageAsync = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
};

export function loadAIKeyFromStorageSync(storage: KeyValueStorageSync, provider: AIProviderId): string {
    return storage.getItem(getAIKeyStorageKey(provider)) ?? '';
}

export function saveAIKeyToStorageSync(storage: KeyValueStorageSync, provider: AIProviderId, value: string): void {
    const key = getAIKeyStorageKey(provider);
    if (!value) {
        storage.removeItem(key);
        return;
    }
    storage.setItem(key, value);
}

export async function loadAIKeyFromStorage(storage: KeyValueStorageAsync, provider: AIProviderId): Promise<string> {
    const value = await storage.getItem(getAIKeyStorageKey(provider));
    return value ?? '';
}

export async function saveAIKeyToStorage(storage: KeyValueStorageAsync, provider: AIProviderId, value: string): Promise<void> {
    const key = getAIKeyStorageKey(provider);
    if (!value) {
        await storage.removeItem(key);
        return;
    }
    await storage.setItem(key, value);
}


export const getAIKeySecretName = (provider: AIProviderId): string => getAIKeyStorageKey(provider).replace(/[^A-Za-z0-9._-]/g, '_');

export type AIKeyStore = {
    load(provider: AIProviderId): Promise<string>;
    save(provider: AIProviderId, value: string): Promise<void>;
};


export function createAIKeyStore({ storage, secrets, vault }: {
    storage: KeyValueStorageAsync;
    secrets: Pick<SyncSecretStoragePort, 'getItem' | 'setItem' | 'deleteItem'>;
    vault: Pick<SyncSecretVault, 'isSecureStoreAvailable' | 'getSessionSecret' | 'setSessionSecret' | 'deleteSessionSecret' | 'evacuateLegacySecretToSession'>;
}): AIKeyStore {
    return {
        load: async (provider) => {
            if (isSandboxMode()) return '';
            const key = getAIKeySecretName(provider);
            if (await vault.isSecureStoreAvailable()) {
                const value = await secrets.getItem(key);
                if (value) {
                    await saveAIKeyToStorage(storage, provider, '');
                    return value;
                }

                const legacyValue = await loadAIKeyFromStorage(storage, provider);
                if (legacyValue) {
                    await secrets.setItem(key, legacyValue, 'when-unlocked');
                    await saveAIKeyToStorage(storage, provider, '');
                }
                return legacyValue;
            }

            const sessionValue = vault.getSessionSecret(key);
            if (sessionValue !== null) return sessionValue;

            const legacyValue = await loadAIKeyFromStorage(storage, provider);
            if (legacyValue) {
                await vault.evacuateLegacySecretToSession(
                    key,
                    legacyValue,
                    () => saveAIKeyToStorage(storage, provider, ''),
                );
            }
            return legacyValue;
        },
        save: async (provider, value) => {
            if (isSandboxMode()) return;
            const key = getAIKeySecretName(provider);
            if (await vault.isSecureStoreAvailable()) {
                if (!value) {
                    await secrets.deleteItem(key);
                } else {
                    await secrets.setItem(key, value, 'when-unlocked');
                }
                await saveAIKeyToStorage(storage, provider, '');
                vault.deleteSessionSecret(key);
                return;
            }

            await saveAIKeyToStorage(storage, provider, '');
            if (value) {
                vault.setSessionSecret(key, value);
            } else {
                vault.deleteSessionSecret(key);
            }
        },
    };
}

const resolveOpenAIEndpoint = (baseUrl?: string): string | undefined => {
    const trimmed = String(baseUrl || '').trim();
    if (!trimmed) return undefined;
    const normalized = trimmed.replace(/\/+$/, '');
    const lower = normalized.toLowerCase();
    if (lower.endsWith(OPENAI_CHAT_COMPLETIONS_PATH)) {
        return normalized;
    }
    return `${normalized}${OPENAI_CHAT_COMPLETIONS_PATH}`;
};


export const resolveOpenAITranscribeEndpoint = (baseUrl?: string): string => {
    const trimmed = String(baseUrl || '').trim();
    if (!trimmed) return OPENAI_TRANSCRIBE_URL;
    const normalized = trimmed.replace(/\/+$/, '');
    const lower = normalized.toLowerCase();
    if (lower.endsWith(OPENAI_TRANSCRIBE_PATH)) {
        return normalized;
    }
    return `${normalized}${OPENAI_TRANSCRIBE_PATH}`;
};


export const openAITranscribeLanguageFieldName = (model: string): 'languages[]' | 'language' => (
    model.startsWith('gpt-transcribe') ? 'languages[]' : 'language'
);

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeOpenAIExtraBodyParams = (
    value: unknown
): AIRequestExtraBodyParams | undefined => {
    if (!isObjectRecord(value)) return undefined;
    return Object.keys(value).length > 0
        ? value as AIRequestExtraBodyParams
        : undefined;
};

export const formatOpenAIExtraBodyParams = (value: unknown): string => {
    const params = normalizeOpenAIExtraBodyParams(value);
    return params ? JSON.stringify(params, null, 2) : '';
};

export type OpenAIExtraBodyParamsParseResult =
    | { ok: true; value?: AIRequestExtraBodyParams }
    | { ok: false; message: string };

export const parseOpenAIExtraBodyParamsInput = (input: string): OpenAIExtraBodyParamsParseResult => {
    const trimmed = input.trim();
    if (!trimmed) return { ok: true };
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isObjectRecord(parsed)) {
            return { ok: false, message: 'Enter a JSON object, for example { "thinking": { "type": "disabled" } }.' };
        }
        return { ok: true, value: normalizeOpenAIExtraBodyParams(parsed) };
    } catch {
        return { ok: false, message: 'Enter valid JSON.' };
    }
};

export function buildAIConfig(settings: AppData['settings'], apiKey: string): AIProviderConfig {
    const provider = (settings.ai?.provider ?? 'openai') as AIProviderId;
    const defaults = getDefaultAIConfig(provider);
    const endpoint = provider === 'openai'
        ? resolveOpenAIEndpoint(settings.ai?.baseUrl)
        : undefined;
    const extraBodyParams = provider === 'openai'
        ? normalizeOpenAIExtraBodyParams(settings.ai?.openAIExtraBodyParams)
        : undefined;
    return {
        provider,
        apiKey,
        model: settings.ai?.model ?? defaults.model,
        reasoningEffort: settings.ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        thinkingBudget: settings.ai?.thinkingBudget ?? defaults.thinkingBudget,
        timeoutMs: resolveAIRequestTimeoutSeconds(settings.ai?.requestTimeoutSeconds) * 1000,
        ...(endpoint ? { endpoint } : {}),
        ...(extraBodyParams ? { extraBodyParams } : {}),
    };
}


export function isAIKeyRequired(settings: AppData['settings'] | undefined): boolean {
    if (isSandboxMode()) return false;
    const config = buildAIConfig(settings ?? {}, '');
    return !(config.provider === 'openai' && Boolean(config.endpoint));
}

export function buildCopilotConfig(settings: AppData['settings'], apiKey: string): AIProviderConfig {
    const provider = (settings.ai?.provider ?? 'openai') as AIProviderId;
    const endpoint = provider === 'openai'
        ? resolveOpenAIEndpoint(settings.ai?.baseUrl)
        : undefined;
    const extraBodyParams = provider === 'openai'
        ? normalizeOpenAIExtraBodyParams(settings.ai?.openAIExtraBodyParams)
        : undefined;
    return {
        provider,
        apiKey,
        model: settings.ai?.copilotModel ?? getDefaultCopilotModel(provider),
        reasoningEffort: COPILOT_REASONING_EFFORT,
        timeoutMs: resolveAIRequestTimeoutSeconds(settings.ai?.requestTimeoutSeconds) * 1000,
        ...(provider === 'gemini' ? { thinkingBudget: DEFAULT_GEMINI_THINKING_BUDGET } : {}),
        ...(provider === 'anthropic' ? { thinkingBudget: DEFAULT_ANTHROPIC_THINKING_BUDGET } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(extraBodyParams ? { extraBodyParams } : {}),
    };
}
