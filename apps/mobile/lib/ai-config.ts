import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { AIProviderConfig, AIProviderId, AppData } from '@mindwtr/core';
import { buildAIConfig as buildCoreAIConfig, buildCopilotConfig as buildCoreCopilotConfig, getAIKeyStorageKey, loadAIKeyFromStorage, saveAIKeyToStorage } from '@mindwtr/core';
import { logInfo } from './app-log';

import {
    deleteSessionSecret,
    evacuateLegacySecretToSession,
    getSessionSecret,
    isSecureStoreAvailable,
    setSessionSecret,
} from './secure-secret-store';

const getSecureKey = (provider: AIProviderId) => {
    return getAIKeyStorageKey(provider).replace(/[^A-Za-z0-9._-]/g, '_');
};

export async function loadAIKey(provider: AIProviderId): Promise<string> {
    const key = getSecureKey(provider);
    if (await isSecureStoreAvailable()) {
        const value = await SecureStore.getItemAsync(key);
        if (value) {
            await saveAIKeyToStorage(AsyncStorage, provider, '');
            return value;
        }

        const legacyValue = await loadAIKeyFromStorage(AsyncStorage, provider);
        if (legacyValue) {
            await SecureStore.setItemAsync(key, legacyValue, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
            await saveAIKeyToStorage(AsyncStorage, provider, '');
        }
        return legacyValue;
    }

    const sessionValue = getSessionSecret(key);
    if (sessionValue !== null) return sessionValue;

    const legacyValue = await loadAIKeyFromStorage(AsyncStorage, provider);
    if (legacyValue) {
        await evacuateLegacySecretToSession(
            key,
            legacyValue,
            () => saveAIKeyToStorage(AsyncStorage, provider, ''),
        );
    }
    return legacyValue;
}

export async function saveAIKey(provider: AIProviderId, value: string): Promise<void> {
    const key = getSecureKey(provider);
    if (await isSecureStoreAvailable()) {
        if (!value) {
            await SecureStore.deleteItemAsync(key);
        } else {
            await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        }
        await saveAIKeyToStorage(AsyncStorage, provider, '');
        deleteSessionSecret(key);
        return;
    }

    await saveAIKeyToStorage(AsyncStorage, provider, '');
    if (value) {
        setSessionSecret(key, value);
    } else {
        deleteSessionSecret(key);
    }
}

export function isAIKeyRequired(settings: AppData['settings'] | undefined): boolean {
    const config = buildCoreAIConfig(settings ?? {}, '');
    return !(config.provider === 'openai' && Boolean(config.endpoint));
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

export function buildAIConfig(settings: AppData['settings'], apiKey: string): AIProviderConfig {
    return withRequestDiagnostics(buildCoreAIConfig(settings, apiKey));
}

export function buildCopilotConfig(settings: AppData['settings'], apiKey: string): AIProviderConfig {
    return withRequestDiagnostics(buildCoreCopilotConfig(settings, apiKey));
}
