import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverNativeAITextModels, discoverNativeVoiceModels, type NativeAITextModelDiscoveryInput, type NativeVoiceModelDiscoveryInput } from './native-ai-model-discovery';
import { abortableAIFetch } from './ai/utils';

const input = (patch: Partial<NativeAITextModelDiscoveryInput> = {}): NativeAITextModelDiscoveryInput => ({
    provider: 'openai', enabled: true, model: 'selected-custom', copilotModel: 'copilot-custom',
    modelOptions: ['built-in', 'selected-custom'], copilotModelOptions: ['fast-built-in', 'copilot-custom'],
    consent: false, isFossBuild: false, ...patch,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fixture = (fetcher: typeof fetch = async () => response({ data: [{ id: 'live', created: 1 }] })) => ({
    readCredential: vi.fn(async (): Promise<string | null> => 'synthetic-private-credential'),
    fetch: vi.fn<typeof fetch>(fetcher),
    current: vi.fn(() => {}),
});
const fallback = { status: 'fallback', modelOptions: ['built-in', 'selected-custom'],
    copilotModelOptions: ['fast-built-in', 'copilot-custom'] };
afterEach(() => vi.useRealTimers());

describe('native selected assistant model discovery', () => {
    it('checks consent before credential or HTTP and never modifies input', async () => {
        const selected = input({ enabled: false }), before = structuredClone(selected), deps = fixture();
        expect(await discoverNativeAITextModels(selected, deps)).toEqual({ ...fallback, status: 'unavailable' });
        expect(deps.readCredential).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
        expect(selected).toEqual(before);
    });

    it.each([{ enabled: false, consent: true }, { enabled: true, consent: false }])('admits recorded or selected-enabled consent %j', async gate => {
        const deps = fixture();
        expect(await discoverNativeAITextModels(input(gate), deps)).toEqual({ status: 'loaded',
            modelOptions: ['selected-custom', 'live'], copilotModelOptions: ['copilot-custom', 'live'] });
        expect(deps.readCredential).toHaveBeenCalledTimes(1); expect(deps.fetch).toHaveBeenCalledTimes(1);
        expect(deps.current.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it.each(['openai', 'gemini', 'anthropic'] as const)('makes no request without a credential for %s official defaults', async provider => {
        const deps = { ...fixture(), readCredential: vi.fn(async () => null) };
        expect(await discoverNativeAITextModels(input({ provider }), deps)).toEqual({ ...fallback, status: 'unavailable' });
        expect(deps.readCredential).toHaveBeenCalledTimes(1); expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('uses a keyless custom OpenAI root without a Bearer header and refreshes uncached', async () => {
        const deps = { ...fixture(), readCredential: vi.fn(async () => null) };
        const selected = input({ baseUrl: '  http://localhost:8123/v1/  ' });
        expect((await discoverNativeAITextModels(selected, deps)).status).toBe('loaded');
        expect((await discoverNativeAITextModels(selected, deps)).status).toBe('loaded');
        expect(deps.fetch).toHaveBeenCalledTimes(2);
        expect(deps.fetch.mock.calls[0][0]).toBe('http://localhost:8123/v1/models');
        expect(new Headers(deps.fetch.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    });

    it('retains the existing FOSS custom-root gate', async () => {
        const deps = fixture();
        expect(await discoverNativeAITextModels(input({ isFossBuild: true }), deps)).toEqual({ ...fallback, status: 'unavailable' });
        expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('retains OpenAI newest-first/filter ordering and keeps a selected live entry in place', async () => {
        const deps = fixture(async () => response({ data: [
            { id: 'older', created: 1 }, { id: 'newer', created: 9 }, { id: 'newer', created: 9 },
            { id: 'text-embedding-3', created: 99 }, { id: 'whisper-1', created: 99 }, { id: 'z-custom' }, { id: 'a-custom' },
        ] }));
        expect(await discoverNativeAITextModels(input({ model: 'older', copilotModel: 'not-listed' }), deps)).toEqual({ status: 'loaded',
            modelOptions: ['newer', 'older', 'a-custom', 'z-custom'], copilotModelOptions: ['not-listed', 'newer', 'older', 'a-custom', 'z-custom'] });
    });

    it('reuses Gemini capability/filter/order and selected credential without another provider endpoint', async () => {
        const deps = fixture(async () => response({ models: [
            { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-z', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/imagen-4', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-b', supportedGenerationMethods: ['embedContent'] },
        ] }));
        const result = await discoverNativeAITextModels(input({ provider: 'gemini', baseUrl: 'https://ignored.invalid' }), deps);
        expect(result.modelOptions).toEqual(['selected-custom', 'gemini-z', 'gemini-a']);
        expect(String(deps.fetch.mock.calls[0][0])).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=synthetic-private-credential&pageSize=1000');
    });

    it('preserves Anthropic API order, dedupes and sends only the chosen credential headers', async () => {
        const deps = fixture(async () => response({ data: [{ id: 'claude-z' }, { id: 'claude-a' }, { id: 'claude-z' }] }));
        const result = await discoverNativeAITextModels(input({ provider: 'anthropic' }), deps);
        expect(result.modelOptions).toEqual(['selected-custom', 'claude-z', 'claude-a']);
        expect(deps.fetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=100');
        expect(new Headers(deps.fetch.mock.calls[0][1]?.headers).get('x-api-key')).toBe('synthetic-private-credential');
    });

    it.each(['empty', 'malformed', 'http', 'throw'] as const)('degrades %s provider failure to static + custom choices', async kind => {
        const deps = fixture(async () => {
            if (kind === 'throw') throw new Error('synthetic-private-credential');
            if (kind === 'malformed') return new Response('{bad}');
            return response({ data: [] }, kind === 'http' ? 503 : 200);
        });
        expect(await discoverNativeAITextModels(input(), deps)).toEqual(fallback);
    });

    it('degrades credential read failure without sending HTTP', async () => {
        const deps = { ...fixture(), readCredential: vi.fn(async () => { throw new Error('synthetic-private-credential'); }) };
        expect(await discoverNativeAITextModels(input(), deps)).toEqual(fallback);
        expect(deps.fetch).not.toHaveBeenCalled();
    });

    it.each(['count', 'id', 'dto', 'custom-added'] as const)('falls back on %s live bounds instead of truncating', async bound => {
        const entries = bound === 'count' ? Array.from({ length: 101 }, (_, n) => ({ id: `live-${n}` }))
            : bound === 'id' ? [{ id: 'x'.repeat(2001) }]
            : bound === 'dto' ? Array.from({ length: 30 }, (_, n) => ({ id: `${n}-` + '界'.repeat(1000) }))
            : Array.from({ length: 100 }, (_, n) => ({ id: `live-${n}` }));
        const deps = fixture(async () => response({ data: entries }));
        expect(await discoverNativeAITextModels(input(), deps)).toEqual(fallback);
    });

    it('refuses invalid fallback bounds before credential/HTTP rather than emitting an invalid DTO', async () => {
        const deps = fixture();
        await expect(discoverNativeAITextModels(input({ modelOptions: Array.from({ length: 101 }, (_, n) => `static-${n}`) }), deps))
            .rejects.toThrow('Native model choices exceed the supported bounds');
        expect(deps.readCredential).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('propagates ownership loss after credential await without HTTP', async () => {
        let stale = false;
        const deps = { ...fixture(), current: () => { if (stale) throw new Error('stale-owner'); },
            readCredential: async () => { stale = true; return 'private'; } };
        await expect(discoverNativeAITextModels(input(), deps)).rejects.toThrow('stale-owner');
        expect(deps.fetch).not.toHaveBeenCalled();
    });

    it.each([false, true])('propagates ownership loss after provider await, including catch path=%s', async fail => {
        let stale = false;
        const deps = { ...fixture(async () => { stale = true; if (fail) throw new Error('provider-private-error'); return response({ data: [] }); }),
            current: () => { if (stale) throw new Error('stale-owner'); } };
        await expect(discoverNativeAITextModels(input(), deps)).rejects.toThrow('stale-owner');
    });

    it('refuses an already aborted owner before credential or fetch', async () => {
        const stop = new AbortController(); stop.abort(); const deps = { ...fixture(), signal: stop.signal };
        await expect(discoverNativeAITextModels(input(), deps)).rejects.toMatchObject({ reason: 'aborted' });
        expect(deps.readCredential).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('combines outer cancellation with the inner fetch signal and never falls back after owner abort', async () => {
        const stop = new AbortController(); let started!: () => void;
        const began = new Promise<void>(resolve => { started = resolve; });
        const deps = { ...fixture(async (_url, init) => {
            started();
            return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
        }), signal: stop.signal };
        const result = discoverNativeAITextModels(input(), deps);
        const rejected = expect(result).rejects.toMatchObject({ reason: 'aborted' });
        await began; stop.abort(); await rejected;
        expect(deps.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it('keeps the shared ten-second timeout while an outer owner signal exists', async () => {
        vi.useFakeTimers(); const stop = new AbortController();
        const deps = { ...fixture(async (_url, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })), signal: stop.signal };
        const result = discoverNativeAITextModels(input(), deps);
        await vi.advanceTimersByTimeAsync(10_001);
        expect(await result).toEqual(fallback);
        expect(stop.signal.aborted).toBe(false);
        expect(deps.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('the shared abort adapter forwards each independent signal rather than replacing the inner one', async () => {
        for (const fromOuter of [true, false]) {
            const outer = new AbortController(), inner = new AbortController();
            const fetcher = vi.fn<typeof fetch>(async () => response({}));
            await abortableAIFetch(fetcher, outer.signal)('https://example.invalid', { signal: inner.signal });
            const combined = fetcher.mock.calls[0][1]?.signal;
            expect(combined).not.toBe(outer.signal); expect(combined).not.toBe(inner.signal);
            if (fromOuter) outer.abort(); else inner.abort();
            expect(combined?.aborted).toBe(true);
        }
    });
});


const voiceInput = (patch: Partial<NativeVoiceModelDiscoveryInput> = {}): NativeVoiceModelDiscoveryInput => ({
    provider: 'openai', model: 'custom-stt', modelOptions: ['built-in-stt', 'custom-stt'],
    consent: false, aiEnabled: true, aiProvider: 'openai', isFossBuild: false, ...patch,
});
const voiceFixture = (fetcher: typeof fetch = async () => response({ data: [{ id: 'gpt-transcribe', created: 1 }] })) => fixture(fetcher);
const voiceFallback = { status: 'fallback', modelOptions: ['built-in-stt', 'custom-stt'] };

describe('native selected speech model discovery', () => {
    it('does not treat speech enabled as consent and never mutates the supplied selection', async () => {
        const selected = { ...voiceInput({ aiEnabled: false }), enabled: true }, before = structuredClone(selected), deps = voiceFixture();
        expect(await discoverNativeVoiceModels(selected, deps)).toEqual({ ...voiceFallback, status: 'unavailable' });
        expect(deps.readCredential).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
        expect(selected).toEqual(before);
    });

    it('does not treat a different enabled text assistant provider as speech consent', async () => {
        const deps = voiceFixture();
        expect(await discoverNativeVoiceModels(voiceInput({ aiProvider: 'anthropic' }), deps))
            .toEqual({ ...voiceFallback, status: 'unavailable' });
        expect(deps.readCredential).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
    });

    it.each([{ consent: true, aiEnabled: false, aiProvider: 'anthropic' }, { consent: false, aiEnabled: true, aiProvider: 'openai' }])(
        'admits only recorded selected consent or matching enabled assistant %j', async consent => {
            const deps = voiceFixture();
            expect(await discoverNativeVoiceModels(voiceInput(consent), deps)).toEqual({ status: 'loaded',
                modelOptions: ['custom-stt', 'gpt-transcribe'] });
            expect(deps.readCredential).toHaveBeenCalledTimes(1); expect(deps.fetch).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['whisper', 'parakeet', 'anthropic', 'unknown'])('leaves %s on static options without reading a credential or HTTP', async provider => {
        const deps = voiceFixture();
        expect(await discoverNativeVoiceModels(voiceInput({ provider, consent: true, aiProvider: provider }), deps))
            .toEqual({ ...voiceFallback, status: 'unavailable' });
        expect(deps.readCredential).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
    });

    it.each(['openai', 'gemini'])('keeps FOSS speech local even when saved %s has prior consent', async provider => {
        const deps = voiceFixture();
        expect(await discoverNativeVoiceModels(voiceInput({ provider, consent: true, isFossBuild: true }), deps))
            .toEqual({ ...voiceFallback, status: 'unavailable' });
        expect(deps.readCredential).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('selects OpenAI transcription models rather than chat, preserving shared newest-first and custom selection', async () => {
        const deps = voiceFixture(async () => response({ data: [
            { id: 'gpt-chat', created: 100 }, { id: 'whisper-1', created: 1 }, { id: 'gpt-transcribe', created: 9 },
            { id: 'whisper-1', created: 1 }, { id: 'text-embedding-3', created: 99 },
        ] }));
        expect(await discoverNativeVoiceModels(voiceInput(), deps)).toEqual({ status: 'loaded',
            modelOptions: ['custom-stt', 'gpt-transcribe', 'whisper-1'] });
    });

    it('selects Gemini generateContent models in shared order and ignores the OpenAI-only custom root', async () => {
        const deps = voiceFixture(async () => response({ models: [
            { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-z', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/veo-video', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
        ] }));
        expect(await discoverNativeVoiceModels(voiceInput({ provider: 'gemini', aiProvider: 'gemini', baseUrl: 'https://ignored.invalid' }), deps))
            .toEqual({ status: 'loaded', modelOptions: ['custom-stt', 'gemini-z', 'gemini-a'] });
        expect(String(deps.fetch.mock.calls[0][0])).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=synthetic-private-credential&pageSize=1000');
    });

    it.each(['openai', 'gemini'])('sends no %s official request when the selected credential is absent', async provider => {
        const deps = { ...voiceFixture(), readCredential: vi.fn(async () => null) };
        expect(await discoverNativeVoiceModels(voiceInput({ provider, consent: true }), deps))
            .toEqual({ ...voiceFallback, status: 'unavailable' });
        expect(deps.readCredential).toHaveBeenCalledTimes(1); expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('uses a keyless custom speech root as raw /v1/models and refreshes without cache', async () => {
        const deps = { ...voiceFixture(), readCredential: vi.fn(async () => null) };
        const selected = voiceInput({ baseUrl: '  http://localhost:8123/v1/ ' });
        expect((await discoverNativeVoiceModels(selected, deps)).status).toBe('loaded');
        expect((await discoverNativeVoiceModels(selected, deps)).status).toBe('loaded');
        expect(deps.fetch).toHaveBeenCalledTimes(2);
        expect(deps.fetch.mock.calls[0][0]).toBe('http://localhost:8123/v1/models');
        expect(new Headers(deps.fetch.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    });

    it.each(['empty', 'malformed', 'http', 'throw'] as const)('retains static/custom speech choices on %s failure', async failure => {
        const deps = voiceFixture(async () => {
            if (failure === 'throw') throw new Error('synthetic-private-credential');
            if (failure === 'malformed') return new Response('{bad}');
            return response({ data: [] }, failure === 'http' ? 503 : 200);
        });
        expect(await discoverNativeVoiceModels(voiceInput(), deps)).toEqual(voiceFallback);
    });

    it.each(['count', 'id', 'dto'] as const)('falls back without truncation for speech %s bounds', async bound => {
        const entries = bound === 'count' ? Array.from({ length: 100 }, (_, n) => ({ id: `transcribe-${n}` }))
            : bound === 'id' ? [{ id: 'transcribe-' + 'x'.repeat(2000) }]
            : Array.from({ length: 30 }, (_, n) => ({ id: `transcribe-${n}-` + '界'.repeat(1000) }));
        const deps = voiceFixture(async () => response({ data: entries }));
        expect(await discoverNativeVoiceModels(voiceInput(), deps)).toEqual(voiceFallback);
    });

    it('rejects invalid static speech bounds before keys/HTTP rather than publishing an invalid DTO', async () => {
        const deps = voiceFixture();
        await expect(discoverNativeVoiceModels(voiceInput({ model: 'x'.repeat(2001) }), deps))
            .rejects.toThrow('Native model choices exceed the supported bounds');
        expect(deps.readCredential).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
    });

    it('checks speech owner after the credential await before HTTP', async () => {
        let stale = false;
        const deps = { ...voiceFixture(), current: () => { if (stale) throw new Error('stale-voice'); },
            readCredential: async () => { stale = true; return 'private'; } };
        await expect(discoverNativeVoiceModels(voiceInput(), deps)).rejects.toThrow('stale-voice');
        expect(deps.fetch).not.toHaveBeenCalled();
    });

    it.each([false, true])('propagates speech owner loss after HTTP success/error=%s instead of fallback', async failure => {
        let stale = false;
        const deps = { ...voiceFixture(async () => {
            stale = true;
            if (failure) throw new Error('private-http-error');
            return response({ data: [{ id: 'gpt-transcribe' }] });
        }), current: () => { if (stale) throw new Error('stale-voice'); } };
        await expect(discoverNativeVoiceModels(voiceInput(), deps)).rejects.toThrow('stale-voice');
    });

    it('propagates outer speech cancellation through HTTP instead of publishing fallback', async () => {
        const stop = new AbortController(); let started!: () => void;
        const began = new Promise<void>(resolve => { started = resolve; });
        const deps = { ...voiceFixture(async (_url, init) => {
            started();
            return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
        }), signal: stop.signal };
        const result = discoverNativeVoiceModels(voiceInput(), deps);
        const rejected = expect(result).rejects.toMatchObject({ reason: 'aborted' });
        await began; stop.abort(); await rejected;
        expect(deps.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it('retains the ten-second timeout with a live outer speech owner', async () => {
        vi.useFakeTimers(); const stop = new AbortController();
        const deps = { ...voiceFixture(async (_url, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })), signal: stop.signal };
        const result = discoverNativeVoiceModels(voiceInput(), deps);
        await vi.advanceTimersByTimeAsync(10_001);
        expect(await result).toEqual(voiceFallback);
        expect(stop.signal.aborted).toBe(false);
        expect(deps.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
