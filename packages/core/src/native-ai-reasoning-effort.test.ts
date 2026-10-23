import { describe, expect, it } from 'vitest';
import { nativeAIReasoningEffortWitness, readNativeAIReasoningEffortRequest } from './native-ai-reasoning-effort';
import type { AppSettings } from './types';

const ID = '00000000-0000-4000-8000-00000000059a';
const absent = { aiPresent: false, effortPresent: false, effort: null, providerPresent: false, provider: null,
    stampPresent: false, stamp: null };
describe('private AI reasoning effort boundary', () => {
    it('distinguishes absent AI, absent effort and explicit default without reading private fields', () => {
        expect(nativeAIReasoningEffortWitness({})).toEqual(absent);
        const ai = { reasoningEffort: 'low' };
        for (const field of ['baseUrl', 'model', 'copilotModel', 'openAIExtraBodyParams', 'speechToText', 'unknown'])
            Object.defineProperty(ai, field, { enumerable: true, get() { throw new Error('private getter was read'); } });
        expect(nativeAIReasoningEffortWitness({ ai } as AppSettings)).toEqual({ ...absent, aiPresent: true,
            effortPresent: true, effort: 'low' });
        expect(nativeAIReasoningEffortWitness({ ai: {} })).toEqual({ ...absent, aiPresent: true });
        expect(nativeAIReasoningEffortWitness({ ai: { reasoningEffort: 'minimal' } }))
            .toEqual({ ...absent, aiPresent: true, effortPresent: true, effort: 'minimal' });
    });
    it('refuses legacy credential presence without reading its value, including falsy members', () => {
        for (const value of [null, false, '', undefined]) {
            const ai = { apiKey: value };
            expect(nativeAIReasoningEffortWitness({ ai } as unknown as AppSettings)).toBeNull();
        }
        const ai = {};
        Object.defineProperty(ai, 'apiKey', { enumerable: true, get() { throw new Error('secret was read'); } });
        expect(nativeAIReasoningEffortWitness({ ai })).toBeNull();
    });
    it('accepts only exact bounded requests and well formed witnesses', () => {
        const request = { requestId: ID, value: 'medium', expected: absent };
        expect(readNativeAIReasoningEffortRequest(request)).toEqual(request);
        for (const value of ['low', 'medium', 'high'])
            expect(readNativeAIReasoningEffortRequest({ ...request, value })?.value).toBe(value);
        expect(readNativeAIReasoningEffortRequest({ ...request,
            expected: { ...absent, aiPresent: true, effortPresent: true, effort: 'minimal' } })).not.toBeNull();
        for (const value of [0, 31, 3600, NaN, Infinity, 'minimal', 'future', true, null])
            expect(readNativeAIReasoningEffortRequest({ ...request, value })).toBeNull();
        for (const bad of [{ ...request, secret: 'private' }, { ...request, requestId: ID.toUpperCase() },
            { ...request, requestId: 'a'.repeat(4096) }, { ...request, value: 'low'.repeat(4096) },
            { ...request, expected: { ...absent, effort: 'low' } }, { ...request, expected: { ...absent, provider: 'openai' } },
            { ...request, expected: { ...absent, stampPresent: true, stamp: 'not-a-date' } },
            { ...request, expected: { ...absent, extra: true } }])
            expect(readNativeAIReasoningEffortRequest(bad)).toBeNull();
        for (const ai of [null, [], false, { reasoningEffort: 31 }, { provider: 'future' }])
            expect(nativeAIReasoningEffortWitness({ ai } as unknown as AppSettings)).toBeNull();
        expect(nativeAIReasoningEffortWitness({ syncPreferencesUpdatedAt: { ai: '2026-10-11T00:00:00.000Z' } }))
            .toEqual({ ...absent, stampPresent: true, stamp: '2026-10-11T00:00:00.000Z' });
    });
});
