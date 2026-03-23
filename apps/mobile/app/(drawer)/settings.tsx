import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
    View,
    Text,
    TextInput,
    Switch,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Linking,
    Alert,
    ActivityIndicator,
    Platform,
    KeyboardAvoidingView,
    Modal,
    Pressable,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage, Language } from '../../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import {
    DEFAULT_REASONING_EFFORT,
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    cloudGetJson,
    generateUUID,
    getDefaultAIConfig,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    normalizeCloudUrl,
    normalizeWebdavUrl,
    getDefaultCopilotModel,
    getCopilotModelOptions,
    getModelOptions,
    resolveDateLocaleTag,
    translateText,
    webdavGetJson,
    type AIProviderId,
    type AIReasoningEffort,
    type AppData,
    type ExternalCalendarSubscription,
    type TaskEditorFieldId,
    type TaskEditorSectionId,
    type TimeEstimate,
    useTaskStore,
} from '@mindwtr/core';
import { pickAndParseSyncFolder, exportData } from '../../lib/storage-file';
import {
    fetchExternalCalendarEvents,
    getExternalCalendars,
    getSystemCalendarPermissionStatus,
    getSystemCalendars,
    getSystemCalendarSettings,
    requestSystemCalendarPermission,
    saveExternalCalendars,
    saveSystemCalendarSettings,
    type SystemCalendarInfo,
    type SystemCalendarPermissionStatus,
} from '../../lib/external-calendar';
import { loadAIKey, saveAIKey } from '../../lib/ai-config';
import { clearLog, ensureLogFilePath, logInfo } from '../../lib/app-log';
import {
    performMobileSync,
} from '../../lib/sync-service';
import { isCloudKitAvailable } from '../../lib/cloudkit-sync';
import { coerceSupportedBackend, isLikelyOfflineSyncError } from '../../lib/sync-service-utils';
import { requestNotificationPermission, startMobileNotifications } from '../../lib/notification-service';
import { authorizeDropbox, getDropboxRedirectUri } from '../../lib/dropbox-oauth';
import {
    disconnectDropbox,
    forceRefreshDropboxAccessToken,
    getValidDropboxAccessToken,
    isDropboxClientConfigured,
    isDropboxConnected,
} from '../../lib/dropbox-auth';
import { testDropboxAccess } from '../../lib/dropbox-sync';
import {
    compareVersions,
    formatClockSkew,
    formatError,
    isDropboxUnauthorizedError,
    logSettingsError,
    logSettingsWarn,
    maskCalendarUrl,
} from '../../lib/settings-utils';
import {
    buildTaskEditorPresetConfig,
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_SECTION_BY_FIELD,
    DEFAULT_TASK_EDITOR_SECTION_OPEN,
    DEFAULT_TASK_EDITOR_VISIBLE,
    TASK_EDITOR_FIXED_FIELDS,
    TASK_EDITOR_SECTION_ORDER,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    isTaskEditorSectionableField,
    resolveTaskEditorPresetId,
    type TaskEditorPresetId,
} from '../../components/task-edit/task-edit-modal.utils';
import {
    SYNC_PATH_KEY,
    SYNC_BACKEND_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    WEBDAV_PASSWORD_KEY,
    CLOUD_URL_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_PROVIDER_KEY,
} from '../../lib/sync-constants';

type SettingsScreen =
    | 'main'
    | 'general'
    | 'notifications'
    | 'ai'
    | 'calendar'
    | 'advanced'
    | 'gtd'
    | 'gtd-archive'
    | 'gtd-time-estimates'
    | 'gtd-task-editor'
    | 'manage'
    | 'sync'
    | 'about';

const SETTINGS_SCREEN_SET: Record<SettingsScreen, true> = {
    main: true,
    general: true,
    notifications: true,
    ai: true,
    calendar: true,
    advanced: true,
    gtd: true,
    'gtd-archive': true,
    'gtd-time-estimates': true,
    'gtd-task-editor': true,
    manage: true,
    sync: true,
    about: true,
};

const LANGUAGES: { id: Language; native: string }[] = [
    { id: 'en', native: 'English' },
    { id: 'zh', native: '中文（简体）' },
    { id: 'zh-Hant', native: '中文（繁體）' },
    { id: 'es', native: 'Español' },
    { id: 'hi', native: 'हिन्दी' },
    { id: 'ar', native: 'العربية' },
    { id: 'de', native: 'Deutsch' },
    { id: 'ru', native: 'Русский' },
    { id: 'ja', native: '日本語' },
    { id: 'fr', native: 'Français' },
    { id: 'pt', native: 'Português' },
    { id: 'pl', native: 'Polski' },
    { id: 'nl', native: 'Nederlands' },
    { id: 'ko', native: '한국어' },
    { id: 'it', native: 'Italiano' },
    { id: 'tr', native: 'Türkçe' },
];

const WHISPER_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const WHISPER_MODELS: Array<{ id: string; fileName: string; label: string }> = [
    { id: 'whisper-tiny', fileName: 'ggml-tiny.bin', label: 'whisper-tiny' },
    { id: 'whisper-tiny.en', fileName: 'ggml-tiny.en.bin', label: 'whisper-tiny.en' },
    { id: 'whisper-base', fileName: 'ggml-base.bin', label: 'whisper-base' },
    { id: 'whisper-base.en', fileName: 'ggml-base.en.bin', label: 'whisper-base.en' },
];
const DEFAULT_WHISPER_MODEL = WHISPER_MODELS[0]?.id ?? 'whisper-tiny';
const UPDATE_BADGE_AVAILABLE_KEY = 'mindwtr-update-available';
const UPDATE_BADGE_LAST_CHECK_KEY = 'mindwtr-update-last-check';
const UPDATE_BADGE_LATEST_KEY = 'mindwtr-update-latest';
const UPDATE_BADGE_INTERVAL_MS = 1000 * 60 * 60 * 24;
const AI_PROVIDER_CONSENT_KEY = 'mindwtr-ai-provider-consent-v1';
const FOSS_LOCAL_LLM_MODEL_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];
const FOSS_LOCAL_LLM_COPILOT_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];

const isValidHttpUrl = (value: string): boolean => {
    if (!value.trim()) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

type MobileExtraConfig = {
    isFossBuild?: boolean | string;
    dropboxAppKey?: string;
};

type CloudProvider = 'selfhosted' | 'dropbox';

export default function SettingsPage() {
    const router = useRouter();
    const { settingsScreen } = useLocalSearchParams<{ settingsScreen?: string | string[] }>();
    const { themeMode, setThemeMode } = useTheme();
    const { language, setLanguage, t } = useLanguage();
    const isChineseLanguage = language === 'zh' || language === 'zh-Hant';
    const localize = (enText: string, zhText?: string) =>
        isChineseLanguage && zhText ? zhText : translateText(enText, language);
    const { tasks, projects, sections, areas, settings, updateSettings } = useTaskStore();
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
    const dropboxAppKey = typeof extraConfig?.dropboxAppKey === 'string' ? extraConfig.dropboxAppKey.trim() : '';
    const dropboxConfigured = !isFossBuild && isDropboxClientConfigured(dropboxAppKey);
    const [isSyncing, setIsSyncing] = useState(false);
    const {
        refreshSyncBadgeConfig,
        syncBadgeAccessibilityLabel,
        syncBadgeColor,
    } = useMobileSyncBadge();
    const currentScreen = useMemo<SettingsScreen>(() => {
        const rawScreen = Array.isArray(settingsScreen) ? settingsScreen[0] : settingsScreen;
        if (!rawScreen) return 'main';
        return SETTINGS_SCREEN_SET[rawScreen as SettingsScreen] ? (rawScreen as SettingsScreen) : 'main';
    }, [settingsScreen]);
    const pushSettingsScreen = useCallback((nextScreen: SettingsScreen) => {
        if (nextScreen === 'main') {
            router.push('/settings');
            return;
        }
        router.push({ pathname: '/settings', params: { settingsScreen: nextScreen } });
    }, [router]);
    const [syncPath, setSyncPath] = useState<string | null>(null);
    const [syncBackend, setSyncBackend] = useState<'file' | 'webdav' | 'cloud' | 'cloudkit' | 'off'>('off');
    const [isTestingConnection, setIsTestingConnection] = useState(false);
    const [webdavUrl, setWebdavUrl] = useState('');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [cloudUrl, setCloudUrl] = useState('');
    const [cloudToken, setCloudToken] = useState('');
    const [cloudProvider, setCloudProvider] = useState<CloudProvider>('selfhosted');
    const [dropboxConnected, setDropboxConnected] = useState(false);
    const [dropboxBusy, setDropboxBusy] = useState(false);
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [hasUpdateBadge, setHasUpdateBadge] = useState(false);
    const [digestTimePicker, setDigestTimePicker] = useState<'morning' | 'evening' | null>(null);
    const [digestTimeDraft, setDigestTimeDraft] = useState<Date | null>(null);
    const [weeklyReviewTimePicker, setWeeklyReviewTimePicker] = useState(false);
    const [weeklyReviewTimeDraft, setWeeklyReviewTimeDraft] = useState<Date | null>(null);
    const [weeklyReviewDayPickerOpen, setWeeklyReviewDayPickerOpen] = useState(false);
    const [gtdInboxProcessingExpanded, setGtdInboxProcessingExpanded] = useState(false);
    const [taskEditorExpandedSections, setTaskEditorExpandedSections] = useState<Record<TaskEditorSectionId, boolean>>({
        basic: true,
        scheduling: false,
        organization: false,
        details: false,
    });
    const [taskEditorSelectedField, setTaskEditorSelectedField] = useState<TaskEditorFieldId | null>(null);
    const [modelPicker, setModelPicker] = useState<null | 'model' | 'copilot' | 'speech'>(null);
    const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
    const [weekStartPickerOpen, setWeekStartPickerOpen] = useState(false);
    const [dateFormatPickerOpen, setDateFormatPickerOpen] = useState(false);
    const [timeFormatPickerOpen, setTimeFormatPickerOpen] = useState(false);
    const [syncOptionsOpen, setSyncOptionsOpen] = useState(false);
    const [syncHistoryExpanded, setSyncHistoryExpanded] = useState(false);
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [newCalendarName, setNewCalendarName] = useState('');
    const [newCalendarUrl, setNewCalendarUrl] = useState('');
    const [systemCalendarEnabled, setSystemCalendarEnabled] = useState(false);
    const [systemCalendarSelectAll, setSystemCalendarSelectAll] = useState(true);
    const [systemCalendarSelectedIds, setSystemCalendarSelectedIds] = useState<string[]>([]);
    const [systemCalendarPermission, setSystemCalendarPermission] = useState<SystemCalendarPermissionStatus>('undetermined');
    const [systemCalendars, setSystemCalendars] = useState<SystemCalendarInfo[]>([]);
    const [isSystemCalendarLoading, setIsSystemCalendarLoading] = useState(false);
    const [aiApiKey, setAiApiKey] = useState('');
    const [speechApiKey, setSpeechApiKey] = useState('');
    const [whisperDownloadState, setWhisperDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
    const [whisperDownloadError, setWhisperDownloadError] = useState('');
    const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
    const supportsNativeICloudSync = Platform.OS === 'ios' && isCloudKitAvailable();
    const [speechOpen, setSpeechOpen] = useState(false);

    const tc = useThemeColors();
    const insets = useSafeAreaInsets();
    const isExpoGo = Constants.appOwnership === 'expo';
    const [androidInstallerSource, setAndroidInstallerSource] = useState<'play-store' | 'sideload' | 'unknown'>(
        Platform.OS === 'android' ? 'unknown' : 'play-store'
    );
    const currentVersion = Constants.expoConfig?.version || '0.0.0';
    const notificationsEnabled = settings.notificationsEnabled !== false;
    const dailyDigestMorningEnabled = settings.dailyDigestMorningEnabled === true;
    const dailyDigestEveningEnabled = settings.dailyDigestEveningEnabled === true;
    const dailyDigestMorningTime = settings.dailyDigestMorningTime || '09:00';
    const dailyDigestEveningTime = settings.dailyDigestEveningTime || '20:00';
    const weeklyReviewEnabled = settings.weeklyReviewEnabled === true;
    const weeklyReviewTime = settings.weeklyReviewTime || '18:00';
    const weeklyReviewDay = Number.isFinite(settings.weeklyReviewDay) ? settings.weeklyReviewDay as number : 0;
    const weekStart = settings.weekStart === 'monday' ? 'monday' : 'sunday';
    const dateFormat = normalizeDateFormatSetting(settings.dateFormat);
    const timeFormat = normalizeTimeFormatSetting(settings.timeFormat);
    const loggingEnabled = settings.diagnostics?.loggingEnabled === true;
    const lastSyncStats = settings.lastSyncStats ?? null;
    const syncConflictCount = (lastSyncStats?.tasks.conflicts || 0) + (lastSyncStats?.projects.conflicts || 0);
    const maxClockSkewMs = Math.max(lastSyncStats?.tasks.maxClockSkewMs || 0, lastSyncStats?.projects.maxClockSkewMs || 0);
    const timestampAdjustments = (lastSyncStats?.tasks.timestampAdjustments || 0) + (lastSyncStats?.projects.timestampAdjustments || 0);
    const conflictIds = [
        ...(lastSyncStats?.tasks.conflictIds ?? []),
        ...(lastSyncStats?.projects.conflictIds ?? []),
    ].slice(0, 6);
    const syncPreferences = settings.syncPreferences ?? {};
    const syncAppearanceEnabled = syncPreferences.appearance === true;
    const syncLanguageEnabled = syncPreferences.language === true;
    const syncExternalCalendarsEnabled = syncPreferences.externalCalendars === true;
    const syncAiEnabled = syncPreferences.ai === true;
    const syncHistory = settings.lastSyncHistory ?? [];
    const syncHistoryEntries = syncHistory.slice(0, 5);
    const webdavUrlError = webdavUrl.trim() ? !isValidHttpUrl(webdavUrl.trim()) : false;
    const cloudUrlError = cloudUrl.trim() ? !isValidHttpUrl(cloudUrl.trim()) : false;
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
    const defaultTimeEstimatePresets: TimeEstimate[] = ['10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const timeEstimatePresets: TimeEstimate[] = (settings.gtd?.timeEstimatePresets?.length
        ? settings.gtd.timeEstimatePresets
        : defaultTimeEstimatePresets) as TimeEstimate[];
    const defaultCaptureMethod = settings.gtd?.defaultCaptureMethod ?? 'text';
    const saveAudioAttachments = settings.gtd?.saveAudioAttachments !== false;
    const inboxProcessing = settings.gtd?.inboxProcessing ?? {};
    const inboxTwoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
    const inboxProjectFirst = inboxProcessing.projectFirst === true;
    const inboxContextStepEnabled = inboxProcessing.contextStepEnabled !== false;
    const inboxScheduleEnabled = inboxProcessing.scheduleEnabled === true;
    const inboxReferenceEnabled = inboxProcessing.referenceEnabled === true;
    const includeContextStep = settings.gtd?.weeklyReview?.includeContextStep !== false;
    const autoArchiveDays = Number.isFinite(settings.gtd?.autoArchiveDays)
        ? Math.max(0, Math.floor(settings.gtd?.autoArchiveDays as number))
        : 7;
    const prioritiesEnabled = settings.features?.priorities === true;
    const timeEstimatesEnabled = settings.features?.timeEstimates === true;
    const pomodoroEnabled = settings.features?.pomodoro === true;

    useEffect(() => {
        if (currentScreen !== 'gtd-task-editor') {
            setTaskEditorSelectedField(null);
            return;
        }
        setTaskEditorExpandedSections({
            basic: true,
            scheduling: typeof settings.gtd?.taskEditor?.sectionOpen?.scheduling === 'boolean'
                ? settings.gtd.taskEditor.sectionOpen.scheduling
                : DEFAULT_TASK_EDITOR_SECTION_OPEN.scheduling,
            organization: typeof settings.gtd?.taskEditor?.sectionOpen?.organization === 'boolean'
                ? settings.gtd.taskEditor.sectionOpen.organization
                : DEFAULT_TASK_EDITOR_SECTION_OPEN.organization,
            details: typeof settings.gtd?.taskEditor?.sectionOpen?.details === 'boolean'
                ? settings.gtd.taskEditor.sectionOpen.details
                : DEFAULT_TASK_EDITOR_SECTION_OPEN.details,
        });
        setTaskEditorSelectedField(null);
    }, [
        currentScreen,
        settings.gtd?.taskEditor?.sectionOpen?.scheduling,
        settings.gtd?.taskEditor?.sectionOpen?.organization,
        settings.gtd?.taskEditor?.sectionOpen?.details,
    ]);

    const updateSyncPreferences = (partial: Partial<NonNullable<AppData['settings']['syncPreferences']>>) => {
        updateSettings({ syncPreferences: { ...syncPreferences, ...partial } }).catch(logSettingsError);
    };

    const scrollContentStyle = useMemo(
        () => [styles.scrollContent, { paddingBottom: 16 + insets.bottom }],
        [insets.bottom],
    );
    const scrollContentStyleWithKeyboard = useMemo(
        () => [styles.scrollContent, { paddingBottom: 140 + insets.bottom }],
        [insets.bottom],
    );

    const formatTimeEstimateLabel = (value: TimeEstimate) => {
        if (value === '5min') return '5m';
        if (value === '10min') return '10m';
        if (value === '15min') return '15m';
        if (value === '30min') return '30m';
        if (value === '1hr') return '1h';
        if (value === '2hr') return '2h';
        if (value === '3hr') return '3h';
        if (value === '4hr') return '4h';
        return '4h+';
    };

    const formatTime = (time: string) => time;

    const updateInboxProcessing = (partial: Partial<NonNullable<AppData['settings']['gtd']>['inboxProcessing']>) => {
        updateSettings({
            gtd: {
                ...(settings.gtd ?? {}),
                inboxProcessing: {
                    ...(settings.gtd?.inboxProcessing ?? {}),
                    ...partial,
                },
            },
        }).catch(logSettingsError);
    };
    const updateWeeklyReviewConfig = (partial: NonNullable<AppData['settings']['gtd']>['weeklyReview']) => {
        updateSettings({
            gtd: {
                ...(settings.gtd ?? {}),
                weeklyReview: {
                    ...(settings.gtd?.weeklyReview ?? {}),
                    ...partial,
                },
            },
        }).catch(logSettingsError);
    };
    const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : '';
    const locale = resolveDateLocaleTag({ language, dateFormat, systemLocale });
    const toTimePickerDate = (time: string) => {
        const [hours, minutes] = time.split(':').map((v) => parseInt(v, 10));
        const date = new Date();
        date.setHours(Number.isFinite(hours) ? hours : 9, Number.isFinite(minutes) ? minutes : 0, 0, 0);
        return date;
    };
    const toTimeValue = (date: Date) => {
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    };

    const openDigestTimePicker = useCallback((picker: 'morning' | 'evening') => {
        setDigestTimePicker(picker);
        if (Platform.OS !== 'ios') return;
        const current = picker === 'morning' ? dailyDigestMorningTime : dailyDigestEveningTime;
        setDigestTimeDraft(toTimePickerDate(current));
    }, [dailyDigestEveningTime, dailyDigestMorningTime]);

    const closeDigestTimePicker = useCallback(() => {
        setDigestTimePicker(null);
        setDigestTimeDraft(null);
    }, []);

    const saveDigestTimePicker = useCallback(() => {
        const picker = digestTimePicker;
        const selected = digestTimeDraft;
        closeDigestTimePicker();
        if (!picker || !selected) return;
        const value = toTimeValue(selected);
        if (picker === 'morning') {
            updateSettings({ dailyDigestMorningTime: value }).catch(logSettingsError);
            return;
        }
        updateSettings({ dailyDigestEveningTime: value }).catch(logSettingsError);
    }, [closeDigestTimePicker, digestTimeDraft, digestTimePicker, updateSettings]);

    const openWeeklyReviewTimePicker = useCallback(() => {
        setWeeklyReviewTimePicker(true);
        if (Platform.OS !== 'ios') return;
        setWeeklyReviewTimeDraft(toTimePickerDate(weeklyReviewTime));
    }, [weeklyReviewTime]);

    const closeWeeklyReviewTimePicker = useCallback(() => {
        setWeeklyReviewTimePicker(false);
        setWeeklyReviewTimeDraft(null);
    }, []);

    const saveWeeklyReviewTimePicker = useCallback(() => {
        const selected = weeklyReviewTimeDraft;
        closeWeeklyReviewTimePicker();
        if (!selected) return;
        updateSettings({ weeklyReviewTime: toTimeValue(selected) }).catch(logSettingsError);
    }, [closeWeeklyReviewTimePicker, updateSettings, weeklyReviewTimeDraft]);

    const onDigestTimeChange = (_event: DateTimePickerEvent, selected?: Date) => {
        const picker = digestTimePicker;
        setDigestTimePicker(null);
        if (!picker || !selected) return;
        const value = toTimeValue(selected);
        if (picker === 'morning') {
            updateSettings({ dailyDigestMorningTime: value }).catch(logSettingsError);
        } else {
            updateSettings({ dailyDigestEveningTime: value }).catch(logSettingsError);
        }
    };

    const onWeeklyReviewTimeChange = (_event: DateTimePickerEvent, selected?: Date) => {
        setWeeklyReviewTimePicker(false);
        if (!selected) return;
        updateSettings({ weeklyReviewTime: toTimeValue(selected) }).catch(logSettingsError);
    };

    const runDropboxConnectionTest = useCallback(async () => {
        let accessToken = await getValidDropboxAccessToken(dropboxAppKey);
        try {
            await testDropboxAccess(accessToken);
        } catch (error) {
            if (!isDropboxUnauthorizedError(error)) throw error;
            accessToken = await forceRefreshDropboxAccessToken(dropboxAppKey);
            await testDropboxAccess(accessToken);
        }
    }, [dropboxAppKey]);

    const getWeekdayLabel = (dayIndex: number) => {
        const base = new Date(2024, 0, 7 + dayIndex);
        return base.toLocaleDateString(locale, { weekday: 'long' });
    };

    const selectWeeklyReviewDay = () => {
        setWeeklyReviewDayPickerOpen(true);
    };

    const loadSystemCalendarState = useCallback(async (requestAccess = false) => {
        setIsSystemCalendarLoading(true);
        try {
            const stored = await getSystemCalendarSettings();
            setSystemCalendarEnabled(stored.enabled);
            setSystemCalendarSelectAll(stored.selectAll);
            setSystemCalendarSelectedIds(stored.selectedCalendarIds);

            const permission = requestAccess
                ? await requestSystemCalendarPermission()
                : await getSystemCalendarPermissionStatus();
            setSystemCalendarPermission(permission);

            if (permission !== 'granted') {
                setSystemCalendars([]);
                return;
            }

            const calendars = await getSystemCalendars();
            setSystemCalendars(calendars);
            if (stored.selectAll) return;

            const validIds = new Set(calendars.map((calendar) => calendar.id));
            const filteredSelection = stored.selectedCalendarIds.filter((id) => validIds.has(id));
            if (
                filteredSelection.length === stored.selectedCalendarIds.length &&
                filteredSelection.every((id, index) => id === stored.selectedCalendarIds[index])
            ) {
                return;
            }

            setSystemCalendarSelectedIds(filteredSelection);
            await saveSystemCalendarSettings({
                enabled: stored.enabled,
                selectAll: false,
                selectedCalendarIds: filteredSelection,
            });
        } catch (error) {
            logSettingsError(error);
        } finally {
            setIsSystemCalendarLoading(false);
        }
    }, []);

    // Load sync path on mount
    useEffect(() => {
        AsyncStorage.multiGet([
            SYNC_PATH_KEY,
            SYNC_BACKEND_KEY,
            WEBDAV_URL_KEY,
            WEBDAV_USERNAME_KEY,
            WEBDAV_PASSWORD_KEY,
            CLOUD_URL_KEY,
            CLOUD_TOKEN_KEY,
            CLOUD_PROVIDER_KEY,
        ]).then((entries) => {
            const entryMap = new Map(entries);
            const path = entryMap.get(SYNC_PATH_KEY);
            const backend = entryMap.get(SYNC_BACKEND_KEY);
            const url = entryMap.get(WEBDAV_URL_KEY);
            const username = entryMap.get(WEBDAV_USERNAME_KEY);
            const password = entryMap.get(WEBDAV_PASSWORD_KEY);
            const cloudSyncUrl = entryMap.get(CLOUD_URL_KEY);
            const cloudSyncToken = entryMap.get(CLOUD_TOKEN_KEY);
            const storedCloudProvider = entryMap.get(CLOUD_PROVIDER_KEY);

            if (path) setSyncPath(path);
            const resolvedBackend = backend === 'webdav' || backend === 'cloud' || backend === 'off' || backend === 'file' || backend === 'cloudkit'
                ? backend
                : 'off';
            const supportedBackend = coerceSupportedBackend(resolvedBackend, supportsNativeICloudSync);
            setSyncBackend(supportedBackend);
            if (resolvedBackend !== supportedBackend) {
                AsyncStorage.setItem(SYNC_BACKEND_KEY, supportedBackend).catch(logSettingsError);
            }
            if (url) setWebdavUrl(url);
            if (username) setWebdavUsername(username);
            if (password) setWebdavPassword(password);
            if (cloudSyncUrl) setCloudUrl(cloudSyncUrl);
            if (cloudSyncToken) setCloudToken(cloudSyncToken);
            const resolvedCloudProvider =
                storedCloudProvider === 'dropbox' && !isFossBuild
                    ? 'dropbox'
                    : 'selfhosted';
            setCloudProvider(resolvedCloudProvider);
            if (isFossBuild && storedCloudProvider === 'dropbox') {
                AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted').catch(logSettingsError);
            }
        }).catch(logSettingsError);
    }, [isFossBuild, supportsNativeICloudSync]);

    useEffect(() => {
        void refreshSyncBadgeConfig();
    }, [
        refreshSyncBadgeConfig,
        syncBackend,
        syncPath,
        webdavUrl,
        cloudUrl,
        cloudToken,
        cloudProvider,
        settings.lastSyncStatus,
        settings.pendingRemoteWriteAt,
        settings.lastSyncAt,
    ]);

    useEffect(() => {
        void loadSystemCalendarState();
    }, [loadSystemCalendarState]);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const stored = await getExternalCalendars();
                if (cancelled) return;
                if (Array.isArray(settings.externalCalendars)) {
                    setExternalCalendars(settings.externalCalendars);
                    if (settings.externalCalendars.length || stored.length) {
                        await saveExternalCalendars(settings.externalCalendars);
                    }
                    return;
                }
                setExternalCalendars(stored);
            } catch (error) {
                logSettingsError(error);
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [settings.externalCalendars]);

    useEffect(() => {
        let cancelled = false;
        const loadDropboxState = async () => {
            if (!dropboxConfigured) {
                if (!cancelled) setDropboxConnected(false);
                return;
            }
            try {
                const connected = await isDropboxConnected();
                if (!cancelled) setDropboxConnected(connected);
            } catch {
                if (!cancelled) setDropboxConnected(false);
            }
        };
        void loadDropboxState();
        return () => {
            cancelled = true;
        };
    }, [dropboxConfigured]);

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

    const themeOptions: { value: typeof themeMode; label: string }[] = [
        { value: 'system', label: t('settings.system') },
        { value: 'light', label: t('settings.light') },
        { value: 'dark', label: t('settings.dark') },
        { value: 'material3-light', label: t('settings.material3Light') },
        { value: 'material3-dark', label: t('settings.material3Dark') },
        { value: 'eink', label: t('settings.eink') },
        { value: 'nord', label: t('settings.nord') },
        { value: 'sepia', label: t('settings.sepia') },
        { value: 'oled', label: t('settings.oled') },
    ];
    const mapThemeToSetting = (mode: typeof themeMode): AppData['settings']['theme'] => mode;
    const [themePickerOpen, setThemePickerOpen] = useState(false);
    const currentThemeLabel = themeOptions.find((opt) => opt.value === themeMode)?.label ?? t('settings.system');
    const weekStartOptions: { value: 'sunday' | 'monday'; label: string }[] = [
        { value: 'sunday', label: t('settings.weekStartSunday') },
        { value: 'monday', label: t('settings.weekStartMonday') },
    ];
    const currentWeekStartLabel = weekStartOptions.find((opt) => opt.value === weekStart)?.label ?? t('settings.weekStartSunday');
    const dateFormatOptions: { value: 'system' | 'dmy' | 'mdy' | 'ymd'; label: string }[] = [
        { value: 'system', label: t('settings.dateFormatSystem') },
        { value: 'dmy', label: t('settings.dateFormatDmy') },
        { value: 'mdy', label: t('settings.dateFormatMdy') },
        { value: 'ymd', label: t('settings.dateFormatYmd') },
    ];
    const currentDateFormatLabel = dateFormatOptions.find((opt) => opt.value === dateFormat)?.label ?? t('settings.dateFormatSystem');
    const timeFormatOptions: { value: 'system' | '12h' | '24h'; label: string }[] = [
        { value: 'system', label: t('settings.timeFormatSystem') },
        { value: '12h', label: t('settings.timeFormat12h') },
        { value: '24h', label: t('settings.timeFormat24h') },
    ];
    const currentTimeFormatLabel = timeFormatOptions.find((opt) => opt.value === timeFormat)?.label ?? t('settings.timeFormatSystem');
    const openLink = (url: string) => Linking.openURL(url);
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
                `To use AI assistant, your task text and optional notes will be sent directly to your configured OpenAI-compatible endpoint (for example, a local or self-hosted LLM server) using your API key. Mindwtr does not collect this data. Do you want to continue?`,
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
    useEffect(() => {
        if (!isFossBuild) return;
        const configuredProvider = (settings.ai?.provider ?? 'openai') as AIProviderId;
        if (configuredProvider !== 'openai') {
            applyAIProviderDefaults('openai');
        }
    }, [applyAIProviderDefaults, isFossBuild, settings.ai?.provider]);
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
    const updateSpeechSettings = (
        next: Partial<NonNullable<NonNullable<typeof settings.ai>['speechToText']>>
    ) => {
        updateAISettings({ speechToText: { ...(settings.ai?.speechToText ?? {}), ...next } });
    };

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
    }, [speechProvider, speechSettings.offlineModelPath, speechModel]);

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
                            'Download failed. Please retry on Wi‑Fi. Large models cannot be buffered into memory.',
                            '下载失败。请在 Wi‑Fi 下重试。大型模型无法加载到内存。'
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
            return;
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

    useEffect(() => {
        if (Platform.OS !== 'android') {
            setAndroidInstallerSource('play-store');
            return;
        }
        if (isFossBuild) {
            setAndroidInstallerSource('sideload');
            return;
        }
        let cancelled = false;
        Application.getInstallReferrerAsync()
            .then((referrer) => {
                if (cancelled) return;
                const normalized = (referrer || '').trim().toLowerCase();
                setAndroidInstallerSource(normalized ? 'play-store' : 'sideload');
            })
            .catch((error) => {
                if (!cancelled) {
                    setAndroidInstallerSource('unknown');
                }
                logSettingsWarn('Failed to detect Android installer source', error);
            });
        return () => {
            cancelled = true;
        };
    }, [isFossBuild]);

    const GITHUB_RELEASES_API = 'https://api.github.com/repos/dongdongbh/Mindwtr/releases/latest';
    const GITHUB_RELEASES_URL = 'https://github.com/dongdongbh/Mindwtr/releases/latest';
    const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr';
    const PLAY_STORE_LOOKUP_URL = 'https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr&hl=en_US&gl=US';
    const PLAY_STORE_MARKET_URL = 'market://details?id=tech.dongdongbh.mindwtr';
    const APP_STORE_BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier || 'tech.dongdongbh.mindwtr';
    const APP_STORE_LOOKUP_URL = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(APP_STORE_BUNDLE_ID)}&country=US`;
    const APP_STORE_LOOKUP_FALLBACK_URL = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(APP_STORE_BUNDLE_ID)}`;

    const persistUpdateBadge = useCallback(async (next: boolean, latestVersion?: string) => {
        setHasUpdateBadge(next);
        try {
            await AsyncStorage.setItem(UPDATE_BADGE_AVAILABLE_KEY, next ? 'true' : 'false');
            if (next && latestVersion) {
                await AsyncStorage.setItem(UPDATE_BADGE_LATEST_KEY, latestVersion);
            } else {
                await AsyncStorage.removeItem(UPDATE_BADGE_LATEST_KEY);
            }
        } catch (error) {
            logSettingsWarn('Failed to persist update badge state', error);
        }
    }, []);

    const fetchLatestRelease = useCallback(async () => {
        const response = await fetch(GITHUB_RELEASES_API, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Mindwtr-App'
            }
        });
        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
        }
        return response.json();
    }, [GITHUB_RELEASES_API]);

    const fetchLatestGithubVersion = useCallback(async () => {
        const release = await fetchLatestRelease();
        return release.tag_name?.replace(/^v/, '') || '0.0.0';
    }, [fetchLatestRelease]);

    const fetchLatestAppStoreInfo = useCallback(async (): Promise<{ version: string; trackViewUrl: string | null }> => {
        const lookupUrls = [APP_STORE_LOOKUP_FALLBACK_URL, APP_STORE_LOOKUP_URL];
        let lastError: Error | null = null;
        let bestMatch: { version: string; trackViewUrl: string | null } | null = null;
        for (const baseUrl of lookupUrls) {
            const separator = baseUrl.includes('?') ? '&' : '?';
            const url = `${baseUrl}${separator}_=${Date.now()}`;
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mindwtr-App'
                },
                cache: 'no-store',
            });
            if (!response.ok) {
                lastError = new Error(`App Store lookup failed (${url}): ${response.status}`);
                continue;
            }
            const payload = await response.json() as { results?: { version?: unknown; trackViewUrl?: unknown }[] };
            const candidate = Array.isArray(payload.results) ? payload.results[0] : null;
            const version = typeof candidate?.version === 'string' ? candidate.version.trim() : '';
            if (!version) {
                lastError = new Error(`Unable to parse App Store version from ${url}`);
                continue;
            }
            const trackViewUrl = typeof candidate?.trackViewUrl === 'string' && candidate.trackViewUrl.trim()
                ? candidate.trackViewUrl.trim()
                : null;
            if (!bestMatch || compareVersions(version, bestMatch.version) > 0) {
                bestMatch = { version, trackViewUrl };
            }
        }
        if (bestMatch) return bestMatch;
        if (lastError) {
            throw lastError;
        }
        throw new Error('Unable to fetch App Store version');
    }, [APP_STORE_LOOKUP_FALLBACK_URL, APP_STORE_LOOKUP_URL]);

    const parsePlayStoreVersion = useCallback((html: string): string | null => {
        const patterns = [
            /"softwareVersion"\s*:\s*"([^"]+)"/i,
            /\\"softwareVersion\\"\s*:\s*\\"([^"]+)\\"/i,
            /itemprop="softwareVersion"[^>]*>\s*([^<]+)\s*</i,
            /"versionName"\s*:\s*"([^"]+)"/i,
            // New Play Store payload format (AF_initDataCallback ds:5)
            /"141"\s*:\s*\[\[\["([^"]+)"/i,
            /\\"141\\"\s*:\s*\[\[\[\\"([^"]+)/i,
        ];
        for (const pattern of patterns) {
            const match = html.match(pattern);
            const candidate = match?.[1]?.trim();
            if (!candidate) continue;
            const versionMatch = candidate.match(/\d+(?:\.\d+){1,3}/);
            if (versionMatch?.[0]) {
                return versionMatch[0];
            }
        }
        return null;
    }, []);

    const fetchLatestPlayStoreVersion = useCallback(async () => {
        const urls = [PLAY_STORE_LOOKUP_URL, PLAY_STORE_URL];
        let lastError: Error | null = null;
        for (const url of urls) {
            const response = await fetch(url, {
                headers: {
                    'Accept': 'text/html',
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
                }
            });
            if (!response.ok) {
                lastError = new Error(`Play Store request failed (${url}): ${response.status}`);
                continue;
            }
            const html = await response.text();
            const version = parsePlayStoreVersion(html);
            if (version) {
                return version;
            }
            lastError = new Error(`Unable to parse Play Store version from ${url}`);
        }
        if (lastError) {
            throw lastError;
        }
        throw new Error('Unable to fetch Play Store version');
    }, [PLAY_STORE_LOOKUP_URL, PLAY_STORE_URL, parsePlayStoreVersion]);

    const fetchLatestComparableVersion = useCallback(async (): Promise<{ version: string; source: 'play-store' | 'app-store' | 'github-release' }> => {
        if (isFossBuild) {
            throw new Error('Update checks are disabled in FOSS build');
        }
        if (Platform.OS === 'ios') {
            const appStoreInfo = await fetchLatestAppStoreInfo();
            return { version: appStoreInfo.version, source: 'app-store' };
        }
        if (Platform.OS !== 'android') {
            const githubVersion = await fetchLatestGithubVersion();
            return { version: githubVersion, source: 'github-release' };
        }
        if (androidInstallerSource === 'sideload') {
            const githubVersion = await fetchLatestGithubVersion();
            return { version: githubVersion, source: 'github-release' };
        }
        try {
            const playStoreVersion = await fetchLatestPlayStoreVersion();
            return { version: playStoreVersion, source: 'play-store' };
        } catch (error) {
            logSettingsWarn('Play Store update check failed; falling back to GitHub release', error);
            const githubVersion = await fetchLatestGithubVersion();
            return { version: githubVersion, source: 'github-release' };
        }
    }, [androidInstallerSource, fetchLatestAppStoreInfo, fetchLatestGithubVersion, fetchLatestPlayStoreVersion, isFossBuild]);

    useEffect(() => {
        if (isFossBuild) {
            setHasUpdateBadge(false);
            AsyncStorage.multiRemove([
                UPDATE_BADGE_AVAILABLE_KEY,
                UPDATE_BADGE_LATEST_KEY,
                UPDATE_BADGE_LAST_CHECK_KEY,
            ]).catch((error) => logSettingsWarn('Failed to clear update badge state for FOSS build', error));
            return;
        }
        let cancelled = false;
        AsyncStorage.multiGet([UPDATE_BADGE_AVAILABLE_KEY, UPDATE_BADGE_LATEST_KEY])
            .then((entries) => {
                if (cancelled) return;
                const entryMap = new Map(entries);
                const storedAvailable = entryMap.get(UPDATE_BADGE_AVAILABLE_KEY) === 'true';
                const storedLatest = entryMap.get(UPDATE_BADGE_LATEST_KEY) ?? '';
                const isValid = storedAvailable && Boolean(storedLatest) && compareVersions(storedLatest, currentVersion) > 0;
                setHasUpdateBadge(isValid);
                if (storedAvailable && !isValid) {
                    AsyncStorage.setItem(UPDATE_BADGE_AVAILABLE_KEY, 'false').catch(logSettingsWarn);
                    AsyncStorage.removeItem(UPDATE_BADGE_LATEST_KEY).catch(logSettingsWarn);
                }
            })
            .catch((error) => logSettingsWarn('Failed to read update badge state', error));
        return () => {
            cancelled = true;
        };
    }, [currentVersion, isFossBuild]);

    useEffect(() => {
        if (isExpoGo || isFossBuild) return;
        let cancelled = false;
        const checkUpdates = async () => {
            try {
                const lastCheckRaw = await AsyncStorage.getItem(UPDATE_BADGE_LAST_CHECK_KEY);
                const lastCheck = Number(lastCheckRaw || 0);
                if (Date.now() - lastCheck < UPDATE_BADGE_INTERVAL_MS) return;
                await AsyncStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));
                const { version: latestVersion } = await fetchLatestComparableVersion();
                const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                if (cancelled) return;
                await persistUpdateBadge(hasUpdate, hasUpdate ? latestVersion : undefined);
            } catch (error) {
                logSettingsWarn('Background update check failed', error);
            }
        };
        void checkUpdates();
        return () => {
            cancelled = true;
        };
    }, [currentVersion, fetchLatestComparableVersion, isExpoGo, isFossBuild, persistUpdateBadge]);

    const handleCheckUpdates = async () => {
        if (isFossBuild) {
            Alert.alert(
                localize('Updates are managed by your distribution source', '更新由发行渠道管理'),
                localize(
                    'In-app update checks are disabled in this FOSS build. Please update from your repository or package source.',
                    '此 FOSS 版本已禁用应用内更新检查。请通过你的软件源或包管理渠道更新。'
                )
            );
            return;
        }
        setIsCheckingUpdate(true);
        try {
            await AsyncStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));

            if (Platform.OS === 'android' && !isFossBuild && androidInstallerSource !== 'sideload') {
                const canOpenMarket = await Linking.canOpenURL(PLAY_STORE_MARKET_URL);
                const targetUrl = canOpenMarket ? PLAY_STORE_MARKET_URL : PLAY_STORE_URL;
                const { version: latestVersion, source } = await fetchLatestComparableVersion();
                const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                if (hasUpdate) {
                    const updateMessage = source === 'play-store'
                        ? localize(
                            `v${currentVersion} → v${latestVersion}\n\nUpdate is available on Google Play. Open app listing now?`,
                            `v${currentVersion} → v${latestVersion}\n\nGoogle Play 已提供更新，是否立即打开应用页面？`
                        )
                        : localize(
                            `v${currentVersion} → v${latestVersion}\n\nPlay Store version lookup is temporarily unavailable. A newer GitHub release is available, and Play rollout may lag. Open app listing now?`,
                            `v${currentVersion} → v${latestVersion}\n\n暂时无法直接获取 Google Play 版本，GitHub 已有更新，Play 商店可能会延迟推送。是否立即打开应用页面？`
                        );
                    Alert.alert(
                        localize('Update Available', '有可用更新'),
                        updateMessage,
                        [
                            { text: localize('Later', '稍后'), style: 'cancel' },
                            { text: localize('Open', '打开'), onPress: () => Linking.openURL(targetUrl) }
                        ]
                    );
                    await persistUpdateBadge(true, latestVersion);
                } else {
                    const upToDateMessage = source === 'play-store'
                        ? localize('You are using the latest Google Play version!', '您正在使用 Google Play 最新版本！')
                        : localize(
                            'Play Store version lookup is temporarily unavailable. Your version matches the latest GitHub release.',
                            '暂时无法直接获取 Google Play 版本，但当前版本与 GitHub 最新发布一致。'
                        );
                    Alert.alert(
                        localize('Up to Date', '已是最新'),
                        upToDateMessage
                    );
                    await persistUpdateBadge(false);
                }
                return;
            }

            if (Platform.OS === 'ios' && !isFossBuild) {
                const { version: latestVersion, trackViewUrl } = await fetchLatestAppStoreInfo();
                const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                const trackIdMatch = trackViewUrl?.match(/\/id(\d+)/i);
                const appStoreDeepLink = trackIdMatch?.[1] ? `itms-apps://apps.apple.com/app/id${trackIdMatch[1]}` : null;
                const canOpenDeepLink = appStoreDeepLink ? await Linking.canOpenURL(appStoreDeepLink) : false;
                const targetUrl = canOpenDeepLink ? appStoreDeepLink : trackViewUrl;
                if (hasUpdate) {
                    Alert.alert(
                        localize('Update Available', '有可用更新'),
                        localize(
                            `v${currentVersion} → v${latestVersion}\n\nUpdate is available on the App Store. Open app listing now?`,
                            `v${currentVersion} → v${latestVersion}\n\nApp Store 已提供更新，是否立即打开应用页面？`
                        ),
                        [
                            { text: localize('Later', '稍后'), style: 'cancel' },
                            ...(targetUrl
                                ? [{ text: localize('Open', '打开'), onPress: () => Linking.openURL(targetUrl) }]
                                : [])
                        ]
                    );
                    await persistUpdateBadge(true, latestVersion);
                } else {
                    Alert.alert(
                        localize('Up to Date', '已是最新'),
                        localize('You are using the latest App Store version!', '您正在使用 App Store 最新版本！')
                    );
                    await persistUpdateBadge(false);
                }
                return;
            }

            const release = await fetchLatestRelease();
            const latestVersion = release.tag_name?.replace(/^v/, '') || '0.0.0';

            // Compare versions
            const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

            if (hasUpdate) {
                // Find APK download URL
                let downloadUrl = GITHUB_RELEASES_URL;
                if (release.html_url) {
                    downloadUrl = release.html_url;
                }

                const changelog = release.body || localize('No changelog available', '暂无更新日志');

                Alert.alert(
                    localize('Update Available', '有可用更新'),
                    `v${currentVersion} → v${latestVersion}\n\n${localize('Changelog', '更新日志')}:\n${changelog.substring(0, 500)}${changelog.length > 500 ? '...' : ''}`,
                    [
                        {
                            text: localize('Later', '稍后'),
                            style: 'cancel'
                        },
                        {
                            text: localize('Download', '下载'),
                            onPress: () => Linking.openURL(downloadUrl)
                        }
                    ]
                );
                await persistUpdateBadge(true, latestVersion);
            } else {
                Alert.alert(
                    localize('Up to Date', '已是最新'),
                    localize('You are using the latest version!', '您正在使用最新版本！')
                );
                await persistUpdateBadge(false);
            }
        } catch (error) {
            logSettingsError('Update check failed:', error);
            Alert.alert(
                localize('Error', '错误'),
                localize('Failed to check for updates', '检查更新失败')
            );
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const resetSyncStatusForBackendSwitch = useCallback(() => {
        updateSettings({
            lastSyncStatus: 'idle',
            lastSyncError: undefined,
        }).catch(logSettingsError);
    }, [updateSettings]);

    // Set sync folder path (iOS can fall back to selecting a JSON file inside the target folder)
    const handleSetSyncPath = async () => {
        try {
            const result = await pickAndParseSyncFolder();
            if (result) {
                // Get the file URI that was picked
                const fileUri = (result as { __fileUri: string }).__fileUri;
                if (fileUri) {
                    await AsyncStorage.setItem(SYNC_PATH_KEY, fileUri);
                    setSyncPath(fileUri);
                    await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file');
                    setSyncBackend('file');
                    resetSyncStatusForBackendSwitch();
                    Alert.alert(
                        localize('Success', '成功'),
                        localize('Sync folder set successfully', '同步文件夹已设置')
                    );
                }
            }
        } catch (error) {
            logSettingsError(error);
            const message = String(error);
            if (/Selected JSON file is not a Mindwtr backup/i.test(message)) {
                Alert.alert(
                    localize('Invalid sync file', '无效同步文件'),
                    localize(
                        'Please choose a Mindwtr backup JSON file in the target folder, then try "Select Folder" again.',
                        '请选择目标文件夹中的 Mindwtr 备份 JSON 文件，然后重试“选择文件夹”。'
                    )
                );
                return;
            }
            if (/temporary Inbox location|re-select a folder in Settings -> Data & Sync/i.test(message)) {
                Alert.alert(
                    localize('Unsupported cloud provider on iOS', 'iOS 云端提供商暂不支持'),
                    localize(
                        'The selected file came from a temporary iOS Files copy. Providers like Google Drive and OneDrive are not reliable for file sync here yet. Please choose iCloud Drive instead, or switch to WebDAV.',
                        '当前选择的是 iOS“文件”提供的临时副本。Google Drive、OneDrive 等提供商暂不适合作为这里的文件同步目录。请改用 iCloud Drive，或切换到 WebDAV。'
                    )
                );
                return;
            }
            if (/read-only|read only|not writable|isn't writable|permission denied|EACCES/i.test(message)) {
                Alert.alert(
                    localize('Sync folder is read-only', '同步文件夹不可写'),
                    Platform.OS === 'ios'
                        ? localize(
                            'The selected folder is read-only. Choose a writable location, or make the cloud folder available offline in Files before selecting it.',
                            '所选文件夹不可写。请选择可写位置，或先在“文件”App中将云端文件夹设为离线可用后再选择。'
                        )
                        : localize(
                            'The selected folder is read-only. Please choose a writable folder (e.g. My files) or make it available offline.',
                            '所选文件夹不可写。请选择可写文件夹（如“我的文件”），或将其设为离线可用。'
                        )
                );
                return;
            }
            Alert.alert(localize('Error', '错误'), localize('Failed to set sync path', '设置失败'));
        }
    };

    const handleConnectDropbox = async () => {
        if (isFossBuild) {
            Alert.alert(
                localize('Dropbox unavailable', 'Dropbox 不可用'),
                localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。')
            );
            return;
        }
        if (!dropboxConfigured) {
            Alert.alert(
                localize('Dropbox unavailable', 'Dropbox 不可用'),
                localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。')
            );
            return;
        }
        if (isExpoGo) {
            Alert.alert(
                localize('Dropbox unavailable in Expo Go', 'Expo Go 不支持 Dropbox'),
                `${localize(
                    'Dropbox OAuth requires a development/release build. Expo Go uses temporary redirect URIs that Dropbox rejects.',
                    'Dropbox OAuth 需要开发版或正式版应用。Expo Go 使用临时回调地址，Dropbox 会拒绝。'
                )}\n\n${localize('Use redirect URI', '请使用回调地址')}: ${getDropboxRedirectUri()}`
            );
            return;
        }
        setDropboxBusy(true);
        try {
            await authorizeDropbox(dropboxAppKey);
            await AsyncStorage.multiSet([
                [SYNC_BACKEND_KEY, 'cloud'],
                [CLOUD_PROVIDER_KEY, 'dropbox'],
            ]);
            setCloudProvider('dropbox');
            setSyncBackend('cloud');
            setDropboxConnected(true);
            resetSyncStatusForBackendSwitch();
            Alert.alert(localize('Success', '成功'), localize('Connected to Dropbox.', '已连接 Dropbox。'));
        } catch (error) {
            logSettingsError(error);
            const message = formatError(error);
            if (/redirect[_\s-]?uri/i.test(message)) {
                Alert.alert(
                    localize('Invalid redirect URI', '回调地址无效'),
                    `${localize(
                        'Add this exact redirect URI in Dropbox OAuth settings.',
                        '请在 Dropbox OAuth 设置里添加以下精确回调地址。'
                    )}\n\n${getDropboxRedirectUri()}`
                );
            } else {
                Alert.alert(localize('Connection failed', '连接失败'), message);
            }
        } finally {
            setDropboxBusy(false);
        }
    };

    const handleDisconnectDropbox = async () => {
        if (!dropboxConfigured) {
            setDropboxConnected(false);
            return;
        }
        setDropboxBusy(true);
        try {
            await disconnectDropbox(dropboxAppKey);
            setDropboxConnected(false);
            resetSyncStatusForBackendSwitch();
            Alert.alert(localize('Disconnected', '已断开'), localize('Dropbox connection removed.', '已移除 Dropbox 连接。'));
        } catch (error) {
            logSettingsError(error);
            Alert.alert(localize('Disconnect failed', '断开失败'), formatError(error));
        } finally {
            setDropboxBusy(false);
        }
    };

    const handleTestDropboxConnection = async () => {
        if (isFossBuild) {
            Alert.alert(
                localize('Dropbox unavailable', 'Dropbox 不可用'),
                localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。')
            );
            return;
        }
        if (!dropboxConfigured) {
            Alert.alert(
                localize('Dropbox unavailable', 'Dropbox 不可用'),
                localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。')
            );
            return;
        }
        setIsTestingConnection(true);
        try {
            await runDropboxConnectionTest();
            setDropboxConnected(true);
            Alert.alert(
                localize('Connection OK', '连接成功'),
                localize('Dropbox account is reachable.', 'Dropbox 账号可访问。')
            );
        } catch (error) {
            logSettingsWarn('Dropbox connection test failed', error);
            if (isDropboxUnauthorizedError(error)) {
                setDropboxConnected(false);
                Alert.alert(
                    localize('Connection failed', '连接失败'),
                    localize(
                        'Dropbox token is invalid or revoked. Please tap Connect Dropbox to re-authorize.',
                        'Dropbox 令牌无效或已失效。请点击“连接 Dropbox”重新授权。'
                    )
                );
            } else {
                Alert.alert(localize('Connection failed', '连接失败'), formatError(error));
            }
        } finally {
            setIsTestingConnection(false);
        }
    };

    // Sync from stored path
    const handleSync = async () => {
        setIsSyncing(true);
        try {
            if (syncBackend === 'off') {
                return;
            }
            if (syncBackend === 'webdav') {
                if (!webdavUrl.trim()) {
                    Alert.alert(
                        localize('Notice', '提示'),
                        localize('Please set a WebDAV URL first', '请先设置 WebDAV 地址')
                    );
                    return;
                }
                if (webdavUrlError) {
                    Alert.alert(
                        localize('Invalid URL', '地址无效'),
                        localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。')
                    );
                    return;
                }
                await AsyncStorage.multiSet([
                    [SYNC_BACKEND_KEY, 'webdav'],
                    [WEBDAV_URL_KEY, webdavUrl.trim()],
                    [WEBDAV_USERNAME_KEY, webdavUsername.trim()],
                    [WEBDAV_PASSWORD_KEY, webdavPassword],
                ]);
            } else if (syncBackend === 'cloudkit') {
                await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'cloudkit');
            } else if (syncBackend === 'cloud') {
                if (cloudProvider === 'dropbox') {
                    if (isFossBuild) {
                        Alert.alert(
                            localize('Dropbox unavailable', 'Dropbox 不可用'),
                            localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。')
                        );
                        return;
                    }
                    if (!dropboxConfigured) {
                        Alert.alert(
                            localize('Dropbox unavailable', 'Dropbox 不可用'),
                            localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。')
                        );
                        return;
                    }
                    const connected = await isDropboxConnected();
                    if (!connected) {
                        Alert.alert(
                            localize('Notice', '提示'),
                            localize('Please connect Dropbox first.', '请先连接 Dropbox。')
                        );
                        return;
                    }
                    await AsyncStorage.multiSet([
                        [SYNC_BACKEND_KEY, 'cloud'],
                        [CLOUD_PROVIDER_KEY, 'dropbox'],
                    ]);
                } else {
                    if (!cloudUrl.trim()) {
                        Alert.alert(
                            localize('Notice', '提示'),
                            localize('Please set a self-hosted URL first', '请先设置自托管地址')
                        );
                        return;
                    }
                    if (cloudUrlError) {
                        Alert.alert(
                            localize('Invalid URL', '地址无效'),
                            localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。')
                        );
                        return;
                    }
                    await AsyncStorage.multiSet([
                        [SYNC_BACKEND_KEY, 'cloud'],
                        [CLOUD_PROVIDER_KEY, 'selfhosted'],
                        [CLOUD_URL_KEY, cloudUrl.trim()],
                        [CLOUD_TOKEN_KEY, cloudToken],
                    ]);
                }
            } else {
                if (!syncPath) {
                    Alert.alert(
                        localize('Notice', '提示'),
                        localize('Please set a sync folder first', '请先设置同步文件夹')
                    );
                    return;
                }
                await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file');
            }

            resetSyncStatusForBackendSwitch();
            const result = await performMobileSync(syncBackend === 'file' ? syncPath || undefined : undefined);
            if (result.skipped === 'offline' || isLikelyOfflineSyncError(result.error)) {
                Alert.alert(
                    localize('Offline', '离线'),
                    localize('No internet connection. Sync skipped.', '当前无网络连接，已跳过同步。')
                );
                return;
            }
            if (result.success) {
                const conflictCount = (result.stats?.tasks.conflicts || 0) + (result.stats?.projects.conflicts || 0);
                Alert.alert(
                    localize('Success', '成功'),
                    conflictCount > 0
                        ? localize(`Sync completed with ${conflictCount} conflicts (resolved automatically).`, `同步完成，发现 ${conflictCount} 个冲突（已自动处理）。`)
                        : localize('Sync completed!', '同步完成！')
                );
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error) {
            logSettingsError(error);
            const message = String(error);
            if (/temporary Inbox location|re-select a folder in Settings -> Data & Sync|Cannot access the selected sync file/i.test(message)) {
                Alert.alert(
                    localize('Unsupported cloud provider on iOS', 'iOS 云端提供商暂不支持'),
                    localize(
                        'The selected file came from a temporary iOS Files copy. Providers like Google Drive and OneDrive are not reliable for file sync here yet. Please go to Settings → Data & Sync, choose iCloud Drive, or switch to WebDAV.',
                        '当前选择的是 iOS“文件”提供的临时副本。Google Drive、OneDrive 等提供商暂不适合作为这里的文件同步目录。请前往「设置 → 数据与同步」，改选 iCloud Drive，或切换到 WebDAV。'
                    )
                );
                return;
            }
            Alert.alert(localize('Error', '错误'), localize('Sync failed', '同步失败'));
        } finally {
            setIsSyncing(false);
        }
    };

    const handleTestConnection = async (backend: 'webdav' | 'cloud') => {
        setIsTestingConnection(true);
        try {
            if (backend === 'webdav') {
                if (!webdavUrl.trim() || webdavUrlError) {
                    Alert.alert(
                        localize('Invalid URL', '地址无效'),
                        localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。')
                    );
                    return;
                }
                await webdavGetJson<unknown>(normalizeWebdavUrl(webdavUrl.trim()), {
                    username: webdavUsername.trim(),
                    password: webdavPassword,
                    timeoutMs: 10_000,
                });
                Alert.alert(
                    localize('Connection OK', '连接成功'),
                    localize('WebDAV endpoint is reachable.', 'WebDAV 端点可访问。')
                );
                return;
            }

            if (cloudProvider === 'dropbox') {
                if (isFossBuild) {
                    Alert.alert(
                        localize('Dropbox unavailable', 'Dropbox 不可用'),
                        localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。')
                    );
                    return;
                }
                await runDropboxConnectionTest();
                setDropboxConnected(true);
                Alert.alert(
                    localize('Connection OK', '连接成功'),
                    localize('Dropbox account is reachable.', 'Dropbox 账号可访问。')
                );
                return;
            }

            if (!cloudUrl.trim() || cloudUrlError) {
                Alert.alert(
                    localize('Invalid URL', '地址无效'),
                    localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。')
                );
                return;
            }
            await cloudGetJson<unknown>(normalizeCloudUrl(cloudUrl.trim()), {
                token: cloudToken,
                timeoutMs: 10_000,
            });
            Alert.alert(
                localize('Connection OK', '连接成功'),
                localize('Self-hosted endpoint is reachable.', '自托管端点可访问。')
            );
        } catch (error) {
            logSettingsWarn('Sync connection test failed', error);
            if (cloudProvider === 'dropbox' && isDropboxUnauthorizedError(error)) {
                setDropboxConnected(false);
            }
            Alert.alert(
                localize('Connection failed', '连接失败'),
                cloudProvider === 'dropbox' && isDropboxUnauthorizedError(error)
                    ? localize(
                        'Dropbox token is invalid or revoked. Please tap Connect Dropbox to re-authorize.',
                        'Dropbox 令牌无效或已失效。请点击“连接 Dropbox”重新授权。'
                    )
                    : formatError(error)
            );
        } finally {
            setIsTestingConnection(false);
        }
    };

    const renderSyncHistory = () => {
        if (syncHistoryEntries.length === 0) return null;
        return (
            <View style={{ marginTop: 6 }}>
                <TouchableOpacity onPress={() => setSyncHistoryExpanded((value) => !value)} activeOpacity={0.7}>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText, fontWeight: '600' }]}>
                        {t('settings.syncHistory')} ({syncHistoryEntries.length}) {syncHistoryExpanded ? '▾' : '▸'}
                    </Text>
                </TouchableOpacity>
                {syncHistoryExpanded && syncHistoryEntries.map((entry) => {
                    const statusLabel = entry.status === 'success'
                        ? t('settings.lastSyncSuccess')
                        : entry.status === 'conflict'
                            ? t('settings.lastSyncConflict')
                            : t('settings.lastSyncError');
                    const details = [
                        entry.backend ? `${t('settings.syncHistoryBackend')}: ${entry.backend}` : null,
                        entry.type ? `${t('settings.syncHistoryType')}: ${entry.type}` : null,
                        entry.conflicts ? `${t('settings.lastSyncConflicts')}: ${entry.conflicts}` : null,
                        entry.maxClockSkewMs > 0 ? `${t('settings.lastSyncSkew')}: ${formatClockSkew(entry.maxClockSkewMs)}` : null,
                        entry.timestampAdjustments > 0 ? `${t('settings.lastSyncAdjusted')}: ${entry.timestampAdjustments}` : null,
                        entry.details ? `${t('settings.syncHistoryDetails')}: ${entry.details}` : null,
                    ].filter(Boolean);
                    return (
                        <Text key={`${entry.at}-${entry.status}`} style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {new Date(entry.at).toLocaleString()} • {statusLabel}
                            {details.length ? ` • ${details.join(' • ')}` : ''}
                            {entry.status === 'error' && entry.error ? ` • ${entry.error}` : ''}
                        </Text>
                    );
                })}
            </View>
        );
    };

    const handleBackup = async () => {
        setIsSyncing(true);
        try {
            await exportData({ tasks, projects, sections, areas, settings });
        } catch (error) {
            logSettingsError(error);
            Alert.alert(localize('Error', '错误'), localize('Failed to export data', '导出失败'));
        } finally {
            setIsSyncing(false);
        }
    };

    const toggleDebugLogging = (value: boolean) => {
        updateSettings({
            diagnostics: {
                ...(settings.diagnostics ?? {}),
                loggingEnabled: value,
            },
        })
            .then(async () => {
                if (!value) return;
                const ensuredPath = await ensureLogFilePath();
                if (!ensuredPath) return;
                await logInfo('Debug logging enabled', { scope: 'diagnostics' });
            })
            .catch(logSettingsError);
    };

    const handleShareLog = async () => {
        const path = await ensureLogFilePath();
        if (!path) {
            Alert.alert(t('settings.debugLogging'), t('settings.logMissing'));
            return;
        }
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
            Alert.alert(t('settings.debugLogging'), t('settings.shareUnavailable'));
            return;
        }
        await Sharing.shareAsync(path, { mimeType: 'text/plain' });
    };

    const handleClearLog = async () => {
        await clearLog();
        Alert.alert(t('settings.debugLogging'), t('settings.logCleared'));
    };

    const updateFeatureFlags = (next: { priorities?: boolean; timeEstimates?: boolean; pomodoro?: boolean }) => {
        updateSettings({
            features: {
                ...(settings.features ?? {}),
                ...next,
            },
        }).catch(logSettingsError);
    };
    const ensureNotificationsPermission = async () => {
        const result = await requestNotificationPermission();
        if (result.granted) {
            startMobileNotifications().catch(logSettingsError);
            return true;
        }
        if (result.canAskAgain === false) {
            Alert.alert(
                localize('Notifications disabled', '通知已禁用'),
                localize('Please enable notifications in system settings.', '请在系统设置中启用通知。'),
                [
                    { text: localize('Cancel', '取消'), style: 'cancel' },
                    {
                        text: localize('Open settings', '打开设置'),
                        onPress: () => Linking.openSettings().catch(logSettingsError),
                    },
                ],
            );
        }
        return false;
    };

    // Sub-screen header
    const SubHeader = ({ title }: { title: string }) => (
        <View style={styles.subHeader}>
            <Text style={[styles.subHeaderTitle, { color: tc.text }]}>{title}</Text>
        </View>
    );

    // Menu Item
    const MenuItem = ({
        title,
        onPress,
        showIndicator,
        indicatorColor,
        indicatorAccessibilityLabel,
    }: {
        title: string;
        onPress: () => void;
        showIndicator?: boolean;
        indicatorColor?: string;
        indicatorAccessibilityLabel?: string;
    }) => (
        <TouchableOpacity style={[styles.menuItem, { borderBottomColor: tc.border }]} onPress={onPress}>
            <Text style={[styles.menuLabel, { color: tc.text }]}>{title}</Text>
            <View style={styles.menuRight}>
                {showIndicator && (
                    <View
                        accessibilityLabel={indicatorAccessibilityLabel ?? localize('Update available', '有可用更新')}
                        accessibilityRole="text"
                        style={[styles.updateDot, indicatorColor ? { backgroundColor: indicatorColor } : null]}
                    />
                )}
                <Text style={[styles.chevron, { color: tc.secondaryText }]}>›</Text>
            </View>
        </TouchableOpacity>
    );

    const SettingsTopBar = () => {
        const canGoBack = router.canGoBack();
        return (
            <View
                style={[
                    styles.topBar,
                    {
                        backgroundColor: tc.cardBg,
                        borderBottomColor: tc.border,
                        height: 52 + insets.top,
                        paddingTop: insets.top,
                    },
                ]}
            >
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    disabled={!canGoBack}
                    hitSlop={8}
                    onPress={() => {
                        if (canGoBack) router.back();
                    }}
                    style={[styles.topBarBackButton, !canGoBack && styles.topBarBackButtonHidden]}
                >
                    <Ionicons color={tc.text} name="chevron-back" size={24} />
                </Pressable>
                <Text style={[styles.topBarTitle, { color: tc.text }]} numberOfLines={1}>
                    {t('settings.title')}
                </Text>
                <View style={styles.topBarBackButton} />
            </View>
        );
    };

    // ============ NOTIFICATIONS SCREEN ============
    if (currentScreen === 'notifications') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.notifications')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.notificationsEnable')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.notificationsDesc')}
                                </Text>
                            </View>
                            <Switch
                                value={notificationsEnabled}
                                onValueChange={(value) => {
                                    if (!value) {
                                        updateSettings({ notificationsEnabled: false }).catch(logSettingsError);
                                        return;
                                    }
                                    ensureNotificationsPermission()
                                        .then((granted) => {
                                            if (!granted) return;
                                            updateSettings({ notificationsEnabled: true }).catch(logSettingsError);
                                        })
                                        .catch(logSettingsError);
                                }}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weeklyReview')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.weeklyReviewDesc')}
                                </Text>
                            </View>
                            <Switch
                                value={weeklyReviewEnabled}
                                onValueChange={(value) => {
                                    if (!value) {
                                        updateSettings({ weeklyReviewEnabled: false }).catch(logSettingsError);
                                        return;
                                    }
                                    ensureNotificationsPermission()
                                        .then((granted) => {
                                            if (!granted) return;
                                            updateSettings({ weeklyReviewEnabled: true }).catch(logSettingsError);
                                        })
                                        .catch(logSettingsError);
                                }}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                                disabled={!notificationsEnabled}
                            />
                        </View>

                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={selectWeeklyReviewDay}
                            disabled={!weeklyReviewEnabled || !notificationsEnabled}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text, opacity: weeklyReviewEnabled ? 1 : 0.5 }]}>
                                    {t('settings.weeklyReviewDay')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, opacity: weeklyReviewEnabled ? 1 : 0.5 }]}>
                                    {getWeekdayLabel(weeklyReviewDay)}
                                </Text>
                            </View>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={openWeeklyReviewTimePicker}
                            disabled={!weeklyReviewEnabled || !notificationsEnabled}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text, opacity: weeklyReviewEnabled ? 1 : 0.5 }]}>
                                    {t('settings.weeklyReviewTime')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, opacity: weeklyReviewEnabled ? 1 : 0.5 }]}>
                                    {formatTime(weeklyReviewTime)}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    </View>

                    <Modal
                        transparent
                        visible={weeklyReviewDayPickerOpen}
                        animationType="fade"
                        onRequestClose={() => setWeeklyReviewDayPickerOpen(false)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setWeeklyReviewDayPickerOpen(false)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.weeklyReviewDay')}</Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {Array.from({ length: 7 }, (_, idx) => {
                                        const label = getWeekdayLabel(idx);
                                        const selected = weeklyReviewDay === idx;
                                        return (
                                            <TouchableOpacity
                                                key={label}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    updateSettings({ weeklyReviewDay: idx }).catch(logSettingsError);
                                                    setWeeklyReviewDayPickerOpen(false);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {label}
                                                </Text>
                                                {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dailyDigest')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.dailyDigestDesc')}
                                </Text>
                            </View>
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dailyDigestMorning')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.dailyDigestMorningTime')}: {formatTime(dailyDigestMorningTime)}
                                </Text>
                            </View>
                            <Switch
                                value={dailyDigestMorningEnabled}
                                onValueChange={(value) => {
                                    if (!value) {
                                        updateSettings({ dailyDigestMorningEnabled: false }).catch(logSettingsError);
                                        return;
                                    }
                                    ensureNotificationsPermission()
                                        .then((granted) => {
                                            if (!granted) return;
                                            updateSettings({ dailyDigestMorningEnabled: true }).catch(logSettingsError);
                                        })
                                        .catch(logSettingsError);
                                }}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>

                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => openDigestTimePicker('morning')}
                            disabled={!dailyDigestMorningEnabled}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text, opacity: dailyDigestMorningEnabled ? 1 : 0.5 }]}>
                                    {t('settings.dailyDigestMorningTime')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, opacity: dailyDigestMorningEnabled ? 1 : 0.5 }]}>
                                    {formatTime(dailyDigestMorningTime)}
                                </Text>
                            </View>
                        </TouchableOpacity>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dailyDigestEvening')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.dailyDigestEveningTime')}: {formatTime(dailyDigestEveningTime)}
                                </Text>
                            </View>
                            <Switch
                                value={dailyDigestEveningEnabled}
                                onValueChange={(value) => {
                                    if (!value) {
                                        updateSettings({ dailyDigestEveningEnabled: false }).catch(logSettingsError);
                                        return;
                                    }
                                    ensureNotificationsPermission()
                                        .then((granted) => {
                                            if (!granted) return;
                                            updateSettings({ dailyDigestEveningEnabled: true }).catch(logSettingsError);
                                        })
                                        .catch(logSettingsError);
                                }}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>

                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => openDigestTimePicker('evening')}
                            disabled={!dailyDigestEveningEnabled}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text, opacity: dailyDigestEveningEnabled ? 1 : 0.5 }]}>
                                    {t('settings.dailyDigestEveningTime')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, opacity: dailyDigestEveningEnabled ? 1 : 0.5 }]}>
                                    {formatTime(dailyDigestEveningTime)}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    </View>

                    {digestTimePicker && Platform.OS === 'ios' && (
                        <Modal
                            transparent
                            visible
                            animationType="fade"
                            onRequestClose={closeDigestTimePicker}
                        >
                            <Pressable style={styles.pickerOverlay} onPress={closeDigestTimePicker}>
                                <View
                                    style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                    onStartShouldSetResponder={() => true}
                                >
                                    <Text style={[styles.pickerTitle, { color: tc.text }]}>
                                        {digestTimePicker === 'morning'
                                            ? t('settings.dailyDigestMorningTime')
                                            : t('settings.dailyDigestEveningTime')}
                                    </Text>
                                    <DateTimePicker
                                        value={digestTimeDraft ?? toTimePickerDate(digestTimePicker === 'morning' ? dailyDigestMorningTime : dailyDigestEveningTime)}
                                        mode="time"
                                        display="spinner"
                                        onChange={(_, date) => {
                                            if (!date) return;
                                            setDigestTimeDraft(date);
                                        }}
                                    />
                                    <View style={[styles.timePickerActions, { borderTopColor: tc.border }]}>
                                        <TouchableOpacity onPress={closeDigestTimePicker} style={styles.timePickerActionButton}>
                                            <Text style={[styles.timePickerActionText, { color: tc.secondaryText }]}>
                                                {t('common.cancel') || 'Cancel'}
                                            </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity onPress={saveDigestTimePicker} style={styles.timePickerActionButton}>
                                            <Text style={[styles.timePickerActionText, { color: tc.tint }]}>
                                                {t('common.done') || 'Done'}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            </Pressable>
                        </Modal>
                    )}

                    {digestTimePicker && Platform.OS === 'android' && (
                        <DateTimePicker
                            value={toTimePickerDate(digestTimePicker === 'morning' ? dailyDigestMorningTime : dailyDigestEveningTime)}
                            mode="time"
                            display="default"
                            onChange={(event, date) => {
                                if (event.type === 'dismissed') {
                                    setDigestTimePicker(null);
                                    return;
                                }
                                onDigestTimeChange(event, date);
                            }}
                        />
                    )}

                    {weeklyReviewTimePicker && Platform.OS === 'ios' && (
                        <Modal
                            transparent
                            visible
                            animationType="fade"
                            onRequestClose={closeWeeklyReviewTimePicker}
                        >
                            <Pressable style={styles.pickerOverlay} onPress={closeWeeklyReviewTimePicker}>
                                <View
                                    style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                    onStartShouldSetResponder={() => true}
                                >
                                    <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.weeklyReviewTime')}</Text>
                                    <DateTimePicker
                                        value={weeklyReviewTimeDraft ?? toTimePickerDate(weeklyReviewTime)}
                                        mode="time"
                                        display="spinner"
                                        onChange={(_, date) => {
                                            if (!date) return;
                                            setWeeklyReviewTimeDraft(date);
                                        }}
                                    />
                                    <View style={[styles.timePickerActions, { borderTopColor: tc.border }]}>
                                        <TouchableOpacity onPress={closeWeeklyReviewTimePicker} style={styles.timePickerActionButton}>
                                            <Text style={[styles.timePickerActionText, { color: tc.secondaryText }]}>
                                                {t('common.cancel') || 'Cancel'}
                                            </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity onPress={saveWeeklyReviewTimePicker} style={styles.timePickerActionButton}>
                                            <Text style={[styles.timePickerActionText, { color: tc.tint }]}>
                                                {t('common.done') || 'Done'}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            </Pressable>
                        </Modal>
                    )}

                    {weeklyReviewTimePicker && Platform.OS === 'android' && (
                        <DateTimePicker
                            value={toTimePickerDate(weeklyReviewTime)}
                            mode="time"
                            display="default"
                            onChange={(event, date) => {
                                if (event.type === 'dismissed') {
                                    setWeeklyReviewTimePicker(false);
                                    return;
                                }
                                onWeeklyReviewTimeChange(event, date);
                            }}
                        />
                    )}


                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GENERAL SCREEN ============
    if (currentScreen === 'general') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.general')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.appearance')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <TouchableOpacity style={styles.settingRow} onPress={() => setThemePickerOpen(true)}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.theme')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {currentThemeLabel}
                                </Text>
                            </View>
                            <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                        </TouchableOpacity>
                    </View>
                    <Modal
                        transparent
                        visible={themePickerOpen}
                        animationType="fade"
                        onRequestClose={() => setThemePickerOpen(false)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setThemePickerOpen(false)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.theme')}</Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {themeOptions.map((option) => {
                                        const selected = option.value === themeMode;
                                        return (
                                            <TouchableOpacity
                                                key={option.value}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    setThemeMode(option.value);
                                                    updateSettings({ theme: mapThemeToSetting(option.value) }).catch(logSettingsError);
                                                    setThemePickerOpen(false);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {option.label}
                                                </Text>
                                                {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>

                    <Text style={[styles.sectionTitle, { color: tc.secondaryText, marginTop: 16 }]}>{t('settings.language')}</Text>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.selectLang')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <TouchableOpacity style={styles.settingRow} onPress={() => setLanguagePickerOpen(true)}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.language')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {LANGUAGES.find((lang) => lang.id === language)?.native ?? language}
                                </Text>
                            </View>
                            <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                        </TouchableOpacity>
                    </View>
                    <Modal
                        transparent
                        visible={languagePickerOpen}
                        animationType="fade"
                        onRequestClose={() => setLanguagePickerOpen(false)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setLanguagePickerOpen(false)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.language')}</Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {LANGUAGES.map((lang) => {
                                        const selected = language === lang.id;
                                        return (
                                            <TouchableOpacity
                                                key={lang.id}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    setLanguage(lang.id);
                                                    updateSettings({ language: lang.id }).catch(logSettingsError);
                                                    setLanguagePickerOpen(false);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {lang.native}
                                                </Text>
                                                {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <TouchableOpacity style={styles.settingRow} onPress={() => setWeekStartPickerOpen(true)}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weekStart')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {currentWeekStartLabel}
                                </Text>
                            </View>
                            <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                        </TouchableOpacity>
                    </View>
                    <Modal
                        transparent
                        visible={weekStartPickerOpen}
                        animationType="fade"
                        onRequestClose={() => setWeekStartPickerOpen(false)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setWeekStartPickerOpen(false)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.weekStart')}</Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {weekStartOptions.map((option) => {
                                        const selected = weekStart === option.value;
                                        return (
                                            <TouchableOpacity
                                                key={option.value}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    updateSettings({ weekStart: option.value }).catch(logSettingsError);
                                                    setWeekStartPickerOpen(false);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {option.label}
                                                </Text>
                                                {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <TouchableOpacity style={styles.settingRow} onPress={() => setDateFormatPickerOpen(true)}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dateFormat')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {currentDateFormatLabel}
                                </Text>
                            </View>
                            <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                        </TouchableOpacity>
                    </View>
                    <Modal
                        transparent
                        visible={dateFormatPickerOpen}
                        animationType="fade"
                        onRequestClose={() => setDateFormatPickerOpen(false)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setDateFormatPickerOpen(false)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.dateFormat')}</Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {dateFormatOptions.map((option) => {
                                        const selected = dateFormat === option.value;
                                        return (
                                            <TouchableOpacity
                                                key={option.value}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    updateSettings({ dateFormat: option.value }).catch(logSettingsError);
                                                    setDateFormatPickerOpen(false);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {option.label}
                                                </Text>
                                                {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <TouchableOpacity style={styles.settingRow} onPress={() => setTimeFormatPickerOpen(true)}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.timeFormat')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {currentTimeFormatLabel}
                                </Text>
                            </View>
                            <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                        </TouchableOpacity>
                    </View>
                    <Modal
                        transparent
                        visible={timeFormatPickerOpen}
                        animationType="fade"
                        onRequestClose={() => setTimeFormatPickerOpen(false)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setTimeFormatPickerOpen(false)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.timeFormat')}</Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {timeFormatOptions.map((option) => {
                                        const selected = timeFormat === option.value;
                                        return (
                                            <TouchableOpacity
                                                key={option.value}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    updateSettings({ timeFormat: option.value }).catch(logSettingsError);
                                                    setTimeFormatPickerOpen(false);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {option.label}
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
            </SafeAreaView>
        );
    }

    // ============ AI SCREEN ============
    if (currentScreen === 'ai') {
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
                            <TouchableOpacity
                                style={styles.settingRow}
                                onPress={() => setAiAssistantOpen((prev) => !prev)}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.ai')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.aiDesc')}
                                    </Text>
                                </View>
                                <Text style={[styles.chevron, { color: tc.secondaryText }]}>
                                    {aiAssistantOpen ? '▾' : '▸'}
                                </Text>
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
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {getAIProviderLabel(aiProvider)}
                                    </Text>
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
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.aiCopilotHint')}
                                    </Text>
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
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.aiBaseUrlHint')}
                                        </Text>
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
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.aiThinkingHint')}
                                        </Text>
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
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.aiThinkingEnableDesc')}
                                        </Text>
                                    </View>
                                    <Switch
                                        value={anthropicThinkingEnabled}
                                        onValueChange={(value) =>
                                            updateAISettings({
                                                thinkingBudget: value
                                                    ? (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024)
                                                    : 0,
                                            })
                                        }
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                {anthropicThinkingEnabled && (
                                    <>
                                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <View style={styles.settingInfo}>
                                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiThinkingBudget')}</Text>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                    {t('settings.aiThinkingHint')}
                                                </Text>
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
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.aiApiKeyHint')}
                                </Text>
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
                            <TouchableOpacity
                                style={styles.settingRow}
                                onPress={() => setSpeechOpen((prev) => !prev)}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechTitle')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.speechDesc')}
                                    </Text>
                                </View>
                                <Text style={[styles.chevron, { color: tc.secondaryText }]}>
                                    {speechOpen ? '▾' : '▸'}
                                </Text>
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
                                            {isFossBuild
                                                ? localize('Local Whisper', '本地 Whisper')
                                                : t('settings.speechProviderOffline')}
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
                                    <Text style={[styles.dropdownValue, { color: tc.text }]} numberOfLines={1}>
                                        {speechModel}
                                    </Text>
                                    <Text style={[styles.dropdownChevron, { color: tc.secondaryText }]}>▾</Text>
                                </TouchableOpacity>
                            </View>

                            {speechProvider === 'whisper' ? (
                                <>
                                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.speechOfflineModel')}</Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.speechOfflineModelDesc')}
                                            </Text>
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
                                                    <Text style={{ color: tc.danger, fontSize: 12, marginTop: 6 }}>
                                                        {whisperDownloadError}
                                                    </Text>
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
                                                    onPress={handleDownloadWhisperModel}
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
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.aiApiKeyHint')}
                                            </Text>
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
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.speechLanguageHint')}
                                    </Text>
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
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.speechModeHint')}
                                    </Text>
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
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.speechFieldStrategyHint')}
                                    </Text>
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
                                                        } else {
                                                            if (speechProvider === 'whisper') {
                                                                applyWhisperModel(option);
                                                            } else {
                                                                updateSpeechSettings({ model: option });
                                                            }
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

    // ============ MANAGE (Areas / Contexts / Tags) ============
    if (currentScreen === 'manage') {
        const areas = useTaskStore.getState().areas;
        const sortedAreas = [...areas].sort((a, b) => a.order - b.order);
        const { allContexts, allTags } = useTaskStore.getState().getDerivedState();
        const deleteArea = useTaskStore.getState().deleteArea;
        const updateArea = useTaskStore.getState().updateArea;
        const deleteTag = useTaskStore.getState().deleteTag;
        const renameTag = useTaskStore.getState().renameTag;
        const deleteContext = useTaskStore.getState().deleteContext;
        const renameContext = useTaskStore.getState().renameContext;

        const localize2 = (en: string, zh: string) => (language === 'zh' || language === 'zh-Hant' ? zh : en);

        const confirmDelete = (label: string, onConfirm: () => void) => {
            Alert.alert(
                localize2('Delete', '删除'),
                localize2(`Delete "${label}"?`, `删除"${label}"？`),
                [
                    { text: localize2('Cancel', '取消'), style: 'cancel' },
                    { text: localize2('Delete', '删除'), style: 'destructive', onPress: onConfirm },
                ],
            );
        };

        const promptRename = (currentValue: string, onRename: (newValue: string) => void) => {
            Alert.prompt(
                localize2('Rename', '重命名'),
                undefined,
                [
                    { text: localize2('Cancel', '取消'), style: 'cancel' },
                    {
                        text: localize2('Save', '保存'),
                        onPress: (newValue: string | undefined) => {
                            const trimmed = (newValue ?? '').trim();
                            if (trimmed && trimmed !== currentValue) {
                                onRename(trimmed);
                            }
                        },
                    },
                ],
                'plain-text',
                currentValue,
            );
        };

        const ManageRow = ({ label, onRename, onDelete }: { label: string; onRename?: () => void; onDelete: () => void }) => (
            <View style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: tc.border }]}>
                <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]} numberOfLines={1}>{label}</Text>
                {onRename && (
                    <TouchableOpacity onPress={onRename} style={{ padding: 8 }}>
                        <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
                    </TouchableOpacity>
                )}
                <TouchableOpacity onPress={onDelete} style={{ padding: 8 }}>
                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                </TouchableOpacity>
            </View>
        );

        const AreaRow = ({ area }: { area: typeof sortedAreas[number] }) => (
            <View style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: tc.border }]}>
                <View style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: area.color || '#94a3b8', marginRight: 12 }} />
                <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]} numberOfLines={1}>{area.name}</Text>
                <TouchableOpacity
                    onPress={() => promptRename(area.name, (name) => void updateArea(area.id, { name }))}
                    style={{ padding: 8 }}
                >
                    <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => confirmDelete(area.name, () => void deleteArea(area.id))}
                    style={{ padding: 8 }}
                >
                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                </TouchableOpacity>
            </View>
        );

        const CollapsibleSection = ({ title, count, children }: { title: string; count: number; children: React.ReactNode }) => {
            const [open, setOpen] = useState(false);
            return (
                <View style={{ marginBottom: 16 }}>
                    <TouchableOpacity
                        onPress={() => setOpen((prev) => !prev)}
                        style={[styles.settingCard, {
                            backgroundColor: tc.cardBg,
                            flexDirection: 'row',
                            alignItems: 'center',
                            padding: 16,
                        }]}
                    >
                        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={16} color={tc.secondaryText} />
                        <Text style={[styles.settingLabel, { color: tc.text, flex: 1, marginLeft: 8 }]}>{title}</Text>
                        <Text style={{ fontSize: 13, color: tc.secondaryText }}>{count}</Text>
                    </TouchableOpacity>
                    {open && (
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 1 }]}>
                            {children}
                        </View>
                    )}
                </View>
            );
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.manage')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    {/* Areas */}
                    <CollapsibleSection title={t('areas.manage')} count={sortedAreas.length}>
                        {sortedAreas.length === 0 && (
                            <View style={styles.settingRow}>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('projects.noArea')}
                                </Text>
                            </View>
                        )}
                        {sortedAreas.map((area) => (
                            <AreaRow key={area.id} area={area} />
                        ))}
                    </CollapsibleSection>

                    {/* Contexts */}
                    <CollapsibleSection title={t('contexts.title')} count={allContexts.length}>
                        {allContexts.length === 0 && (
                            <View style={styles.settingRow}>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {localize2('No contexts', '无情境')}
                                </Text>
                            </View>
                        )}
                        {allContexts.map((ctx) => (
                            <ManageRow
                                key={ctx}
                                label={ctx}
                                onRename={() => promptRename(ctx, (newVal) => void renameContext(ctx, newVal))}
                                onDelete={() => confirmDelete(ctx, () => void deleteContext(ctx))}
                            />
                        ))}
                    </CollapsibleSection>

                    {/* Tags */}
                    <CollapsibleSection title={localize2('Tags', '标签')} count={allTags.length}>
                        {allTags.length === 0 && (
                            <View style={styles.settingRow}>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('projects.noTags')}
                                </Text>
                            </View>
                        )}
                        {allTags.map((tag) => (
                            <ManageRow
                                key={tag}
                                label={tag}
                                onRename={() => promptRename(tag, (newVal) => void renameTag(tag, newVal))}
                                onDelete={() => confirmDelete(tag, () => void deleteTag(tag))}
                            />
                        ))}
                    </CollapsibleSection>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GTD MENU ============
    if (currentScreen === 'gtd') {
        const featurePomodoroLabelRaw = t('settings.featurePomodoro');
        const featurePomodoroDescRaw = t('settings.featurePomodoroDesc');
        const featurePomodoroLabel = featurePomodoroLabelRaw === 'settings.featurePomodoro'
            ? localize('Pomodoro timer', '番茄钟')
            : featurePomodoroLabelRaw;
        const featurePomodoroDesc = featurePomodoroDescRaw === 'settings.featurePomodoroDesc'
            ? localize('Enable the optional Pomodoro panel in Focus view.', '在聚焦视图中启用可选的番茄钟面板。')
            : featurePomodoroDescRaw;
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.gtd')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.gtdDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.features')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.featuresDesc')}
                                </Text>
                            </View>
                        </View>
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{featurePomodoroLabel}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {featurePomodoroDesc}
                                </Text>
                            </View>
                            <Switch
                                value={pomodoroEnabled}
                                onValueChange={(value) => updateFeatureFlags({ pomodoro: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                    </View>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        {timeEstimatesEnabled && (
                            <MenuItem
                                title={t('settings.timeEstimatePresets')}
                                onPress={() => pushSettingsScreen('gtd-time-estimates')}
                            />
                        )}
                        <MenuItem
                            title={t('settings.autoArchive')}
                            onPress={() => pushSettingsScreen('gtd-archive')}
                        />
                        <MenuItem
                            title={t('settings.taskEditorLayout')}
                            onPress={() => pushSettingsScreen('gtd-task-editor')}
                        />
                    </View>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.captureDefault')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.captureDefaultDesc')}
                                </Text>
                            </View>
                        </View>
                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                            <View style={styles.backendToggle}>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: defaultCaptureMethod === 'text' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        updateSettings({
                                            gtd: {
                                                ...(settings.gtd ?? {}),
                                                defaultCaptureMethod: 'text',
                                            },
                                        }).catch(logSettingsError);
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: defaultCaptureMethod === 'text' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.captureDefaultText')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: defaultCaptureMethod === 'audio' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        updateSettings({
                                            gtd: {
                                                ...(settings.gtd ?? {}),
                                                defaultCaptureMethod: 'audio',
                                            },
                                        }).catch(logSettingsError);
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: defaultCaptureMethod === 'audio' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.captureDefaultAudio')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                        {defaultCaptureMethod === 'audio' ? (
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.captureSaveAudio')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.captureSaveAudioDesc')}
                                    </Text>
                                </View>
                                <Switch
                                    value={saveAudioAttachments}
                                    onValueChange={(value) => {
                                        updateSettings({
                                            gtd: {
                                                ...(settings.gtd ?? {}),
                                                saveAudioAttachments: value,
                                            },
                                        }).catch(logSettingsError);
                                    }}
                                    trackColor={{ false: '#767577', true: '#3B82F6' }}
                                />
                            </View>
                        ) : null}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weeklyReviewConfig')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.weeklyReviewConfigDesc')}
                                </Text>
                            </View>
                        </View>
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weeklyReviewIncludeContextsStep')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.weeklyReviewIncludeContextsStepDesc')}
                                </Text>
                            </View>
                            <Switch
                                value={includeContextStep}
                                onValueChange={(value) => updateWeeklyReviewConfig({ includeContextStep: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <TouchableOpacity
                                style={styles.settingInfo}
                                onPress={() => setGtdInboxProcessingExpanded((prev) => !prev)}
                                activeOpacity={0.7}
                            >
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxProcessing')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.inboxProcessingDesc')}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setGtdInboxProcessingExpanded((prev) => !prev)} activeOpacity={0.7}>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {gtdInboxProcessingExpanded ? '▾' : '▸'}
                                </Text>
                            </TouchableOpacity>
                        </View>
                        {gtdInboxProcessingExpanded && (
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxTwoMinuteEnabled')}</Text>
                            </View>
                            <Switch
                                value={inboxTwoMinuteEnabled}
                                onValueChange={(value) => updateInboxProcessing({ twoMinuteEnabled: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                        )}
                        {gtdInboxProcessingExpanded && (
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxProjectFirst')}</Text>
                            </View>
                            <Switch
                                value={inboxProjectFirst}
                                onValueChange={(value) => updateInboxProcessing({ projectFirst: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                        )}
                        {gtdInboxProcessingExpanded && (
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxContextStepEnabled')}</Text>
                            </View>
                            <Switch
                                value={inboxContextStepEnabled}
                                onValueChange={(value) => updateInboxProcessing({ contextStepEnabled: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                        )}
                        {gtdInboxProcessingExpanded && (
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxScheduleEnabled')}</Text>
                            </View>
                            <Switch
                                value={inboxScheduleEnabled}
                                onValueChange={(value) => updateInboxProcessing({ scheduleEnabled: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                        )}
                        {gtdInboxProcessingExpanded && (
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.inboxReferenceEnabled')}</Text>
                            </View>
                            <Switch
                                value={inboxReferenceEnabled}
                                onValueChange={(value) => updateInboxProcessing({ referenceEnabled: value })}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                        )}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GTD: AUTO ARCHIVE ============
    if (currentScreen === 'gtd-archive') {
        const autoArchiveOptions = [0, 1, 3, 7, 14, 30, 60];
        const formatAutoArchiveLabel = (days: number) => {
            if (days <= 0) return t('settings.autoArchiveNever');
            return isChineseLanguage ? `${days} 天` : `${days} ${translateText('days', language)}`;
        };

        const handleSelectArchive = (days: number) => {
            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    autoArchiveDays: days,
                },
            }).catch(logSettingsError);
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.autoArchive')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.autoArchiveDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {autoArchiveOptions.map((days, idx) => {
                            const selected = autoArchiveDays === days;
                            return (
                                <TouchableOpacity
                                    key={days}
                                    style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => handleSelectArchive(days)}
                                >
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{formatAutoArchiveLabel(days)}</Text>
                                    {selected && <Text style={{ color: '#3B82F6', fontSize: 20 }}>✓</Text>}
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GTD: TIME ESTIMATES ============
    if (currentScreen === 'gtd-time-estimates') {
        if (!timeEstimatesEnabled) {
            return (
                <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                    <SubHeader title={t('settings.timeEstimatePresets')} />
                    <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                        <Text style={[styles.description, { color: tc.secondaryText }]}>
                            {t('settings.timeEstimatePresetsDisabled')}
                        </Text>
                        <TouchableOpacity
                            style={[styles.settingCard, { backgroundColor: tc.cardBg }]}
                            onPress={() => updateFeatureFlags({ timeEstimates: true })}
                        >
                            <View style={styles.settingRow}>
                                <Text style={[styles.settingLabel, { color: tc.tint }]}>
                                    {t('settings.enableTimeEstimates')}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    </ScrollView>
                </SafeAreaView>
            );
        }

        const togglePreset = (value: TimeEstimate) => {
            const isSelected = timeEstimatePresets.includes(value);
            if (isSelected && timeEstimatePresets.length <= 1) return;

            const next = isSelected ? timeEstimatePresets.filter((v) => v !== value) : [...timeEstimatePresets, value];
            const ordered = timeEstimateOptions.filter((v) => next.includes(v));

            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    timeEstimatePresets: ordered,
                },
            }).catch(logSettingsError);
        };

        const resetToDefault = () => {
            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    timeEstimatePresets: [...defaultTimeEstimatePresets],
                },
            }).catch(logSettingsError);
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.timeEstimatePresets')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.timeEstimatePresetsDesc')}</Text>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {timeEstimateOptions.map((value, idx) => {
                            const selected = timeEstimatePresets.includes(value);
                            return (
                                <TouchableOpacity
                                    key={value}
                                    style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => togglePreset(value)}
                                >
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                        {formatTimeEstimateLabel(value)}
                                    </Text>
                                    {selected && <Text style={{ color: '#3B82F6', fontSize: 20 }}>✓</Text>}
                                </TouchableOpacity>
                            );
                        })}
                    </View>

                    <TouchableOpacity
                        style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}
                        onPress={resetToDefault}
                    >
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.resetToDefault')}</Text>
                        </View>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GTD: TASK EDITOR ============
    if (currentScreen === 'gtd-task-editor') {
        const featureHiddenFields = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) featureHiddenFields.add('priority');
        if (!timeEstimatesEnabled) featureHiddenFields.add('timeEstimate');

        const defaultTaskEditorOrder = DEFAULT_TASK_EDITOR_ORDER;
        const defaultVisibleFields = DEFAULT_TASK_EDITOR_VISIBLE;
        const defaultTaskEditorHidden = defaultTaskEditorOrder.filter(
            (id) => !defaultVisibleFields.includes(id) || featureHiddenFields.has(id)
        );
        const known = new Set(defaultTaskEditorOrder);
        const savedOrder = (settings.gtd?.taskEditor?.order ?? []).filter((id) => known.has(id));
        const taskEditorOrder = [...savedOrder, ...defaultTaskEditorOrder.filter((id) => !savedOrder.includes(id))];

        const savedHidden = settings.gtd?.taskEditor?.hidden ?? defaultTaskEditorHidden;
        const hiddenSet = new Set(savedHidden.filter((id) => known.has(id)));
        const taskEditorSections = getTaskEditorSectionAssignments(settings.gtd?.taskEditor);
        const taskEditorSectionOpen = getTaskEditorSectionOpenDefaults(settings.gtd?.taskEditor);
        const taskEditorDefaultOpenLabel = t('settings.taskEditorDefaultOpen');
        const resolvedTaskEditorDefaultOpenLabel = taskEditorDefaultOpenLabel === 'settings.taskEditorDefaultOpen'
            ? 'Open sections by default'
            : taskEditorDefaultOpenLabel;
        const taskEditorPresetOptions: { id: Exclude<TaskEditorPresetId, 'custom'>; label: string }[] = [
            { id: 'simple', label: localize('Simple', '简洁') },
            { id: 'standard', label: localize('Standard', '标准') },
            { id: 'full', label: localize('Full', '完整') },
        ];
        const activeTaskEditorPreset = resolveTaskEditorPresetId({
            order: taskEditorOrder,
            hidden: hiddenSet,
            sections: settings.gtd?.taskEditor?.sections,
            sectionOpen: settings.gtd?.taskEditor?.sectionOpen,
            featureHiddenFields,
        });
        const taskEditorHelperText = localize(
            'Choose a preset, then open a section to fine-tune fields.',
            '先选择一个预设，再展开分组微调字段。'
        );
        const taskEditorCustomLabel = localize('Current layout: Custom', '当前布局：自定义');
        const taskEditorPresetLabel = localize('Presets', '预设');
        const taskEditorMoveSectionLabel = localize('Move to section', '移动到分组');
        const taskEditorOrderLabel = localize('Order within section', '调整分组内顺序');
        const taskEditorKeepOpenLabel = localize(
            'Start task editing with this section expanded.',
            '编辑任务时默认展开此分组。'
        );
        const showInEditorLabel = localize('Show in editor', '在编辑器中显示');
        const moveUpLabel = localize('Move up', '上移');
        const moveDownLabel = localize('Move down', '下移');
        const doneLabel = t('common.done') === 'common.done' ? localize('Done', '完成') : t('common.done');

        const fieldLabel = (fieldId: TaskEditorFieldId) => {
            switch (fieldId) {
                case 'status':
                    return t('taskEdit.statusLabel');
                case 'project':
                    return t('taskEdit.projectLabel');
                case 'section':
                    return t('taskEdit.sectionLabel');
                case 'area':
                    return t('taskEdit.areaLabel');
                case 'priority':
                    return t('taskEdit.priorityLabel');
                case 'contexts':
                    return t('taskEdit.contextsLabel');
                case 'description':
                    return t('taskEdit.descriptionLabel');
                case 'tags':
                    return t('taskEdit.tagsLabel');
                case 'timeEstimate':
                    return t('taskEdit.timeEstimateLabel');
                case 'recurrence':
                    return t('taskEdit.recurrenceLabel');
                case 'startTime':
                    return t('taskEdit.startDateLabel');
                case 'dueDate':
                    return t('taskEdit.dueDateLabel');
                case 'reviewAt':
                    return t('taskEdit.reviewDateLabel');
                case 'attachments':
                    return t('attachments.title');
                case 'checklist':
                    return t('taskEdit.checklist');
                default:
                    return fieldId;
            }
        };

        const sectionLabel = (sectionId: TaskEditorSectionId) => {
            switch (sectionId) {
                case 'basic':
                    return t('taskEdit.basic');
                case 'scheduling':
                    return t('taskEdit.scheduling');
                case 'organization':
                    return t('taskEdit.organization');
                case 'details':
                    return t('taskEdit.details');
                default:
                    return sectionId;
            }
        };

        const toggleTaskEditorSectionExpanded = (sectionId: TaskEditorSectionId) => {
            setTaskEditorExpandedSections((prev) => ({
                ...prev,
                [sectionId]: !prev[sectionId],
            }));
        };

        const saveTaskEditor = (
            next: {
                order?: TaskEditorFieldId[];
                hidden?: TaskEditorFieldId[];
                sections?: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>;
                sectionOpen?: Partial<Record<TaskEditorSectionId, boolean>>;
            },
            nextFeatures?: AppData['settings']['features']
        ) => {
            updateSettings({
                ...(nextFeatures ? { features: nextFeatures } : null),
                gtd: {
                    ...(settings.gtd ?? {}),
                    taskEditor: {
                        ...(settings.gtd?.taskEditor ?? {}),
                        ...next,
                    },
                },
            }).catch(logSettingsError);
        };

        const toggleFieldVisibility = (fieldId: TaskEditorFieldId) => {
            const nextHidden = new Set(hiddenSet);
            if (nextHidden.has(fieldId)) nextHidden.delete(fieldId);
            else nextHidden.add(fieldId);
            const nextFeatures = { ...(settings.features ?? {}) };
            if (fieldId === 'priority') nextFeatures.priorities = !nextHidden.has('priority');
            if (fieldId === 'timeEstimate') nextFeatures.timeEstimates = !nextHidden.has('timeEstimate');
            saveTaskEditor({ order: taskEditorOrder, hidden: Array.from(nextHidden) }, nextFeatures);
        };

        const moveOrderInGroup = (fieldId: TaskEditorFieldId, delta: number, groupFields: TaskEditorFieldId[]) => {
            const groupOrder = taskEditorOrder.filter((id) => groupFields.includes(id));
            const fromIndex = groupOrder.indexOf(fieldId);
            if (fromIndex < 0) return;
            const toIndex = Math.max(0, Math.min(groupOrder.length - 1, fromIndex + delta));
            if (fromIndex === toIndex) return;
            const nextGroupOrder = [...groupOrder];
            const [item] = nextGroupOrder.splice(fromIndex, 1);
            nextGroupOrder.splice(toIndex, 0, item);
            let groupIndex = 0;
            const nextOrder = taskEditorOrder.map((id) =>
                groupFields.includes(id) ? nextGroupOrder[groupIndex++] : id
            );
            saveTaskEditor({ order: nextOrder, hidden: Array.from(hiddenSet) });
        };

        const updateFieldSection = (fieldId: TaskEditorFieldId, sectionId: TaskEditorSectionId) => {
            if (!isTaskEditorSectionableField(fieldId)) return;
            const nextSections = { ...(settings.gtd?.taskEditor?.sections ?? {}) };
            if (sectionId === DEFAULT_TASK_EDITOR_SECTION_BY_FIELD[fieldId]) {
                delete nextSections[fieldId];
            } else {
                nextSections[fieldId] = sectionId;
            }
            saveTaskEditor({ order: taskEditorOrder, hidden: Array.from(hiddenSet), sections: nextSections });
        };

        const updateSectionOpenDefault = (sectionId: Exclude<TaskEditorSectionId, 'basic'>, isOpen: boolean) => {
            const nextSectionOpen = { ...(settings.gtd?.taskEditor?.sectionOpen ?? {}) };
            if (isOpen === DEFAULT_TASK_EDITOR_SECTION_OPEN[sectionId]) {
                delete nextSectionOpen[sectionId];
            } else {
                nextSectionOpen[sectionId] = isOpen;
            }
            saveTaskEditor({ sectionOpen: nextSectionOpen });
        };

        const fieldGroups: { id: TaskEditorSectionId; title: string; fields: TaskEditorFieldId[] }[] = TASK_EDITOR_SECTION_ORDER.map((sectionId) => ({
            id: sectionId,
            title: sectionLabel(sectionId),
            fields: taskEditorOrder.filter((fieldId) => {
                if (sectionId === 'basic' && TASK_EDITOR_FIXED_FIELDS.includes(fieldId)) return true;
                return isTaskEditorSectionableField(fieldId) && taskEditorSections[fieldId] === sectionId;
            }),
        }));

        const applyTaskEditorPreset = (presetId: Exclude<TaskEditorPresetId, 'custom'>) => {
            const preset = buildTaskEditorPresetConfig(presetId, featureHiddenFields);
            saveTaskEditor(preset);
        };

        const selectedFieldId = taskEditorSelectedField;
        const selectedFieldGroup = selectedFieldId
            ? fieldGroups.find((group) => group.fields.includes(selectedFieldId)) ?? null
            : null;
        const selectedFieldGroupFields = selectedFieldGroup?.fields ?? [];
        const selectedFieldGroupOrder = taskEditorOrder.filter((id) => selectedFieldGroupFields.includes(id));
        const selectedFieldIndex = selectedFieldId ? selectedFieldGroupOrder.indexOf(selectedFieldId) : -1;
        const selectedFieldSectionable = selectedFieldId ? isTaskEditorSectionableField(selectedFieldId) : false;
        const selectedFieldVisible = selectedFieldId ? !hiddenSet.has(selectedFieldId) : false;
        const closeTaskEditorFieldSheet = () => setTaskEditorSelectedField(null);

        function TaskEditorFieldRow({
            fieldId,
            isFirst,
            showTopBorder = false,
        }: {
            fieldId: TaskEditorFieldId;
            isFirst: boolean;
            showTopBorder?: boolean;
        }) {
            const visible = !hiddenSet.has(fieldId);

            return (
                <TouchableOpacity
                    style={[
                        styles.taskEditorCompactRow,
                        { borderTopColor: tc.border },
                        (showTopBorder || !isFirst) && styles.taskEditorCompactRowBorder,
                    ]}
                    onPress={() => setTaskEditorSelectedField(fieldId)}
                    activeOpacity={0.8}
                >
                    <View
                        style={[
                            styles.taskEditorVisibilityBadge,
                            {
                                backgroundColor: visible ? tc.filterBg : 'transparent',
                                borderColor: visible ? tc.tint : tc.border,
                            },
                        ]}
                    >
                        <Ionicons
                            name={visible ? 'eye-outline' : 'eye-off-outline'}
                            size={16}
                            color={visible ? tc.tint : tc.secondaryText}
                        />
                    </View>
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{fieldLabel(fieldId)}</Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {visible ? t('settings.visible') : t('settings.hidden')}
                        </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={tc.secondaryText} />
                </TouchableOpacity>
            );
        }

        const resetToDefault = () => {
            const nextFeatures = { ...(settings.features ?? {}) };
            nextFeatures.priorities = !defaultTaskEditorHidden.includes('priority');
            nextFeatures.timeEstimates = !defaultTaskEditorHidden.includes('timeEstimate');
            saveTaskEditor(
                {
                    order: [...defaultTaskEditorOrder],
                    hidden: [...defaultTaskEditorHidden],
                    sections: {},
                    sectionOpen: {},
                },
                nextFeatures
            );
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.taskEditorLayout')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.taskEditorLayoutDesc')}</Text>
                    <Text style={[styles.description, { color: tc.secondaryText, marginTop: -6 }]}>{taskEditorHelperText}</Text>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, overflow: 'visible' }]}>
                        <Text style={[styles.sectionHeaderText, { color: tc.secondaryText }]}>{taskEditorPresetLabel}</Text>
                        <View style={styles.taskEditorPresetRow}>
                            {taskEditorPresetOptions.map((option) => {
                                const selected = activeTaskEditorPreset === option.id;
                                return (
                                    <TouchableOpacity
                                        key={option.id}
                                        style={[
                                            styles.taskEditorPresetButton,
                                            {
                                                backgroundColor: selected ? tc.filterBg : 'transparent',
                                                borderColor: selected ? tc.tint : tc.border,
                                            },
                                        ]}
                                        onPress={() => applyTaskEditorPreset(option.id)}
                                    >
                                        <Text
                                            style={[
                                                styles.taskEditorPresetButtonText,
                                                { color: selected ? tc.tint : tc.secondaryText },
                                            ]}
                                        >
                                            {option.label}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                        {activeTaskEditorPreset === 'custom' && (
                            <Text style={[styles.settingDescription, { color: tc.secondaryText, paddingHorizontal: 16, paddingBottom: 16 }]}>
                                {taskEditorCustomLabel}
                            </Text>
                        )}
                    </View>

                    {fieldGroups.map((group) => {
                        const groupOrder = taskEditorOrder.filter((id) => group.fields.includes(id));
                        if (groupOrder.length === 0) return null;
                        const expanded = taskEditorExpandedSections[group.id];
                        return (
                            <View
                                key={group.id}
                                style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}
                            >
                                <TouchableOpacity
                                    style={styles.taskEditorSectionHeaderRow}
                                    onPress={() => toggleTaskEditorSectionExpanded(group.id)}
                                    activeOpacity={0.8}
                                >
                                    <View style={styles.taskEditorSectionHeaderMain}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{group.title}</Text>
                                        <View style={[styles.taskEditorSectionCountBadge, { backgroundColor: tc.filterBg }]}>
                                            <Text style={[styles.taskEditorSectionCountText, { color: tc.tint }]}>
                                                {groupOrder.length}
                                            </Text>
                                        </View>
                                    </View>
                                    <Ionicons
                                        name={expanded ? 'chevron-up' : 'chevron-down'}
                                        size={18}
                                        color={tc.secondaryText}
                                    />
                                </TouchableOpacity>
                                {expanded && (
                                    <>
                                        {group.id !== 'basic' && (
                                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                                <View style={styles.settingInfo}>
                                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                                        {resolvedTaskEditorDefaultOpenLabel}
                                                    </Text>
                                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                        {taskEditorKeepOpenLabel}
                                                    </Text>
                                                </View>
                                                <Switch
                                                    value={taskEditorSectionOpen[group.id]}
                                                    onValueChange={(value) => updateSectionOpenDefault(
                                                        group.id as Exclude<TaskEditorSectionId, 'basic'>,
                                                        value
                                                    )}
                                                    trackColor={{ false: '#767577', true: '#3B82F6' }}
                                                />
                                            </View>
                                        )}
                                        {groupOrder.map((fieldId, index) => (
                                            <TaskEditorFieldRow
                                                key={fieldId}
                                                fieldId={fieldId}
                                                isFirst={index === 0}
                                                showTopBorder={group.id !== 'basic' && index === 0}
                                            />
                                        ))}
                                    </>
                                )}
                            </View>
                        );
                    })}

                    <TouchableOpacity
                        style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}
                        onPress={resetToDefault}
                    >
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.resetToDefault')}</Text>
                        </View>
                    </TouchableOpacity>
                </ScrollView>

                <Modal
                    visible={Boolean(selectedFieldId)}
                    transparent
                    animationType="slide"
                    onRequestClose={closeTaskEditorFieldSheet}
                >
                    <View style={styles.taskEditorSheetOverlay}>
                        <Pressable style={StyleSheet.absoluteFill} onPress={closeTaskEditorFieldSheet} />
                        <View
                            style={[
                                styles.taskEditorSheetCard,
                                {
                                    backgroundColor: tc.cardBg,
                                    borderColor: tc.border,
                                    paddingBottom: 16 + Math.max(insets.bottom, 8),
                                },
                            ]}
                        >
                            <View style={[styles.taskEditorSheetHandle, { backgroundColor: tc.border }]} />
                            {selectedFieldId && (
                                <>
                                    <View style={styles.settingRowColumn}>
                                        <Text style={[styles.pickerTitle, { color: tc.text, marginBottom: 4 }]}>
                                            {fieldLabel(selectedFieldId)}
                                        </Text>
                                        {selectedFieldGroup && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {selectedFieldGroup.title}
                                            </Text>
                                        )}
                                    </View>

                                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: tc.text }]}>{showInEditorLabel}</Text>
                                        </View>
                                        <Switch
                                            value={selectedFieldVisible}
                                            onValueChange={() => toggleFieldVisibility(selectedFieldId!)}
                                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                                        />
                                    </View>

                                    {selectedFieldSectionable && (
                                        <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                            <Text style={[styles.settingLabel, { color: tc.text }]}>{taskEditorMoveSectionLabel}</Text>
                                            <View style={styles.taskEditorSectionChips}>
                                                {TASK_EDITOR_SECTION_ORDER.map((sectionId) => {
                                                    const selected = taskEditorSections[selectedFieldId!] === sectionId;
                                                    return (
                                                        <TouchableOpacity
                                                            key={sectionId}
                                                            style={[
                                                                styles.taskEditorSectionChip,
                                                                {
                                                                    borderColor: selected ? tc.tint : tc.border,
                                                                    backgroundColor: selected ? tc.filterBg : 'transparent',
                                                                },
                                                            ]}
                                                            onPress={() => updateFieldSection(selectedFieldId!, sectionId)}
                                                        >
                                                            <Text
                                                                style={[
                                                                    styles.taskEditorSectionChipText,
                                                                    { color: selected ? tc.tint : tc.secondaryText },
                                                                ]}
                                                            >
                                                                {sectionLabel(sectionId)}
                                                            </Text>
                                                        </TouchableOpacity>
                                                    );
                                                })}
                                            </View>
                                        </View>
                                    )}

                                    <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{taskEditorOrderLabel}</Text>
                                        <View style={styles.taskEditorSheetActions}>
                                            <TouchableOpacity
                                                style={[
                                                    styles.taskEditorSheetActionButton,
                                                    {
                                                        borderColor: tc.border,
                                                        backgroundColor: tc.filterBg,
                                                    },
                                                    selectedFieldIndex <= 0 && styles.taskEditorSheetActionDisabled,
                                                ]}
                                                onPress={() => moveOrderInGroup(selectedFieldId!, -1, selectedFieldGroupFields)}
                                                disabled={selectedFieldIndex <= 0}
                                            >
                                                <Ionicons name="arrow-up" size={16} color={selectedFieldIndex <= 0 ? tc.secondaryText : tc.text} />
                                                <Text style={[styles.taskEditorSheetActionText, { color: selectedFieldIndex <= 0 ? tc.secondaryText : tc.text }]}>
                                                    {moveUpLabel}
                                                </Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={[
                                                    styles.taskEditorSheetActionButton,
                                                    {
                                                        borderColor: tc.border,
                                                        backgroundColor: tc.filterBg,
                                                    },
                                                    selectedFieldIndex >= selectedFieldGroupOrder.length - 1 && styles.taskEditorSheetActionDisabled,
                                                ]}
                                                onPress={() => moveOrderInGroup(selectedFieldId!, 1, selectedFieldGroupFields)}
                                                disabled={selectedFieldIndex >= selectedFieldGroupOrder.length - 1}
                                            >
                                                <Ionicons
                                                    name="arrow-down"
                                                    size={16}
                                                    color={selectedFieldIndex >= selectedFieldGroupOrder.length - 1 ? tc.secondaryText : tc.text}
                                                />
                                                <Text
                                                    style={[
                                                        styles.taskEditorSheetActionText,
                                                        {
                                                            color: selectedFieldIndex >= selectedFieldGroupOrder.length - 1
                                                                ? tc.secondaryText
                                                                : tc.text,
                                                        },
                                                    ]}
                                                >
                                                    {moveDownLabel}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>

                                    <TouchableOpacity
                                        style={[
                                            styles.taskEditorSheetDoneButton,
                                            { backgroundColor: tc.tint },
                                        ]}
                                        onPress={closeTaskEditorFieldSheet}
                                    >
                                        <Text style={styles.taskEditorSheetDoneButtonText}>{doneLabel}</Text>
                                    </TouchableOpacity>
                                </>
                            )}
                        </View>
                    </View>
                </Modal>
            </SafeAreaView>
        );
    }

    // ============ CALENDAR SCREEN ============
    if (currentScreen === 'calendar') {
        const persistSystemCalendarState = async (next: {
            enabled?: boolean;
            selectAll?: boolean;
            selectedCalendarIds?: string[];
        }) => {
            const payload = {
                enabled: next.enabled ?? systemCalendarEnabled,
                selectAll: next.selectAll ?? systemCalendarSelectAll,
                selectedCalendarIds: next.selectedCalendarIds ?? systemCalendarSelectedIds,
            };
            setSystemCalendarEnabled(payload.enabled);
            setSystemCalendarSelectAll(payload.selectAll);
            setSystemCalendarSelectedIds(payload.selectedCalendarIds);
            await saveSystemCalendarSettings(payload);
        };

        const handleToggleSystemCalendarEnabled = async (enabled: boolean) => {
            await persistSystemCalendarState({ enabled });
            if (enabled && systemCalendarPermission !== 'granted') {
                await loadSystemCalendarState(true);
            }
        };

        const handleRequestSystemCalendarAccess = async () => {
            await loadSystemCalendarState(true);
        };

        const handleToggleSystemCalendarSelection = async (calendarId: string, enabled: boolean) => {
            const allIds = systemCalendars.map((calendar) => calendar.id);
            if (allIds.length === 0) return;

            const currentSelection = systemCalendarSelectAll
                ? allIds
                : Array.from(new Set(systemCalendarSelectedIds.filter((id) => allIds.includes(id))));
            const nextSelection = enabled
                ? Array.from(new Set([...currentSelection, calendarId]))
                : currentSelection.filter((id) => id !== calendarId);
            const selectAll = nextSelection.length === allIds.length;

            await persistSystemCalendarState({
                selectAll,
                selectedCalendarIds: selectAll ? [] : nextSelection,
            });
        };

        const selectedSystemCalendarSet = new Set(systemCalendarSelectedIds);

        const handleAddCalendar = async () => {
            const url = newCalendarUrl.trim();
            if (!url) return;

            const name = (newCalendarName.trim() || localize('Calendar', '日历')).trim();
            const next: ExternalCalendarSubscription[] = [
                ...externalCalendars,
                { id: generateUUID(), name, url, enabled: true },
            ];

            setExternalCalendars(next);
            setNewCalendarName('');
            setNewCalendarUrl('');
            await saveExternalCalendars(next);
            await updateSettings({ externalCalendars: next });
        };

        const handleToggleCalendar = async (id: string, enabled: boolean) => {
            const next = externalCalendars.map((c) => (c.id === id ? { ...c, enabled } : c));
            setExternalCalendars(next);
            await saveExternalCalendars(next);
            await updateSettings({ externalCalendars: next });
        };

        const handleRemoveCalendar = async (id: string) => {
            const next = externalCalendars.filter((c) => c.id !== id);
            setExternalCalendars(next);
            await saveExternalCalendars(next);
            await updateSettings({ externalCalendars: next });
        };

        const handleTestFetch = async () => {
            try {
                const now = new Date();
                const rangeStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
                const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
                const { events } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                Alert.alert(
                    localize('Success', '成功'),
                    isChineseLanguage ? `已加载 ${events.length} 个日程` : translateText(`Loaded ${events.length} events`, language)
                );
            } catch (error) {
                logSettingsError(error);
                Alert.alert(localize('Error', '错误'), localize('Failed to load events', '加载失败'));
            }
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.calendar')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>
                        {t('settings.calendarDesc')}
                    </Text>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.deviceCalendars')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.deviceCalendarsDesc')}</Text>
                            </View>
                            <Switch
                                value={systemCalendarEnabled}
                                onValueChange={handleToggleSystemCalendarEnabled}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>

                        {systemCalendarEnabled && (
                            <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
                                {systemCalendarPermission !== 'granted' ? (
                                    <View>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {systemCalendarPermission === 'denied'
                                                ? t('settings.calendarAccessDenied')
                                                : t('settings.calendarAccessRequired')}
                                        </Text>
                                        <TouchableOpacity
                                            style={[
                                                styles.backendOption,
                                                { borderColor: tc.border, backgroundColor: tc.filterBg, marginTop: 12, alignSelf: 'flex-start' },
                                            ]}
                                            onPress={handleRequestSystemCalendarAccess}
                                        >
                                            <Text style={[styles.backendOptionText, { color: tc.text }]}>
                                                {t('settings.grantCalendarAccess')}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                ) : isSystemCalendarLoading ? (
                                    <View style={{ paddingVertical: 8 }}>
                                        <ActivityIndicator color={tc.tint} />
                                    </View>
                                ) : systemCalendars.length === 0 ? (
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.noDeviceCalendars')}
                                    </Text>
                                ) : (
                                    <View>
                                        {systemCalendars.map((calendar, idx) => {
                                            const selected = systemCalendarSelectAll || selectedSystemCalendarSet.has(calendar.id);
                                            return (
                                                <View
                                                    key={calendar.id}
                                                    style={[
                                                        styles.settingRow,
                                                        idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border },
                                                    ]}
                                                >
                                                    <View style={styles.settingInfo}>
                                                        <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                                            {calendar.name}
                                                        </Text>
                                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                                            {t('settings.deviceCalendar')}
                                                        </Text>
                                                    </View>
                                                    <Switch
                                                        value={selected}
                                                        onValueChange={(value) => handleToggleSystemCalendarSelection(calendar.id, value)}
                                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                                    />
                                                </View>
                                            );
                                        })}
                                    </View>
                                )}
                            </View>
                        )}
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
                        <View style={styles.inputGroup}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.externalCalendarName')}</Text>
                            <TextInput
                                style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                placeholder={localize('Optional', '可选')}
                                placeholderTextColor={tc.secondaryText}
                                value={newCalendarName}
                                onChangeText={setNewCalendarName}
                            />

                            <Text style={[styles.settingLabel, { color: tc.text, marginTop: 12 }]}>{t('settings.externalCalendarUrl')}</Text>
                            <TextInput
                                style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                placeholder={t('settings.externalCalendarUrlPlaceholder')}
                                placeholderTextColor={tc.secondaryText}
                                autoCapitalize="none"
                                autoCorrect={false}
                                value={newCalendarUrl}
                                onChangeText={setNewCalendarUrl}
                            />

                            <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: newCalendarUrl.trim() ? tc.tint : tc.filterBg },
                                    ]}
                                    onPress={handleAddCalendar}
                                    disabled={!newCalendarUrl.trim()}
                                >
                                    <Text style={[styles.backendOptionText, { color: newCalendarUrl.trim() ? '#FFFFFF' : tc.secondaryText }]}>
                                        {t('settings.externalCalendarAdd')}
                                    </Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.backendOption, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={handleTestFetch}
                                >
                                    <Text style={[styles.backendOptionText, { color: tc.text }]}>
                                        {localize('Test', '测试')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>

                    {externalCalendars.length > 0 && (
                        <View style={{ marginTop: 16 }}>
                            <Text style={[styles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.externalCalendars')}</Text>
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                                {externalCalendars.map((calendar, idx) => (
                                    <View
                                        key={calendar.id}
                                        style={[
                                            styles.settingRow,
                                            idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border },
                                        ]}
                                    >
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                                {calendar.name}
                                            </Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                                {maskCalendarUrl(calendar.url)}
                                            </Text>
                                        </View>
                                        <View style={{ alignItems: 'flex-end', gap: 10 }}>
                                            <Switch
                                                value={calendar.enabled}
                                                onValueChange={(value) => handleToggleCalendar(calendar.id, value)}
                                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                                            />
                                            <TouchableOpacity onPress={() => handleRemoveCalendar(calendar.id)}>
                                                <Text style={{ color: '#EF4444', fontSize: 13, fontWeight: '600' }}>
                                                    {t('settings.externalCalendarRemove')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                ))}
                            </View>
                        </View>
                    )}
                </ScrollView>
            </SafeAreaView>
        );
    }

    if (currentScreen === 'advanced') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.advanced')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        <MenuItem title={t('settings.ai')} onPress={() => pushSettingsScreen('ai')} />
                        <MenuItem title={t('settings.calendar')} onPress={() => pushSettingsScreen('calendar')} />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ SYNC SCREEN ============
    if (currentScreen === 'sync') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.dataSync')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                        <View style={styles.settingRowColumn}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncBackend')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {syncBackend === 'off'
                                        ? t('settings.syncBackendOff')
                                        : syncBackend === 'cloudkit'
                                            ? 'iCloud (CloudKit)'
                                            : syncBackend === 'webdav'
                                                ? t('settings.syncBackendWebdav')
                                                : syncBackend === 'cloud'
                                                    ? t('settings.syncBackendCloud')
                                                    : t('settings.syncBackendFile')}
                                </Text>
                            </View>
                            <View style={[styles.backendToggle, { marginTop: 8, width: '100%' }]}>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: syncBackend === 'off' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, 'off').catch(logSettingsError);
                                        setSyncBackend('off');
                                        resetSyncStatusForBackendSwitch();
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: syncBackend === 'off' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.syncBackendOff')}
                                    </Text>
                                </TouchableOpacity>
                                {supportsNativeICloudSync && (
                                    <TouchableOpacity
                                        style={[
                                            styles.backendOption,
                                            { borderColor: tc.border, backgroundColor: syncBackend === 'cloudkit' ? tc.filterBg : 'transparent' },
                                        ]}
                                        onPress={() => {
                                            AsyncStorage.setItem(SYNC_BACKEND_KEY, 'cloudkit').catch(logSettingsError);
                                            setSyncBackend('cloudkit');
                                            resetSyncStatusForBackendSwitch();
                                        }}
                                    >
                                        <Text style={[styles.backendOptionText, { color: syncBackend === 'cloudkit' ? tc.tint : tc.secondaryText }]}>
                                            iCloud
                                        </Text>
                                    </TouchableOpacity>
                                )}
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: syncBackend === 'file' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file').catch(logSettingsError);
                                        setSyncBackend('file');
                                        resetSyncStatusForBackendSwitch();
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: syncBackend === 'file' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.syncBackendFile')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: syncBackend === 'webdav' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, 'webdav').catch(logSettingsError);
                                        setSyncBackend('webdav');
                                        resetSyncStatusForBackendSwitch();
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: syncBackend === 'webdav' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.syncBackendWebdav')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: syncBackend === 'cloud' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, 'cloud').catch(logSettingsError);
                                        setSyncBackend('cloud');
                                        resetSyncStatusForBackendSwitch();
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: syncBackend === 'cloud' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.syncBackendCloud')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>

                    {syncBackend === 'off' && (
                        <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.helpTitle, { color: tc.text }]}>
                                {t('settings.syncOff')}
                            </Text>
                            <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                                {t('settings.syncOffDesc')}
                            </Text>
                        </View>
                    )}

                    {syncBackend === 'cloudkit' && supportsNativeICloudSync && (
                        <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.helpTitle, { color: tc.text }]}>
                                iCloud Sync
                            </Text>
                            <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                                Syncs your tasks, projects, and areas across Apple devices using CloudKit.
                                No setup required — just sign in to iCloud on your devices.
                            </Text>
                            <Text style={[styles.helpText, { color: tc.secondaryText, marginTop: 8 }]}>
                                Changes sync automatically via periodic polling and push notifications when available.
                            </Text>
                        </View>
                    )}

                    {syncBackend === 'file' && (
                        <>
                            {/* Step-by-step instructions */}
                            <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                <Text style={[styles.helpTitle, { color: tc.text }]}>
                                    {localize('How to Sync', '如何同步')}
                                </Text>
                                <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                                    {Platform.OS === 'ios' ? t('settings.fileSyncHowToIos') : t('settings.fileSyncHowToAndroid')}
                                </Text>
                                <Text style={[styles.helpText, { color: tc.secondaryText, marginTop: 8 }]}>
                                    {t('settings.fileSyncTip')}
                                </Text>
                            </View>

                            <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>
                                {t('settings.syncSettings')}
                            </Text>
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                                {/* Sync File Path */}
                                <View style={styles.settingRow}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>
                                            {t('settings.syncFolderLocation')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                            {syncPath ? syncPath.split('/').pop() : t('common.notSet')}
                                        </Text>
                                    </View>
                                    <TouchableOpacity onPress={handleSetSyncPath}>
                                        <Text style={styles.linkText}>{t('settings.selectFolder')}</Text>
                                    </TouchableOpacity>
                                </View>

                                {/* Sync Now */}
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={handleSync}
                                    disabled={isSyncing || !syncPath}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: syncPath ? '#3B82F6' : tc.secondaryText }]}>
                                            {t('settings.syncNow')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.syncReadMergeFolder')}
                                        </Text>
                                    </View>
                                    {isSyncing && <ActivityIndicator size="small" color="#3B82F6" />}
                                </TouchableOpacity>

                                {/* Last Sync Status */}
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>
                                            {t('settings.lastSync')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {settings.lastSyncAt
                                                ? new Date(settings.lastSyncAt).toLocaleString()
                                                : t('settings.lastSyncNever')}
                                            {settings.lastSyncStatus === 'error' && t('settings.syncStatusFailedSuffix')}
                                            {settings.lastSyncStatus === 'conflict' && t('settings.syncStatusConflictsSuffix')}
                                        </Text>
                                        {lastSyncStats && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncConflicts')}: {syncConflictCount}
                                            </Text>
                                        )}
                                        {lastSyncStats && maxClockSkewMs > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncSkew')}: {formatClockSkew(maxClockSkewMs)}
                                            </Text>
                                        )}
                                        {lastSyncStats && timestampAdjustments > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncAdjusted')}: {timestampAdjustments}
                                            </Text>
                                        )}
                                        {lastSyncStats && conflictIds.length > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncConflictIds')}: {conflictIds.join(', ')}
                                            </Text>
                                        )}
                                        {settings.lastSyncStatus === 'error' && settings.lastSyncError && (
                                            <Text style={[styles.settingDescription, { color: '#EF4444' }]}>
                                                {settings.lastSyncError}
                                            </Text>
                                        )}
                                        {renderSyncHistory()}
                                    </View>
                                </View>
                            </View>
                        </>
                    )}

                    {syncBackend === 'webdav' && (
                        <>
                            <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>
                                {t('settings.syncBackendWebdav')}
                            </Text>
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                                <View style={styles.inputGroup}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavUrl')}</Text>
                                    <TextInput
                                        value={webdavUrl}
                                        onChangeText={setWebdavUrl}
                                        placeholder={t('settings.webdavUrlPlaceholder')}
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.webdavHint')}
                                    </Text>
                                    {webdavUrlError && (
                                        <Text style={[styles.settingDescription, { color: '#EF4444' }]}>
                                            {t('settings.invalidUrlHttp')}
                                        </Text>
                                    )}
                                </View>

                                <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavUsername')}</Text>
                                    <TextInput
                                        value={webdavUsername}
                                        onChangeText={setWebdavUsername}
                                        placeholder={t('settings.webdavUsernamePlaceholder')}
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                </View>

                                <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavPassword')}</Text>
                                    <TextInput
                                        value={webdavPassword}
                                        onChangeText={setWebdavPassword}
                                        placeholder="••••••••"
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        secureTextEntry
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                </View>
                                {Platform.OS === 'web' && (
                                    <Text style={[styles.settingDescription, { color: '#F59E0B' }]}>
                                        {localize(
                                            'Web warning: WebDAV passwords are stored in browser storage. Use only on trusted devices.',
                                            'Web 提示：WebDAV 密码会保存在浏览器本地存储中，请仅在可信设备使用。'
                                        )}
                                    </Text>
                                )}

                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => {
                                        if (webdavUrlError || !webdavUrl.trim()) {
                                            Alert.alert(
                                                localize('Invalid URL', '地址无效'),
                                                localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。')
                                            );
                                            return;
                                        }
                                        AsyncStorage.multiSet([
                                            [SYNC_BACKEND_KEY, 'webdav'],
                                            [WEBDAV_URL_KEY, webdavUrl.trim()],
                                            [WEBDAV_USERNAME_KEY, webdavUsername.trim()],
                                            [WEBDAV_PASSWORD_KEY, webdavPassword],
                                        ]).then(() => {
                                            resetSyncStatusForBackendSwitch();
                                            Alert.alert(localize('Success', '成功'), t('settings.webdavSave'));
                                        }).catch(logSettingsError);
                                    }}
                                    disabled={webdavUrlError || !webdavUrl.trim()}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: webdavUrlError || !webdavUrl.trim() ? tc.secondaryText : tc.tint }]}>
                                            {t('settings.webdavSave')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.webdavUrl')}
                                        </Text>
                                    </View>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={handleSync}
                                    disabled={isSyncing || !webdavUrl.trim() || webdavUrlError}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: webdavUrl.trim() && !webdavUrlError ? tc.tint : tc.secondaryText }]}>
                                            {t('settings.syncNow')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.syncReadMergeWebdav')}
                                        </Text>
                                    </View>
                                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => handleTestConnection('webdav')}
                                    disabled={isSyncing || isTestingConnection || !webdavUrl.trim() || webdavUrlError}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('settings.webdavTestAccessibility')}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: webdavUrl.trim() && !webdavUrlError ? tc.tint : tc.secondaryText }]}>
                                            {t('settings.testConnection')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.webdavTestHint')}
                                        </Text>
                                    </View>
                                    {isTestingConnection && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>

                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>
                                            {t('settings.lastSync')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {settings.lastSyncAt
                                                ? new Date(settings.lastSyncAt).toLocaleString()
                                                : t('settings.lastSyncNever')}
                                            {settings.lastSyncStatus === 'error' && t('settings.syncStatusFailedSuffix')}
                                            {settings.lastSyncStatus === 'conflict' && t('settings.syncStatusConflictsSuffix')}
                                        </Text>
                                        {lastSyncStats && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncConflicts')}: {syncConflictCount}
                                            </Text>
                                        )}
                                        {lastSyncStats && maxClockSkewMs > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncSkew')}: {formatClockSkew(maxClockSkewMs)}
                                            </Text>
                                        )}
                                        {lastSyncStats && timestampAdjustments > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncAdjusted')}: {timestampAdjustments}
                                            </Text>
                                        )}
                                        {lastSyncStats && conflictIds.length > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncConflictIds')}: {conflictIds.join(', ')}
                                            </Text>
                                        )}
                                        {settings.lastSyncStatus === 'error' && settings.lastSyncError && (
                                            <Text style={[styles.settingDescription, { color: '#EF4444' }]}>
                                                {settings.lastSyncError}
                                            </Text>
                                        )}
                                        {renderSyncHistory()}
                                    </View>
                                </View>
                            </View>
                        </>
                    )}

                    {syncBackend === 'cloud' && (
                        <>
                            <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>
                                {t('settings.syncBackendCloud')}
                            </Text>
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                                <View style={[styles.settingRowColumn]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                        {t('settings.cloudProvider')}
                                    </Text>
                                    <View style={[styles.backendToggle, { marginTop: 8, width: '100%' }]}>
                                        <TouchableOpacity
                                            style={[
                                                styles.backendOption,
                                                {
                                                    borderColor: tc.border,
                                                    backgroundColor: cloudProvider === 'selfhosted' ? tc.filterBg : 'transparent',
                                                },
                                            ]}
                                            onPress={() => {
                                                setCloudProvider('selfhosted');
                                                AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted').catch(logSettingsError);
                                                resetSyncStatusForBackendSwitch();
                                            }}
                                        >
                                            <Text style={[styles.backendOptionText, { color: cloudProvider === 'selfhosted' ? tc.tint : tc.secondaryText }]}>
                                                {t('settings.cloudProviderSelfHosted')}
                                            </Text>
                                        </TouchableOpacity>
                                        {!isFossBuild && (
                                            <TouchableOpacity
                                                style={[
                                                    styles.backendOption,
                                                    {
                                                        borderColor: tc.border,
                                                        backgroundColor: cloudProvider === 'dropbox' ? tc.filterBg : 'transparent',
                                                    },
                                                ]}
                                                onPress={() => {
                                                    setCloudProvider('dropbox');
                                                    AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'dropbox').catch(logSettingsError);
                                                    resetSyncStatusForBackendSwitch();
                                                }}
                                            >
                                                <Text style={[styles.backendOptionText, { color: cloudProvider === 'dropbox' ? tc.tint : tc.secondaryText }]}>
                                                    Dropbox
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                </View>
                            </View>

                            {cloudProvider === 'selfhosted' || isFossBuild ? (
                                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                                    <View style={styles.inputGroup}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudUrl')}</Text>
                                        <TextInput
                                            value={cloudUrl}
                                            onChangeText={setCloudUrl}
                                            placeholder={t('settings.cloudUrlPlaceholder')}
                                            placeholderTextColor={tc.secondaryText}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                        />
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.cloudHint')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.cloudBaseUrlHint')}
                                        </Text>
                                        {cloudUrlError && (
                                            <Text style={[styles.settingDescription, { color: '#EF4444' }]}>
                                                {t('settings.invalidUrlHttp')}
                                            </Text>
                                        )}
                                    </View>

                                    <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudToken')}</Text>
                                        <TextInput
                                            value={cloudToken}
                                            onChangeText={setCloudToken}
                                            placeholder="••••••••"
                                            placeholderTextColor={tc.secondaryText}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            secureTextEntry
                                            style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                        />
                                    </View>

                                    <TouchableOpacity
                                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                        onPress={() => {
                                            if (cloudUrlError || !cloudUrl.trim()) {
                                                Alert.alert(
                                                    localize('Invalid URL', '地址无效'),
                                                    localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。')
                                                );
                                                return;
                                            }
                                            AsyncStorage.multiSet([
                                                [SYNC_BACKEND_KEY, 'cloud'],
                                                [CLOUD_PROVIDER_KEY, 'selfhosted'],
                                                [CLOUD_URL_KEY, cloudUrl.trim()],
                                                [CLOUD_TOKEN_KEY, cloudToken],
                                            ]).then(() => {
                                                resetSyncStatusForBackendSwitch();
                                                Alert.alert(localize('Success', '成功'), t('settings.cloudSave'));
                                            }).catch(logSettingsError);
                                        }}
                                        disabled={cloudUrlError || !cloudUrl.trim()}
                                    >
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: cloudUrlError || !cloudUrl.trim() ? tc.secondaryText : tc.tint }]}>
                                                {t('settings.cloudSave')}
                                            </Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.cloudUrl')}
                                            </Text>
                                        </View>
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                        onPress={handleSync}
                                        disabled={isSyncing || !cloudUrl.trim() || cloudUrlError}
                                    >
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: cloudUrl.trim() && !cloudUrlError ? tc.tint : tc.secondaryText }]}>
                                                {t('settings.syncNow')}
                                            </Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.syncReadMergeSelfHosted')}
                                            </Text>
                                        </View>
                                        {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                        onPress={() => handleTestConnection('cloud')}
                                        disabled={isSyncing || isTestingConnection || !cloudUrl.trim() || cloudUrlError}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('settings.cloudTestAccessibility')}
                                    >
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: cloudUrl.trim() && !cloudUrlError ? tc.tint : tc.secondaryText }]}>
                                                {t('settings.testConnection')}
                                            </Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.cloudTestHint')}
                                            </Text>
                                        </View>
                                        {isTestingConnection && <ActivityIndicator size="small" color={tc.tint} />}
                                    </TouchableOpacity>
                                </View>
                            ) : (
                                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                                    <View style={styles.settingRowColumn}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>
                                            {localize('Dropbox account', 'Dropbox 账号')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 6 }]}>
                                            {localize(
                                                'OAuth with Dropbox App Folder access. Mindwtr syncs /Apps/Mindwtr/data.json and /Apps/Mindwtr/attachments/* in your Dropbox.',
                                                '使用 Dropbox OAuth（应用文件夹权限）。Mindwtr 会同步 Dropbox 中 /Apps/Mindwtr/data.json 与 /Apps/Mindwtr/attachments/*。'
                                            )}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 6 }]}>
                                            {localize('Redirect URI', '回调地址')}: {getDropboxRedirectUri()}
                                        </Text>
                                        {!dropboxConfigured && (
                                            <Text style={[styles.settingDescription, { color: '#EF4444', marginTop: 8 }]}>
                                                {localize('Dropbox app key is not configured for this build.', '当前构建未配置 Dropbox App Key。')}
                                            </Text>
                                        )}
                                        {isExpoGo && (
                                            <Text style={[styles.settingDescription, { color: '#EF4444', marginTop: 8 }]}>
                                                {localize(
                                                    'Expo Go is not supported for Dropbox OAuth. Use a development/release build.',
                                                    'Expo Go 不支持 Dropbox OAuth。请使用开发版或正式版应用。'
                                                )}
                                            </Text>
                                        )}
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                            {dropboxConnected
                                                ? localize('Status: Connected', '状态：已连接')
                                                : localize('Status: Not connected', '状态：未连接')}
                                        </Text>
                                    </View>

                                    <TouchableOpacity
                                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                        onPress={dropboxConnected ? handleDisconnectDropbox : handleConnectDropbox}
                                        disabled={dropboxBusy || !dropboxConfigured || isExpoGo}
                                    >
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: dropboxConfigured && !isExpoGo ? tc.tint : tc.secondaryText }]}>
                                                {dropboxConnected
                                                    ? localize('Disconnect Dropbox', '断开 Dropbox')
                                                    : localize('Connect Dropbox', '连接 Dropbox')}
                                            </Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {isExpoGo
                                                    ? localize(
                                                        'Requires development/release build (Expo Go unsupported).',
                                                        '需要开发版/正式版应用（Expo Go 不支持）。'
                                                    )
                                                    : dropboxConnected
                                                    ? localize('Revoke app token and remove local auth.', '撤销应用令牌并移除本地授权。')
                                                    : localize('Open Dropbox OAuth sign-in in browser.', '在浏览器中打开 Dropbox OAuth 登录。')}
                                            </Text>
                                        </View>
                                        {dropboxBusy && <ActivityIndicator size="small" color={tc.tint} />}
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                        onPress={handleTestDropboxConnection}
                                        disabled={isTestingConnection || !dropboxConfigured || !dropboxConnected}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('settings.dropboxTestAccessibility')}
                                    >
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: dropboxConnected ? tc.tint : tc.secondaryText }]}>
                                                {t('settings.testConnection')}
                                            </Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.dropboxTestHint')}
                                            </Text>
                                        </View>
                                        {isTestingConnection && <ActivityIndicator size="small" color={tc.tint} />}
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                        onPress={handleSync}
                                        disabled={isSyncing || !dropboxConfigured || !dropboxConnected}
                                    >
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: dropboxConnected ? tc.tint : tc.secondaryText }]}>
                                                {t('settings.syncNow')}
                                            </Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {localize('Read and merge Dropbox data.', '读取并合并 Dropbox 数据。')}
                                            </Text>
                                        </View>
                                        {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                                    </TouchableOpacity>
                                </View>
                            )}

                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                                <View style={styles.settingRow}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>
                                            {t('settings.lastSync')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {settings.lastSyncAt
                                                ? new Date(settings.lastSyncAt).toLocaleString()
                                                : t('settings.lastSyncNever')}
                                            {settings.lastSyncStatus === 'error' && t('settings.syncStatusFailedSuffix')}
                                            {settings.lastSyncStatus === 'conflict' && t('settings.syncStatusConflictsSuffix')}
                                        </Text>
                                        {lastSyncStats && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncConflicts')}: {syncConflictCount}
                                            </Text>
                                        )}
                                        {lastSyncStats && maxClockSkewMs > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncSkew')}: {formatClockSkew(maxClockSkewMs)}
                                            </Text>
                                        )}
                                        {lastSyncStats && timestampAdjustments > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncAdjusted')}: {timestampAdjustments}
                                            </Text>
                                        )}
                                        {lastSyncStats && conflictIds.length > 0 && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.lastSyncConflictIds')}: {conflictIds.join(', ')}
                                            </Text>
                                        )}
                                        {settings.lastSyncStatus === 'error' && settings.lastSyncError && (
                                            <Text style={[styles.settingDescription, { color: '#EF4444' }]}>
                                                {settings.lastSyncError}
                                            </Text>
                                        )}
                                        {renderSyncHistory()}
                                    </View>
                                </View>
                            </View>
                        </>
                    )}


                    {/* Backup Section */}
                    <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>
                        {t('settings.backup')}
                    </Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <TouchableOpacity
                            style={styles.settingRow}
                            onPress={handleBackup}
                            disabled={isSyncing}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: '#3B82F6' }]}>
                                    {t('settings.exportBackup')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.saveToSyncFolder')}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
                        <TouchableOpacity
                            style={styles.settingRow}
                            onPress={() => setSyncOptionsOpen((prev) => !prev)}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferences')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.syncPreferencesDesc')}
                                </Text>
                            </View>
                            <Text style={[styles.chevron, { color: tc.secondaryText }]}>
                                {syncOptionsOpen ? '▾' : '▸'}
                            </Text>
                        </TouchableOpacity>
                        {syncOptionsOpen && (
                            <>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceAppearance')}</Text>
                                    </View>
                                    <Switch
                                        value={syncAppearanceEnabled}
                                        onValueChange={(value) => updateSyncPreferences({ appearance: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceLanguage')}</Text>
                                    </View>
                                    <Switch
                                        value={syncLanguageEnabled}
                                        onValueChange={(value) => updateSyncPreferences({ language: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceExternalCalendars')}</Text>
                                    </View>
                                    <Switch
                                        value={syncExternalCalendarsEnabled}
                                        onValueChange={(value) => updateSyncPreferences({ externalCalendars: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                                <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceAi')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.syncPreferenceAiHint')}
                                        </Text>
                                    </View>
                                    <Switch
                                        value={syncAiEnabled}
                                        onValueChange={(value) => updateSyncPreferences({ ai: value })}
                                        trackColor={{ false: '#767577', true: '#3B82F6' }}
                                    />
                                </View>
                            </>
                        )}
                    </View>

                    <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>
                        {t('settings.diagnostics')}
                    </Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.debugLogging')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.debugLoggingDesc')}
                                </Text>
                            </View>
                            <Switch
                                value={loggingEnabled}
                                onValueChange={toggleDebugLogging}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                        {loggingEnabled && (
                            <>
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={handleShareLog}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.shareLog')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.logFile')}
                                        </Text>
                                    </View>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={handleClearLog}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.secondaryText }]}>{t('settings.clearLog')}</Text>
                                    </View>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ ABOUT SCREEN ============
    if (currentScreen === 'about') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.about')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.version')}</Text>
                            <Text style={[styles.settingValue, { color: tc.secondaryText }]}>
                                {Constants.expoConfig?.version ?? '0.1.0'}
                            </Text>
                        </View>
                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => openLink('https://github.com/dongdongbh/Mindwtr/wiki')}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.documentation')}</Text>
                            <Text style={styles.linkText}>GitHub Wiki</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => openLink('https://ko-fi.com/dongdongbh')}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>
                                {t('settings.sponsorProject')}
                            </Text>
                            <Text style={styles.linkText}>Ko-fi</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => openLink('https://github.com/dongdongbh/Mindwtr')}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>GitHub</Text>
                            <Text style={styles.linkText}>Mindwtr</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => openLink('https://dongdongbh.tech')}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>
                                {t('settings.website')}
                            </Text>
                            <Text style={styles.linkText}>dongdongbh.tech</Text>
                        </TouchableOpacity>
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.license')}</Text>
                            <Text style={[styles.settingValue, { color: tc.secondaryText }]}>AGPL-3.0</Text>
                        </View>
                        {!isFossBuild && (
                            <TouchableOpacity
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                onPress={handleCheckUpdates}
                                disabled={isCheckingUpdate}
                            >
                                <Text style={[styles.settingLabel, { color: tc.text }]}>
                                    {t('settings.checkForUpdates')}
                                </Text>
                                {isCheckingUpdate ? (
                                    <ActivityIndicator size="small" color="#3B82F6" />
                                ) : (
                                    <Text style={styles.linkText}>
                                        {localize('Tap to check', '点击检查')}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        )}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ MAIN SETTINGS SCREEN ============
    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.menuCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
                    <MenuItem title={t('settings.general')} onPress={() => pushSettingsScreen('general')} />
                    <MenuItem title={t('settings.gtd')} onPress={() => pushSettingsScreen('gtd')} />
                    <MenuItem title={t('settings.manage')} onPress={() => pushSettingsScreen('manage')} />
                    <MenuItem title={t('settings.notifications')} onPress={() => pushSettingsScreen('notifications')} />
                    <MenuItem
                        title={t('settings.dataSync')}
                        onPress={() => pushSettingsScreen('sync')}
                        showIndicator={Boolean(syncBadgeColor)}
                        indicatorColor={syncBadgeColor}
                        indicatorAccessibilityLabel={syncBadgeAccessibilityLabel}
                    />
                    <MenuItem title={t('settings.advanced')} onPress={() => pushSettingsScreen('advanced')} />
                    <MenuItem title={t('settings.about')} onPress={() => pushSettingsScreen('about')} showIndicator={!isFossBuild && hasUpdateBadge} />
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    scrollView: { flex: 1 },
    scrollContent: { padding: 16 },
    topBar: {
        height: 52,
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 8,
    },
    topBarBackButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    topBarBackButtonHidden: {
        opacity: 0,
    },
    topBarTitle: {
        fontSize: 17,
        fontWeight: '700',
    },
    subHeader: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
    backButton: { fontSize: 16, fontWeight: '500' },
    subHeaderTitle: { fontSize: 18, fontWeight: '600' },
    description: { fontSize: 13, marginBottom: 12, paddingHorizontal: 4, lineHeight: 18 },
    sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8, marginLeft: 4 },
    menuCard: { borderRadius: 12, overflow: 'hidden' },
    menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1 },
    menuLabel: { fontSize: 17, fontWeight: '400' },
    chevron: { fontSize: 24, fontWeight: '300' },
    menuRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    updateDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' },
    settingCard: { borderRadius: 12, overflow: 'hidden' },
    settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
    settingRowColumn: { padding: 16 },
    sectionHeaderText: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: 16, marginTop: 12, marginBottom: 4 },
    taskEditorPresetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 16 },
    taskEditorPresetButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
    taskEditorPresetButtonText: { fontSize: 13, fontWeight: '700' },
    taskEditorSectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
    taskEditorSectionHeaderMain: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, marginRight: 12 },
    taskEditorSectionCountBadge: {
        minWidth: 26,
        height: 26,
        borderRadius: 13,
        paddingHorizontal: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    taskEditorSectionCountText: { fontSize: 12, fontWeight: '700' },
    taskEditorCompactRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
    taskEditorCompactRowBorder: { borderTopWidth: 1 },
    taskEditorVisibilityBadge: {
        width: 34,
        height: 34,
        borderRadius: 17,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    taskEditorSectionChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
    taskEditorSectionChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
    taskEditorSectionChipText: { fontSize: 12, fontWeight: '600' },
    taskEditorSheetOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.35)',
        justifyContent: 'flex-end',
    },
    taskEditorSheetCard: {
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        borderWidth: 1,
        overflow: 'hidden',
    },
    taskEditorSheetHandle: {
        width: 42,
        height: 5,
        borderRadius: 999,
        alignSelf: 'center',
        marginTop: 10,
        marginBottom: 2,
    },
    taskEditorSheetActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
    taskEditorSheetActionButton: {
        flex: 1,
        minHeight: 44,
        borderRadius: 12,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 12,
    },
    taskEditorSheetActionDisabled: { opacity: 0.45 },
    taskEditorSheetActionText: { fontSize: 14, fontWeight: '600' },
    taskEditorSheetDoneButton: {
        marginHorizontal: 16,
        marginTop: 16,
        borderRadius: 12,
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    taskEditorSheetDoneButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
    settingInfo: { flex: 1, marginRight: 16 },
    settingLabel: { fontSize: 16, fontWeight: '500' },
    settingDescription: { fontSize: 13, marginTop: 2 },
    settingValue: { fontSize: 16 },
    linkText: { fontSize: 16, color: '#3B82F6' },
    helpBox: { borderRadius: 12, padding: 16, marginBottom: 8, borderWidth: 1 },
    helpTitle: { fontSize: 15, fontWeight: '600', marginBottom: 8 },
    helpText: { fontSize: 13, lineHeight: 20 },
    backendToggle: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    backendOption: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
    backendOptionText: { fontSize: 13, fontWeight: '700' },
    dropdownButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1,
        borderRadius: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
        gap: 8,
    },
    dropdownValue: {
        flex: 1,
        fontSize: 13,
        fontWeight: '600',
    },
    dropdownChevron: {
        fontSize: 14,
        fontWeight: '600',
    },
    modelInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    modelTextInput: {
        flex: 1,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
    },
    modelSuggestButton: {
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    modelSuggestButtonText: {
        fontSize: 12,
        fontWeight: '600',
    },
    pickerOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'center',
        padding: 20,
    },
    pickerCard: {
        borderRadius: 16,
        borderWidth: 1,
        padding: 16,
        maxHeight: '70%',
    },
    pickerTitle: {
        fontSize: 16,
        fontWeight: '700',
        marginBottom: 12,
    },
    pickerList: {
        flexGrow: 0,
    },
    pickerListContent: {
        gap: 8,
    },
    pickerOption: {
        borderWidth: 1,
        borderRadius: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    pickerOptionText: {
        fontSize: 13,
        fontWeight: '600',
    },
    timePickerActions: {
        marginTop: 12,
        borderTopWidth: 1,
        paddingTop: 12,
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
    timePickerActionButton: {
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    timePickerActionText: {
        fontSize: 15,
        fontWeight: '600',
    },
    inputGroup: { padding: 16 },
    textInput: { marginTop: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
});
