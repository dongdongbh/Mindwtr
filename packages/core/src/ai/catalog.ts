import type { AIProviderConfig, AIProviderId, AIReasoningEffort } from './types';

// GPT-5.4/5.5 family (current as of 2026-07). mini is the cost-efficient default
// for well-defined task work, nano the fast/high-frequency tier (copilot metadata),
// and 5.5 the smart tier for harder planning. Older gpt-4o/gpt-5 ids still work if a
// user types them into the model field — they are just no longer suggested.
export const OPENAI_DEFAULT_MODEL = 'gpt-5.4-mini';
export const OPENAI_FAST_MODEL = 'gpt-5.4-nano';
export const OPENAI_SMART_MODEL = 'gpt-5.5';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';
export const OPENAI_COPILOT_DEFAULT_MODEL = OPENAI_FAST_MODEL;
export const GEMINI_COPILOT_DEFAULT_MODEL = 'gemini-2.0-flash-lite';
export const ANTHROPIC_COPILOT_DEFAULT_MODEL = 'claude-haiku-4-5';
export const DEFAULT_GEMINI_THINKING_BUDGET = 0;
export const DEFAULT_ANTHROPIC_THINKING_BUDGET = 0;

export const OPENAI_MODEL_OPTIONS = [
    OPENAI_SMART_MODEL,
    'gpt-5.4',
    OPENAI_DEFAULT_MODEL,
    OPENAI_FAST_MODEL,
];
export const GEMINI_MODEL_OPTIONS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-3-flash-preview',
];
export const ANTHROPIC_MODEL_OPTIONS = [
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-sonnet-4',
    'claude-opus-4',
    'claude-3-7-sonnet',
    'claude-3-5-haiku',
];

export const DEFAULT_REASONING_EFFORT: AIReasoningEffort = 'low';
// The copilot runs on every debounced keystroke, so keep reasoning minimal to
// protect type-ahead latency on GPT-5 reasoning models (the fast/copilot default).
export const COPILOT_REASONING_EFFORT: AIReasoningEffort = 'minimal';

export function getDefaultAIConfig(provider: AIProviderId): AIProviderConfig {
    return {
        provider,
        apiKey: '',
        model:
            provider === 'openai'
                ? OPENAI_DEFAULT_MODEL
                : provider === 'anthropic'
                    ? ANTHROPIC_DEFAULT_MODEL
                    : GEMINI_DEFAULT_MODEL,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        ...(provider === 'gemini' ? { thinkingBudget: DEFAULT_GEMINI_THINKING_BUDGET } : {}),
        ...(provider === 'anthropic' ? { thinkingBudget: DEFAULT_ANTHROPIC_THINKING_BUDGET } : {}),
    };
}

export function getModelOptions(provider: AIProviderId): string[] {
    if (provider === 'openai') return OPENAI_MODEL_OPTIONS;
    if (provider === 'anthropic') return ANTHROPIC_MODEL_OPTIONS;
    return GEMINI_MODEL_OPTIONS;
}

export function getDefaultCopilotModel(provider: AIProviderId): string {
    if (provider === 'openai') return OPENAI_COPILOT_DEFAULT_MODEL;
    if (provider === 'anthropic') return ANTHROPIC_COPILOT_DEFAULT_MODEL;
    return GEMINI_COPILOT_DEFAULT_MODEL;
}

export function getCopilotModelOptions(provider: AIProviderId): string[] {
    return getModelOptions(provider);
}
