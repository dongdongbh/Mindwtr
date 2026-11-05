import type { AIProvider, AIProviderConfig, BreakdownInput, BreakdownResponse, ClarifyInput, ClarifyResponse, CopilotInput, CopilotResponse, ReviewAnalysisInput, ReviewAnalysisResponse, AIRequestOptions } from '../types';
import { buildBreakdownPrompt, buildClarifyPrompt, buildCopilotPrompt, buildReviewAnalysisPrompt } from '../prompts';
import {
    fetchTextWithTimeout,
    isAIRequestStopError,
    normalizeTags,
    normalizeTimeEstimate,
    parseJson,
    rateLimit,
    throwIfAIRequestAborted,
    type BufferedAIResponse,
    waitForAIRequestRetry,
    withAIRequestStopNotifications,
} from '../utils';
import { isBreakdownResponse, isClarifyResponse, isCopilotResponse, isReviewAnalysisResponse } from '../validators';

const OPENAI_BASE_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const resolveTimeoutMs = (value?: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;


const isReasoningModel = (model: string): boolean => {
    const id = model.trim().toLowerCase();
    return id.startsWith('gpt-5') || /^o\d+(?:-|$)/.test(id);
};


interface OpenAIResponseSchema {
    name: string;
    schema: Record<string, unknown>;
}


const nullable = (schema: Record<string, unknown>): Record<string, unknown> => ({
    anyOf: [schema, { type: 'null' }],
});

const CLARIFY_JSON_SCHEMA: OpenAIResponseSchema = {
    name: 'clarify_response',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options', 'suggestedAction'],
        properties: {
            question: { type: 'string' },
            options: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['label', 'action'],
                    properties: {
                        label: { type: 'string' },
                        action: { type: 'string' },
                    },
                },
            },


            suggestedAction: nullable({
                type: 'object',
                additionalProperties: false,
                required: ['title', 'context', 'timeEstimate', 'isProject'],
                properties: {
                    title: { type: 'string' },
                    context: nullable({ type: 'string' }),
                    timeEstimate: nullable({ type: 'string' }),
                    isProject: nullable({ type: 'boolean' }),
                },
            }),
        },
    },
};

const BREAKDOWN_JSON_SCHEMA: OpenAIResponseSchema = {
    name: 'breakdown_response',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['steps'],
        properties: {
            steps: { type: 'array', items: { type: 'string' } },
        },
    },
};

const REVIEW_JSON_SCHEMA: OpenAIResponseSchema = {
    name: 'review_analysis_response',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['suggestions'],
        properties: {
            suggestions: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'action', 'reason'],
                    properties: {
                        id: { type: 'string' },
                        action: { type: 'string', enum: ['someday', 'archive', 'breakdown', 'keep'] },
                        reason: { type: 'string' },
                    },
                },
            },
        },
    },
};

const COPILOT_JSON_SCHEMA: OpenAIResponseSchema = {
    name: 'copilot_response',
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['context', 'timeEstimate', 'tags'],
        properties: {
            context: nullable({ type: 'string' }),
            timeEstimate: nullable({ type: 'string' }),
            tags: { type: 'array', items: { type: 'string' } },
        },
    },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const extractText = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === 'string') return item;
                if (!isRecord(item)) return '';
                const text = item.text ?? item.content;
                return typeof text === 'string' ? text : '';
            })
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    if (isRecord(value)) {
        const text = value.text ?? value.content;
        if (typeof text === 'string') return text.trim();
        if (Array.isArray(value.summary)) return extractText(value.summary);
        if (typeof value.summary === 'string') return value.summary.trim();
    }
    return '';
};

const extractOpenAIMessageText = (message: unknown): string => {
    if (!isRecord(message)) return '';
    const contentText = extractText(message.content);
    if (contentText) return contentText;

    const reasoningContent = extractText(message.reasoning_content);
    if (reasoningContent) return reasoningContent;

    return extractText(message.reasoning);
};

interface OpenAIErrorInfo {
    status: number;
    message: string;
    code: string;
    type: string;
    raw: string;
}

async function readOpenAIErrorInfo(response: BufferedAIResponse): Promise<OpenAIErrorInfo> {
    const status = response.status;
    let message = '';
    let code = '';
    let type = '';
    let raw = '';


    raw = response.bodyText;
    if (raw) {
        try {
            const data = JSON.parse(raw) as {
                error?: string | { message?: string; code?: string; type?: string };
            };
            if (typeof data?.error === 'string') {
                message = data.error;
                raw = '';
            } else if (data?.error) {
                message = data.error.message ?? '';
                code = data.error.code ?? '';
                type = data.error.type ?? '';
                raw = '';
            }
        } catch {

        }
    }
    return { status, message, code, type, raw };
}


const isUnsupportedResponseFormatError = (info: OpenAIErrorInfo): boolean => {
    if (info.status !== 400) return false;
    const haystack = `${info.message} ${info.code} ${info.type}`.toLowerCase();
    return haystack.includes('response_format') || haystack.includes('json_schema') || haystack.includes('structured output');
};

const requiresJsonSchemaResponseFormat = (info: OpenAIErrorInfo): boolean => {
    if (info.status !== 400) return false;
    const haystack = `${info.message} ${info.code} ${info.type}`.toLowerCase();
    return haystack.includes('response_format')
        && haystack.includes('json_schema')
        && (haystack.includes('must') || haystack.includes('only'));
};

function buildOpenAIError(info: OpenAIErrorInfo, usingOfficialOpenAI: boolean): Error {
    const { status, message, code, type, raw } = info;

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

async function requestOpenAI(config: AIProviderConfig, prompt: { system: string; user: string }, schema?: OpenAIResponseSchema, options?: AIRequestOptions) {
    const url = config.endpoint || OPENAI_BASE_URL;
    const usingOfficialOpenAI = url === OPENAI_BASE_URL;
    const apiKey = String(config.apiKey || '').trim();
    if (!apiKey && usingOfficialOpenAI) {
        throw new Error('OpenAI API key is required.');
    }
    const reasoningModel = isReasoningModel(config.model);
    const reasoningEffort = reasoningModel && config.reasoningEffort
        ? config.reasoningEffort
        : undefined;

    const extraBodyParams = config.extraBodyParams ?? {};


    const hasExplicitTemperature = Object.prototype.hasOwnProperty.call(extraBodyParams, 'temperature');


    const jsonSchemaResponseFormat = schema
        ? { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } }
        : undefined;
    const responseFormat = usingOfficialOpenAI && jsonSchemaResponseFormat
        ? jsonSchemaResponseFormat
        : { type: 'json_object' };

    const body = {
        ...extraBodyParams,
        model: config.model,
        messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
        ],


        ...(hasExplicitTemperature || reasoningModel ? {} : { temperature: 0.2 }),
        response_format: responseFormat,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    await rateLimit('openai', 250, options?.signal, 'OpenAI');


    const dispatch = async (requestBody: unknown): Promise<BufferedAIResponse> => {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
            throwIfAIRequestAborted(options?.signal, 'OpenAI');
            let response: BufferedAIResponse;
            try {
                response = await fetchTextWithTimeout(
                    url,
                    {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(requestBody),
                    },
                    resolveTimeoutMs(config.timeoutMs),
                    'OpenAI',
                    options?.signal,
                    config.fetcher
                );
            } catch (error) {
                if (isAIRequestStopError(error)) throw error;
                if (attempt < MAX_RETRIES) {
                    await waitForAIRequestRetry(400 * Math.pow(2, attempt), options?.signal, 'OpenAI');
                    continue;
                }
                throw error;
            }

            if (!response.ok && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
                await waitForAIRequestRetry(400 * Math.pow(2, attempt), options?.signal, 'OpenAI');
                continue;
            }
            return response;
        }
        throw new Error('OpenAI request failed to start.');
    };

    let response = await dispatch(body);


    if (!response.ok && jsonSchemaResponseFormat && response.status === 400) {
        const info = await readOpenAIErrorInfo(response);
        if (usingOfficialOpenAI && isUnsupportedResponseFormatError(info)) {
            response = await dispatch({ ...body, response_format: { type: 'json_object' } });
        } else if (!usingOfficialOpenAI && requiresJsonSchemaResponseFormat(info)) {
            response = await dispatch({ ...body, response_format: jsonSchemaResponseFormat });
        } else {
            throw buildOpenAIError(info, usingOfficialOpenAI);
        }
    }

    if (!response.ok) {
        throw buildOpenAIError(await readOpenAIErrorInfo(response), usingOfficialOpenAI);
    }

    const result = JSON.parse(response.bodyText) as {
        choices?: Array<{ message?: unknown }>;
    };

    const text = extractOpenAIMessageText(result.choices?.[0]?.message);
    if (!text) {
        throw new Error('OpenAI returned no content.');
    }
    return text;
}

export function createOpenAIProvider(config: AIProviderConfig): AIProvider {
    return withAIRequestStopNotifications(config, {
        clarifyTask: async (input: ClarifyInput, options?: AIRequestOptions): Promise<ClarifyResponse> => {
            const prompt = buildClarifyPrompt(input, config.language);
            const text = await requestOpenAI(config, prompt, CLARIFY_JSON_SCHEMA, options);
            try {
                return parseJson<ClarifyResponse>(text, isClarifyResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestOpenAI(config, retryPrompt, CLARIFY_JSON_SCHEMA, options);
                return parseJson<ClarifyResponse>(retryText, isClarifyResponse);
            }
        },
        breakDownTask: async (input: BreakdownInput, options?: AIRequestOptions): Promise<BreakdownResponse> => {
            const prompt = buildBreakdownPrompt(input, config.language);
            const text = await requestOpenAI(config, prompt, BREAKDOWN_JSON_SCHEMA, options);
            try {
                return parseJson<BreakdownResponse>(text, isBreakdownResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestOpenAI(config, retryPrompt, BREAKDOWN_JSON_SCHEMA, options);
                return parseJson<BreakdownResponse>(retryText, isBreakdownResponse);
            }
        },
        analyzeReview: async (input: ReviewAnalysisInput, options?: AIRequestOptions): Promise<ReviewAnalysisResponse> => {
            const prompt = buildReviewAnalysisPrompt(input.items, config.language);
            const text = await requestOpenAI(config, prompt, REVIEW_JSON_SCHEMA, options);
            try {
                return parseJson<ReviewAnalysisResponse>(text, isReviewAnalysisResponse);
            } catch {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestOpenAI(config, retryPrompt, REVIEW_JSON_SCHEMA, options);
                return parseJson<ReviewAnalysisResponse>(retryText, isReviewAnalysisResponse);
            }
        },
        predictMetadata: async (input: CopilotInput, options?: AIRequestOptions): Promise<CopilotResponse> => {
            const prompt = buildCopilotPrompt(input, config.language);
            const text = await requestOpenAI(config, prompt, COPILOT_JSON_SCHEMA, options);
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
                const retryText = await requestOpenAI(config, retryPrompt, COPILOT_JSON_SCHEMA, options);
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
    });
}
