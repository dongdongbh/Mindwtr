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


export type SpeechProvider = 'openai' | 'gemini' | 'whisper';

export type SpeechToTextConfig = Omit<SpeechToTaskCaptureConfig, 'provider'> & {
    provider: SpeechProvider;
    apiKey?: string;
    model: string;
    parseModel?: string;
    modelPath?: string;
    isFossBuild?: boolean;

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

    baseUrl?: string;
    language?: string;
    mode: AudioCaptureMode;
    fieldStrategy: AudioFieldStrategy;
    isFossBuild: boolean;
};


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


    if (!value) return OPENAI_DEFAULT_MODEL;
    const lower = value.toLowerCase();
    if (lower.startsWith('gpt-4o')) return OPENAI_DEFAULT_MODEL;
    return value;
};

export type SpeechCapturePorts = {

    readBytes: () => Promise<{ bytes: Uint8Array; mimeType: string }>;

    withOpenAIUpload: <T>(send: (upload: OpenAISpeechUpload) => Promise<T>) => Promise<T>;

    transcribeLocal: () => Promise<string>;
    logWarn: SpeechLogWarn;

    fetcher?: typeof fetch;
};


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
}: {
    speechEnabled: boolean;
    provider: string;
    apiKey?: string;


    baseUrl?: string;

    whisperModelReady: boolean;
}) => {
    if (!speechEnabled) return false;
    if (provider === 'whisper') return whisperModelReady;
    if (provider === 'openai' && Boolean(baseUrl?.trim())) return true;
    return Boolean(apiKey);
};


export const resolveQuickCaptureAudioFormat = ({
    speechEnabled,
    provider,
    whisperModelReady,
}: {
    speechEnabled: boolean;
    provider: string;
    whisperModelReady: boolean;
}): 'wav' | 'm4a' => (speechEnabled && provider === 'whisper' && whisperModelReady ? 'wav' : 'm4a');


export const shouldSaveQuickCaptureAudio = (settings: Pick<AppSettings, 'gtd'> | null | undefined, canTranscribeSpeech: boolean): boolean =>
    settings?.gtd?.saveAudioAttachments !== false || !canTranscribeSpeech;


export const buildAudioNoteTitle = (
    label: string,
    now: Date,
    formatDate: (value: Date, pattern: string) => string = safeFormatDate,
): string => `${label} ${formatDate(now, 'Pp')}`;


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


export type QuickCaptureAudioStore = {
    getState: () => Pick<TaskStore, 'tasks' | 'projects' | 'settings' | 'addProject' | 'updateTask' | 'deleteTask'>;
};

export type SpeechApplyResult = 'applied' | 'empty' | 'skipped';


export async function applySpeechResult(
    taskId: string,
    result: SpeechToTaskResult,
    store: QuickCaptureAudioStore,
    options: { titleAtSave?: string } = {},
): Promise<SpeechApplyResult> {
    const { tasks: currentTasks, settings: currentSettings } = store.getState();
    const existing = currentTasks.find((task) => task.id === taskId);
    if (!existing) return 'skipped';

    const { updates, suggestedProjectTitle } = buildTaskUpdatesFromSpeechResult(existing, result, currentSettings);
    if (!Object.keys(updates).length && !suggestedProjectTitle) return 'empty';
    let outcome: SpeechApplyResult = 'applied';


    await runStoreCommand(async () => {
        const state = store.getState();
        const latest = state.tasks.find((task) => task.id === taskId);
        if (!latest) return;
        const plan = buildTaskUpdatesFromSpeechResult(latest, result, state.settings);
        const rebuilt = plan.updates;
        if (options.titleAtSave !== undefined && latest.title !== options.titleAtSave) delete rebuilt.title;
        if (plan.suggestedProjectTitle && !latest.projectId) {
            const targetAreaId = rebuilt.areaId ?? latest.areaId;
            const match = findSelectableProjectByTitleAndArea(state.projects, plan.suggestedProjectTitle, targetAreaId);
            if (match) {
                rebuilt.projectId = match.id;
            } else {
                const created = await state.addProject(
                    plan.suggestedProjectTitle,
                    DEFAULT_PROJECT_COLOR,
                    targetAreaId ? { areaId: targetAreaId } : undefined
                );
                if (!created) {
                    outcome = 'skipped';
                    return;
                }
                rebuilt.projectId = created.id;
            }
        }
        if (Object.keys(rebuilt).length) await state.updateTask(taskId, rebuilt);
    });
    return outcome;
}


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
