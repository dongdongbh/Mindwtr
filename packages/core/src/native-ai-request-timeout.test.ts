import { describe, expect, it } from 'vitest';
import { nativeAIRequestTimeoutWitness, readNativeAIRequestTimeoutRequest } from './native-ai-request-timeout';
import type { AppSettings } from './types';

const ID = '00000000-0000-4000-8000-00000000059a';
const absent = { aiPresent: false, timeoutPresent: false, timeout: null, providerPresent: false, provider: null,
    stampPresent: false, stamp: null };
describe('private AI timeout boundary', () => {
    it('distinguishes absent AI, absent timeout and explicit default without reading private fields', () => {
        expect(nativeAIRequestTimeoutWitness({})).toEqual(absent);
        const ai = { requestTimeoutSeconds: 30 };
        for (const field of ['baseUrl', 'model', 'copilotModel', 'openAIExtraBodyParams', 'speechToText', 'unknown'])
            Object.defineProperty(ai, field, { enumerable: true, get() { throw new Error('private getter was read'); } });
        expect(nativeAIRequestTimeoutWitness({ ai } as AppSettings)).toEqual({ ...absent, aiPresent: true,
            timeoutPresent: true, timeout: 30 });
        expect(nativeAIRequestTimeoutWitness({ ai: {} })).toEqual({ ...absent, aiPresent: true });
    });
    it('refuses legacy credential presence without reading its value, including falsy members', () => {
        for (const value of [null, false, '', undefined]) {
            const ai = { apiKey: value };
            expect(nativeAIRequestTimeoutWitness({ ai } as unknown as AppSettings)).toBeNull();
        }
        const ai = {};
        Object.defineProperty(ai, 'apiKey', { enumerable: true, get() { throw new Error('secret was read'); } });
        expect(nativeAIRequestTimeoutWitness({ ai })).toBeNull();
    });
    it('accepts only exact bounded requests and well formed witnesses', () => {
        const request = { requestId: ID, value: 60, expected: absent };
        expect(readNativeAIRequestTimeoutRequest(request)).toEqual(request);
        for (const value of [0, 31, 3600, NaN, Infinity, '60', true, null])
            expect(readNativeAIRequestTimeoutRequest({ ...request, value })).toBeNull();
        for (const bad of [{ ...request, secret: 'private' }, { ...request, requestId: ID.toUpperCase() },
            { ...request, expected: { ...absent, timeout: 30 } }, { ...request, expected: { ...absent, provider: 'openai' } },
            { ...request, expected: { ...absent, stampPresent: true, stamp: 'not-a-date' } },
            { ...request, expected: { ...absent, extra: true } }])
            expect(readNativeAIRequestTimeoutRequest(bad)).toBeNull();
        for (const ai of [null, [], false, { requestTimeoutSeconds: 31 }, { provider: 'future' }])
            expect(nativeAIRequestTimeoutWitness({ ai } as unknown as AppSettings)).toBeNull();
        expect(nativeAIRequestTimeoutWitness({ syncPreferencesUpdatedAt: { ai: '2026-10-11T00:00:00.000Z' } }))
            .toEqual({ ...absent, stampPresent: true, stamp: '2026-10-11T00:00:00.000Z' });
    });
});
