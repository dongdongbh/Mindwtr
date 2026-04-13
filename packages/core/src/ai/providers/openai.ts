import type { AIProvider, AIProviderConfig, BreakdownInput, BreakdownResponse, ClarifyInput, ClarifyResponse, CopilotInput, CopilotResponse, ReviewAnalysisInput, ReviewAnalysisResponse, AIRequestOptions } from '../types';
import { buildBreakdownPrompt, buildClarifyPrompt, buildCopilotPrompt, buildReviewAnalysisPrompt } from '../prompts';
import { fetchWithTimeout, normalizeTags, normalizeTimeEstimate, parseJson, rateLimit } from '../utils';
import { isBreakdownResponse, isClarifyResponse, isCopilotResponse, isReviewAnalysisResponse } from '../validators';

const OPENAI_BASE_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const resolveTimeoutMs = (value?: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;

async function buildOpenAIError(response: Response, usingOfficialOpenAI: boolean): Promise<Error> {
    const status = response.status;
    let message = '';
    let code = '';
    let type = '';
    let raw = '';
    try {
        const data = await response.json() as { error?: { message?: string; code?: string; type?: string } };
        if (data?.error) {
            message = data.error.message ?? '';
            code = data.error.code ?? '';
            type = data.error.type ?? '';
        } else {
            raw = JSON.stringify(data);
        }
    } catch {
        try {
            raw = await response.text();
        } catch {
            raw = '';
        }
    }

    if (status === 401) {
        return usingOfficialOpenAI
            ? new Error('OpenAI API key is invalid or missing.')
            : new Error('OpenAI-compatible endpoint rejected the request. Check the custom base URL, API key, and model.');
    }
    if (status === 403) {
        return usingOfficialOpenAI
            ? new Error('OpenAI access denied for this model or key.')
            : new Error('OpenAI-compatible endpoint denied access. Check the API key and model permissions.');
    }
    if (status === 404) {
        return usingOfficialOpenAI
            ? new Error('OpenAI model not found or unavailable for this key.')
            : new Error('OpenAI-compatible endpoint or model not found. Check the custom base URL and model.');
    }
    if (status === 429) {
        return usingOfficialOpenAI
            ? new Error('OpenAI rate limit or quota exceeded. Please try again later.')
            : new Error('OpenAI-compatible endpoint rate limit or quota exceeded. Please try again later.');
    }

    const parts = [
        `OpenAI request failed (${status})`,
        code ? `[${code}]` : '',
        type ? `(${type})` : '',
        message ? `: ${message}` : '',
        !message && raw ? `: ${raw}` : '',
    ].filter(Boolean);
    return new Error(parts.join(' ').trim());
}

async function requestOpenAI(config: AIProviderConfig, prompt: { system: string; user: string }, options?: AIRequestOptions) {
    const url = config.endpoint || OPENAI_BASE_URL;
    const usingOfficialOpenAI = url === OPENAI_BASE_URL;
    const apiKey = String(config.apiKey || '').trim();
    if (!apiKey && usingOfficialOpenAI) {
        throw new Error('OpenAI API key is required.');
    }
    const reasoningEffort = config.model.startsWith('gpt-5') && config.reasoningEffort
        ? config.reasoningEffort
        : undefined;

    const body = {
        model: config.model,
        messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    await rateLimit('openai');

    let response: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                },
                resolveTimeoutMs(config.timeoutMs),
                'OpenAI',
                options?.signal
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
            throw await buildOpenAIError(response, usingOfficialOpenAI);
        }
        break;
    }

    if (!response) {
        throw new Error('OpenAI request failed to start.');
    }

    const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
    };

    const text = result.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error('OpenAI returned no content.');
    }
    return text;
}

export function createOpenAIProvider(config: AIProviderConfig): AIProvider {
    return {
        clarifyTask: async (input: ClarifyInput, options?: AIRequestOptions): Promise<ClarifyResponse> => {
            const prompt = buildClarifyPrompt(input);
            const text = await requestOpenAI(config, prompt, options);
            try {
                return parseJson<ClarifyResponse>(text, isClarifyResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestOpenAI(config, retryPrompt, options);
                return parseJson<ClarifyResponse>(retryText, isClarifyResponse);
            }
        },
        breakDownTask: async (input: BreakdownInput, options?: AIRequestOptions): Promise<BreakdownResponse> => {
            const prompt = buildBreakdownPrompt(input);
            const text = await requestOpenAI(config, prompt, options);
            try {
                return parseJson<BreakdownResponse>(text, isBreakdownResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestOpenAI(config, retryPrompt, options);
                return parseJson<BreakdownResponse>(retryText, isBreakdownResponse);
            }
        },
        analyzeReview: async (input: ReviewAnalysisInput, options?: AIRequestOptions): Promise<ReviewAnalysisResponse> => {
            const prompt = buildReviewAnalysisPrompt(input.items);
            const text = await requestOpenAI(config, prompt, options);
            try {
                return parseJson<ReviewAnalysisResponse>(text, isReviewAnalysisResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestOpenAI(config, retryPrompt, options);
                return parseJson<ReviewAnalysisResponse>(retryText, isReviewAnalysisResponse);
            }
        },
        predictMetadata: async (input: CopilotInput, options?: AIRequestOptions): Promise<CopilotResponse> => {
            const prompt = buildCopilotPrompt(input);
            const text = await requestOpenAI(config, prompt, options);
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
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestOpenAI(config, retryPrompt, options);
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
