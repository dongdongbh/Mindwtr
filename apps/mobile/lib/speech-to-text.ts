import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import type {
  OpenAISpeechUpload,
  ResolvedSpeechToTextRuntimeSettings,
  SpeechProvider,
  SpeechToTaskResult,
  SpeechToTextConfig,
  SpeechToTextSettings,
} from '@mindwtr/core';
import {
  dispatchSpeechCapture,
  normalizeSpeechLanguage,
  REMOTE_SPEECH_TO_TEXT_FOSS_ERROR,
  resolveSpeechToTextRuntimeSettings as resolveSpeechToTextRuntimeSettingsForBuild,
} from '@mindwtr/core';
import { DEFAULT_GEMINI_STT_MODEL, DEFAULT_OPENAI_STT_MODEL } from '@mindwtr/core/ai-settings-model';
import { logInfo, logWarn } from './app-log';
import {
  buildMultipartAudioPart,
  normalizeAudioUri,
  normalizeAudioUriForFileRead,
} from './speech-to-text.helpers';
import {
  ensureLocation as ensureWhisperModelLocation,
  getRNFSModuleAsync,
  locate as locateWhisperModel,
  type WhisperModelLocation,
} from './whisper-model-store';

// The provider resolution, the FOSS rule and the provider dispatch are core's (quick-capture-audio.ts); this module binds them to
// Expo's build flags and files and keeps whisper.rn.
export type { ResolvedSpeechToTextRuntimeSettings, SpeechProvider, SpeechToTextConfig };
export { REMOTE_SPEECH_TO_TEXT_FOSS_ERROR };

export type SpeechToTextResult = SpeechToTaskResult;

export type CapturedAudio = {
  uri: string;
  platform: 'ios' | 'android';
  source: 'expo-recorder' | 'pcm-recorder';
  extension?: string;
};

export type LocalWhisperAudio = {
  uri: string;
  format: 'wav-pcm';
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  bytes: number;
  durationMs: number;
};

export type WhisperRealtimeHandle = {
  stop: () => Promise<void>;
  result: Promise<SpeechToTextResult>;
  hasRealtimeTranscript: boolean;
};

const WHISPER_ANDROID_MAX_THREADS = 1;
const WHISPER_ANDROID_N_PROCESSORS = 1;
const LOCAL_WHISPER_SAMPLE_RATE = 16000;
const LOCAL_WHISPER_CHANNELS = 1;
const LOCAL_WHISPER_BITS_PER_SAMPLE = 16;
const LOCAL_WHISPER_MIN_DURATION_MS = 150;
const LOCAL_WHISPER_UNSUPPORTED_AUDIO_ERROR =
  'Local Whisper can only transcribe 16 kHz mono PCM WAV audio.';
// Core's (ai-settings-model.ts), so the settings screen offers the same defaults this
// runtime resolves — the two hardcoding their own copies is how the screen kept
// offering retired gemini-2.5 ids after the catalog refresh.
export { DEFAULT_GEMINI_STT_MODEL, DEFAULT_OPENAI_STT_MODEL };

type ExpoConstantsExtra = {
  isFossBuild?: unknown;
};

type ExpoConstantsLike = {
  appOwnership?: string | null;
  expoConfig?: {
    extra?: ExpoConstantsExtra | null;
  } | null;
};

type WhisperContextLike = {
  transcribe: (uri: string, options?: Record<string, unknown>) => { promise: Promise<unknown> };
  transcribeData?: (
    data: ArrayBuffer,
    options?: Record<string, unknown>
  ) => { stop: () => Promise<void>; promise: Promise<unknown> };
};

type WhisperRealtimeEventLike = {
  data?: unknown;
  sliceIndex?: number;
};

type AudioPcmStreamAdapterLike = object;

type AudioPcmStreamAdapterConstructor = new () => AudioPcmStreamAdapterLike;

type RealtimeTranscriberLike = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  release: () => Promise<void>;
};

type RealtimeTranscriberConstructor = new (
  dependencies: {
    whisperContext: WhisperContextLike;
    audioStream: AudioPcmStreamAdapterLike;
    fs: RNFSModule;
  },
  options: Record<string, unknown>,
  handlers: {
    onBeginTranscribe?: () => Promise<boolean>;
    onTranscribe?: (event: WhisperRealtimeEventLike) => void;
    onError?: (error: string) => void;
    onStatusChange?: (isActive: boolean) => void;
  }
) => RealtimeTranscriberLike;

let whisperContextCache: { modelPath: string; context: WhisperContextLike } | null = null;
let whisperNativeLogEnabled = false;
type WhisperModule = typeof import('whisper.rn');
let whisperModuleCache: WhisperModule | null = null;
let expoConstantsCache: ExpoConstantsLike | null | undefined;
let whisperRealtimeModuleCache:
  | {
    AudioPcmStreamAdapter: AudioPcmStreamAdapterConstructor;
    RealtimeTranscriber: RealtimeTranscriberConstructor;
  }
  | null
  | undefined;

type RNFSModule = typeof import('react-native-fs');

const getWhisperModule = () => {
  if (whisperModuleCache) return whisperModuleCache;
  try {
    // Use static fallback paths so Metro can bundle this file.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('whisper.rn/src/index') as WhisperModule;
      whisperModuleCache = mod;
      return mod;
    } catch (sourceError) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('whisper.rn') as WhisperModule;
        whisperModuleCache = mod;
        return mod;
      } catch (rootError) {
        const errors = [sourceError, rootError]
          .map((value) => (value instanceof Error ? value.message : String(value)))
          .join(' | ');
        throw new Error(`Whisper module unavailable: ${errors}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Whisper module unavailable: ${message}`);
  }
};

const getExpoConstants = (): ExpoConstantsLike | null => {
  if (expoConstantsCache !== undefined) return expoConstantsCache;
  try {
    // Delay loading expo-constants so non-Expo test environments can import this module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-constants') as {
      default?: ExpoConstantsLike | { default?: ExpoConstantsLike };
    } | ExpoConstantsLike | undefined;
    const moduleDefault = (mod as { default?: ExpoConstantsLike | { default?: ExpoConstantsLike } } | undefined)?.default;
    expoConstantsCache = (
      (moduleDefault as { default?: ExpoConstantsLike } | undefined)?.default
      ?? (moduleDefault as ExpoConstantsLike | undefined)
      ?? (mod as ExpoConstantsLike | undefined)
      ?? null
    );
    return expoConstantsCache;
  } catch {
    expoConstantsCache = null;
    return null;
  }
};

const parseExtraBool = (value: unknown): boolean => value === true || value === 'true' || value === '1';

const isExpoGo = (): boolean => getExpoConstants()?.appOwnership === 'expo';

export const isMobileFossBuild = (): boolean => parseExtraBool(
  getExpoConstants()?.expoConfig?.extra?.isFossBuild
);

export const resolveSpeechToTextRuntimeSettings = (
  speech: SpeechToTextSettings | undefined,
  options?: { isFossBuild?: boolean }
): ResolvedSpeechToTextRuntimeSettings => resolveSpeechToTextRuntimeSettingsForBuild(speech, {
  isFossBuild: options?.isFossBuild ?? isMobileFossBuild(),
});

const getWhisperRealtimeModule = () => {
  if (whisperRealtimeModuleCache !== undefined) return whisperRealtimeModuleCache;
  try {
    // Delay loading Whisper realtime modules so generic task-edit tests can import this file
    // without a native audio stream implementation in the environment.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adapterModule = require(
      'whisper.rn/realtime-transcription/adapters/AudioPcmStreamAdapter.js'
    ) as { AudioPcmStreamAdapter?: AudioPcmStreamAdapterConstructor } | undefined;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realtimeModule = require(
      'whisper.rn/realtime-transcription/index.js'
    ) as { RealtimeTranscriber?: RealtimeTranscriberConstructor } | undefined;
    if (!adapterModule?.AudioPcmStreamAdapter || !realtimeModule?.RealtimeTranscriber) {
      whisperRealtimeModuleCache = null;
      return null;
    }
    whisperRealtimeModuleCache = {
      AudioPcmStreamAdapter: adapterModule.AudioPcmStreamAdapter,
      RealtimeTranscriber: realtimeModule.RealtimeTranscriber,
    };
    return whisperRealtimeModuleCache;
  } catch (error) {
    void logWarn('Whisper realtime module unavailable', {
      scope: 'speech',
      force: true,
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    whisperRealtimeModuleCache = null;
    return null;
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

type OpenAIUploadStrategy = 'blob' | 'uri';

const buildOpenAIMultipartPayload = async (
  audioUri: string,
  strategy: OpenAIUploadStrategy
): Promise<{
  part: Blob | { uri: string; name: string; type: string };
  fileName?: string;
  meta: Record<string, string>;
}> => {
  const uploadUri = normalizeAudioUri(audioUri);
  const fileReadUri = normalizeAudioUriForFileRead(audioUri);
  const file = new File(fileReadUri);
  const name = file.name || `audio${getExtension(uploadUri)}`;
  const type = file.type || getMimeType(uploadUri);
  const uriScheme = uploadUri.split(':')[0] || 'unknown';
  const baseMeta = {
    strategy,
    uriScheme,
    fileName: name,
    mimeType: type,
    fileExists: String(Boolean(file.exists)),
    fileSize: String(typeof file.size === 'number' ? file.size : 0),
    expoGo: String(isExpoGo()),
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
      uri: uploadUri,
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
    part: { uri: uploadUri, name, type },
    meta: baseMeta,
  };
};

const withOpenAIUpload = async <T>(
  audioUri: string,
  config: SpeechToTextConfig,
  send: (upload: OpenAISpeechUpload) => Promise<T>
): Promise<T> => {
  const language = normalizeSpeechLanguage(config.language);
  const strategies: OpenAIUploadStrategy[] = isExpoGo() ? ['uri', 'blob'] : ['blob', 'uri'];
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
      // React Native FormData accepts its URI descriptor at runtime even though
      // the DOM type used by core only exposes Blob.
      const result = await send({ part: part as Blob, fileName });
      void logInfo('OpenAI transcription completed', {
        scope: 'speech',
        extra: {
          provider: 'openai',
          model: config.model,
          language,
          attempt: String(index + 1),
          strategy,
          transcriptLength: String(
            typeof result === 'string' ? result.trim().length : 0
          ),
        },
      });
      return result;
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
          expoGo: String(isExpoGo()),
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
            expoGo: String(isExpoGo()),
          },
        });
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'OpenAI transcription failed'));
};

const MIN_WHISPER_MODEL_BYTES = 5 * 1024 * 1024;
const WHISPER_REALTIME_SLICE_SEC = 30;
const WHISPER_REALTIME_BUFFER_SIZE = 2048;
// Model directory naming, the candidate ladder, the RNFS<->expo-file-system
// fallback, and URI normalization all live in whisper-model-store.ts now — it's
// the one place both this read side and the settings write side resolve "where
// is the model, and is it there." These are thin wrappers kept for the existing
// call sites in this file and in components that import them directly
// (use-quick-capture-audio.ts, use-task-edit-attachments.ts).
export const resolveWhisperModelPathForConfigAsync = (
  modelId: string | undefined,
  modelPath?: string
): Promise<WhisperModelLocation> => locateWhisperModel(modelId, modelPath);

export const ensureWhisperModelPathForConfigAsync = (
  modelId: string | undefined,
  modelPath?: string
): Promise<WhisperModelLocation> => ensureWhisperModelLocation(modelId, modelPath);

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
      force: true,
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
  }
};

const getWhisperContext = async (modelPath: string, modelId?: string) => {
  await enableWhisperNativeLogging();
  const resolved = await ensureWhisperModelPathForConfigAsync(modelId, modelPath);
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
      const primaryMessage = error instanceof Error ? error.message : String(error);
      void logWarn('Whisper context init failed, retrying with file uri', {
        scope: 'speech',
        force: true,
        extra: {
          platform: Platform.OS,
          modelId: modelId ?? '',
          modelPath: resolved.path,
          modelUri: withScheme,
          modelSize: String(resolved.size),
          error: primaryMessage,
        },
      });
      try {
        const context = await initWhisper({ ...initOptions, filePath: withScheme });
        whisperContextCache = { modelPath: withScheme, context };
        return context;
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        void logWarn('Whisper context init failed', {
          scope: 'speech',
          force: true,
          extra: {
            platform: Platform.OS,
            modelId: modelId ?? '',
            modelPath: resolved.path,
            modelUri: withScheme,
            modelSize: String(resolved.size),
            error: message,
          },
        });
        throw new Error(`Whisper init failed (${message}) at ${resolved.path} (${resolved.size} bytes)`);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    void logWarn('Whisper context init failed', {
      scope: 'speech',
      force: true,
      extra: {
        platform: Platform.OS,
        modelId: modelId ?? '',
        modelPath: resolved.path,
        modelSize: String(resolved.size),
        error: message,
      },
    });
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

type WavPcmMetadata = {
  valid: boolean;
  reason?: string;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  dataBytes?: number;
  durationMs?: number;
  headerRiffWave: boolean;
};

const getAudioFileExtensionFromUri = (uri: string): string => {
  const withoutQuery = uri.split('?')[0]?.split('#')[0] ?? '';
  const fileName = withoutQuery.split('/').pop() ?? '';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return '';
  return fileName.slice(dotIndex + 1).toLowerCase();
};

const getUriScheme = (uri: string): string => {
  const index = uri.indexOf(':');
  if (index > 0) return uri.slice(0, index);
  if (uri.startsWith('/')) return 'file';
  return 'unknown';
};

const readAscii = (bytes: Uint8Array, offset: number, length: number): string => {
  let value = '';
  for (let i = 0; i < length; i += 1) {
    value += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return value;
};

const readUInt16LE = (bytes: Uint8Array, offset: number): number => (
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
);

const readUInt32LE = (bytes: Uint8Array, offset: number): number => (
  ((bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)) >>> 0
);

const inspectWavPcm = (bytes: Uint8Array): WavPcmMetadata => {
  if (bytes.byteLength < 44) {
    return { valid: false, reason: 'too_short', headerRiffWave: false };
  }

  const headerRiffWave = readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WAVE';
  if (!headerRiffWave) {
    return { valid: false, reason: 'not_riff_wave', headerRiffWave };
  }

  let offset = 12;
  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let dataBytes: number | undefined;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readUInt32LE(bytes, offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > bytes.byteLength) {
      break;
    }

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = readUInt16LE(bytes, chunkDataOffset);
      channels = readUInt16LE(bytes, chunkDataOffset + 2);
      sampleRate = readUInt32LE(bytes, chunkDataOffset + 4);
      bitsPerSample = readUInt16LE(bytes, chunkDataOffset + 14);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  const bytesPerSecond = sampleRate && channels && bitsPerSample
    ? sampleRate * channels * (bitsPerSample / 8)
    : 0;
  const durationMs = dataBytes && bytesPerSecond > 0 ? Math.round((dataBytes / bytesPerSecond) * 1000) : 0;
  const base = {
    audioFormat,
    bitsPerSample,
    channels,
    dataBytes,
    durationMs,
    headerRiffWave,
    sampleRate,
  };

  if (audioFormat !== 1) return { ...base, valid: false, reason: 'not_pcm' };
  if (channels !== LOCAL_WHISPER_CHANNELS) return { ...base, valid: false, reason: 'unsupported_channels' };
  if (sampleRate !== LOCAL_WHISPER_SAMPLE_RATE) return { ...base, valid: false, reason: 'unsupported_sample_rate' };
  if (bitsPerSample !== LOCAL_WHISPER_BITS_PER_SAMPLE) return { ...base, valid: false, reason: 'unsupported_bits_per_sample' };
  if (!dataBytes || dataBytes <= 0) return { ...base, valid: false, reason: 'empty_data' };
  if (durationMs < LOCAL_WHISPER_MIN_DURATION_MS) return { ...base, valid: false, reason: 'too_short_duration' };

  return { ...base, valid: true };
};

const buildLocalAsrLogContext = (captured: CapturedAudio, metadata: WavPcmMetadata | null, bytes: number, fallbackReason?: string) => ({
  bits_per_sample: String(metadata?.bitsPerSample ?? ''),
  capture_mode: captured.source,
  channels: String(metadata?.channels ?? ''),
  duration_ms: String(metadata?.durationMs ?? 0),
  extension: captured.extension ?? getAudioFileExtensionFromUri(captured.uri),
  fallback_reason: fallbackReason ?? '',
  file_size: String(bytes),
  header_riff_wave: String(metadata?.headerRiffWave === true),
  platform: captured.platform,
  sample_rate: String(metadata?.sampleRate ?? ''),
  sniffed_format: metadata?.headerRiffWave ? 'wav' : 'unknown',
  uri_scheme: getUriScheme(captured.uri),
});

export const prepareAudioForLocalWhisper = async (captured: CapturedAudio): Promise<LocalWhisperAudio | null> => {
  const normalizedUri = normalizeAudioUriForFileRead(captured.uri);
  let bytes: Uint8Array;
  try {
    bytes = await new File(normalizedUri).bytes();
  } catch (error) {
    await logWarn('ASR_INPUT_REJECTED_UNSUPPORTED_FORMAT', {
      scope: 'speech',
      force: true,
      extra: {
        ...buildLocalAsrLogContext(captured, null, 0, 'read_failed'),
        error: error instanceof Error ? error.message : String(error),
        local_whisper_called: 'false',
        reject_reason: 'read_failed',
      },
    });
    return null;
  }

  const metadata = inspectWavPcm(bytes);
  if (!metadata.valid) {
    await logWarn('ASR_INPUT_REJECTED_UNSUPPORTED_FORMAT', {
      scope: 'speech',
      force: true,
      extra: {
        ...buildLocalAsrLogContext(captured, metadata, bytes.byteLength, metadata.reason),
        local_whisper_called: 'false',
        reject_reason: metadata.reason ?? 'unsupported_format',
      },
    });
    return null;
  }

  await logInfo('ASR_INPUT_ACCEPTED_LOCAL_WHISPER', {
    scope: 'speech',
    force: true,
    extra: {
      ...buildLocalAsrLogContext(captured, metadata, bytes.byteLength),
      local_whisper_called: 'false',
    },
  });

  return {
    uri: normalizeAudioUri(captured.uri),
    format: 'wav-pcm',
    sampleRate: metadata.sampleRate ?? LOCAL_WHISPER_SAMPLE_RATE,
    channels: metadata.channels ?? LOCAL_WHISPER_CHANNELS,
    bitsPerSample: metadata.bitsPerSample ?? LOCAL_WHISPER_BITS_PER_SAMPLE,
    bytes: bytes.byteLength,
    durationMs: metadata.durationMs ?? 0,
  };
};

export const startWhisperRealtimeCapture = async (
  audioOutputPath: string,
  config: SpeechToTextConfig
): Promise<WhisperRealtimeHandle> => {
  if (isExpoGo()) {
    throw new Error('On-device Whisper requires a dev build or production build (not Expo Go).');
  }
  const whisperRealtime = getWhisperRealtimeModule();
  if (!whisperRealtime) {
    throw new Error('Whisper realtime transcription requires native audio stream modules.');
  }
  const RNFS = await getRNFSModuleAsync();
  if (!RNFS) {
    throw new Error('react-native-fs is unavailable. Use a dev build or production build with native modules.');
  }
  const resolved = await ensureWhisperModelPathForConfigAsync(config.model, config.modelPath);
  if (!resolved.exists) {
    throw new Error(`Offline model not found at ${resolved.path}`);
  }
  const context = await getWhisperContext(resolved.path, config.model);
  const language = normalizeSpeechLanguage(config.language);
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

  const audioStream = new whisperRealtime.AudioPcmStreamAdapter();
  // Android's file transcription path decodes WAV only. Use the realtime helper
  // there as a PCM/WAV recorder, then transcribe the generated WAV after stop.
  const enableRealtimeTranscript = Platform.OS !== 'android';
  const transcriptBySlice = new Map<number, string>();
  let completed = false;
  let hasActivated = false;
  let resolveResult: (value: SpeechToTextResult) => void = () => {};
  const result = new Promise<SpeechToTextResult>((resolve) => {
    resolveResult = resolve;
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
        force: true,
        extra: {
          uri: audioOutputPath,
          modelPath: resolved.path,
          language: effectiveLanguage,
        },
      });
    }
    resolveResult({ transcript: text });
  };

  const realtime = new whisperRealtime.RealtimeTranscriber(
    { whisperContext: context, audioStream, fs: RNFS },
    options,
    {
      onBeginTranscribe: enableRealtimeTranscript ? undefined : async () => false,
      onTranscribe: enableRealtimeTranscript
        ? (event: WhisperRealtimeEventLike) => {
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
        void logWarn('Whisper realtime transcription failed', {
          scope: 'speech',
          force: true,
          extra: {
            platform: Platform.OS,
            error,
          },
        });
        resolveResult({ transcript: '' });
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
  if (isExpoGo()) return;
  const resolved = await ensureWhisperModelPathForConfigAsync(config.model, config.modelPath);
  if (!resolved.exists) return;
  await getWhisperContext(resolved.path, config.model);
};

export const transcribeLocalWhisper = async (input: LocalWhisperAudio, config: SpeechToTextConfig) => {
  if (isExpoGo()) {
    throw new Error('On-device Whisper requires a dev build or production build (not Expo Go).');
  }
  const resolved = await ensureWhisperModelPathForConfigAsync(config.model, config.modelPath);
  if (!resolved.exists) {
    throw new Error(`Offline model not found at ${resolved.path}`);
  }
  const context = await getWhisperContext(resolved.path, config.model);
  const language = normalizeSpeechLanguage(config.language);
  const effectiveLanguage = config.model?.endsWith('.en') && language === 'auto' ? 'en' : language;
  const options = buildWhisperTranscribeOptions(effectiveLanguage);
  const audioUri = input.uri;
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
      const primaryMessage = error instanceof Error ? error.message : String(error);
      void logWarn('Whisper transcription path failed, retrying with file uri', {
        scope: 'speech',
        force: true,
        extra: {
          platform: Platform.OS,
          modelPath: resolved.path,
          language: effectiveLanguage,
          error: primaryMessage,
        },
      });
      try {
        result = await context.transcribe(audioUri, options).promise;
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        void logWarn('Whisper transcription failed', {
          scope: 'speech',
          force: true,
          extra: {
            platform: Platform.OS,
            modelPath: resolved.path,
            language: effectiveLanguage,
            error: message,
          },
        });
        throw retryError;
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      void logWarn('Whisper transcription failed', {
        scope: 'speech',
        force: true,
        extra: {
          platform: Platform.OS,
          modelPath: resolved.path,
          language: effectiveLanguage,
          error: message,
        },
      });
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
      force: true,
      extra: {
        uri: audioUri,
        modelPath: resolved.path,
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
  return dispatchSpeechCapture(config, config.isFossBuild ?? isMobileFossBuild(), {
    readBytes: async () => {
      const normalizedUri = normalizeAudioUri(audioUri);
      const fileReadUri = normalizeAudioUriForFileRead(audioUri);
      const file = new File(fileReadUri);
      return {
        bytes: await file.bytes(),
        mimeType: getMimeType(normalizedUri),
      };
    },
    withOpenAIUpload: (send) => withOpenAIUpload(audioUri, config, send),
    transcribeLocal: async () => {
      const localInput = await prepareAudioForLocalWhisper({
        uri: audioUri,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        source: 'expo-recorder',
        extension: getAudioFileExtensionFromUri(audioUri),
      });
      if (!localInput) {
        throw new Error(LOCAL_WHISPER_UNSUPPORTED_AUDIO_ERROR);
      }
      return transcribeLocalWhisper(localInput, config);
    },
    logWarn,
  });
}
