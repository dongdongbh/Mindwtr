import { useCallback, useEffect, useState } from 'react';
import type { AIProviderId, AIReasoningEffort, AppData, AudioCaptureMode, AudioFieldStrategy } from '@mindwtr/core';
import {
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getCopilotModelOptions,
    getModelOptions,
} from '@mindwtr/core';
import { BaseDirectory, exists, mkdir, remove, size, writeFile } from '@tauri-apps/plugin-fs';
import { dataDir, join } from '@tauri-apps/api/path';
import { loadAIKey, saveAIKey } from '../../../lib/ai-config';
import { reportError } from '../../../lib/report-error';
import { logWarn } from '../../../lib/app-log';
import { markSettingsOpenTrace, measureSettingsOpenStep } from '../../../lib/settings-open-diagnostics';
import { useUiStore } from '../../../store/ui-store';
import {
    DEFAULT_WHISPER_MODEL,
    GEMINI_SPEECH_MODELS,
    OPENAI_SPEECH_MODELS,
    WHISPER_MODEL_BASE_URL,
    WHISPER_MODELS,
} from '../../../lib/speech-models';

type UseAiSettingsOptions = {
    isTauri: boolean;
    settings: AppData['settings'] | undefined;
    updateSettings: (next: Partial<AppData['settings']>) => Promise<void>;
    showSaved: () => void;
    enabled?: boolean;
};

type AiSettingsUpdate = Partial<NonNullable<AppData['settings']>['ai']>;
type SpeechSettingsUpdate = Partial<NonNullable<NonNullable<AppData['settings']>['ai']>['speechToText']>;

export function useAiSettings({ isTauri, settings, updateSettings, showSaved, enabled = true }: UseAiSettingsOptions) {
    const [aiApiKey, setAiApiKey] = useState('');
    const [speechApiKey, setSpeechApiKey] = useState('');
    const [speechDownloadState, setSpeechDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
    const [speechDownloadError, setSpeechDownloadError] = useState<string | null>(null);
    const [speechOfflinePath, setSpeechOfflinePath] = useState<string | null>(null);
    const [speechOfflineSize, setSpeechOfflineSize] = useState<number | null>(null);
    const showToast = useUiStore((state) => state.showToast);

    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const aiEnabled = settings?.ai?.enabled === true;
    const aiDefaults = getDefaultAIConfig(aiProvider);
    const aiModel = settings?.ai?.model ?? aiDefaults.model;
    const aiBaseUrl = settings?.ai?.baseUrl ?? '';
    const aiReasoningEffort = (settings?.ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT) as AIReasoningEffort;
    const aiThinkingBudget = settings?.ai?.thinkingBudget ?? aiDefaults.thinkingBudget ?? DEFAULT_GEMINI_THINKING_BUDGET;
    const anthropicThinkingEnabled = aiProvider === 'anthropic' && aiThinkingBudget > 0;
    const aiModelOptions = getModelOptions(aiProvider);
    const aiCopilotModel = settings?.ai?.copilotModel ?? getDefaultCopilotModel(aiProvider);
    const aiCopilotOptions = getCopilotModelOptions(aiProvider);

    const speechSettings = settings?.ai?.speechToText ?? {};
    const speechProvider = speechSettings.provider ?? 'gemini';
    const speechEnabled = speechSettings.enabled === true;
    const speechModel = speechSettings.model ?? (
        speechProvider === 'openai'
            ? OPENAI_SPEECH_MODELS[0]
            : speechProvider === 'gemini'
                ? GEMINI_SPEECH_MODELS[0]
                : DEFAULT_WHISPER_MODEL
    );
    const speechLanguage = speechSettings.language ?? '';
    const speechMode = (speechSettings.mode ?? 'smart_parse') as AudioCaptureMode;
    const speechFieldStrategy = (speechSettings.fieldStrategy ?? 'smart') as AudioFieldStrategy;
    const speechModelOptions = speechProvider === 'openai'
        ? OPENAI_SPEECH_MODELS
        : speechProvider === 'gemini'
            ? GEMINI_SPEECH_MODELS
            : WHISPER_MODELS.map((model) => model.id);

    const updateAISettings = useCallback((next: AiSettingsUpdate) => {
        updateSettings({ ai: { ...(settings?.ai ?? {}), ...next } })
            .then(showSaved)
            .catch((error) => reportError('Failed to update AI settings', error));
    }, [settings?.ai, showSaved, updateSettings]);

    const updateSpeechSettings = useCallback((next: SpeechSettingsUpdate) => {
        updateSettings({
            ai: {
                ...(settings?.ai ?? {}),
                speechToText: { ...(settings?.ai?.speechToText ?? {}), ...next },
            },
        })
            .then(showSaved)
            .catch((error) => reportError('Failed to update speech settings', error));
    }, [settings?.ai, showSaved, updateSettings]);

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
        setAiApiKey(value);
        saveAIKey(aiProvider, value).catch((error) => reportError('Failed to save AI key', error));
    }, [aiProvider, enabled]);

    const handleSpeechProviderChange = useCallback((provider: 'openai' | 'gemini' | 'whisper') => {
        const nextModel = provider === 'openai'
            ? OPENAI_SPEECH_MODELS[0]
            : provider === 'gemini'
                ? GEMINI_SPEECH_MODELS[0]
                : DEFAULT_WHISPER_MODEL;
        updateSpeechSettings({
            provider,
            model: nextModel,
            offlineModelPath: provider === 'whisper' ? speechSettings.offlineModelPath : undefined,
        });
    }, [speechSettings.offlineModelPath, updateSpeechSettings]);

    const handleSpeechApiKeyChange = useCallback((value: string) => {
        setSpeechApiKey(value);
        if (speechProvider !== 'whisper') {
            saveAIKey(speechProvider as AIProviderId, value).catch((error) => reportError('Failed to save speech API key', error));
        }
    }, [speechProvider, enabled]);

    const resolveWhisperPath = useCallback(async (modelId: string) => {
        if (!isTauri) return null;
        const entry = WHISPER_MODELS.find((model) => model.id === modelId);
        if (!entry) return null;
        const base = await dataDir();
        return await join(base, 'mindwtr', 'whisper-models', entry.fileName);
    }, [isTauri]);

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
                if (active) setAiApiKey(key);
            })
            .catch(() => {
                if (active) setAiApiKey('');
            });
        return () => {
            active = false;
        };
    }, [aiProvider]);

    useEffect(() => {
        let active = true;
        if (!enabled) {
            return () => {
                active = false;
            };
        }
        if (speechProvider === 'whisper') {
            setSpeechApiKey('');
            return () => {
                active = false;
            };
        }
        markSettingsOpenTrace('ai-settings-load-speech-key', { provider: speechProvider });
        measureSettingsOpenStep(`ai-load-speech-key:${speechProvider}`, () => loadAIKey(speechProvider as AIProviderId))
            .then((key) => {
                if (active) setSpeechApiKey(key);
            })
            .catch(() => {
                if (active) setSpeechApiKey('');
            });
        return () => {
            active = false;
        };
    }, [speechProvider]);

    useEffect(() => {
        let active = true;
        if (!enabled) {
            return () => {
                active = false;
            };
        }
        if (!isTauri || speechProvider !== 'whisper') {
            setSpeechOfflinePath(null);
            setSpeechOfflineSize(null);
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
                return;
            }
            try {
                const present = await measureSettingsOpenStep(
                    `ai-check-whisper-exists:${speechModel}`,
                    () => exists(resolved)
                );
                if (!present) {
                    setSpeechOfflineSize(null);
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
                }
            } catch {
                if (active) {
                    setSpeechOfflineSize(null);
                }
            }
        };
        load().catch(() => {
            if (active) {
                setSpeechOfflineSize(null);
            }
        });
        return () => {
            active = false;
        };
    }, [
        enabled,
        isTauri,
        resolveWhisperPath,
        speechModel,
        speechProvider,
        speechSettings.offlineModelPath,
        updateSpeechSettings,
    ]);

    const handleDownloadWhisperModel = useCallback(async () => {
        const entry = WHISPER_MODELS.find((model) => model.id === speechModel);
        if (!entry || !isTauri) return;
        setSpeechDownloadError(null);
        setSpeechDownloadState('downloading');
        try {
            const targetDir = 'mindwtr/whisper-models';
            await mkdir(targetDir, { baseDir: BaseDirectory.Data, recursive: true });
            const targetPath = `${targetDir}/${entry.fileName}`;
            const alreadyExists = await exists(targetPath, { baseDir: BaseDirectory.Data });
            if (alreadyExists) {
                const resolved = await resolveWhisperPath(entry.id);
                const fileSize = resolved ? await size(resolved) : null;
                setSpeechOfflineSize(fileSize);
                setSpeechOfflinePath(resolved);
                updateSpeechSettings({ offlineModelPath: resolved ?? undefined, model: entry.id });
                setSpeechDownloadState('success');
                setTimeout(() => setSpeechDownloadState('idle'), 2000);
                return;
            }
            const url = `${WHISPER_MODEL_BASE_URL}/${entry.fileName}`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Download failed (${response.status})`);
            }
            const buffer = await response.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            await writeFile(targetPath, bytes, { baseDir: BaseDirectory.Data });
            const resolved = await resolveWhisperPath(entry.id);
            setSpeechOfflineSize(bytes.length);
            setSpeechOfflinePath(resolved);
            updateSpeechSettings({ offlineModelPath: resolved ?? undefined, model: entry.id });
            setSpeechDownloadState('success');
            setTimeout(() => setSpeechDownloadState('idle'), 2000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setSpeechDownloadError(message);
            setSpeechDownloadState('error');
            showToast(`Offline model download failed: ${message}`, 'error', 6000);
        }
    }, [isTauri, resolveWhisperPath, showToast, speechModel, updateSpeechSettings]);

    const handleDeleteWhisperModel = useCallback(async () => {
        if (!speechOfflinePath) {
            updateSpeechSettings({ offlineModelPath: undefined });
            return;
        }
        try {
            await remove(speechOfflinePath);
            setSpeechOfflineSize(null);
            setSpeechOfflinePath(null);
            updateSpeechSettings({ offlineModelPath: undefined });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void logWarn('Whisper model delete failed', {
                scope: 'ai',
                extra: { error: message },
            });
            setSpeechDownloadError(message);
            setSpeechDownloadState('error');
            showToast(`Offline model delete failed: ${message}`, 'error', 6000);
        }
    }, [showToast, speechOfflinePath, updateSpeechSettings]);

    return {
        aiEnabled,
        aiProvider,
        aiModel,
        aiBaseUrl,
        aiModelOptions,
        aiCopilotModel,
        aiCopilotOptions,
        aiReasoningEffort,
        aiThinkingBudget,
        anthropicThinkingEnabled,
        aiApiKey,
        speechEnabled,
        speechProvider,
        speechModel,
        speechModelOptions,
        speechLanguage,
        speechMode,
        speechFieldStrategy,
        speechApiKey,
        speechOfflineReady: Boolean(speechOfflineSize),
        speechOfflineSize,
        speechDownloadState,
        speechDownloadError,
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
