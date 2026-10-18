import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Check } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    updateSettingsFromLatest,
    fetchProviderModelsCached,
    formatOpenAIExtraBodyParams,
    mergeModelOptions,
    parseOpenAIExtraBodyParamsInput,
    shallow,
    type AIProviderId,
    type AppSettings,
    useTaskStore,
} from '@mindwtr/core';
import {
    AI_MODEL_FETCH_DEBOUNCE_MS,
    canFetchAIChatModels,
    getAIConsentPrompt,
    getAIProviderDefaultsPatch,
    getAIProviderLabel as getCoreAIProviderLabel,
    getAnthropicThinkingPatch,
    getFossSpeechCorrection,
    getSelectedMobileWhisperModel,
    getSpeechModelListKind,
    getSpeechProviderPatch,
    needsFossAIProviderReset,
    normalizeSpeechLanguageInput,
    readAIProviderConsent,
    canDiscoverAIModels,
    recordAIProviderConsent,
    resolveAISettingsScreenState,
} from '@mindwtr/core/ai-settings-model';

import { loadAIKey, saveAIKey } from '@/lib/ai-config';
import {
    readAppleClarificationBackend,
    writeAppleClarificationBackend,
    type AppleClarificationBackend,
} from '@/lib/apple-clarification-preference';
import {
    describeAppleClarificationUnavailableReason,
    getAppleClarificationCapability,
} from '@/lib/apple-foundation-models';
import { useToast } from '@/contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError, logSettingsWarn } from '@/lib/settings-utils';
import * as whisperModelStore from '@/lib/whisper-model-store';
import type { WhisperModelLocation } from '@/lib/whisper-model-store';

import { AiSettingsAssistantCard } from './ai-settings-assistant-card';
import { AiSettingsSpeechCard } from './ai-settings-speech-card';
import { isWhisperModelFileReady } from './ai-settings-whisper-model';
import { MobileExtraConfig } from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';


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
    const appleClarificationPrototypeEnabled = Platform.OS === 'ios' && (
        extraConfig?.appleClarificationPrototypeEnabled === true
        || extraConfig?.appleClarificationPrototypeEnabled === 'true'
    );
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
    const [appleClarificationBackend, setAppleClarificationBackend] = useState<AppleClarificationBackend>('configured');
    const [appleClarificationAvailability, setAppleClarificationAvailability] = useState('');
    // This device's consent record (null until read): a model list asks only a provider it covers (canDiscoverAIModels).
    const [consentMap, setConsentMap] = useState<Record<string, boolean> | null>(null);

    const {
        aiProvider,
        aiEnabled,
        staticAiModelOptions,
        aiModel,
        aiBaseUrl,
        aiOpenAIExtraBodyParams,
        aiReasoningEffort,
        aiThinkingBudget,
        staticAiCopilotOptions,
        aiCopilotModel,
        aiRequestTimeoutSeconds,
        anthropicThinkingEnabled,
        speechEnabled,
        speechProvider,
        speechModel,
        speechBaseUrl,
        speechLanguage,
        speechMode,
        speechFieldStrategy,
        staticSpeechModelOptions,
    } = resolveAISettingsScreenState(settings, isFossBuild);
    const aiApiKey = aiKey.provider === aiProvider ? aiKey.value : '';
    const aiModelOptions = mergeModelOptions(fetchedChatModels, staticAiModelOptions, aiModel);
    const aiCopilotOptions = mergeModelOptions(fetchedChatModels, staticAiCopilotOptions, aiCopilotModel);
    const speechSettings = settings.ai?.speechToText ?? {};
    const speechApiKey = speechKey.provider === speechProvider ? speechKey.value : '';
    const speechModelOptions = mergeModelOptions(fetchedSpeechModels, staticSpeechModelOptions, speechModel);

    // Each change merges into the settings stored when its write is admitted, never into this render's
    // copy: two changes in one render (the FOSS corrections) would otherwise undo each other, and a sync
    // save's newer keys stay.
    const updateAISettings = useCallback((next: Partial<NonNullable<AppSettings['ai']>>) => {
        updateSettingsFromLatest((latest) => ({ ai: { ...(latest.ai ?? {}), ...next } }), { write: updateSettings, read: () => useTaskStore.getState().settings }).catch(logSettingsError);
    }, [updateSettings]);

    useEffect(() => {
        let active = true;
        void readAIProviderConsent(AsyncStorage, logSettingsWarn).then((consent) => {
            if (active) setConsentMap(consent);
        });
        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        if (!appleClarificationPrototypeEnabled) return;
        let active = true;
        void Promise.all([
            readAppleClarificationBackend(),
            getAppleClarificationCapability(),
        ]).then(([backend, capability]) => {
            if (!active) return;
            setAppleClarificationBackend(backend);
            setAppleClarificationAvailability(capability.available
                ? 'Available on this device. Requests stay on device.'
                : describeAppleClarificationUnavailableReason(capability.reason));
        });
        return () => {
            active = false;
        };
    }, [appleClarificationPrototypeEnabled]);

    const handleAppleClarificationBackendChange = useCallback((backend: AppleClarificationBackend) => {
        setAppleClarificationBackend(backend);
        void writeAppleClarificationBackend(backend);
    }, []);

    useEffect(() => {
        setOpenAIExtraParamsDraft(formatOpenAIExtraBodyParams(aiOpenAIExtraBodyParams));
        setOpenAIExtraParamsError('');
    }, [aiOpenAIExtraBodyParams]);

    const getAIProviderLabel = (provider: AIProviderId): string => getCoreAIProviderLabel(provider, isFossBuild, { t, tr });

    const requestAIProviderConsent = async (provider: AIProviderId): Promise<boolean> => {
        const consentMap = await readAIProviderConsent(AsyncStorage, logSettingsWarn);
        if (consentMap[provider]) return true;

        const prompt = getAIConsentPrompt(provider, isFossBuild, { t, tr });

        return await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            Alert.alert(
                prompt.title,
                prompt.message,
                [
                    {
                        text: prompt.cancel,
                        style: 'cancel',
                        onPress: () => finish(false),
                    },
                    {
                        text: prompt.agree,
                        onPress: () => {
                            void recordAIProviderConsent(AsyncStorage, provider, logSettingsWarn);
                            setConsentMap((current) => ({ ...(current ?? {}), [provider]: true }));
                            finish(true);
                        },
                    },
                ],
                { cancelable: true, onDismiss: () => finish(false) }
            );
        });
    };

    const applyAIProviderDefaults = useCallback((provider: AIProviderId) => {
        updateAISettings(getAIProviderDefaultsPatch(provider, isFossBuild));
    }, [isFossBuild, updateAISettings]);

    const updateSpeechSettings = useCallback((
        next: Partial<NonNullable<NonNullable<AppSettings['ai']>['speechToText']>>
    ) => {
        updateSettingsFromLatest((latest) => ({
            ai: { ...(latest.ai ?? {}), speechToText: { ...(latest.ai?.speechToText ?? {}), ...next } },
        }), { write: updateSettings, read: () => useTaskStore.getState().settings }).catch(logSettingsError);
    }, [updateSettings]);

    useEffect(() => {
        if (needsFossAIProviderReset(settings.ai?.provider, isFossBuild)) {
            applyAIProviderDefaults('openai');
        }
    }, [applyAIProviderDefaults, isFossBuild, settings.ai?.provider]);

    useEffect(() => {
        const correction = getFossSpeechCorrection({
            provider: settings.ai?.speechToText?.provider,
            model: settings.ai?.speechToText?.model,
        }, isFossBuild);
        if (correction) {
            updateSpeechSettings(correction);
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
        if (!canFetchAIChatModels({ isFossBuild, provider: aiProvider, apiKey, baseUrl })) return;
        if (!consentMap || !canDiscoverAIModels({ provider: aiProvider, consent: consentMap, aiEnabled, aiProvider })) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            fetchProviderModelsCached(aiProvider, { apiKey, baseUrl, kind: 'chat' })
                .then((models) => {
                    if (!cancelled) setFetchedChatModels(models);
                })
                .catch(() => {
                    // Static catalog stays; nothing to tell the user.
                });
        }, AI_MODEL_FETCH_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [aiApiKey, aiBaseUrl, aiEnabled, aiProvider, consentMap, isFossBuild]);

    // Live speech model list (#986). Whisper is a local sha256-pinned catalog —
    // never fetched, which also covers FOSS builds (Whisper is their only STT).
    useEffect(() => {
        setFetchedSpeechModels(null);
        const apiKey = speechApiKey.trim();
        const baseUrl = speechBaseUrl.trim();
        const kind = getSpeechModelListKind({ provider: speechProvider, apiKey, baseUrl });
        if (!kind || speechProvider === 'whisper') return;
        if (!consentMap || !canDiscoverAIModels({ provider: speechProvider, consent: consentMap, aiEnabled, aiProvider })) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            fetchProviderModelsCached(speechProvider, { apiKey, baseUrl, kind })
                .then((models) => {
                    if (!cancelled) setFetchedSpeechModels(models);
                })
                .catch(() => {
                    // Static list stays.
                });
        }, AI_MODEL_FETCH_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [aiEnabled, aiProvider, consentMap, speechApiKey, speechBaseUrl, speechProvider]);

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
        updateAISettings(getAnthropicThinkingPatch(value));
    }, [updateAISettings]);

    const applyWhisperModel = (modelId: string) => {
        updateSpeechSettings({ model: modelId, offlineModelPath: whisperModelStore.getPreferredModelUri(modelId) });
    };

    const handleSpeechProviderChange = useCallback((provider: 'openai' | 'gemini' | 'whisper') => {
        updateSpeechSettings(getSpeechProviderPatch(provider, whisperModelStore.getPreferredModelUri));
    }, [updateSpeechSettings]);

    const handleSpeechApiKeyChange = useCallback((value: string) => {
        setSpeechKey({ provider: speechProvider, value });
        if (speechProvider === 'whisper') return;
        saveAIKey(speechProvider, value).catch(logSettingsError);
    }, [speechProvider]);

    const handleSpeechLanguageChange = useCallback((value: string) => {
        updateSpeechSettings({ language: normalizeSpeechLanguageInput(value) });
    }, [updateSpeechSettings]);

    const selectedWhisperModel = getSelectedMobileWhisperModel(speechModel);

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
                        appleClarificationAvailability={appleClarificationAvailability}
                        appleClarificationBackend={appleClarificationBackend}
                        appleClarificationVisible={appleClarificationPrototypeEnabled}
                        aiReasoningEffort={aiReasoningEffort}
                        aiRequestTimeoutSeconds={aiRequestTimeoutSeconds}
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
                        onAppleClarificationBackendChange={handleAppleClarificationBackendChange}
                        onAiReasoningEffortChange={(value) => updateAISettings({ reasoningEffort: value })}
                        onAiRequestTimeoutSecondsChange={(value) => updateAISettings({ requestTimeoutSeconds: value })}
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
                                                {selected && <Check size={18} color={tc.tint} strokeWidth={2.5} />}
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
