import { describe, expect, it } from 'vitest';
import { buildNativeVoiceRuntimeOptions, buildNativeVoiceSettingsOptions, nativeVoiceSettingsWitness, planNativeVoiceSettings, readNativeVoiceSettingsRequest, readNativeVoiceSettingsWitness } from './native-voice-settings';
import { DEFAULT_GEMINI_STT_MODEL, DEFAULT_OPENAI_STT_MODEL, GEMINI_STT_MODEL_OPTIONS, MOBILE_DEFAULT_WHISPER_MODEL, MOBILE_WHISPER_MODELS, OPENAI_STT_MODEL_OPTIONS } from './ai-settings-model';
import { buildRemoteGeminiSpeechRequest, decodeRemoteGeminiSpeechResponse, NATIVE_VOICE_MAX_AUDIO_BYTES } from './speech-to-task';
import { dispatchSpeechCapture } from './quick-capture-audio';
import type { AppSettings } from './types';
const ID = '00000000-0000-4000-8000-0000000007a1';

describe('native voice settings pure boundary', () => {
    it('projects selected scalar fields without private getters and preserves unsupported providers until an explicit switch', () => {
        const ai = { provider: 'anthropic', enabled: false, speechToText: { provider: 'parakeet', enabled: true, mode: 'transcribe_only', language: 'en' } };
        for (const field of ['baseUrl', 'offlineModelPath', 'unknown']) Object.defineProperty(ai.speechToText, field, { enumerable: true, get() { throw new Error('private speech value read'); } });
        for (const field of ['model', 'baseUrl', 'openAIExtraBodyParams']) Object.defineProperty(ai, field, { enumerable: true, get() { throw new Error('private text value read'); } });
        const options = buildNativeVoiceSettingsOptions({ ai } as AppSettings)!;
        expect(options).toMatchObject({ provider: 'parakeet', supported: false, enabled: true, mode: 'transcribe_only', language: 'en' });
        expect(planNativeVoiceSettings(options.expected, { type: 'enabled', value: false })).toEqual({ enabled: false });
        expect(() => planNativeVoiceSettings(options.expected, { type: 'model', value: 'new' })).toThrow();
        expect(planNativeVoiceSettings(options.expected, { type: 'useGemini' })).toMatchObject({ provider: 'gemini' });
        expect(planNativeVoiceSettings(options.expected, { type: 'useWhisper' })).toMatchObject({ provider: 'whisper', model: MOBILE_DEFAULT_WHISPER_MODEL });
        expect(Object.getOwnPropertyDescriptor(ai.speechToText, 'offlineModelPath')?.get).toBeDefined();
        const defaults = buildNativeVoiceSettingsOptions({})!;
        expect(defaults).toMatchObject({ provider: 'gemini', supported: true, enabled: false, mode: 'smart_parse', fieldStrategy: 'smart' });
        expect(planNativeVoiceSettings(defaults.expected, { type: 'useGemini' })).toBeNull();
        expect(planNativeVoiceSettings(defaults.expected, { type: 'language', value: '   ' })).toEqual({ language: 'auto' });
    });
    it('rejects legacy credential presence, malformed selected scalars and extra request keys', () => {
        const ai = {};
        Object.defineProperty(ai, 'apiKey', { get() { throw new Error('credential read'); } });
        expect(nativeVoiceSettingsWitness({ ai })).toBeNull();
        for (const speechToText of [{ mode: 'other' }, { provider: 'other' }, { fieldStrategy: null }, { enabled: 1 }, { model: 'x'.repeat(2001) }])
            expect(nativeVoiceSettingsWitness({ ai: { speechToText } } as unknown as AppSettings)).toBeNull();
        const request = { version: 1, requestId: ID, expected: nativeVoiceSettingsWitness({}), change: { type: 'enabled', value: true } };
        expect(readNativeVoiceSettingsRequest(request)).toEqual(request);
        for (const invalid of [{ ...request, extra: true }, { ...request, expected: { ...request.expected, mode: 'smart_parse' } },
            { ...request, change: { type: 'useGemini', value: true } }, { ...request, change: { type: 'language', value: 'x'.repeat(201) } }])
            expect(readNativeVoiceSettingsRequest(invalid)).toBeNull();
    });
    it.each(['gemini', 'openai', 'whisper', 'parakeet'] as const)('preserves exact private projection key sets for %s', provider => {
        const ai = { speechToText: { provider, model: 'custom-speech', enabled: true } };
        for (const field of ['baseUrl', 'offlineModelPath', 'unknown']) Object.defineProperty(ai.speechToText, field, {
            enumerable: true, get() { throw new Error('private speech getter read'); },
        });
        for (const field of ['model', 'baseUrl', 'openAIExtraBodyParams']) Object.defineProperty(ai, field, {
            enumerable: true, get() { throw new Error('private assistant getter read'); },
        });
        const settings = { ai, gtd: { saveAudioAttachments: false } };
        const options = buildNativeVoiceSettingsOptions(settings)!, runtime = buildNativeVoiceRuntimeOptions(settings)!;
        expect(Object.keys(options).sort()).toEqual(['version', 'provider', 'supported', 'enabled', 'model', 'modelOptions', 'language', 'mode', 'fieldStrategy', 'expected'].sort());
        expect(Object.keys(runtime).sort()).toEqual(['version', 'provider', 'supported', 'enabled', 'model', 'language', 'mode', 'fieldStrategy', 'expected', 'saveAudioAttachments'].sort());
        expect(Object.keys(options.expected).sort()).toEqual(['aiPresent', 'speechPresent', 'providerPresent', 'provider', 'enabledPresent', 'enabled',
            'modelPresent', 'model', 'languagePresent', 'language', 'modePresent', 'mode', 'fieldStrategyPresent', 'fieldStrategy', 'stampPresent', 'stamp'].sort());
        const supported = provider !== 'parakeet';
        expect(options.supported).toBe(supported); expect(runtime.saveAudioAttachments).toBe(false);
        const catalog = provider === 'openai' ? OPENAI_STT_MODEL_OPTIONS
            : provider === 'whisper' ? MOBILE_WHISPER_MODELS.map(entry => entry.id) : GEMINI_STT_MODEL_OPTIONS;
        expect(options.modelOptions).toEqual(supported ? [...catalog, 'custom-speech'] : ['custom-speech']);
        expect(readNativeVoiceSettingsWitness({ ...options.expected, baseUrl: 'PRIVATE' })).toBeNull();
    });
    it.each([
        ['gemini', DEFAULT_GEMINI_STT_MODEL], ['openai', DEFAULT_OPENAI_STT_MODEL],
        ['whisper', MOBILE_DEFAULT_WHISPER_MODEL], ['parakeet', MOBILE_DEFAULT_WHISPER_MODEL],
    ] as const)('uses %s defaults for absent and empty models without changing the stored witness', (provider, model) => {
        expect(buildNativeVoiceSettingsOptions({ ai: { speechToText: { provider } } })?.model).toBe(model);
        const settings = { ai: { speechToText: { provider, model: '' } } };
        expect(buildNativeVoiceRuntimeOptions(settings)).toMatchObject({ provider, model, expected: { modelPresent: true, model: '' } });
        expect(settings.ai.speechToText.model).toBe('');
    });
    it('validates explicit OpenAI switches, returns no-op for the selected provider and enables existing scalar edits', () => {
        const expected = nativeVoiceSettingsWitness({})!;
        const request = { version: 1, requestId: ID, expected, change: { type: 'useOpenAI' } };
        expect(readNativeVoiceSettingsRequest(request)).toEqual(request);
        for (const change of [{ type: 'useOpenAI', value: true }, { type: 'useOpenAI', baseUrl: 'PRIVATE' }, { type: 'baseUrl', value: 'PRIVATE' }])
            expect(readNativeVoiceSettingsRequest({ ...request, change })).toBeNull();
        expect(planNativeVoiceSettings(expected, { type: 'useOpenAI' })).toEqual({ provider: 'openai', model: DEFAULT_OPENAI_STT_MODEL, offlineModelPath: undefined });
        const selected = nativeVoiceSettingsWitness({ ai: { speechToText: { provider: 'openai', enabled: true,
            model: 'custom-speech', language: 'en', mode: 'smart_parse', fieldStrategy: 'smart' } } })!;
        expect(planNativeVoiceSettings(selected, { type: 'useOpenAI' })).toBeNull();
        expect(planNativeVoiceSettings(selected, { type: 'model', value: 'custom-speech' })).toBeNull();
        expect(planNativeVoiceSettings(selected, { type: 'enabled', value: false })).toEqual({ enabled: false });
        expect(planNativeVoiceSettings(selected, { type: 'model', value: 'next-model' })).toEqual({ model: 'next-model' });
        expect(planNativeVoiceSettings(selected, { type: 'language', value: '  es  ' })).toEqual({ language: 'es' });
        expect(planNativeVoiceSettings(selected, { type: 'mode', value: 'transcribe_only' })).toEqual({ mode: 'transcribe_only' });
        expect(planNativeVoiceSettings(selected, { type: 'fieldStrategy', value: 'title_only' })).toEqual({ fieldStrategy: 'title_only' });
        expect(planNativeVoiceSettings(selected, { type: 'useGemini' })).toMatchObject({ provider: 'gemini', model: DEFAULT_GEMINI_STT_MODEL });
    });
    it('validates explicit Whisper switches and preserves the selected provider without resetting legacy models', () => {
        const expected = nativeVoiceSettingsWitness({})!;
        const request = { version: 1, requestId: ID, expected, change: { type: 'useWhisper' } };
        expect(readNativeVoiceSettingsRequest(request)).toEqual(request);
        for (const change of [{ type: 'useWhisper', value: true }, { type: 'useWhisper', offlineModelPath: 'PRIVATE' }])
            expect(readNativeVoiceSettingsRequest({ ...request, change })).toBeNull();
        expect(planNativeVoiceSettings(expected, { type: 'useWhisper' })).toEqual({ provider: 'whisper', model: MOBILE_DEFAULT_WHISPER_MODEL, offlineModelPath: undefined });
        expect(MOBILE_WHISPER_MODELS.map(entry => entry.id)).toEqual(['whisper-tiny', 'whisper-tiny.en', 'whisper-base', 'whisper-base.en']);
        expect(buildNativeVoiceSettingsOptions({ ai: { speechToText: { provider: 'whisper' } } })?.modelOptions)
            .toEqual(MOBILE_WHISPER_MODELS.map(entry => entry.id));
        for (const model of ['custom-local-model', 'whisper-large-v3-turbo']) {
            const settings = { ai: { speechToText: { provider: 'whisper' as const, model, enabled: true,
                language: 'en', mode: 'smart_parse' as const, fieldStrategy: 'smart' as const, offlineModelPath: 'PRIVATE' } } };
            const raw = JSON.stringify(settings), options = buildNativeVoiceSettingsOptions(settings)!, selected = options.expected;
            expect(options).toMatchObject({ supported: true, model });
            expect(options.modelOptions).toEqual([...MOBILE_WHISPER_MODELS.map(entry => entry.id), model]);
            expect(buildNativeVoiceRuntimeOptions(settings)?.model).toBe(model);
            expect(planNativeVoiceSettings(selected, { type: 'useWhisper' })).toBeNull();
            expect(() => planNativeVoiceSettings(selected, { type: 'model', value: model })).toThrow('Whisper model is not supported');
            for (const choice of MOBILE_WHISPER_MODELS) expect(planNativeVoiceSettings(selected, { type: 'model', value: choice.id })).toEqual({ model: choice.id });
            expect(planNativeVoiceSettings(selected, { type: 'language', value: '  es  ' })).toEqual({ language: 'es' });
            expect(planNativeVoiceSettings(selected, { type: 'mode', value: 'transcribe_only' })).toEqual({ mode: 'transcribe_only' });
            expect(planNativeVoiceSettings(selected, { type: 'fieldStrategy', value: 'description_only' })).toEqual({ fieldStrategy: 'description_only' });
            expect(planNativeVoiceSettings(selected, { type: 'enabled', value: false })).toEqual({ enabled: false });
            expect(JSON.stringify(settings)).toBe(raw);
            expect(JSON.stringify(options)).not.toContain('PRIVATE');
        }
    });
});

describe('pure Gemini native transport projection', () => {
    it('shares request/response semantics without credentials and rejects invalid/capped native audio', () => {
        const config = { model: 'gemini-3.6-flash', mode: 'transcribe_only' as const, language: 'en', now: new Date('2026-10-29T12:00:00.000Z') };
        const request = buildRemoteGeminiSpeechRequest(config, 'TWE=', 'audio/mp4');
        expect(request).toMatchObject({ method: 'POST', timeoutMs: 30000, headers: [['Content-Type', 'application/json']] });
        expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
        expect(JSON.parse(request.body).contents[0].parts[1]).toEqual({ inline_data: { mime_type: 'audio/mp4', data: 'TWE=' } });
        expect(request.body).not.toContain('apiKey');
        expect(decodeRemoteGeminiSpeechResponse({ candidates: [{ content: { parts: [{ text: '{"transcript":"Buy milk","tags":["errand"]}' }] } }] }))
            .toMatchObject({ transcript: 'Buy milk', tags: ['errand'] });
        for (const bytes of ['', 'TWF=', 'TQ=', 'TR==', 'not base64']) expect(() => buildRemoteGeminiSpeechRequest(config, bytes, 'audio/mp4')).toThrow();
        const maximum = Buffer.alloc(NATIVE_VOICE_MAX_AUDIO_BYTES).toString('base64');
        expect(() => buildRemoteGeminiSpeechRequest(config, maximum, 'audio/mp4')).not.toThrow();
        expect(() => buildRemoteGeminiSpeechRequest(config, Buffer.alloc(NATIVE_VOICE_MAX_AUDIO_BYTES + 1).toString('base64'), 'audio/mp4')).toThrow();
    });
    it('keeps existing RN/Android Gemini dispatch outside the new native-only upload cap', async () => {
        let upload = '';
        const bytes = new Uint8Array(NATIVE_VOICE_MAX_AUDIO_BYTES + 1);
        const result = await dispatchSpeechCapture({ provider: 'gemini', apiKey: 'synthetic', model: 'gemini-3.6-flash', mode: 'transcribe_only' }, false, {
            readBytes: async () => ({ bytes, mimeType: 'audio/mp4' }),
            withOpenAIUpload: async () => { throw new Error('not OpenAI'); }, transcribeLocal: async () => { throw new Error('not local'); }, logWarn: () => {},
            fetcher: async (_input, init) => { upload = String(init?.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"transcript":"kept"}' }] } }] })); },
        });
        expect(result.transcript).toBe('kept');
        expect(JSON.parse(upload).contents[0].parts[1].inline_data.data.length).toBeGreaterThan(NATIVE_VOICE_MAX_AUDIO_BYTES);
    });
});
