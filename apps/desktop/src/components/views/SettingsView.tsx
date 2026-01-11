import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
    Bell,
    CalendarDays,
    Database,
    ExternalLink,
    Info,
    ListChecks,
    Monitor,
    Sparkles,
} from 'lucide-react';
import {
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    generateUUID,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getCopilotModelOptions,
    getModelOptions,
    type AIProviderId,
    type AIReasoningEffort,
    type AudioCaptureMode,
    type AudioFieldStrategy,
    safeFormatDate,
    type ExternalCalendarSubscription,
    useTaskStore,
} from '@mindwtr/core';

import { useKeybindings } from '../../contexts/keybinding-context';
import { useLanguage, type Language } from '../../contexts/language-context';
import { isTauriRuntime } from '../../lib/runtime';
import { SyncService } from '../../lib/sync-service';
import { clearLog, getLogPath, logDiagnosticsEnabled } from '../../lib/app-log';
import { ExternalCalendarService } from '../../lib/external-calendar-service';
import { checkForUpdates, type UpdateInfo, GITHUB_RELEASES_URL, verifyDownloadChecksum } from '../../lib/update-service';
import { loadAIKey, saveAIKey } from '../../lib/ai-config';
import {
    DEFAULT_WHISPER_MODEL,
    GEMINI_SPEECH_MODELS,
    OPENAI_SPEECH_MODELS,
    WHISPER_MODEL_BASE_URL,
    WHISPER_MODELS,
} from '../../lib/speech-models';
import { cn } from '../../lib/utils';
import { SettingsMainPage } from './settings/SettingsMainPage';
import { SettingsGtdPage } from './settings/SettingsGtdPage';
import { SettingsAiPage } from './settings/SettingsAiPage';
import { SettingsNotificationsPage } from './settings/SettingsNotificationsPage';
import { SettingsCalendarPage } from './settings/SettingsCalendarPage';
import { SettingsSyncPage } from './settings/SettingsSyncPage';
import { SettingsAboutPage } from './settings/SettingsAboutPage';
import { BaseDirectory, exists, mkdir, remove, size, writeFile } from '@tauri-apps/plugin-fs';
import { dataDir, join } from '@tauri-apps/api/path';

type ThemeMode = 'system' | 'light' | 'dark' | 'eink' | 'nord' | 'sepia';
type SettingsPage = 'main' | 'gtd' | 'notifications' | 'sync' | 'calendar' | 'ai' | 'about';
type LinuxDistroInfo = { id?: string; id_like?: string[] };

const THEME_STORAGE_KEY = 'mindwtr-theme';

const LANGUAGES: { id: Language; label: string; native: string }[] = [
    { id: 'en', label: 'English', native: 'English' },
    { id: 'zh', label: 'Chinese', native: '中文' },
    { id: 'es', label: 'Spanish', native: 'Español' },
    { id: 'hi', label: 'Hindi', native: 'हिन्दी' },
    { id: 'ar', label: 'Arabic', native: 'العربية' },
    { id: 'de', label: 'German', native: 'Deutsch' },
    { id: 'ru', label: 'Russian', native: 'Русский' },
    { id: 'ja', label: 'Japanese', native: '日本語' },
    { id: 'fr', label: 'French', native: 'Français' },
    { id: 'pt', label: 'Portuguese', native: 'Português' },
    { id: 'ko', label: 'Korean', native: '한국어' },
    { id: 'it', label: 'Italian', native: 'Italiano' },
    { id: 'tr', label: 'Turkish', native: 'Türkçe' },
];

const maskCalendarUrl = (url: string): string => {
    const trimmed = url.trim();
    if (!trimmed) return '';
    const match = trimmed.match(/^(https?:\/\/)?([^/?#]+)([^?#]*)/i);
    if (!match) {
        return trimmed.length <= 8 ? '...' : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
    }
    const protocol = match[1] ?? '';
    const host = match[2] ?? '';
    const path = match[3] ?? '';
    const lastSegment = path.split('/').filter(Boolean).pop() ?? '';
    const suffix = lastSegment ? `...${lastSegment.slice(-6)}` : '...';
    return `${protocol}${host}/${suffix}`;
};

export function SettingsView() {
    const [page, setPage] = useState<SettingsPage>('main');
    const [themeMode, setThemeMode] = useState<ThemeMode>('system');
    const { language, setLanguage, t: translate } = useLanguage();
    const { style: keybindingStyle, setStyle: setKeybindingStyle, openHelp } = useKeybindings();
    const { settings, updateSettings } = useTaskStore();
    const isTauri = isTauriRuntime();

    const [saved, setSaved] = useState(false);
    const [appVersion, setAppVersion] = useState('0.1.0');
    const [dataPath, setDataPath] = useState('');
    const [dbPath, setDbPath] = useState('');
    const [configPath, setConfigPath] = useState('');
    const [logPath, setLogPath] = useState('');
    const [aiApiKey, setAiApiKey] = useState('');
    const [speechApiKey, setSpeechApiKey] = useState('');
    const [speechDownloadState, setSpeechDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
    const [speechDownloadError, setSpeechDownloadError] = useState<string | null>(null);
    const [speechOfflinePath, setSpeechOfflinePath] = useState<string | null>(null);
    const [speechOfflineSize, setSpeechOfflineSize] = useState<number | null>(null);

    const notificationsEnabled = settings?.notificationsEnabled !== false;
    const dailyDigestMorningEnabled = settings?.dailyDigestMorningEnabled === true;
    const dailyDigestEveningEnabled = settings?.dailyDigestEveningEnabled === true;
    const dailyDigestMorningTime = settings?.dailyDigestMorningTime || '09:00';
    const dailyDigestEveningTime = settings?.dailyDigestEveningTime || '20:00';
    const autoArchiveDays = Number.isFinite(settings?.gtd?.autoArchiveDays)
        ? Math.max(0, Math.floor(settings?.gtd?.autoArchiveDays as number))
        : 7;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const aiEnabled = settings?.ai?.enabled === true;
    const aiDefaults = getDefaultAIConfig(aiProvider);
    const aiModel = settings?.ai?.model ?? aiDefaults.model;
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
    const loggingEnabled = settings?.diagnostics?.loggingEnabled === true;
    const didWriteLogRef = useRef(false);

    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [updateError, setUpdateError] = useState<string | null>(null);
    const [updateNotice, setUpdateNotice] = useState<string | null>(null);
    const [showUpdateModal, setShowUpdateModal] = useState(false);
    const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
    const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
    const [linuxDistro, setLinuxDistro] = useState<LinuxDistroInfo | null>(null);

    const [syncPath, setSyncPath] = useState<string>('');
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [syncBackend, setSyncBackend] = useState<'file' | 'webdav' | 'cloud'>('file');
    const [webdavUrl, setWebdavUrl] = useState('');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [webdavHasPassword, setWebdavHasPassword] = useState(false);
    const [cloudUrl, setCloudUrl] = useState('');
    const [cloudToken, setCloudToken] = useState('');
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [newCalendarName, setNewCalendarName] = useState('');
    const [newCalendarUrl, setNewCalendarUrl] = useState('');
    const [calendarError, setCalendarError] = useState<string | null>(null);

    useEffect(() => {
        const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
        if (
            savedTheme === 'system'
            || savedTheme === 'light'
            || savedTheme === 'dark'
            || savedTheme === 'eink'
            || savedTheme === 'nord'
            || savedTheme === 'sepia'
        ) {
            setThemeMode(savedTheme);
        }

        if (!isTauri) {
            setAppVersion('web');
            return;
        }

        import('@tauri-apps/api/app')
            .then(({ getVersion }) => getVersion())
            .then(setAppVersion)
            .catch(console.error);

        import('@tauri-apps/api/core')
            .then(async ({ invoke }) => {
                const [data, config, db, distro] = await Promise.all([
                    invoke<string>('get_data_path_cmd'),
                    invoke<string>('get_config_path_cmd'),
                    invoke<string>('get_db_path_cmd'),
                    invoke<LinuxDistroInfo | null>('get_linux_distro'),
                ]);
                setDataPath(data);
                setConfigPath(config);
                setDbPath(db);
                setLinuxDistro(distro);
            })
            .catch(console.error);

        getLogPath()
            .then((path) => {
                if (path) setLogPath(path);
            })
            .catch(console.error);
    }, [isTauri]);

    useEffect(() => {
        SyncService.getSyncPath().then(setSyncPath).catch(console.error);
        SyncService.getSyncBackend().then(setSyncBackend).catch(console.error);
        SyncService.getWebDavConfig()
            .then((cfg) => {
                setWebdavUrl(cfg.url);
                setWebdavUsername(cfg.username);
                setWebdavPassword(cfg.password ?? '');
                setWebdavHasPassword(cfg.hasPassword === true);
            })
            .catch(console.error);
        SyncService.getCloudConfig()
            .then((cfg) => {
                setCloudUrl(cfg.url);
                setCloudToken(cfg.token);
            })
            .catch(console.error);
    }, []);

    useEffect(() => {
        if (!loggingEnabled) {
            didWriteLogRef.current = false;
            return;
        }
        if (didWriteLogRef.current) return;
        didWriteLogRef.current = true;
        logDiagnosticsEnabled().catch(console.warn);
    }, [loggingEnabled]);

    useEffect(() => {
        ExternalCalendarService.getCalendars().then(setExternalCalendars).catch(console.error);
    }, []);

    useEffect(() => {
        let active = true;
        loadAIKey(aiProvider)
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
        if (speechProvider === 'whisper') {
            setSpeechApiKey('');
            return () => {
                active = false;
            };
        }
        loadAIKey(speechProvider as AIProviderId)
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
        const root = document.documentElement;
        root.classList.remove('theme-eink', 'theme-nord', 'theme-sepia');

        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (themeMode === 'system') {
            root.classList.toggle('dark', prefersDark);
        } else if (themeMode === 'dark' || themeMode === 'nord') {
            root.classList.add('dark');
        } else {
            root.classList.remove('dark');
        }

        if (themeMode === 'eink') root.classList.add('theme-eink');
        if (themeMode === 'nord') root.classList.add('theme-nord');
        if (themeMode === 'sepia') root.classList.add('theme-sepia');

        if (!isTauri) return;
        const tauriTheme = themeMode === 'system'
            ? null
            : themeMode === 'dark' || themeMode === 'nord'
                ? 'dark'
                : 'light';
        import('@tauri-apps/api/app')
            .then(({ setTheme }) => setTheme(tauriTheme))
            .catch(console.error);
    }, [isTauri, themeMode]);

    const showSaved = () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    };

    const saveThemePreference = (mode: ThemeMode) => {
        localStorage.setItem(THEME_STORAGE_KEY, mode);
        setThemeMode(mode);
        showSaved();
    };

    const saveLanguagePreference = (lang: Language) => {
        setLanguage(lang);
        showSaved();
    };

    const handleKeybindingStyleChange = (style: 'vim' | 'emacs') => {
        setKeybindingStyle(style);
        showSaved();
    };

    const updateAISettings = (next: Partial<NonNullable<typeof settings.ai>>) => {
        updateSettings({ ai: { ...(settings.ai ?? {}), ...next } })
            .then(showSaved)
            .catch(console.error);
    };

    const updateSpeechSettings = (
        next: Partial<NonNullable<NonNullable<typeof settings.ai>['speechToText']>>
    ) => {
        updateSettings({
            ai: {
                ...(settings.ai ?? {}),
                speechToText: { ...(settings.ai?.speechToText ?? {}), ...next },
            },
        })
            .then(showSaved)
            .catch(console.error);
    };

    const handleAIProviderChange = (provider: AIProviderId) => {
        updateAISettings({
            provider,
            model: getDefaultAIConfig(provider).model,
            copilotModel: getDefaultCopilotModel(provider),
            thinkingBudget: getDefaultAIConfig(provider).thinkingBudget,
        });
    };

    const handleToggleAnthropicThinking = () => {
        updateAISettings({
            thinkingBudget: anthropicThinkingEnabled ? 0 : (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024),
        });
    };

    const handleAiApiKeyChange = (value: string) => {
        setAiApiKey(value);
        saveAIKey(aiProvider, value).catch(console.error);
    };

    const handleSpeechProviderChange = (provider: 'openai' | 'gemini' | 'whisper') => {
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
    };

    const handleSpeechApiKeyChange = (value: string) => {
        setSpeechApiKey(value);
        if (speechProvider !== 'whisper') {
            saveAIKey(speechProvider as AIProviderId, value).catch(console.error);
        }
    };

    const resolveWhisperPath = useCallback(async (modelId: string) => {
        if (!isTauri) return null;
        const entry = WHISPER_MODELS.find((model) => model.id === modelId);
        if (!entry) return null;
        const base = await dataDir();
        return await join(base, 'mindwtr', 'whisper-models', entry.fileName);
    }, [isTauri]);

    useEffect(() => {
        let active = true;
        if (!isTauri || speechProvider !== 'whisper') {
            setSpeechOfflinePath(null);
            setSpeechOfflineSize(null);
            return () => {
                active = false;
            };
        }
        const load = async () => {
            const resolved = speechSettings.offlineModelPath || await resolveWhisperPath(speechModel);
            if (!active) return;
            setSpeechOfflinePath(resolved);
            if (!resolved) {
                setSpeechOfflineSize(null);
                return;
            }
            try {
                const present = await exists(resolved);
                if (!present) {
                    setSpeechOfflineSize(null);
                    return;
                }
                if (!speechSettings.offlineModelPath) {
                    updateSpeechSettings({ offlineModelPath: resolved, model: speechModel });
                }
                const fileSize = await size(resolved);
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
        }
    }, [isTauri, resolveWhisperPath, speechModel, updateSpeechSettings]);

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
            console.warn('Whisper model delete failed', error);
            setSpeechDownloadError(error instanceof Error ? error.message : String(error));
            setSpeechDownloadState('error');
        }
    }, [speechOfflinePath, updateSpeechSettings]);

    const persistCalendars = async (next: ExternalCalendarSubscription[]) => {
        setCalendarError(null);
        setExternalCalendars(next);
        try {
            await ExternalCalendarService.setCalendars(next);
            showSaved();
        } catch (error) {
            console.error(error);
            setCalendarError(String(error));
        }
    };

    const handleAddCalendar = () => {
        const url = newCalendarUrl.trim();
        if (!url) return;
        const name = (newCalendarName.trim() || 'Calendar').trim();
        const next = [
            ...externalCalendars,
            { id: generateUUID(), name, url, enabled: true },
        ];
        setNewCalendarName('');
        setNewCalendarUrl('');
        persistCalendars(next);
    };

    const handleToggleCalendar = (id: string, enabled: boolean) => {
        const next = externalCalendars.map((calendar) => (calendar.id === id ? { ...calendar, enabled } : calendar));
        persistCalendars(next);
    };

    const handleRemoveCalendar = (id: string) => {
        const next = externalCalendars.filter((calendar) => calendar.id !== id);
        persistCalendars(next);
    };

    const handleSaveSyncPath = async () => {
        if (!syncPath.trim()) return;
        const result = await SyncService.setSyncPath(syncPath.trim());
        if (result.success) {
            showSaved();
        }
    };

    const openLink = async (url: string) => {
        if (isTauri) {
            try {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(url);
                return;
            } catch (error) {
                console.error('Failed to open external link:', error);
            }
        }

        window.open(url, '_blank', 'noopener,noreferrer');
    };

    const handleChangeSyncLocation = async () => {
        try {
            if (!isTauri) return;

            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                directory: true,
                multiple: false,
                title: t.selectSyncFolderTitle,
            });

            if (selected && typeof selected === 'string') {
                setSyncPath(selected);
                const result = await SyncService.setSyncPath(selected);
                if (result.success) {
                    showSaved();
                }
            }
        } catch (error) {
            console.error('Failed to change sync location:', error);
        }
    };

    const handleSetSyncBackend = async (backend: 'file' | 'webdav' | 'cloud') => {
        setSyncBackend(backend);
        await SyncService.setSyncBackend(backend);
        showSaved();
    };

    const handleSaveWebDav = async () => {
        const trimmedUrl = webdavUrl.trim();
        const trimmedPassword = webdavPassword.trim();
        await SyncService.setWebDavConfig({
            url: trimmedUrl,
            username: webdavUsername.trim(),
            ...(trimmedPassword ? { password: trimmedPassword } : {}),
        });
        if (!trimmedUrl) {
            setWebdavHasPassword(false);
            setWebdavPassword('');
        } else if (trimmedPassword) {
            setWebdavHasPassword(true);
        }
        showSaved();
    };

    const handleSaveCloud = async () => {
        await SyncService.setCloudConfig({
            url: cloudUrl.trim(),
            token: cloudToken.trim(),
        });
        showSaved();
    };

    const handleSync = async () => {
        try {
            setIsSyncing(true);
            setSyncError(null);

            if (syncBackend === 'webdav') {
                if (!webdavUrl.trim()) return;
                await handleSaveWebDav();
            }
            if (syncBackend === 'cloud') {
                if (!cloudUrl.trim()) return;
                await handleSaveCloud();
            }
            if (syncBackend === 'file') {
                const path = syncPath.trim();
                if (path) {
                    await SyncService.setSyncPath(path);
                }
            }

            await SyncService.performSync();
        } catch (error) {
            console.error('Sync failed:', error);
            setSyncError(String(error));
        } finally {
            setIsSyncing(false);
        }
    };

    const toggleLogging = async () => {
        const nextEnabled = !loggingEnabled;
        await updateSettings({
            diagnostics: {
                ...(settings?.diagnostics ?? {}),
                loggingEnabled: nextEnabled,
            },
        }).then(showSaved).catch(console.error);
        if (nextEnabled) {
            await logDiagnosticsEnabled();
        }
    };

    const handleClearLog = async () => {
        await clearLog();
        showSaved();
    };

    const handleCheckUpdates = async () => {
        setIsCheckingUpdate(true);
        setUpdateInfo(null);
        setUpdateError(null);
        setUpdateNotice(null);
        try {
            const info = await checkForUpdates(appVersion);
            if (!info || !info.hasUpdate) {
                setUpdateNotice(t.upToDate);
                return;
            }
            setUpdateInfo(info);
            if (info.platform === 'linux' && linuxFlavor === 'arch') {
                setDownloadNotice(t.downloadAURHint);
            } else {
                setDownloadNotice(null);
            }
            setIsDownloadingUpdate(false);
            setShowUpdateModal(true);
        } catch (error) {
            console.error('Update check failed:', error);
            setUpdateError(String(error));
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handleDownloadUpdate = async () => {
        const targetUrl = preferredDownloadUrl;
        if (updateInfo?.platform === 'linux' && linuxFlavor === 'arch') {
            setDownloadNotice(t.downloadAURHint);
            return;
        }
        if (!targetUrl) {
            setDownloadNotice(t.downloadFailed);
            return;
        }
        setIsDownloadingUpdate(true);
        setDownloadNotice(t.downloadStarting);

        try {
            if (updateInfo?.assets?.length) {
                const verified = await verifyDownloadChecksum(targetUrl, updateInfo.assets);
                if (!verified) {
                    setDownloadNotice(t.downloadFailed);
                    setIsDownloadingUpdate(false);
                    return;
                }
            }
            if (isTauri) {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(targetUrl);
            } else {
                window.open(targetUrl, '_blank');
            }
            setDownloadNotice(t.downloadStarted);
        } catch (error) {
            console.error('Failed to open update URL:', error);
            window.open(targetUrl, '_blank');
            setDownloadNotice(t.downloadFailed);
        }

        if (isTauri) {
            try {
                const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
                if (/linux/i.test(userAgent)) {
                    setDownloadNotice(t.linuxUpdateHint);
                }
            } catch (error) {
                console.error('Failed to detect platform:', error);
            }
        }

    };

    const labelFallback = {
        en: {
            title: 'Settings',
            general: 'General',
            subtitle: 'Customize your Mindwtr experience',
            back: 'Back',
            features: 'Features',
            featuresDesc: 'Optional signals you can turn on when needed.',
            appearance: 'Appearance',
            gtd: 'GTD',
            gtdDesc: 'Tune the GTD workflow defaults.',
            captureDefault: 'Default capture method',
            captureDefaultDesc: 'Choose whether quick capture starts with text or audio.',
            captureDefaultText: 'Text',
            captureDefaultAudio: 'Audio',
            captureSaveAudio: 'Save audio attachments',
            captureSaveAudioDesc: 'Keep the audio file attached after transcription.',
            autoArchive: 'Auto-archive done tasks',
            autoArchiveDesc: 'Move completed tasks to Archived after a set number of days.',
            autoArchiveNever: 'Never (keep in Done)',
            language: 'Language',
            keybindings: 'Keyboard Shortcuts',
            keybindingsDesc: 'Choose your preferred desktop keybinding style.',
            keybindingVim: 'Vim',
            keybindingEmacs: 'Emacs',
            viewShortcuts: 'View shortcuts',
            taskEditorLayout: 'Task editor layout',
            taskEditorLayoutDesc: 'Choose which fields are shown by default in the task editor.',
            taskEditorLayoutHint: 'Hidden fields appear when they have content or after clicking “More options”.',
            taskEditorLayoutReset: 'Reset layout',
            taskEditorFieldStatus: 'Status',
            taskEditorFieldProject: 'Project',
            taskEditorFieldPriority: 'Priority',
            taskEditorFieldContexts: 'Contexts',
            taskEditorFieldDescription: 'Description',
            taskEditorFieldTags: 'Tags',
            taskEditorFieldTimeEstimate: 'Time estimate',
            taskEditorFieldRecurrence: 'Recurrence',
            taskEditorFieldStartTime: 'Start date',
            taskEditorFieldDueDate: 'Due date',
            taskEditorFieldReviewAt: 'Review date',
            taskEditorFieldAttachments: 'Attachments',
            taskEditorFieldChecklist: 'Checklist',
            featurePriorities: 'Priorities',
            featurePrioritiesDesc: 'Show a priority flag on tasks.',
            featureTimeEstimates: 'Time estimates',
            featureTimeEstimatesDesc: 'Add quick duration estimates for time blocking.',
            notifications: 'Notifications',
            notificationsDesc: 'Enable task reminders and daily digest notifications.',
            notificationsEnable: 'Enable notifications',
            ai: 'AI Assistant',
            aiDesc: 'Optional help to clarify and break down tasks.',
            aiEnable: 'Enable AI assistant',
            aiProvider: 'Provider',
            aiProviderOpenAI: 'OpenAI',
            aiProviderGemini: 'Gemini',
            aiProviderAnthropic: 'Anthropic (Claude)',
            aiModel: 'Model',
            aiApiKey: 'API key',
            aiApiKeyHint: 'Stored locally on this device. Never synced.',
            aiReasoning: 'Reasoning effort',
            aiReasoningHint: 'Used by GPT-5 models.',
            aiEffortLow: 'Low',
            aiEffortMedium: 'Medium',
            aiEffortHigh: 'High',
            aiCopilotModel: 'Copilot model',
            aiCopilotHint: 'Used for fast autocomplete suggestions.',
            aiThinkingBudget: 'Thinking budget',
            aiThinkingHint: 'Claude/Gemini only. 0 disables extended thinking.',
            aiThinkingEnable: 'Enable thinking',
            aiThinkingEnableDesc: 'Use extended reasoning for complex tasks.',
            aiThinkingOff: 'Off',
            aiThinkingLow: 'Low',
            aiThinkingMedium: 'Medium',
            aiThinkingHigh: 'High',
            speechTitle: 'Speech to text',
            speechDesc: 'Transcribe voice captures and map them into task fields.',
            speechEnable: 'Enable speech to text',
            speechProvider: 'Speech provider',
            speechProviderOffline: 'On-device (Whisper)',
            speechModel: 'Speech model',
            speechOfflineModel: 'Offline model',
            speechOfflineModelDesc: 'Download once to transcribe fully offline.',
            speechOfflineReady: 'Model downloaded',
            speechOfflineNotDownloaded: 'Model not downloaded',
            speechOfflineDownload: 'Download',
            speechOfflineDownloadSuccess: 'Download complete',
            speechOfflineDelete: 'Delete',
            speechOfflineDownloadError: 'Offline model download failed',
            speechLanguage: 'Audio language',
            speechLanguageHint: 'Use a language name or code, or leave blank to auto-detect.',
            speechLanguageAuto: 'Auto (detect language)',
            speechMode: 'Processing mode',
            speechModeHint: 'Smart parse extracts dates and fields; transcript-only just transcribes.',
            speechModeSmart: 'Smart parse',
            speechModeTranscript: 'Transcript only',
            speechFieldStrategy: 'Field mapping',
            speechFieldStrategyHint: 'Choose where the transcript should land by default.',
            speechFieldSmart: 'Smart',
            speechFieldTitle: 'Title',
            speechFieldDescription: 'Description',
            dailyDigest: 'Daily Digest',
            dailyDigestDesc: 'Morning briefing and evening review prompts.',
            dailyDigestMorning: 'Morning briefing',
            dailyDigestEvening: 'Evening review',
            weeklyReview: 'Weekly review',
            weeklyReviewDesc: 'Get a weekly review reminder at your chosen time.',
            weeklyReviewDay: 'Review day',
            weeklyReviewTime: 'Review time',
            on: 'On',
            off: 'Off',
            visible: 'Shown',
            hidden: 'Hidden',
            manage: 'Manage',
            localData: 'Local Data',
            localDataDesc: 'Config is stored in your system config folder; data is stored in your system data folder.',
            webDataDesc: 'The web app stores data in browser storage.',
            diagnostics: 'Diagnostics',
            diagnosticsDesc: 'Help troubleshoot issues.',
            debugLogging: 'Debug logging',
            debugLoggingDesc: 'Record errors locally to share with support.',
            logFile: 'Log file',
            clearLog: 'Clear log',
            sync: 'Sync',
            syncDescription:
                'Configure a secondary folder to sync your data with (e.g., Dropbox, Syncthing). This merges your local data with the sync folder to prevent data loss.',
            syncBackend: 'Sync backend',
            syncBackendFile: 'File',
            syncBackendWebdav: 'WebDAV',
            syncBackendCloud: 'Self-Hosted',
            calendar: 'Calendar',
            calendarDesc: 'View external calendars via ICS subscription URLs.',
            externalCalendars: 'External calendars',
            calendarName: 'Name',
            calendarUrl: 'ICS URL',
            calendarAdd: 'Add calendar',
            calendarRemove: 'Remove',
            syncFolderLocation: 'Sync folder',
            savePath: 'Save',
            browse: 'Browse…',
            syncNow: 'Sync now',
            syncing: 'Syncing…',
            pathHint: 'Type a path directly (e.g., ~/Sync/mindwtr) or use Browse if available',
            webdavUrl: 'WebDAV URL',
            webdavUsername: 'Username',
            webdavPassword: 'Password',
            webdavSave: 'Save WebDAV',
            webdavHint: 'Use a full URL to your sync JSON file (e.g., https://example.com/remote.php/dav/files/user/data.json).',
            cloudUrl: 'Self-hosted URL',
            cloudToken: 'Access token',
            cloudSave: 'Save Self-Hosted',
            cloudHint: 'Use your self-hosted endpoint URL.',
            lastSync: 'Last sync',
            lastSyncNever: 'Never',
            lastSyncSuccess: 'Sync completed',
            lastSyncError: 'Sync failed',
            lastSyncConflict: 'Conflicts resolved',
            lastSyncConflicts: 'Conflicts',
            about: 'About',
            version: 'Version',
            developer: 'Developer',
            website: 'Website',
            github: 'GitHub',
            license: 'License',
            checkForUpdates: 'Check for Updates',
            checking: 'Checking…',
            upToDate: 'You are using the latest version!',
            updateAvailable: 'Update Available',
            checkFailed: 'Failed to check for updates',
            download: 'Download',
            downloadStarting: 'Opening download…',
            downloadStarted: 'Download started in your browser.',
            downloadFailed: 'Failed to open download link.',
            downloadRecommended: 'Recommended package',
            downloadAURHint: 'Arch detected: update via AUR',
            changelog: 'Changelog',
            noChangelog: 'No changelog available',
            later: 'Later',
            linuxUpdateHint: 'On Linux, Mindwtr cannot auto-install updates. After downloading, install via your package manager (e.g., yay -S mindwtr or paru -S mindwtr) or the downloaded package.',
            saved: 'Settings saved',
            selectSyncFolderTitle: 'Select sync folder',
            system: 'System',
            light: 'Light',
            dark: 'Dark',
            eink: 'E-Ink',
            nord: 'Nord',
            sepia: 'Sepia',
        },
        zh: {
            title: '设置',
            general: '通用',
            subtitle: '自定义您的 Mindwtr 体验',
            back: '返回',
            features: '功能',
            featuresDesc: '按需开启可选信号。',
            appearance: '外观',
            gtd: 'GTD',
            gtdDesc: '调整 GTD 工作流默认设置。',
            captureDefault: '默认捕获方式',
            captureDefaultDesc: '选择快速捕获默认使用文本或语音。',
            captureDefaultText: '文本',
            captureDefaultAudio: '语音',
            captureSaveAudio: '保留语音附件',
            captureSaveAudioDesc: '转录后仍保留音频文件。',
            autoArchive: '自动归档完成任务',
            autoArchiveDesc: '在设定天数后将已完成任务移入归档。',
            autoArchiveNever: '从不（保留在已完成）',
            language: '语言',
            keybindings: '快捷键',
            keybindingsDesc: '选择桌面端偏好的快捷键风格。',
            keybindingVim: 'Vim',
            keybindingEmacs: 'Emacs',
            viewShortcuts: '查看快捷键',
            taskEditorLayout: '任务编辑布局',
            taskEditorLayoutDesc: '选择默认显示的任务编辑字段。',
            taskEditorLayoutHint: '隐藏字段仅在有内容或点击“更多选项”后显示。',
            taskEditorLayoutReset: '重置布局',
            taskEditorFieldStatus: '状态',
            taskEditorFieldProject: '项目',
            taskEditorFieldPriority: '优先级',
            taskEditorFieldContexts: '情境',
            taskEditorFieldDescription: '描述',
            taskEditorFieldTags: '标签',
            taskEditorFieldTimeEstimate: '时间预估',
            taskEditorFieldRecurrence: '重复',
            taskEditorFieldStartTime: '开始日期',
            taskEditorFieldDueDate: '截止日期',
            taskEditorFieldReviewAt: '回顾日期',
            taskEditorFieldAttachments: '附件',
            taskEditorFieldChecklist: '清单',
            featurePriorities: '优先级',
            featurePrioritiesDesc: '为任务显示优先级标记。',
            featureTimeEstimates: '时间估算',
            featureTimeEstimatesDesc: '为时间管理添加时长估计。',
            notifications: '通知',
            notificationsDesc: '启用任务提醒与每日简报通知。',
            notificationsEnable: '启用通知',
            ai: 'AI 助手',
            aiDesc: '帮助澄清与拆解任务（可选）。',
            aiEnable: '启用 AI 助手',
            aiProvider: '服务商',
            aiProviderOpenAI: 'OpenAI',
            aiProviderGemini: 'Gemini',
            aiProviderAnthropic: 'Anthropic（Claude）',
            aiModel: '模型',
            aiApiKey: 'API 密钥',
            aiApiKeyHint: '仅保存在本机，不会同步。',
            aiReasoning: '推理强度',
            aiReasoningHint: '仅用于 GPT-5 模型。',
            aiEffortLow: '低',
            aiEffortMedium: '中',
            aiEffortHigh: '高',
            aiCopilotModel: '助手模型',
            aiCopilotHint: '用于快速补全建议。',
            aiThinkingBudget: '思考预算',
            aiThinkingHint: '仅用于 Claude/Gemini。0 代表关闭深度思考。',
            aiThinkingEnable: '启用思考',
            aiThinkingEnableDesc: '为复杂任务启用扩展推理。',
            aiThinkingOff: '关闭',
            aiThinkingLow: '低',
            aiThinkingMedium: '中',
            aiThinkingHigh: '高',
            speechTitle: '语音转文字',
            speechDesc: '转录语音并映射到任务字段。',
            speechEnable: '启用语音转文字',
            speechProvider: '语音服务商',
            speechProviderOffline: '本地（Whisper）',
            speechModel: '语音模型',
            speechOfflineModel: '离线模型',
            speechOfflineModelDesc: '下载一次即可离线转录。',
            speechOfflineReady: '模型已下载',
            speechOfflineNotDownloaded: '尚未下载模型',
            speechOfflineDownload: '下载',
            speechOfflineDownloadSuccess: '下载完成',
            speechOfflineDelete: '删除',
            speechOfflineDownloadError: '离线模型下载失败',
            speechLanguage: '语音语言',
            speechLanguageHint: '可填写语言名称或代码，留空则自动检测。',
            speechLanguageAuto: '自动检测语言',
            speechMode: '处理模式',
            speechModeHint: '智能解析可提取日期与字段，纯转录仅输出文本。',
            speechModeSmart: '智能解析',
            speechModeTranscript: '仅转录',
            speechFieldStrategy: '字段映射',
            speechFieldStrategyHint: '选择默认写入标题或描述的位置。',
            speechFieldSmart: '智能',
            speechFieldTitle: '标题',
            speechFieldDescription: '描述',
            dailyDigest: '每日简报',
            dailyDigestDesc: '早间简报与晚间回顾提醒。',
            dailyDigestMorning: '早间简报',
            dailyDigestEvening: '晚间回顾',
            weeklyReview: '每周回顾',
            weeklyReviewDesc: '在你设定的时间提醒进行每周回顾。',
            weeklyReviewDay: '回顾日期',
            weeklyReviewTime: '回顾时间',
            on: '开启',
            off: '关闭',
            visible: '显示',
            hidden: '隐藏',
            manage: '管理',
            localData: '本地数据',
            localDataDesc: '配置保存在系统配置目录；数据保存在系统数据目录。',
            webDataDesc: 'Web 版本使用浏览器存储。',
            diagnostics: '诊断',
            diagnosticsDesc: '帮助排查问题。',
            debugLogging: '调试日志',
            debugLoggingDesc: '将错误记录到本地以便提交反馈。',
            logFile: '日志文件',
            clearLog: '清除日志',
            sync: '同步',
            syncDescription:
                '配置一个辅助文件夹来同步您的数据（如 Dropbox、Syncthing）。这会将本地数据与同步文件夹合并，以防止数据丢失。',
            syncBackend: '同步后端',
            syncBackendFile: '文件',
            syncBackendWebdav: 'WebDAV',
            syncBackendCloud: '自托管',
            calendar: '日历',
            calendarDesc: '通过 ICS 订阅地址查看外部日历（只读）。',
            externalCalendars: '外部日历',
            calendarName: '名称',
            calendarUrl: 'ICS 地址',
            calendarAdd: '添加日历',
            calendarRemove: '移除',
            syncFolderLocation: '同步文件夹',
            savePath: '保存',
            browse: '浏览…',
            syncNow: '立即同步',
            syncing: '同步中…',
            pathHint: '直接输入路径（如 ~/Sync/mindwtr）或点击浏览选择',
            webdavUrl: 'WebDAV 地址',
            webdavUsername: '用户名',
            webdavPassword: '密码',
            webdavSave: '保存 WebDAV',
            webdavHint: '请输入同步 JSON 文件的完整 URL（例如 https://example.com/remote.php/dav/files/user/data.json）。',
            cloudUrl: '自托管地址',
            cloudToken: '访问令牌',
            cloudSave: '保存自托管配置',
            cloudHint: '请输入自托管同步端点 URL。',
            lastSync: '上次同步',
            lastSyncNever: '从未同步',
            lastSyncSuccess: '同步完成',
            lastSyncError: '同步失败',
            lastSyncConflict: '已解决冲突',
            lastSyncConflicts: '冲突',
            about: '关于',
            version: '版本',
            developer: '开发者',
            website: '网站',
            github: 'GitHub',
            license: '许可证',
            checkForUpdates: '检查更新',
            checking: '检查中…',
            upToDate: '您正在使用最新版本！',
            updateAvailable: '有可用更新',
            checkFailed: '检查更新失败',
            download: '下载',
            downloadStarting: '正在打开下载…',
            downloadStarted: '已在浏览器开始下载。',
            downloadFailed: '打开下载链接失败。',
            downloadRecommended: '推荐下载包',
            downloadAURHint: '检测到 Arch：建议使用 AUR 更新',
            changelog: '更新日志',
            noChangelog: '暂无更新日志',
            later: '稍后',
            linuxUpdateHint: 'Linux 上无法自动安装更新。下载后请使用包管理器更新（如 yay -S mindwtr 或 paru -S mindwtr），或安装下载的包。',
            saved: '设置已保存',
            selectSyncFolderTitle: '选择同步文件夹',
            system: '系统',
            light: '浅色',
            dark: '深色',
            eink: '电子墨水',
            nord: 'Nord',
            sepia: '复古米黄',
        },
    } as const;

    type Labels = Record<keyof typeof labelFallback.en, string>;
    const labelKeyOverrides: Partial<Record<keyof Labels, string>> = {
        back: 'common.back',
        keybindings: 'keybindings.helpTitle',
        keybindingsDesc: 'settings.keybindingsDesc',
        keybindingVim: 'keybindings.style.vim',
        keybindingEmacs: 'keybindings.style.emacs',
        viewShortcuts: 'keybindings.openHelp',
        taskEditorLayoutReset: 'settings.resetToDefault',
        taskEditorFieldStatus: 'taskEdit.statusLabel',
        taskEditorFieldProject: 'taskEdit.projectLabel',
        taskEditorFieldPriority: 'taskEdit.priorityLabel',
        taskEditorFieldContexts: 'taskEdit.contextsLabel',
        taskEditorFieldDescription: 'taskEdit.descriptionLabel',
        taskEditorFieldTags: 'taskEdit.tagsLabel',
        taskEditorFieldTimeEstimate: 'taskEdit.timeEstimateLabel',
        taskEditorFieldRecurrence: 'taskEdit.recurrenceLabel',
        taskEditorFieldStartTime: 'taskEdit.startDateLabel',
        taskEditorFieldDueDate: 'taskEdit.dueDateLabel',
        taskEditorFieldReviewAt: 'taskEdit.reviewDateLabel',
        taskEditorFieldAttachments: 'attachments.title',
        taskEditorFieldChecklist: 'taskEdit.checklist',
    };
    const labelsFallback = language === 'zh' ? labelFallback.zh : labelFallback.en;
    const t = useMemo(() => {
        const result = {} as Labels;
        (Object.keys(labelFallback.en) as Array<keyof Labels>).forEach((key) => {
            const i18nKey = labelKeyOverrides[key] ?? `settings.${key}`;
            const translated = translate(i18nKey);
            result[key] = translated !== i18nKey ? translated : labelsFallback[key];
        });
        return result;
    }, [labelsFallback, translate]);
    const anthropicThinkingOptions = [
        { value: DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024, label: t.aiThinkingLow },
        { value: 2048, label: t.aiThinkingMedium },
        { value: 4096, label: t.aiThinkingHigh },
    ];

    const linuxFlavor = useMemo(() => {
        if (!linuxDistro) return null;
        const tokens = [
            linuxDistro.id,
            ...(linuxDistro.id_like ?? []),
        ]
            .filter(Boolean)
            .map((value) => String(value).toLowerCase());
        if (tokens.some((token) => token.includes('arch') || token.includes('manjaro'))) return 'arch';
        if (tokens.some((token) => token.includes('debian') || token.includes('ubuntu') || token.includes('pop'))) return 'debian';
        if (tokens.some((token) => token.includes('fedora') || token.includes('rhel') || token.includes('redhat') || token.includes('centos') || token.includes('rocky') || token.includes('alma'))) return 'rpm';
        if (tokens.some((token) => token.includes('suse') || token.includes('opensuse'))) return 'rpm';
        return 'other';
    }, [linuxDistro]);

    const recommendedDownload = useMemo(() => {
        if (!updateInfo) return null;
        const assets = updateInfo.assets || [];
        const findAsset = (patterns: RegExp[]) => assets.find((asset) => patterns.some((pattern) => pattern.test(asset.name)));

        if (updateInfo.platform === 'windows') {
            const asset = findAsset([/\.msi$/i, /\.exe$/i]);
            return asset ? { label: '.msi/.exe', url: asset.url } : null;
        }

        if (updateInfo.platform === 'macos') {
            const asset = findAsset([/\.dmg$/i, /\.app\.tar\.gz$/i]);
            return asset ? { label: '.dmg', url: asset.url } : null;
        }

        if (updateInfo.platform === 'linux') {
            if (linuxFlavor === 'arch') {
                return { label: 'AUR', url: null };
            }
            if (linuxFlavor === 'debian') {
                const asset = findAsset([/\.deb$/i]);
                return { label: '.deb', url: asset?.url ?? null };
            }
            if (linuxFlavor === 'rpm') {
                const asset = findAsset([/\.rpm$/i]);
                return { label: '.rpm', url: asset?.url ?? null };
            }
            const asset = findAsset([/\.AppImage$/i]);
            return { label: '.AppImage', url: asset?.url ?? null };
        }

        return null;
    }, [updateInfo, linuxFlavor]);

    const preferredDownloadUrl = useMemo(() => {
        if (!updateInfo) return null;
        if (updateInfo.platform === 'linux') {
            if (linuxFlavor === 'arch') return null;
            if (linuxFlavor === 'debian' || linuxFlavor === 'rpm') {
                return recommendedDownload?.url ?? updateInfo.releaseUrl ?? GITHUB_RELEASES_URL;
            }
        }
        return recommendedDownload?.url ?? updateInfo.downloadUrl ?? updateInfo.releaseUrl ?? GITHUB_RELEASES_URL;
    }, [updateInfo, linuxFlavor, recommendedDownload]);

    const isArchLinuxUpdate = updateInfo?.platform === 'linux' && linuxFlavor === 'arch';
    const canDownloadUpdate = Boolean(preferredDownloadUrl) && !isArchLinuxUpdate;

    const lastSyncAt = settings?.lastSyncAt;
    const lastSyncStatus = settings?.lastSyncStatus;
    const lastSyncStats = settings?.lastSyncStats ?? null;
    const lastSyncDisplay = lastSyncAt ? safeFormatDate(lastSyncAt, 'PPpp', lastSyncAt) : t.lastSyncNever;
    const conflictCount = (lastSyncStats?.tasks.conflicts || 0) + (lastSyncStats?.projects.conflicts || 0);
    const weeklyReviewEnabled = settings?.weeklyReviewEnabled === true;
    const weeklyReviewTime = settings?.weeklyReviewTime || '18:00';
    const weeklyReviewDay = Number.isFinite(settings?.weeklyReviewDay) ? settings?.weeklyReviewDay as number : 0;
    const localeMap: Record<Language, string> = {
        en: 'en-US',
        zh: 'zh-CN',
        es: 'es-ES',
        hi: 'hi-IN',
        ar: 'ar',
        de: 'de-DE',
        ru: 'ru-RU',
        ja: 'ja-JP',
        fr: 'fr-FR',
        pt: 'pt-PT',
        ko: 'ko-KR',
        it: 'it-IT',
        tr: 'tr-TR',
    };
    const locale = localeMap[language] ?? 'en-US';
    const weekdayOptions = useMemo(() => (
        Array.from({ length: 7 }, (_, i) => {
            const base = new Date(2021, 7, 1 + i);
            return { value: i, label: base.toLocaleDateString(locale, { weekday: 'long' }) };
        })
    ), [locale]);

    const pageTitle = page === 'gtd'
        ? t.gtd
        : page === 'notifications'
            ? t.notifications
            : page === 'ai'
                ? t.ai
            : page === 'sync'
                ? t.sync
                : page === 'calendar'
                    ? t.calendar
                    : page === 'about'
                        ? t.about
                        : t.general;

    const navItems: Array<{
        id: SettingsPage;
        icon: ComponentType<{ className?: string }>;
        label: string;
        description?: string;
    }> = [
        { id: 'main', icon: Monitor, label: t.general, description: `${t.appearance} • ${t.language} • ${t.keybindings}` },
        { id: 'gtd', icon: ListChecks, label: t.gtd, description: t.gtdDesc },
        { id: 'notifications', icon: Bell, label: t.notifications },
        { id: 'sync', icon: Database, label: t.sync },
        { id: 'ai', icon: Sparkles, label: t.ai, description: t.aiDesc },
        { id: 'calendar', icon: CalendarDays, label: t.calendar },
        { id: 'about', icon: Info, label: t.about },
    ];

    const renderPage = () => {
        if (page === 'main') {
            return (
                <SettingsMainPage
                    t={t}
                    themeMode={themeMode}
                    onThemeChange={saveThemePreference}
                    language={language}
                    onLanguageChange={saveLanguagePreference}
                    keybindingStyle={keybindingStyle}
                    onKeybindingStyleChange={handleKeybindingStyleChange}
                    onOpenHelp={openHelp}
                    languages={LANGUAGES}
                />
            );
        }

        if (page === 'gtd') {
            return (
                <SettingsGtdPage
                    t={t}
                    language={language}
                    settings={settings}
                    updateSettings={updateSettings}
                    showSaved={showSaved}
                    autoArchiveDays={autoArchiveDays}
                />
            );
        }

        if (page === 'ai') {
            return (
                <SettingsAiPage
                    t={t}
                    aiEnabled={aiEnabled}
                    aiProvider={aiProvider}
                    aiModel={aiModel}
                    aiModelOptions={aiModelOptions}
                    aiCopilotModel={aiCopilotModel}
                    aiCopilotOptions={aiCopilotOptions}
                    aiReasoningEffort={aiReasoningEffort}
                    aiThinkingBudget={aiThinkingBudget}
                    anthropicThinkingEnabled={anthropicThinkingEnabled}
                    anthropicThinkingOptions={anthropicThinkingOptions}
                    aiApiKey={aiApiKey}
                    speechEnabled={speechEnabled}
                    speechProvider={speechProvider}
                    speechModel={speechModel}
                    speechModelOptions={speechModelOptions}
                    speechLanguage={speechLanguage}
                    speechMode={speechMode}
                    speechFieldStrategy={speechFieldStrategy}
                    speechApiKey={speechApiKey}
                    speechOfflineReady={Boolean(speechOfflineSize)}
                    speechOfflineSize={speechOfflineSize}
                    speechDownloadState={speechDownloadState}
                    speechDownloadError={speechDownloadError}
                    onUpdateAISettings={updateAISettings}
                    onUpdateSpeechSettings={updateSpeechSettings}
                    onProviderChange={handleAIProviderChange}
                    onSpeechProviderChange={handleSpeechProviderChange}
                    onToggleAnthropicThinking={handleToggleAnthropicThinking}
                    onAiApiKeyChange={handleAiApiKeyChange}
                    onSpeechApiKeyChange={handleSpeechApiKeyChange}
                    onDownloadWhisperModel={handleDownloadWhisperModel}
                    onDeleteWhisperModel={handleDeleteWhisperModel}
                />
            );
        }

        if (page === 'notifications') {
            return (
                <SettingsNotificationsPage
                    t={t}
                    notificationsEnabled={notificationsEnabled}
                    weeklyReviewEnabled={weeklyReviewEnabled}
                    weeklyReviewDay={weeklyReviewDay}
                    weeklyReviewTime={weeklyReviewTime}
                    weekdayOptions={weekdayOptions}
                    dailyDigestMorningEnabled={dailyDigestMorningEnabled}
                    dailyDigestEveningEnabled={dailyDigestEveningEnabled}
                    dailyDigestMorningTime={dailyDigestMorningTime}
                    dailyDigestEveningTime={dailyDigestEveningTime}
                    updateSettings={updateSettings}
                    showSaved={showSaved}
                />
            );
        }

        if (page === 'calendar') {
            return (
                <SettingsCalendarPage
                    t={t}
                    newCalendarName={newCalendarName}
                    newCalendarUrl={newCalendarUrl}
                    calendarError={calendarError}
                    externalCalendars={externalCalendars}
                    onCalendarNameChange={setNewCalendarName}
                    onCalendarUrlChange={setNewCalendarUrl}
                    onAddCalendar={handleAddCalendar}
                    onToggleCalendar={handleToggleCalendar}
                    onRemoveCalendar={handleRemoveCalendar}
                    maskCalendarUrl={maskCalendarUrl}
                />
            );
        }

        if (page === 'sync') {
            return (
                <SettingsSyncPage
                    t={t}
                    isTauri={isTauri}
                    dataPath={dataPath}
                    dbPath={dbPath}
                    configPath={configPath}
                    loggingEnabled={loggingEnabled}
                    logPath={logPath}
                    onToggleLogging={toggleLogging}
                    onClearLog={handleClearLog}
                    syncBackend={syncBackend}
                    onSetSyncBackend={handleSetSyncBackend}
                    syncPath={syncPath}
                    onSyncPathChange={setSyncPath}
                    onSaveSyncPath={handleSaveSyncPath}
                    onBrowseSyncPath={handleChangeSyncLocation}
                    webdavUrl={webdavUrl}
                    webdavUsername={webdavUsername}
                    webdavPassword={webdavPassword}
                    webdavHasPassword={webdavHasPassword}
                    onWebdavUrlChange={setWebdavUrl}
                    onWebdavUsernameChange={setWebdavUsername}
                    onWebdavPasswordChange={setWebdavPassword}
                    onSaveWebDav={handleSaveWebDav}
                    cloudUrl={cloudUrl}
                    cloudToken={cloudToken}
                    onCloudUrlChange={setCloudUrl}
                    onCloudTokenChange={setCloudToken}
                    onSaveCloud={handleSaveCloud}
                    onSyncNow={handleSync}
                    isSyncing={isSyncing}
                    syncError={syncError}
                    lastSyncDisplay={lastSyncDisplay}
                    lastSyncStatus={lastSyncStatus}
                    lastSyncStats={lastSyncStats}
                    conflictCount={conflictCount}
                    lastSyncError={settings?.lastSyncError}
                />
            );
        }

        if (page === 'about') {
            return (
                <SettingsAboutPage
                    t={t}
                    isTauri={isTauri}
                    dataPath={dataPath}
                    dbPath={dbPath}
                    configPath={configPath}
                    appVersion={appVersion}
                    onOpenLink={openLink}
                    onCheckUpdates={handleCheckUpdates}
                    isCheckingUpdate={isCheckingUpdate}
                    updateError={updateError}
                    updateNotice={updateNotice}
                />
            );
        }

        return null;
    };

    return (
        <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-6xl p-8">
                <div className="grid grid-cols-12 gap-6">
                    <aside className="col-span-12 lg:col-span-4 xl:col-span-3 space-y-4">
                        <div>
                            <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
                            <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
                        </div>
                        <nav className="bg-card border border-border rounded-lg p-1">
                            {navItems.map((item) => {
                                const Icon = item.icon;
                                const isActive = item.id === page;
                                return (
                                    <button
                                        key={item.id}
                                        onClick={() => setPage(item.id)}
                                        className={cn(
                                            "w-full flex items-start gap-3 px-3 py-2 rounded-md text-left transition-colors",
                                            isActive
                                                ? "bg-primary/10 text-primary"
                                                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                                        )}
                                    >
                                        <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium leading-5">{item.label}</div>
                                            {item.description && (
                                                <div className={cn("text-xs mt-0.5", isActive ? "text-primary/80" : "text-muted-foreground")}>
                                                    {item.description}
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </nav>
                    </aside>

                    <main className="col-span-12 lg:col-span-8 xl:col-span-9">
                        <div className="space-y-6">
                            <header className="flex items-start justify-between gap-4">
                                <div>
                                    <h2 className="text-xl font-semibold tracking-tight">{pageTitle}</h2>
                                </div>
                            </header>
                            {renderPage()}
                        </div>
                    </main>
                </div>
            </div>

            {saved && (
                <div className="fixed bottom-8 right-8 bg-primary text-primary-foreground px-4 py-2 rounded-lg shadow-lg animate-in fade-in slide-in-from-bottom-2">
                    {t.saved}
                </div>
            )}

            {showUpdateModal && updateInfo && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="bg-card border border-border rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
                        <div className="p-6 border-b border-border">
                            <h3 className="text-xl font-semibold text-green-500 flex items-center gap-2">{t.updateAvailable}</h3>
                            <p className="text-muted-foreground mt-1">
                                v{updateInfo.currentVersion} → v{updateInfo.latestVersion}
                            </p>
                        </div>
                        <div className="p-6 overflow-y-auto flex-1">
                            <h4 className="font-medium mb-2">{t.changelog}</h4>
                            <div className="bg-muted/50 rounded-md p-4 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto">
                                {updateInfo.releaseNotes || t.noChangelog}
                            </div>
                            {recommendedDownload && (
                                <div className="mt-4 text-xs text-muted-foreground">
                                    {t.downloadRecommended}: {recommendedDownload.label}
                                    {!recommendedDownload.url && linuxFlavor === 'arch' && (
                                        <span className="ml-1">• {t.downloadAURHint}</span>
                                    )}
                                </div>
                            )}
                            {(isDownloadingUpdate || downloadNotice) && (
                                <div className="mt-4 space-y-2">
                                    {downloadNotice && (
                                        <div className="text-xs text-muted-foreground">{downloadNotice}</div>
                                    )}
                                    {isDownloadingUpdate && (
                                        <div className="h-2 w-full rounded bg-muted">
                                            <div className="h-2 w-1/2 rounded bg-green-500 animate-pulse"></div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="p-6 border-t border-border flex gap-3 justify-end">
                            <button
                                onClick={() => {
                                    setShowUpdateModal(false);
                                    setIsDownloadingUpdate(false);
                                    setDownloadNotice(null);
                                }}
                                disabled={isDownloadingUpdate}
                                className="px-4 py-2 rounded-md text-sm font-medium bg-muted hover:bg-muted/80 transition-colors"
                            >
                                {t.later}
                            </button>
                            <button
                                onClick={handleDownloadUpdate}
                                disabled={isDownloadingUpdate || !canDownloadUpdate}
                                className={cn(
                                    "px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2",
                                    isDownloadingUpdate || !canDownloadUpdate
                                        ? "bg-muted text-muted-foreground cursor-not-allowed"
                                        : "bg-green-600 text-white hover:bg-green-700"
                                )}
                            >
                                <ExternalLink className="w-4 h-4" />
                                {isDownloadingUpdate ? t.downloadStarting : t.download}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
