import type {
    AIProvider,
    AIProviderConfig,
    BreakdownInput,
    BreakdownResponse,
    ClarifyInput,
    ClarifyResponse,
    CopilotInput,
    CopilotResponse,
    ReviewAnalysisInput,
    ReviewAnalysisResponse,
    AIRequestOptions,
} from '../types';
import { buildBreakdownPrompt, buildClarifyPrompt, buildCopilotPrompt, buildReviewAnalysisPrompt } from '../prompts';
import { fetchWithTimeout, normalizeTags, normalizeTimeEstimate, parseJson, rateLimit } from '../utils';
import { isBreakdownResponse, isClarifyResponse, isCopilotResponse, isReviewAnalysisResponse } from '../validators';
import { sleep } from '../../async-utils';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_TOKENS = 1024;

const resolveTimeoutMs = (value?: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;

async function buildAnthropicError(response: Response, usingOfficialAnthropic: boolean): Promise<Error> {
    const status = response.status;
    let message = '';
    let type = '';
    let raw = '';
    // The request id is the handle Anthropic support and logs key off; prefer the
    // response header (present even when the body isn't JSON) and fall back to the body.
    let requestId = response.headers.get('request-id') ?? '';
    try {
        raw = await response.text();
    } catch {
        raw = '';
    }
    if (raw) {
        try {
            const data = JSON.parse(raw) as { error?: { message?: string; type?: string }; request_id?: string };
            if (typeof data?.request_id === 'string' && data.request_id) {
                requestId = data.request_id;
            }
            if (data?.error) {
                message = data.error.message ?? '';
                type = data.error.type ?? '';
                raw = '';
            }
        } catch {
            // Not JSON; fall back to the raw body text below.
        }
    }

    // Keep Anthropic's own explanation (and request id) on the friendly messages —
    // e.g. a 401 may be "invalid x-api-key" vs a disabled org, which changes the fix.
    const detail = [
        message || raw,
        requestId ? `request-id: ${requestId}` : '',
    ].filter(Boolean).join(', ');
    const withDetail = (friendly: string) => new Error(detail ? `${friendly} (${detail})` : friendly);

    if (status === 401) {
        return usingOfficialAnthropic
            ? withDetail('Anthropic API key is invalid or missing.')
            : withDetail('Anthropic-compatible endpoint rejected the request. Check the custom base URL, API key, and model.');
    }
    if (status === 403) {
        return usingOfficialAnthropic
            ? withDetail('Anthropic access denied for this model or key.')
            : withDetail('Anthropic-compatible endpoint denied access. Check the API key and model permissions.');
    }
    if (status === 404) {
        return usingOfficialAnthropic
            ? withDetail('Anthropic model not found or unavailable for this key.')
            : withDetail('Anthropic-compatible endpoint or model not found. Check the custom base URL and model.');
    }
    if (status === 429) {
        return usingOfficialAnthropic
            ? withDetail('Anthropic rate limit or quota exceeded. Please try again later.')
            : withDetail('Anthropic-compatible endpoint rate limit or quota exceeded. Please try again later.');
    }

    const parts = [
        `Anthropic request failed (${status})`,
        type ? `[${type}]` : '',
        requestId ? `(${requestId})` : '',
        message ? `: ${message}` : '',
        !message && raw ? `: ${raw}` : '',
    ].filter(Boolean);
    return new Error(parts.join(' ').trim());
}

async function requestAnthropic(
    config: AIProviderConfig,
    prompt: { system: string; user: string },
    options?: AIRequestOptions
) {
    // Trim to tolerate keys pasted with a trailing newline or spaces, which
    // Anthropic otherwise rejects with a 401 (see OpenAI provider for parity).
    const apiKey = String(config.apiKey || '').trim();
    if (!apiKey) {
        throw new Error('Anthropic API key is required.');
    }
    const url = config.endpoint || ANTHROPIC_BASE_URL;
    const usingOfficialAnthropic = url === ANTHROPIC_BASE_URL;
    const thinkingBudget = typeof config.thinkingBudget === 'number' ? config.thinkingBudget : 0;
    const maxTokens =
        thinkingBudget > 0 ? Math.max(DEFAULT_MAX_TOKENS, thinkingBudget + 256) : DEFAULT_MAX_TOKENS;

    const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: maxTokens,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        temperature: 0.2,
    };

    if (thinkingBudget > 0) {
        body.thinking = {
            type: 'enabled',
            budget_tokens: thinkingBudget,
        };
    }

    await rateLimit('anthropic');

    let response: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        // Requests carry a browser Origin (Tauri webview / web build), which
                        // Anthropic blocks unless this header opts in. Safe here: the key is
                        // user-supplied and stored locally, not exposed in a public web page.
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: JSON.stringify(body),
                },
                resolveTimeoutMs(config.timeoutMs),
                'Anthropic',
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
            throw await buildAnthropicError(response, usingOfficialAnthropic);
        }
        break;
    }

    if (!response) {
        throw new Error('Anthropic request failed to start.');
    }

    const result = await response.json() as {
        content?: Array<{ type?: string; text?: string }>;
    };

    const textBlocks = (result.content || []).filter(
        (block) => block.type === 'text' && typeof block.text === 'string'
    ) as Array<{ text: string }>;

    const text = textBlocks.map((block) => block.text).join('\n').trim();
    if (!text) {
        throw new Error('Anthropic returned no content.');
    }
    return text;
}

export function createAnthropicProvider(config: AIProviderConfig): AIProvider {
    return {
        clarifyTask: async (input: ClarifyInput, options?: AIRequestOptions): Promise<ClarifyResponse> => {
            const prompt = buildClarifyPrompt(input);
            const text = await requestAnthropic(config, prompt, options);
            try {
                return parseJson<ClarifyResponse>(text, isClarifyResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestAnthropic(config, retryPrompt, options);
                return parseJson<ClarifyResponse>(retryText, isClarifyResponse);
            }
        },
        breakDownTask: async (input: BreakdownInput, options?: AIRequestOptions): Promise<BreakdownResponse> => {
            const prompt = buildBreakdownPrompt(input);
            const text = await requestAnthropic(config, prompt, options);
            try {
                return parseJson<BreakdownResponse>(text, isBreakdownResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestAnthropic(config, retryPrompt, options);
                return parseJson<BreakdownResponse>(retryText, isBreakdownResponse);
            }
        },
        analyzeReview: async (input: ReviewAnalysisInput, options?: AIRequestOptions): Promise<ReviewAnalysisResponse> => {
            const prompt = buildReviewAnalysisPrompt(input.items);
            const text = await requestAnthropic(config, prompt, options);
            try {
                return parseJson<ReviewAnalysisResponse>(text, isReviewAnalysisResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestAnthropic(config, retryPrompt, options);
                return parseJson<ReviewAnalysisResponse>(retryText, isReviewAnalysisResponse);
            }
        },
        predictMetadata: async (input: CopilotInput, options?: AIRequestOptions): Promise<CopilotResponse> => {
            const prompt = buildCopilotPrompt(input);
            const text = await requestAnthropic(config, prompt, options);
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
                const retryText = await requestAnthropic(config, retryPrompt, options);
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
