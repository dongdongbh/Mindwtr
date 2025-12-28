import type { AIProvider, AIProviderConfig, BreakdownInput, BreakdownResponse, ClarifyInput, ClarifyResponse, CopilotInput, CopilotResponse, ReviewAnalysisInput, ReviewAnalysisResponse } from '../types';
import { buildBreakdownPrompt, buildClarifyPrompt, buildCopilotPrompt, buildReviewAnalysisPrompt } from '../prompts';
import { normalizeTags, normalizeTimeEstimate, parseJson } from '../utils';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

type GeminiSchema = {
    type: 'object' | 'array';
    properties?: Record<string, unknown>;
    required?: string[];
    items?: Record<string, unknown>;
};

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

async function requestGemini(config: AIProviderConfig, prompt: { system: string; user: string }, schema?: GeminiSchema) {
    const endpoint = config.endpoint || GEMINI_BASE_URL;
    const url = `${endpoint}/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    const thinkingBudget = typeof config.thinkingBudget === 'number' && config.thinkingBudget > 0
        ? Math.floor(config.thinkingBudget)
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
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
            ...(schema ? { responseSchema: schema } : {}),
            ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
        },
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini error: ${response.status} ${text}`);
    }

    const result = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }, finishReason?: string }>;
    };

    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error('Gemini returned no content.');
    }
    return text;
}

export function createGeminiProvider(config: AIProviderConfig): AIProvider {
    return {
        clarifyTask: async (input: ClarifyInput): Promise<ClarifyResponse> => {
            const prompt = buildClarifyPrompt(input);
            const text = await requestGemini(config, prompt, CLARIFY_SCHEMA);
            try {
                return parseJson<ClarifyResponse>(text);
            } catch (error) {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestGemini(config, retryPrompt, CLARIFY_SCHEMA);
                return parseJson<ClarifyResponse>(retryText);
            }
        },
        breakDownTask: async (input: BreakdownInput): Promise<BreakdownResponse> => {
            const prompt = buildBreakdownPrompt(input);
            const text = await requestGemini(config, prompt, BREAKDOWN_SCHEMA);
            try {
                return parseJson<BreakdownResponse>(text);
            } catch (error) {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestGemini(config, retryPrompt, BREAKDOWN_SCHEMA);
                return parseJson<BreakdownResponse>(retryText);
            }
        },
        analyzeReview: async (input: ReviewAnalysisInput): Promise<ReviewAnalysisResponse> => {
            const prompt = buildReviewAnalysisPrompt(input.items);
            const text = await requestGemini(config, prompt, REVIEW_SCHEMA);
            try {
                return parseJson<ReviewAnalysisResponse>(text);
            } catch (error) {
                const retryPrompt = {
                    system: prompt.system,
                    user: `${prompt.user}\n\nReturn ONLY valid JSON. Do not include any extra text.`,
                };
                const retryText = await requestGemini(config, retryPrompt, REVIEW_SCHEMA);
                return parseJson<ReviewAnalysisResponse>(retryText);
            }
        },
        predictMetadata: async (input: CopilotInput): Promise<CopilotResponse> => {
            const prompt = buildCopilotPrompt(input);
            const text = await requestGemini(config, prompt, COPILOT_SCHEMA);
            try {
                const parsed = parseJson<CopilotResponse>(text);
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
                const retryText = await requestGemini(config, retryPrompt, COPILOT_SCHEMA);
                const parsed = parseJson<CopilotResponse>(retryText);
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
