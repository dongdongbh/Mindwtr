import type { AIProviderId } from '@mindwtr/core';
import { buildAIConfig, buildCopilotConfig, loadAIKeyFromStorageSync, saveAIKeyToStorageSync } from '@mindwtr/core';

export function loadAIKey(provider: AIProviderId): string {
    if (typeof localStorage === 'undefined') return '';
    return loadAIKeyFromStorageSync(localStorage, provider);
}

export function saveAIKey(provider: AIProviderId, value: string): void {
    if (typeof localStorage === 'undefined') return;
    saveAIKeyToStorageSync(localStorage, provider, value);
}

export { buildAIConfig, buildCopilotConfig };
