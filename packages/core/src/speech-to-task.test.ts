import { describe, expect, it, vi } from 'vitest';

import {
    buildRemoteOpenAISpeechParseRequest,
    buildRemoteOpenAISpeechTranscriptionRequest,
    decodeRemoteOpenAISpeechParseResponse,
    decodeRemoteOpenAISpeechTranscriptionResponse,
    resolveOpenAIParseModel,
    runRemoteSpeechToTaskCapture,
    runSpeechToTaskCapture,
    type SpeechToTaskResult,
} from './speech-to-task';
import { OPENAI_DEFAULT_MODEL } from './ai/catalog';

describe('credential-free OpenAI speech projections', () => {
    it('projects multipart fields using the existing endpoint and language policy without credentials', () => {
        const config = { model: 'gpt-transcribe', language: 'English', baseUrl: 'http://localhost:8000/v1/', apiKey: 'PRIVATE_CREDENTIAL' };
        const projected = buildRemoteOpenAISpeechTranscriptionRequest(config);
        expect(projected).toEqual({ url: 'http://localhost:8000/v1/audio/transcriptions', method: 'POST', timeoutMs: 30_000,
            fields: [['model', 'gpt-transcribe'], ['languages[]', 'en'], ['response_format', 'json']] });
        expect(JSON.stringify(projected)).not.toContain(config.apiKey);
        expect(buildRemoteOpenAISpeechTranscriptionRequest({ model: 'whisper-1', language: 'es-MX' }).fields)
            .toEqual([['model', 'whisper-1'], ['language', 'es'], ['response_format', 'json']]);
        expect(buildRemoteOpenAISpeechTranscriptionRequest({ model: 'whisper-1', language: 'auto' }))
            .toMatchObject({ url: 'https://api.openai.com/v1/audio/transcriptions', fields: [['model', 'whisper-1'], ['response_format', 'json']] });
        expect(buildRemoteOpenAISpeechTranscriptionRequest({ model: 'custom', baseUrl: 'https://speech.example/custom/audio/transcriptions' }).url)
            .toBe('https://speech.example/custom/audio/transcriptions');
    });
    it('decodes transcription text with the existing trim and empty-text behavior', () => {
        expect(decodeRemoteOpenAISpeechTranscriptionResponse({ text: ' \nBuy milk\t' })).toBe('Buy milk');
        for (const value of [null, [], {}, { text: null }, { text: 42 }, { text: '  ' }])
            expect(decodeRemoteOpenAISpeechTranscriptionResponse(value)).toBe('');
    });
    it.each(['responses', 'chat'] as const)('projects the existing full smart-parse prompt and JSON format for %s', api => {
        const config = { fieldStrategy: 'description_only' as const, language: 'Spanish', now: new Date('2026-10-10T12:00:00Z'),
            timeZone: 'America/New_York', apiKey: 'PRIVATE_CREDENTIAL' };
        const request = buildRemoteOpenAISpeechParseRequest(config, 'Exact transcript', 'custom-parse-model', api);
        expect(request).toMatchObject({ url: `https://api.openai.com/v1/${api === 'responses' ? 'responses' : 'chat/completions'}`,
            method: 'POST', headers: [['Content-Type', 'application/json']], timeoutMs: 30_000 });
        const body = JSON.parse(request.body);
        expect(body).toMatchObject({ model: 'custom-parse-model', temperature: 0.2 });
        const messages = api === 'responses' ? body.input : body.messages;
        expect(messages[0].content).toContain('description_only'); expect(messages[0].content).toContain('es');
        expect(messages[0].content).toContain('Time zone: America/New_York'); expect(messages[0].content).toContain('2026-10-10');
        expect(messages[1]).toEqual({ role: 'user', content: 'Exact transcript' });
        expect(api === 'responses' ? body.text.format : body.response_format).toEqual({ type: 'json_object' });
        expect(JSON.stringify(request)).not.toContain(config.apiKey);
    });
    it('preserves every parsed field across direct Responses, message Responses and Chat replies', () => {
        const parsed: SpeechToTaskResult = { transcript: 'Full transcript', title: 'Title', description: 'Description', dueDate: '2026-10-11',
            startTime: '2026-10-10', projectTitle: 'Project', tags: ['tag'], contexts: ['context'], language: 'en' };
        const content = `\`\`\`json\n${JSON.stringify(parsed)}\n\`\`\``;
        expect(decodeRemoteOpenAISpeechParseResponse({ output_text: content }, 'responses')).toEqual(parsed);
        expect(decodeRemoteOpenAISpeechParseResponse({ output_text: ' ', output: [{ type: 'reasoning' },
            { type: 'message', content: [{ type: 'output_text', text: content }] }] }, 'responses')).toEqual(parsed);
        expect(decodeRemoteOpenAISpeechParseResponse({ output: [{ type: 'message', content: [{ type: 'text', text: content }] }] }, 'responses')).toEqual(parsed);
        expect(decodeRemoteOpenAISpeechParseResponse({ choices: [{ message: { content } }] }, 'chat')).toEqual(parsed);
    });
    it.each(['responses', 'chat'] as const)('refuses missing or malformed %s parse content', api => {
        for (const value of [null, [], {}, { output_text: 42 }, { output: [{ type: 'message', content: [{ type: 'output_text', text: 42 }] }] },
            { choices: [{ message: { content: 42 } }] }]) expect(() => decodeRemoteOpenAISpeechParseResponse(value, api)).toThrow('OpenAI returned no content.');
        const invalid = api === 'responses' ? { output_text: 'not JSON' } : { choices: [{ message: { content: 'not JSON' } }] };
        expect(() => decodeRemoteOpenAISpeechParseResponse(invalid, api)).toThrow();
    });
    it('moves the RN parse-model resolution unchanged, including legacy routing and custom models', () => {
        for (const model of [undefined, '', 'gpt-4o-mini', 'GPT-4O', 'gpt-4o-legacy']) expect(resolveOpenAIParseModel(model)).toBe(OPENAI_DEFAULT_MODEL);
        expect(resolveOpenAIParseModel('custom-model')).toBe('custom-model');
        expect(resolveOpenAIParseModel(' custom-model ')).toBe(' custom-model ');
    });
});

describe('runRemoteSpeechToTaskCapture', () => {
    it.each(['https://speech.example/v1', 'https://speech.example/v1/audio/transcriptions/'])('keeps every parse attempt on %s with the configured model', async (baseUrl) => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const fetcher: typeof fetch = async (input, init) => {
            const url = String(input);
            requests.push({ url, init });
            if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'Call dentist tomorrow' }));
            if (requests.length < 5) return new Response('Unavailable', { status: 503 });
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Call dentist', dueDate: '2026-11-14' }) } }] }));
        };
        const result = await runRemoteSpeechToTaskCapture({ provider: 'openai', model: 'custom-transcribe',
            baseUrl, apiKey: 'synthetic-custom-credential', parseModel: 'custom-chat', mode: 'smart_parse' }, {
            withOpenAIUpload: async send => send({ part: new Blob(['synthetic']) }),
        }, { fetcher });
        expect(requests.map(request => request.url)).toEqual([
            'https://speech.example/v1/audio/transcriptions', 'https://speech.example/v1/responses',
            'https://speech.example/v1/chat/completions', 'https://speech.example/v1/responses',
            'https://speech.example/v1/chat/completions',
        ]);
        for (const request of requests.slice(1)) {
            expect(JSON.parse(String(request.init?.body)).model).toBe('custom-chat');
            expect(new Headers(request.init?.headers).get('Authorization')).toBe('Bearer synthetic-custom-credential');
        }
        expect(result).toMatchObject({ title: 'Call dentist', dueDate: '2026-11-14' });
    });

    it('parses with a keyless custom server without an Authorization header', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const fetcher: typeof fetch = async (input, init) => {
            requests.push({ url: String(input), init });
            return new Response(JSON.stringify(String(input).endsWith('/audio/transcriptions')
                ? { text: 'Buy milk' } : { output_text: JSON.stringify({ title: 'Buy milk' }) }));
        };
        const result = await runRemoteSpeechToTaskCapture({ provider: 'openai', model: 'whisper', parseModel: 'local-chat',
            baseUrl: 'http://localhost:8000/v1' }, { withOpenAIUpload: async send => send({ part: new Blob(['synthetic']) }) }, { fetcher });
        expect(requests.map(request => request.url)).toEqual(['http://localhost:8000/v1/audio/transcriptions', 'http://localhost:8000/v1/responses']);
        expect(requests.every(request => !new Headers(request.init?.headers).has('Authorization'))).toBe(true);
        expect(result.title).toBe('Buy milk');
    });

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
        const config = { now: new Date('2026-08-01T12:00:00.000Z'), timeZone: 'America/New_York' };
        expect(requests[1]?.init?.body).toBe(buildRemoteOpenAISpeechParseRequest(config, 'Buy milk tomorrow', 'gpt-4o-mini', 'responses').body);
        expect(requests[2]?.init?.body).toBe(buildRemoteOpenAISpeechParseRequest(config, 'Buy milk tomorrow', 'gpt-4o-mini', 'chat').body);
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
