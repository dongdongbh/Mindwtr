import { useCallback, useEffect, useState } from 'react';
import type { AIProviderId, AIReasoningEffort, AiSettings, AppData, AudioCaptureMode, AudioFieldStrategy } from '@mindwtr/core';
import {
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    fetchProviderModelsCached,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getCopilotModelOptions,
    getModelOptions,
    mergeModelOptions,
    resolveAIRequestTimeoutSeconds,
} from '@mindwtr/core';
import { exists, remove, size } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { getManagedPath } from '../../../lib/managed-paths';
import { loadAIKey, saveAIKey } from '../../../lib/ai-config';
import { downloadParakeetModel, downloadWhisperModel } from '../../../lib/speech-to-text';
import { markSettingsOpenTrace, measureSettingsOpenStep } from '../../../lib/settings-open-diagnostics';
import { useUiStore } from '../../../store/ui-store';
import { useLanguage } from '../../../contexts/language-context';
import { reportSettingsFailure, resolveSettingsFeedback } from './settings-feedback';
import {
    DEFAULT_PARAKEET_MODEL,
    DEFAULT_WHISPER_MODEL,
    GEMINI_SPEECH_MODELS,
    OPENAI_SPEECH_MODELS,
    PARAKEET_MODELS,
    PARAKEET_MODEL_INSTALL_DIR,
    PARAKEET_REQUIRED_FILES,
    WHISPER_MODELS,
} from '../../../lib/speech-models';

type UseAiSettingsOptions = {
    isTauri: boolean;
    settings: AppData['settings'] | undefined;
    updateSettings: (next: Partial<AppData['settings']>) => Promise<void>;
    showSaved: () => void;
    enabled?: boolean;
};

// Typing a key by hand would otherwise fire one list request per keystroke.
const MODEL_FETCH_DEBOUNCE_MS = 400;

// A loaded key belongs to the provider it was loaded for. Effects in one commit
// all see that commit's values, so a bare `key` string would still be the old
// provider's secret on the render where the provider flipped — tagging it lets
// the fetch gate itself off until the matching key arrives.
type LoadedKey = { provider: string; value: string };

type AiSettingsUpdate = Partial<AiSettings>;
type SpeechSettings = NonNullable<AiSettings['speechToText']>;
type SpeechSettingsUpdate = Partial<SpeechSettings>;
type SpeechProvider = NonNullable<SpeechSettings['provider']>;
type SpeechDownloadProgress = {
    stage: string;
    loaded: number;
    total?: number | null;
    percent?: number | null;
};

export function useAiSettings({ isTauri, settings, updateSettings, showSaved, enabled = true }: UseAiSettingsOptions) {
    const [aiKey, setAiKey] = useState<LoadedKey>({ provider: '', value: '' });
    const [speechKey, setSpeechKey] = useState<LoadedKey>({ provider: '', value: '' });
    const [speechDownloadState, setSpeechDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
    const [speechDownloadError, setSpeechDownloadError] = useState<string | null>(null);
    const [speechOfflinePath, setSpeechOfflinePath] = useState<string | null>(null);
    const [speechOfflineSize, setSpeechOfflineSize] = useState<number | null>(null);
    const [speechOfflineReadyState, setSpeechOfflineReadyState] = useState(false);
    const [speechDownloadProgress, setSpeechDownloadProgress] = useState<SpeechDownloadProgress | null>(null);
    // Live provider model lists (#986). null = nothing fetched yet or the fetch
    // failed, which mergeModelOptions degrades to the static catalog.
    const [fetchedChatModels, setFetchedChatModels] = useState<string[] | null>(null);
    const [fetchedSpeechModels, setFetchedSpeechModels] = useState<string[] | null>(null);
    const showToast = useUiStore((state) => state.showToast);
    const { t } = useLanguage();
    const resolveFeedback = useCallback((key: string, fallback: string) => (
        resolveSettingsFeedback(t, key, fallback)
    ), [t]);
    const saveFailedMessage = resolveFeedback(
        'settings.feedback.saveFailed',
        "Couldn't save this setting. Try again.",
    );

    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const aiApiKey = aiKey.provider === aiProvider ? aiKey.value : '';
    const aiEnabled = settings?.ai?.enabled === true;
    const aiDefaults = getDefaultAIConfig(aiProvider);
    const aiModel = settings?.ai?.model ?? aiDefaults.model;
    const aiBaseUrl = settings?.ai?.baseUrl ?? '';
    const aiOpenAIExtraBodyParams = settings?.ai?.openAIExtraBodyParams;
    const aiReasoningEffort = (settings?.ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT) as AIReasoningEffort;
    const aiThinkingBudget = settings?.ai?.thinkingBudget ?? aiDefaults.thinkingBudget ?? DEFAULT_GEMINI_THINKING_BUDGET;
    const anthropicThinkingEnabled = aiProvider === 'anthropic' && aiThinkingBudget > 0;
    const aiModelOptions = mergeModelOptions(fetchedChatModels, getModelOptions(aiProvider), aiModel);
    const aiCopilotModel = settings?.ai?.copilotModel ?? getDefaultCopilotModel(aiProvider);
    const aiCopilotOptions = mergeModelOptions(fetchedChatModels, getCopilotModelOptions(aiProvider), aiCopilotModel);
    const aiRequestTimeoutSeconds = resolveAIRequestTimeoutSeconds(settings?.ai?.requestTimeoutSeconds);

    const speechSettings = settings?.ai?.speechToText ?? {};
    const speechProvider = speechSettings.provider ?? 'gemini';
    const speechApiKey = speechKey.provider === speechProvider ? speechKey.value : '';
    const speechEnabled = speechSettings.enabled === true;
    const speechModel = speechSettings.model ?? (
        speechProvider === 'openai'
            ? OPENAI_SPEECH_MODELS[0]
            : speechProvider === 'gemini'
                ? GEMINI_SPEECH_MODELS[0]
                : speechProvider === 'parakeet'
                    ? DEFAULT_PARAKEET_MODEL
                    : DEFAULT_WHISPER_MODEL
    );
    const speechBaseUrl = speechSettings.baseUrl ?? '';
    const speechLanguage = speechSettings.language ?? '';
    const speechMode = (speechSettings.mode ?? 'smart_parse') as AudioCaptureMode;
    const speechFieldStrategy = (speechSettings.fieldStrategy ?? 'smart') as AudioFieldStrategy;
    const staticSpeechModelOptions = speechProvider === 'openai'
        ? OPENAI_SPEECH_MODELS
        : speechProvider === 'gemini'
            ? GEMINI_SPEECH_MODELS
            : speechProvider === 'parakeet'
                ? PARAKEET_MODELS.map((model) => model.id)
                : WHISPER_MODELS.map((model) => model.id);
    const speechModelOptions = mergeModelOptions(fetchedSpeechModels, staticSpeechModelOptions, speechModel);

    const selectedLocalSpeechModelSize = speechProvider === 'whisper'
        ? WHISPER_MODELS.find((model) => model.id === speechModel)?.sizeBytes ?? null
        : speechProvider === 'parakeet'
            ? PARAKEET_MODELS.find((model) => model.id === speechModel)?.sizeBytes ?? null
            : null;

    const updateAISettings = useCallback((next: AiSettingsUpdate) => {
        updateSettings({ ai: { ...(settings?.ai ?? {}), ...next } })
            .then(showSaved)
            .catch((error) => reportSettingsFailure('Failed to update AI settings', error, saveFailedMessage));
    }, [saveFailedMessage, settings?.ai, showSaved, updateSettings]);

    const updateSpeechSettings = useCallback((next: SpeechSettingsUpdate) => {
        updateSettings({
            ai: {
                ...(settings?.ai ?? {}),
                speechToText: { ...(settings?.ai?.speechToText ?? {}), ...next },
            },
        })
            .then(showSaved)
            .catch((error) => reportSettingsFailure('Failed to update speech settings', error, saveFailedMessage));
    }, [saveFailedMessage, settings?.ai, showSaved, updateSettings]);

    const handleAIProviderChange = useCallback((provider: AIProviderId) => {
        updateAISettings({
            provider,
            model: getDefaultAIConfig(provider).model,
            copilotModel: getDefaultCopilotModel(provider),
            thinkingBudget: getDefaultAIConfig(provider).thinkingBudget,
        });
    }, [updateAISettings]);

    const handleToggleAnthropicThinking = useCallback(() => {
        updateAISettings({
            thinkingBudget: anthropicThinkingEnabled ? 0 : (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024),
        });
    }, [anthropicThinkingEnabled, updateAISettings]);

    const handleAiApiKeyChange = useCallback((value: string) => {
        setAiKey({ provider: aiProvider, value });
        saveAIKey(aiProvider, value).catch((error) => (
            reportSettingsFailure('Failed to save AI key', error, saveFailedMessage)
        ));
    }, [aiProvider, saveFailedMessage]);

    const handleSpeechProviderChange = useCallback((provider: SpeechProvider) => {
        const nextModel = provider === 'openai'
            ? OPENAI_SPEECH_MODELS[0]
            : provider === 'gemini'
                ? GEMINI_SPEECH_MODELS[0]
                : provider === 'parakeet'
                    ? DEFAULT_PARAKEET_MODEL
                    : DEFAULT_WHISPER_MODEL;
        const currentProvider = speechSettings.provider ?? 'gemini';
        updateSpeechSettings({
            provider,
            model: nextModel,
            offlineModelPath: provider === currentProvider && (provider === 'whisper' || provider === 'parakeet')
                ? speechSettings.offlineModelPath
                : undefined,
        });
    }, [speechSettings.offlineModelPath, speechSettings.provider, updateSpeechSettings]);

    const handleSpeechApiKeyChange = useCallback((value: string) => {
        setSpeechKey({ provider: speechProvider, value });
        if (speechProvider !== 'whisper' && speechProvider !== 'parakeet') {
            saveAIKey(speechProvider as AIProviderId, value).catch((error) => (
                reportSettingsFailure('Failed to save speech API key', error, saveFailedMessage)
            ));
        }
    }, [saveFailedMessage, speechProvider]);

    const resolveWhisperPath = useCallback(async (modelId: string) => {
        if (!isTauri) return null;
        const entry = WHISPER_MODELS.find((model) => model.id === modelId);
        if (!entry) return null;
        return await getManagedPath('whisper-models', entry.fileName);
    }, [isTauri]);

    const resolveParakeetPath = useCallback(async () => {
        if (!isTauri) return null;
        return await getManagedPath(PARAKEET_MODEL_INSTALL_DIR);
    }, [isTauri]);

    const checkParakeetModelReady = useCallback(async (modelPath: string) => {
        for (const fileName of PARAKEET_REQUIRED_FILES) {
            const filePath = await join(modelPath, fileName);
            if (!await exists(filePath)) return false;
        }
        return true;
    }, []);

    useEffect(() => {
        let active = true;
        if (!enabled) {
            return () => {
                active = false;
            };
        }
        markSettingsOpenTrace('ai-settings-load-provider-key', { provider: aiProvider });
        measureSettingsOpenStep(`ai-load-key:${aiProvider}`, () => loadAIKey(aiProvider))
            .then((key) => {
                if (active) setAiKey({ provider: aiProvider, value: key });
            })
            .catch(() => {
                if (active) setAiKey({ provider: aiProvider, value: '' });
            });
        return () => {
            active = false;
        };
    }, [aiProvider, enabled]);

    useEffect(() => {
        let active = true;
        if (!enabled) {
            return () => {
                active = false;
            };
        }
        if (speechProvider === 'whisper' || speechProvider === 'parakeet') {
            setSpeechKey({ provider: speechProvider, value: '' });
            return () => {
                active = false;
            };
        }
        markSettingsOpenTrace('ai-settings-load-speech-key', { provider: speechProvider });
        measureSettingsOpenStep(`ai-load-speech-key:${speechProvider}`, () => loadAIKey(speechProvider as AIProviderId))
            .then((key) => {
                if (active) setSpeechKey({ provider: speechProvider, value: key });
            })
            .catch(() => {
                if (active) setSpeechKey({ provider: speechProvider, value: '' });
            });
        return () => {
            active = false;
        };
    }, [enabled, speechProvider]);

    // Live assistant/copilot model list (#986). The keys above arrive
    // asynchronously, so this reruns once aiApiKey lands. Any failure keeps the
    // static catalog — the pickers must never break on a bad network.
    useEffect(() => {
        setFetchedChatModels(null);
        const apiKey = aiApiKey.trim();
        const baseUrl = aiBaseUrl.trim();
        // A self-hosted OpenAI-compatible server needs no key (#930); official
        // endpoints list nothing without one, so don't bother asking.
        if (!enabled || (!apiKey && !(aiProvider === 'openai' && baseUrl))) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            fetchProviderModelsCached(aiProvider, { apiKey, baseUrl, kind: 'chat' })
                .then((models) => {
                    if (!cancelled) setFetchedChatModels(models);
                })
                .catch(() => {
                    // Static catalog stays; nothing to tell the user.
                });
        }, MODEL_FETCH_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [aiApiKey, aiBaseUrl, aiProvider, enabled]);

    // Live speech model list (#986). Whisper/Parakeet are local sha256-pinned
    // catalogs — never fetched.
    useEffect(() => {
        setFetchedSpeechModels(null);
        const apiKey = speechApiKey.trim();
        const baseUrl = speechBaseUrl.trim();
        const remote = speechProvider === 'openai' || speechProvider === 'gemini';
        if (!enabled || !remote || (!apiKey && !(speechProvider === 'openai' && baseUrl))) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            fetchProviderModelsCached(speechProvider, {
                apiKey,
                baseUrl,
                kind: 'transcription',
            })
                .then((models) => {
                    if (!cancelled) setFetchedSpeechModels(models);
                })
                .catch(() => {
                    // Static list stays.
                });
        }, MODEL_FETCH_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [enabled, speechApiKey, speechBaseUrl, speechProvider]);

    useEffect(() => {
        if (!enabled || !isTauri) {
            setSpeechDownloadProgress(null);
            return;
        }
        let active = true;
        let unlisteners: Array<() => void> = [];
        import('@tauri-apps/api/event')
            .then(async ({ listen }) => {
                const handleProgress = (event: { payload: SpeechDownloadProgress }) => {
                    if (active) setSpeechDownloadProgress(event.payload);
                };
                return await Promise.all([
                    listen<SpeechDownloadProgress>('parakeet-model-download-progress', handleProgress),
                    listen<SpeechDownloadProgress>('whisper-model-download-progress', handleProgress),
                ]);
            })
            .then((dispose) => {
                if (active) {
                    unlisteners = dispose;
                } else {
                    dispose.forEach((unlisten) => unlisten());
                }
            })
            .catch((error) => reportSettingsFailure(
                'Failed to subscribe to offline model download progress',
                error,
                resolveFeedback('settings.feedback.loadFailed', "Couldn't load this setting. Try again."),
                { toast: false },
            ));
        return () => {
            active = false;
            unlisteners.forEach((unlisten) => unlisten());
        };
    }, [enabled, isTauri, resolveFeedback]);

    useEffect(() => {
        let active = true;
        if (!enabled) {
            return () => {
                active = false;
            };
        }
        if (speechProvider === 'parakeet') {
            const load = async () => {
                setSpeechOfflineSize(null);
                if (!isTauri) {
                    setSpeechOfflinePath(speechSettings.offlineModelPath ?? null);
                    setSpeechOfflineReadyState(false);
                    return;
                }
                markSettingsOpenTrace('ai-settings-load-parakeet-state', { model: speechModel });
                const resolved = speechSettings.offlineModelPath || await measureSettingsOpenStep(
                    `ai-resolve-parakeet-path:${speechModel}`,
                    resolveParakeetPath
                );
                if (!active) return;
                setSpeechOfflinePath(resolved);
                if (!resolved) {
                    setSpeechOfflineReadyState(false);
                    return;
                }
                const ready = await measureSettingsOpenStep(
                    `ai-check-parakeet-files:${speechModel}`,
                    () => checkParakeetModelReady(resolved)
                );
                if (!active) return;
                setSpeechOfflineReadyState(ready);
                setSpeechOfflineSize(ready ? selectedLocalSpeechModelSize : null);
                if (ready && !speechSettings.offlineModelPath) {
                    updateSpeechSettings({ offlineModelPath: resolved, model: speechModel });
                }
            };
            load().catch(() => {
                if (active) {
                    setSpeechOfflineReadyState(false);
                    setSpeechOfflineSize(null);
                }
            });
            return () => {
                active = false;
            };
        }
        if (!isTauri || speechProvider !== 'whisper') {
            setSpeechOfflinePath(null);
            setSpeechOfflineSize(null);
            setSpeechOfflineReadyState(false);
            return () => {
                active = false;
            };
        }
        const load = async () => {
            markSettingsOpenTrace('ai-settings-load-whisper-state', { model: speechModel });
            const resolved = speechSettings.offlineModelPath || await measureSettingsOpenStep(
                `ai-resolve-whisper-path:${speechModel}`,
                () => resolveWhisperPath(speechModel)
            );
            if (!active) return;
            setSpeechOfflinePath(resolved);
            if (!resolved) {
                setSpeechOfflineSize(null);
                setSpeechOfflineReadyState(false);
                return;
            }
            try {
                const present = await measureSettingsOpenStep(
                    `ai-check-whisper-exists:${speechModel}`,
                    () => exists(resolved)
                );
                if (!present) {
                    setSpeechOfflineSize(null);
                    setSpeechOfflineReadyState(false);
                    return;
                }
                if (!speechSettings.offlineModelPath) {
                    updateSpeechSettings({ offlineModelPath: resolved, model: speechModel });
                }
                const fileSize = await measureSettingsOpenStep(
                    `ai-read-whisper-size:${speechModel}`,
                    () => size(resolved)
                );
                if (active) {
                    setSpeechOfflineSize(fileSize);
                    setSpeechOfflineReadyState(true);
                }
            } catch {
                if (active) {
                    setSpeechOfflineSize(null);
                    setSpeechOfflineReadyState(false);
                }
            }
        };
        load().catch(() => {
            if (active) {
                setSpeechOfflineSize(null);
                setSpeechOfflineReadyState(false);
            }
        });
        return () => {
            active = false;
        };
    }, [
        checkParakeetModelReady,
        enabled,
        isTauri,
        resolveParakeetPath,
        resolveWhisperPath,
        selectedLocalSpeechModelSize,
        speechModel,
        speechProvider,
        speechSettings.offlineModelPath,
        updateSpeechSettings,
    ]);

    const handleDownloadWhisperModel = useCallback(async () => {
        if (!isTauri) return;
        setSpeechDownloadError(null);
        setSpeechDownloadProgress(null);
        setSpeechDownloadState('downloading');
        try {
            if (speechProvider === 'parakeet') {
                const resolved = await downloadParakeetModel(speechModel);
                setSpeechOfflinePath(resolved);
                setSpeechOfflineSize(selectedLocalSpeechModelSize);
                setSpeechOfflineReadyState(true);
                updateSpeechSettings({ offlineModelPath: resolved, model: speechModel });
                setSpeechDownloadProgress(null);
                setSpeechDownloadState('success');
                setTimeout(() => setSpeechDownloadState('idle'), 2000);
                return;
            }

            const entry = WHISPER_MODELS.find((model) => model.id === speechModel);
            if (!entry) return;
            const resolved = await downloadWhisperModel(entry.id);
            const fileSize = resolved ? await size(resolved).catch(() => selectedLocalSpeechModelSize) : null;
            setSpeechOfflineSize(fileSize);
            setSpeechOfflinePath(resolved);
            setSpeechOfflineReadyState(Boolean(resolved));
            updateSpeechSettings({ offlineModelPath: resolved ?? undefined, model: entry.id });
            setSpeechDownloadProgress(null);
            setSpeechDownloadState('success');
            setTimeout(() => setSpeechDownloadState('idle'), 2000);
        } catch (error) {
            const message = resolveFeedback('settings.speechOfflineDownloadError', 'Offline model download failed');
            setSpeechDownloadError(message);
            setSpeechDownloadProgress(null);
            setSpeechDownloadState('error');
            reportSettingsFailure('Offline model download failed', error, message, { toast: false });
            showToast(message, 'error', 6000);
        }
    }, [isTauri, resolveFeedback, selectedLocalSpeechModelSize, showToast, speechModel, speechProvider, updateSpeechSettings]);

    const handleDeleteWhisperModel = useCallback(async () => {
        const currentPath = speechOfflinePath || speechSettings.offlineModelPath;
        if (!currentPath) {
            updateSpeechSettings({ offlineModelPath: undefined });
            setSpeechOfflineReadyState(false);
            return;
        }
        try {
            if (speechProvider === 'parakeet') {
                await remove(currentPath, { recursive: true });
            } else {
                await remove(currentPath);
            }
            setSpeechOfflineSize(null);
            setSpeechOfflineReadyState(false);
            if (speechProvider === 'parakeet') {
                setSpeechOfflinePath(await resolveParakeetPath());
            } else {
                setSpeechOfflinePath(null);
            }
            updateSpeechSettings({ offlineModelPath: undefined });
        } catch (error) {
            const message = resolveFeedback('settings.speechOfflineDeleteError', 'Offline model delete failed');
            setSpeechDownloadError(message);
            setSpeechDownloadProgress(null);
            setSpeechDownloadState('error');
            reportSettingsFailure('Offline model delete failed', error, message, { toast: false });
            showToast(message, 'error', 6000);
        }
    }, [resolveFeedback, resolveParakeetPath, showToast, speechOfflinePath, speechProvider, speechSettings.offlineModelPath, updateSpeechSettings]);

    return {
        aiEnabled,
        aiProvider,
        aiModel,
        aiBaseUrl,
        aiOpenAIExtraBodyParams,
        aiModelOptions,
        aiCopilotModel,
        aiCopilotOptions,
        aiRequestTimeoutSeconds,
        aiReasoningEffort,
        aiThinkingBudget,
        anthropicThinkingEnabled,
        aiApiKey,
        speechEnabled,
        speechProvider,
        speechModel,
        speechModelOptions,
        speechBaseUrl,
        speechLanguage,
        speechMode,
        speechFieldStrategy,
        speechApiKey,
        speechOfflineReady: speechOfflineReadyState,
        speechOfflineModelPath: speechOfflinePath ?? speechSettings.offlineModelPath ?? '',
        speechOfflineEstimatedSize: selectedLocalSpeechModelSize,
        speechOfflineSize,
        speechDownloadState,
        speechDownloadError,
        speechDownloadProgress,
        onUpdateAISettings: updateAISettings,
        onUpdateSpeechSettings: updateSpeechSettings,
        onProviderChange: handleAIProviderChange,
        onSpeechProviderChange: handleSpeechProviderChange,
        onToggleAnthropicThinking: handleToggleAnthropicThinking,
        onAiApiKeyChange: handleAiApiKeyChange,
        onSpeechApiKeyChange: handleSpeechApiKeyChange,
        onDownloadWhisperModel: handleDownloadWhisperModel,
        onDeleteWhisperModel: handleDeleteWhisperModel,
    };
}
