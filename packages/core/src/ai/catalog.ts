import type { AIProviderConfig, AIProviderId, AIReasoningEffort } from './types';

// GPT-5.6 family (current as of 2026-07-31): terra balances intelligence and
// cost (assistant default), luna is the cost/latency tier (copilot), and
// gpt-5.6 (alias of gpt-5.6-sol) the frontier tier for harder planning. The
// mini/nano naming is gone with this generation. Older gpt-5.x/gpt-4o ids are
// NOT retired (no deprecation listed as of 2026-07) and still work if a user
// types them — they are just no longer suggested.
export const OPENAI_DEFAULT_MODEL = 'gpt-5.6-terra';
export const OPENAI_FAST_MODEL = 'gpt-5.6-luna';
export const OPENAI_SMART_MODEL = 'gpt-5.6';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';
export const OPENAI_COPILOT_DEFAULT_MODEL = OPENAI_FAST_MODEL;
export const GEMINI_COPILOT_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const ANTHROPIC_COPILOT_DEFAULT_MODEL = 'claude-haiku-4-5';
// OrcaRouter is an OpenAI-compatible routing gateway: the `orcarouter/*` ids
// it exposes are gateway-level routes (fusion = flagship, fusion-mini = fast
// tier), not a single vendor's model. Verified live on the gateway's
// /v1/chat/completions endpoint before adding. Brand-named vendor ids are
// listed as suggestions too; the live /v1/models fetch in model-list.ts
// replaces this list whenever an API key is present.
export const ORCAROUTER_DEFAULT_MODEL = 'orcarouter/fusion';
export const ORCAROUTER_COPILOT_DEFAULT_MODEL = 'orcarouter/fusion-mini';
export const DEFAULT_GEMINI_THINKING_BUDGET = 0;
export const DEFAULT_ANTHROPIC_THINKING_BUDGET = 0;

export const OPENAI_MODEL_OPTIONS = [
    OPENAI_SMART_MODEL,
    OPENAI_DEFAULT_MODEL,
    OPENAI_FAST_MODEL,
];
export const GEMINI_MODEL_OPTIONS = [
    GEMINI_DEFAULT_MODEL,
    'gemini-3.5-flash',
    GEMINI_COPILOT_DEFAULT_MODEL,
];
// Fable/Mythos stay deliberately excluded (pricing/retention profile is wrong
// for a consumer task app). claude-opus-5 ships at Opus 4.8 pricing, so it
// replaces claude-opus-4-7 (two generations back, still typable) in the list.
export const ANTHROPIC_MODEL_OPTIONS = [
    ANTHROPIC_DEFAULT_MODEL,
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-opus-5',
    'claude-opus-4-8',
];
export const ORCAROUTER_MODEL_OPTIONS = [
    ORCAROUTER_DEFAULT_MODEL,
    ORCAROUTER_COPILOT_DEFAULT_MODEL,
    'orcarouter/fusion-flash',
    'orcarouter/free',
    'openai/gpt-5.6-terra',
    'anthropic/claude-sonnet-5',
    'google/gemini-3.6-flash',
];


// Providers retire model ids on their own schedules (Google pulled
// gemini-2.5-flash on 2026-07-09, three months before its announced date;
// Anthropic's claude-3-5-haiku/3-7-sonnet 404 since 2026-02-19). Saved
// settings and stale defaults must keep working, so requests remap retired
// ids to the closest current tier at call time. User-typed ids that are not
// in these maps pass through untouched.
const RETIRED_GEMINI_MODELS: Record<string, string> = {
    'gemini-1.5-flash': GEMINI_DEFAULT_MODEL,
    'gemini-1.5-flash-8b': GEMINI_COPILOT_DEFAULT_MODEL,
    'gemini-1.5-pro': GEMINI_DEFAULT_MODEL,
    'gemini-2.0-flash': GEMINI_DEFAULT_MODEL,
    'gemini-2.0-flash-lite': GEMINI_COPILOT_DEFAULT_MODEL,
    'gemini-2.5-flash': GEMINI_DEFAULT_MODEL,
    'gemini-2.5-flash-lite': GEMINI_COPILOT_DEFAULT_MODEL,
    'gemini-3-flash-preview': GEMINI_DEFAULT_MODEL,
};

export function resolveGeminiModel(model?: string | null): string {
    const id = String(model ?? '').trim();
    if (!id) return GEMINI_DEFAULT_MODEL;
    return RETIRED_GEMINI_MODELS[id.toLowerCase()] ?? id;
}

const RETIRED_ANTHROPIC_MODELS: Record<string, string> = {
    'claude-2.0': ANTHROPIC_DEFAULT_MODEL,
    'claude-2.1': ANTHROPIC_DEFAULT_MODEL,
    'claude-3-sonnet-20240229': ANTHROPIC_DEFAULT_MODEL,
    'claude-3-5-sonnet-20240620': ANTHROPIC_DEFAULT_MODEL,
    'claude-3-5-sonnet-20241022': ANTHROPIC_DEFAULT_MODEL,
    'claude-3-7-sonnet': ANTHROPIC_DEFAULT_MODEL,
    'claude-3-7-sonnet-20250219': ANTHROPIC_DEFAULT_MODEL,
    'claude-3-haiku-20240307': ANTHROPIC_COPILOT_DEFAULT_MODEL,
    'claude-3-5-haiku': ANTHROPIC_COPILOT_DEFAULT_MODEL,
    'claude-3-5-haiku-20241022': ANTHROPIC_COPILOT_DEFAULT_MODEL,
    'claude-3-opus-20240229': 'claude-opus-4-8',
    'claude-opus-4': 'claude-opus-4-8',
    'claude-opus-4-0': 'claude-opus-4-8',
    'claude-opus-4-20250514': 'claude-opus-4-8',
    'claude-opus-4-1': 'claude-opus-4-8',
    'claude-opus-4-1-20250805': 'claude-opus-4-8',
    'claude-sonnet-4': ANTHROPIC_DEFAULT_MODEL,
    'claude-sonnet-4-0': ANTHROPIC_DEFAULT_MODEL,
    'claude-sonnet-4-20250514': ANTHROPIC_DEFAULT_MODEL,
};

export function resolveAnthropicModel(model?: string | null): string {
    const id = String(model ?? '').trim();
    if (!id) return ANTHROPIC_DEFAULT_MODEL;
    return RETIRED_ANTHROPIC_MODELS[id.toLowerCase()] ?? id;
}

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
                    : provider === 'orcarouter'
                        ? ORCAROUTER_DEFAULT_MODEL
                        : GEMINI_DEFAULT_MODEL,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        ...(provider === 'gemini' ? { thinkingBudget: DEFAULT_GEMINI_THINKING_BUDGET } : {}),
        ...(provider === 'anthropic' ? { thinkingBudget: DEFAULT_ANTHROPIC_THINKING_BUDGET } : {}),
    };
}

export function getModelOptions(provider: AIProviderId): string[] {
    if (provider === 'openai') return OPENAI_MODEL_OPTIONS;
    if (provider === 'anthropic') return ANTHROPIC_MODEL_OPTIONS;
    if (provider === 'orcarouter') return ORCAROUTER_MODEL_OPTIONS;
    return GEMINI_MODEL_OPTIONS;
}

export function getDefaultCopilotModel(provider: AIProviderId): string {
    if (provider === 'openai') return OPENAI_COPILOT_DEFAULT_MODEL;
    if (provider === 'anthropic') return ANTHROPIC_COPILOT_DEFAULT_MODEL;
    if (provider === 'orcarouter') return ORCAROUTER_COPILOT_DEFAULT_MODEL;
    return GEMINI_COPILOT_DEFAULT_MODEL;
}

export function getCopilotModelOptions(provider: AIProviderId): string[] {
    return getModelOptions(provider);
}
