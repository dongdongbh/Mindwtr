import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelOptions, type AppData } from '@mindwtr/core';

import { AISettingsScreen } from './ai-settings-screen';

const constantsState = vi.hoisted(() => ({ isFossBuild: false }));
const storeState = vi.hoisted(() => ({
    settings: {} as AppData['settings'],
    updateSettings: vi.fn(async () => undefined),
}));
const coreMocks = vi.hoisted(() => ({ fetchProviderModelsCached: vi.fn() }));
const aiConfigMocks = vi.hoisted(() => ({ loadAIKey: vi.fn(), saveAIKey: vi.fn() }));
const captured = vi.hoisted(() => ({ assistant: [] as Record<string, any>[] }));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const { mockCore } = await import('../../test-support/mock-core');
    return mockCore(importOriginal, () => storeState, {
        fetchProviderModelsCached: coreMocks.fetchProviderModelsCached,
    });
});

vi.mock('expo-constants', () => ({
    default: {
        get expoConfig() {
            return { extra: { isFossBuild: constantsState.isFossBuild } };
        },
        appOwnership: 'standalone',
    },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => undefined),
    },
}));

vi.mock('@/lib/ai-config', () => ({
    loadAIKey: aiConfigMocks.loadAIKey,
    saveAIKey: aiConfigMocks.saveAIKey,
}));

vi.mock('@/lib/whisper-model-store', () => ({
    locateSync: () => null,
    locate: async () => ({ exists: false, uri: '', size: 0 }),
    getPreferredModelUri: (id: string) => `file:///models/${id}`,
    download: vi.fn(),
    remove: vi.fn(),
}));

vi.mock('@/contexts/toast-context', () => ({
    ToastViewport: () => null,
    useToast: () => ({ dismissToast: vi.fn(), showToast: vi.fn() }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({
        bg: '#0f172a',
        cardBg: '#111827',
        filterBg: '#1f2937',
        border: '#334155',
        text: '#f8fafc',
        tint: '#3b82f6',
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('./settings.hooks', () => ({
    useSettingsLocalization: () => ({
        isChineseLanguage: false,
        language: 'en',
        t: (key: string) => key,
        tr: (key: string) => key,
    }),
    useSettingsScrollContent: () => ({}),
}));

vi.mock('./settings.shell', () => ({
    SettingsTopBar: () => React.createElement('SettingsTopBar'),
}));

// The cards only need to expose the option arrays the pickers render.
vi.mock('./ai-settings-assistant-card', () => ({
    AiSettingsAssistantCard: (props: Record<string, any>) => {
        captured.assistant.push(props);
        return null;
    },
}));

vi.mock('./ai-settings-speech-card', () => ({
    AiSettingsSpeechCard: () => null,
}));

// The fetch effects debounce, and a key that arrives asynchronously only
// schedules its timer on the render after it lands — hence two passes.
const settle = async () => {
    for (let pass = 0; pass < 2; pass += 1) {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
    }
};

const renderScreen = async (settings: AppData['settings']) => {
    storeState.settings = settings;
    await act(async () => {
        renderer.create(React.createElement(AISettingsScreen));
    });
    await settle();
    return () => captured.assistant[captured.assistant.length - 1];
};

const localWhisperSpeech = { provider: 'whisper' as const, model: 'whisper-tiny' };

describe('AISettingsScreen live model lists', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        captured.assistant.length = 0;
        constantsState.isFossBuild = false;
        aiConfigMocks.loadAIKey.mockResolvedValue('sk-test');
        aiConfigMocks.saveAIKey.mockResolvedValue(undefined);
        coreMocks.fetchProviderModelsCached.mockResolvedValue([]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('offers the fetched chat models with the selected models first', async () => {
        coreMocks.fetchProviderModelsCached.mockResolvedValue(['live-a', 'live-b']);

        const latest = await renderScreen({
            ai: {
                provider: 'openai',
                model: 'my-model',
                copilotModel: 'my-copilot',
                speechToText: localWhisperSpeech,
            },
        });

        expect(latest().aiModelOptions).toEqual(['my-model', 'live-a', 'live-b']);
        expect(latest().aiCopilotOptions).toEqual(['my-copilot', 'live-a', 'live-b']);
        expect(latest().aiRequestTimeoutSeconds).toBe(30);
        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith('openai', {
            apiKey: 'sk-test',
            baseUrl: '',
            kind: 'chat',
        });
        // Whisper is a local sha256-pinned catalog.
        expect(coreMocks.fetchProviderModelsCached).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ kind: 'transcription' }),
        );
    });

    it('passes through a persisted timeout and preserves sibling AI settings when changing it', async () => {
        const latest = await renderScreen({
            ai: {
                enabled: true,
                provider: 'openai',
                model: 'my-model',
                requestTimeoutSeconds: 120,
                speechToText: localWhisperSpeech,
            },
        });

        expect(latest().aiRequestTimeoutSeconds).toBe(120);
        storeState.updateSettings.mockClear();
        await act(async () => {
            latest().onAiRequestTimeoutSecondsChange(300);
        });

        expect(storeState.updateSettings).toHaveBeenCalledWith({
            ai: {
                enabled: true,
                provider: 'openai',
                model: 'my-model',
                requestTimeoutSeconds: 300,
                speechToText: localWhisperSpeech,
            },
        });
    });

    it('keeps the static catalog when the fetch fails', async () => {
        coreMocks.fetchProviderModelsCached.mockRejectedValue(new Error('offline'));

        const latest = await renderScreen({
            ai: { provider: 'gemini', speechToText: localWhisperSpeech },
        });

        expect(latest().aiModelOptions).toEqual(getModelOptions('gemini'));
    });

    it('never calls a provider on a FOSS build without a base URL', async () => {
        constantsState.isFossBuild = true;

        const latest = await renderScreen({
            ai: { provider: 'openai', speechToText: localWhisperSpeech },
        });

        expect(coreMocks.fetchProviderModelsCached).not.toHaveBeenCalled();
        expect(latest().aiModelOptions).toEqual(['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini']);
    });

    it('lists a FOSS build local server models from its base URL', async () => {
        constantsState.isFossBuild = true;
        coreMocks.fetchProviderModelsCached.mockResolvedValue(['qwen3:8b']);

        const latest = await renderScreen({
            ai: {
                provider: 'openai',
                baseUrl: 'http://10.0.0.5:11434/v1',
                model: 'qwen3:8b',
                speechToText: localWhisperSpeech,
            },
        });

        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith('openai', {
            apiKey: 'sk-test',
            baseUrl: 'http://10.0.0.5:11434/v1',
            kind: 'chat',
        });
        expect(latest().aiModelOptions).toEqual(['qwen3:8b']);
    });

    it('lists Gemini speech models from its chat models', async () => {
        await renderScreen({
            ai: {
                provider: 'gemini',
                speechToText: { provider: 'gemini', model: 'gemini-3.5-flash' },
            },
        });

        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith('gemini', {
            apiKey: 'sk-test',
            baseUrl: '',
            kind: 'chat',
        });
    });
});
