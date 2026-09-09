import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiSettings, AppSettings } from '@mindwtr/core';
import { buildAIConfig, buildCopilotConfig, isAIKeyRequired } from './ai-config';

const isTauriRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const nativeFetchMock = vi.hoisted(() => vi.fn());
const logInfoMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock('./app-log', () => ({ logInfo: logInfoMock, logError: vi.fn() }));

vi.mock('./runtime', () => ({
    isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock('@tauri-apps/plugin-http', () => ({
    fetch: nativeFetchMock,
}));

const createSettings = (ai: AiSettings): AppSettings => ({ ai });

beforeEach(() => {
    isTauriRuntimeMock.mockReturnValue(false);
    nativeFetchMock.mockReset();
    logInfoMock.mockReset().mockResolvedValue(null);
});

describe('isAIKeyRequired', () => {
    it('requires key for default OpenAI endpoint', () => {
        expect(isAIKeyRequired(createSettings({
            provider: 'openai',
            model: 'gpt-4o-mini',
        }))).toBe(true);
    });

    it('does not require key for custom OpenAI-compatible endpoint', () => {
        expect(isAIKeyRequired(createSettings({
            provider: 'openai',
            model: 'llama3.2',
            baseUrl: 'http://localhost:11434/v1',
        }))).toBe(false);
    });

    it('requires key for non-openai providers', () => {
        expect(isAIKeyRequired(createSettings({
            provider: 'gemini',
            model: 'gemini-2.5-flash',
        }))).toBe(true);
    });
});

describe('buildAIConfig', () => {
    it('does not surface a diagnostics backend failure after cancellation', async () => {
        isTauriRuntimeMock.mockReturnValue(true);
        logInfoMock.mockRejectedValueOnce(new Error('diagnostics unavailable'));
        const config = await buildAIConfig(createSettings({ provider: 'openai' }), '');
        expect(() => config.onRequestStop?.('aborted')).not.toThrow();
        await Promise.resolve();
    });

    it.each([buildAIConfig, buildCopilotConfig])('logs only safe stop metadata for assistant and Copilot requests', async (buildConfig) => {
        isTauriRuntimeMock.mockReturnValue(true);
        const config = await buildConfig(createSettings({
            provider: 'openai',
            baseUrl: 'http://localhost:11434/v1',
            model: 'private-model',
            requestTimeoutSeconds: 120,
        }), 'private-credential');
        expect(config.timeoutMs).toBe(120_000);
        expect(logInfoMock).not.toHaveBeenCalled();
        config.onRequestStop?.('timeout');
        expect(logInfoMock).toHaveBeenCalledExactlyOnceWith('AI request stopped without retry', {
            scope: 'ai',
            extra: {
                releaseCheck: 'v1.3.0/ai-request-stop-once',
                outcome: 'timeout',
                provider: 'openai',
                timeoutMs: 120_000,
            },
        });
    });

    it('uses Tauri native HTTP fetch in the desktop runtime', async () => {
        isTauriRuntimeMock.mockReturnValue(true);

        const config = await buildAIConfig(createSettings({
            provider: 'openai',
            model: 'gpt-4o-mini',
        }), 'test-key');

        expect(config.fetcher).toBe(nativeFetchMock);
    });
});
