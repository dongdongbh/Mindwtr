import { AI_REQUEST_TIMEOUT_OPTIONS } from './ai-config';
import { resolveAISettingsScreenState } from './ai-settings-model';
import type { AppSettings } from './types';

const malformed = () => new Error('INVALID_INPUT: Saved AI configuration is malformed');
const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
    return value as Record<string, unknown>;
};
const choice = <T extends string>(value: unknown, values: readonly T[]): T | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !values.includes(value as T)) throw malformed();
    return value as T;
};
const boolean = (value: unknown): boolean | undefined => {
    if (value !== undefined && typeof value !== 'boolean') throw malformed();
    return value as boolean | undefined;
};

/** Private saved controls only: defaults stay in this projection, never in persisted settings. */
export function buildNativeAISettingsProjection(settings: AppSettings) {
    const saved = object(settings), ai = saved.ai === undefined ? {} : object(saved.ai);
    const speech = ai.speechToText === undefined ? {} : object(ai.speechToText);
    const thinkingBudget = ai.thinkingBudget, timeout = ai.requestTimeoutSeconds;
    if (thinkingBudget !== undefined && (!Number.isSafeInteger(thinkingBudget)
        || (thinkingBudget as number) < 0 || (thinkingBudget as number) > 32768)) throw malformed();
    if (timeout !== undefined && !AI_REQUEST_TIMEOUT_OPTIONS.some(option => option === timeout)) throw malformed();
    // Do not even read arbitrary model/language strings, endpoints, body JSON, credentials or local paths.
    const state = resolveAISettingsScreenState({ ai: {
        enabled: boolean(ai.enabled), provider: choice(ai.provider, ['openai', 'gemini', 'anthropic']),
        reasoningEffort: choice(ai.reasoningEffort, ['minimal', 'low', 'medium', 'high']),
        thinkingBudget: thinkingBudget as number | undefined, requestTimeoutSeconds: timeout as number | undefined,
        speechToText: { enabled: boolean(speech.enabled), provider: choice(speech.provider, ['openai', 'gemini', 'whisper', 'parakeet']),
            mode: choice(speech.mode, ['smart_parse', 'transcribe_only']),
            fieldStrategy: choice(speech.fieldStrategy, ['smart', 'title_only', 'description_only']) },
    } }, false);
    const choices = (values: string[]) => {
        if (values.length > 16 || values.some(value => typeof value !== 'string' || value.length > 64
            || !/^[a-z0-9][a-z0-9.-]*$/.test(value))) throw malformed();
        return [...values];
    };
    return { version: 1 as const, aiProvider: state.aiProvider, aiEnabled: state.aiEnabled,
        staticAiModelOptions: choices(state.staticAiModelOptions), aiReasoningEffort: state.aiReasoningEffort,
        aiThinkingBudget: state.aiThinkingBudget, staticAiCopilotOptions: choices(state.staticAiCopilotOptions),
        aiRequestTimeoutSeconds: state.aiRequestTimeoutSeconds, anthropicThinkingEnabled: state.anthropicThinkingEnabled,
        speechEnabled: state.speechEnabled, speechProvider: state.speechProvider,
        speechMode: state.speechMode, speechFieldStrategy: state.speechFieldStrategy,
        staticSpeechModelOptions: choices(state.staticSpeechModelOptions) };
}

export type NativeAISettingsProjection = ReturnType<typeof buildNativeAISettingsProjection>;
