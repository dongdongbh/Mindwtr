import { describe, expect, it } from 'vitest';
import {
    buildCaptureDirectoryUri,
    buildCaptureExtra,
    buildCaptureFileUri,
    getCaptureFileExtension,
    getCaptureMimeType,
    selectExistingCaptureFile,
    selectQuickCaptureSettings,
} from './quick-capture-sheet.utils';

describe('quick-capture utils', () => {
    it('extracts file extension with fallback', () => {
        expect(getCaptureFileExtension('/tmp/clip.wav')).toBe('.wav');
        expect(getCaptureFileExtension('/tmp/clip')).toBe('.m4a');
    });

    it('maps mime types for supported extensions', () => {
        expect(getCaptureMimeType('.wav')).toBe('audio/wav');
        expect(getCaptureMimeType('.mp3')).toBe('audio/mpeg');
        expect(getCaptureMimeType('.unknown')).toBe('audio/mp4');
        // RN voice bug 3: the speech upload names .webm audio/webm; the attachment says the same.
        expect(getCaptureMimeType('.webm')).toBe('audio/webm');
    });

    it('builds managed capture directory URIs below the root directory', () => {
        expect(buildCaptureDirectoryUri('file:///document/', 'audio-captures'))
            .toBe('file:///document/audio-captures');
        expect(buildCaptureDirectoryUri('file:///document', 'audio-captures'))
            .toBe('file:///document/audio-captures');
    });

    it('builds capture file URIs inside the target directory', () => {
        expect(buildCaptureFileUri('file:///document/audio-captures', 'mindwtr-audio.m4a'))
            .toBe('file:///document/audio-captures/mindwtr-audio.m4a');
        expect(buildCaptureFileUri('file:///document/audio-captures/', 'mindwtr-audio.wav'))
            .toBe('file:///document/audio-captures/mindwtr-audio.wav');
    });

    it('selects the first existing capture file and skips missing candidates', () => {
        const missingDestination = {
            uri: 'file:///document/mindwtr-audio.m4a',
            info: () => ({ exists: false, size: 0 }),
        };
        const originalSource = {
            uri: 'file:///cache/ExpoAudio/recording.m4a',
            info: () => ({ exists: true, size: 105614 }),
        };

        expect(selectExistingCaptureFile([missingDestination, originalSource])).toMatchObject({
            file: originalSource,
            info: { exists: true, size: 105614 },
        });
    });

    it('returns null when every capture file candidate is missing or invalid', () => {
        const missingDestination = {
            uri: 'file:///document/mindwtr-audio.m4a',
            info: () => ({ exists: false, size: 0 }),
        };
        const directoryCandidate = {
            uri: 'file:///document/audio-captures',
            info: () => ({ exists: true, isDirectory: true, size: 0 }),
        };
        const throwingCandidate = {
            uri: 'file:///cache/ExpoAudio/recording.m4a',
            info: () => { throw new Error('missing'); },
        };

        expect(selectExistingCaptureFile([missingDestination, directoryCandidate, throwingCandidate])).toBeNull();
    });

    it('builds structured capture error metadata', () => {
        const error = new Error('boom');
        const extra = buildCaptureExtra('Failed capture', error);
        expect(extra).toMatchObject({
            message: 'Failed capture',
            error: 'boom',
        });
        expect(buildCaptureExtra()).toBeUndefined();
    });

    it('uses the latest store speech settings over a stale capture snapshot', () => {
        const staleSettings = {
            ai: {
                speechToText: {
                    provider: 'whisper',
                    model: 'whisper-tiny.en',
                    offlineModelPath: 'file:///document/ggml-tiny.en.bin',
                },
            },
        };
        const latestSettings = {
            ai: {
                speechToText: {
                    provider: 'whisper',
                    model: 'whisper-tiny.en',
                    offlineModelPath: 'file:///document/whisper-models/ggml-tiny.en.bin',
                },
            },
        };

        expect(selectQuickCaptureSettings(staleSettings, latestSettings)).toBe(latestSettings);
        expect(selectQuickCaptureSettings(staleSettings, undefined)).toBe(staleSettings);
    });
});
