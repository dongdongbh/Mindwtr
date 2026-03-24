import { Directory, File, Paths } from 'expo-file-system';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { AudioPcmStreamAdapter } from 'whisper.rn/realtime-transcription/adapters/AudioPcmStreamAdapter.js';
import { RealtimeTranscriber, type RealtimeTranscriberEvent } from 'whisper.rn/realtime-transcription/index.js';
import type { AudioCaptureMode, AudioFieldStrategy } from '@mindwtr/core';
import { logInfo, logWarn } from './app-log';
import { buildMultipartAudioPart } from './speech-to-text.helpers';

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

export type WhisperRealtimeHandle = {
  stop: () => Promise<void>;
  result: Promise<SpeechToTextResult>;
  hasRealtimeTranscript: boolean;
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
const WHISPER_ANDROID_MAX_THREADS = 1;
const WHISPER_ANDROID_N_PROCESSORS = 1;

type WhisperContextLike = {
  transcribe: (uri: string, options?: Record<string, unknown>) => { promise: Promise<unknown> };
  transcribeData?: (
    data: ArrayBuffer,
    options?: Record<string, unknown>
  ) => { stop: () => Promise<void>; promise: Promise<unknown> };
};

let whisperContextCache: { modelPath: string; context: WhisperContextLike } | null = null;
let whisperNativeLogEnabled = false;
type WhisperModule = typeof import('whisper.rn');
let whisperModuleCache: WhisperModule | null = null;

type RNFSModule = typeof import('react-native-fs');
let rnfsModuleCache: RNFSModule | null | undefined;

const getRNFSModule = (): RNFSModule | null => {
  if (rnfsModuleCache !== undefined) return rnfsModuleCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-fs') as RNFSModule;
    const hasCoreFs = !!mod
      && typeof (mod as unknown as { writeFile?: unknown }).writeFile === 'function'
      && typeof (mod as unknown as { appendFile?: unknown }).appendFile === 'function'
      && typeof (mod as unknown as { readFile?: unknown }).readFile === 'function'
      && typeof (mod as unknown as { exists?: unknown }).exists === 'function'
      && typeof (mod as unknown as { unlink?: unknown }).unlink === 'function';
    if (!hasCoreFs) {
      rnfsModuleCache = null;
      return null;
    }
    rnfsModuleCache = mod;
    return mod;
  } catch (error) {
    rnfsModuleCache = null;
    return null;
  }
};

const getWhisperModule = () => {
  if (whisperModuleCache) return whisperModuleCache;
  try {
    // Use static fallback paths so Metro can bundle this file.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('whisper.rn/src/index') as WhisperModule;
      whisperModuleCache = mod;
      return mod;
    } catch (sourceError) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('whisper.rn') as WhisperModule;
        whisperModuleCache = mod;
        return mod;
      } catch (rootError) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mod = require('whisper.rn/index') as WhisperModule;
          whisperModuleCache = mod;
          return mod;
        } catch (finalError) {
          const errors = [sourceError, rootError, finalError]
            .map((value) => (value instanceof Error ? value.message : String(value)))
            .join(' | ');
          throw new Error(`Whisper module unavailable: ${errors}`);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Whisper module unavailable: ${message}`);
  }
};

const buildWhisperTranscribeOptions = (language: string): Record<string, unknown> => {
  const options: Record<string, unknown> = {};
  if (language !== 'auto') {
    options.language = language;
  }
  if (Platform.OS === 'android') {
    options.maxThreads = WHISPER_ANDROID_MAX_THREADS;
    options.nProcessors = WHISPER_ANDROID_N_PROCESSORS;
  }
  return options;
};

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

const parseJsonResponse = (text: unknown): SpeechToTextResult => {
  if (typeof text !== 'string') {
    throw new Error('Speech parser returned non-text response.');
  }
  const cleaned = text.replace(/```json|```/gi, '').trim();
  if (!cleaned) {
    throw new Error('Speech parser returned empty response.');
  }
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
  if (!trimmed) return 'auto';
  const normalized = trimmed.toLowerCase();
  if (normalized === 'auto') return 'auto';
  const base = normalized.split(/[-_]/)[0];
  const map: Record<string, string> = {
    english: 'en',
    en: 'en',
    spanish: 'es',
    espanol: 'es',
    es: 'es',
  };
  return map[base] ?? base;
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

type OpenAIUploadStrategy = 'blob' | 'uri';

const buildOpenAIMultipartPayload = async (
  audioUri: string,
  strategy: OpenAIUploadStrategy
): Promise<{
  part: Blob | { uri: string; name: string; type: string };
  fileName?: string;
  meta: Record<string, string>;
}> => {
  const file = new File(audioUri);
  const name = file.name || `audio${getExtension(audioUri)}`;
  const type = file.type || getMimeType(audioUri);
  const uriScheme = audioUri.split(':')[0] || 'unknown';
  const baseMeta = {
    strategy,
    uriScheme,
    fileName: name,
    mimeType: type,
    fileExists: String(Boolean(file.exists)),
    fileSize: String(typeof file.size === 'number' ? file.size : 0),
    expoGo: String(IS_EXPO_GO),
  };

  if (strategy === 'blob') {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await file.bytes();
    } catch (error) {
      throw new Error(
        `Failed to read audio bytes for Blob upload: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const { part, fileName } = buildMultipartAudioPart({
      uri: audioUri,
      name,
      type,
      bytes,
    });
    if (fileName && part instanceof Blob) {
      return {
        part,
        fileName,
        meta: {
          ...baseMeta,
          byteLength: String(bytes.byteLength),
        },
      };
    }
    throw new Error('Blob upload requested but Blob multipart part could not be created.');
  }

  return {
    part: { uri: audioUri, name, type },
    meta: baseMeta,
  };
};

const transcribeOpenAI = async (audioUri: string, config: SpeechToTextConfig) => {
  if (!config.apiKey) {
    throw new Error('OpenAI API key missing');
  }
  const language = resolveLanguage(config.language);
  const strategies: OpenAIUploadStrategy[] = IS_EXPO_GO ? ['uri', 'blob'] : ['blob', 'uri'];
  let lastError: unknown = null;

  for (let index = 0; index < strategies.length; index += 1) {
    const strategy = strategies[index];
    try {
      const { part, fileName, meta } = await buildOpenAIMultipartPayload(audioUri, strategy);
      void logInfo('OpenAI transcription starting', {
        scope: 'speech',
        extra: {
          provider: 'openai',
          model: config.model,
          language,
          attempt: String(index + 1),
          ...meta,
        },
      });

      const form = new FormData();
      if (fileName) {
        form.append('file', part as Blob, fileName);
      } else {
        form.append('file', part as any);
      }
      form.append('model', config.model);
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
      void logInfo('OpenAI transcription completed', {
        scope: 'speech',
        extra: {
          provider: 'openai',
          model: config.model,
          language,
          attempt: String(index + 1),
          strategy,
          transcriptLength: String(text.trim().length),
        },
      });
      return text.trim();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      void logWarn('OpenAI transcription failed', {
        scope: 'speech',
        extra: {
          provider: 'openai',
          model: config.model,
          language,
          attempt: String(index + 1),
          strategy,
          expoGo: String(IS_EXPO_GO),
          audioUri,
          error: message,
        },
      });
      if (index < strategies.length - 1) {
        void logWarn('Retrying OpenAI transcription with alternate upload strategy', {
          scope: 'speech',
          extra: {
            currentStrategy: strategy,
            nextStrategy: strategies[index + 1],
            expoGo: String(IS_EXPO_GO),
          },
        });
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'OpenAI transcription failed'));
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
    void logWarn('OpenAI responses parse failed, retrying with chat completions', {
      scope: 'speech',
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
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

const MIN_WHISPER_MODEL_BYTES = 5 * 1024 * 1024;
const WHISPER_REALTIME_SLICE_SEC = 30;
const WHISPER_REALTIME_BUFFER_SIZE = 2048;
const WHISPER_MODEL_DIR_NAME = 'whisper-models';
const WHISPER_MODEL_KEEP_FILE = '.keep';
const WHISPER_MODEL_FILES: Record<string, string> = {
  'whisper-tiny': 'ggml-tiny.bin',
  'whisper-tiny.en': 'ggml-tiny.en.bin',
  'whisper-base': 'ggml-base.bin',
  'whisper-base.en': 'ggml-base.en.bin',
};

type WhisperModelResolved = {
  path: string;
  uri: string;
  exists: boolean;
  size: number;
};

const normalizeFilePath = (value: string) => {
  if (value.startsWith('file://')) {
    return { path: value.replace(/^file:\/\//, ''), uri: value };
  }
  if (value.startsWith('file:/')) {
    const stripped = value.replace(/^file:\//, '/');
    return { path: stripped, uri: `file://${stripped}` };
  }
  if (value.startsWith('/')) {
    return { path: value, uri: `file://${value}` };
  }
  return { path: value, uri: value };
};

const getPathInfoSize = (info: unknown) => {
  if (!info || typeof info !== 'object') return 0;
  const size = (info as { size?: unknown }).size;
  return typeof size === 'number' ? size : 0;
};

const checkFile = (uri: string) => {
  try {
    const info = Paths.info(uri);
    if (info?.exists && !info.isDirectory) {
      const size = getPathInfoSize(info);
      return { exists: true, size };
    }
  } catch {
    // Fall back to File metadata when Paths.info cannot handle the uri.
  }
  try {
    const file = new File(uri);
    if (file.exists) {
      const size = typeof file.size === 'number' ? file.size : 0;
      return { exists: true, size };
    }
  } catch {
    // Ignore and report missing below.
  }
  return { exists: false, size: 0 };
};

const checkPath = (uri?: string) => {
  if (!uri) return { exists: false, isDirectory: false, size: 0 };
  try {
    const info = Paths.info(uri);
    if (info?.exists) {
      return {
        exists: true,
        isDirectory: Boolean(info.isDirectory),
        size: getPathInfoSize(info),
      };
    }
  } catch {
  }
  try {
    const dir = new Directory(uri);
    if (dir.exists) {
      return { exists: true, isDirectory: true, size: 0 };
    }
  } catch {
  }
  try {
    const file = new File(uri);
    if (file.exists) {
      return { exists: true, isDirectory: false, size: typeof file.size === 'number' ? file.size : 0 };
    }
  } catch {
  }
  return { exists: false, isDirectory: false, size: 0 };
};

const listDirectorySample = (uri?: string) => {
  if (!uri) return '';
  try {
    const dir = new Directory(uri);
    if (!dir.exists) return '';
    const entries = dir.list();
    if (!entries.length) return '';
    return entries
      .slice(0, 8)
      .map((entry) => {
        try {
          return Paths.basename(entry.uri) ?? '';
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join(', ');
  } catch {
    return '';
  }
};

const buildWhisperDiagnostics = (modelId?: string, modelPath?: string, resolved?: WhisperModelResolved) => {
  const docUri = Paths.document?.uri ?? '';
  const cacheUri = Paths.cache?.uri ?? '';
  const normalizedDoc = docUri ? normalizeFilePath(docUri).uri : '';
  const normalizedCache = cacheUri ? normalizeFilePath(cacheUri).uri : '';
  const docInfo = checkPath(normalizedDoc);
  const cacheInfo = checkPath(normalizedCache);
  const whisperDirUri = normalizedDoc
    ? `${normalizedDoc.endsWith('/') ? normalizedDoc : `${normalizedDoc}/`}${WHISPER_MODEL_DIR_NAME}`
    : '';
  const whisperDirInfo = checkPath(whisperDirUri);
  const resolvedInfo = resolved ? checkFile(resolved.uri) : { exists: false, size: 0 };
  const documentSample = listDirectorySample(normalizedDoc);
  const cacheSample = listDirectorySample(normalizedCache);
  const whisperDirSample = listDirectorySample(whisperDirUri);
  return {
    modelId: modelId ?? '',
    modelPath: modelPath ?? '',
    resolvedUri: resolved?.uri ?? '',
    resolvedExists: String(Boolean(resolvedInfo.exists)),
    resolvedSize: String(resolvedInfo.size ?? 0),
    documentUri: normalizedDoc,
    documentExists: String(Boolean(docInfo.exists)),
    documentIsDir: String(Boolean(docInfo.isDirectory)),
    documentSample,
    cacheUri: normalizedCache,
    cacheExists: String(Boolean(cacheInfo.exists)),
    cacheIsDir: String(Boolean(cacheInfo.isDirectory)),
    cacheSample,
    whisperDirUri,
    whisperDirExists: String(Boolean(whisperDirInfo.exists)),
    whisperDirIsDir: String(Boolean(whisperDirInfo.isDirectory)),
    whisperDirSample,
  };
};

const ensureWhisperModelDirectory = (): string | null => {
  const roots: Directory[] = [];
  try {
    roots.push(Paths.cache);
  } catch {
  }
  try {
    roots.push(Paths.document);
  } catch {
  }
  for (const root of roots) {
    try {
      const dir = new Directory(root, WHISPER_MODEL_DIR_NAME);
      dir.create({ intermediates: true, idempotent: true });
      try {
        const keepFile = new File(dir, WHISPER_MODEL_KEEP_FILE);
        if (!keepFile.exists) {
          keepFile.create({ intermediates: true, overwrite: true });
        }
      } catch {
        // Ignore keep file errors; directory is the important part.
      }
      return dir.uri;
    } catch {
    }
  }
  return null;
};

const buildWhisperModelCandidates = (
  modelId: string | undefined,
  modelPath?: string,
  includeRoot: boolean = true,
  includeCache: boolean = true
): string[] => {
  const candidates: string[] = [];
  if (modelPath) {
    const normalized = normalizeFilePath(modelPath);
    candidates.push(normalized.uri);
    if (normalized.uri !== modelPath) {
      candidates.push(modelPath);
    }
  }
  const fileName = modelId ? WHISPER_MODEL_FILES[modelId] : undefined;
  if (fileName) {
    const appendCandidates = (base?: string | null) => {
      if (!base) return;
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      candidates.push(`${normalizedBase}${WHISPER_MODEL_DIR_NAME}/${fileName}`);
      if (includeRoot) {
        candidates.push(`${normalizedBase}${fileName}`);
      }
    };
    if (includeCache) {
      appendCandidates(Paths.cache?.uri ?? null);
    }
    appendCandidates(Paths.document?.uri ?? null);
  }
  return candidates;
};

export const resolveWhisperModelPathForConfig = (
  modelId: string | undefined,
  modelPath?: string
): WhisperModelResolved => {
  const fileName = modelId ? WHISPER_MODEL_FILES[modelId] : undefined;
  const candidates = buildWhisperModelCandidates(modelId, modelPath, true, true);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeFilePath(candidate);
    const info = checkFile(normalized.uri);
    if (info.exists) {
      return { path: normalized.path, uri: normalized.uri, exists: true, size: info.size };
    }
  }

  const fallback = modelPath ? normalizeFilePath(modelPath) : normalizeFilePath(fileName ?? '');
  return { path: fallback.path, uri: fallback.uri, exists: false, size: 0 };
};

export const ensureWhisperModelPathForConfig = (
  modelId: string | undefined,
  modelPath?: string
): WhisperModelResolved => {
  const resolved = resolveWhisperModelPathForConfig(modelId, modelPath);
  const fileName = modelId ? WHISPER_MODEL_FILES[modelId] : undefined;
  if (!fileName) return resolved;

  const preferredDir = ensureWhisperModelDirectory();
  const preferredUri = preferredDir
    ? `${preferredDir.endsWith('/') ? preferredDir : `${preferredDir}/`}${fileName}`
    : null;

  if (preferredUri) {
    const preferredNormalized = normalizeFilePath(preferredUri);
    const preferredInfo = checkFile(preferredNormalized.uri);
    if (preferredInfo.exists) {
      return {
        path: preferredNormalized.path,
        uri: preferredNormalized.uri,
        exists: true,
        size: preferredInfo.size,
      };
    }
    if (resolved.exists) {
      try {
        const source = new File(resolved.uri);
        const destination = new File(preferredNormalized.uri);
        if (!destination.exists) {
          source.copy(destination);
        }
        const destInfo = checkFile(preferredNormalized.uri);
        if (destInfo.exists) {
          return {
            path: preferredNormalized.path,
            uri: preferredNormalized.uri,
            exists: true,
            size: destInfo.size,
          };
        }
      } catch {
        // Ignore copy errors and fall back to resolved below.
      }
    }
  }

  if (resolved.exists) return resolved;

  const candidates = buildWhisperModelCandidates(modelId, modelPath, true, true);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeFilePath(candidate);
    const info = checkFile(normalized.uri);
    if (!info.exists) continue;
    return { path: normalized.path, uri: normalized.uri, exists: true, size: info.size };
  }

  void logWarn('Whisper model missing', {
    scope: 'speech',
    extra: buildWhisperDiagnostics(modelId, modelPath, resolved),
  });

  return resolved;
};

const enableWhisperNativeLogging = async (): Promise<void> => {
  if (whisperNativeLogEnabled) return;
  if (!__DEV__) {
    // Avoid enabling JNI log callbacks in release builds.
    whisperNativeLogEnabled = true;
    return;
  }
  try {
    const whisper = getWhisperModule();
    if (typeof whisper.toggleNativeLog === 'function') {
      await whisper.toggleNativeLog(true);
    }
    if (typeof whisper.addNativeLogListener === 'function') {
      whisper.addNativeLogListener((level: string, text: string) => {
        void logWarn('Whisper native', {
          scope: 'speech',
          extra: { level, text },
        });
      });
    }
    whisperNativeLogEnabled = true;
  } catch (error) {
    void logWarn('Failed to enable Whisper native logs', {
      scope: 'speech',
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
  }
};

const getWhisperContext = async (modelPath: string, modelId?: string) => {
  await enableWhisperNativeLogging();
  const resolved = ensureWhisperModelPathForConfig(modelId, modelPath);
  if (!resolved.exists) {
    throw new Error(`Offline model not found at ${resolved.path}`);
  }
  if (resolved.size > 0 && resolved.size < MIN_WHISPER_MODEL_BYTES) {
    throw new Error(`Offline model file is too small (${resolved.size} bytes)`);
  }
  if (whisperContextCache?.modelPath === resolved.path) {
    return whisperContextCache.context;
  }
  const { initWhisper } = getWhisperModule();
  const initOptions: { filePath: string; useGpu?: boolean; useFlashAttn?: boolean } = {
    filePath: resolved.path,
    useFlashAttn: false,
  };
  if (Platform.OS === 'android') {
    initOptions.useGpu = false;
  }
  try {
    const context = await initWhisper(initOptions);
    whisperContextCache = { modelPath: resolved.path, context };
    return context;
  } catch (error) {
    const withScheme = resolved.uri;
    if (withScheme !== resolved.path) {
      try {
        const context = await initWhisper({ ...initOptions, filePath: withScheme });
        whisperContextCache = { modelPath: withScheme, context };
        return context;
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        throw new Error(`Whisper init failed (${message}) at ${resolved.path} (${resolved.size} bytes)`);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Whisper init failed (${message}) at ${resolved.path} (${resolved.size} bytes)`);
  }
};

const extractWhisperText = (result: unknown): string => {
  const direct = (result as { result?: unknown })?.result;
  if (typeof direct === 'string') return direct;
  if (direct && typeof (direct as { text?: unknown }).text === 'string') {
    return (direct as { text: string }).text;
  }
  if (typeof (result as { text?: unknown }).text === 'string') {
    return (result as { text: string }).text;
  }
  if (typeof (result as { transcript?: unknown }).transcript === 'string') {
    return (result as { transcript: string }).transcript;
  }
  const segments = (result as { segments?: Array<{ text?: string }> }).segments;
  if (Array.isArray(segments)) {
    const joined = segments.map((segment) => segment?.text ?? '').join(' ').trim();
    if (joined) return joined;
  }
  return '';
};

export const startWhisperRealtimeCapture = async (
  audioOutputPath: string,
  config: SpeechToTextConfig
): Promise<WhisperRealtimeHandle> => {
  if (IS_EXPO_GO) {
    throw new Error('On-device Whisper requires a dev build or production build (not Expo Go).');
  }
  const RNFS = getRNFSModule();
  if (!RNFS) {
    throw new Error('react-native-fs is unavailable. Use a dev build or production build with native modules.');
  }
  const resolved = ensureWhisperModelPathForConfig(config.model, config.modelPath);
  if (!resolved.exists) {
    throw new Error(`Offline model not found at ${resolved.path}`);
  }
  const context = await getWhisperContext(resolved.path, config.model);
  const language = resolveLanguage(config.language);
  const effectiveLanguage = config.model?.endsWith('.en') && language === 'auto' ? 'en' : language;
  const transcribeOptions = buildWhisperTranscribeOptions(effectiveLanguage);
  const options: Record<string, unknown> = {
    audioOutputPath,
    audioSliceSec: WHISPER_REALTIME_SLICE_SEC,
    audioStreamConfig: {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      bufferSize: WHISPER_REALTIME_BUFFER_SIZE,
      audioSource: 6,
    },
    transcribeOptions: Object.keys(transcribeOptions).length ? transcribeOptions : undefined,
    promptPreviousSlices: false,
  };

  void logInfo('Whisper transcription started', {
    scope: 'speech',
    extra: {
      uri: audioOutputPath,
      modelPath: resolved.path,
      language: effectiveLanguage,
    },
  });

  const audioStream = new AudioPcmStreamAdapter();
  const enableRealtimeTranscript = Platform.OS !== 'android';
  const transcriptBySlice = new Map<number, string>();
  let completed = false;
  let hasActivated = false;
  let resolveResult: (value: SpeechToTextResult) => void = () => {};
  let rejectResult: (error: Error) => void = () => {};

  const result = new Promise<SpeechToTextResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finalize = () => {
    if (completed) return;
    completed = true;
    if (!enableRealtimeTranscript) {
      resolveResult({ transcript: '' });
      return;
    }
    const sorted = [...transcriptBySlice.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value.trim())
      .filter(Boolean);
    const text = sorted.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) {
      void logWarn('Whisper returned empty transcript', {
        scope: 'speech',
        extra: {
          uri: audioOutputPath,
          modelPath: resolved.path,
          language: effectiveLanguage,
        },
      });
    } else {
      void logInfo('Whisper transcription completed', {
        scope: 'speech',
        extra: {
          length: String(text.length),
          language: effectiveLanguage,
        },
      });
    }
    resolveResult({ transcript: text });
  };

  const realtime = new RealtimeTranscriber(
    { whisperContext: context, audioStream, fs: RNFS },
    options,
    {
      onBeginTranscribe: enableRealtimeTranscript ? undefined : async () => false,
      onTranscribe: enableRealtimeTranscript
        ? (event: RealtimeTranscriberEvent) => {
          if (completed) return;
          const nextText = extractWhisperText(event.data ?? {}).trim();
          if (!nextText) return;
          const normalized = nextText.replace(/\s+/g, ' ').trim();
          if (!normalized) return;
          const sliceIndex = typeof event.sliceIndex === 'number' ? event.sliceIndex : 0;
          const prev = transcriptBySlice.get(sliceIndex) ?? '';
          if (!prev || normalized.length > prev.length) {
            transcriptBySlice.set(sliceIndex, normalized);
          }
        }
        : undefined,
      onError: (error: string) => {
        if (completed) return;
        completed = true;
        rejectResult(new Error(error));
      },
      onStatusChange: (isActive: boolean) => {
        if (completed) return;
        if (isActive) {
          hasActivated = true;
          return;
        }
        if (hasActivated) {
          finalize();
        }
      },
    }
  );

  try {
    await realtime.start();
  } catch (error) {
    try {
      await realtime.release();
    } catch {
      // Ignore cleanup failures after a failed start.
    }
    throw error;
  }

  const stop = async () => {
    try {
      await realtime.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void logWarn('Failed to stop whisper recording', {
        scope: 'speech',
        extra: { error: message },
      });
    } finally {
      try {
        await realtime.release();
      } catch {
        // Ignore release failures.
      }
      finalize();
    }
  };

  return { stop, result, hasRealtimeTranscript: enableRealtimeTranscript };
};

export const preloadWhisperContext = async (config: {
  model?: string;
  modelPath?: string;
}): Promise<void> => {
  if (IS_EXPO_GO) return;
  const resolved = ensureWhisperModelPathForConfig(config.model, config.modelPath);
  if (!resolved.exists) return;
  await getWhisperContext(resolved.path, config.model);
};

const transcribeWhisper = async (audioUri: string, config: SpeechToTextConfig) => {
  if (IS_EXPO_GO) {
    throw new Error('On-device Whisper requires a dev build or production build (not Expo Go).');
  }
  const resolved = ensureWhisperModelPathForConfig(config.model, config.modelPath);
  if (!resolved.exists) {
    throw new Error(`Offline model not found at ${resolved.path}`);
  }
  const context = await getWhisperContext(resolved.path, config.model);
  const language = resolveLanguage(config.language);
  const effectiveLanguage = config.model?.endsWith('.en') && language === 'auto' ? 'en' : language;
  const options = buildWhisperTranscribeOptions(effectiveLanguage);
  void logInfo('Whisper transcription started', {
    scope: 'speech',
    extra: {
      uri: audioUri,
      modelPath: resolved.path,
      language: effectiveLanguage,
    },
  });
  const normalizedUri = audioUri.startsWith('file://')
    ? audioUri.replace(/^file:\/\//, '')
    : audioUri.startsWith('file:/')
      ? audioUri.replace(/^file:\//, '/')
      : audioUri;
  let result: unknown;
  try {
    result = await context.transcribe(normalizedUri, options).promise;
  } catch (error) {
    if (normalizedUri !== audioUri) {
      result = await context.transcribe(audioUri, options).promise;
    } else {
      throw error;
    }
  }
  let text = extractWhisperText(result).trim();
  if (!text && normalizedUri !== audioUri) {
    try {
      const retry = await context.transcribe(audioUri, options).promise;
      text = extractWhisperText(retry).trim();
    } catch {
      // Ignore retry errors after a successful primary transcription.
    }
  }
  if (!text) {
    void logWarn('Whisper returned empty transcript', {
      scope: 'speech',
      extra: {
        uri: audioUri,
        modelPath: resolved.path,
        language: effectiveLanguage,
      },
    });
  } else {
    void logInfo('Whisper transcription completed', {
      scope: 'speech',
      extra: {
        length: String(text.length),
        language: effectiveLanguage,
      },
    });
  }
  return text;
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
      void logWarn('OpenAI smart parse failed, falling back to transcript', {
        scope: 'speech',
        extra: { error: retryError instanceof Error ? retryError.message : String(retryError) },
      });
      return { transcript };
    }
  }
}
