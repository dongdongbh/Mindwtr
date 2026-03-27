import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    getCopilotModelOptions,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getModelOptions,
    type AIProviderId,
    type AIReasoningEffort,
    useTaskStore,
} from '@mindwtr/core';

import { loadAIKey, saveAIKey } from '@/lib/ai-config';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError, logSettingsWarn } from '@/lib/settings-utils';

import {
    AI_PROVIDER_CONSENT_KEY,
    DEFAULT_WHISPER_MODEL,
    FOSS_LOCAL_LLM_COPILOT_OPTIONS,
    FOSS_LOCAL_LLM_MODEL_OPTIONS,
    MobileExtraConfig,
    WHISPER_MODEL_BASE_URL,
    WHISPER_MODELS,
} from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

export function AISettingsScreen() {
    const tc = useThemeColors();
    const { localize, t } = useSettingsLocalization();
    const scrollContentStyleWithKeyboard = useSettingsScrollContent(140);
    const { settings, updateSettings } = useTaskStore();
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
    const isExpoGo = Constants.appOwnership === 'expo';
    const [aiApiKey, setAiApiKey] = useState('');
    const [speechApiKey, setSpeechApiKey] = useState('');
    const [whisperDownloadState, setWhisperDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
    const [whisperDownloadError, setWhisperDownloadError] = useState('');
    const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
    const [speechOpen, setSpeechOpen] = useState(false);
    const [modelPicker, setModelPicker] = useState<null | 'model' | 'copilot' | 'speech'>(null);

    const aiProvider = (isFossBuild ? 'openai' : (settings.ai?.provider ?? 'openai')) as AIProviderId;
    const aiEnabled = settings.ai?.enabled === true;
    const aiModelOptions = isFossBuild ? FOSS_LOCAL_LLM_MODEL_OPTIONS : getModelOptions(aiProvider);
    const aiModel = settings.ai?.model ?? (isFossBuild ? FOSS_LOCAL_LLM_MODEL_OPTIONS[0] : getDefaultAIConfig(aiProvider).model);
    const aiBaseUrl = settings.ai?.baseUrl ?? '';
    const aiReasoningEffort = (settings.ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT) as AIReasoningEffort;
    const aiThinkingBudget = settings.ai?.thinkingBudget ?? getDefaultAIConfig(aiProvider).thinkingBudget ?? 0;
    const aiCopilotOptions = isFossBuild ? FOSS_LOCAL_LLM_COPILOT_OPTIONS : getCopilotModelOptions(aiProvider);
    const aiCopilotModel = settings.ai?.copilotModel ?? (isFossBuild ? FOSS_LOCAL_LLM_COPILOT_OPTIONS[0] : getDefaultCopilotModel(aiProvider));
    const anthropicThinkingEnabled = aiProvider === 'anthropic' && aiThinkingBudget > 0;
    const speechSettings = settings.ai?.speechToText ?? {};
    const speechEnabled = speechSettings.enabled === true;
    const speechProvider = (isFossBuild ? 'whisper' : (speechSettings.provider ?? 'gemini')) as 'openai' | 'gemini' | 'whisper';
    const speechModel = speechSettings.model ?? (
        speechProvider === 'openai'
            ? 'gpt-4o-transcribe'
            : speechProvider === 'gemini'
                ? 'gemini-2.5-flash'
                : DEFAULT_WHISPER_MODEL
    );
    const speechLanguage = speechSettings.language ?? 'auto';
    const speechMode = speechSettings.mode ?? 'smart_parse';
    const speechFieldStrategy = speechSettings.fieldStrategy ?? 'smart';
    const speechModelOptions = isFossBuild
        ? WHISPER_MODELS.map((model) => model.id)
        : speechProvider === 'openai'
            ? ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1']
            : speechProvider === 'gemini'
                ? ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']
                : WHISPER_MODELS.map((model) => model.id);

    const updateAISettings = useCallback((next: Partial<NonNullable<typeof settings.ai>>) => {
        updateSettings({ ai: { ...(settings.ai ?? {}), ...next } }).catch(logSettingsError);
    }, [settings.ai, updateSettings]);

    const getAIProviderLabel = (provider: AIProviderId): string => (
        isFossBuild && provider === 'openai'
            ? localize('Local / Custom (OpenAI-compatible)', '本地 / 自定义（OpenAI 兼容）')
            : provider === 'openai'
                ? t('settings.aiProviderOpenAI')
                : provider === 'gemini'
                    ? t('settings.aiProviderGemini')
                    : t('settings.aiProviderAnthropic')
    );

    const getAIProviderPolicyUrl = (provider: AIProviderId): string => (
        isFossBuild && provider === 'openai'
            ? ''
            : provider === 'openai'
                ? 'https://openai.com/policies/privacy-policy'
                : provider === 'gemini'
                    ? 'https://policies.google.com/privacy'
                    : 'https://www.anthropic.com/privacy'
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
        const title = localize('Enable AI features?', '启用 AI 功能？');
        const message = isFossBuild && provider === 'openai'
            ? localize(
                'To use AI assistant, your task text and optional notes will be sent directly to your configured OpenAI-compatible endpoint (for example, a local or self-hosted LLM server) using your API key. Mindwtr does not collect this data. Do you want to continue?',
                '要使用 AI 助手，任务文本和可选备注会通过你的 API Key 直接发送到你配置的 OpenAI 兼容端点（例如本地或自托管 LLM 服务）。Mindwtr 不会收集这些数据。是否继续？'
            )
            : localize(
                `To use AI assistant, your task text and optional notes will be sent directly to ${providerLabel} using your API key. Mindwtr does not collect this data. Provider privacy policy: ${policyUrl}. Do you want to continue?`,
                `要使用 AI 助手，任务文本和可选备注会通过你的 API Key 直接发送到 ${providerLabel}。Mindwtr 不会收集这些数据。服务商隐私政策：${policyUrl}。是否继续？`
            );

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
                        text: localize('Cancel', '取消'),
                        style: 'cancel',
                        onPress: () => finish(false),
                    },
                    {
                        text: localize('Agree', '同意'),
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

    const updateSpeechSettings = (
        next: Partial<NonNullable<NonNullable<typeof settings.ai>['speechToText']>>
    ) => {
        updateAISettings({ speechToText: { ...(settings.ai?.speechToText ?? {}), ...next } });
    };

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
    }, [isFossBuild, settings.ai?.speechToText?.model, settings.ai?.speechToText?.provider]);

    useEffect(() => {
        loadAIKey(aiProvider).then(setAiApiKey).catch(logSettingsError);
    }, [aiProvider]);

    useEffect(() => {
        if (speechProvider === 'whisper') {
            setSpeechApiKey('');
            return;
        }
        loadAIKey(speechProvider).then(setSpeechApiKey).catch(logSettingsError);
    }, [speechProvider]);

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

    const getWhisperDirectories = () => {
        const candidates: Directory[] = [];
        try {
            candidates.push(new Directory(Paths.cache, 'whisper-models'));
        } catch (error) {
            logSettingsWarn('Whisper cache directory unavailable', error);
        }
        if (!candidates.length) {
            try {
                candidates.push(new Directory(Paths.document, 'whisper-models'));
            } catch (error) {
                logSettingsWarn('Whisper document directory unavailable', error);
            }
        }
        return candidates;
    };

    const getWhisperDirectory = () => {
        const candidates = getWhisperDirectories();
        return candidates.length ? candidates[0] : null;
    };

    const normalizeWhisperPath = (uri: string) => {
        if (uri.startsWith('file://')) return uri;
        if (uri.startsWith('file:/')) {
            const stripped = uri.replace(/^file:\//, '/');
            return `file://${stripped}`;
        }
        if (uri.startsWith('/')) {
            return `file://${uri}`;
        }
        return uri;
    };

    const safePathInfo = (uri: string) => {
        const normalized = normalizeWhisperPath(uri);
        try {
            const info = Paths.info(normalized);
            if (info) return info;
        } catch (error) {
            logSettingsWarn('Whisper path info failed', error);
        }
        try {
            const file = new File(normalized);
            if (file.exists) {
                const size = typeof file.size === 'number' ? file.size : 0;
                return { exists: true, isDirectory: false, size };
            }
        } catch {
        }
        try {
            const dir = new Directory(normalized);
            if (dir.exists) {
                return { exists: true, isDirectory: true, size: 0 };
            }
        } catch {
        }
        return null;
    };

    const resolveWhisperModelPath = (modelId: string) => {
        const model = WHISPER_MODELS.find((entry) => entry.id === modelId);
        if (!model) return undefined;
        const base = getWhisperDirectory();
        if (!base) return undefined;
        const baseUri = base.uri.endsWith('/') ? base.uri : `${base.uri}/`;
        return new File(`${baseUri}${model.fileName}`).uri;
    };

    const findExistingWhisperModelPath = (modelId: string) => {
        const model = WHISPER_MODELS.find((entry) => entry.id === modelId);
        if (!model) return undefined;
        const fileName = model.fileName;
        const candidates: string[] = [];
        const appendCandidates = (base?: string | null) => {
            if (!base) return;
            const normalized = base.endsWith('/') ? base : `${base}/`;
            candidates.push(`${normalized}whisper-models/${fileName}`);
            candidates.push(`${normalized}${fileName}`);
        };
        appendCandidates(Paths.cache?.uri ?? null);
        appendCandidates(Paths.document?.uri ?? null);
        for (const candidate of candidates) {
            try {
                const info = safePathInfo(candidate);
                if (info?.exists && !info.isDirectory) {
                    return candidate;
                }
            } catch {
            }
        }
        return undefined;
    };

    const isWhisperModelFilePath = (uri?: string) => {
        if (!uri) return false;
        const baseName = Paths.basename(uri);
        return Boolean(baseName && baseName.endsWith('.bin'));
    };

    const isWhisperTargetPath = (uri: string, fileName: string) => {
        const baseName = Paths.basename(uri);
        if (baseName !== fileName) return false;
        return uri.includes('/whisper-models/') || uri.includes('\\whisper-models\\');
    };

    const applyWhisperModel = (modelId: string) => {
        updateSpeechSettings({ model: modelId, offlineModelPath: resolveWhisperModelPath(modelId) });
    };

    useEffect(() => {
        if (speechProvider !== 'whisper') return;
        const storedPath = speechSettings.offlineModelPath;
        if (!storedPath) return;
        const info = safePathInfo(storedPath);
        if (info?.exists && info.isDirectory) {
            const resolved = resolveWhisperModelPath(speechModel);
            updateSpeechSettings({ offlineModelPath: resolved });
            return;
        }
        if (!info?.exists || info.isDirectory) {
            const existing = findExistingWhisperModelPath(speechModel);
            if (existing && existing !== storedPath) {
                updateSpeechSettings({ offlineModelPath: existing });
                return;
            }
        }
        if (!isWhisperModelFilePath(storedPath)) {
            const resolved = resolveWhisperModelPath(speechModel);
            if (resolved && resolved !== storedPath) {
                updateSpeechSettings({ offlineModelPath: resolved });
            }
        }
    }, [speechModel, speechProvider, speechSettings.offlineModelPath]);

    const selectedWhisperModel = WHISPER_MODELS.find((model) => model.id === speechModel) ?? WHISPER_MODELS[0];
    const whisperModelPath = speechProvider === 'whisper'
        ? (speechSettings.offlineModelPath ?? resolveWhisperModelPath(speechModel))
        : undefined;
    let whisperDownloaded = false;
    let whisperSizeLabel = '';
    if (whisperModelPath) {
        const info = safePathInfo(whisperModelPath);
        if (info?.exists && info.isDirectory === false) {
            try {
                const file = new File(normalizeWhisperPath(whisperModelPath));
                whisperDownloaded = (file.size ?? 0) > 0;
                if (whisperDownloaded && file.size) {
                    whisperSizeLabel = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
                }
            } catch (error) {
                logSettingsWarn('Whisper file info failed', error);
            }
        }
    }

    const handleDownloadWhisperModel = async () => {
        if (!selectedWhisperModel) return;
        if (isExpoGo) {
            const message = localize(
                'Whisper downloads require a dev build or production build (not Expo Go).',
                'Whisper 下载需要开发版或正式版构建（Expo Go 不支持）。'
            );
            setWhisperDownloadError(message);
            setWhisperDownloadState('error');
            Alert.alert(t('settings.speechOfflineDownloadError'), message);
            return;
        }
        setWhisperDownloadError('');
        setWhisperDownloadState('downloading');
        const clearSuccess = () => {
            setTimeout(() => setWhisperDownloadState('idle'), 2000);
        };
        try {
            const directories = getWhisperDirectories();
            if (!directories.length) {
                throw new Error('Whisper storage unavailable');
            }
            const fileName = selectedWhisperModel.fileName;
            if (!fileName) {
                throw new Error('Whisper model filename missing');
            }
            const url = `${WHISPER_MODEL_BASE_URL}/${fileName}`;
            let lastError: Error | null = null;
            for (const directory of directories) {
                try {
                    directory.create({ intermediates: true, idempotent: true });
                    const dirUri = directory.uri.endsWith('/') ? directory.uri : `${directory.uri}/`;
                    const targetFile = new File(`${dirUri}${fileName}`);
                    const conflictInfo = safePathInfo(targetFile.uri);
                    if (conflictInfo?.exists && conflictInfo.isDirectory) {
                        if (!isWhisperTargetPath(targetFile.uri, fileName)) {
                            throw new Error(localize(
                                `Offline model path is not safe to modify (${targetFile.uri}).`,
                                `离线模型路径不安全，无法自动处理（${targetFile.uri}）。`
                            ));
                        }
                    }
                    const postCleanupInfo = safePathInfo(targetFile.uri);
                    if (postCleanupInfo?.exists && postCleanupInfo.isDirectory) {
                        throw new Error(localize(
                            `Offline model path is a folder (${targetFile.uri}). Please remove it and try again.`,
                            `离线模型路径是文件夹（${targetFile.uri}），请删除后重试。`
                        ));
                    }
                    const existingInfo = safePathInfo(targetFile.uri);
                    if (existingInfo?.exists && existingInfo.isDirectory === false) {
                        try {
                            const existingFile = new File(targetFile.uri);
                            if ((existingFile.size ?? 0) > 0) {
                                updateSpeechSettings({ offlineModelPath: targetFile.uri, model: selectedWhisperModel.id });
                                setWhisperDownloadState('success');
                                clearSuccess();
                                return;
                            }
                        } catch (error) {
                            logSettingsWarn('Whisper existing file check failed', error);
                        }
                    }
                    try {
                        const file = await File.downloadFileAsync(url, targetFile, { idempotent: true });
                        updateSpeechSettings({ offlineModelPath: file.uri, model: selectedWhisperModel.id });
                    } catch (downloadError) {
                        const fallbackMessage = localize(
                            'Download failed. Please retry on Wi-Fi. Large models cannot be buffered into memory.',
                            '下载失败。请在 Wi-Fi 下重试。大型模型无法加载到内存。'
                        );
                        throw new Error(downloadError instanceof Error
                            ? `${fallbackMessage}\n${downloadError.message}`
                            : fallbackMessage);
                    }
                    setWhisperDownloadState('success');
                    clearSuccess();
                    return;
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    logSettingsWarn('Whisper model download failed', error);
                }
            }
            throw lastError ?? new Error('Whisper storage unavailable');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setWhisperDownloadError(message);
            setWhisperDownloadState('error');
            logSettingsWarn('Whisper model download failed', error);
            Alert.alert(t('settings.speechOfflineDownloadError'), message);
        }
    };

    const handleDeleteWhisperModel = () => {
        try {
            if (whisperModelPath) {
                const info = safePathInfo(whisperModelPath);
                const basename = Paths.basename(whisperModelPath);
                if (basename && basename.endsWith('.bin') && info?.exists) {
                    if (info.isDirectory) {
                        const dir = new Directory(normalizeWhisperPath(whisperModelPath));
                        dir.delete();
                    } else {
                        const file = new File(normalizeWhisperPath(whisperModelPath));
                        file.delete();
                    }
                }
            }
            updateSpeechSettings({ offlineModelPath: undefined });
        } catch (error) {
            logSettingsWarn('Whisper model delete failed', error);
            Alert.alert(t('settings.speechOfflineDeleteError'), t('settings.speechOfflineDeleteErrorBody'));
        }
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <SubHeader title={t('settings.ai')} />
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
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <TouchableOpacity style={styles.settingRow} onPress={() => setAiAssistantOpen((prev) => !prev)}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.ai')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiDesc')}</Text>
                            </View>
                            <Text style={[styles.chevron, { color: tc.secondaryText }]}>{aiAssistantOpen ? '▾' : '▸'}</Text>
                        </TouchableOpacity>

                        {aiAssistantOpen && (
                            <>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiEnable')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {localize(
                                                `When enabled, task text is sent directly to ${getAIProviderLabel(aiProvider)} using your API key.`,
                                                `启用后，任务文本将通过你的 API Key 直接发送到 ${getAIProviderLabel(aiProvider)}。`
                                            )}
                                        </Text>
                                    </View>
                                    <Switch
                                        value={aiEnabled}
                                        onValueChange={handleAIEnabledToggle}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiProvider')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{getAIProviderLabel(aiProvider)}</Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                    <View style={styles.backendToggle}>
                                        <TouchableOpacity
                                            style={[
                                                styles.backendOption,
                                                { borderColor: tc.border, backgroundColor: aiProvider === 'openai' ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => handleAIProviderChange('openai')}
                                        >
                                            <Text style={[styles.backendOptionText, { color: aiProvider === 'openai' ? tc.tint : tc.secondaryText }]}>
                                                {getAIProviderLabel('openai')}
                                            </Text>
                                        </TouchableOpacity>
                                        {!isFossBuild && (
                                            <TouchableOpacity
                                                style={[
                                                    styles.backendOption,
                                                    { borderColor: tc.border, backgroundColor: aiProvider === 'gemini' ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => handleAIProviderChange('gemini')}
                                            >
                                                <Text style={[styles.backendOptionText, { color: aiProvider === 'gemini' ? tc.tint : tc.secondaryText }]}>
                                                    {t('settings.aiProviderGemini')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                        {!isFossBuild && (
                                            <TouchableOpacity
                                                style={[
                                                    styles.backendOption,
                                                    { borderColor: tc.border, backgroundColor: aiProvider === 'anthropic' ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => handleAIProviderChange('anthropic')}
                                            >
                                                <Text style={[styles.backendOptionText, { color: aiProvider === 'anthropic' ? tc.tint : tc.secondaryText }]}>
                                                    {t('settings.aiProviderAnthropic')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                </View>

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiModel')}</Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                    <View style={styles.modelInputRow}>
                                        <TextInput
                                            value={aiModel}
                                            onChangeText={(value) => updateAISettings({ model: value })}
                                            placeholder={aiModelOptions[0]}
                                            placeholderTextColor={tc.secondaryText}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            style={[styles.modelTextInput, { borderColor: tc.border, color: tc.text }]}
                                        />
                                        <TouchableOpacity
                                            style={[styles.modelSuggestButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                            onPress={() => setModelPicker('model')}
                                        >
                                            <Text style={[styles.modelSuggestButtonText, { color: tc.secondaryText }]}>
                                                {localize('Suggestions', '建议')}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiCopilotModel')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiCopilotHint')}</Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                    <View style={styles.modelInputRow}>
                                        <TextInput
                                            value={aiCopilotModel}
                                            onChangeText={(value) => updateAISettings({ copilotModel: value })}
                                            placeholder={aiCopilotOptions[0]}
                                            placeholderTextColor={tc.secondaryText}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            style={[styles.modelTextInput, { borderColor: tc.border, color: tc.text }]}
                                        />
                                        <TouchableOpacity
                                            style={[styles.modelSuggestButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                            onPress={() => setModelPicker('copilot')}
                                        >
                                            <Text style={[styles.modelSuggestButtonText, { color: tc.secondaryText }]}>
                                                {localize('Suggestions', '建议')}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                {aiProvider === 'openai' && (
                                    <>
                                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <View style={styles.settingInfo}>
                                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiReasoning')}</Text>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                    {t(isFossBuild ? 'settings.aiReasoningHintFoss' : 'settings.aiReasoningHint')}
                                                </Text>
                                            </View>
                                        </View>
                                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                            <View style={styles.backendToggle}>
                                                {(['low', 'medium', 'high'] as AIReasoningEffort[]).map((effort) => (
                                                    <TouchableOpacity
                                                        key={effort}
                                                        style={[
                                                            styles.backendOption,
                                                            { borderColor: tc.border, backgroundColor: aiReasoningEffort === effort ? tc.filterBg : 'transparent' },
                                                        ]}
                                                        onPress={() => updateAISettings({ reasoningEffort: effort })}
                                                    >
                                                        <Text style={[styles.backendOptionText, { color: aiReasoningEffort === effort ? tc.tint : tc.secondaryText }]}>
                                                            {effort === 'low'
                                                                ? t('settings.aiEffortLow')
                                                                : effort === 'medium'
                                                                    ? t('settings.aiEffortMedium')
                                                                    : t('settings.aiEffortHigh')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                ))}
                                            </View>
                                        </View>
                                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <View style={styles.settingInfo}>
                                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiBaseUrl')}</Text>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiBaseUrlHint')}</Text>
                                            </View>
                                        </View>
                                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                            <TextInput
                                                value={aiBaseUrl}
                                                onChangeText={(value) => updateAISettings({ baseUrl: value })}
                                                placeholder={t('settings.aiBaseUrlPlaceholder')}
                                                placeholderTextColor={tc.secondaryText}
                                                autoCapitalize="none"
                                                autoCorrect={false}
                                                style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                            />
                                        </View>
                                    </>
                                )}

                                {aiProvider === 'gemini' && (
                                    <>
                                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <View style={styles.settingInfo}>
                                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiThinkingBudget')}</Text>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiThinkingHint')}</Text>
                                            </View>
                                        </View>
                                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                            <View style={styles.backendToggle}>
                                                {[
                                                    { value: 0, label: t('settings.aiThinkingOff') },
                                                    { value: 128, label: t('settings.aiThinkingLow') },
                                                    { value: 256, label: t('settings.aiThinkingMedium') },
                                                    { value: 512, label: t('settings.aiThinkingHigh') },
                                                ].map((option) => (
                                                    <TouchableOpacity
                                                        key={option.value}
                                                        style={[
                                                            styles.backendOption,
                                                            { borderColor: tc.border, backgroundColor: aiThinkingBudget === option.value ? tc.filterBg : 'transparent' },
                                                        ]}
                                                        onPress={() => updateAISettings({ thinkingBudget: option.value })}
                                                    >
                                                        <Text style={[styles.backendOptionText, { color: aiThinkingBudget === option.value ? tc.tint : tc.secondaryText }]}>
                                                            {option.label}
                                                        </Text>
                                                    </TouchableOpacity>
                                                ))}
                                            </View>
                                        </View>
                                    </>
                                )}

                                {aiProvider === 'anthropic' && (
                                    <>
                                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <View style={styles.settingInfo}>
                                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiThinkingEnable')}</Text>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiThinkingEnableDesc')}</Text>
                                            </View>
                                            <Switch
                                                value={anthropicThinkingEnabled}
                                                onValueChange={(value) => updateAISettings({
                                                    thinkingBudget: value ? (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024) : 0,
                                                })}
                                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                                            />
                                        </View>
                                        {anthropicThinkingEnabled && (
                                            <>
                                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                                    <View style={styles.settingInfo}>
                                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiThinkingBudget')}</Text>
                                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiThinkingHint')}</Text>
                                                    </View>
                                                </View>
                                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                                    <View style={styles.backendToggle}>
                                                        {[
                                                            { value: DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024, label: t('settings.aiThinkingLow') },
                                                            { value: 2048, label: t('settings.aiThinkingMedium') },
                                                            { value: 4096, label: t('settings.aiThinkingHigh') },
                                                        ].map((option) => (
                                                            <TouchableOpacity
                                                                key={option.value}
                                                                style={[
                                                                    styles.backendOption,
                                                                    { borderColor: tc.border, backgroundColor: aiThinkingBudget === option.value ? tc.filterBg : 'transparent' },
                                                                ]}
                                                                onPress={() => updateAISettings({ thinkingBudget: option.value })}
                                                            >
                                                                <Text style={[styles.backendOptionText, { color: aiThinkingBudget === option.value ? tc.tint : tc.secondaryText }]}>
                                                                    {option.label}
                                                                </Text>
                                                            </TouchableOpacity>
                                                        ))}
                                                    </View>
                                                </View>
                                            </>
                                        )}
                                    </>
                                )}

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiApiKey')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiApiKeyHint')}</Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                                    <TextInput
                                        value={aiApiKey}
                                        onChangeText={(value) => {
                                            setAiApiKey(value);
                                            saveAIKey(aiProvider, value).catch(logSettingsError);
                                        }}
                                        placeholder={t('settings.aiApiKeyPlaceholder')}
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        secureTextEntry
                                        style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                    />
                                </View>
                            </>
                        )}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <TouchableOpacity style={styles.settingRow} onPress={() => setSpeechOpen((prev) => !prev)}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechTitle')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechDesc')}</Text>
                            </View>
                            <Text style={[styles.chevron, { color: tc.secondaryText }]}>{speechOpen ? '▾' : '▸'}</Text>
                        </TouchableOpacity>

                        {speechOpen && (
                            <>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechEnable')}</Text>
                                    </View>
                                    <Switch
                                        value={speechEnabled}
                                        onValueChange={(value) => updateSpeechSettings({ enabled: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechProvider')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {speechProvider === 'openai'
                                                ? t('settings.aiProviderOpenAI')
                                                : speechProvider === 'gemini'
                                                    ? t('settings.aiProviderGemini')
                                                    : t('settings.speechProviderOffline')}
                                        </Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                    <View style={styles.backendToggle}>
                                        {!isFossBuild && (
                                            <TouchableOpacity
                                                style={[
                                                    styles.backendOption,
                                                    { borderColor: tc.border, backgroundColor: speechProvider === 'openai' ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    updateSpeechSettings({
                                                        provider: 'openai',
                                                        model: 'gpt-4o-transcribe',
                                                        offlineModelPath: undefined,
                                                    });
                                                }}
                                            >
                                                <Text style={[styles.backendOptionText, { color: speechProvider === 'openai' ? tc.tint : tc.secondaryText }]}>
                                                    {t('settings.aiProviderOpenAI')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                        {!isFossBuild && (
                                            <TouchableOpacity
                                                style={[
                                                    styles.backendOption,
                                                    { borderColor: tc.border, backgroundColor: speechProvider === 'gemini' ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    updateSpeechSettings({
                                                        provider: 'gemini',
                                                        model: 'gemini-2.5-flash',
                                                        offlineModelPath: undefined,
                                                    });
                                                }}
                                            >
                                                <Text style={[styles.backendOptionText, { color: speechProvider === 'gemini' ? tc.tint : tc.secondaryText }]}>
                                                    {t('settings.aiProviderGemini')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                        <TouchableOpacity
                                            style={[
                                                styles.backendOption,
                                                { borderColor: tc.border, backgroundColor: speechProvider === 'whisper' ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                updateSpeechSettings({
                                                    provider: 'whisper',
                                                    model: DEFAULT_WHISPER_MODEL,
                                                    offlineModelPath: resolveWhisperModelPath(DEFAULT_WHISPER_MODEL),
                                                });
                                            }}
                                        >
                                            <Text style={[styles.backendOptionText, { color: speechProvider === 'whisper' ? tc.tint : tc.secondaryText }]}>
                                                {isFossBuild ? localize('Local Whisper', '本地 Whisper') : t('settings.speechProviderOffline')}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechModel')}</Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                    <TouchableOpacity
                                        style={[styles.dropdownButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                        onPress={() => setModelPicker('speech')}
                                    >
                                        <Text style={[styles.dropdownValue, { color: tc.text }]} numberOfLines={1}>{speechModel}</Text>
                                        <Text style={[styles.dropdownChevron, { color: tc.secondaryText }]}>▾</Text>
                                    </TouchableOpacity>
                                </View>

                                {speechProvider === 'whisper' ? (
                                    <>
                                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <View style={styles.settingInfo}>
                                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechOfflineModel')}</Text>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechOfflineModelDesc')}</Text>
                                                {isExpoGo ? (
                                                    <Text style={[styles.settingDescription, { color: tc.danger, marginTop: 6 }]}>
                                                        {localize(
                                                            'Whisper transcription requires a dev build or production build (not Expo Go).',
                                                            'Whisper 转录需要开发版或正式版构建（Expo Go 不支持）。'
                                                        )}
                                                    </Text>
                                                ) : null}
                                            </View>
                                        </View>
                                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                                <View style={{ flex: 1 }}>
                                                    <Text style={{ color: tc.secondaryText, fontSize: 12 }}>
                                                        {whisperDownloaded ? t('settings.speechOfflineReady') : t('settings.speechOfflineNotDownloaded')}
                                                        {whisperSizeLabel ? ` - ${whisperSizeLabel}` : ''}
                                                    </Text>
                                                    {whisperDownloadState === 'success' ? (
                                                        <Text style={{ color: tc.tint, fontSize: 12, marginTop: 6 }}>
                                                            {t('settings.speechOfflineDownloadSuccess')}
                                                        </Text>
                                                    ) : null}
                                                    {whisperDownloadError ? (
                                                        <Text style={{ color: tc.danger, fontSize: 12, marginTop: 6 }}>{whisperDownloadError}</Text>
                                                    ) : null}
                                                </View>
                                                {whisperDownloadState === 'downloading' ? (
                                                    <ActivityIndicator color={tc.tint} />
                                                ) : whisperDownloaded ? (
                                                    <TouchableOpacity
                                                        style={[styles.backendOption, { borderColor: tc.border }]}
                                                        onPress={handleDeleteWhisperModel}
                                                    >
                                                        <Text style={[styles.backendOptionText, { color: tc.text }]}>
                                                            {t('settings.speechOfflineDelete')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                ) : (
                                                    <TouchableOpacity
                                                        style={[styles.backendOption, { borderColor: tc.border }]}
                                                        onPress={() => void handleDownloadWhisperModel()}
                                                    >
                                                        <Text style={[styles.backendOptionText, { color: tc.text }]}>
                                                            {t('settings.speechOfflineDownload')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                )}
                                            </View>
                                        </View>
                                    </>
                                ) : (
                                    <>
                                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <View style={styles.settingInfo}>
                                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiApiKey')}</Text>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiApiKeyHint')}</Text>
                                            </View>
                                        </View>
                                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                            <TextInput
                                                value={speechApiKey}
                                                onChangeText={(value) => {
                                                    setSpeechApiKey(value);
                                                    saveAIKey(speechProvider, value).catch(logSettingsError);
                                                }}
                                                placeholder={t('settings.aiApiKeyPlaceholder')}
                                                placeholderTextColor={tc.secondaryText}
                                                autoCapitalize="none"
                                                secureTextEntry
                                                style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                            />
                                        </View>
                                    </>
                                )}

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechLanguage')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechLanguageHint')}</Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                    <TextInput
                                        value={speechLanguage === 'auto' ? '' : speechLanguage}
                                        onChangeText={(value) => {
                                            const trimmed = value.trim();
                                            updateSpeechSettings({ language: trimmed ? trimmed : 'auto' });
                                        }}
                                        placeholder={t('settings.speechLanguageAuto')}
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                    />
                                </View>

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechMode')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechModeHint')}</Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                    <View style={styles.backendToggle}>
                                        <TouchableOpacity
                                            style={[
                                                styles.backendOption,
                                                { borderColor: tc.border, backgroundColor: speechMode === 'smart_parse' ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => updateSpeechSettings({ mode: 'smart_parse' })}
                                        >
                                            <Text style={[styles.backendOptionText, { color: speechMode === 'smart_parse' ? tc.tint : tc.secondaryText }]}>
                                                {t('settings.speechModeSmart')}
                                            </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={[
                                                styles.backendOption,
                                                { borderColor: tc.border, backgroundColor: speechMode === 'transcribe_only' ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => updateSpeechSettings({ mode: 'transcribe_only' })}
                                        >
                                            <Text style={[styles.backendOptionText, { color: speechMode === 'transcribe_only' ? tc.tint : tc.secondaryText }]}>
                                                {t('settings.speechModeTranscript')}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechFieldStrategy')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.speechFieldStrategyHint')}</Text>
                                    </View>
                                </View>
                                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                                    <View style={styles.backendToggle}>
                                        {[
                                            { value: 'smart', label: t('settings.speechFieldSmart') },
                                            { value: 'title_only', label: t('settings.speechFieldTitle') },
                                            { value: 'description_only', label: t('settings.speechFieldDescription') },
                                        ].map((option) => (
                                            <TouchableOpacity
                                                key={option.value}
                                                style={[
                                                    styles.backendOption,
                                                    { borderColor: tc.border, backgroundColor: speechFieldStrategy === option.value ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => updateSpeechSettings({ fieldStrategy: option.value as 'smart' | 'title_only' | 'description_only' })}
                                            >
                                                <Text style={[styles.backendOptionText, { color: speechFieldStrategy === option.value ? tc.tint : tc.secondaryText }]}>
                                                    {option.label}
                                                </Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                </View>
                            </>
                        )}
                    </View>

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
