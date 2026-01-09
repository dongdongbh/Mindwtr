import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AIProviderId } from '@mindwtr/core';
import { buildAIConfig, buildCopilotConfig, loadAIKeyFromStorage, saveAIKeyToStorage } from '@mindwtr/core';

export async function loadAIKey(provider: AIProviderId): Promise<string> {
    return loadAIKeyFromStorage(AsyncStorage, provider);
}

export async function saveAIKey(provider: AIProviderId, value: string): Promise<void> {
    await saveAIKeyToStorage(AsyncStorage, provider, value);
}

export { buildAIConfig, buildCopilotConfig };
