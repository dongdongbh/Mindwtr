import { exact, isNativeJsonWithinBytes, record } from './native-json';
import { getCopilotModelOptions, getDefaultAIConfig, getDefaultCopilotModel, getModelOptions } from './ai/catalog';
import type { AppSettings } from './types';
import type { AIProviderId, AIReasoningEffort } from './ai/types';
import type { TranslateFn } from './i18n';
import { createAISettingsTranslator, getAIProviderDefaultsPatch, getAIProviderLabel, getAnthropicThinkingPatch, getAnthropicThinkingBudgetPresets } from './ai-settings-model';

export type AITextConfigurationChange = { type: 'enabled'; value: boolean }
    | { type: 'model' | 'copilotModel'; value: string };
export type AITextConfigurationWitness = {
    aiPresent: boolean; providerPresent: boolean; provider: 'openai' | null;
    enabledPresent: boolean; enabled: boolean | null;
    modelPresent: boolean; model: string | null;
    copilotModelPresent: boolean; copilotModel: string | null;
    stampPresent: boolean; stamp: string | null;
};
export type AITextConfigurationRequest = { requestId: string; change: AITextConfigurationChange;
    expected: AITextConfigurationWitness; consent: boolean };
export type AITextConfigurationResult = { change: AITextConfigurationChange; changed: boolean };
export type PreparedAITextConfiguration = { version: 1; request: AITextConfigurationRequest };
export type AITextConfigurationOptions = { enabled: boolean; model: string; copilotModel: string;
    modelOptions: string[]; copilotModelOptions: string[]; expected: AITextConfigurationWitness };

const owns = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const model = (value: unknown): value is string => typeof value === 'string' && value.length <= 2000;
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function nativeAITextConfigurationWitness(settings: AppSettings): AITextConfigurationWitness | null {
    if (!record(settings)) return null;
    const aiPresent = owns(settings, 'ai'), rawAI = aiPresent ? settings.ai : undefined;
    if (aiPresent && (!record(rawAI) || owns(rawAI, 'apiKey'))) return null;
    const ai = record(rawAI) ? rawAI : undefined;
    const providerPresent = !!ai && owns(ai, 'provider'), provider = providerPresent ? ai.provider : null;
    const enabledPresent = !!ai && owns(ai, 'enabled'), enabled = enabledPresent ? ai.enabled : null;
    const modelPresent = !!ai && owns(ai, 'model'), savedModel = modelPresent ? ai.model : null;
    const copilotModelPresent = !!ai && owns(ai, 'copilotModel'), copilotModel = copilotModelPresent ? ai.copilotModel : null;
    if (providerPresent && provider !== 'openai' || enabledPresent && typeof enabled !== 'boolean'
        || modelPresent && !model(savedModel) || copilotModelPresent && !model(copilotModel)) return null;
    const groupPresent = owns(settings, 'syncPreferencesUpdatedAt'), rawGroup = groupPresent ? settings.syncPreferencesUpdatedAt : undefined;
    if (groupPresent && !record(rawGroup)) return null;
    const group = record(rawGroup) ? rawGroup : undefined;
    const stampPresent = !!group && owns(group, 'ai'), at = stampPresent ? group.ai : null;
    if (stampPresent && !stamp(at)) return null;
    return { aiPresent, providerPresent, provider: providerPresent ? 'openai' : null,
        enabledPresent, enabled: typeof enabled === 'boolean' ? enabled : null,
        modelPresent, model: typeof savedModel === 'string' ? savedModel : null,
        copilotModelPresent, copilotModel: typeof copilotModel === 'string' ? copilotModel : null,
        stampPresent, stamp: typeof at === 'string' ? at : null };
}

const readWitness = (input: unknown): AITextConfigurationWitness | null => {
    if (!record(input) || !exact(input, ['aiPresent', 'providerPresent', 'provider', 'enabledPresent', 'enabled',
        'modelPresent', 'model', 'copilotModelPresent', 'copilotModel', 'stampPresent', 'stamp'])
        || typeof input.aiPresent !== 'boolean' || typeof input.providerPresent !== 'boolean'
        || typeof input.enabledPresent !== 'boolean' || typeof input.modelPresent !== 'boolean'
        || typeof input.copilotModelPresent !== 'boolean' || typeof input.stampPresent !== 'boolean'
        || !input.aiPresent && (input.providerPresent || input.enabledPresent || input.modelPresent || input.copilotModelPresent)
        || (input.providerPresent ? input.provider !== 'openai' : input.provider !== null)
        || (input.enabledPresent ? typeof input.enabled !== 'boolean' : input.enabled !== null)
        || (input.modelPresent ? !model(input.model) : input.model !== null)
        || (input.copilotModelPresent ? !model(input.copilotModel) : input.copilotModel !== null)
        || (input.stampPresent ? !stamp(input.stamp) : input.stamp !== null)) return null;
    return { aiPresent: input.aiPresent, providerPresent: input.providerPresent,
        provider: input.provider === 'openai' ? 'openai' : null,
        enabledPresent: input.enabledPresent, enabled: typeof input.enabled === 'boolean' ? input.enabled : null,
        modelPresent: input.modelPresent, model: typeof input.model === 'string' ? input.model : null,
        copilotModelPresent: input.copilotModelPresent, copilotModel: typeof input.copilotModel === 'string' ? input.copilotModel : null,
        stampPresent: input.stampPresent, stamp: typeof input.stamp === 'string' ? input.stamp : null };
};

export const readAITextConfigurationChange = (input: unknown): AITextConfigurationChange | null => {
    if (!record(input) || !exact(input, ['type', 'value'])) return null;
    if (input.type === 'enabled' && typeof input.value === 'boolean') return { type: 'enabled', value: input.value };
    if ((input.type === 'model' || input.type === 'copilotModel') && model(input.value))
        return { type: input.type, value: input.value };
    return null;
};

export const readNativeAITextConfigurationRequest = (input: unknown): AITextConfigurationRequest | null => {
    if (!isNativeJsonWithinBytes(input, 32 * 1024) || !record(input)
        || !exact(input, ['requestId', 'change', 'expected', 'consent'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || typeof input.consent !== 'boolean') return null;
    const expected = readWitness(input.expected), change = readAITextConfigurationChange(input.change);
    if (!expected || !change || input.consent && !(change.type === 'enabled' && change.value)) return null;
    return { requestId: input.requestId, change, expected, consent: input.consent };
};

export function planNativeAITextConfigurationChange(expected: AITextConfigurationWitness,
    change: AITextConfigurationChange): Partial<NonNullable<AppSettings['ai']>> | null {
    switch (change.type) {
        case 'enabled': return expected.enabledPresent && expected.enabled === change.value ? null : { enabled: change.value };
        case 'model': return expected.modelPresent && expected.model === change.value ? null : { model: change.value };
        case 'copilotModel': return expected.copilotModelPresent && expected.copilotModel === change.value ? null : { copilotModel: change.value };
    }
}

export function buildNativeAITextConfigurationOptions(settings: AppSettings): AITextConfigurationOptions | null {
    const expected = nativeAITextConfigurationWitness(settings);
    if (!expected) return null;
    const selectedModel = expected.model ?? getDefaultAIConfig('openai').model;
    const copilotModel = expected.copilotModel ?? getDefaultCopilotModel('openai');
    return { enabled: expected.enabled === true, model: selectedModel, copilotModel,
        modelOptions: Array.from(new Set([...getModelOptions('openai'), selectedModel])),
        copilotModelOptions: Array.from(new Set([...getCopilotModelOptions('openai'), copilotModel])), expected };
}


export type AITextConfigurationChangeV2 = AITextConfigurationChange | { type: 'provider'; value: AIProviderId }
    | { type: 'anthropicThinking'; value: boolean } | { type: 'thinkingBudget'; value: number };
export type AITextConfigurationWitnessV2 = Omit<AITextConfigurationWitness, 'provider'> & {
    provider: AIProviderId | null;
    effortPresent: boolean; effort: AIReasoningEffort | null;
    budgetPresent: boolean; budget: number | null;
};
export type AITextConfigurationRequestV2 = { version: 2; requestId: string; change: AITextConfigurationChangeV2;
    expected: AITextConfigurationWitnessV2; consent: boolean };
export type AITextConfigurationResultV2 = { change: AITextConfigurationChangeV2; changed: boolean };
export type PreparedAITextConfigurationV2 = { version: 2; request: AITextConfigurationRequestV2 };
export type AITextConfigurationOptionsV2 = { version: 2; provider: AIProviderId;
    providerOptions: { value: AIProviderId; label: string }[];
    enabled: boolean; model: string; copilotModel: string;
    modelOptions: string[]; copilotModelOptions: string[]; expected: AITextConfigurationWitnessV2 };

export type AIAnthropicThinkingOptions = { version: 1; enabled: boolean; value: number;
    options: { value: number; label: string }[]; expected: AITextConfigurationWitnessV2 };
const anthropicBudget = (expected: AITextConfigurationWitnessV2): number =>
    expected.budget ?? getDefaultAIConfig('anthropic').thinkingBudget ?? 0;
const anthropicChangeAllowed = (expected: AITextConfigurationWitnessV2, change: AITextConfigurationChangeV2): boolean => {
    if (change.type !== 'anthropicThinking' && change.type !== 'thinkingBudget') return true;
    return expected.provider === 'anthropic' && (change.type === 'anthropicThinking'
        || anthropicBudget(expected) > 0 && getAnthropicThinkingBudgetPresets().includes(change.value));
};

const providers: AIProviderId[] = ['openai', 'gemini', 'anthropic'];
const provider = (value: unknown): value is AIProviderId => value === 'openai' || value === 'gemini' || value === 'anthropic';
const effort = (value: unknown): value is AIReasoningEffort => value === 'minimal' || value === 'low' || value === 'medium' || value === 'high';
const budget = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 32768;

export function nativeAITextConfigurationWitnessV2(settings: AppSettings): AITextConfigurationWitnessV2 | null {
    if (!record(settings)) return null;
    const aiPresent = owns(settings, 'ai'), rawAI = aiPresent ? settings.ai : undefined;
    if (aiPresent && (!record(rawAI) || owns(rawAI, 'apiKey'))) return null;
    const ai = record(rawAI) ? rawAI : undefined;
    const providerPresent = !!ai && owns(ai, 'provider'), selected = providerPresent ? ai.provider : null;
    if (providerPresent && !provider(selected)) return null;
    const scalars: Record<string, unknown> = {};
    for (const field of ['enabled', 'model', 'copilotModel']) if (ai && owns(ai, field)) scalars[field] = (ai as Record<string, unknown>)[field];
    const projected: Record<string, unknown> = {};
    if (aiPresent) projected.ai = scalars;
    if (owns(settings, 'syncPreferencesUpdatedAt')) projected.syncPreferencesUpdatedAt = settings.syncPreferencesUpdatedAt;
    const base = nativeAITextConfigurationWitness(projected as AppSettings);
    if (!base) return null;
    const effortPresent = !!ai && owns(ai, 'reasoningEffort'), savedEffort = effortPresent ? ai.reasoningEffort : null;
    const budgetPresent = !!ai && owns(ai, 'thinkingBudget'), savedBudget = budgetPresent ? ai.thinkingBudget : null;
    if (effortPresent && !effort(savedEffort) || budgetPresent && !budget(savedBudget)) return null;
    return { ...base, providerPresent, provider: provider(selected) ? selected : null,
        effortPresent, effort: effort(savedEffort) ? savedEffort : null,
        budgetPresent, budget: budget(savedBudget) ? savedBudget : null };
}

const readWitnessV2 = (input: unknown): AITextConfigurationWitnessV2 | null => {
    if (!record(input) || !exact(input, ['aiPresent', 'providerPresent', 'provider', 'enabledPresent', 'enabled',
        'modelPresent', 'model', 'copilotModelPresent', 'copilotModel', 'effortPresent', 'effort', 'budgetPresent', 'budget', 'stampPresent', 'stamp'])
        || (input.providerPresent ? !provider(input.provider) : input.provider !== null)
        || typeof input.effortPresent !== 'boolean' || typeof input.budgetPresent !== 'boolean'
        || !input.aiPresent && (input.effortPresent || input.budgetPresent)
        || (input.effortPresent ? !effort(input.effort) : input.effort !== null)
        || (input.budgetPresent ? !budget(input.budget) : input.budget !== null)) return null;
    const base = readWitness({ aiPresent: input.aiPresent, providerPresent: input.providerPresent,
        provider: input.providerPresent ? 'openai' : null,
        enabledPresent: input.enabledPresent, enabled: input.enabled, modelPresent: input.modelPresent, model: input.model,
        copilotModelPresent: input.copilotModelPresent, copilotModel: input.copilotModel, stampPresent: input.stampPresent, stamp: input.stamp });
    return base ? { ...base, provider: provider(input.provider) ? input.provider : null,
        effortPresent: input.effortPresent, effort: effort(input.effort) ? input.effort : null,
        budgetPresent: input.budgetPresent, budget: budget(input.budget) ? input.budget : null } : null;
};
export const readAITextConfigurationChangeV2 = (input: unknown): AITextConfigurationChangeV2 | null => {
    const scalar = readAITextConfigurationChange(input);
    if (scalar) return scalar;
    if (!record(input) || !exact(input, ['type', 'value'])) return null;
    if (input.type === 'provider' && provider(input.value)) return { type: 'provider', value: input.value };
    if (input.type === 'anthropicThinking' && typeof input.value === 'boolean') return { type: 'anthropicThinking', value: input.value };
    if (input.type === 'thinkingBudget' && typeof input.value === 'number' && getAnthropicThinkingBudgetPresets().includes(input.value))
        return { type: 'thinkingBudget', value: input.value };
    return null;
};

export function nativeAITextConfigurationConsentTarget(request: AITextConfigurationRequestV2): AIProviderId | null {
    const selected = request.expected.provider ?? 'openai';
    if (request.change.type === 'enabled' && request.change.value) return selected;
    return request.change.type === 'provider' && request.change.value !== selected && request.expected.enabled === true
        ? request.change.value : null;
}

export const readNativeAITextConfigurationRequestV2 = (input: unknown): AITextConfigurationRequestV2 | null => {
    if (!isNativeJsonWithinBytes(input, 32 * 1024) || !record(input)
        || !exact(input, ['version', 'requestId', 'change', 'expected', 'consent']) || input.version !== 2
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || typeof input.consent !== 'boolean') return null;
    const expected = readWitnessV2(input.expected), change = readAITextConfigurationChangeV2(input.change);
    if (!expected || !change || !anthropicChangeAllowed(expected, change)) return null;
    const request: AITextConfigurationRequestV2 = { version: 2, requestId: input.requestId, change, expected, consent: input.consent };
    return input.consent && !nativeAITextConfigurationConsentTarget(request) ? null : request;
};

export function planNativeAITextConfigurationChangeV2(expected: AITextConfigurationWitnessV2,
    change: AITextConfigurationChangeV2): Partial<NonNullable<AppSettings['ai']>> | null {
    if (!anthropicChangeAllowed(expected, change)) return null;
    if (change.type === 'anthropicThinking') return change.value === (anthropicBudget(expected) > 0)
        ? null : getAnthropicThinkingPatch(change.value);
    if (change.type === 'thinkingBudget') return expected.budgetPresent && expected.budget === change.value
        ? null : { thinkingBudget: change.value };
    if (change.type === 'provider') return change.value === (expected.provider ?? 'openai')
        ? null : getAIProviderDefaultsPatch(change.value, false);
    return planNativeAITextConfigurationChange({ ...expected, provider: expected.providerPresent ? 'openai' : null }, change);
}

export function buildNativeAITextConfigurationOptionsV2(settings: AppSettings, t: TranslateFn): AITextConfigurationOptionsV2 | null {
    const expected = nativeAITextConfigurationWitnessV2(settings);
    if (!expected) return null;
    const selected = expected.provider ?? 'openai', model = expected.model ?? getDefaultAIConfig(selected).model;
    const copilotModel = expected.copilotModel ?? getDefaultCopilotModel(selected), tr = createAISettingsTranslator(t);
    return { version: 2, provider: selected,
        providerOptions: providers.map(value => ({ value, label: getAIProviderLabel(value, false, { t, tr }) })),
        enabled: expected.enabled === true, model, copilotModel,
        modelOptions: Array.from(new Set([...getModelOptions(selected), model])),
        copilotModelOptions: Array.from(new Set([...getCopilotModelOptions(selected), copilotModel])), expected };
}

export function buildNativeAIAnthropicThinkingOptions(settings: AppSettings, t: TranslateFn): AIAnthropicThinkingOptions | null {
    const expected = nativeAITextConfigurationWitnessV2(settings);
    if (!expected || expected.provider !== 'anthropic') return null;
    const value = anthropicBudget(expected);
    const labels = ['settings.aiThinkingLow', 'settings.aiThinkingMedium', 'settings.aiThinkingHigh'];
    return { version: 1, enabled: value > 0, value,
        options: getAnthropicThinkingBudgetPresets().map((value, index) => ({ value, label: t(labels[index]) })), expected };
}
