import { describe, expect, it } from 'vitest';
import { resolveAISettingsScreenState } from './ai-settings-model';
import { buildNativeAISettingsProjection } from './native-ai-settings-projection';
import type { AppSettings } from './types';

const fields = ['aiProvider', 'aiEnabled', 'staticAiModelOptions', 'aiReasoningEffort', 'aiThinkingBudget',
    'staticAiCopilotOptions', 'aiRequestTimeoutSeconds', 'anthropicThinkingEnabled', 'speechEnabled',
    'speechProvider', 'speechMode', 'speechFieldStrategy', 'staticSpeechModelOptions'] as const;

describe('private saved AI configuration projection', () => {
    it.each(['openai', 'gemini', 'anthropic'] as const)('matches shared defaults and controls for %s without persisting them', (provider) => {
        for (const settings of [{}, { ai: { provider, enabled: true, reasoningEffort: 'high', thinkingBudget: 2048,
            requestTimeoutSeconds: 120, speechToText: { enabled: true, provider: 'parakeet', mode: 'transcribe_only', fieldStrategy: 'title_only' } } }] as AppSettings[]) {
            const before = JSON.stringify(settings), shared = resolveAISettingsScreenState(settings, false);
            expect(buildNativeAISettingsProjection(settings)).toEqual({ version: 1,
                ...Object.fromEntries(fields.map((field) => [field, shared[field]])) });
            expect(JSON.stringify(settings)).toBe(before);
        }
    });

    it('never reads saved model, language, endpoint, body, credential or local file fields', () => {
        const ai = { provider: 'openai', speechToText: { provider: 'whisper' } } as Record<string, unknown>;
        for (const name of ['model', 'copilotModel', 'baseUrl', 'openAIExtraBodyParams', 'apiKey']) {
            Object.defineProperty(ai, name, { enumerable: true, get: () => { throw new Error('SECRET ' + name); } });
        }
        for (const name of ['model', 'language', 'baseUrl', 'offlineModelPath', 'apiKey']) {
            Object.defineProperty(ai.speechToText, name, { enumerable: true, get: () => { throw new Error('SECRET ' + name); } });
        }
        const projection = buildNativeAISettingsProjection({ ai } as AppSettings);
        expect(Object.keys(projection).sort()).toEqual(['version', ...fields].sort());
        expect(JSON.stringify(projection)).not.toContain('SECRET');
        expect(projection.staticSpeechModelOptions).toEqual(['whisper-tiny', 'whisper-tiny.en', 'whisper-base', 'whisper-base.en']);
    });

    it('rejects malformed saved enums and bounded controls without revealing their value', () => {
        const sentinel = 'PRIVATE-SAVED-SENTINEL';
        const invalid = [null, [], { ai: [] }, { ai: null }, { ai: { provider: sentinel } },
            { ai: { reasoningEffort: sentinel } }, { ai: { enabled: 1 } },
            ...[NaN, Infinity, -1, 1.5, 32769].map(thinkingBudget => ({ ai: { thinkingBudget } })),
            { ai: { requestTimeoutSeconds: 999 } },
            ...['provider', 'mode', 'fieldStrategy', 'enabled'].map(field => ({ ai: { speechToText: { [field]: sentinel } } })),
            { ai: { speechToText: [] } }];
        for (const settings of invalid) {
            expect(() => buildNativeAISettingsProjection(settings as AppSettings)).toThrow('INVALID_INPUT: Saved AI configuration is malformed');
            try { buildNativeAISettingsProjection(settings as AppSettings); }
            catch (error) { expect(String(error)).not.toContain(sentinel); }
        }
    });

    it('bounds and copies every static catalog choice', () => {
        for (const provider of ['openai', 'gemini', 'anthropic'] as const) {
            const projection = buildNativeAISettingsProjection({ ai: { provider, thinkingBudget: 32768 } });
            expect(projection.aiThinkingBudget).toBe(32768);
            expect(JSON.stringify(projection).length).toBeLessThan(8192);
            projection.staticAiModelOptions.push('MUTATED');
            expect(buildNativeAISettingsProjection({ ai: { provider } }).staticAiModelOptions).not.toContain('MUTATED');
        }
    });
});
