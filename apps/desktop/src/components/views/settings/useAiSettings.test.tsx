import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelOptions, useTaskStore } from '@mindwtr/core';
import type { AppData } from '@mindwtr/core';

import { useAiSettings } from './useAiSettings';
import { useUiStore } from '../../../store/ui-store';

type HookResult = ReturnType<typeof useAiSettings>;

const fsMocks = vi.hoisted(() => ({
    exists: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    size: vi.fn(),
    writeFile: vi.fn(),
}));

const pathMocks = vi.hoisted(() => ({
    dataDir: vi.fn(),
    join: vi.fn(),
}));

const tauriCoreMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
    listen: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
    fetchProviderModelsCached: vi.fn(),
}));

const aiConfigMocks = vi.hoisted(() => ({
    loadAIKey: vi.fn(async (_provider: string) => ''),
    saveAIKey: vi.fn(async () => undefined),
}));

const languageMocks = vi.hoisted(() => ({
    t: vi.fn((key: string) => key),
}));

vi.mock('../../../contexts/language-context', () => ({
    useLanguage: () => ({ t: languageMocks.t, language: 'en' }),
}));

vi.mock('../../../lib/ai-config', () => ({
    loadAIKey: aiConfigMocks.loadAIKey,
    saveAIKey: aiConfigMocks.saveAIKey,
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    fetchProviderModelsCached: coreMocks.fetchProviderModelsCached,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Data: 'Data' },
    exists: fsMocks.exists,
    mkdir: fsMocks.mkdir,
    remove: fsMocks.remove,
    size: fsMocks.size,
    writeFile: fsMocks.writeFile,
}));

vi.mock('@tauri-apps/api/path', () => ({
    dataDir: pathMocks.dataDir,
    join: pathMocks.join,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriCoreMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: eventMocks.listen,
}));

const settingsWithSpeech = (speechToText: NonNullable<NonNullable<AppData['settings']['ai']>['speechToText']>): AppData['settings'] => ({
    ai: {
        speechToText,
    },
});

const initialTaskState = useTaskStore.getState();

describe('useAiSettings speech provider changes', () => {
    afterEach(() => {
        useTaskStore.setState(initialTaskState, true);
    });

    beforeEach(() => {
        vi.clearAllMocks();
        languageMocks.t.mockImplementation((key: string) => key);
        // The model downloads go through the shared native-invoke adapter, which
        // refuses outside the desktop shell.
        (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        fsMocks.exists.mockResolvedValue(false);
        fsMocks.mkdir.mockResolvedValue(undefined);
        fsMocks.remove.mockResolvedValue(undefined);
        fsMocks.size.mockResolvedValue(0);
        fsMocks.writeFile.mockResolvedValue(undefined);
        pathMocks.dataDir.mockResolvedValue('/home/dd/.local/share');
        pathMocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
        tauriCoreMocks.invoke.mockResolvedValue(null);
        eventMocks.listen.mockResolvedValue(vi.fn());
        coreMocks.fetchProviderModelsCached.mockResolvedValue([]);
    });

    it('shows localized safe feedback when saving AI settings fails', async () => {
        let result: HookResult | null = null;
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        languageMocks.t.mockImplementation((key: string) => (
            key === 'settings.feedback.saveFailed' ? 'Impossible d’enregistrer ce réglage.' : key
        ));

        function Probe() {
            result = useAiSettings({
                isTauri: false,
                settings: { ai: {} },
                updateSettings: vi.fn(async () => { throw new Error('provider detail'); }),
                showSaved: vi.fn(),
                enabled: false,
            });
            return null;
        }

        render(<Probe />);
        act(() => {
            result?.onUpdateAISettings({ enabled: true });
        });

        await waitFor(() => {
            expect(showToast).toHaveBeenCalledWith('Impossible d’enregistrer ce réglage.', 'error');
        });
        expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('provider detail'), expect.anything());
    });

    afterEach(() => {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('loads provider keys only after the AI page becomes active', async () => {
        const settings: AppData['settings'] = {
            ai: { provider: 'gemini', speechToText: { provider: 'openai' } },
        };

        function Probe({ enabled }: { enabled: boolean }) {
            useAiSettings({
                isTauri: false,
                settings,
                updateSettings: vi.fn(async () => undefined),
                showSaved: vi.fn(),
                enabled,
            });
            return null;
        }

        const view = render(<Probe enabled={false} />);
        expect(aiConfigMocks.loadAIKey).not.toHaveBeenCalled();

        view.rerender(<Probe enabled />);

        await waitFor(() => {
            expect(aiConfigMocks.loadAIKey).toHaveBeenCalledWith('gemini');
            expect(aiConfigMocks.loadAIKey).toHaveBeenCalledWith('openai');
        });
    });

    it('does not reuse a Whisper model file path when switching to Parakeet', () => {
        let result: HookResult | null = null;
        const updateSettings = vi.fn(async () => undefined);
        const settings = settingsWithSpeech({
            provider: 'whisper',
            model: 'whisper-base',
            offlineModelPath: '/home/dd/.local/share/mindwtr/whisper-models/ggml-base.bin',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: false,
                settings,
                updateSettings,
                showSaved: vi.fn(),
                enabled: false,
            });
            return null;
        }

        render(<Probe />);

        act(() => {
            result?.onSpeechProviderChange('parakeet');
        });

        expect(updateSettings).toHaveBeenCalledWith({
            ai: {
                speechToText: {
                    provider: 'parakeet',
                    model: 'parakeet-tdt-0.6b-v3-int8',
                    offlineModelPath: undefined,
                },
            },
        });
    });

    it('shows the default Parakeet model folder without marking it ready before install', async () => {
        let result: HookResult | null = null;
        const updateSettings = vi.fn(async () => undefined);
        const settings = settingsWithSpeech({
            provider: 'parakeet',
            model: 'parakeet-tdt-0.6b-v3-int8',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings,
                showSaved: vi.fn(),
            });
            return (
                <output data-testid="speech-state">
                    {JSON.stringify({
                        path: result.speechOfflineModelPath,
                        ready: result.speechOfflineReady,
                    })}
                </output>
            );
        }

        render(<Probe />);

        await waitFor(() => {
            expect(screen.getByTestId('speech-state').textContent).toContain('/home/dd/.local/share/mindwtr/parakeet-model');
        });
        expect(JSON.parse(screen.getByTestId('speech-state').textContent ?? '{}')).toMatchObject({
            path: '/home/dd/.local/share/mindwtr/parakeet-model',
            ready: false,
        });
        expect(updateSettings).not.toHaveBeenCalled();
    });


    it('tracks Parakeet download progress events', async () => {
        let result: HookResult | null = null;
        let progressHandler: ((event: { payload: { stage: string; loaded: number; total: number; percent: number } }) => void) | null = null;
        eventMocks.listen.mockImplementation(async (_event: string, handler: typeof progressHandler) => {
            progressHandler = handler;
            return vi.fn();
        });
        const settings = settingsWithSpeech({
            provider: 'parakeet',
            model: 'parakeet-tdt-0.6b-v3-int8',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings: vi.fn(async () => undefined),
                showSaved: vi.fn(),
            });
            return null;
        }

        render(<Probe />);

        await waitFor(() => {
            expect(eventMocks.listen).toHaveBeenCalledWith('parakeet-model-download-progress', expect.any(Function));
        });

        act(() => {
            progressHandler?.({
                payload: {
                    stage: 'model_download',
                    loaded: 50,
                    total: 100,
                    percent: 50,
                },
            });
        });

        const readResult = () => result as unknown as HookResult;
        expect(readResult().speechDownloadProgress).toEqual({
            stage: 'model_download',
            loaded: 50,
            total: 100,
            percent: 50,
        });
    });

    it('tracks Whisper download progress events', async () => {
        let result: HookResult | null = null;
        let progressHandler: ((event: { payload: { stage: string; loaded: number; total: number; percent: number } }) => void) | null = null;
        eventMocks.listen.mockImplementation(async (event: string, handler: typeof progressHandler) => {
            if (event === 'whisper-model-download-progress') {
                progressHandler = handler;
            }
            return vi.fn();
        });
        const settings = settingsWithSpeech({
            provider: 'whisper',
            model: 'whisper-tiny',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings: vi.fn(async () => undefined),
                showSaved: vi.fn(),
            });
            return null;
        }

        render(<Probe />);

        await waitFor(() => {
            expect(eventMocks.listen).toHaveBeenCalledWith('whisper-model-download-progress', expect.any(Function));
        });

        act(() => {
            progressHandler?.({
                payload: {
                    stage: 'model_download',
                    loaded: 50,
                    total: 100,
                    percent: 50,
                },
            });
        });

        const readResult = () => result as unknown as HookResult;
        expect(readResult().speechDownloadProgress).toEqual({
            stage: 'model_download',
            loaded: 50,
            total: 100,
            percent: 50,
        });
    });

    it('downloads Whisper through the native command and stores the installed model path', async () => {
        let result: HookResult | null = null;
        const updateSettings = vi.fn(async () => undefined);
        const showSaved = vi.fn();
        const installedPath = '/home/dd/.local/share/mindwtr/whisper-models/ggml-tiny.bin';
        tauriCoreMocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'download_whisper_model') return installedPath;
            return null;
        });
        const settings = settingsWithSpeech({
            provider: 'whisper',
            model: 'whisper-tiny',
        });
        // The write is built on the stored settings, which the page renders.
        useTaskStore.setState({ settings });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings,
                showSaved,
            });
            return null;
        }

        render(<Probe />);

        await act(async () => {
            await result?.onDownloadWhisperModel();
        });

        expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('download_whisper_model', {
            model: 'whisper-tiny',
        });
        expect(updateSettings).toHaveBeenCalledWith({
            ai: {
                speechToText: {
                    provider: 'whisper',
                    model: 'whisper-tiny',
                    offlineModelPath: installedPath,
                },
            },
        });
        expect(showSaved).toHaveBeenCalled();
    });

    it('downloads Parakeet into the default folder and stores the installed model path', async () => {
        let result: HookResult | null = null;
        const updateSettings = vi.fn(async () => undefined);
        const showSaved = vi.fn();
        const installedPath = '/home/dd/.local/share/mindwtr/parakeet-model';
        tauriCoreMocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'download_parakeet_model') return installedPath;
            return null;
        });
        const settings = settingsWithSpeech({
            provider: 'parakeet',
            model: 'parakeet-tdt-0.6b-v3-int8',
        });
        useTaskStore.setState({ settings });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings,
                showSaved,
            });
            return null;
        }

        render(<Probe />);

        await waitFor(() => {
            expect(result?.speechOfflineModelPath).toBe(installedPath);
        });

        await act(async () => {
            await result?.onDownloadWhisperModel();
        });

        expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('download_parakeet_model', {
            model: 'parakeet-tdt-0.6b-v3-int8',
        });
        expect(updateSettings).toHaveBeenCalledWith({
            ai: {
                speechToText: {
                    provider: 'parakeet',
                    model: 'parakeet-tdt-0.6b-v3-int8',
                    offlineModelPath: installedPath,
                },
            },
        });
        expect(showSaved).toHaveBeenCalled();
    });
});

describe('useAiSettings live model lists', () => {
    // A base URL is the credential-free trigger (self-hosted servers, #930), so
    // these render without waiting for the async key load.
    const localOpenAiSettings = (
        extra: Partial<NonNullable<AppData['settings']['ai']>> = {}
    ): AppData['settings'] => ({
        ai: {
            enabled: true,
            provider: 'openai',
            baseUrl: 'http://localhost:1234/v1',
            model: 'my-local-model',
            ...extra,
        },
    });

    function Probe({ settings }: { settings: AppData['settings'] }) {
        const result = useAiSettings({
            isTauri: false,
            settings,
            updateSettings: vi.fn(async () => undefined),
            showSaved: vi.fn(),
        });
        return (
            <output data-testid="options">
                {JSON.stringify({
                    model: result.aiModelOptions,
                    copilot: result.aiCopilotOptions,
                    speech: result.speechModelOptions,
                })}
            </output>
        );
    }

    const read = () => JSON.parse(screen.getByTestId('options').textContent ?? '{}');

    // The fetch effects debounce, so nothing is in flight until the timer runs —
    // and a key that arrives asynchronously only schedules its timer on the
    // render after it lands, hence two passes.
    const settle = async () => {
        for (let pass = 0; pass < 2; pass += 1) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(600);
            });
        }
    };

    const renderOptions = async (settings: AppData['settings']) => {
        const view = render(<Probe settings={settings} />);
        await settle();
        return view;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        fsMocks.exists.mockResolvedValue(false);
        fsMocks.size.mockResolvedValue(0);
        pathMocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
        eventMocks.listen.mockResolvedValue(vi.fn());
        coreMocks.fetchProviderModelsCached.mockResolvedValue([]);
        aiConfigMocks.loadAIKey.mockImplementation(async () => '');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('offers the fetched chat models, keeping a listed selection in place', async () => {
        coreMocks.fetchProviderModelsCached.mockResolvedValue(['live-a', 'live-b']);

        await renderOptions(localOpenAiSettings({ copilotModel: 'live-b' }));

        expect(read().model).toEqual(['my-local-model', 'live-a', 'live-b']);
        expect(read().copilot).toEqual(['live-a', 'live-b']);
        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith('openai', {
            apiKey: '',
            baseUrl: 'http://localhost:1234/v1',
            kind: 'chat',
        });
    });

    it('keeps the static catalog when the fetch fails', async () => {
        coreMocks.fetchProviderModelsCached.mockRejectedValue(new Error('offline'));

        await renderOptions(localOpenAiSettings());

        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalled();
        expect(read().model).toEqual(['my-local-model', ...getModelOptions('openai')]);
    });

    it('keeps the static catalog when the provider lists nothing', async () => {
        coreMocks.fetchProviderModelsCached.mockResolvedValue([]);

        await renderOptions(localOpenAiSettings());

        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalled();
        expect(read().model).toEqual(['my-local-model', ...getModelOptions('openai')]);
    });

    it('fetches transcription models for a self-hosted speech server', async () => {
        coreMocks.fetchProviderModelsCached.mockResolvedValue(['live-whisper']);

        await renderOptions(localOpenAiSettings({
            speechToText: { provider: 'openai', model: 'whisper-1', baseUrl: 'http://localhost:9000/v1' },
        }));

        expect(read().speech).toEqual(['whisper-1', 'live-whisper']);
        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith('openai', {
            apiKey: '',
            baseUrl: 'http://localhost:9000/v1',
            kind: 'transcription',
        });
    });

    it('requests Gemini speech models with the transcription capability', async () => {
        aiConfigMocks.loadAIKey.mockResolvedValue('g-key');

        await renderOptions({
            ai: {
                enabled: true,
                provider: 'gemini',
                speechToText: { provider: 'gemini' },
            },
        });

        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith('gemini', {
            apiKey: 'g-key',
            baseUrl: '',
            kind: 'transcription',
        });
    });

    it('never fetches for the local Whisper and Parakeet catalogs', async () => {
        coreMocks.fetchProviderModelsCached.mockResolvedValue(['live-a']);

        await renderOptions(localOpenAiSettings({
            speechToText: { provider: 'whisper', model: 'whisper-tiny' },
        }));

        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledTimes(1);
        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith('openai', expect.objectContaining({ kind: 'chat' }));
        expect(coreMocks.fetchProviderModelsCached).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ kind: 'transcription' })
        );
    });

    it('asks no provider for models before AI is turned on with it (consent)', async () => {
        aiConfigMocks.loadAIKey.mockResolvedValue('sk-entered');
        const aiOff: AppData['settings'] = {
            ai: {
                provider: 'openai',
                baseUrl: 'http://localhost:1234/v1',
                speechToText: { provider: 'gemini' },
            },
        };

        const { rerender } = await renderOptions(aiOff);
        expect(coreMocks.fetchProviderModelsCached).not.toHaveBeenCalled();

        // Turning AI on is this device's consent for its provider only; the
        // Gemini speech provider was never agreed to.
        rerender(<Probe settings={{ ai: { ...aiOff.ai, enabled: true } }} />);
        await settle();
        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith('openai', expect.objectContaining({ kind: 'chat' }));
        expect(coreMocks.fetchProviderModelsCached).not.toHaveBeenCalledWith('gemini', expect.anything());
    });

    it('does not call any provider without a key or base URL', async () => {
        await renderOptions({ ai: { enabled: true, provider: 'gemini' } });

        expect(coreMocks.fetchProviderModelsCached).not.toHaveBeenCalled();
        expect(read().model).toEqual(getModelOptions('gemini'));
    });

    it('waits for the new provider key instead of reusing the previous one', async () => {
        aiConfigMocks.loadAIKey.mockImplementation(async (provider: string) => {
            // Gemini's key never arrives, so a stale OpenAI key is the only one
            // the fetch could possibly reach for.
            if (provider !== 'openai') return await new Promise<string>(() => {});
            return 'sk-openai';
        });

        const { rerender } = await renderOptions({ ai: { enabled: true, provider: 'openai' } });
        expect(coreMocks.fetchProviderModelsCached).toHaveBeenCalledWith(
            'openai',
            expect.objectContaining({ apiKey: 'sk-openai' })
        );

        coreMocks.fetchProviderModelsCached.mockClear();
        rerender(<Probe settings={{ ai: { enabled: true, provider: 'gemini' } }} />);
        await settle();

        expect(coreMocks.fetchProviderModelsCached).not.toHaveBeenCalledWith(
            'gemini',
            expect.objectContaining({ apiKey: 'sk-openai' })
        );
        expect(coreMocks.fetchProviderModelsCached).not.toHaveBeenCalled();
    });
});
