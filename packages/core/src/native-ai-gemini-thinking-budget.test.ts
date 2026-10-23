import { describe, expect, it } from 'vitest';
import { nativeAIGeminiThinkingBudgetWitness, readNativeAIGeminiThinkingBudgetRequest } from './native-ai-gemini-thinking-budget';
import type { AppSettings } from './types';

const ID = '00000000-0000-4000-8000-00000000069a';
const absent = { aiPresent: false, budgetPresent: false, budget: null, providerPresent: false, provider: null,
    stampPresent: false, stamp: null };
describe('private Gemini thinking-budget boundary', () => {
    it('preserves absent, explicit Off and custom saved budgets without reading private neighbors', () => {
        expect(nativeAIGeminiThinkingBudgetWitness({})).toEqual(absent);
        expect(nativeAIGeminiThinkingBudgetWitness({ ai: {} })).toEqual({ ...absent, aiPresent: true });
        for (const budget of [0, 128, 256, 512, 1024, 32768]) {
            const ai = { provider: 'gemini' as const, thinkingBudget: budget };
            for (const field of ['baseUrl', 'model', 'copilotModel', 'openAIExtraBodyParams', 'speechToText', 'unknown'])
                Object.defineProperty(ai, field, { enumerable: true, get() { throw new Error('private getter was read'); } });
            expect(nativeAIGeminiThinkingBudgetWitness({ ai })).toEqual({ ...absent, aiPresent: true,
                budgetPresent: true, budget, providerPresent: true, provider: 'gemini' });
        }
    });
    it('refuses legacy credential presence before reading its value, including falsy members', () => {
        for (const value of [null, false, '', undefined])
            expect(nativeAIGeminiThinkingBudgetWitness({ ai: { apiKey: value } } as unknown as AppSettings)).toBeNull();
        const ai = {};
        Object.defineProperty(ai, 'apiKey', { enumerable: true, get() { throw new Error('secret was read'); } });
        expect(nativeAIGeminiThinkingBudgetWitness({ ai })).toBeNull();
    });
    it('accepts only the four exact numeric requests while witnesses preserve custom saved values', () => {
        const request = { requestId: ID, value: 128, expected: absent };
        for (const value of [0, 128, 256, 512])
            expect(readNativeAIGeminiThinkingBudgetRequest({ ...request, value })).toEqual({ ...request, value });
        expect(readNativeAIGeminiThinkingBudgetRequest({ ...request,
            expected: { ...absent, aiPresent: true, budgetPresent: true, budget: 32768 } })).not.toBeNull();
        for (const value of [-1, 1.5, 1024, 32768, NaN, Infinity, '128', true, null])
            expect(readNativeAIGeminiThinkingBudgetRequest({ ...request, value })).toBeNull();
        for (const bad of [{ ...request, secret: 'private' }, { ...request, requestId: ID.toUpperCase() },
            { ...request, requestId: 'a'.repeat(4096) }, { ...request, value: '128'.repeat(4096) },
            { ...request, expected: { ...absent, budget: 0 } }, { ...request, expected: { ...absent, provider: 'gemini' } },
            { ...request, expected: { ...absent, stampPresent: true, stamp: 'not-a-date' } },
            { ...request, expected: { ...absent, extra: true } }])
            expect(readNativeAIGeminiThinkingBudgetRequest(bad)).toBeNull();
    });
    it('refuses malformed saved budgets and preserves exact preference stamp authority', () => {
        for (const value of [-1, 32769, 1.5, NaN, Infinity, '128', null, false])
            expect(nativeAIGeminiThinkingBudgetWitness({ ai: { thinkingBudget: value } } as unknown as AppSettings)).toBeNull();
        for (const ai of [null, [], false, { provider: 'future' }])
            expect(nativeAIGeminiThinkingBudgetWitness({ ai } as unknown as AppSettings)).toBeNull();
        expect(nativeAIGeminiThinkingBudgetWitness({ syncPreferencesUpdatedAt: { ai: '2026-10-13T00:00:00.000Z' } }))
            .toEqual({ ...absent, stampPresent: true, stamp: '2026-10-13T00:00:00.000Z' });
    });
});
