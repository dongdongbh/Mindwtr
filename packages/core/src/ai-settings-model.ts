/**
 * The mobile Settings › AI screen's rules (React Native's ai-settings-screen.tsx; the
 * native host contract's AI screen): what the screen shows for the stored settings, the
 * settings each control writes, the per-device consent record a provider needs before
 * task text is sent to it, and when the screen asks a provider for its live model list.
 * The host keeps the keys (ai-config.ts createAIKeyStore) and the device storage.
 */
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

/** Device storage (React Native: AsyncStorage): which providers this device agreed to send task text to. */
export const AI_PROVIDER_CONSENT_KEY = 'mindwtr-ai-provider-consent-v1';

/** A FOSS build talks only to the user's own OpenAI-compatible server; these are its model suggestions. */
export const FOSS_LOCAL_LLM_MODEL_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];
export const FOSS_LOCAL_LLM_COPILOT_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];

// Mobile only offers the small models people can realistically download over a phone
// connection; the full catalogue (and every hash and size) is whisper-models.ts.
const MOBILE_WHISPER_MODEL_IDS = new Set(['whisper-tiny', 'whisper-tiny.en', 'whisper-base', 'whisper-base.en']);
export const MOBILE_WHISPER_MODELS: WhisperModelDescriptor[] = WHISPER_MODELS
    .filter((model) => MOBILE_WHISPER_MODEL_IDS.has(model.id));
export const MOBILE_DEFAULT_WHISPER_MODEL = MOBILE_WHISPER_MODELS[0]?.id ?? 'whisper-tiny';

export const DEFAULT_OPENAI_STT_MODEL = 'gpt-transcribe';
export const DEFAULT_GEMINI_STT_MODEL = 'gemini-3.6-flash';
export const OPENAI_STT_MODEL_OPTIONS = ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
export const GEMINI_STT_MODEL_OPTIONS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];

/** Typing a key or URL by hand would otherwise fire one model-list request per keystroke. */
export const AI_MODEL_FETCH_DEBOUNCE_MS = 400;

export type SpeechProviderChoice = 'openai' | 'gemini' | 'whisper';

/** What the screen shows for the stored settings (a FOSS build shows its forced providers). */
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

/** The Whisper model the offline rows describe: the chosen one, or the first mobile model. */
export const getSelectedMobileWhisperModel = (speechModel: string): WhisperModelDescriptor | undefined => (
    MOBILE_WHISPER_MODELS.find((model) => model.id === speechModel) ?? MOBILE_WHISPER_MODELS[0]
);

type AISettingsTranslators = { t: Translate; tr: (key: string, values?: I18nTemplateValues) => string };

/** The screen's `tr`: a translated text with its {{values}} filled in. */
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

/** The question asked before this device first sends task text to `provider`. */
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

/** This device's consent record: a provider agreed to holds `true`. Unreadable reads as none (warned). */
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

/**
 * Whether a model list may ask `provider` (it sends the key there): only a provider this device agreed to, or the one the
 * assistant is on with (the synced switch carries the consent given where it was turned on). A key or an endpoint saved while
 * the assistant is off reaches no provider before its question is answered.
 */
export function canDiscoverAIModels(input: { provider: string; consent: Readonly<Record<string, boolean>>; aiEnabled: boolean; aiProvider: string }): boolean {
    return input.consent[input.provider] === true || (input.aiEnabled && input.aiProvider === input.provider);
}

/** Records this device's consent for `provider`; a failed write is warned, and the answer stands. */
export async function recordAIProviderConsent(storage: ConsentStorage, provider: AIProviderId, warn: ConsentWarn): Promise<void> {
    try {
        const consentMap = await readAIProviderConsent(storage, warn);
        consentMap[provider] = true;
        await storage.setItem(AI_PROVIDER_CONSENT_KEY, JSON.stringify(consentMap));
    } catch (error) {
        warn('Failed to save AI consent state', error);
    }
}

/** A provider choice: that provider with its default models, effort and thinking budget. */
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

/** Anthropic's thinking switch: a budget of 1,024 tokens (the default when it has one), or none. */
export const getAnthropicThinkingPatch = (enabled: boolean): { thinkingBudget: number } => ({
    thinkingBudget: enabled ? (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024) : 0,
});

/** The existing mobile Anthropic presets, with Low following the shared switch default. */
export const getAnthropicThinkingBudgetPresets = (): number[] => [getAnthropicThinkingPatch(true).thinkingBudget, 2048, 4096];

/** A speech provider choice: its default model; Whisper also takes that model's file. */
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

/** The audio language field: blank means auto-detect. */
export const normalizeSpeechLanguageInput = (value: string): string => {
    const trimmed = value.trim();
    return trimmed ? trimmed : 'auto';
};

/** A FOSS build with a stored provider (`ai.provider`) other than its local one: that provider's defaults are due. */
export const needsFossAIProviderReset = (provider: string | undefined, isFossBuild: boolean): boolean => (
    isFossBuild && ((provider ?? 'openai') as AIProviderId) !== 'openai'
);

/** A FOSS build transcribes with Whisper only: the correction its stored speech provider and model need, or null. */
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

/**
 * Whether the screen asks the provider for its chat models. A FOSS build only ever talks to the
 * user's own server, so it needs a base URL and no key; elsewhere a self-hosted OpenAI-compatible
 * server needs no key either (#930), while the official endpoints list nothing without one.
 */
export const canFetchAIChatModels = (input: { isFossBuild: boolean; provider: AIProviderId; apiKey: string; baseUrl: string }): boolean => (
    input.isFossBuild
        ? Boolean(input.baseUrl)
        : Boolean(input.apiKey) || (input.provider === 'openai' && Boolean(input.baseUrl))
);

/**
 * Which model list the speech card asks for: Whisper is a local sha256-pinned catalog, never
 * fetched; Gemini transcribes with its chat models; null when a cloud provider has neither a key
 * nor (OpenAI) a base URL.
 */
export function getSpeechModelListKind(input: { provider: SpeechProviderChoice; apiKey: string; baseUrl: string }): 'transcription' | 'chat' | null {
    if (input.provider === 'whisper') return null;
    if (!input.apiKey && !(input.provider === 'openai' && input.baseUrl)) return null;
    return input.provider === 'openai' ? 'transcription' : 'chat';
}
