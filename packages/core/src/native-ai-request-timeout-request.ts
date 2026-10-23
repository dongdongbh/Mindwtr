import { exact, isNativeJsonWithinBytes, record } from './native-json';
import type { AppSettings } from './types';
import { AI_REQUEST_TIMEOUT_OPTIONS } from './ai-config';

export type AIRequestTimeoutValue = typeof AI_REQUEST_TIMEOUT_OPTIONS[number];
export type AIRequestTimeoutWitness = { aiPresent: boolean; timeoutPresent: boolean; timeout: AIRequestTimeoutValue | null;
    providerPresent: boolean; provider: 'openai' | 'gemini' | 'anthropic' | null; stampPresent: boolean; stamp: string | null };
export type AIRequestTimeoutRequest = { requestId: string; value: AIRequestTimeoutValue; expected: AIRequestTimeoutWitness };
export type AIRequestTimeoutResult = { value: AIRequestTimeoutValue; changed: boolean };
export type PreparedAIRequestTimeout = { version: 1; request: AIRequestTimeoutRequest };
const owns = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const timeout = (value: unknown): value is AIRequestTimeoutValue => AI_REQUEST_TIMEOUT_OPTIONS.some(option => option === value);
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const provider = (value: unknown): value is AIRequestTimeoutWitness['provider'] => value === 'openai' || value === 'gemini' || value === 'anthropic';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** Bounded raw CAS only. Credential presence is refused before any credential value access. */
export function nativeAIRequestTimeoutWitness(settings: AppSettings): AIRequestTimeoutWitness | null {
    if (!record(settings)) return null;
    const aiPresent = owns(settings, 'ai'), ai = aiPresent ? settings.ai : undefined;
    if (aiPresent && (!record(ai) || owns(ai, 'apiKey'))) return null;
    const timeoutPresent = !!ai && owns(ai, 'requestTimeoutSeconds'), value = timeoutPresent ? (ai as Record<string, unknown>).requestTimeoutSeconds : null;
    const providerPresent = !!ai && owns(ai, 'provider'), selected = providerPresent ? (ai as Record<string, unknown>).provider : null;
    if (timeoutPresent && !timeout(value) || providerPresent && !provider(selected)) return null;
    const groupPresent = owns(settings, 'syncPreferencesUpdatedAt'), group = groupPresent ? settings.syncPreferencesUpdatedAt : undefined;
    if (groupPresent && !record(group)) return null;
    const stampPresent = !!group && owns(group, 'ai'), at = stampPresent ? (group as Record<string, unknown>).ai : null;
    if (stampPresent && !stamp(at)) return null;
    return { aiPresent, timeoutPresent, timeout: value as AIRequestTimeoutValue | null,
        providerPresent, provider: selected as AIRequestTimeoutWitness['provider'], stampPresent, stamp: at as string | null };
}
const witnessOf = (input: unknown): AIRequestTimeoutWitness | null => {
    if (!record(input) || !exact(input, ['aiPresent', 'timeoutPresent', 'timeout', 'providerPresent', 'provider', 'stampPresent', 'stamp'])
        || !['aiPresent', 'timeoutPresent', 'providerPresent', 'stampPresent'].every(field => typeof input[field] === 'boolean')
        || !input.aiPresent && (input.timeoutPresent || input.providerPresent)
        || (input.timeoutPresent ? !timeout(input.timeout) : input.timeout !== null)
        || (input.providerPresent ? !provider(input.provider) : input.provider !== null)
        || (input.stampPresent ? !stamp(input.stamp) : input.stamp !== null)) return null;
    return { aiPresent: input.aiPresent as boolean, timeoutPresent: input.timeoutPresent as boolean,
        timeout: input.timeout as AIRequestTimeoutValue | null, providerPresent: input.providerPresent as boolean,
        provider: input.provider as AIRequestTimeoutWitness['provider'], stampPresent: input.stampPresent as boolean, stamp: input.stamp as string | null };
};
export const readNativeAIRequestTimeoutRequest = (input: unknown): AIRequestTimeoutRequest | null => {
    if (!isNativeJsonWithinBytes(input, 2048) || !record(input) || !exact(input, ['requestId', 'value', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || !timeout(input.value)) return null;
    const expected = witnessOf(input.expected);
    return expected ? { requestId: input.requestId, value: input.value, expected } : null;
};
