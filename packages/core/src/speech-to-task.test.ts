import { describe, expect, it, vi } from 'vitest';

import {
    runRemoteSpeechToTaskCapture,
    runSpeechToTaskCapture,
    type SpeechToTaskResult,
} from './speech-to-task';

describe('runRemoteSpeechToTaskCapture', () => {
    it('times out and cancels a stalled remote speech error body', async () => {
        vi.useFakeTimers();
        try {
            const cancel = vi.fn();
            const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 500 });
            const pending = runRemoteSpeechToTaskCapture(
                {
                    provider: 'openai',
                    mode: 'transcribe_only',
                    apiKey: 'openai-key',
                    model: 'whisper-1',
                },
                {
                    withOpenAIUpload: async (send) => send({
                        part: new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
                        fileName: 'note.wav',
                    }),
                },
                { fetcher: async () => response },
            );
            const assertion = expect(pending).rejects.toThrow('Speech request timed out');

            await vi.advanceTimersByTimeAsync(30_000);
            await assertion;
            expect(cancel).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('transcribes OpenAI audio through the public speech provider seam', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const fetcher: typeof fetch = async (input, init) => {
            requests.push({ url: String(input), init });
            return new Response(JSON.stringify({ text: ' Buy milk ' }), {
                headers: { 'Content-Type': 'application/json' },
            });
        };

        const result = await runRemoteSpeechToTaskCapture(
            {
                provider: 'openai',
                mode: 'transcribe_only',
                apiKey: 'openai-key',
                model: 'whisper-1',
                parseModel: 'gpt-4o-mini',
                language: 'English',
            },
            {
                withOpenAIUpload: async (send) => send({
                    part: new Blob([new Uint8Array([1, 2, 3])], {
                        type: 'audio/wav',
                    }),
                    fileName: 'note.wav',
                }),
            },
            { fetcher },
        );

        expect(result).toEqual({ transcript: 'Buy milk' });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
        expect(requests[0]?.init?.headers).toEqual({
            Authorization: 'Bearer openai-key',
        });
        expect(requests[0]?.init?.body).toBeInstanceOf(FormData);
        const body = requests[0]?.init?.body as FormData;
        expect(body.get('model')).toBe('whisper-1');
        expect(body.get('language')).toBe('en');
        expect(body.get('response_format')).toBe('json');
        expect((body.get('file') as File).name).toBe('note.wav');
    });

    it('sends Gemini audio bytes and parses the provider response', async () => {
        let request: { url: string; init?: RequestInit } | undefined;
        const fetcher: typeof fetch = async (input, init) => {
            request = { url: String(input), init };
            return new Response(JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{
                            text: JSON.stringify({
                                transcript: 'Buy milk',
                                title: 'Buy milk',
                                language: 'en',
                            }),
                        }],
                    },
                }],
            }), {
                headers: { 'Content-Type': 'application/json' },
            });
        };

        const result = await runRemoteSpeechToTaskCapture(
            {
                provider: 'gemini',
                mode: 'smart_parse',
                apiKey: 'gemini-key',
                model: 'gemini-3.6-flash',
                now: new Date('2026-08-01T12:00:00.000Z'),
                timeZone: 'America/New_York',
            },
            {
                readBytes: async () => ({
                    bytes: new Uint8Array([1, 2, 3]),
                    mimeType: 'audio/wav',
                }),
            },
            { fetcher },
        );

        expect(result).toEqual({
            transcript: 'Buy milk',
            title: 'Buy milk',
            language: 'en',
        });
        expect(request?.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
        );
        expect(request?.init?.headers).toEqual({
            'Content-Type': 'application/json',
            'x-goog-api-key': 'gemini-key',
        });
        const body = JSON.parse(String(request?.init?.body));
        expect(body.contents[0].parts[0].text).toContain('Time zone: America/New_York');
        expect(body.contents[0].parts[1].inline_data).toEqual({
            mime_type: 'audio/wav',
            data: 'AQID',
        });
    });

    it('falls back from OpenAI Responses to chat completions at the provider seam', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const warnings: Array<{ message: string; error: Error }> = [];
        const fetcher: typeof fetch = async (input, init) => {
            const url = String(input);
            requests.push({ url, init });
            if (url.endsWith('/audio/transcriptions')) {
                return new Response(JSON.stringify({ text: 'Buy milk tomorrow' }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith('/responses')) {
                return new Response('Responses unavailable', { status: 500 });
            }
            return new Response(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            transcript: 'Buy milk tomorrow',
                            title: 'Buy milk',
                            dueDate: '2026-08-02T09:00:00-04:00',
                        }),
                    },
                }],
            }), {
                headers: { 'Content-Type': 'application/json' },
            });
        };

        const result = await runRemoteSpeechToTaskCapture(
            {
                provider: 'openai',
                mode: 'smart_parse',
                apiKey: 'openai-key',
                model: 'whisper-1',
                parseModel: 'gpt-4o-mini',
                retryModel: 'gpt-4o-mini',
                now: new Date('2026-08-01T12:00:00.000Z'),
                timeZone: 'America/New_York',
            },
            {
                withOpenAIUpload: async (send) => send({
                    part: new Blob([new Uint8Array([1, 2, 3])], {
                        type: 'audio/wav',
                    }),
                    fileName: 'note.wav',
                }),
            },
            {
                fetcher,
                onWarn: (message, error) => warnings.push({ message, error }),
            },
        );

        expect(result).toEqual({
            transcript: 'Buy milk tomorrow',
            title: 'Buy milk',
            dueDate: '2026-08-02T09:00:00-04:00',
        });
        expect(requests.map(({ url }) => url)).toEqual([
            'https://api.openai.com/v1/audio/transcriptions',
            'https://api.openai.com/v1/responses',
            'https://api.openai.com/v1/chat/completions',
        ]);
        expect(JSON.parse(String(requests[1]?.init?.body)).model).toBe('gpt-4o-mini');
        expect(JSON.parse(String(requests[2]?.init?.body)).model).toBe('gpt-4o-mini');
        expect(warnings).toEqual([{
            message: 'OpenAI responses parse failed, retrying with chat completions',
            error: expect.objectContaining({ message: 'Responses unavailable' }),
        }]);
    });
});

describe('runSpeechToTaskCapture', () => {
    it('uses the direct audio adapter with a transcription prompt in transcribe-only mode', async () => {
        const direct = vi.fn(async (): Promise<SpeechToTaskResult> => ({
            transcript: 'Call Marc tomorrow.',
            language: 'en',
        }));
        const transcribe = vi.fn();
        const parse = vi.fn();

        const result = await runSpeechToTaskCapture(
            {
                provider: 'gemini',
                mode: 'transcribe_only',
                language: 'English',
            },
            { direct, transcribe, parse },
        );

        expect(result).toEqual({
            transcript: 'Call Marc tomorrow.',
            language: 'en',
        });
        expect(direct).toHaveBeenCalledWith(expect.stringContaining('Audio language: en'));
        expect(transcribe).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
    });

    it('returns local transcription without invoking remote parsing', async () => {
        const transcribe = vi.fn(async () => 'Call Marc tomorrow.');
        const parse = vi.fn();

        await expect(runSpeechToTaskCapture(
            { provider: 'whisper', mode: 'smart_parse' },
            { transcribe, parse },
        )).resolves.toEqual({ transcript: 'Call Marc tomorrow.' });
        expect(parse).not.toHaveBeenCalled();
    });

    it('retries smart parsing once and preserves the original transcript when parsing fails', async () => {
        const transcribe = vi.fn(async () => 'Call Marc tomorrow.');
        const parse = vi.fn()
            .mockRejectedValueOnce(new Error('primary failed'))
            .mockRejectedValueOnce(new Error('retry failed'));
        const onParseFallback = vi.fn();

        const result = await runSpeechToTaskCapture(
            { provider: 'openai', mode: 'smart_parse' },
            { transcribe, parse, onParseFallback },
        );

        expect(result).toEqual({ transcript: 'Call Marc tomorrow.' });
        expect(parse).toHaveBeenNthCalledWith(1, 'Call Marc tomorrow.', undefined);
        expect(parse).toHaveBeenNthCalledWith(2, 'Call Marc tomorrow.', 'gpt-4o-mini');
        expect(onParseFallback).toHaveBeenCalledWith(expect.objectContaining({
            message: 'retry failed',
        }));
    });

    it('fills an empty parsed transcript with the original transcription', async () => {
        const result = await runSpeechToTaskCapture(
            { provider: 'openai', mode: 'smart_parse' },
            {
                transcribe: async () => 'Call Marc tomorrow.',
                parse: async () => ({
                    transcript: '',
                    title: 'Call Marc',
                }),
            },
        );

        expect(result).toEqual({
            transcript: 'Call Marc tomorrow.',
            title: 'Call Marc',
        });
    });
});
