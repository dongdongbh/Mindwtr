import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AIProviderConfig, AIProviderId, AppData, Language } from '@mindwtr/core';
import { buildAIConfig as buildCoreAIConfig, buildCopilotConfig as buildCoreCopilotConfig, isAIKeyRequired as isCoreAIKeyRequired, isSandboxMode } from '@mindwtr/core';
import { createAIKeyStore, type AIKeyStore } from '@mindwtr/core/ai-config';
import { logInfo } from './app-log';

import { secureSecretStorage, secureSecretVault } from './secure-secret-store';


let keyStore: AIKeyStore | null = null;
const aiKeys = (): AIKeyStore => {
    keyStore ??= createAIKeyStore({ storage: AsyncStorage, secrets: secureSecretStorage, vault: secureSecretVault });
    return keyStore;
};

export function loadAIKey(provider: AIProviderId): Promise<string> {
    return aiKeys().load(provider);
}

export function saveAIKey(provider: AIProviderId, value: string): Promise<void> {
    return aiKeys().save(provider, value);
}


export function isAIKeyRequired(settings: AppData['settings'] | undefined): boolean {
    return isCoreAIKeyRequired(settings);
}

const withRequestDiagnostics = (config: AIProviderConfig): AIProviderConfig => ({
    ...config,
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
});

export function buildAIConfig(settings: AppData['settings'], apiKey: string, language: Language = 'en'): AIProviderConfig {
    if (isSandboxMode()) throw new Error('Unavailable in sandbox');
    return withRequestDiagnostics({ ...buildCoreAIConfig(settings, apiKey), language });
}

export function buildCopilotConfig(settings: AppData['settings'], apiKey: string, language: Language = 'en'): AIProviderConfig {
    if (isSandboxMode()) throw new Error('Unavailable in sandbox');
    return withRequestDiagnostics({ ...buildCoreCopilotConfig(settings, apiKey), language });
}
