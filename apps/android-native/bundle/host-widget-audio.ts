import {
    ANDROID_QUICK_CAPTURE_SOURCE,
    DEFAULT_GEMINI_STT_MODEL,
    runRemoteSpeechToTaskCapture,
    type AIProviderId,
    type AppData,
    type PendingAudioCapture,
    type PendingCaptureAudioPort,
} from '@mindwtr/core';

/**
 * The home-screen widget's queued recordings on this host (core's ingestPendingAudio): RN's audio port
 * (apps/mobile/lib/pending-captures.ts resolveSafeAndroidQuickCaptureAudioPath, apps/mobile/lib/watch-audio.ts
 * transcribePendingAudio). A recording becomes a task only once it has a transcript; with none it stays queued, as in RN.
 * This host reaches Gemini (JSON with inline audio over the polyfill's fetch). OpenAI and OpenAI-compatible servers need a
 * multipart upload and local Whisper needs whisper.cpp; both come with the voice capture passes (V3, V4), so they answer no
 * transcript yet and the recording waits.
 */
export type WidgetAudioBindings = {
    /** expo-file-system's documentDirectory form of the app's files folder: `file:///…/files/`. */
    documentDirectory: string;
    /** A recording's bytes (the attachment file port's readBytes). */
    readBytes: (uri: string) => Promise<Uint8Array>;
    /** Deletes `files/<path>` (HostFiles.delete); a file already gone is no error. */
    deleteFile: (path: string) => void;
    /** RN's loadAIKey: the provider's key from SecureStore, '' when none. */
    loadKey: (provider: AIProviderId) => Promise<string>;
    isFossBuild: boolean;
    fetcher?: typeof fetch;
    /** One line per recording that waits, with its outcome only (never audio or transcript text). */
    logWaiting: (outcome: 'not-configured' | 'provider-unsupported' | 'empty' | 'failed') => void;
};

const AUDIO_DIRECTORY = 'quick-capture-audio';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function createWidgetAudioPort(bindings: WidgetAudioBindings): PendingCaptureAudioPort {
    const documents = bindings.documentDirectory.endsWith('/') ? bindings.documentDirectory : `${bindings.documentDirectory}/`;
    const owned = (id: string) => `${documents}${AUDIO_DIRECTORY}/${id}.wav`;
    return {
        // Only the widget's own recording for this capture's UUID, as its writer names it (PendingCaptureWriter.kt).
        resolvePath: (capture: PendingAudioCapture) => (
            capture.source === ANDROID_QUICK_CAPTURE_SOURCE && UUID.test(capture.id) && capture.audioPath === owned(capture.id)
                ? owned(capture.id) : null
        ),
        delete: async (audioPath: string) => {
            if (!audioPath.startsWith(`${documents}${AUDIO_DIRECTORY}/`)) return;
            bindings.deleteFile(`files/${audioPath.slice(documents.length)}`);
        },
        transcribe: async (audioPath: string, settings: AppData['settings']) => {
            // RN's resolveSpeechToTextRuntimeSettings and transcribePendingAudio.
            const speech = settings.ai?.speechToText;
            const provider = bindings.isFossBuild ? 'whisper' : speech?.provider ?? 'gemini';
            const enabled = speech?.enabled === true && provider !== 'parakeet';
            if (!enabled) { bindings.logWaiting('not-configured'); return null; }
            if (provider !== 'gemini') { bindings.logWaiting('provider-unsupported'); return null; }
            const apiKey = await bindings.loadKey('gemini').catch(() => '');
            if (!apiKey) { bindings.logWaiting('not-configured'); return null; }
            let transcript: string | undefined;
            try {
                const result = await runRemoteSpeechToTaskCapture({
                    provider: 'gemini',
                    apiKey,
                    model: speech?.model || DEFAULT_GEMINI_STT_MODEL,
                    language: speech?.language,
                    mode: speech?.mode ?? 'smart_parse',
                    fieldStrategy: speech?.fieldStrategy ?? 'smart',
                    now: new Date(),
                }, {
                    readBytes: async () => ({ bytes: await bindings.readBytes(audioPath), mimeType: 'audio/wav' }),
                }, bindings.fetcher ? { fetcher: bindings.fetcher } : {});
                transcript = result.transcript?.trim();
            } catch (error) {
                // Core keeps the item and its recording for a later run; the error's text may hold the provider's answer.
                bindings.logWaiting('failed');
                throw error;
            }
            if (!transcript) { bindings.logWaiting('empty'); return null; }
            return transcript;
        },
    };
}
