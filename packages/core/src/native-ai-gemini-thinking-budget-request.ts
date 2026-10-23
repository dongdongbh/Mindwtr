import { exact, isNativeJsonWithinBytes, record } from './native-json';
import type { AppSettings } from './types';

export type AIGeminiThinkingBudgetValue = 0 | 128 | 256 | 512;
export type AIGeminiThinkingBudgetWitness = { aiPresent: boolean; budgetPresent: boolean; budget: number | null;
    providerPresent: boolean; provider: 'openai' | 'gemini' | 'anthropic' | null; stampPresent: boolean; stamp: string | null };
export type AIGeminiThinkingBudgetRequest = { requestId: string; value: AIGeminiThinkingBudgetValue; expected: AIGeminiThinkingBudgetWitness };
export type AIGeminiThinkingBudgetResult = { value: AIGeminiThinkingBudgetValue; changed: boolean };
export type PreparedAIGeminiThinkingBudget = { version: 1; request: AIGeminiThinkingBudgetRequest };
const owns = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const budget = (value: unknown): value is AIGeminiThinkingBudgetValue => value === 0 || value === 128 || value === 256 || value === 512;
const savedBudget = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 32768;
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const provider = (value: unknown): value is AIGeminiThinkingBudgetWitness['provider'] => value === 'openai' || value === 'gemini' || value === 'anthropic';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** Bounded raw CAS only. Credential presence is refused before any credential value access. */
export function nativeAIGeminiThinkingBudgetWitness(settings: AppSettings): AIGeminiThinkingBudgetWitness | null {
    if (!record(settings)) return null;
    const aiPresent = owns(settings, 'ai'), ai = aiPresent ? settings.ai : undefined;
    if (aiPresent && (!record(ai) || owns(ai, 'apiKey'))) return null;
    const budgetPresent = !!ai && owns(ai, 'thinkingBudget'), value = budgetPresent ? (ai as Record<string, unknown>).thinkingBudget : null;
    const providerPresent = !!ai && owns(ai, 'provider'), selected = providerPresent ? (ai as Record<string, unknown>).provider : null;
    if (budgetPresent && !savedBudget(value) || providerPresent && !provider(selected)) return null;
    const groupPresent = owns(settings, 'syncPreferencesUpdatedAt'), group = groupPresent ? settings.syncPreferencesUpdatedAt : undefined;
    if (groupPresent && !record(group)) return null;
    const stampPresent = !!group && owns(group, 'ai'), at = stampPresent ? (group as Record<string, unknown>).ai : null;
    if (stampPresent && !stamp(at)) return null;
    return { aiPresent, budgetPresent, budget: value as number | null,
        providerPresent, provider: selected as AIGeminiThinkingBudgetWitness['provider'], stampPresent, stamp: at as string | null };
}
const witnessOf = (input: unknown): AIGeminiThinkingBudgetWitness | null => {
    if (!record(input) || !exact(input, ['aiPresent', 'budgetPresent', 'budget', 'providerPresent', 'provider', 'stampPresent', 'stamp'])
        || !['aiPresent', 'budgetPresent', 'providerPresent', 'stampPresent'].every(field => typeof input[field] === 'boolean')
        || !input.aiPresent && (input.budgetPresent || input.providerPresent)
        || (input.budgetPresent ? !savedBudget(input.budget) : input.budget !== null)
        || (input.providerPresent ? !provider(input.provider) : input.provider !== null)
        || (input.stampPresent ? !stamp(input.stamp) : input.stamp !== null)) return null;
    return { aiPresent: input.aiPresent as boolean, budgetPresent: input.budgetPresent as boolean,
        budget: input.budget as number | null, providerPresent: input.providerPresent as boolean,
        provider: input.provider as AIGeminiThinkingBudgetWitness['provider'], stampPresent: input.stampPresent as boolean, stamp: input.stamp as string | null };
};
export const readNativeAIGeminiThinkingBudgetRequest = (input: unknown): AIGeminiThinkingBudgetRequest | null => {
    if (!isNativeJsonWithinBytes(input, 2048) || !record(input) || !exact(input, ['requestId', 'value', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || !budget(input.value)) return null;
    const expected = witnessOf(input.expected);
    return expected ? { requestId: input.requestId, value: input.value, expected } : null;
};
