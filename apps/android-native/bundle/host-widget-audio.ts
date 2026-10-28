import {
    ANDROID_QUICK_CAPTURE_SOURCE,
    dispatchSpeechCapture,
    resolveSpeechToTextRuntimeSettings,
    type AIProviderId,
    type AppData,
    type PendingAudioCapture,
    type PendingCaptureAudioPort,
} from '@mindwtr/core';
import { createNativeSpeechPorts, speechConfigFor } from './host-voice';

/**
 * The home-screen widget's queued recordings on this host (core's ingestPendingAudio): RN's audio port
 * (apps/mobile/lib/pending-captures.ts resolveSafeAndroidQuickCaptureAudioPath, apps/mobile/lib/watch-audio.ts
 * transcribePendingAudio). A recording becomes a task only once it has a transcript; with none it stays queued, as in RN.
 * The provider is core's (resolveSpeechToTextRuntimeSettings) and so is the dispatch: Gemini, OpenAI and OpenAI-compatible
 * servers over the polyfill's fetch (OpenAI's multipart through its FormData). Local Whisper needs whisper.cpp (voice pass V4),
 * so a Whisper recording answers no transcript yet and waits.
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
            // RN's transcribePendingAudio over core's resolver: FOSS forces Whisper, Parakeet is off, no provider means Gemini.
            const runtime = resolveSpeechToTextRuntimeSettings(settings.ai?.speechToText, { isFossBuild: bindings.isFossBuild });
            if (!runtime.enabled) { bindings.logWaiting('not-configured'); return null; }
            if (runtime.provider === 'whisper') { bindings.logWaiting('provider-unsupported'); return null; }
            const apiKey = await bindings.loadKey(runtime.provider).catch(() => '');
            if (!apiKey && !runtime.baseUrl) { bindings.logWaiting('not-configured'); return null; }
            let transcript: string | undefined;
            try {
                const ports = { ...createNativeSpeechPorts(bindings, audioPath, 'audio/wav', () => undefined),
                    ...(bindings.fetcher ? { fetcher: bindings.fetcher } : {}) };
                const result = await dispatchSpeechCapture(speechConfigFor(runtime, apiKey, settings, new Date()), runtime.isFossBuild, ports);
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
