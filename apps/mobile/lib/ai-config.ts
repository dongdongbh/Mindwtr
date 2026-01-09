import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { AIProviderId } from '@mindwtr/core';
import { buildAIConfig, buildCopilotConfig, getAIKeyStorageKey, loadAIKeyFromStorage, saveAIKeyToStorage } from '@mindwtr/core';

const secureAvailable = (() => {
    let cached: Promise<boolean> | null = null;
    return () => {
        if (!cached) {
            cached = SecureStore.isAvailableAsync().catch(() => false);
        }
        return cached;
    };
})();

const getSecureKey = (provider: AIProviderId) => {
    return getAIKeyStorageKey(provider).replace(/[^A-Za-z0-9._-]/g, '_');
};

export async function loadAIKey(provider: AIProviderId): Promise<string> {
    const key = getSecureKey(provider);
    if (await secureAvailable()) {
        const value = await SecureStore.getItemAsync(key);
        if (value) return value;
    }
    return loadAIKeyFromStorage(AsyncStorage, provider);
}

export async function saveAIKey(provider: AIProviderId, value: string): Promise<void> {
    const key = getSecureKey(provider);
    if (await secureAvailable()) {
        if (!value) {
            await SecureStore.deleteItemAsync(key);
        } else {
            await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        }
        await saveAIKeyToStorage(AsyncStorage, provider, '');
        return;
    }
    await saveAIKeyToStorage(AsyncStorage, provider, value);
}

export { buildAIConfig, buildCopilotConfig };
