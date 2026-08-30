import { describe, expect, it } from 'vitest';
import {
    buildAIConfig,
    buildCopilotConfig,
    formatOpenAIExtraBodyParams,
    openAITranscribeLanguageFieldName,
    parseOpenAIExtraBodyParamsInput,
    resolveOpenAITranscribeEndpoint,
} from './ai-config';
import type { AiSettings, AppSettings } from './types';

const createSettings = (ai: AiSettings): AppSettings => ({
    ai,
});

describe('ai-config endpoint mapping', () => {
    it('maps OpenAI base URL to chat completions endpoint', () => {
        const config = buildAIConfig(
            createSettings({
                provider: 'openai',
                model: 'gpt-4o-mini',
                baseUrl: 'http://localhost:11434/v1',
            }),
            'test-key',
        );
        expect(config.endpoint).toBe('http://localhost:11434/v1/chat/completions');
    });

    it('maps llama.cpp OpenAI-compatible base URL to chat completions endpoint', () => {
        const config = buildAIConfig(
            createSettings({
                provider: 'openai',
                model: 'llama-3.2',
                baseUrl: 'http://localhost:8080/v1',
            }),
            '',
        );
        expect(config.endpoint).toBe('http://localhost:8080/v1/chat/completions');
    });

    it('keeps chat completions endpoint unchanged', () => {
        const config = buildAIConfig(
            createSettings({
                provider: 'openai',
                model: 'gpt-4o-mini',
                baseUrl: 'http://localhost:11434/v1/chat/completions/',
            }),
            'test-key',
        );
        expect(config.endpoint).toBe('http://localhost:11434/v1/chat/completions');
    });

    it('does not set endpoint for non-openai providers', () => {
        const config = buildAIConfig(
            createSettings({
                provider: 'gemini',
                model: 'gemini-2.5-flash',
                baseUrl: 'http://localhost:11434/v1',
            }),
            'test-key',
        );
        expect(config.endpoint).toBeUndefined();
    });

    it('applies OpenAI endpoint mapping to copilot config', () => {
        const config = buildCopilotConfig(
            createSettings({
                provider: 'openai',
                copilotModel: 'gpt-4o-mini',
                baseUrl: 'http://localhost:1234/v1',
                openAIExtraBodyParams: {
                    thinking: { type: 'disabled' },
                },
            }),
            'test-key',
        );
        expect(config.endpoint).toBe('http://localhost:1234/v1/chat/completions');
        expect(config.extraBodyParams).toEqual({
            thinking: { type: 'disabled' },
        });
    });

    it('runs the copilot at portable low reasoning effort to protect type-ahead latency', () => {
        const config = buildCopilotConfig(
            createSettings({ provider: 'openai', copilotModel: 'gpt-5.4-nano' }),
            'test-key',
        );
        expect(config.reasoningEffort).toBe('low');
    });

    it('passes OpenAI-compatible extra body params only for OpenAI provider configs', () => {
        const openAIConfig = buildAIConfig(
            createSettings({
                provider: 'openai',
                model: 'glm-4.5-flash',
                openAIExtraBodyParams: {
                    thinking: { type: 'disabled' },
                },
            }),
            '',
        );
        expect(openAIConfig.extraBodyParams).toEqual({
            thinking: { type: 'disabled' },
        });

        const geminiConfig = buildAIConfig(
            createSettings({
                provider: 'gemini',
                model: 'gemini-2.5-flash',
                openAIExtraBodyParams: {
                    thinking: { type: 'disabled' },
                },
            }),
            'test-key',
        );
        expect(geminiConfig.extraBodyParams).toBeUndefined();
    });

    it('parses OpenAI-compatible extra body params from JSON object input', () => {
        const result = parseOpenAIExtraBodyParamsInput('{ "thinking": { "type": "disabled" } }');

        expect(result).toEqual({
            ok: true,
            value: {
                thinking: { type: 'disabled' },
            },
        });
    });

    it('rejects non-object OpenAI-compatible extra body params input', () => {
        expect(parseOpenAIExtraBodyParamsInput('[]')).toMatchObject({ ok: false });
        expect(parseOpenAIExtraBodyParamsInput('not json')).toMatchObject({ ok: false });
    });

    it('formats OpenAI-compatible extra body params for settings editing', () => {
        expect(formatOpenAIExtraBodyParams({
            thinking: { type: 'disabled' },
        })).toBe('{\n  "thinking": {\n    "type": "disabled"\n  }\n}');
        expect(formatOpenAIExtraBodyParams({})).toBe('');
    });
});

describe('resolveOpenAITranscribeEndpoint', () => {
    it('defaults to the official OpenAI transcription endpoint when no base URL is set', () => {
        expect(resolveOpenAITranscribeEndpoint(undefined)).toBe('https://api.openai.com/v1/audio/transcriptions');
        expect(resolveOpenAITranscribeEndpoint('')).toBe('https://api.openai.com/v1/audio/transcriptions');
    });

    it('appends the transcription path to a self-hosted base URL', () => {
        expect(resolveOpenAITranscribeEndpoint('http://localhost:8000/v1'))
            .toBe('http://localhost:8000/v1/audio/transcriptions');
    });

    it('does not double-append when the base URL already ends in the transcription path', () => {
        expect(resolveOpenAITranscribeEndpoint('http://localhost:8000/v1/audio/transcriptions/'))
            .toBe('http://localhost:8000/v1/audio/transcriptions');
    });
});

describe('openAITranscribeLanguageFieldName', () => {
    it('uses the languages array field for gpt-transcribe-generation models', () => {
        expect(openAITranscribeLanguageFieldName('gpt-transcribe')).toBe('languages[]');
    });

    it('keeps the singular language field for earlier models', () => {
        expect(openAITranscribeLanguageFieldName('whisper-1')).toBe('language');
        expect(openAITranscribeLanguageFieldName('gpt-4o-transcribe')).toBe('language');
        expect(openAITranscribeLanguageFieldName('gpt-4o-mini-transcribe')).toBe('language');
    });
});
