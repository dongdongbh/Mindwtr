import type { AudioCaptureMode, AudioFieldStrategy } from './ai/types';
import { strToU8 } from 'fflate';
import { OPENAI_DEFAULT_MODEL, resolveGeminiModel } from './ai/catalog';
import { fetchTextWithTimeout } from './ai/utils';
import {
    openAITranscribeLanguageFieldName,
    resolveOpenAITranscribeEndpoint,
} from './ai-config';

const SPEECH_REQUEST_TIMEOUT_MS = 30_000;
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const GEMINI_SPEECH_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export type SpeechToTaskProvider = 'openai' | 'gemini' | 'whisper' | 'parakeet';

export type SpeechToTaskResult = {
    transcript: string;
    title?: string | null;
    description?: string | null;
    dueDate?: string | null;
    startTime?: string | null;
    projectTitle?: string | null;
    tags?: string[] | null;
    contexts?: string[] | null;
    language?: string | null;
};

export type SpeechToTaskCaptureConfig = {
    provider: SpeechToTaskProvider;
    mode?: AudioCaptureMode;
    fieldStrategy?: AudioFieldStrategy;
    language?: string;
    now?: Date;
    timeZone?: string;
    retryModel?: string;
};

export type SpeechToTaskCapturePorts = {
    transcribe: () => Promise<string>;
    direct?: (prompt: string) => Promise<SpeechToTaskResult>;
    parse?: (transcript: string, overrideModel?: string) => Promise<SpeechToTaskResult>;
    onParseFallback?: (error: Error) => void;
};

export type RemoteSpeechToTaskCaptureConfig = SpeechToTaskCaptureConfig & {
    provider: 'openai' | 'gemini';
    apiKey?: string;
    model: string;
    parseModel?: string;
    baseUrl?: string;
};

export type OpenAISpeechUpload = {
    part: Blob;
    fileName?: string;
};

export type RemoteSpeechAudioPorts = {
    readBytes?: () => Promise<{ bytes: Uint8Array; mimeType: string }>;
    withOpenAIUpload?: <T>(
        send: (upload: OpenAISpeechUpload) => Promise<T>,
    ) => Promise<T>;
};

export type RemoteSpeechToTaskOptions = {
    fetcher?: typeof fetch;
    onWarn?: (message: string, error: Error) => void;
};

export type OpenAISpeechTranscriptionRequestConfig = Pick<RemoteSpeechToTaskCaptureConfig, 'model' | 'language' | 'baseUrl'>;
export type OpenAISpeechTranscriptionRequest = { url: string; method: 'POST'; fields: [string, string][]; timeoutMs: number };
export type OpenAISpeechParseRequestConfig = Pick<RemoteSpeechToTaskCaptureConfig, 'fieldStrategy' | 'language' | 'now' | 'timeZone'>;
export type OpenAISpeechParseAPI = 'responses' | 'chat';
export type OpenAISpeechParseRequest = { url: string; method: 'POST'; headers: [string, string][]; body: string; timeoutMs: number };

export function resolveOpenAIParseModel(value?: string): string {
    if (!value || value.toLowerCase().startsWith('gpt-4o')) return OPENAI_DEFAULT_MODEL;
    return value;
}

export function buildRemoteOpenAISpeechTranscriptionRequest(config: OpenAISpeechTranscriptionRequestConfig): OpenAISpeechTranscriptionRequest {
    const language = normalizeSpeechLanguage(config.language);
    const fields: [string, string][] = [['model', config.model]];
    if (language !== 'auto') fields.push([openAITranscribeLanguageFieldName(config.model), language]);
    fields.push(['response_format', 'json']);
    return { url: resolveOpenAITranscribeEndpoint(config.baseUrl), method: 'POST', timeoutMs: SPEECH_REQUEST_TIMEOUT_MS,
        fields };
}

const speechObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function decodeRemoteOpenAISpeechTranscriptionResponse(json: unknown): string {
    return speechObject(json) && typeof json.text === 'string' ? json.text.trim() : '';
}

async function fetchSpeechJson(
    url: string,
    init: RequestInit,
    fetcher: typeof fetch,
): Promise<unknown> {
    const response = await fetchTextWithTimeout(
        url,
        init,
        SPEECH_REQUEST_TIMEOUT_MS,
        'Speech',
        undefined,
        fetcher,
    );
    if (!response.ok) {
        throw new Error(response.bodyText || `Request failed (${response.status})`);
    }
    return JSON.parse(response.bodyText) as unknown;
}

async function transcribeRemoteOpenAI(
    config: RemoteSpeechToTaskCaptureConfig,
    audio: RemoteSpeechAudioPorts,
    fetcher: typeof fetch,
): Promise<string> {
    if (!config.apiKey && !config.baseUrl?.trim()) {
        throw new Error('OpenAI API key missing');
    }
    if (!audio.withOpenAIUpload) {
        throw new Error('OpenAI audio upload adapter missing');
    }
    const request = buildRemoteOpenAISpeechTranscriptionRequest(config);
    return audio.withOpenAIUpload(async ({ part, fileName }) => {
        const form = new FormData();
        if (fileName) {
            form.append('file', part as Blob, fileName);
        } else {
            form.append('file', part as Blob);
        }
        for (const [name, value] of request.fields) form.append(name, value);

        const result = await fetchSpeechJson(
            request.url,
            {
                method: request.method,
                headers: {
                    ...(config.apiKey
                        ? { Authorization: `Bearer ${config.apiKey}` }
                        : {}),
                },
                body: form,
            },
            fetcher,
        );
        return decodeRemoteOpenAISpeechTranscriptionResponse(result);
    });
}

function speechBytesToBase64(bytes: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index] ?? 0;
        const second = bytes[index + 1];
        const third = bytes[index + 2];
        const triplet = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

        output += alphabet[(triplet >> 18) & 0x3f];
        output += alphabet[(triplet >> 12) & 0x3f];
        output += typeof second === 'number'
            ? alphabet[(triplet >> 6) & 0x3f]
            : '=';
        output += typeof third === 'number' ? alphabet[triplet & 0x3f] : '=';
    }
    return output;
}

async function requestRemoteGemini(
    config: RemoteSpeechToTaskCaptureConfig,
    audio: RemoteSpeechAudioPorts,
    prompt: string,
    fetcher: typeof fetch,
): Promise<SpeechToTaskResult> {
    if (!config.apiKey) {
        throw new Error('Gemini API key missing');
    }
    if (!audio.readBytes) {
        throw new Error('Gemini audio bytes adapter missing');
    }
    const { bytes, mimeType } = await audio.readBytes();
    const request = geminiSpeechUpload(config.model, speechBytesToBase64(bytes), mimeType, prompt);
    const result = await fetchSpeechJson(request.url, {
        method: request.method,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: request.body,
    }, fetcher);
    return decodeRemoteGeminiSpeechResponse(result);
}

export const NATIVE_VOICE_MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const NATIVE_VOICE_MAX_HTTP_BYTES = 8 * 1024 * 1024;
export type GeminiSpeechRequestConfig = Pick<RemoteSpeechToTaskCaptureConfig, 'model' | 'mode' | 'fieldStrategy' | 'language' | 'now' | 'timeZone'>;
export type GeminiSpeechRequest = { url: string; method: 'POST'; headers: [string, string][]; body: string; timeoutMs: number };

const geminiSpeechUpload = (modelId: string, audioBase64: string, mimeType: string, prompt: string): GeminiSpeechRequest => ({
    url: `${GEMINI_SPEECH_BASE_URL}/${resolveGeminiModel(modelId)}:generateContent`, method: 'POST',
    headers: [['Content-Type', 'application/json']], timeoutMs: SPEECH_REQUEST_TIMEOUT_MS,
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt },
        { inline_data: { mime_type: mimeType, data: audioBase64 } }] }],
        generationConfig: { temperature: 0.2, topP: 0.8, topK: 20, candidateCount: 1,
            maxOutputTokens: 1024, responseMimeType: 'application/json' } }),
});

export function buildRemoteGeminiSpeechRequest(config: GeminiSpeechRequestConfig, audioBase64: string, mimeType: string): GeminiSpeechRequest {
    if (!config || typeof config.model !== 'string' || !config.model.trim() || config.model.length > 2000
        || config.mode !== undefined && !['smart_parse', 'transcribe_only'].includes(config.mode)
        || config.fieldStrategy !== undefined && !['smart', 'title_only', 'description_only'].includes(config.fieldStrategy)
        || config.language !== undefined && (typeof config.language !== 'string' || config.language.length > 200)
        || config.timeZone !== undefined && (typeof config.timeZone !== 'string' || config.timeZone.length > 200)
        || config.now !== undefined && (!(config.now instanceof Date) || !Number.isFinite(config.now.getTime()))
        || typeof mimeType !== 'string' || !/^audio\/[a-z0-9.+-]{1,50}$/.test(mimeType)
        || typeof audioBase64 !== 'string' || !audioBase64.length
        || audioBase64.length > Math.ceil(NATIVE_VOICE_MAX_AUDIO_BYTES / 3) * 4
        || audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) throw new Error('Voice audio request is invalid');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const padding = audioBase64.endsWith('==') ? 2 : audioBase64.endsWith('=') ? 1 : 0;
    const bytes = audioBase64.length / 4 * 3 - padding;
    if (bytes > NATIVE_VOICE_MAX_AUDIO_BYTES || padding === 2 && alphabet.indexOf(audioBase64.charAt(audioBase64.length - 3)) % 16 !== 0
        || padding === 1 && alphabet.indexOf(audioBase64.charAt(audioBase64.length - 2)) % 4 !== 0) throw new Error('Voice audio request is invalid');
    const language = normalizeSpeechLanguage(config.language);
    const prompt = config.mode === 'transcribe_only' ? buildSpeechTranscriptionPrompt(language)
        : buildSpeechToTaskPrompt({ fieldStrategy: config.fieldStrategy, language, now: config.now, timeZone: config.timeZone });
    const request = geminiSpeechUpload(config.model, audioBase64, mimeType, prompt);
    if (strToU8(request.body).length > NATIVE_VOICE_MAX_HTTP_BYTES) throw new Error('Voice audio request is too large');
    return request;
}

export function decodeRemoteGeminiSpeechResponse(json: unknown): SpeechToTaskResult {
    const text = (json as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }).candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error('Gemini returned no content.');
    }
    return parseSpeechToTaskResult(text);
}

function extractOpenAIResponsesText(result: unknown): string | undefined {
    if (!speechObject(result)) return undefined;
    const direct = typeof result.output_text === 'string' ? result.output_text : undefined;
    if (direct?.trim()) return direct;

    const output = result.output;
    if (!Array.isArray(output)) return undefined;
    for (const item of output) {
        if (!speechObject(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
        const textPart = item.content.find(
            (part: unknown) => speechObject(part) && (part.type === 'output_text' || part.type === 'text'),
        );
        if (speechObject(textPart) && typeof textPart.text === 'string' && textPart.text.trim()) return textPart.text;
    }
    return undefined;
}

function buildOpenAIParsePrompt(config: OpenAISpeechParseRequestConfig): string {
    return buildSpeechToTaskPrompt({
        fieldStrategy: config.fieldStrategy ?? 'smart',
        language: normalizeSpeechLanguage(config.language),
        now: config.now ?? new Date(),
        timeZone: config.timeZone,
    });
}

export function buildRemoteOpenAISpeechParseRequest(config: OpenAISpeechParseRequestConfig, transcript: string,
    model: string, api: OpenAISpeechParseAPI): OpenAISpeechParseRequest {
    if (api !== 'responses' && api !== 'chat') throw new Error('OpenAI speech parse API is invalid');
    const messages = [{ role: 'system', content: buildOpenAIParsePrompt(config) }, { role: 'user', content: transcript }];
    return { url: api === 'responses' ? OPENAI_RESPONSES_URL : OPENAI_CHAT_COMPLETIONS_URL, method: 'POST',
        headers: [['Content-Type', 'application/json']], timeoutMs: SPEECH_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(api === 'responses' ? { model, temperature: 0.2, input: messages, text: { format: { type: 'json_object' } } }
            : { model, temperature: 0.2, response_format: { type: 'json_object' }, messages }) };
}

export function decodeRemoteOpenAISpeechParseResponse(json: unknown, api: OpenAISpeechParseAPI): SpeechToTaskResult {
    if (api !== 'responses' && api !== 'chat') throw new Error('OpenAI speech parse API is invalid');
    let content: unknown;
    if (api === 'responses') content = extractOpenAIResponsesText(json);
    else if (speechObject(json) && Array.isArray(json.choices) && speechObject(json.choices[0]) && speechObject(json.choices[0].message))
        content = json.choices[0].message.content;
    if (typeof content !== 'string' || !content) throw new Error('OpenAI returned no content.');
    return parseSpeechToTaskResult(content);
}

async function parseRemoteOpenAIResponses(
    transcript: string,
    model: string,
    config: RemoteSpeechToTaskCaptureConfig,
    fetcher: typeof fetch,
): Promise<SpeechToTaskResult> {
    if (!config.apiKey) {
        throw new Error('OpenAI API key missing');
    }
    const request = buildRemoteOpenAISpeechParseRequest(config, transcript, model, 'responses');
    const result = await fetchSpeechJson(
        request.url,
        {
            method: request.method,
            headers: {
                ...Object.fromEntries(request.headers),
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: request.body,
        },
        fetcher,
    );
    return decodeRemoteOpenAISpeechParseResponse(result, 'responses');
}

async function parseRemoteOpenAIChat(
    transcript: string,
    model: string,
    config: RemoteSpeechToTaskCaptureConfig,
    fetcher: typeof fetch,
): Promise<SpeechToTaskResult> {
    if (!config.apiKey) {
        throw new Error('OpenAI API key missing');
    }
    const request = buildRemoteOpenAISpeechParseRequest(config, transcript, model, 'chat');
    const result = await fetchSpeechJson(
        request.url,
        {
            method: request.method,
            headers: {
                ...Object.fromEntries(request.headers),
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: request.body,
        },
        fetcher,
    );
    return decodeRemoteOpenAISpeechParseResponse(result, 'chat');
}

async function parseRemoteOpenAI(
    transcript: string,
    overrideModel: string | undefined,
    config: RemoteSpeechToTaskCaptureConfig,
    fetcher: typeof fetch,
    onWarn?: RemoteSpeechToTaskOptions['onWarn'],
): Promise<SpeechToTaskResult> {
    const model = overrideModel ?? config.parseModel ?? 'gpt-4o-mini';
    try {
        return await parseRemoteOpenAIResponses(transcript, model, config, fetcher);
    } catch (error) {
        const normalizedError = error instanceof Error
            ? error
            : new Error(String(error));
        onWarn?.(
            'OpenAI responses parse failed, retrying with chat completions',
            normalizedError,
        );
        return parseRemoteOpenAIChat(transcript, model, config, fetcher);
    }
}

export async function runRemoteSpeechToTaskCapture(
    config: RemoteSpeechToTaskCaptureConfig,
    audio: RemoteSpeechAudioPorts,
    options: RemoteSpeechToTaskOptions = {},
): Promise<SpeechToTaskResult> {
    const fetcher = options.fetcher ?? globalThis.fetch;
    if (config.provider === 'gemini') {
        return runSpeechToTaskCapture(config, {
            transcribe: async () => {
                throw new Error('Gemini uses direct audio processing');
            },
            direct: (prompt) => requestRemoteGemini(config, audio, prompt, fetcher),
        });
    }
    return runSpeechToTaskCapture(config, {
        transcribe: () => transcribeRemoteOpenAI(config, audio, fetcher),
        parse: (transcript, overrideModel) => parseRemoteOpenAI(
            transcript,
            overrideModel,
            config,
            fetcher,
            options.onWarn,
        ),
        onParseFallback: (error) => options.onWarn?.(
            'OpenAI smart parse failed, falling back to transcript',
            error,
        ),
    });
}

export function normalizeSpeechLanguage(value?: string): string {
    if (!value) return 'auto';
    const trimmed = value.trim();
    if (!trimmed) return 'auto';
    const normalized = trimmed.toLowerCase();
    if (normalized === 'auto') return 'auto';
    const base = normalized.split(/[-_]/)[0];
    const aliases: Record<string, string> = {
        english: 'en',
        en: 'en',
        spanish: 'es',
        espanol: 'es',
        es: 'es',
    };
    return aliases[base] ?? base;
}

export function parseSpeechToTaskResult(text: unknown): SpeechToTaskResult {
    if (typeof text !== 'string') {
        throw new Error('Speech parser returned non-text response.');
    }
    const cleaned = text.replace(/```json|```/gi, '').trim();
    if (!cleaned) {
        throw new Error('Speech parser returned empty response.');
    }
    return JSON.parse(cleaned) as SpeechToTaskResult;
}

export function buildSpeechToTaskPrompt({
    fieldStrategy = 'smart',
    language = 'auto',
    now = new Date(),
    timeZone,
}: {
    fieldStrategy?: AudioFieldStrategy;
    language?: string;
    now?: Date;
    timeZone?: string;
}): string {
    return `
You are a personal assistant converting a voice note into a GTD task.

Audio language: ${language === 'auto' ? 'Detect automatically' : language}
Current date/time: ${now.toISOString()}
Time zone: ${timeZone || 'local'}

Return ONLY valid JSON with these keys:
{
  "transcript": "string",
  "title": "string or null",
  "description": "string or null",
  "dueDate": "ISO 8601 string or null",
  "startTime": "ISO 8601 string or null",
  "projectTitle": "string or null",
  "tags": ["#tag"] or [],
  "contexts": ["@context"] or [],
  "language": "detected language name or code"
}

Field strategy: ${fieldStrategy}
- smart: If transcript is short (<= 15 words), use it verbatim as title and leave description empty. If longer, create a concise 3-7 word title and put the full transcript in description.
- title_only: Put the full transcript in title and leave description empty.
- description_only: Keep title empty and put the full transcript in description.

Extract any dates/times and convert to ISO 8601 using the current date/time for relative phrases (e.g., "tomorrow 5pm").
If a field is unknown, return null or an empty array.
  `.trim();
}

export function buildSpeechTranscriptionPrompt(language = 'auto'): string {
    return `
Transcribe the audio into plain text.
Audio language: ${language === 'auto' ? 'Detect automatically' : language}

Return ONLY valid JSON with these keys:
{
  "transcript": "string",
  "language": "detected language name or code"
}
  `.trim();
}

export async function runSpeechToTaskCapture(
    config: SpeechToTaskCaptureConfig,
    ports: SpeechToTaskCapturePorts,
): Promise<SpeechToTaskResult> {
    const mode = config.mode ?? 'smart_parse';
    const language = normalizeSpeechLanguage(config.language);

    if (config.provider === 'whisper' || config.provider === 'parakeet') {
        return { transcript: await ports.transcribe() };
    }

    if (config.provider === 'gemini') {
        if (!ports.direct) {
            throw new Error('Direct speech adapter missing');
        }
        const prompt = mode === 'transcribe_only'
            ? buildSpeechTranscriptionPrompt(language)
            : buildSpeechToTaskPrompt({
                fieldStrategy: config.fieldStrategy,
                language,
                now: config.now,
                timeZone: config.timeZone,
            });
        return ports.direct(prompt);
    }

    const transcript = await ports.transcribe();
    if (mode === 'transcribe_only') {
        return { transcript };
    }
    if (!ports.parse) {
        throw new Error('Speech parser adapter missing');
    }

    try {
        const parsed = await ports.parse(transcript, undefined);
        return { ...parsed, transcript: parsed.transcript || transcript };
    } catch {
        try {
            const parsed = await ports.parse(
                transcript,
                config.retryModel ?? 'gpt-4o-mini',
            );
            return { ...parsed, transcript: parsed.transcript || transcript };
        } catch (error) {
            ports.onParseFallback?.(
                error instanceof Error ? error : new Error(String(error)),
            );
            return { transcript };
        }
    }
}
