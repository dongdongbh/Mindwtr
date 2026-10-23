import { describe, expect, it } from 'vitest';
import { getAIKeySecretName, getAIKeyStorageKey } from './ai-config';
import { readAIProviderConsent } from './ai-settings-model';
import { readNativeAIProviderDeviceState } from './native-ai-provider-device-state';
import type { AppSettings } from './types';

describe('private selected AI provider device metadata', () => {
    it.each(['openai', 'gemini', 'anthropic'] as const)('uses only the saved %s identity and exact existing names', async (provider) => {
        const settings: AppSettings = { ai: { provider } }, before = JSON.stringify(settings);
        const calls: unknown[] = [];
        for (const secureItem of ['present', 'absent', 'unavailable'] as const) {
            const result = await readNativeAIProviderDeviceState(settings, async (...input) => {
                calls.push(input); return { consentRecorded: true, secureItem, legacyItemPresent: false };
            });
            expect(result).toEqual({ version: 1, provider, consentRecorded: true, secureItem, legacyItemPresent: false });
        }
        expect(calls).toEqual(Array(3).fill([provider, getAIKeySecretName(provider), getAIKeyStorageKey(provider)]));
        expect(JSON.stringify(settings)).toBe(before);
    });

    it('uses the existing default provider without reading arbitrary private saved fields', async () => {
        const ai = {};
        for (const name of ['apiKey', 'baseUrl', 'model', 'openAIExtraBodyParams']) {
            Object.defineProperty(ai, name, { enumerable: true, get: () => { throw new Error('PRIVATE592-SENTINEL'); } });
        }
        const result = await readNativeAIProviderDeviceState({ ai }, async (...input) => {
            expect(input).toEqual(['openai', 'mindwtr-ai-key_openai', 'mindwtr-ai-key:openai']);
            return { consentRecorded: false, secureItem: 'absent', legacyItemPresent: true };
        });
        expect(result).toEqual({ version: 1, provider: 'openai', consentRecorded: false, secureItem: 'absent', legacyItemPresent: true });
    });

    it('rejects malformed saved selection before inspecting device storage', async () => {
        let calls = 0;
        for (const settings of [{ ai: { provider: 'PRIVATE592-SENTINEL' } }, { ai: null }, { ai: [] }]) {
            await expect(readNativeAIProviderDeviceState(settings as AppSettings, async () => { calls += 1; return {}; }))
                .rejects.toThrow('INVALID_INPUT: Saved AI configuration is malformed');
        }
        expect(calls).toBe(0);
    });

    it('records the shared strict consent grammar reference for the native physical matrix', async () => {
        const cases: [string, boolean][] = [
            ['{"openai":true}', true], ['\uFEFF{"openai":true}', false], ['{"openai":true,}', false],
            ['{"openai":true,"future":{"opaque":1,}}', false], ['{"openai":true,"future":[1, \n]}', false],
            ['{"openai":true,"future":",} ,]"}', true],
            ['{"openai":true,"future":"escaped \\" ,} and \\\\ ,]"}', true],
            [' \t\r\n{"openai":true,"future":[]} \t\r\n', true],
        ];
        for (const [raw, expected] of cases) {
            const state = await readAIProviderConsent({ getItem: async () => raw,
                setItem: async () => { throw new Error('Consent reference must not write'); } }, () => undefined);
            expect(state.openai === true, raw).toBe(expected);
        }
    });

    it('rejects extra fields, numeric consent and malformed metadata without reflecting private values', async () => {
        const valid = { consentRecorded: false, secureItem: 'absent', legacyItemPresent: false };
        for (const value of [null, [], {}, { ...valid, provider: 'gemini' }, { ...valid, value: 'PRIVATE592-SENTINEL' },
            { ...valid, consentRecorded: 1 }, { ...valid, legacyItemPresent: 0 }, { ...valid, secureItem: 'PRIVATE592-SENTINEL' }]) {
            await expect(readNativeAIProviderDeviceState({}, async () => value))
                .rejects.toThrow('INVALID_INPUT: AI provider device metadata is malformed');
        }
        await expect(readNativeAIProviderDeviceState({}, async () => { throw new Error('retired'); })).rejects.toThrow('retired');
    });
});
