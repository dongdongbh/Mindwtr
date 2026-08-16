import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    fetchProviderModelsCached,
    formatOpenAIExtraBodyParams,
    getCopilotModelOptions,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getModelOptions,
    mergeModelOptions,
    parseOpenAIExtraBodyParamsInput,
    shallow,
    type AIProviderId,
    type AIReasoningEffort,
    type AppSettings,
    useTaskStore,
} from '@mindwtr/core';

import { loadAIKey, saveAIKey } from '@/lib/ai-config';
import { DEFAULT_GEMINI_STT_MODEL, DEFAULT_OPENAI_STT_MODEL } from '@/lib/speech-to-text';
import { useToast } from '@/contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError, logSettingsWarn } from '@/lib/settings-utils';
import * as whisperModelStore from '@/lib/whisper-model-store';
import type { WhisperModelLocation } from '@/lib/whisper-model-store';

import { AiSettingsAssistantCard } from './ai-settings-assistant-card';
import { AiSettingsSpeechCard } from './ai-settings-speech-card';
import { isWhisperModelFileReady } from './ai-settings-whisper-model';
import {
    AI_PROVIDER_CONSENT_KEY,
    DEFAULT_WHISPER_MODEL,
    FOSS_LOCAL_LLM_COPILOT_OPTIONS,
    FOSS_LOCAL_LLM_MODEL_OPTIONS,
    MobileExtraConfig,
    WHISPER_MODELS,
} from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';


// Typing a key by hand would otherwise fire one list request per keystroke.
const MODEL_FETCH_DEBOUNCE_MS = 400;

// A loaded key belongs to the provider it was loaded for. Effects in one commit
// all see that commit's values, so a bare `key` string would still be the old
// provider's secret on the render where the provider flipped — tagging it lets
// the fetch gate itself off until the matching key arrives.
type LoadedKey = { provider: string; value: string };

export function AISettingsScreen() {
    const tc = useThemeColors();
    const { showToast } = useToast();
    const { tr, t } = useSettingsLocalization();
    const scrollContentStyleWithKeyboard = useSettingsScrollContent(140);
    const { settings, updateSettings } = useTaskStore((state) => ({
        settings: state.settings,
        updateSettings: state.updateSettings,
    }), shallow);
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
    const isExpoGo = Constants.appOwnership === 'expo';
    const [aiKey, setAiKey] = useState<LoadedKey>({ provider: '', value: '' });
    const [speechKey, setSpeechKey] = useState<LoadedKey>({ provider: '', value: '' });
    const [whisperDownloadState, setWhisperDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
    const [whisperDownloadError, setWhisperDownloadError] = useState('');
    const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
    const [speechOpen, setSpeechOpen] = useState(false);
    const [modelPicker, setModelPicker] = useState<null | 'model' | 'copilot' | 'speech'>(null);
    const [openAIExtraParamsDraft, setOpenAIExtraParamsDraft] = useState(() =>
        formatOpenAIExtraBodyParams(settings.ai?.openAIExtraBodyParams)
    );
    const [openAIExtraParamsError, setOpenAIExtraParamsError] = useState('');
    // Live provider model lists (#986). null = nothing fetched yet or the fetch
    // failed, which mergeModelOptions degrades to the static catalog.
    const [fetchedChatModels, setFetchedChatModels] = useState<string[] | null>(null);
    const [fetchedSpeechModels, setFetchedSpeechModels] = useState<string[] | null>(null);

    const aiProvider = (isFossBuild ? 'openai' : (settings.ai?.provider ?? 'openai')) as AIProviderId;
    const aiApiKey = aiKey.provider === aiProvider ? aiKey.value : '';
    const aiEnabled = settings.ai?.enabled === true;
    const staticAiModelOptions = isFossBuild ? FOSS_LOCAL_LLM_MODEL_OPTIONS : getModelOptions(aiProvider);
    const aiModel = settings.ai?.model ?? (isFossBuild ? FOSS_LOCAL_LLM_MODEL_OPTIONS[0] : getDefaultAIConfig(aiProvider).model);
    const aiModelOptions = mergeModelOptions(fetchedChatModels, staticAiModelOptions, aiModel);
    const aiBaseUrl = settings.ai?.baseUrl ?? '';
    const aiOpenAIExtraBodyParams = settings.ai?.openAIExtraBodyParams;
    const aiReasoningEffort = (settings.ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT) as AIReasoningEffort;
    const aiThinkingBudget = settings.ai?.thinkingBudget ?? getDefaultAIConfig(aiProvider).thinkingBudget ?? 0;
    const staticAiCopilotOptions = isFossBuild ? FOSS_LOCAL_LLM_COPILOT_OPTIONS : getCopilotModelOptions(aiProvider);
    const aiCopilotModel = settings.ai?.copilotModel ?? (isFossBuild ? FOSS_LOCAL_LLM_COPILOT_OPTIONS[0] : getDefaultCopilotModel(aiProvider));
    const aiCopilotOptions = mergeModelOptions(fetchedChatModels, staticAiCopilotOptions, aiCopilotModel);
    const anthropicThinkingEnabled = aiProvider === 'anthropic' && aiThinkingBudget > 0;
    const speechSettings = settings.ai?.speechToText ?? {};
    const speechEnabled = speechSettings.enabled === true;
    const configuredSpeechProvider = isFossBuild ? 'whisper' : (speechSettings.provider ?? 'gemini');
    const speechProvider = (configuredSpeechProvider === 'parakeet' ? 'whisper' : configuredSpeechProvider) as 'openai' | 'gemini' | 'whisper';
    const speechApiKey = speechKey.provider === speechProvider ? speechKey.value : '';
    const speechModel = speechSettings.model ?? (
        speechProvider === 'openai'
            ? DEFAULT_OPENAI_STT_MODEL
            : speechProvider === 'gemini'
                ? DEFAULT_GEMINI_STT_MODEL
                : DEFAULT_WHISPER_MODEL
    );
    const speechBaseUrl = speechSettings.baseUrl ?? '';
    const speechLanguage = speechSettings.language ?? 'auto';
    const speechMode = speechSettings.mode ?? 'smart_parse';
    const speechFieldStrategy = speechSettings.fieldStrategy ?? 'smart';
    const staticSpeechModelOptions = isFossBuild
        ? WHISPER_MODELS.map((model) => model.id)
        : speechProvider === 'openai'
            ? ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1']
            : speechProvider === 'gemini'
                ? ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']
                : WHISPER_MODELS.map((model) => model.id);
    const speechModelOptions = mergeModelOptions(fetchedSpeechModels, staticSpeechModelOptions, speechModel);

    const aiSettings = settings.ai;
    const updateAISettings = useCallback((next: Partial<NonNullable<AppSettings['ai']>>) => {
        updateSettings({ ai: { ...(aiSettings ?? {}), ...next } }).catch(logSettingsError);
    }, [aiSettings, updateSettings]);

    useEffect(() => {
        setOpenAIExtraParamsDraft(formatOpenAIExtraBodyParams(aiOpenAIExtraBodyParams));
        setOpenAIExtraParamsError('');
    }, [aiOpenAIExtraBodyParams]);

    const getAIProviderLabel = (provider: AIProviderId): string => (
        isFossBuild && provider === 'openai'
            ? tr('settings.aiMobile.localCustomOpenaiCompatible')
            : provider === 'openai'
                ? t('settings.aiProviderOpenAI')
                : provider === 'gemini'
                    ? t('settings.aiProviderGemini')
                    : provider === 'anthropic'
                        ? t('settings.aiProviderAnthropic')
                        : t('settings.aiProviderOrcaRouter')
    );

    const getAIProviderPolicyUrl = (provider: AIProviderId): string => (
        isFossBuild && provider === 'openai'
            ? ''
            : provider === 'openai'
                ? 'https://openai.com/policies/privacy-policy'
                : provider === 'gemini'
                    ? 'https://policies.google.com/privacy'
                    : provider === 'anthropic'
                        ? 'https://www.anthropic.com/privacy'
                        : 'https://www.orcarouter.ai/privacy-policy'
    );

    const loadAIProviderConsent = async (): Promise<Record<string, boolean>> => {
        try {
            const raw = await AsyncStorage.getItem(AI_PROVIDER_CONSENT_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            const entries = Object.entries(parsed as Record<string, unknown>)
                .map(([provider, value]) => [provider, value === true] as const);
            return Object.fromEntries(entries);
        } catch (error) {
            logSettingsWarn('Failed to load AI consent state', error);
            return {};
        }
    };

    const saveAIProviderConsent = async (provider: AIProviderId): Promise<void> => {
        try {
            const consentMap = await loadAIProviderConsent();
            consentMap[provider] = true;
            await AsyncStorage.setItem(AI_PROVIDER_CONSENT_KEY, JSON.stringify(consentMap));
        } catch (error) {
            logSettingsWarn('Failed to save AI consent state', error);
        }
    };

    const requestAIProviderConsent = async (provider: AIProviderId): Promise<boolean> => {
        const consentMap = await loadAIProviderConsent();
        if (consentMap[provider]) return true;

        const providerLabel = getAIProviderLabel(provider);
        const policyUrl = getAIProviderPolicyUrl(provider);
        const title = tr('settings.aiMobile.enableAiFeatures');
        const message = isFossBuild && provider === 'openai'
            ? tr('settings.aiMobile.toUseAiAssistantYourTaskTextAndOptionalNotes')
            : tr('settings.aiMobile.aiAssistantPrivacyPromptForProvider', { provider: providerLabel, privacyUrl: policyUrl });

        return await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            Alert.alert(
                title,
                message,
                [
                    {
                        text: tr('common.cancel'),
                        style: 'cancel',
                        onPress: () => finish(false),
                    },
                    {
                        text: tr('settings.aiConsentAgree'),
                        onPress: () => {
                            void saveAIProviderConsent(provider);
                            finish(true);
                        },
                    },
                ],
                { cancelable: true, onDismiss: () => finish(false) }
            );
        });
    };

    const applyAIProviderDefaults = useCallback((provider: AIProviderId) => {
        const defaults = getDefaultAIConfig(provider);
        updateAISettings({
            provider,
            model: isFossBuild && provider === 'openai' ? FOSS_LOCAL_LLM_MODEL_OPTIONS[0] : defaults.model,
            copilotModel: isFossBuild && provider === 'openai' ? FOSS_LOCAL_LLM_COPILOT_OPTIONS[0] : getDefaultCopilotModel(provider),
            reasoningEffort: defaults.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
            thinkingBudget: defaults.thinkingBudget
                ?? (provider === 'gemini'
                    ? DEFAULT_GEMINI_THINKING_BUDGET
                    : provider === 'anthropic'
                        ? DEFAULT_ANTHROPIC_THINKING_BUDGET
                        : 0),
        });
    }, [isFossBuild, updateAISettings]);

    const speechToTextSettings = settings.ai?.speechToText;
    const updateSpeechSettings = useCallback((
        next: Partial<NonNullable<NonNullable<AppSettings['ai']>['speechToText']>>
    ) => {
        updateAISettings({ speechToText: { ...(speechToTextSettings ?? {}), ...next } });
    }, [speechToTextSettings, updateAISettings]);

    useEffect(() => {
        if (!isFossBuild) return;
        const configuredProvider = (settings.ai?.provider ?? 'openai') as AIProviderId;
        if (configuredProvider !== 'openai') {
            applyAIProviderDefaults('openai');
        }
    }, [applyAIProviderDefaults, isFossBuild, settings.ai?.provider]);

    useEffect(() => {
        if (!isFossBuild) return;
        const configuredProvider = settings.ai?.speechToText?.provider ?? 'whisper';
        const configuredModel = settings.ai?.speechToText?.model;
        const modelIsValidWhisper = typeof configuredModel === 'string'
            && WHISPER_MODELS.some((entry) => entry.id === configuredModel);
        if (configuredProvider !== 'whisper' || !modelIsValidWhisper) {
            updateSpeechSettings({
                provider: 'whisper',
                model: modelIsValidWhisper ? configuredModel : DEFAULT_WHISPER_MODEL,
            });
        }
    }, [isFossBuild, settings.ai?.speechToText?.model, settings.ai?.speechToText?.provider, updateSpeechSettings]);

    useEffect(() => {
        loadAIKey(aiProvider)
            .then((value) => setAiKey({ provider: aiProvider, value }))
            .catch(logSettingsError);
    }, [aiProvider]);

    useEffect(() => {
        if (speechProvider === 'whisper') {
            setSpeechKey({ provider: speechProvider, value: '' });
            return;
        }
        loadAIKey(speechProvider)
            .then((value) => setSpeechKey({ provider: speechProvider, value }))
            .catch(logSettingsError);
    }, [speechProvider]);

    // Live assistant/copilot model list (#986). The keys above arrive
    // asynchronously, so this reruns once aiApiKey lands. Any failure keeps the
    // static catalog — the pickers must never break on a bad network.
    useEffect(() => {
        setFetchedChatModels(null);
        const apiKey = aiApiKey.trim();
        const baseUrl = aiBaseUrl.trim();
        // FOSS builds only ever talk to the user's own server, so a base URL is
        // required and no key is; elsewhere a self-hosted OpenAI-compatible
        // server needs no key either (#930), while the official endpoints list
        // nothing without one.
        const canFetch = isFossBuild
            ? Boolean(baseUrl)
            : Boolean(apiKey) || (aiProvider === 'openai' && Boolean(baseUrl));
        if (!canFetch) return;
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
    }, [aiApiKey, aiBaseUrl, aiProvider, isFossBuild]);

    // Live speech model list (#986). Whisper is a local sha256-pinned catalog —
    // never fetched, which also covers FOSS builds (Whisper is their only STT).
    useEffect(() => {
        setFetchedSpeechModels(null);
        const apiKey = speechApiKey.trim();
        const baseUrl = speechBaseUrl.trim();
        if (speechProvider === 'whisper') return;
        if (!apiKey && !(speechProvider === 'openai' && baseUrl)) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            fetchProviderModelsCached(speechProvider, {
                apiKey,
                baseUrl,
                // Gemini transcribes with its regular generateContent models.
                kind: speechProvider === 'openai' ? 'transcription' : 'chat',
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
    }, [speechApiKey, speechBaseUrl, speechProvider]);

    const handleAIProviderChange = (provider: AIProviderId) => {
        if (provider === aiProvider) return;
        void (async () => {
            if (aiEnabled) {
                const consented = await requestAIProviderConsent(provider);
                if (!consented) return;
            }
            applyAIProviderDefaults(provider);
        })();
    };

    const handleAIEnabledToggle = (value: boolean) => {
        if (!value) {
            updateAISettings({ enabled: false });
            return;
        }
        void (async () => {
            const consented = await requestAIProviderConsent(aiProvider);
            if (!consented) return;
            updateAISettings({ enabled: true });
        })();
    };

    const handleAiApiKeyChange = useCallback((value: string) => {
        setAiKey({ provider: aiProvider, value });
        saveAIKey(aiProvider, value).catch(logSettingsError);
    }, [aiProvider]);

    const handleOpenAIExtraBodyParamsSave = useCallback(() => {
        const result = parseOpenAIExtraBodyParamsInput(openAIExtraParamsDraft);
        if (!result.ok) {
            const message = t('settings.aiExtraBodyParamsInvalid');
            setOpenAIExtraParamsError(message);
            showToast({
                title: t('settings.aiExtraBodyParams'),
                message,
                tone: 'warning',
                durationMs: 4200,
            });
            return;
        }
        setOpenAIExtraParamsError('');
        setOpenAIExtraParamsDraft(formatOpenAIExtraBodyParams(result.value));
        updateAISettings({ openAIExtraBodyParams: result.value });
    }, [openAIExtraParamsDraft, showToast, t, updateAISettings]);

    const handleAnthropicThinkingEnabledChange = useCallback((value: boolean) => {
        updateAISettings({
            thinkingBudget: value ? (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024) : 0,
        });
    }, [updateAISettings]);

    const applyWhisperModel = (modelId: string) => {
        updateSpeechSettings({ model: modelId, offlineModelPath: whisperModelStore.getPreferredModelUri(modelId) });
    };

    const handleSpeechProviderChange = useCallback((provider: 'openai' | 'gemini' | 'whisper') => {
        updateSpeechSettings({
            provider,
            model: provider === 'openai'
                ? DEFAULT_OPENAI_STT_MODEL
                : provider === 'gemini'
                    ? DEFAULT_GEMINI_STT_MODEL
                    : DEFAULT_WHISPER_MODEL,
            offlineModelPath: provider === 'whisper'
                ? whisperModelStore.getPreferredModelUri(DEFAULT_WHISPER_MODEL)
                : undefined,
        });
    }, [updateSpeechSettings]);

    const handleSpeechApiKeyChange = useCallback((value: string) => {
        setSpeechKey({ provider: speechProvider, value });
        if (speechProvider === 'whisper') return;
        saveAIKey(speechProvider, value).catch(logSettingsError);
    }, [speechProvider]);

    const handleSpeechLanguageChange = useCallback((value: string) => {
        const trimmed = value.trim();
        updateSpeechSettings({ language: trimmed ? trimmed : 'auto' });
    }, [updateSpeechSettings]);

    const selectedWhisperModel = WHISPER_MODELS.find((model) => model.id === speechModel) ?? WHISPER_MODELS[0];

    // Lazy initializer runs synchronously on first render, so a model that's
    // already downloaded shows "ready" from frame one instead of flashing
    // "not downloaded" until the effect below confirms it. locateSync is the
    // same Expo-only fast path locate() itself uses before falling back to
    // the native RNFS pass.
    const [whisperResolved, setWhisperResolved] = useState<WhisperModelLocation | null>(() => (
        speechProvider === 'whisper' && selectedWhisperModel
            ? whisperModelStore.locateSync(speechModel, speechSettings.offlineModelPath)
            : null
    ));

    // Single source of "where is the model, and is it there": locate() runs the
    // whole candidate ladder (Expo sync pass, then native RNFS pass per ADR 0019
    // #10) and, if the stored path has drifted from where the file actually is
    // (or nowhere), reconciles offlineModelPath to match.
    useEffect(() => {
        if (speechProvider !== 'whisper' || !selectedWhisperModel) {
            setWhisperResolved(null);
            return;
        }
        let cancelled = false;
        const storedPath = speechSettings.offlineModelPath;
        // Re-seed with the sync fast path immediately (covers switching models
        // mid-session, where the lazy initializer above only ran once at mount)
        // before the slower native-confirming pass lands.
        setWhisperResolved(whisperModelStore.locateSync(speechModel, storedPath));
        void whisperModelStore.locate(speechModel, storedPath).then((resolved) => {
            if (cancelled) return;
            setWhisperResolved(resolved);
            if (!storedPath) return;
            const nextPath = resolved.exists ? resolved.uri : whisperModelStore.getPreferredModelUri(speechModel);
            if (nextPath && nextPath !== storedPath) {
                updateSpeechSettings({ offlineModelPath: nextPath });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [speechModel, speechProvider, selectedWhisperModel, speechSettings.offlineModelPath, updateSpeechSettings]);

    // A file can exist without being a complete model (interrupted download) —
    // validate the exact expected byte count, not just presence.
    const whisperDownloaded = Boolean(selectedWhisperModel && whisperResolved && isWhisperModelFileReady(
        selectedWhisperModel,
        { exists: whisperResolved.exists, isDirectory: false, size: whisperResolved.size }
    ));
    const whisperSizeLabel = whisperDownloaded && whisperResolved && whisperResolved.size > 0
        ? `${(whisperResolved.size / (1024 * 1024)).toFixed(1)} MB`
        : '';

    const handleDownloadWhisperModel = async () => {
        if (!selectedWhisperModel) return;

        if (isExpoGo) {
            const message = tr('settings.aiMobile.whisperDownloadsRequireADevBuildOrProductionBuildNot');
            setWhisperDownloadError(message);
            setWhisperDownloadState('error');
            showToast({
                title: t('settings.speechOfflineDownloadError'),
                message,
                tone: 'warning',
                durationMs: 5200,
            });
            return;
        }
        setWhisperDownloadError('');
        setWhisperDownloadState('downloading');
        const clearSuccess = () => {
            setTimeout(() => setWhisperDownloadState('idle'), 2000);
        };
        try {
            const downloadedUri = await whisperModelStore.download(selectedWhisperModel.id);
            updateSpeechSettings({ offlineModelPath: downloadedUri, model: selectedWhisperModel.id });
            setWhisperResolved(await whisperModelStore.locate(selectedWhisperModel.id, downloadedUri));
            setWhisperDownloadState('success');
            clearSuccess();
        } catch (error) {
            // The store cannot translate, so the actionable hint lives here — but only
            // for the store's retryOnWifi-tagged errors (the actual network/streaming
            // attempt), matching the pre-store code's scope: a setup/safety failure
            // (blocked directory, unsafe target) isn't a network issue and "retry on
            // Wi-Fi" would be misleading for it.
            const detail = error instanceof Error ? error.message : String(error);
            const message = error instanceof Error && (error as whisperModelStore.WhisperDownloadError).retryOnWifi
                ? `${tr('settings.aiMobile.downloadFailedPleaseRetryOnWiFiLargeModelsCannot')}\n${detail}`
                : detail;
            setWhisperDownloadError(message);
            setWhisperDownloadState('error');
            logSettingsWarn('Whisper model download failed', error);
            showToast({
                title: t('settings.speechOfflineDownloadError'),
                message,
                tone: 'warning',
                durationMs: 5200,
            });
        }
    };

    const handleDeleteWhisperModel = async () => {
        try {
            if (selectedWhisperModel) {
                await whisperModelStore.remove(selectedWhisperModel.id);
            }
            setWhisperResolved(null);
            updateSpeechSettings({ offlineModelPath: undefined });
        } catch (error) {
            logSettingsWarn('Whisper model delete failed', error);
            showToast({
                title: t('settings.speechOfflineDeleteError'),
                message: t('settings.speechOfflineDeleteErrorBody'),
                tone: 'warning',
                durationMs: 4200,
            });
        }
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('settings.ai')} />
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
                style={{ flex: 1 }}
            >
                <ScrollView
                    style={styles.scrollView}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={scrollContentStyleWithKeyboard}
                >
                    <AiSettingsAssistantCard
                        aiApiKey={aiApiKey}
                        aiAssistantOpen={aiAssistantOpen}
                        aiBaseUrl={aiBaseUrl}
                        aiCopilotModel={aiCopilotModel}
                        aiCopilotOptions={aiCopilotOptions}
                        aiEnabled={aiEnabled}
                        aiExtraBodyParamsDraft={openAIExtraParamsDraft}
                        aiExtraBodyParamsError={openAIExtraParamsError}
                        aiModel={aiModel}
                        aiModelOptions={aiModelOptions}
                        aiProvider={aiProvider}
                        aiReasoningEffort={aiReasoningEffort}
                        aiThinkingBudget={aiThinkingBudget}
                        anthropicThinkingEnabled={anthropicThinkingEnabled}
                        getAIProviderLabel={getAIProviderLabel}
                        isFossBuild={isFossBuild}
                        tr={tr}
                        onAiApiKeyChange={handleAiApiKeyChange}
                        onAiBaseUrlChange={(value) => updateAISettings({ baseUrl: value })}
                        onAiCopilotModelChange={(value) => updateAISettings({ copilotModel: value })}
                        onAiEnabledChange={handleAIEnabledToggle}
                        onAiExtraBodyParamsDraftChange={setOpenAIExtraParamsDraft}
                        onAiExtraBodyParamsSave={handleOpenAIExtraBodyParamsSave}
                        onAiModelChange={(value) => updateAISettings({ model: value })}
                        onAiProviderChange={handleAIProviderChange}
                        onAiReasoningEffortChange={(value) => updateAISettings({ reasoningEffort: value })}
                        onAiThinkingBudgetChange={(value) => updateAISettings({ thinkingBudget: value })}
                        onAnthropicThinkingEnabledChange={handleAnthropicThinkingEnabledChange}
                        onModelPickerChange={setModelPicker}
                        onToggleOpen={() => setAiAssistantOpen((prev) => !prev)}
                        t={t}
                        tc={tc}
                    />

                    <AiSettingsSpeechCard
                        isExpoGo={isExpoGo}
                        isFossBuild={isFossBuild}
                        tr={tr}
                        onDeleteWhisperModel={() => void handleDeleteWhisperModel()}
                        onDownloadWhisperModel={() => void handleDownloadWhisperModel()}
                        onOpenModelPicker={() => setModelPicker('speech')}
                        onSpeechApiKeyChange={handleSpeechApiKeyChange}
                        onSpeechBaseUrlChange={(value) => updateSpeechSettings({ baseUrl: value })}
                        onSpeechEnabledChange={(value) => updateSpeechSettings({ enabled: value })}
                        onSpeechFieldStrategyChange={(value) => updateSpeechSettings({ fieldStrategy: value })}
                        onSpeechLanguageChange={handleSpeechLanguageChange}
                        onSpeechModeChange={(value) => updateSpeechSettings({ mode: value })}
                        onSpeechModelChange={(value) => updateSpeechSettings({ model: value })}
                        onSpeechProviderChange={handleSpeechProviderChange}
                        onToggleOpen={() => setSpeechOpen((prev) => !prev)}
                        speechApiKey={speechApiKey}
                        speechBaseUrl={speechBaseUrl}
                        speechEnabled={speechEnabled}
                        speechFieldStrategy={speechFieldStrategy}
                        speechLanguage={speechLanguage}
                        speechMode={speechMode}
                        speechModel={speechModel}
                        speechOpen={speechOpen}
                        speechProvider={speechProvider}
                        t={t}
                        tc={tc}
                        whisperDownloadError={whisperDownloadError}
                        whisperDownloadState={whisperDownloadState}
                        whisperDownloaded={whisperDownloaded}
                        whisperSizeLabel={whisperSizeLabel}
                    />

                    <Modal
                        transparent
                        visible={modelPicker !== null}
                        animationType="fade"
                        onRequestClose={() => setModelPicker(null)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setModelPicker(null)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>
                                    {modelPicker === 'model'
                                        ? t('settings.aiModel')
                                        : modelPicker === 'copilot'
                                            ? t('settings.aiCopilotModel')
                                            : t('settings.speechModel')}
                                </Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {(modelPicker === 'model'
                                        ? aiModelOptions
                                        : modelPicker === 'copilot'
                                            ? aiCopilotOptions
                                            : speechModelOptions).map((option) => {
                                        const selected = modelPicker === 'model'
                                            ? aiModel === option
                                            : modelPicker === 'copilot'
                                                ? aiCopilotModel === option
                                                : speechModel === option;
                                        return (
                                            <TouchableOpacity
                                                key={option}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    if (modelPicker === 'model') {
                                                        updateAISettings({ model: option });
                                                    } else if (modelPicker === 'copilot') {
                                                        updateAISettings({ copilotModel: option });
                                                    } else if (speechProvider === 'whisper') {
                                                        applyWhisperModel(option);
                                                    } else {
                                                        updateSpeechSettings({ model: option });
                                                    }
                                                    setModelPicker(null);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {option}
                                                </Text>
                                                {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}
