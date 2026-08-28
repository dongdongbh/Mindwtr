import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processAudioCapture, resolveSpeechCapture } from './speech-to-text';

const tauriMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

const aiConfigMocks = vi.hoisted(() => ({
    loadAIKey: vi.fn(async () => ''),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriMocks.invoke,
}));

vi.mock('./ai-config', () => ({
    loadAIKey: aiConfigMocks.loadAIKey,
}));

describe('processAudioCapture desktop local ASR providers', () => {
    beforeEach(() => {
        tauriMocks.invoke.mockReset();
        (window as typeof window & { __TAURI__?: unknown }).__TAURI__ = {};
    });

    it('invokes the sherpa-onnx Parakeet command with local audio and model paths', async () => {
        tauriMocks.invoke.mockResolvedValueOnce(' Call Marc tomorrow. ');

        const result = await processAudioCapture(
            {
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: 'audio/wav',
                name: 'capture.wav',
                path: '/tmp/capture.wav',
            },
            {
                provider: 'parakeet',
                model: 'parakeet-tdt-0.6b-v3-int8',
                modelPath: '/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
                language: 'en',
            },
        );

        expect(result).toEqual({ transcript: 'Call Marc tomorrow.' });
        expect(tauriMocks.invoke).toHaveBeenCalledWith('transcribe_parakeet', {
            modelPath: '/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
            audioPath: '/tmp/capture.wav',
            language: 'en',
        });
    });

    it('extracts transcript text from structured local ASR JSON output', async () => {
        tauriMocks.invoke.mockResolvedValueOnce('{"lang":"","emotion":"","event":"","text":"Call Marc tomorrow."}');

        const result = await processAudioCapture(
            {
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: 'audio/wav',
                name: 'capture.wav',
                path: '/tmp/capture.wav',
            },
            {
                provider: 'parakeet',
                model: 'parakeet-tdt-0.6b-v3-int8',
                modelPath: '/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
                language: 'en',
            },
        );

        expect(result).toEqual({ transcript: 'Call Marc tomorrow.' });
    });
});

describe('resolveSpeechCapture', () => {
    beforeEach(() => {
        aiConfigMocks.loadAIKey.mockReset();
        aiConfigMocks.loadAIKey.mockResolvedValue('');
    });

    it.each(['openai', 'gemini'] as const)('is ready when %s is enabled and a key is present', async (provider) => {
        aiConfigMocks.loadAIKey.mockResolvedValue('secret-key');

        const result = await resolveSpeechCapture({ speechToText: { enabled: true, provider } });

        expect(result.ready).toBe(true);
        expect(result.reason).toBeUndefined();
        expect(result.config.apiKey).toBe('secret-key');
        expect(aiConfigMocks.loadAIKey).toHaveBeenCalledWith(provider);
    });

    it.each(['openai', 'gemini'] as const)('reports no-key when %s is enabled but the key is empty', async (provider) => {
        const result = await resolveSpeechCapture({ speechToText: { enabled: true, provider } });

        expect(result.ready).toBe(false);
        expect(result.reason).toBe('no-key');
    });

    it.each(['whisper', 'parakeet'] as const)('is ready when %s is enabled and an offline model path is set', async (provider) => {
        const result = await resolveSpeechCapture({
            speechToText: { enabled: true, provider, offlineModelPath: '/models/local' },
        });

        expect(result.ready).toBe(true);
        expect(result.reason).toBeUndefined();
        expect(result.config.modelPath).toBe('/models/local');
        expect(aiConfigMocks.loadAIKey).not.toHaveBeenCalled();
    });

    it.each(['whisper', 'parakeet'] as const)('reports no-model when %s is enabled but no offline model path is set', async (provider) => {
        const result = await resolveSpeechCapture({ speechToText: { enabled: true, provider } });

        expect(result.ready).toBe(false);
        expect(result.reason).toBe('no-model');
    });

    it.each(['openai', 'gemini', 'whisper', 'parakeet'] as const)(
        'reports disabled for %s without touching loadAIKey, even when otherwise configured',
        async (provider) => {
            const result = await resolveSpeechCapture({
                speechToText: { enabled: false, provider, offlineModelPath: '/models/local' },
            });

            expect(result.ready).toBe(false);
            expect(result.reason).toBe('disabled');
            expect(aiConfigMocks.loadAIKey).not.toHaveBeenCalled();
        }
    );

    it('defaults to the gemini provider when speech-to-text settings are absent', async () => {
        const result = await resolveSpeechCapture(undefined);

        expect(result.config.provider).toBe('gemini');
        expect(result.ready).toBe(false);
        expect(result.reason).toBe('disabled');
    });

    it('defaults openai speech to gpt-transcribe when no model is saved', async () => {
        aiConfigMocks.loadAIKey.mockResolvedValue('secret-key');

        const result = await resolveSpeechCapture({
            speechToText: { enabled: true, provider: 'openai' },
        });

        expect(result.config.model).toBe('gpt-transcribe');
    });

    it('carries parseModel through only when the speech provider and the main AI provider are both openai', async () => {
        aiConfigMocks.loadAIKey.mockResolvedValue('secret-key');

        const matched = await resolveSpeechCapture({
            provider: 'openai',
            model: 'gpt-5-main',
            speechToText: { enabled: true, provider: 'openai' },
        });
        expect(matched.config.parseModel).toBe('gpt-5-main');

        const mismatched = await resolveSpeechCapture({
            provider: 'gemini',
            model: 'gemini-main',
            speechToText: { enabled: true, provider: 'openai' },
        });
        expect(mismatched.config.parseModel).toBeUndefined();
    });

    // Regression guard for the divergence in #886-era QuickAddModal: the "can I
    // record?" gate and the "can I transcribe?" gate both call this function with
    // the same settings snapshot, so they can no longer disagree. Before the fix,
    // QuickAddModal re-derived the record gate by hand and never resolved a model,
    // so the two computations could drift independently.
    it('is deterministic for a fixed settings snapshot, so the record gate and transcribe gate cannot disagree', async () => {
        aiConfigMocks.loadAIKey.mockResolvedValue('secret-key');
        const settings = { speechToText: { enabled: true, provider: 'openai' as const } };

        const recordGate = await resolveSpeechCapture(settings);
        const transcribeGate = await resolveSpeechCapture(settings);

        expect(recordGate.ready).toBe(transcribeGate.ready);
        expect(recordGate.reason).toBe(transcribeGate.reason);
        expect(recordGate.config).toEqual(transcribeGate.config);
    });

    // #930: a self-hosted OpenAI-compatible transcription server usually has
    // no key, so a configured base URL substitutes for one — openai only.
    it('is ready with a custom OpenAI base URL and no key', async () => {
        const result = await resolveSpeechCapture({
            speechToText: { enabled: true, provider: 'openai', baseUrl: 'http://localhost:8000/v1' },
        });

        expect(result.ready).toBe(true);
        expect(result.reason).toBeUndefined();
        expect(result.config.apiKey).toBe('');
        expect(result.config.baseUrl).toBe('http://localhost:8000/v1');
    });

    it('still reports no-key for openai without a base URL or a key', async () => {
        const result = await resolveSpeechCapture({
            speechToText: { enabled: true, provider: 'openai' },
        });

        expect(result.ready).toBe(false);
        expect(result.reason).toBe('no-key');
    });

    it('does not extend the base-URL escape hatch to gemini', async () => {
        const result = await resolveSpeechCapture({
            speechToText: { enabled: true, provider: 'gemini', baseUrl: 'http://localhost:8000/v1' },
        });

        expect(result.ready).toBe(false);
        expect(result.reason).toBe('no-key');
        expect(result.config.baseUrl).toBeUndefined();
    });
});

describe('processAudioCapture openai transcription against a custom base URL', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({
            ok: true,
            text: async () => JSON.stringify({ text: 'hello from whisperx' }),
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav', name: 'capture.wav' };

    it('derives the transcribe endpoint from a base URL, stripping a trailing slash', async () => {
        await processAudioCapture(audio, {
            provider: 'openai',
            model: 'large-v3',
            baseUrl: 'http://localhost:8000/v1/',
            mode: 'transcribe_only',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:8000/v1/audio/transcriptions',
            expect.anything()
        );
    });

    it('uses the official OpenAI URL when no base URL is configured', async () => {
        await processAudioCapture(audio, {
            provider: 'openai',
            model: 'gpt-4o-transcribe',
            apiKey: 'secret-key',
            mode: 'transcribe_only',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.openai.com/v1/audio/transcriptions',
            expect.anything()
        );
    });

    it('sends no Authorization header when there is no key', async () => {
        await processAudioCapture(audio, {
            provider: 'openai',
            model: 'large-v3',
            baseUrl: 'http://localhost:8000/v1',
            mode: 'transcribe_only',
        });

        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('sends an Authorization header when a key is present', async () => {
        await processAudioCapture(audio, {
            provider: 'openai',
            model: 'gpt-4o-transcribe',
            apiKey: 'secret-key',
            mode: 'transcribe_only',
        });

        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers.Authorization).toBe('Bearer secret-key');
    });

    // gpt-transcribe-generation models take a `languages` array; earlier
    // models keep the singular `language` field (#984).
    it('sends languages[] for gpt-transcribe and language for earlier models', async () => {
        await processAudioCapture(audio, {
            provider: 'openai',
            model: 'gpt-transcribe',
            apiKey: 'secret-key',
            language: 'en',
            mode: 'transcribe_only',
        });
        await processAudioCapture(audio, {
            provider: 'openai',
            model: 'whisper-1',
            apiKey: 'secret-key',
            language: 'en',
            mode: 'transcribe_only',
        });

        const newModelForm = fetchMock.mock.calls[0][1].body as FormData;
        expect(newModelForm.get('languages[]')).toBe('en');
        expect(newModelForm.get('language')).toBeNull();

        const legacyModelForm = fetchMock.mock.calls[1][1].body as FormData;
        expect(legacyModelForm.get('language')).toBe('en');
        expect(legacyModelForm.get('languages[]')).toBeNull();
    });
});
