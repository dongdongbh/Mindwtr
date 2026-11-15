import { describe, expect, it } from 'bun:test';
import { WHISPER_MODELS } from '@mindwtr/core';
import { createNativeWhisper, type WhisperLine } from './host-whisper';


const DOCS = 'file:///data/user/0/tech.dongdongbh.mindwtr.nativeclient.dev/files/';
const tiny = WHISPER_MODELS.find((model) => model.id === 'whisper-tiny')!;
const baseEn = WHISPER_MODELS.find((model) => model.id === 'whisper-base.en')!;

const harness = (answer: (request: Record<string, unknown>) => unknown) => {
    const requests: Array<Record<string, unknown>> = [];
    const lines: WhisperLine[] = [];
    const remembered: Array<[string, string | undefined]> = [];
    let clock = 1_000;
    const whisper = createNativeWhisper({
        call: async (request) => { requests.push(request); return answer(request); },
        documentDirectory: DOCS,
        log: (line) => { lines.push(line); },
        rememberPath: async (modelId, uri) => { remembered.push([modelId, uri]); },
        now: () => (clock += 250),
    });
    return { whisper, requests, lines, remembered };
};

describe('native local Whisper', () => {
    it('keeps RN\'s model file names and folder, so RN and native share one download', () => {
        const { whisper } = harness(() => null);
        expect(whisper.preferredModelUri('whisper-base.en')).toBe(`${DOCS}whisper-models/ggml-base.en.bin`);
        expect(whisper.preferredModelUri('whisper-large-v3-turbo')).toBe(`${DOCS}whisper-models/ggml-tiny.bin`);
    });

    it('counts a model as ready only at its exact catalogue size, through the one host resolver', async () => {
        for (const [size, ready] of [[tiny.sizeBytes, true], [tiny.sizeBytes - 1, false], [tiny.sizeBytes + 1, false]] as const) {
            const { whisper, requests } = harness(() => ({ exists: true, uri: `${DOCS}whisper-models/ggml-tiny.bin`, size }));
            expect(await whisper.ready({ model: 'whisper-tiny', modelPath: `${DOCS}whisper-models/ggml-tiny.bin`, language: 'auto' })).toBe(ready);
            expect(requests).toEqual([{ op: 'whisperLocate', fileName: 'ggml-tiny.bin', sizeBytes: tiny.sizeBytes, storedPath: `${DOCS}whisper-models/ggml-tiny.bin` }]);
        }
        const missing = harness(() => { throw new Error('E_WHISPER_IO'); });
        expect(await missing.whisper.ready({ model: 'whisper-tiny', language: 'auto' })).toBe(false);
    });

    it('transcribes the recording with the catalogue model and RN\'s language rule, and logs no transcript text', async () => {
        const { whisper, requests, lines } = harness(() => 'Buy milk');
        expect(await whisper.transcribe(`${DOCS}voice-captures/a.wav`, { model: 'whisper-base.en', language: 'auto' })).toBe('Buy milk');
        expect(await whisper.transcribe(`${DOCS}voice-captures/b.wav`, { model: 'whisper-tiny', modelPath: `${DOCS}whisper-models/ggml-tiny.bin`, language: 'German' })).toBe('Buy milk');
        expect(requests).toEqual([
            { op: 'whisperTranscribe', uri: `${DOCS}voice-captures/a.wav`, fileName: 'ggml-base.en.bin', sizeBytes: baseEn.sizeBytes, language: 'en' },
            { op: 'whisperTranscribe', uri: `${DOCS}voice-captures/b.wav`, fileName: 'ggml-tiny.bin', sizeBytes: tiny.sizeBytes, language: 'german',
                storedPath: `${DOCS}whisper-models/ggml-tiny.bin` },
        ]);
        expect(lines).toEqual([{ stage: 'transcribe', outcome: 'transcribed', ms: 250 }, { stage: 'transcribe', outcome: 'transcribed', ms: 250 }]);
        expect(JSON.stringify(lines)).not.toContain('milk');
    });

    it('logs an empty transcript and a failure by code only', async () => {
        const empty = harness(() => '');
        expect(await empty.whisper.transcribe(`${DOCS}a.wav`, { model: 'whisper-tiny', language: 'auto' })).toBe('');
        expect(empty.lines).toEqual([{ stage: 'transcribe', outcome: 'empty', ms: 250 }]);
        const failed = harness(() => { throw new Error('E_WHISPER_AUDIO_UNSUPPORTED'); });
        await expect(failed.whisper.transcribe(`${DOCS}a.m4a`, { model: 'whisper-tiny', language: 'auto' })).rejects.toThrow('E_WHISPER_AUDIO_UNSUPPORTED');
        const leaky = harness(() => { throw new Error('open failed: /data/user/0/secret/files/a.wav'); });
        await expect(leaky.whisper.transcribe(`${DOCS}a.wav`, { model: 'whisper-tiny', language: 'auto' })).rejects.toThrow();
        expect([...failed.lines, ...leaky.lines]).toEqual([
            { stage: 'transcribe', outcome: 'failed', reason: 'E_WHISPER_AUDIO_UNSUPPORTED', ms: 250 },
            { stage: 'transcribe', outcome: 'failed', reason: 'E_WHISPER_FAILED', ms: 250 },
        ]);
    });

    it('downloads from RN\'s two hosts with the pinned size and SHA-256, deletes by file name, and stores the model path as RN does', async () => {
        const { whisper, requests, lines, remembered } = harness((request) => (request.op === 'whisperDownload'
            ? { exists: true, uri: `${DOCS}whisper-models/ggml-base.en.bin`, size: baseEn.sizeBytes, repaired: true } : null));
        expect(await whisper.download('whisper-base.en')).toEqual({ exists: true, uri: `${DOCS}whisper-models/ggml-base.en.bin`, size: baseEn.sizeBytes });
        await whisper.remove('whisper-base.en');
        expect(requests).toEqual([
            { op: 'whisperDownload', fileName: 'ggml-base.en.bin', sizeBytes: baseEn.sizeBytes, sha256: baseEn.sha256, urls: [
                'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
                'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
            ] },
            { op: 'whisperDelete', fileName: 'ggml-base.en.bin' },
        ]);
        expect(lines).toEqual([{ stage: 'download', outcome: 'model-ready', repaired: true }, { stage: 'delete', outcome: 'deleted' }]);
        expect(remembered).toEqual([['whisper-base.en', `${DOCS}whisper-models/ggml-base.en.bin`], ['whisper-base.en', undefined]]);
        const failed = harness(() => { throw new Error('E_WHISPER_HASH'); });
        await expect(failed.whisper.download('whisper-tiny')).rejects.toThrow('E_WHISPER_HASH');
        expect(failed.lines).toEqual([{ stage: 'download', outcome: 'failed', reason: 'E_WHISPER_HASH' }]);
        expect(failed.remembered).toEqual([]);
    });
});
