import {
    getSelectedMobileWhisperModel,
    normalizeSpeechLanguage,
    WHISPER_MODEL_BASE_URLS,
    type ResolvedSpeechToTextRuntimeSettings,
} from '@mindwtr/core';


export type WhisperCall = (request: Record<string, unknown>) => Promise<unknown>;

export type WhisperLine = {
    stage: 'download' | 'delete' | 'transcribe';
    outcome: 'model-ready' | 'deleted' | 'transcribed' | 'empty' | 'failed';
    reason?: string;
    repaired?: boolean;
    ms?: number;
};

export type WhisperLocation = { exists: boolean; uri: string; size: number };

type WhisperRuntime = Pick<ResolvedSpeechToTextRuntimeSettings, 'model' | 'modelPath' | 'language'>;

const reasonOf = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    return /^E_[A-Z0-9_]+$/.test(message) ? message : 'E_WHISPER_FAILED';
};

export function createNativeWhisper(bindings: { call: WhisperCall; documentDirectory: string; log: (line: WhisperLine) => void;
    rememberPath: (modelId: string, uri: string | undefined) => Promise<void>; now?: () => number }) {
    const now = bindings.now ?? Date.now;
    const documents = bindings.documentDirectory.endsWith('/') ? bindings.documentDirectory : `${bindings.documentDirectory}/`;
    const modelOf = (modelId: string | undefined) => getSelectedMobileWhisperModel(modelId ?? '')!;

    const locate = async (modelId: string, storedPath: string | undefined): Promise<WhisperLocation> => (
        await bindings.call({ op: 'whisperLocate', fileName: modelOf(modelId).fileName, sizeBytes: modelOf(modelId).sizeBytes,
            ...(storedPath ? { storedPath } : {}) }) as WhisperLocation
    );

    return {
        preferredModelUri: (modelId: string) => `${documents}whisper-models/${modelOf(modelId).fileName}`,
        locate,

        async ready(runtime: WhisperRuntime): Promise<boolean> {
            const found = await locate(runtime.model, runtime.modelPath).catch(() => null);
            return Boolean(found?.exists && found.size === modelOf(runtime.model).sizeBytes);
        },

        async transcribe(uri: string, runtime: WhisperRuntime): Promise<string> {
            const model = modelOf(runtime.model);
            const language = normalizeSpeechLanguage(runtime.language);
            const started = now();
            try {
                const text = await bindings.call({
                    op: 'whisperTranscribe', uri, fileName: model.fileName, sizeBytes: model.sizeBytes,
                    language: model.id.endsWith('.en') && language === 'auto' ? 'en' : language,
                    ...(runtime.modelPath ? { storedPath: runtime.modelPath } : {}),
                }) as string;
                bindings.log({ stage: 'transcribe', outcome: text ? 'transcribed' : 'empty', ms: now() - started });
                return text;
            } catch (error) {
                bindings.log({ stage: 'transcribe', outcome: 'failed', reason: reasonOf(error), ms: now() - started });
                throw error;
            }
        },

        async download(modelId: string): Promise<WhisperLocation> {
            const model = modelOf(modelId);
            try {
                const found = await bindings.call({ op: 'whisperDownload', fileName: model.fileName, sizeBytes: model.sizeBytes, sha256: model.sha256,
                    urls: WHISPER_MODEL_BASE_URLS.map((root) => `${root}/${model.fileName}`) }) as WhisperLocation & { repaired: boolean };
                bindings.log({ stage: 'download', outcome: 'model-ready', ...(found.repaired ? { repaired: true } : {}) });
                await bindings.rememberPath(model.id, found.uri);
                return { exists: found.exists, uri: found.uri, size: found.size };
            } catch (error) {
                bindings.log({ stage: 'download', outcome: 'failed', reason: reasonOf(error) });
                throw error;
            }
        },

        async remove(modelId: string): Promise<void> {
            try {
                await bindings.call({ op: 'whisperDelete', fileName: modelOf(modelId).fileName });
                bindings.log({ stage: 'delete', outcome: 'deleted' });
                await bindings.rememberPath(modelOf(modelId).id, undefined);
            } catch (error) {
                bindings.log({ stage: 'delete', outcome: 'failed', reason: reasonOf(error) });
                throw error;
            }
        },
    };
}

export type NativeWhisper = ReturnType<typeof createNativeWhisper>;
