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


export type WidgetAudioBindings = {

    documentDirectory: string;

    readBytes: (uri: string) => Promise<Uint8Array>;

    deleteFile: (path: string) => void;

    loadKey: (provider: AIProviderId) => Promise<string>;
    isFossBuild: boolean;
    fetcher?: typeof fetch;

    logWaiting: (outcome: 'not-configured' | 'provider-unsupported' | 'empty' | 'failed') => void;
};

const AUDIO_DIRECTORY = 'quick-capture-audio';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function createWidgetAudioPort(bindings: WidgetAudioBindings): PendingCaptureAudioPort {
    const documents = bindings.documentDirectory.endsWith('/') ? bindings.documentDirectory : `${bindings.documentDirectory}/`;
    const owned = (id: string) => `${documents}${AUDIO_DIRECTORY}/${id}.wav`;
    return {

        resolvePath: (capture: PendingAudioCapture) => (
            capture.source === ANDROID_QUICK_CAPTURE_SOURCE && UUID.test(capture.id) && capture.audioPath === owned(capture.id)
                ? owned(capture.id) : null
        ),
        delete: async (audioPath: string) => {
            if (!audioPath.startsWith(`${documents}${AUDIO_DIRECTORY}/`)) return;
            bindings.deleteFile(`files/${audioPath.slice(documents.length)}`);
        },
        transcribe: async (audioPath: string, settings: AppData['settings']) => {

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

                bindings.logWaiting('failed');
                throw error;
            }
            if (!transcript) { bindings.logWaiting('empty'); return null; }
            return transcript;
        },
    };
}
