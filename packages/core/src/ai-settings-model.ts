


import type { AppSettings } from './types';
import type { AIProviderId, AIReasoningEffort } from './ai/types';
import {
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    getCopilotModelOptions,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getModelOptions,
} from './ai/catalog';
import { resolveAIRequestTimeoutSeconds } from './ai-config';
import { resolveI18nText, type I18nTemplateValues } from './i18n';
import { WHISPER_MODELS, type WhisperModelDescriptor } from './whisper-models';

type AISettings = NonNullable<AppSettings['ai']>;
type SpeechSettings = NonNullable<AISettings['speechToText']>;
type Translate = (key: string) => string;


export const AI_PROVIDER_CONSENT_KEY = 'mindwtr-ai-provider-consent-v1';


export const FOSS_LOCAL_LLM_MODEL_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];
export const FOSS_LOCAL_LLM_COPILOT_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];


const MOBILE_WHISPER_MODEL_IDS = new Set(['whisper-tiny', 'whisper-tiny.en', 'whisper-base', 'whisper-base.en']);
export const MOBILE_WHISPER_MODELS: WhisperModelDescriptor[] = WHISPER_MODELS
    .filter((model) => MOBILE_WHISPER_MODEL_IDS.has(model.id));
export const MOBILE_DEFAULT_WHISPER_MODEL = MOBILE_WHISPER_MODELS[0]?.id ?? 'whisper-tiny';

export const DEFAULT_OPENAI_STT_MODEL = 'gpt-transcribe';
export const DEFAULT_GEMINI_STT_MODEL = 'gemini-3.6-flash';
const OPENAI_STT_MODEL_OPTIONS = ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
const GEMINI_STT_MODEL_OPTIONS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];


export const AI_MODEL_FETCH_DEBOUNCE_MS = 400;

export type SpeechProviderChoice = 'openai' | 'gemini' | 'whisper';


export function resolveAISettingsScreenState(settings: AppSettings, isFossBuild: boolean) {
    const ai = settings.ai;
    const aiProvider = (isFossBuild ? 'openai' : (ai?.provider ?? 'openai')) as AIProviderId;
    const aiModel = ai?.model ?? (isFossBuild ? FOSS_LOCAL_LLM_MODEL_OPTIONS[0] : getDefaultAIConfig(aiProvider).model);
    const aiThinkingBudget = ai?.thinkingBudget ?? getDefaultAIConfig(aiProvider).thinkingBudget ?? 0;
    const speech = ai?.speechToText ?? {};
    const configuredSpeechProvider = isFossBuild ? 'whisper' : (speech.provider ?? 'gemini');
    const speechProvider = (configuredSpeechProvider === 'parakeet' ? 'whisper' : configuredSpeechProvider) as SpeechProviderChoice;
    const speechModel = speech.model ?? (
        speechProvider === 'openai'
            ? DEFAULT_OPENAI_STT_MODEL
            : speechProvider === 'gemini'
                ? DEFAULT_GEMINI_STT_MODEL
                : MOBILE_DEFAULT_WHISPER_MODEL
    );
    return {
        aiProvider,
        aiEnabled: ai?.enabled === true,
        staticAiModelOptions: isFossBuild ? FOSS_LOCAL_LLM_MODEL_OPTIONS : getModelOptions(aiProvider),
        aiModel,
        aiBaseUrl: ai?.baseUrl ?? '',
        aiOpenAIExtraBodyParams: ai?.openAIExtraBodyParams,
        aiReasoningEffort: (ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT) as AIReasoningEffort,
        aiThinkingBudget,
        staticAiCopilotOptions: isFossBuild ? FOSS_LOCAL_LLM_COPILOT_OPTIONS : getCopilotModelOptions(aiProvider),
        aiCopilotModel: ai?.copilotModel ?? (isFossBuild ? FOSS_LOCAL_LLM_COPILOT_OPTIONS[0] : getDefaultCopilotModel(aiProvider)),
        aiRequestTimeoutSeconds: resolveAIRequestTimeoutSeconds(ai?.requestTimeoutSeconds),
        anthropicThinkingEnabled: aiProvider === 'anthropic' && aiThinkingBudget > 0,
        speechEnabled: speech.enabled === true,
        speechProvider,
        speechModel,
        speechBaseUrl: speech.baseUrl ?? '',
        speechLanguage: speech.language ?? 'auto',
        speechMode: speech.mode ?? 'smart_parse',
        speechFieldStrategy: speech.fieldStrategy ?? 'smart',
        staticSpeechModelOptions: isFossBuild
            ? MOBILE_WHISPER_MODELS.map((model) => model.id)
            : speechProvider === 'openai'
                ? OPENAI_STT_MODEL_OPTIONS
                : speechProvider === 'gemini'
                    ? GEMINI_STT_MODEL_OPTIONS
                    : MOBILE_WHISPER_MODELS.map((model) => model.id),
    };
}

export type AISettingsScreenState = ReturnType<typeof resolveAISettingsScreenState>;


export const getSelectedMobileWhisperModel = (speechModel: string): WhisperModelDescriptor | undefined => (
    MOBILE_WHISPER_MODELS.find((model) => model.id === speechModel) ?? MOBILE_WHISPER_MODELS[0]
);

type AISettingsTranslators = { t: Translate; tr: (key: string, values?: I18nTemplateValues) => string };


export const createAISettingsTranslator = (t: Translate) => (key: string, values?: I18nTemplateValues) => resolveI18nText(t, key, { values });

export function getAIProviderLabel(provider: AIProviderId, isFossBuild: boolean, { t, tr }: AISettingsTranslators): string {
    return isFossBuild && provider === 'openai'
        ? tr('settings.aiMobile.localCustomOpenaiCompatible')
        : provider === 'openai'
            ? t('settings.aiProviderOpenAI')
            : provider === 'gemini'
                ? t('settings.aiProviderGemini')
                : t('settings.aiProviderAnthropic');
}

export function getAIProviderPolicyUrl(provider: AIProviderId, isFossBuild: boolean): string {
    return isFossBuild && provider === 'openai'
        ? ''
        : provider === 'openai'
            ? 'https://openai.com/policies/privacy-policy'
            : provider === 'gemini'
                ? 'https://policies.google.com/privacy'
                : 'https://www.anthropic.com/privacy';
}

export type AIConsentPrompt = { title: string; message: string; cancel: string; agree: string };


export function getAIConsentPrompt(provider: AIProviderId, isFossBuild: boolean, translators: AISettingsTranslators): AIConsentPrompt {
    const { tr } = translators;
    return {
        title: tr('settings.aiMobile.enableAiFeatures'),
        message: isFossBuild && provider === 'openai'
            ? tr('settings.aiMobile.toUseAiAssistantYourTaskTextAndOptionalNotes')
            : tr('settings.aiMobile.aiAssistantPrivacyPromptForProvider', {
                provider: getAIProviderLabel(provider, isFossBuild, translators),
                privacyUrl: getAIProviderPolicyUrl(provider, isFossBuild),
            }),
        cancel: tr('common.cancel'),
        agree: tr('settings.aiConsentAgree'),
    };
}

type ConsentStorage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
};
type ConsentWarn = (message: string, error: unknown) => void;


export async function readAIProviderConsent(storage: ConsentStorage, warn: ConsentWarn): Promise<Record<string, boolean>> {
    try {
        const raw = await storage.getItem(AI_PROVIDER_CONSENT_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const entries = Object.entries(parsed as Record<string, unknown>)
            .map(([provider, value]) => [provider, value === true] as const);
        return Object.fromEntries(entries);
    } catch (error) {
        warn('Failed to load AI consent state', error);
        return {};
    }
}


export function canDiscoverAIModels(input: { provider: string; consent: Readonly<Record<string, boolean>>; aiEnabled: boolean; aiProvider: string }): boolean {
    return input.consent[input.provider] === true || (input.aiEnabled && input.aiProvider === input.provider);
}


export async function recordAIProviderConsent(storage: ConsentStorage, provider: AIProviderId, warn: ConsentWarn): Promise<void> {
    try {
        const consentMap = await readAIProviderConsent(storage, warn);
        consentMap[provider] = true;
        await storage.setItem(AI_PROVIDER_CONSENT_KEY, JSON.stringify(consentMap));
    } catch (error) {
        warn('Failed to save AI consent state', error);
    }
}


export function getAIProviderDefaultsPatch(provider: AIProviderId, isFossBuild: boolean): Partial<AISettings> {
    const defaults = getDefaultAIConfig(provider);
    return {
        provider,
        model: isFossBuild && provider === 'openai' ? FOSS_LOCAL_LLM_MODEL_OPTIONS[0] : defaults.model,
        copilotModel: isFossBuild && provider === 'openai' ? FOSS_LOCAL_LLM_COPILOT_OPTIONS[0] : getDefaultCopilotModel(provider),
        reasoningEffort: defaults.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        thinkingBudget: defaults.thinkingBudget
            ?? (provider === 'gemini'
                ? DEFAULT_GEMINI_THINKING_BUDGET
                : provider === 'anthropic'
                    ? DEFAULT_ANTHROPIC_THINKING_BUDGET
                    : 0),
    };
}


export const getAnthropicThinkingPatch = (enabled: boolean): Partial<AISettings> => ({
    thinkingBudget: enabled ? (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024) : 0,
});


export function getSpeechProviderPatch(provider: SpeechProviderChoice, whisperModelUri: (modelId: string) => string | undefined): Partial<SpeechSettings> {
    return {
        provider,
        model: provider === 'openai'
            ? DEFAULT_OPENAI_STT_MODEL
            : provider === 'gemini'
                ? DEFAULT_GEMINI_STT_MODEL
                : MOBILE_DEFAULT_WHISPER_MODEL,
        offlineModelPath: provider === 'whisper'
            ? whisperModelUri(MOBILE_DEFAULT_WHISPER_MODEL)
            : undefined,
    };
}


export const normalizeSpeechLanguageInput = (value: string): string => {
    const trimmed = value.trim();
    return trimmed ? trimmed : 'auto';
};


export const needsFossAIProviderReset = (provider: string | undefined, isFossBuild: boolean): boolean => (
    isFossBuild && ((provider ?? 'openai') as AIProviderId) !== 'openai'
);


export function getFossSpeechCorrection(stored: Pick<SpeechSettings, 'provider' | 'model'> | undefined, isFossBuild: boolean): Partial<SpeechSettings> | null {
    if (!isFossBuild) return null;
    const configuredProvider = stored?.provider ?? 'whisper';
    const configuredModel = stored?.model;
    const modelIsValidWhisper = typeof configuredModel === 'string'
        && MOBILE_WHISPER_MODELS.some((entry) => entry.id === configuredModel);
    if (configuredProvider === 'whisper' && modelIsValidWhisper) return null;
    return {
        provider: 'whisper',
        model: modelIsValidWhisper ? configuredModel : MOBILE_DEFAULT_WHISPER_MODEL,
    };
}


export const canFetchAIChatModels = (input: { isFossBuild: boolean; provider: AIProviderId; apiKey: string; baseUrl: string }): boolean => (
    input.isFossBuild
        ? Boolean(input.baseUrl)
        : Boolean(input.apiKey) || (input.provider === 'openai' && Boolean(input.baseUrl))
);


export function getSpeechModelListKind(input: { provider: SpeechProviderChoice; apiKey: string; baseUrl: string }): 'transcription' | 'chat' | null {
    if (input.provider === 'whisper') return null;
    if (!input.apiKey && !(input.provider === 'openai' && input.baseUrl)) return null;
    return input.provider === 'openai' ? 'transcription' : 'chat';
}
