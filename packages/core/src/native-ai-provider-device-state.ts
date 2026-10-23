import { getAIKeySecretName, getAIKeyStorageKey } from './ai-config';
import { buildNativeAISettingsProjection } from './native-ai-settings-projection';
import type { AIProviderId } from './ai/types';
import type { AppSettings } from './types';

/** Private display metadata only; every future write or request needs fresh admission. */
export async function readNativeAIProviderDeviceState(settings: AppSettings,
    inspect: (provider: AIProviderId, secretName: string, legacyName: string) => unknown | Promise<unknown>) {
    const provider = buildNativeAISettingsProjection(settings).aiProvider;
    const metadata = await inspect(provider, getAIKeySecretName(provider), getAIKeyStorageKey(provider));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).sort().join(',') !== 'consentRecorded,legacyItemPresent,secureItem') {
        throw new Error('INVALID_INPUT: AI provider device metadata is malformed');
    }
    const value = metadata as Record<string, unknown>;
    if (typeof value.consentRecorded !== 'boolean' || typeof value.legacyItemPresent !== 'boolean'
        || !['present', 'absent', 'unavailable'].includes(value.secureItem as string)) {
        throw new Error('INVALID_INPUT: AI provider device metadata is malformed');
    }
    return { version: 1 as const, provider, consentRecorded: value.consentRecorded,
        secureItem: value.secureItem as 'present' | 'absent' | 'unavailable', legacyItemPresent: value.legacyItemPresent };
}
