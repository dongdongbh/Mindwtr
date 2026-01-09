import type { AIProviderConfig, AIProviderId, AppData } from './types';
import { DEFAULT_ANTHROPIC_THINKING_BUDGET, DEFAULT_GEMINI_THINKING_BUDGET, DEFAULT_REASONING_EFFORT, getDefaultAIConfig, getDefaultCopilotModel } from './ai/catalog';

const AI_KEY_PREFIX = 'mindwtr-ai-key';

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

export function buildAIConfig(settings: AppData['settings'], apiKey: string): AIProviderConfig {
    const provider = (settings.ai?.provider ?? 'openai') as AIProviderId;
    const defaults = getDefaultAIConfig(provider);
    return {
        provider,
        apiKey,
        model: settings.ai?.model ?? defaults.model,
        reasoningEffort: settings.ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        thinkingBudget: settings.ai?.thinkingBudget ?? defaults.thinkingBudget,
    };
}

export function buildCopilotConfig(settings: AppData['settings'], apiKey: string): AIProviderConfig {
    const provider = (settings.ai?.provider ?? 'openai') as AIProviderId;
    return {
        provider,
        apiKey,
        model: settings.ai?.copilotModel ?? getDefaultCopilotModel(provider),
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        ...(provider === 'gemini' ? { thinkingBudget: DEFAULT_GEMINI_THINKING_BUDGET } : {}),
        ...(provider === 'anthropic' ? { thinkingBudget: DEFAULT_ANTHROPIC_THINKING_BUDGET } : {}),
    };
}
