import type { AudioCaptureMode, AudioFieldStrategy } from './ai/types';
import { OPENAI_DEFAULT_MODEL } from './ai/catalog';
import { DEFAULT_GEMINI_STT_MODEL, DEFAULT_OPENAI_STT_MODEL } from './ai-settings-model';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { safeFormatDate } from './date';
import { findSelectableProjectByTitleAndArea } from './project-utils';
import {
    runRemoteSpeechToTaskCapture,
    runSpeechToTaskCapture,
    type OpenAISpeechUpload,
    type SpeechToTaskCaptureConfig,
    type SpeechToTaskResult,
} from './speech-to-task';
import { runStoreCommand } from './store-write-gate';
import { buildTaskUpdatesFromSpeechResult } from './task-speech';
import type { TaskStore } from './store-types';
import type { AppSettings, Attachment, SpeechToTextSettings } from './types';
import { generateUUID } from './uuid';

// RN's voice capture rules without React, Expo or whisper.rn (apps/mobile use-quick-capture-audio.ts and speech-to-text.ts
// import them from here; the native app binds the same ports). Each port is what RN passes in: its store, its file delete, its
// logger, its clock format and id, so RN's tests still pin them.

export type SpeechProvider = 'openai' | 'gemini' | 'whisper';

export type SpeechToTextConfig = Omit<SpeechToTaskCaptureConfig, 'provider'> & {
    provider: SpeechProvider;
    apiKey?: string;
    model: string;
    parseModel?: string;
    modelPath?: string;
    isFossBuild?: boolean;
    // Only meaningful for provider 'openai' — see resolveOpenAITranscribeEndpoint.
    baseUrl?: string;
};

const DEFAULT_WHISPER_STT_MODEL = 'whisper-tiny';
const WHISPER_STT_MODEL_IDS = new Set([
    'whisper-tiny',
    'whisper-tiny.en',
    'whisper-base',
    'whisper-base.en',
]);
export const REMOTE_SPEECH_TO_TEXT_FOSS_ERROR =
    'Remote speech-to-text is not available in FOSS builds.';

const getDefaultSpeechModel = (provider: SpeechProvider): string => {
    if (provider === 'openai') return DEFAULT_OPENAI_STT_MODEL;
    if (provider === 'gemini') return DEFAULT_GEMINI_STT_MODEL;
    return DEFAULT_WHISPER_STT_MODEL;
};

const normalizeSpeechProviderForRuntime = (
    provider: SpeechToTextSettings['provider'] | undefined,
    fossBuild: boolean
): { provider: SpeechProvider; enabledProvider: boolean } => {
    if (fossBuild) return { provider: 'whisper', enabledProvider: true };
    if (!provider) return { provider: 'gemini', enabledProvider: true };
    if (provider === 'parakeet') return { provider: 'whisper', enabledProvider: false };
    return { provider, enabledProvider: true };
};

const normalizeSpeechModelForRuntime = (model: string | undefined, provider: SpeechProvider): string => {
    if (model && (provider !== 'whisper' || WHISPER_STT_MODEL_IDS.has(model))) return model;
    return getDefaultSpeechModel(provider);
};

export type ResolvedSpeechToTextRuntimeSettings = {
    provider: SpeechProvider;
    enabled: boolean;
    model: string;
    modelPath?: string;
    // Only set for provider 'openai' — see resolveOpenAITranscribeEndpoint.
    baseUrl?: string;
    language?: string;
    mode: AudioCaptureMode;
    fieldStrategy: AudioFieldStrategy;
    isFossBuild: boolean;
};

/** The speech settings a capture runs with; a FOSS build always runs local Whisper (RN reads [isFossBuild] from Expo). */
export const resolveSpeechToTextRuntimeSettings = (
    speech: SpeechToTextSettings | undefined,
    options: { isFossBuild: boolean }
): ResolvedSpeechToTextRuntimeSettings => {
    const fossBuild = options.isFossBuild;
    const normalized = normalizeSpeechProviderForRuntime(speech?.provider, fossBuild);
    const model = normalizeSpeechModelForRuntime(speech?.model, normalized.provider);
    return {
        provider: normalized.provider,
        enabled: speech?.enabled === true && normalized.enabledProvider,
        model,
        modelPath: normalized.provider === 'whisper' ? speech?.offlineModelPath : undefined,
        baseUrl: normalized.provider === 'openai' ? (speech?.baseUrl?.trim() || undefined) : undefined,
        language: speech?.language,
        mode: speech?.mode ?? 'smart_parse',
        fieldStrategy: speech?.fieldStrategy ?? 'smart',
        isFossBuild: fossBuild,
    };
};

/** RN's app-log logWarn, as the dispatch calls it. */
export type SpeechLogWarn = (message: string, options: { scope: string; force?: boolean; extra?: Record<string, string> }) => unknown;

const assertSpeechProviderAllowedForRuntime = (provider: SpeechProvider, fossBuild: boolean, logWarn: SpeechLogWarn): void => {
    if (!fossBuild || provider === 'whisper') return;
    void logWarn('Remote speech-to-text blocked in FOSS build', {
        scope: 'speech',
        force: true,
        extra: { provider },
    });
    throw new Error(REMOTE_SPEECH_TO_TEXT_FOSS_ERROR);
};

const resolveOpenAIParseModel = (value?: string) => {
    // The transcript parse step wants a cheap fast model; gpt-4o-mini (the old
    // choice) is retiring, so route to the current cost-efficient default.
    if (!value) return OPENAI_DEFAULT_MODEL;
    const lower = value.toLowerCase();
    if (lower.startsWith('gpt-4o')) return OPENAI_DEFAULT_MODEL;
    return value;
};

export type SpeechCapturePorts = {
    /** The recording's bytes and type, for Gemini and OpenAI. */
    readBytes: () => Promise<{ bytes: Uint8Array; mimeType: string }>;
    /** OpenAI's multipart upload of the recording. */
    withOpenAIUpload: <T>(send: (upload: OpenAISpeechUpload) => Promise<T>) => Promise<T>;
    /** Local Whisper's transcript of the recording. */
    transcribeLocal: () => Promise<string>;
    logWarn: SpeechLogWarn;
    /** The cloud providers' fetch; the global one when unset (RN). */
    fetcher?: typeof fetch;
};

/**
 * RN's provider dispatch (processAudioCapture): a FOSS build refuses a cloud provider; Gemini and OpenAI transcribe remotely
 * (core's runRemoteSpeechToTaskCapture), Whisper on the device. [isFossBuild] is the build's, resolved by the caller.
 */
export async function dispatchSpeechCapture(
    config: SpeechToTextConfig,
    isFossBuild: boolean,
    ports: SpeechCapturePorts
): Promise<SpeechToTaskResult> {
    assertSpeechProviderAllowedForRuntime(config.provider, isFossBuild, ports.logWarn);
    if (config.provider === 'openai' || config.provider === 'gemini') {
        const parseModel = resolveOpenAIParseModel(config.parseModel);
        const retryModel = resolveOpenAIParseModel(config.retryModel ?? 'gpt-4o-mini');
        return runRemoteSpeechToTaskCapture(
            { ...config, provider: config.provider, parseModel, retryModel },
            {
                readBytes: ports.readBytes,
                withOpenAIUpload: ports.withOpenAIUpload,
            },
            {
                ...(ports.fetcher ? { fetcher: ports.fetcher } : {}),
                onWarn: (message, error) => {
                    void ports.logWarn(message, {
                        scope: 'speech',
                        extra: { error: error.message },
                    });
                },
            }
        );
    }
    return runSpeechToTaskCapture(config, { transcribe: ports.transcribeLocal });
}

// ---- The quick-capture rules (RN's use-quick-capture-audio.ts) ----

/**
 * A recording's mime type by its extension (with the dot, any case): one table for the capture attachment and the speech upload,
 * which disagreed on .webm (RN voice bug 3). Anything else is m4a's.
 */
export const getAudioMimeType = (extension: string): string => {
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

export const isQuickCaptureSpeechReady = ({
    speechEnabled,
    provider,
    apiKey,
    baseUrl,
    whisperModelReady,
    whisperModelPath,
}: {
    speechEnabled: boolean;
    provider: string;
    apiKey?: string;
    // Only meaningful for provider 'openai': a self-hosted OpenAI-compatible
    // server (#930) substitutes for a key.
    baseUrl?: string;
    whisperModelReady: boolean;
    whisperModelPath?: string;
}) => {
    if (!speechEnabled) return false;
    if (provider === 'whisper') return whisperModelReady || Boolean(whisperModelPath?.trim());
    if (provider === 'openai' && Boolean(baseUrl?.trim())) return true;
    return Boolean(apiKey);
};

/**
 * RN's recording format (decision Q1): Whisper with a ready model records 16 kHz WAV (whisper.rn's PCM recorder, transcribed
 * on the device); every other capture records expo-audio's HIGH_QUALITY preset, m4a/AAC, for the cloud providers.
 */
export const resolveQuickCaptureAudioFormat = ({
    speechEnabled,
    provider,
    whisperModelReady,
}: {
    speechEnabled: boolean;
    provider: string;
    whisperModelReady: boolean;
}): 'wav' | 'm4a' => (speechEnabled && provider === 'whisper' && whisperModelReady ? 'wav' : 'm4a');

/** Whether the recording stays on the task: Settings › GTD's "save audio" unless off, and always when nothing can transcribe it. */
export const shouldSaveQuickCaptureAudio = (settings: Pick<AppSettings, 'gtd'> | null | undefined, canTranscribeSpeech: boolean): boolean =>
    settings?.gtd?.saveAudioAttachments !== false || !canTranscribeSpeech;

/** The task's title until a transcript replaces it: "Audio note" and the local time ([label] is quickAdd.audioNoteTitle). */
export const buildAudioNoteTitle = (
    label: string,
    now: Date,
    formatDate: (value: Date, pattern: string) => string = safeFormatDate,
): string => `${label} ${formatDate(now, 'Pp')}`;

/**
 * The recording as the task's attachment, also kept for recovery while the task saves. [size] is set (even undefined) only
 * when the caller read it: RN's Whisper path reads it here, its m4a path once the file moved.
 */
export const buildQuickCaptureAudioAttachment = (input: {
    title: string;
    uri: string;
    mimeType: string;
    now: Date;
    size?: number;
    newId?: () => string;
}): Attachment => {
    const nowIso = input.now.toISOString();
    return {
        id: (input.newId ?? generateUUID)(),
        kind: 'file',
        title: input.title,
        uri: input.uri,
        mimeType: input.mimeType,
        ...('size' in input ? { size: input.size } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
        localStatus: 'available',
    };
};

/** The store a speech result writes to: core's useTaskStore (RN passes its own, so its tests can stand one in). */
export type QuickCaptureAudioStore = {
    getState: () => Pick<TaskStore, 'tasks' | 'projects' | 'settings' | 'addProject' | 'updateTask' | 'deleteTask'>;
};

export type SpeechApplyResult = 'applied' | 'empty' | 'skipped';

/**
 * A transcript's fields on the saved task: its suggested project matched by title in the task's area (or made), then one store
 * command that builds the updates again on the task as stored then (a sync save admitted first may publish newer tags).
 */
export async function applySpeechResult(
    taskId: string,
    result: SpeechToTaskResult,
    store: QuickCaptureAudioStore,
): Promise<SpeechApplyResult> {
    const { tasks: currentTasks, projects: currentProjects, addProject: addProjectNow, settings: currentSettings } = store.getState();
    const existing = currentTasks.find((task) => task.id === taskId);
    if (!existing) return 'skipped';

    const { updates, suggestedProjectTitle } = buildTaskUpdatesFromSpeechResult(existing, result, currentSettings);
    if (suggestedProjectTitle && !existing.projectId) {
        const targetAreaId = updates.areaId ?? existing.areaId;
        const match = findSelectableProjectByTitleAndArea(currentProjects, suggestedProjectTitle, targetAreaId);
        if (match) {
            updates.projectId = match.id;
        } else {
            const created = await addProjectNow(
                suggestedProjectTitle,
                DEFAULT_PROJECT_COLOR,
                targetAreaId ? { areaId: targetAreaId } : undefined
            );
            if (!created) return 'skipped';
            updates.projectId = created.id;
        }
    }

    if (!Object.keys(updates).length) return 'empty';
    // Built again on the task as stored when the write is admitted: a sync save admitted first may publish newer tags.
    await runStoreCommand(async () => {
        const state = store.getState();
        const latest = state.tasks.find((task) => task.id === taskId);
        if (!latest) return;
        const rebuilt = buildTaskUpdatesFromSpeechResult(latest, result, state.settings).updates;
        if (updates.projectId && !latest.projectId) rebuilt.projectId = updates.projectId;
        if (Object.keys(rebuilt).length) await state.updateTask(taskId, rebuilt);
    });
    return 'applied';
}

/** An empty transcript: the task goes, then each of its recording files once ([deleteFile] keeps RN's safe-delete rules). */
export async function discardEmptySpeechTask<F extends { uri?: string | null }>(
    taskId: string,
    files: (F | null | undefined)[],
    reason: string,
    deps: {
        store: QuickCaptureAudioStore;
        deleteFile: (file: F, reason: string) => void;
        onWarn: (message: string, error?: unknown) => void;
    },
): Promise<void> {
    try {
        await deps.store.getState().deleteTask(taskId);
    } catch (error) {
        deps.onWarn('Failed to discard empty speech task', error);
    }
    const seen = new Set<string>();
    for (const file of files) {
        const uri = file?.uri ?? '';
        if (!file || !uri || seen.has(uri)) continue;
        seen.add(uri);
        deps.deleteFile(file, reason);
    }
}
