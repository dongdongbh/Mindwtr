import type {
    AiSettings,
    SpeechToTaskCaptureConfig,
    SpeechToTaskResult,
} from '@mindwtr/core';
import {
    GEMINI_DEFAULT_MODEL,
    normalizeSpeechLanguage,
    runRemoteSpeechToTaskCapture,
    runSpeechToTaskCapture,
} from '@mindwtr/core';

import { loadAIKey } from './ai-config';
import { isTauriRuntime } from './runtime';
import { logWarn } from './app-log';
import { invokeNative } from './tauri-invoke';
import { DEFAULT_PARAKEET_MODEL, DEFAULT_WHISPER_MODEL } from './speech-models';

export type SpeechToTextResult = SpeechToTaskResult;

export type SpeechToTextConfig = SpeechToTaskCaptureConfig & {
    apiKey?: string;
    model: string;
    parseModel?: string;
    modelPath?: string;

    baseUrl?: string;
};

export type SpeechCaptureReadyReason = 'disabled' | 'no-key' | 'no-model';

export type ResolvedSpeechCapture = {
    ready: boolean;
    reason?: SpeechCaptureReadyReason;
    config: SpeechToTextConfig;
};


export async function resolveSpeechCapture(settings: AiSettings | undefined): Promise<ResolvedSpeechCapture> {
    const speech = settings?.speechToText;
    const provider = speech?.provider ?? 'gemini';
    const model = speech?.model ?? (
        provider === 'openai' ? 'gpt-transcribe'
            : provider === 'gemini' ? GEMINI_DEFAULT_MODEL
                : provider === 'parakeet' ? DEFAULT_PARAKEET_MODEL
                    : DEFAULT_WHISPER_MODEL
    );
    const apiSpeechProvider = provider === 'openai' || provider === 'gemini' ? provider : null;
    const modelPath = apiSpeechProvider ? undefined : speech?.offlineModelPath;


    const baseUrl = provider === 'openai' ? (speech?.baseUrl?.trim() || undefined) : undefined;
    const baseConfig = {
        provider,
        model,
        modelPath,
        baseUrl,
        language: speech?.language,
        mode: speech?.mode ?? 'smart_parse',
        fieldStrategy: speech?.fieldStrategy ?? 'smart',
        parseModel: provider === 'openai' && settings?.provider === 'openai' ? settings?.model : undefined,
    };
    if (!speech?.enabled) {


        return { ready: false, reason: 'disabled', config: { ...baseConfig, apiKey: '' } };
    }
    const apiKey = apiSpeechProvider ? await loadAIKey(apiSpeechProvider).catch(() => '') : '';
    const config: SpeechToTextConfig = { ...baseConfig, apiKey };
    if (apiSpeechProvider ? (!apiKey && !baseUrl) : !modelPath) {
        return { ready: false, reason: apiSpeechProvider ? 'no-key' : 'no-model', config };
    }
    return { ready: true, config };
}

export type AudioInput = {
    bytes: Uint8Array;
    mimeType: string;
    name?: string;
    path?: string;
};

const normalizeLocalAsrTranscript = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return '';

    const parseCandidate = (candidate: string) => {
        try {
            const parsed = JSON.parse(candidate) as unknown;
            if (!parsed || typeof parsed !== 'object') return null;
            const text = (parsed as { text?: unknown; transcript?: unknown }).text
                ?? (parsed as { transcript?: unknown }).transcript;
            return typeof text === 'string' ? text.trim() : null;
        } catch {
            return null;
        }
    };

    const direct = parseCandidate(trimmed);
    if (direct !== null) return direct;

    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        const embedded = parseCandidate(trimmed.slice(objectStart, objectEnd + 1));
        if (embedded !== null) return embedded;
    }

    return trimmed;
};

const resolveOpenAIParseModel = (value?: string, baseUrl?: string) => {
    if (baseUrl?.trim() && value) return value;
    if (!value) return 'gpt-4o-mini';
    const lower = value.toLowerCase();
    if (lower.startsWith('gpt-5')) return 'gpt-4o-mini';
    return value;
};

const transcribeWhisper = async (audio: AudioInput, config: SpeechToTextConfig) => {
    if (!config.modelPath) {
        throw new Error('Whisper model path missing');
    }
    if (!audio.path) {
        throw new Error('Whisper requires a local audio path');
    }
    if (!isTauriRuntime()) {
        throw new Error('Whisper is only available in the desktop app');
    }
    const language = normalizeSpeechLanguage(config.language);
    const text = await invokeNative<string>('transcribe_whisper', {
        modelPath: config.modelPath,
        audioPath: audio.path,
        language: language === 'auto' ? null : language,
    });
    return normalizeLocalAsrTranscript(text);
};


const transcribeParakeet = async (audio: AudioInput, config: SpeechToTextConfig) => {
    if (!config.modelPath) {
        throw new Error('Parakeet model directory missing');
    }
    if (!audio.path) {
        throw new Error('Parakeet requires a local audio path');
    }
    if (!isTauriRuntime()) {
        throw new Error('Parakeet is only available in the desktop app');
    }
    const language = normalizeSpeechLanguage(config.language);
    const text = await invokeNative<string>('transcribe_parakeet', {
        modelPath: config.modelPath,
        audioPath: audio.path,
        language: language === 'auto' ? null : language,
    });
    return normalizeLocalAsrTranscript(text);
};


export const downloadWhisperModel = (model: string): Promise<string> => (
    invokeNative<string>('download_whisper_model', { model })
);


export const downloadParakeetModel = (model: string): Promise<string> => (
    invokeNative<string>('download_parakeet_model', { model })
);

export async function processAudioCapture(
    audio: AudioInput,
    config: SpeechToTextConfig
): Promise<SpeechToTextResult> {
    if (config.provider === 'openai' || config.provider === 'gemini') {
        const parseModel = resolveOpenAIParseModel(config.parseModel, config.baseUrl);
        const retryModel = config.baseUrl?.trim()
            ? config.retryModel ?? parseModel : resolveOpenAIParseModel(config.retryModel ?? 'gpt-4o-mini');
        return runRemoteSpeechToTaskCapture(
            { ...config, provider: config.provider, parseModel, retryModel },
            {
                readBytes: async () => ({
                    bytes: audio.bytes,
                    mimeType: audio.mimeType,
                }),
                withOpenAIUpload: async (send) => {
                    const bytes = new Uint8Array(audio.bytes);
                    const blob = new Blob([bytes], { type: audio.mimeType });
                    const fileName = audio.name || 'audio.wav';
                    const file = new File([blob], fileName, { type: audio.mimeType });
                    return send({ part: file });
                },
            },
            {
                onWarn: (message, error) => {
                    void logWarn(message, {
                        scope: 'speech',
                        extra: { error: error.message },
                    });
                },
            },
        );
    }
    return runSpeechToTaskCapture(config, {
        transcribe: () => {
            if (config.provider === 'whisper') {
                return transcribeWhisper(audio, config);
            }
            if (config.provider === 'parakeet') {
                return transcribeParakeet(audio, config);
            }
            throw new Error(`Unsupported local speech provider: ${config.provider}`);
        },
    });
}
