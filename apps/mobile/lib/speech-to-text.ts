import { File } from 'expo-file-system';
import Constants from 'expo-constants';
import type { AudioCaptureMode, AudioFieldStrategy } from '@mindwtr/core';

type SpeechProvider = 'openai' | 'gemini' | 'whisper';

export type SpeechToTextResult = {
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

export type SpeechToTextConfig = {
  provider: SpeechProvider;
  apiKey?: string;
  model: string;
  language?: string;
  mode?: AudioCaptureMode;
  fieldStrategy?: AudioFieldStrategy;
  parseModel?: string;
  modelPath?: string;
  now?: Date;
  timeZone?: string;
};

type FetchOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const IS_EXPO_GO = Constants.appOwnership === 'expo';

let whisperContextCache: { modelPath: string; context: { transcribe: (uri: string, options?: Record<string, unknown>) => { promise: Promise<unknown> } } } | null = null;

const bytesToBase64 = (bytes: Uint8Array) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    const hasB1 = typeof b1 === 'number';
    const hasB2 = typeof b2 === 'number';

    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);

    out += alphabet[(triplet >> 18) & 0x3f];
    out += alphabet[(triplet >> 12) & 0x3f];
    out += hasB1 ? alphabet[(triplet >> 6) & 0x3f] : '=';
    out += hasB2 ? alphabet[triplet & 0x3f] : '=';
  }
  return out;
};

const parseJsonResponse = (text: string): SpeechToTextResult => {
  const cleaned = text.replace(/```json|```/gi, '').trim();
  return JSON.parse(cleaned) as SpeechToTextResult;
};

const getExtension = (uri: string) => {
  const match = uri.match(/\.[a-z0-9]+$/i);
  return match ? match[0] : '.m4a';
};

const getMimeType = (uri: string) => {
  const extension = getExtension(uri);
  switch (extension.toLowerCase()) {
    case '.aac':
      return 'audio/aac';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.caf':
      return 'audio/x-caf';
    case '.3gp':
    case '.3gpp':
      return 'audio/3gpp';
    case '.webm':
      return 'audio/webm';
    case '.m4a':
    default:
      return 'audio/mp4';
  }
};

const resolveLanguage = (value?: string) => {
  if (!value) return 'auto';
  const trimmed = value.trim();
  return trimmed.length ? trimmed : 'auto';
};

const buildSmartPrompt = ({
  fieldStrategy,
  language,
  now,
  timeZone,
}: {
  fieldStrategy: AudioFieldStrategy;
  language: string;
  now: Date;
  timeZone?: string;
}) => {
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
};

const buildTranscriptionPrompt = (language: string) => {
  return `
Transcribe the audio into plain text.
Audio language: ${language === 'auto' ? 'Detect automatically' : language}

Return ONLY valid JSON with these keys:
{
  "transcript": "string",
  "language": "detected language name or code"
}
  `.trim();
};

const fetchJson = async (url: string, init: RequestInit, options?: FetchOptions) => {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (options?.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Request failed (${response.status})`);
    }
    const data = await response.json();
    return data as Promise<unknown>;
  } finally {
    clearTimeout(handle);
  }
};

const transcribeOpenAI = async (audioUri: string, config: SpeechToTextConfig) => {
  if (!config.apiKey) {
    throw new Error('OpenAI API key missing');
  }
  const file = new File(audioUri);
  const form = new FormData();
  form.append('file', {
    uri: audioUri,
    name: file.name || `audio${getExtension(audioUri)}`,
    type: getMimeType(audioUri),
  } as any);
  form.append('model', config.model);
  const language = resolveLanguage(config.language);
  if (language !== 'auto') {
    form.append('language', language);
  }
  form.append('response_format', 'json');

  const result = await fetchJson(
    OPENAI_TRANSCRIBE_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: form,
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const text = typeof (result as { text?: unknown }).text === 'string'
    ? (result as { text: string }).text
    : '';
  return text.trim();
};

const resolveOpenAIParseModel = (value?: string) => {
  if (!value) return 'gpt-4o-mini';
  const lower = value.toLowerCase();
  if (lower.startsWith('gpt-5')) return 'gpt-4o-mini';
  return value;
};

const extractResponsesText = (result: unknown) => {
  const direct = typeof (result as { output_text?: string }).output_text === 'string'
    ? (result as { output_text: string }).output_text
    : undefined;
  if (direct && direct.trim()) return direct;
  const output = (result as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }).output;
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (!item || item.type !== 'message') continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    const textPart = content.find((part) => part?.type === 'output_text' || part?.type === 'text');
    if (textPart?.text && textPart.text.trim()) return textPart.text;
  }
  return undefined;
};

const parseWithOpenAIResponses = async (transcript: string, config: SpeechToTextConfig, overrideModel?: string) => {
  if (!config.apiKey) {
    throw new Error('OpenAI API key missing');
  }
  const now = config.now ?? new Date();
  const prompt = buildSmartPrompt({
    fieldStrategy: config.fieldStrategy ?? 'smart',
    language: resolveLanguage(config.language),
    now,
    timeZone: config.timeZone,
  });
  const parserModel = resolveOpenAIParseModel(overrideModel ?? config.parseModel);
  const result = await fetchJson(
    OPENAI_RESPONSES_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: parserModel,
        temperature: 0.2,
        input: [
          { role: 'system', content: prompt },
          { role: 'user', content: transcript },
        ],
        text: { format: { type: 'json_object' } },
      }),
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const content = extractResponsesText(result);
  if (!content) {
    throw new Error('OpenAI returned no content.');
  }
  return parseJsonResponse(content);
};

const parseWithOpenAIChat = async (transcript: string, config: SpeechToTextConfig, overrideModel?: string) => {
  if (!config.apiKey) {
    throw new Error('OpenAI API key missing');
  }
  const now = config.now ?? new Date();
  const prompt = buildSmartPrompt({
    fieldStrategy: config.fieldStrategy ?? 'smart',
    language: resolveLanguage(config.language),
    now,
    timeZone: config.timeZone,
  });
  const parserModel = resolveOpenAIParseModel(overrideModel ?? config.parseModel);
  const result = await fetchJson(
    OPENAI_CHAT_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: parserModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: transcript },
        ],
      }),
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const content = (result as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI returned no content.');
  }
  return parseJsonResponse(content);
};

const parseWithOpenAI = async (transcript: string, config: SpeechToTextConfig, overrideModel?: string) => {
  try {
    return await parseWithOpenAIResponses(transcript, config, overrideModel);
  } catch (error) {
    console.warn('OpenAI responses parse failed, retrying with chat completions', error);
    return parseWithOpenAIChat(transcript, config, overrideModel);
  }
};

const requestGemini = async (audioUri: string, config: SpeechToTextConfig, promptOverride?: string) => {
  if (!config.apiKey) {
    throw new Error('Gemini API key missing');
  }
  const now = config.now ?? new Date();
  const prompt = promptOverride ?? buildSmartPrompt({
    fieldStrategy: config.fieldStrategy ?? 'smart',
    language: resolveLanguage(config.language),
    now,
    timeZone: config.timeZone,
  });
  const file = new File(audioUri);
  const bytes = await file.bytes();
  const base64Audio = bytesToBase64(bytes);
  const mimeType = getMimeType(audioUri);
  const url = `${GEMINI_BASE_URL}/${config.model}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Audio,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
      candidateCount: 1,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  };
  const result = await fetchJson(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const text = (result as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    .candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned no content.');
  }
  return parseJsonResponse(text);
};

const getWhisperContext = async (modelPath: string) => {
  if (whisperContextCache?.modelPath === modelPath) {
    return whisperContextCache.context;
  }
  const { initWhisper } = await import('whisper.rn');
  const context = await initWhisper({ filePath: modelPath });
  whisperContextCache = { modelPath, context };
  return context;
};

const transcribeWhisper = async (audioUri: string, config: SpeechToTextConfig) => {
  if (IS_EXPO_GO) {
    throw new Error('On-device Whisper requires a dev build or production build (not Expo Go).');
  }
  if (!config.modelPath) {
    throw new Error('Offline model path missing');
  }
  const context = await getWhisperContext(config.modelPath);
  const language = resolveLanguage(config.language);
  const options: Record<string, unknown> = {};
  if (language !== 'auto') {
    options.language = language;
  }
  const { promise } = context.transcribe(audioUri, options);
  const result = await promise;
  const text = typeof (result as { result?: unknown }).result === 'string'
    ? (result as { result: string }).result
    : typeof (result as { text?: unknown }).text === 'string'
      ? (result as { text: string }).text
      : '';
  return text.trim();
};

export async function processAudioCapture(
  audioUri: string,
  config: SpeechToTextConfig
): Promise<SpeechToTextResult> {
  const mode = config.mode ?? 'smart_parse';
  if (config.provider === 'whisper') {
    const transcript = await transcribeWhisper(audioUri, config);
    return { transcript };
  }
  if (config.provider === 'gemini') {
    if (mode === 'transcribe_only') {
      const prompt = buildTranscriptionPrompt(resolveLanguage(config.language));
      return requestGemini(audioUri, config, prompt);
    }
    return requestGemini(audioUri, config);
  }

  const transcript = await transcribeOpenAI(audioUri, config);
  if (mode === 'transcribe_only') {
    return { transcript };
  }
  try {
    const parsed = await parseWithOpenAI(transcript, config);
    return {
      ...parsed,
      transcript: parsed.transcript || transcript,
    };
  } catch (error) {
    try {
      const parsed = await parseWithOpenAI(transcript, config, 'gpt-4o-mini');
      return {
        ...parsed,
        transcript: parsed.transcript || transcript,
      };
    } catch (retryError) {
      console.warn('OpenAI smart parse failed, falling back to transcript', retryError);
      return { transcript };
    }
  }
}
