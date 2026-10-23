import { exact, isNativeJsonWithinBytes, record } from './native-json';
import type { AppSettings } from './types';

export type AIReasoningEffortValue = 'low' | 'medium' | 'high';
export type AIReasoningEffortSavedValue = AIReasoningEffortValue | 'minimal';
export type AIReasoningEffortWitness = { aiPresent: boolean; effortPresent: boolean; effort: AIReasoningEffortSavedValue | null;
    providerPresent: boolean; provider: 'openai' | 'gemini' | 'anthropic' | null; stampPresent: boolean; stamp: string | null };
export type AIReasoningEffortRequest = { requestId: string; value: AIReasoningEffortValue; expected: AIReasoningEffortWitness };
export type AIReasoningEffortResult = { value: AIReasoningEffortValue; changed: boolean };
export type PreparedAIReasoningEffort = { version: 1; request: AIReasoningEffortRequest };
const owns = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const effort = (value: unknown): value is AIReasoningEffortValue => value === 'low' || value === 'medium' || value === 'high';
const savedEffort = (value: unknown): value is AIReasoningEffortSavedValue => value === 'minimal' || effort(value);
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const provider = (value: unknown): value is AIReasoningEffortWitness['provider'] => value === 'openai' || value === 'gemini' || value === 'anthropic';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** Bounded raw CAS only. Credential presence is refused before any credential value access. */
export function nativeAIReasoningEffortWitness(settings: AppSettings): AIReasoningEffortWitness | null {
    if (!record(settings)) return null;
    const aiPresent = owns(settings, 'ai'), ai = aiPresent ? settings.ai : undefined;
    if (aiPresent && (!record(ai) || owns(ai, 'apiKey'))) return null;
    const effortPresent = !!ai && owns(ai, 'reasoningEffort'), value = effortPresent ? (ai as Record<string, unknown>).reasoningEffort : null;
    const providerPresent = !!ai && owns(ai, 'provider'), selected = providerPresent ? (ai as Record<string, unknown>).provider : null;
    if (effortPresent && !savedEffort(value) || providerPresent && !provider(selected)) return null;
    const groupPresent = owns(settings, 'syncPreferencesUpdatedAt'), group = groupPresent ? settings.syncPreferencesUpdatedAt : undefined;
    if (groupPresent && !record(group)) return null;
    const stampPresent = !!group && owns(group, 'ai'), at = stampPresent ? (group as Record<string, unknown>).ai : null;
    if (stampPresent && !stamp(at)) return null;
    return { aiPresent, effortPresent, effort: value as AIReasoningEffortSavedValue | null,
        providerPresent, provider: selected as AIReasoningEffortWitness['provider'], stampPresent, stamp: at as string | null };
}
const witnessOf = (input: unknown): AIReasoningEffortWitness | null => {
    if (!record(input) || !exact(input, ['aiPresent', 'effortPresent', 'effort', 'providerPresent', 'provider', 'stampPresent', 'stamp'])
        || !['aiPresent', 'effortPresent', 'providerPresent', 'stampPresent'].every(field => typeof input[field] === 'boolean')
        || !input.aiPresent && (input.effortPresent || input.providerPresent)
        || (input.effortPresent ? !savedEffort(input.effort) : input.effort !== null)
        || (input.providerPresent ? !provider(input.provider) : input.provider !== null)
        || (input.stampPresent ? !stamp(input.stamp) : input.stamp !== null)) return null;
    return { aiPresent: input.aiPresent as boolean, effortPresent: input.effortPresent as boolean,
        effort: input.effort as AIReasoningEffortSavedValue | null, providerPresent: input.providerPresent as boolean,
        provider: input.provider as AIReasoningEffortWitness['provider'], stampPresent: input.stampPresent as boolean, stamp: input.stamp as string | null };
};
export const readNativeAIReasoningEffortRequest = (input: unknown): AIReasoningEffortRequest | null => {
    if (!isNativeJsonWithinBytes(input, 2048) || !record(input) || !exact(input, ['requestId', 'value', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || !effort(input.value)) return null;
    const expected = witnessOf(input.expected);
    return expected ? { requestId: input.requestId, value: input.value, expected } : null;
};
