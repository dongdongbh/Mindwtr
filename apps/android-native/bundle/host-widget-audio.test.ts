import { describe, expect, it } from 'bun:test';
import type { AppData, PendingAudioCapture } from '@mindwtr/core';
import { createWidgetAudioPort, type WidgetAudioBindings } from './host-widget-audio';

// The widget's queued recordings on the native host (widget-audio-20261028-05): RN's audio port, with Gemini the one provider
// this host reaches before the voice capture passes; any other leaves the recording queued, as RN does without speech.

const DOCS = 'file:///data/user/0/tech.dongdongbh.mindwtr.nativeclient.dev/files/';
const ID = '22222222-2222-4abc-8def-222222222222';
const capture = (props: Partial<PendingAudioCapture> = {}): PendingAudioCapture => ({
    kind: 'audio', id: ID, source: 'android-quick-capture', audioPath: `${DOCS}quick-capture-audio/${ID}.wav`, ...props,
} as PendingAudioCapture);
const settings = (speechToText: Record<string, unknown> | undefined): AppData['settings'] => ({ ai: { speechToText } } as never);

const harness = (overrides: Partial<WidgetAudioBindings> = {}, answer: unknown = { transcript: 'Buy milk' }) => {
    const deleted: string[] = [];
    const waiting: string[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const port = createWidgetAudioPort({
        documentDirectory: DOCS,
        readBytes: async () => new Uint8Array([82, 73, 70, 70]),
        deleteFile: (path) => { deleted.push(path); },
        loadKey: async (provider) => (provider === 'gemini' ? 'gemini-key' : ''),
        isFossBuild: false,
        fetcher: (async (url: string, init: RequestInit) => {
            requests.push({ url, init });
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
        }) as never,
        logWaiting: (outcome) => { waiting.push(outcome); },
        ...overrides,
    });
    return { port, deleted, waiting, requests };
};

describe('the widget audio port', () => {
    it('accepts only the widget\'s own recording for the capture\'s UUID, and deletes only there', async () => {
        const { port, deleted } = harness();
        expect(port.resolvePath(capture())).toBe(`${DOCS}quick-capture-audio/${ID}.wav`);
        for (const other of [
            capture({ source: 'apple-watch' }),
            capture({ id: 'not-a-uuid', audioPath: `${DOCS}quick-capture-audio/not-a-uuid.wav` }),
            capture({ audioPath: `${DOCS}attachments/${ID}.wav` }),
            capture({ audioPath: `${DOCS}quick-capture-audio/../mindwtr-native-dev.db` }),
            capture({ audioPath: `${DOCS}quick-capture-audio/33333333-3333-4abc-8def-333333333333.wav` }),
        ]) expect(port.resolvePath(other)).toBeNull();
        await port.delete(`${DOCS}quick-capture-audio/${ID}.wav`);
        await port.delete(`${DOCS}mindwtr-native-dev.db`);
        expect(deleted).toEqual([`files/quick-capture-audio/${ID}.wav`]);
    });

    it('transcribes with Gemini: the recording inline as WAV, the key in a header, never the URL', async () => {
        const { port, requests, waiting } = harness();
        expect(await port.transcribe!(`${DOCS}quick-capture-audio/${ID}.wav`, settings({ enabled: true, provider: 'gemini' }))).toBe('Buy milk');
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toContain(':generateContent');
        expect(requests[0].url).not.toContain('gemini-key');
        expect((requests[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('gemini-key');
        const body = JSON.parse(String(requests[0].init.body));
        expect(body.contents[0].parts[1].inline_data).toEqual({ mime_type: 'audio/wav', data: 'UklGRg==' });
        expect(waiting).toEqual([]);
    });

    it('answers no transcript, so the recording stays queued, without speech, without a key, or for a provider this host cannot reach yet', async () => {
        const path = `${DOCS}quick-capture-audio/${ID}.wav`;
        const cases: Array<[Partial<WidgetAudioBindings>, Record<string, unknown> | undefined, string]> = [
            [{}, undefined, 'not-configured'],
            [{}, { enabled: false, provider: 'gemini' }, 'not-configured'],
            [{ loadKey: async () => '' }, { enabled: true, provider: 'gemini' }, 'not-configured'],
            [{}, { enabled: true, provider: 'openai' }, 'provider-unsupported'],
            [{}, { enabled: true, provider: 'openai', baseUrl: 'http://192.168.1.2:8000' }, 'provider-unsupported'],
            [{}, { enabled: true, provider: 'whisper' }, 'provider-unsupported'],
            // A FOSS build uses local Whisper whatever is stored, as RN's.
            [{ isFossBuild: true }, { enabled: true, provider: 'gemini' }, 'provider-unsupported'],
            [{}, { enabled: true, provider: 'parakeet' }, 'not-configured'],
        ];
        for (const [overrides, speech, outcome] of cases) {
            const { port, requests, waiting } = harness(overrides);
            expect(await port.transcribe!(path, settings(speech))).toBeNull();
            expect([JSON.stringify(speech), requests.length, waiting]).toEqual([JSON.stringify(speech), 0, [outcome]]);
        }
        const empty = harness({}, { transcript: '   ' });
        expect(await empty.port.transcribe!(path, settings({ enabled: true, provider: 'gemini' }))).toBeNull();
        expect(empty.waiting).toEqual(['empty']);
    });
});
