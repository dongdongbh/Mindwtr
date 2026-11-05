import { describe, expect, it } from 'vitest';
import { buildNativeAITextConfigurationOptions, nativeAITextConfigurationWitness,
    planNativeAITextConfigurationChange, readNativeAITextConfigurationRequest } from './native-ai-text-configuration';
import type { AppSettings } from './types';
import type { AIProviderId } from './ai/types';
import { getTranslator } from './i18n';
import { getDefaultAIConfig, getDefaultCopilotModel } from './ai/catalog';
import { getAIProviderDefaultsPatch } from './ai-settings-model';
import { buildNativeAITextConfigurationOptionsV2, nativeAITextConfigurationWitnessV2, nativeAITextConfigurationConsentTarget,
    planNativeAITextConfigurationChangeV2, readNativeAITextConfigurationRequestV2, buildNativeAIAnthropicThinkingOptions } from './native-ai-text-configuration';

const ID = '00000000-0000-4000-8000-00000000059a';
const absent = { aiPresent: false, providerPresent: false, provider: null, enabledPresent: false, enabled: null,
    modelPresent: false, model: null, copilotModelPresent: false, copilotModel: null, stampPresent: false, stamp: null };

describe('private AI text configuration boundary', () => {
    it('projects defaults and saved custom models without reading endpoint, credential or speech fields', () => {
        const ai = { model: 'my/custom-model', copilotModel: 'local-model' };
        for (const field of ['baseUrl', 'openAIExtraBodyParams', 'speechToText', 'unknown'])
            Object.defineProperty(ai, field, { enumerable: true, get() { throw new Error('private field read'); } });
        const expected = { ...absent, aiPresent: true, modelPresent: true, model: 'my/custom-model',
            copilotModelPresent: true, copilotModel: 'local-model' };
        expect(nativeAITextConfigurationWitness({ ai })).toEqual(expected);
        expect(buildNativeAITextConfigurationOptions({ ai })).toMatchObject({ enabled: false,
            model: 'my/custom-model', copilotModel: 'local-model', expected });
        expect(buildNativeAITextConfigurationOptions({ ai })?.modelOptions).toContain('my/custom-model');
        expect(buildNativeAITextConfigurationOptions({})).toMatchObject({ enabled: false, expected: absent });
        expect(nativeAITextConfigurationWitness({})).toEqual(absent);
    });

    it('refuses unsupported providers and legacy credential presence before reading its value', () => {
        for (const ai of [{ provider: 'gemini' }, { provider: 'anthropic' }, { provider: null }, null, [], false,
            { enabled: 1 }, { model: null }, { copilotModel: 'x'.repeat(2001) }])
            expect(nativeAITextConfigurationWitness({ ai } as unknown as AppSettings)).toBeNull();
        const ai = {};
        Object.defineProperty(ai, 'apiKey', { enumerable: true, get() { throw new Error('credential read'); } });
        expect(nativeAITextConfigurationWitness({ ai })).toBeNull();
        for (const apiKey of ['', null, undefined, false])
            expect(nativeAITextConfigurationWitness({ ai: { apiKey } } as unknown as AppSettings)).toBeNull();
    });

    it('validates exact request shapes, consent placement, model bounds and presence pairs', () => {
        const request = { requestId: ID, change: { type: 'model', value: 'my-model' }, expected: absent, consent: false };
        expect(readNativeAITextConfigurationRequest(request)).toEqual(request);
        expect(readNativeAITextConfigurationRequest({ ...request, change: { type: 'enabled', value: true }, consent: true })).not.toBeNull();
        for (const invalid of [{ ...request, extra: true }, { ...request, requestId: ID.toUpperCase() },
            { ...request, consent: true }, { ...request, change: { type: 'enabled', value: false }, consent: true },
            { ...request, change: { type: 'model', value: 'x'.repeat(2001) } },
            { ...request, change: { type: 'provider', value: 'openai' } },
            { ...request, change: { type: 'model', value: 'ok', extra: true } },
            { ...request, expected: { ...absent, model: 'hidden' } },
            { ...request, expected: { ...absent, modelPresent: true, model: 'invalid-parent' } },
            { ...request, expected: { ...absent, stampPresent: true, stamp: 'invalid' } },
            { ...request, expected: { ...absent, extra: true } }])
            expect(readNativeAITextConfigurationRequest(invalid)).toBeNull();
    });

    it('writes explicit absent defaults but skips only an identical stored choice', () => {
        expect(planNativeAITextConfigurationChange(absent, { type: 'enabled', value: false })).toEqual({ enabled: false });
        expect(planNativeAITextConfigurationChange({ ...absent, aiPresent: true, enabledPresent: true, enabled: false },
            { type: 'enabled', value: false })).toBeNull();
        expect(planNativeAITextConfigurationChange({ ...absent, aiPresent: true, modelPresent: true, model: 'old' },
            { type: 'model', value: 'new' })).toEqual({ model: 'new' });
    });
});

const providers: AIProviderId[] = ['openai', 'gemini', 'anthropic'];
const absentV2 = { ...absent, effortPresent: false, effort: null, budgetPresent: false, budget: null };

describe('version 2 selected-provider AI text configuration boundary', () => {
    it('offers all shared providers/catalogs without reading private fields or mutating saved defaults', () => {
        for (const provider of providers) {
            const ai = { provider, reasoningEffort: 'minimal' as const, thinkingBudget: 32000 };
            for (const field of ['baseUrl', 'openAIExtraBodyParams', 'speechToText', 'unknown'])
                Object.defineProperty(ai, field, { enumerable: true, get() { throw new Error('private field read'); } });
            const options = buildNativeAITextConfigurationOptionsV2({ ai }, getTranslator('en'));
            expect(options).toMatchObject({ version: 2, provider, enabled: false, model: getDefaultAIConfig(provider).model,
                copilotModel: getDefaultCopilotModel(provider), expected: { provider, effort: 'minimal', budget: 32000 } });
            expect(options?.providerOptions.map(choice => choice.value)).toEqual(providers);
            expect(options?.providerOptions.every(choice => choice.label.length > 0)).toBe(true);
            expect(options?.modelOptions).toContain(options?.model);
            expect(options?.copilotModelOptions).toContain(options?.copilotModel);
            expect(Object.hasOwn(ai, 'model')).toBe(false);
        }
        const options = buildNativeAITextConfigurationOptionsV2({ ai: { provider: 'gemini', model: 'my-model', copilotModel: 'my-copilot' } }, getTranslator('en'));
        expect(options?.modelOptions.filter(value => value === 'my-model')).toEqual(['my-model']);
        expect(options?.copilotModelOptions).toContain('my-copilot');
        expect(nativeAITextConfigurationWitnessV2({})).toEqual(absentV2);
        expect(Object.keys(buildNativeAITextConfigurationOptions({})!).sort()).toEqual(
            ['enabled', 'model', 'copilotModel', 'modelOptions', 'copilotModelOptions', 'expected'].sort());
        expect(nativeAITextConfigurationWitness({ ai: { provider: 'gemini' } })).toBeNull();
    });

    it('retains strict version/presence bounds and refuses legacy credential presence without reading it', () => {
        const request = { version: 2, requestId: ID, change: { type: 'provider', value: 'gemini' }, expected: absentV2, consent: false };
        expect(readNativeAITextConfigurationRequestV2(request)).toEqual(request);
        expect(readNativeAITextConfigurationRequest(request)).toBeNull();
        const v1 = { requestId: ID, change: { type: 'enabled', value: true }, expected: absent, consent: false };
        expect(readNativeAITextConfigurationRequest(v1)).toEqual(v1);
        expect(readNativeAITextConfigurationRequestV2(v1)).toBeNull();
        for (const invalid of [{ ...request, version: 1 }, { ...request, extra: true }, { ...request, consent: true },
            { ...request, requestId: ID.toUpperCase() }, { ...request, change: { type: 'provider', value: 'other' } },
            { ...request, expected: { ...absentV2, effortPresent: true, effort: 'low' } },
            { ...request, expected: { ...absentV2, effort: 'minimal' } },
            { ...request, expected: { ...absentV2, budgetPresent: true, budget: 32769, aiPresent: true } },
            { ...request, expected: { ...absentV2, providerPresent: true, provider: 'gemini' } },
            { ...request, expected: { ...absentV2, extra: true } }])
            expect(readNativeAITextConfigurationRequestV2(invalid)).toBeNull();
        for (const ai of [{ provider: 'other' }, { reasoningEffort: null }, { thinkingBudget: -1 },
            { thinkingBudget: 0.5 }, { thinkingBudget: 32769 }, { thinkingBudget: Infinity }])
            expect(nativeAITextConfigurationWitnessV2({ ai } as unknown as AppSettings)).toBeNull();
        const ai = {};
        Object.defineProperty(ai, 'apiKey', { enumerable: true, get() { throw new Error('credential read'); } });
        expect(nativeAITextConfigurationWitnessV2({ ai })).toBeNull();
    });

    it('selects consent from the frozen target and permits explicit agreement only for enabled intents', () => {
        for (const provider of providers) {
            const expected = nativeAITextConfigurationWitnessV2({ ai: { provider, enabled: true } })!;
            for (const target of providers) {
                const request = { version: 2 as const, requestId: ID, change: { type: 'provider' as const, value: target }, expected, consent: false };
                expect(nativeAITextConfigurationConsentTarget(request)).toBe(provider === target ? null : target);
                expect(readNativeAITextConfigurationRequestV2({ ...request, consent: true }) !== null).toBe(provider !== target);
                const disabled = { ...request, expected: { ...expected, enabled: false } };
                expect(nativeAITextConfigurationConsentTarget(disabled)).toBeNull();
                expect(readNativeAITextConfigurationRequestV2({ ...disabled, consent: true })).toBeNull();
            }
            expect(nativeAITextConfigurationConsentTarget({ version: 2, requestId: ID, expected,
                change: { type: 'enabled', value: true }, consent: false })).toBe(provider);
        }
        expect(nativeAITextConfigurationConsentTarget({ version: 2, requestId: ID, expected: absentV2,
            change: { type: 'enabled', value: true }, consent: false })).toBe('openai');
    });

    it('uses shared atomic provider defaults and no-ops effective current providers without resetting custom fields', () => {
        for (const provider of providers) {
            const selected = nativeAITextConfigurationWitnessV2({ ai: { provider, model: 'custom', copilotModel: 'custom',
                reasoningEffort: 'high', thinkingBudget: 32000 } })!;
            expect(planNativeAITextConfigurationChangeV2(selected, { type: 'provider', value: provider })).toBeNull();
            for (const target of providers.filter(value => value !== provider))
                expect(planNativeAITextConfigurationChangeV2(selected, { type: 'provider', value: target }))
                    .toEqual(getAIProviderDefaultsPatch(target, false));
        }
        expect(planNativeAITextConfigurationChangeV2(absentV2, { type: 'provider', value: 'openai' })).toBeNull();
        expect(planNativeAITextConfigurationChangeV2(absentV2, { type: 'enabled', value: false })).toEqual({ enabled: false });
    });
});


describe('Anthropic thinking private V2 controls', () => {
    const witness = (thinkingBudget?: number) => nativeAITextConfigurationWitnessV2({ ai: { provider: 'anthropic',
        ...(thinkingBudget === undefined ? {} : { thinkingBudget }) } })!;
    const request = (change: unknown, expected = witness(1024)) => ({ version: 2, requestId: ID, change, expected, consent: false });

    it('keeps the separate read closed, translated and passive for absent/custom budgets and private fields', () => {
        for (const value of [undefined, 0, 1024, 7777]) {
            const ai = { provider: 'anthropic' as const, ...(value === undefined ? {} : { thinkingBudget: value }) };
            for (const field of ['baseUrl', 'openAIExtraBodyParams', 'speechToText', 'unknown'])
                Object.defineProperty(ai, field, { enumerable: true, get() { throw new Error('private field read'); } });
            const options = buildNativeAIAnthropicThinkingOptions({ ai }, getTranslator('en'))!;
            expect(Object.keys(options).sort()).toEqual(['version', 'enabled', 'value', 'options', 'expected'].sort());
            expect(options).toMatchObject({ version: 1, enabled: (value ?? 0) > 0, value: value ?? 0,
                expected: { provider: 'anthropic', budgetPresent: value !== undefined, budget: value ?? null } });
            expect(options.options.map(entry => entry.value)).toEqual([1024, 2048, 4096]);
            expect(options.options.map(entry => entry.label)).toEqual(['Low', 'Medium', 'High']);
            expect(Object.hasOwn(ai, 'thinkingBudget')).toBe(value !== undefined);
            expect(Object.keys(buildNativeAITextConfigurationOptionsV2({ ai }, getTranslator('en'))!).sort())
                .toEqual(['version', 'provider', 'providerOptions', 'enabled', 'model', 'copilotModel', 'modelOptions', 'copilotModelOptions', 'expected'].sort());
        }
        for (const provider of ['openai', 'gemini'] as const)
            expect(buildNativeAIAnthropicThinkingOptions({ ai: { provider } }, getTranslator('en'))).toBeNull();
        expect(buildNativeAIAnthropicThinkingOptions({}, getTranslator('en'))).toBeNull();
    });

    it('rejects malformed change values, wrong provider, off-budget writes and misplaced consent before no-op planning', () => {
        for (const change of [{ type: 'anthropicThinking', value: 1 }, { type: 'anthropicThinking', value: null },
            { type: 'anthropicThinking', value: true, extra: true }, ...[0, 128, 1023, 1024.1, 7777, Infinity, NaN, true, '2048', null]
                .map(value => ({ type: 'thinkingBudget', value }))])
            expect(readNativeAITextConfigurationRequestV2(request(change))).toBeNull();
        for (const selected of [absentV2, nativeAITextConfigurationWitnessV2({ ai: { provider: 'gemini', thinkingBudget: 1024 } })!,
            nativeAITextConfigurationWitnessV2({ ai: { provider: 'openai', thinkingBudget: 1024 } })!]) {
            expect(readNativeAITextConfigurationRequestV2(request({ type: 'anthropicThinking', value: true }, selected))).toBeNull();
            expect(readNativeAITextConfigurationRequestV2(request({ type: 'thinkingBudget', value: 2048 }, selected))).toBeNull();
        }
        for (const selected of [witness(), witness(0)])
            expect(readNativeAITextConfigurationRequestV2(request({ type: 'thinkingBudget', value: 1024 }, selected))).toBeNull();
        for (const change of [{ type: 'anthropicThinking', value: true }, { type: 'thinkingBudget', value: 2048 }]) {
            const valid = request(change);
            expect(readNativeAITextConfigurationRequestV2(valid)).toEqual(valid);
            expect(readNativeAITextConfigurationRequestV2({ ...valid, consent: true })).toBeNull();
            expect(readNativeAITextConfigurationRequest(valid)).toBeNull();
        }
    });

    it('preserves already effective toggle states and writes only explicit switch or preset changes', () => {
        for (const expected of [witness(), witness(0)]) {
            expect(planNativeAITextConfigurationChangeV2(expected, { type: 'anthropicThinking', value: false })).toBeNull();
            expect(planNativeAITextConfigurationChangeV2(expected, { type: 'anthropicThinking', value: true })).toEqual({ thinkingBudget: 1024 });
        }
        for (const value of [1024, 2048, 4096, 7777]) {
            const expected = witness(value);
            expect(planNativeAITextConfigurationChangeV2(expected, { type: 'anthropicThinking', value: true })).toBeNull();
            expect(planNativeAITextConfigurationChangeV2(expected, { type: 'anthropicThinking', value: false })).toEqual({ thinkingBudget: 0 });
            for (const preset of [1024, 2048, 4096]) {
                const change = { type: 'thinkingBudget' as const, value: preset };
                expect(planNativeAITextConfigurationChangeV2(expected, change)).toEqual(value === preset ? null : { thinkingBudget: preset });
                expect(nativeAITextConfigurationConsentTarget({ ...request(change, expected), change })).toBeNull();
            }
        }
    });
});
