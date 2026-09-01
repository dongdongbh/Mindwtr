import { join } from '@tauri-apps/api/path';
import { mkdir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { generateUUID } from '@mindwtr/core';

import { logWarn } from './app-log';
import { appendAudioChunkWithLimit, getMaxAudioSamples } from './audio-capture-buffer';
import { getPreferredDesktopAudioCaptureBackend, type DesktopAudioCaptureBackend } from './audio-capture-backend';
import { encodeWav, resampleAudio } from './audio-utils';
import { getManagedPath } from './managed-paths';
import { isFlatpakRuntime, isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';

// Relative to the managed data dir (portable-aware, #855).
const AUDIO_CAPTURE_DIR = 'audio-captures';
const TARGET_SAMPLE_RATE = 16_000;

/** Mirrors the Rust `AudioCaptureResult` returned by `stop_audio_recording`. */
type NativeAudioCaptureResult = {
    path: string;
    sampleRate: number;
    channels: number;
    size: number;
};

export type AudioCaptureFailureReason =
    /** No recorder is available at all (no getUserMedia, no AudioContext). */
    | 'unsupported'
    /** A recorder exists but the machine has no audio input device. */
    | 'no-microphone'
    /** Permission denied, device busy, or any other start failure. */
    | 'failed';

export class AudioCaptureError extends Error {
    readonly reason: AudioCaptureFailureReason;

    constructor(reason: AudioCaptureFailureReason, message: string) {
        super(message);
        this.name = 'AudioCaptureError';
        this.reason = reason;
    }
}

export type AudioCapture = {
    /** Absolute path of the captured WAV on disk. */
    path: string;
    name: string;
    mimeType: 'audio/wav';
    /** Byte length, when the backend reported one. */
    size?: number;
    /**
     * Reads the captured audio. Memoised — callers that both attach and
     * transcribe do not pay for a second read, and callers that only attach
     * never read at all.
     */
    bytes: () => Promise<Uint8Array>;
};

export type AudioCaptureSession = {
    backend: DesktopAudioCaptureBackend;
    /** Ends the recording and materialises the WAV. */
    stop: () => Promise<AudioCapture>;
    /** Ends the recording and deletes anything it wrote. Never rejects. */
    cancel: () => Promise<void>;
};

const memoiseBytes = (read: () => Promise<Uint8Array>): (() => Promise<Uint8Array>) => {
    let pending: Promise<Uint8Array> | null = null;
    return () => {
        pending ??= read();
        return pending;
    };
};

const readWavFile = async (path: string): Promise<Uint8Array> => {
    const bytes = await readFile(path);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
};

const removeQuietly = async (path: string): Promise<void> => {
    try {
        await remove(path);
    } catch (error) {
        void logWarn('Audio cleanup failed', {
            scope: 'audio',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
};

const fileNameFromPath = (path: string): string => {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || 'mindwtr-audio.wav';
};

const startNativeCapture = async (): Promise<AudioCaptureSession> => {
    await invokeNative('start_audio_recording');
    const stopNative = () => invokeNative<NativeAudioCaptureResult>('stop_audio_recording');
    return {
        backend: 'native',
        stop: async () => {
            const result = await stopNative();
            return {
                path: result.path,
                name: fileNameFromPath(result.path),
                mimeType: 'audio/wav',
                size: result.size,
                bytes: memoiseBytes(() => readWavFile(result.path)),
            };
        },
        cancel: async () => {
            try {
                const result = await stopNative();
                if (result.path) await removeQuietly(result.path);
            } catch (error) {
                void logWarn('Native audio cancel failed', {
                    scope: 'audio',
                    extra: { error: error instanceof Error ? error.message : String(error) },
                });
            }
        },
    };
};

const startWebCapture = async (
    timestampedName: () => string,
    isCurrent: () => boolean,
): Promise<AudioCaptureSession> => {
    if (!isCurrent()) throw new Error('Audio capture start was cancelled');
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new AudioCaptureError('unsupported', 'Audio capture is unavailable.');
    }
    if (navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!isCurrent()) throw new Error('Audio capture start was cancelled');
        if (!devices.some((device) => device.kind === 'audioinput')) {
            throw new AudioCaptureError('no-microphone', 'No microphone detected');
        }
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('Audio capture start was cancelled');
    }
    const AudioContextConstructor = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
        stream.getTracks().forEach((track) => track.stop());
        throw new AudioCaptureError('unsupported', 'AudioContext unavailable');
    }

    const context = new AudioContextConstructor();
    await context.resume();
    if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop());
        if (context.state !== 'closed') await context.close();
        throw new Error('Audio capture start was cancelled');
    }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const zeroGain = context.createGain();
    zeroGain.gain.value = 0;

    const inputSampleRate = context.sampleRate;
    let chunks: Float32Array[] = [];
    let sampleCount = 0;
    let limitHit = false;
    processor.onaudioprocess = (event) => {
        if (limitHit) return;
        const result = appendAudioChunkWithLimit({
            chunks,
            chunk: event.inputBuffer.getChannelData(0),
            maxSamples: getMaxAudioSamples(inputSampleRate),
            sampleCount,
        });
        sampleCount = result.sampleCount;
        limitHit = result.limitHit;
    };
    source.connect(processor);
    processor.connect(zeroGain);
    zeroGain.connect(context.destination);

    const teardown = async (): Promise<Float32Array[]> => {
        if (context.state === 'running') {
            // Suspending the graph gives ScriptProcessorNode one stable stop point before teardown.
            await context.suspend();
        }
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        if (context.state !== 'closed') {
            await context.close();
        }
        const captured = chunks;
        chunks = [];
        sampleCount = 0;
        limitHit = false;
        return captured;
    };

    return {
        backend: 'web',
        stop: async () => {
            const captured = await teardown();
            if (!captured.length) {
                throw new Error('No audio data captured');
            }
            const totalLength = captured.reduce((sum, chunk) => sum + chunk.length, 0);
            const buffer = new Float32Array(totalLength);
            let offset = 0;
            for (const chunk of captured) {
                buffer.set(chunk, offset);
                offset += chunk.length;
            }
            const wavBytes = encodeWav(resampleAudio(buffer, inputSampleRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);

            const name = timestampedName();
            const audioCaptureDir = await getManagedPath(AUDIO_CAPTURE_DIR);
            await mkdir(audioCaptureDir, { recursive: true });
            const path = await join(audioCaptureDir, name);
            await writeFile(path, wavBytes);

            return {
                path,
                name,
                mimeType: 'audio/wav',
                size: wavBytes.length,
                bytes: async () => wavBytes,
            };
        },
        // Nothing has been written yet on the web path, so dropping the buffer is the whole cleanup.
        cancel: async () => {
            await teardown();
        },
    };
};

/**
 * Starts a desktop audio capture, preferring the native recorder and falling
 * back to the in-page MediaRecorder graph when it is unavailable — the same
 * fallback both capture surfaces need, so neither hard-fails outside Tauri.
 */
export async function startAudioCapture(
    options: { defaultName?: () => string; isCurrent?: () => boolean } = {},
): Promise<AudioCaptureSession> {
    const timestampedName = options.defaultName
        ?? (() => `mindwtr-audio-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${generateUUID()}.wav`);
    const isCurrent = options.isCurrent ?? (() => true);

    if (!isCurrent()) throw new Error('Audio capture start was cancelled');

    const preferredBackend = getPreferredDesktopAudioCaptureBackend({
        isTauriRuntime: isTauriRuntime(),
        isFlatpakRuntime: isFlatpakRuntime(),
    });

    if (preferredBackend === 'native') {
        try {
            return await startNativeCapture();
        } catch (error) {
            if (!isCurrent()) throw error;
            void logWarn('Native audio recording failed, falling back to web capture', {
                scope: 'audio',
                extra: {
                    error: error instanceof Error ? error.message : String(error),
                    preferredBackend,
                },
            });
        }
    }

    return startWebCapture(timestampedName, isCurrent);
}
