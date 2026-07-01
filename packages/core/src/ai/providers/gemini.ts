import type { AIProvider, AIProviderConfig, BreakdownInput, BreakdownResponse, ClarifyInput, ClarifyResponse, CopilotInput, CopilotResponse, ReviewAnalysisInput, ReviewAnalysisResponse, AIRequestOptions } from '../types';
import { buildBreakdownPrompt, buildClarifyPrompt, buildCopilotPrompt, buildReviewAnalysisPrompt } from '../prompts';
import { fetchWithTimeout, normalizeTags, normalizeTimeEstimate, parseJson, rateLimit } from '../utils';
import { isBreakdownResponse, isClarifyResponse, isCopilotResponse, isReviewAnalysisResponse } from '../validators';
import { sleep } from '../../async-utils';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

type GeminiSchema = {
    type: 'object' | 'array';
    properties?: Record<string, unknown>;
    required?: string[];
    items?: Record<string, unknown>;
};

interface GeminiResponse {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
}

const resolveTimeoutMs = (value?: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;

// Gemini 2.5+ (and 3.x) support `thinkingConfig`; sending it to older models can be rejected.
const modelSupportsThinking = (model: string): boolean => /gemini-(2\.[5-9]|[3-9])/i.test(model);

async function buildGeminiError(response: Response, usingOfficialGemini: boolean): Promise<Error> {
    const httpStatus = response.status;
    let message = '';
    let status = '';
    let raw = '';
    try {
        raw = await response.text();
    } catch {
        raw = '';
    }
    if (raw) {
        try {
            const data = JSON.parse(raw) as { error?: { message?: string; status?: string } };
            if (data?.error) {
                message = data.error.message ?? '';
                status = data.error.status ?? '';
                raw = '';
            }
        } catch {
            // Not JSON; fall back to the raw body text below.
        }
    }

    if (httpStatus === 400 && /api key not valid/i.test(message)) {
        return new Error('Gemini API key is invalid.');
    }
    if (httpStatus === 401) {
        return usingOfficialGemini
            ? new Error('Gemini API key is invalid or missing.')
            : new Error('Gemini-compatible endpoint rejected the request. Check the custom base URL, API key, and model.');
    }
    if (httpStatus === 403) {
        return usingOfficialGemini
            ? new Error('Gemini access denied for this model or key.')
            : new Error('Gemini-compatible endpoint denied access. Check the API key and model permissions.');
    }
    if (httpStatus === 404) {
        return usingOfficialGemini
            ? new Error('Gemini model not found or unavailable for this key.')
            : new Error('Gemini-compatible endpoint or model not found. Check the custom base URL and model.');
    }
    if (httpStatus === 429) {
        return usingOfficialGemini
            ? new Error('Gemini rate limit or quota exceeded. Please try again later.')
            : new Error('Gemini-compatible endpoint rate limit or quota exceeded. Please try again later.');
    }

    const parts = [
        `Gemini request failed (${httpStatus})`,
        status ? `[${status}]` : '',
        message ? `: ${message}` : '',
        !message && raw ? `: ${raw}` : '',
    ].filter(Boolean);
    return new Error(parts.join(' ').trim());
}

const CLARIFY_SCHEMA: GeminiSchema = {
    type: 'object',
    required: ['question', 'options'],
    properties: {
        question: { type: 'string' },
        options: {
            type: 'array',
            items: {
                type: 'object',
                required: ['label', 'action'],
                properties: {
                    label: { type: 'string' },
                    action: { type: 'string' },
                },
            },
        },
        suggestedAction: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                timeEstimate: { type: 'string' },
                context: { type: 'string' },
                isProject: { type: 'boolean' },
            },
        },
    },
};

const BREAKDOWN_SCHEMA: GeminiSchema = {
    type: 'object',
    required: ['steps'],
    properties: {
        steps: {
            type: 'array',
            items: { type: 'string' },
        },
    },
};

const REVIEW_SCHEMA: GeminiSchema = {
    type: 'object',
    required: ['suggestions'],
    properties: {
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'action', 'reason'],
                properties: {
                    id: { type: 'string' },
                    action: { type: 'string' },
                    reason: { type: 'string' },
                },
            },
        },
    },
};

const COPILOT_SCHEMA: GeminiSchema = {
    type: 'object',
    properties: {
        context: { type: 'string' },
        timeEstimate: { type: 'string' },
        tags: {
            type: 'array',
            items: { type: 'string' },
        },
    },
};

async function requestGemini(config: AIProviderConfig, prompt: { system: string; user: string }, schema?: GeminiSchema, options?: AIRequestOptions) {
    const endpoint = config.endpoint || GEMINI_BASE_URL;
    const usingOfficialGemini = endpoint === GEMINI_BASE_URL;
    // Trim to tolerate keys pasted with a trailing newline or spaces (parity with OpenAI).
    const apiKey = String(config.apiKey || '').trim();
    if (!apiKey) {
        throw new Error('Gemini API key is required.');
    }
    const rawUrl = `${endpoint.replace(/\/+$/, '')}/${config.model}:generateContent`;
    let url = rawUrl;
    try {
        const parsed = new URL(rawUrl);
        if (parsed.searchParams.has('key')) {
            parsed.searchParams.delete('key');
        }
        url = parsed.toString();
    } catch {
        // If URL parsing fails, fall back to a manual cleanup of key params.
        url = rawUrl.replace(/([?&])key=[^&]+&?/gi, '$1').replace(/[?&]$/, '');
    }
    // Gemini 2.5+ "thinking" tokens count against maxOutputTokens; when the user has not
    // set a budget these models still think dynamically, which can consume the budget and
    // truncate the JSON answer (#596). Explicitly disable thinking for those models unless a
    // budget is requested. Older models that do not support thinkingConfig get nothing sent.
    const explicitBudget = typeof config.thinkingBudget === 'number' && config.thinkingBudget > 0
        ? Math.floor(config.thinkingBudget)
        : undefined;
    const thinkingBudget = explicitBudget !== undefined
        ? explicitBudget
        : modelSupportsThinking(config.model)
            ? 0
            : undefined;
    const body = {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: `${prompt.system}\n\n${prompt.user}` },
                ],
            },
        ],
        generationConfig: {
            temperature: 0.15,
            topP: 0.8,
            topK: 20,
            candidateCount: 1,
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
            ...(schema ? { responseSchema: schema } : {}),
            ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
        },
    };

    await rateLimit('gemini');

    let response: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey,
                    },
                    body: JSON.stringify(body),
                },
                resolveTimeoutMs(config.timeoutMs),
                'Gemini',
                options?.signal,
                config.fetcher
            );
        } catch (error) {
            if (attempt < MAX_RETRIES) {
                await sleep(400 * Math.pow(2, attempt));
                continue;
            }
            throw error;
        }

        if (!response.ok) {
            if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
                await sleep(400 * Math.pow(2, attempt));
                continue;
            }
            throw await buildGeminiError(response, usingOfficialGemini);
        }
        break;
    }

    if (!response) {
        throw new Error('Gemini request failed to start.');
    }

    const result = await response.json() as GeminiResponse;

    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error('Gemini returned no content.');
    }
    return text;
}

export function createGeminiProvider(config: AIProviderConfig): AIProvider {
    return {
        clarifyTask: async (input: ClarifyInput, options?: AIRequestOptions): Promise<ClarifyResponse> => {
            const prompt = buildClarifyPrompt(input);
            const text = await requestGemini(config, prompt, CLARIFY_SCHEMA, options);
            try {
                return parseJson<ClarifyResponse>(text, isClarifyResponse);
            } catch (error) {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestGemini(config, retryPrompt, CLARIFY_SCHEMA, options);
                return parseJson<ClarifyResponse>(retryText, isClarifyResponse);
            }
        },
        breakDownTask: async (input: BreakdownInput, options?: AIRequestOptions): Promise<BreakdownResponse> => {
            const prompt = buildBreakdownPrompt(input);
            const text = await requestGemini(config, prompt, BREAKDOWN_SCHEMA, options);
            try {
                return parseJson<BreakdownResponse>(text, isBreakdownResponse);
            } catch (error) {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestGemini(config, retryPrompt, BREAKDOWN_SCHEMA, options);
                return parseJson<BreakdownResponse>(retryText, isBreakdownResponse);
            }
        },
        analyzeReview: async (input: ReviewAnalysisInput, options?: AIRequestOptions): Promise<ReviewAnalysisResponse> => {
            const prompt = buildReviewAnalysisPrompt(input.items);
            const text = await requestGemini(config, prompt, REVIEW_SCHEMA, options);
            try {
                return parseJson<ReviewAnalysisResponse>(text, isReviewAnalysisResponse);
            } catch (error) {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestGemini(config, retryPrompt, REVIEW_SCHEMA, options);
                return parseJson<ReviewAnalysisResponse>(retryText, isReviewAnalysisResponse);
            }
        },
        predictMetadata: async (input: CopilotInput, options?: AIRequestOptions): Promise<CopilotResponse> => {
            const prompt = buildCopilotPrompt(input);
            const text = await requestGemini(config, prompt, COPILOT_SCHEMA, options);
            try {
                const parsed = parseJson<CopilotResponse>(text, isCopilotResponse);
                const context = typeof parsed.context === 'string' ? parsed.context : undefined;
                const timeEstimate = typeof parsed.timeEstimate === 'string' ? parsed.timeEstimate : undefined;
                const tags = Array.isArray(parsed.tags) ? normalizeTags(parsed.tags) : [];
                return {
                    context,
                    timeEstimate: normalizeTimeEstimate(timeEstimate) as CopilotResponse['timeEstimate'],
                    tags,
                };
            } catch (error) {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestGemini(config, retryPrompt, COPILOT_SCHEMA, options);
                const parsed = parseJson<CopilotResponse>(retryText, isCopilotResponse);
                const context = typeof parsed.context === 'string' ? parsed.context : undefined;
                const timeEstimate = typeof parsed.timeEstimate === 'string' ? parsed.timeEstimate : undefined;
                const tags = Array.isArray(parsed.tags) ? normalizeTags(parsed.tags) : [];
                return {
                    context,
                    timeEstimate: normalizeTimeEstimate(timeEstimate) as CopilotResponse['timeEstimate'],
                    tags,
                };
            }
        },
    };
}
