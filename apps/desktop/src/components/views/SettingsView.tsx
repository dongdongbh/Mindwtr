import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import {
    Bell,
    CalendarDays,
    Database,
    Info,
    ListChecks,
    Monitor,
    Sparkles,
} from 'lucide-react';
import {
    type DateFormatSetting,
    normalizeDateFormatSetting,
    resolveDateLocaleTag,
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    flushPendingSave,
    safeFormatDate,
    useTaskStore,
    type AppData,
} from '@mindwtr/core';

import { useKeybindings } from '../../contexts/keybinding-context';
import { useLanguage, type Language } from '../../contexts/language-context';
import { isFlatpakRuntime, isTauriRuntime } from '../../lib/runtime';
import { reportError } from '../../lib/report-error';
import { SyncService } from '../../lib/sync-service';
import { clearLog, getLogPath } from '../../lib/app-log';
import {
    APP_STORE_LISTING_URL,
    checkForUpdates,
    compareVersions,
    HOMEBREW_CASK_URL,
    normalizeInstallSource,
    type UpdateInfo,
    type InstallSource,
    GITHUB_RELEASES_URL,
    MS_STORE_URL,
    verifyDownloadChecksum,
    WINGET_PACKAGE_URL,
} from '../../lib/update-service';
import { labelFallback, labelKeyOverrides, type SettingsLabels } from './settings/labels';
import { SettingsUpdateModal } from './settings/SettingsUpdateModal';
import { SettingsSidebar } from './settings/SettingsSidebar';
import { useAiSettings } from './settings/useAiSettings';
import { useCalendarSettings } from './settings/useCalendarSettings';
import { useSyncSettings } from './settings/useSyncSettings';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { THEME_STORAGE_KEY, applyThemeMode, coerceDesktopThemeMode, mapSyncedThemeToDesktop, resolveNativeTheme, type DesktopThemeMode } from '../../lib/theme';
import { type GlobalQuickAddShortcutSetting } from '../../lib/global-quick-add-shortcut';

type ThemeMode = DesktopThemeMode;
type DensityMode = 'comfortable' | 'compact';
type SettingsPage = 'main' | 'gtd' | 'notifications' | 'sync' | 'calendar' | 'ai' | 'about';
type LinuxDistroInfo = { id?: string; id_like?: string[] };
type DateFormatUiSetting = Exclude<DateFormatSetting, 'ymd'>;

const SettingsMainPage = lazy(() => import('./settings/SettingsMainPage').then((m) => ({ default: m.SettingsMainPage })));
const SettingsGtdPage = lazy(() => import('./settings/SettingsGtdPage').then((m) => ({ default: m.SettingsGtdPage })));
const SettingsAiPage = lazy(() => import('./settings/SettingsAiPage').then((m) => ({ default: m.SettingsAiPage })));
const SettingsNotificationsPage = lazy(() => import('./settings/SettingsNotificationsPage').then((m) => ({ default: m.SettingsNotificationsPage })));
const SettingsCalendarPage = lazy(() => import('./settings/SettingsCalendarPage').then((m) => ({ default: m.SettingsCalendarPage })));
const SettingsSyncPage = lazy(() => import('./settings/SettingsSyncPage').then((m) => ({ default: m.SettingsSyncPage })));
const SettingsAboutPage = lazy(() => import('./settings/SettingsAboutPage').then((m) => ({ default: m.SettingsAboutPage })));

const UPDATE_BADGE_AVAILABLE_KEY = 'mindwtr-update-available';
const UPDATE_BADGE_LAST_CHECK_KEY = 'mindwtr-update-last-check';
const UPDATE_BADGE_LATEST_KEY = 'mindwtr-update-latest';
const UPDATE_BADGE_INTERVAL_MS = 1000 * 60 * 60 * 24;

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
    { id: 'pl', label: 'Polish', native: 'Polski' },
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
    const perf = usePerformanceMonitor('SettingsView');
    const [page, setPage] = useState<SettingsPage>('main');
    const [themeMode, setThemeMode] = useState<ThemeMode>('system');
    const { language, setLanguage, t: translate } = useLanguage();
    const {
        style: keybindingStyle,
        setStyle: setKeybindingStyle,
        quickAddShortcut: globalQuickAddShortcut,
        setQuickAddShortcut: setGlobalQuickAddShortcut,
        openHelp,
    } = useKeybindings();
    const settings = useTaskStore((state) => state.settings) ?? ({} as AppData['settings']);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const isTauri = isTauriRuntime();
    const isFlatpak = isFlatpakRuntime();
    const isLinux = useMemo(() => {
        if (!isTauri) return false;
        try {
            return /linux/i.test(navigator.userAgent);
        } catch {
            return false;
        }
    }, [isTauri]);
    const [installSource, setInstallSource] = useState<InstallSource>('unknown');
    const windowDecorationsEnabled = settings?.window?.decorations !== false;
    const closeBehavior = settings?.window?.closeBehavior ?? 'ask';
    const trayVisible = settings?.window?.showTray !== false;
    const densityMode = (settings?.appearance?.density === 'compact' ? 'compact' : 'comfortable') as DensityMode;
    const dateFormat = normalizeDateFormatSetting(settings?.dateFormat);
    const dateFormatForUi: DateFormatUiSetting = dateFormat === 'ymd' ? 'system' : dateFormat;
    const [saved, setSaved] = useState(false);
    const [appVersion, setAppVersion] = useState('0.1.0');
    const [logPath, setLogPath] = useState('');
    const notificationsEnabled = settings?.notificationsEnabled !== false;
    const reviewAtNotificationsEnabled = settings?.reviewAtNotificationsEnabled !== false;
    const dailyDigestMorningEnabled = settings?.dailyDigestMorningEnabled === true;
    const dailyDigestEveningEnabled = settings?.dailyDigestEveningEnabled === true;
    const dailyDigestMorningTime = settings?.dailyDigestMorningTime || '09:00';
    const dailyDigestEveningTime = settings?.dailyDigestEveningTime || '20:00';
    const autoArchiveDays = Number.isFinite(settings?.gtd?.autoArchiveDays)
        ? Math.max(0, Math.floor(settings?.gtd?.autoArchiveDays as number))
        : 7;
    const loggingEnabled = settings?.diagnostics?.loggingEnabled === true;
    const attachmentsLastCleanupAt = settings?.attachments?.lastCleanupAt;
    const didWriteLogRef = useRef(false);

    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [updateError, setUpdateError] = useState<string | null>(null);
    const [updateNotice, setUpdateNotice] = useState<string | null>(null);
    const [showUpdateModal, setShowUpdateModal] = useState(false);
    const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
    const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
    const [linuxDistro, setLinuxDistro] = useState<LinuxDistroInfo | null>(null);
    const [hasUpdateBadge, setHasUpdateBadge] = useState(false);

    const showSaved = useCallback(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    }, []);

    const persistUpdateBadge = useCallback((next: boolean, latestVersion?: string) => {
        setHasUpdateBadge(next);
        try {
            localStorage.setItem(UPDATE_BADGE_AVAILABLE_KEY, next ? 'true' : 'false');
            if (next && latestVersion) {
                localStorage.setItem(UPDATE_BADGE_LATEST_KEY, latestVersion);
            } else {
                localStorage.removeItem(UPDATE_BADGE_LATEST_KEY);
            }
        } catch (error) {
            reportError('Failed to persist update badge state', error);
        }
    }, []);

    useEffect(() => {
        if (!isTauri) {
            setInstallSource('github-release');
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const rawSource = await invoke<string>('get_install_source');
                const source = normalizeInstallSource(rawSource);
                if (!cancelled) {
                    setInstallSource(source);
                }
            } catch (error) {
                if (!cancelled) {
                    setInstallSource('unknown');
                }
                reportError('Failed to detect install source', error);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isTauri]);

    const {
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
        speechOfflineReady,
        speechOfflineSize,
        speechDownloadState,
        speechDownloadError,
        onUpdateAISettings,
        onUpdateSpeechSettings,
        onProviderChange,
        onSpeechProviderChange,
        onToggleAnthropicThinking,
        onAiApiKeyChange,
        onSpeechApiKeyChange,
        onDownloadWhisperModel,
        onDeleteWhisperModel,
    } = useAiSettings({
        isTauri,
        settings,
        updateSettings,
        showSaved,
        enabled: true,
    });
    const selectSyncFolderTitle = useMemo(() => {
        const key = 'settings.selectSyncFolderTitle';
        const translated = translate(key);
        return translated === key ? 'Select sync folder' : translated;
    }, [translate]);

    // Heavy settings hooks are only needed when their page is active.
    const [isCleaningAttachments, setIsCleaningAttachments] = useState(false);



    const t = useMemo(() => {
        const labelsFallback = language === 'zh' ? labelFallback.zh : labelFallback.en;
        const result = {} as SettingsLabels;
        (Object.keys(labelFallback.en) as Array<keyof SettingsLabels>).forEach((key) => {
            const i18nKey = labelKeyOverrides[key] ?? `settings.${key}`;
            const translated = translate(i18nKey);
            result[key] = translated !== i18nKey ? translated : labelsFallback[key];
        });
        return result;
    }, [language, translate]);

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('SettingsView', perf.metrics, 'settings');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    useEffect(() => {
        const savedTheme = coerceDesktopThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
        if (savedTheme) {
            setThemeMode(savedTheme);
        }

        if (!isTauri) {
            setAppVersion('web');
            return;
        }

        let cancelled = false;
        const timer = window.setTimeout(() => {
            if (cancelled) return;
            import('@tauri-apps/api/app')
                .then(({ getVersion }) => getVersion())
                .then((version) => {
                    if (!cancelled) setAppVersion(version);
                })
                .catch((error) => reportError('Failed to read app version', error));

            import('@tauri-apps/api/core')
                .then(async ({ invoke }) => {
                    const distro = await invoke<LinuxDistroInfo | null>('get_linux_distro');
                    if (cancelled) return;
                    setLinuxDistro(distro);
                })
                .catch((error) => reportError('Failed to read system paths', error));

            getLogPath()
                .then((path) => {
                    if (path && !cancelled) setLogPath(path);
                })
                .catch((error) => reportError('Failed to read log path', error));
        }, 0);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [isTauri]);

    useEffect(() => {
        const syncedTheme = mapSyncedThemeToDesktop(settings?.theme);
        if (!syncedTheme || syncedTheme === themeMode) return;
        localStorage.setItem(THEME_STORAGE_KEY, syncedTheme);
        setThemeMode(syncedTheme);
    }, [settings?.theme, themeMode]);

    useEffect(() => {
        if (!isTauri || !appVersion || appVersion === 'web') return;
        try {
            const storedAvailable = localStorage.getItem(UPDATE_BADGE_AVAILABLE_KEY);
            const storedLatest = localStorage.getItem(UPDATE_BADGE_LATEST_KEY);
            if (storedAvailable === 'true' && storedLatest && compareVersions(storedLatest, appVersion) > 0) {
                setHasUpdateBadge(true);
                return;
            }
            setHasUpdateBadge(false);
            if (storedAvailable === 'true') {
                localStorage.setItem(UPDATE_BADGE_AVAILABLE_KEY, 'false');
                localStorage.removeItem(UPDATE_BADGE_LATEST_KEY);
            }
        } catch (error) {
            reportError('Failed to read update badge state', error);
        }
    }, [appVersion, installSource, isTauri]);

    useEffect(() => {
        if (!isTauri || !appVersion || appVersion === 'web') return;
        let lastCheck = 0;
        try {
            lastCheck = Number(localStorage.getItem(UPDATE_BADGE_LAST_CHECK_KEY) || 0);
        } catch (error) {
            reportError('Failed to read update check timestamp', error);
        }
        if (Date.now() - lastCheck < UPDATE_BADGE_INTERVAL_MS) return;
        try {
            localStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));
        } catch (error) {
            reportError('Failed to persist update check timestamp', error);
        }
        let cancelled = false;
        (async () => {
            try {
                const info = await checkForUpdates(appVersion, { installSource });
                if (cancelled) return;
                if (info.hasUpdate) {
                    persistUpdateBadge(true, info.latestVersion);
                } else {
                    persistUpdateBadge(false);
                }
            } catch (error) {
                reportError('Background update check failed', error);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [appVersion, installSource, isTauri, persistUpdateBadge]);

    useEffect(() => {
        if (!loggingEnabled) {
            didWriteLogRef.current = false;
            return;
        }
        if (didWriteLogRef.current) return;
        didWriteLogRef.current = true;
    }, [loggingEnabled]);

    useEffect(() => {
        applyThemeMode(themeMode);

        if (!isTauri) return;
        const tauriTheme = resolveNativeTheme(themeMode);
        import('@tauri-apps/api/app')
            .then(({ setTheme }) => setTheme(tauriTheme))
            .catch((error) => reportError('Failed to set theme', error));
    }, [isTauri, themeMode]);

    const saveThemePreference = (mode: ThemeMode) => {
        localStorage.setItem(THEME_STORAGE_KEY, mode);
        setThemeMode(mode);
        updateSettings({ theme: mode })
            .then(showSaved)
            .catch((error) => reportError('Failed to update theme', error));
    };

    const saveDensityPreference = (mode: DensityMode) => {
        updateSettings({
            appearance: {
                ...(settings?.appearance ?? {}),
                density: mode,
            },
        })
            .then(showSaved)
            .catch((error) => reportError('Failed to update density', error));
    };

    const saveLanguagePreference = (lang: Language) => {
        setLanguage(lang);
        updateSettings({ language: lang })
            .then(showSaved)
            .catch((error) => reportError('Failed to update language', error));
    };

    const saveWeekStartPreference = (value: 'sunday' | 'monday') => {
        updateSettings({ weekStart: value })
            .then(showSaved)
            .catch((error) => reportError('Failed to update week start', error));
    };

    const saveDateFormatPreference = (value: DateFormatUiSetting) => {
        updateSettings({ dateFormat: value })
            .then(showSaved)
            .catch((error) => reportError('Failed to update date format', error));
    };

    const handleWindowDecorationsChange = useCallback((enabled: boolean) => {
        updateSettings({
            window: {
                ...(settings?.window ?? {}),
                decorations: enabled,
            },
        })
            .then(showSaved)
            .catch((error) => reportError('Failed to update window decorations', error));

        if (!isTauri || !isLinux) return;
        import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => getCurrentWindow().setDecorations(enabled))
            .catch((error) => reportError('Failed to set window decorations', error));
    }, [isLinux, isTauri, settings?.window, showSaved, updateSettings]);

    const handleCloseBehaviorChange = useCallback((behavior: 'ask' | 'tray' | 'quit') => {
        updateSettings({
            window: {
                ...(settings?.window ?? {}),
                closeBehavior: behavior,
            },
        })
            .then(() => flushPendingSave())
            .then(showSaved)
            .catch((error) => reportError('Failed to update close behavior', error));
    }, [settings?.window, showSaved, updateSettings]);

    const handleTrayVisibleChange = useCallback((visible: boolean) => {
        updateSettings({
            window: {
                ...(settings?.window ?? {}),
                showTray: visible,
            },
        })
            .then(() => flushPendingSave())
            .then(showSaved)
            .catch((error) => reportError('Failed to update tray visibility setting', error));
    }, [settings?.window, showSaved, updateSettings]);

    const handleKeybindingStyleChange = (style: 'vim' | 'emacs') => {
        setKeybindingStyle(style);
        showSaved();
    };
    const handleGlobalQuickAddShortcutChange = (shortcut: GlobalQuickAddShortcutSetting) => {
        setGlobalQuickAddShortcut(shortcut);
        showSaved();
    };

    const openLink = async (url: string): Promise<boolean> => {
        const nextUrl = url.trim();
        let openError: unknown = null;
        if (isTauri) {
            try {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(nextUrl);
                return true;
            } catch (error) {
                openError = error;
            }
        }

        const opened = window.open(nextUrl, '_blank', 'noopener,noreferrer');
        if (!opened) {
            reportError('Failed to open external link', openError ?? new Error('Popup blocked'));
            return false;
        }
        return true;
    };

    const handleAttachmentsCleanup = useCallback(async () => {
        if (!isTauri) return;
        try {
            setIsCleaningAttachments(true);
            await SyncService.cleanupAttachmentsNow();
        } catch (error) {
            reportError('Attachment cleanup failed', error);
        } finally {
            setIsCleaningAttachments(false);
        }
    }, [isTauri]);

    const toggleLogging = async () => {
        const nextEnabled = !loggingEnabled;
        await updateSettings({
            diagnostics: {
                ...(settings?.diagnostics ?? {}),
                loggingEnabled: nextEnabled,
            },
        }).then(showSaved).catch((error) => reportError('Failed to update logging settings', error));
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
            try {
                localStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));
            } catch (error) {
                reportError('Failed to persist update check timestamp', error);
            }
            const info = await checkForUpdates(appVersion, { installSource });
            if (!info || !info.hasUpdate) {
                setUpdateNotice(t.upToDate);
                persistUpdateBadge(false);
                return;
            }
            setUpdateInfo(info);
            persistUpdateBadge(true, info.latestVersion);
            if (info.platform === 'linux' && linuxFlavor === 'arch') {
                setDownloadNotice(t.downloadAURHint);
            } else if (
                info.platform === 'macos'
                && (installSource === 'direct' || installSource === 'github-release' || installSource === 'unknown')
            ) {
                setDownloadNotice('Recommended on macOS: brew update && brew upgrade --cask mindwtr');
            } else {
                setDownloadNotice(null);
            }
            setIsDownloadingUpdate(false);
            setShowUpdateModal(true);
        } catch (error) {
            reportError('Update check failed', error);
            setUpdateError(String(error));
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handleDownloadUpdate = async () => {
        const targetUrl = preferredDownloadUrl;
        if (installSource === 'microsoft-store') {
            await openLink(MS_STORE_URL);
            setDownloadNotice(t.storeUpdateHint);
            return;
        }
        if (installSource === 'mac-app-store') {
            const opened = await openLink(APP_STORE_LISTING_URL);
            setDownloadNotice(opened ? 'Update via App Store.' : t.downloadFailed);
            return;
        }
        if (installSource === 'homebrew') {
            await openLink(HOMEBREW_CASK_URL);
            setDownloadNotice('Update via Homebrew: brew update && brew upgrade --cask mindwtr');
            return;
        }
        if (installSource === 'winget') {
            await openLink(WINGET_PACKAGE_URL);
            setDownloadNotice('Update via winget: winget upgrade --id dongdongbh.Mindwtr --exact');
            return;
        }
        if (updateInfo?.platform === 'macos') {
            const opened = await openLink(HOMEBREW_CASK_URL);
            setDownloadNotice(opened
                ? 'Recommended on macOS: brew update && brew upgrade --cask mindwtr'
                : t.downloadFailed);
            return;
        }
        if (updateInfo?.platform === 'linux' && linuxFlavor === 'arch') {
            setDownloadNotice(getLinuxPostDownloadNotice());
            return;
        }
        if (!targetUrl) {
            setDownloadNotice(t.downloadFailed);
            return;
        }
        setIsDownloadingUpdate(true);
        setDownloadNotice(t.downloadStarting);

        try {
            let checksumStatus: 'verified' | 'unavailable' | 'mismatch' = 'unavailable';
            if (updateInfo?.assets?.length) {
                try {
                    checksumStatus = await verifyDownloadChecksum(targetUrl, updateInfo.assets);
                } catch (error) {
                    reportError('Checksum verification failed unexpectedly', error);
                    checksumStatus = 'unavailable';
                }
                if (checksumStatus === 'mismatch') {
                    setDownloadNotice(t.downloadChecksumMismatch);
                    return;
                }
            }
            const opened = await openLink(targetUrl);
            if (!opened) {
                setDownloadNotice(t.downloadFailed);
                return;
            }
            if (updateInfo?.platform === 'linux') {
                setDownloadNotice(getLinuxPostDownloadNotice());
            } else {
                setDownloadNotice(t.downloadStarted);
            }
        } catch (error) {
            reportError('Failed to open update URL', error);
            setDownloadNotice(t.downloadFailed);
        } finally {
            setIsDownloadingUpdate(false);
        }
    };

    const attachmentsLastCleanupDisplay = useMemo(() => {
        if (!attachmentsLastCleanupAt) return '';
        return safeFormatDate(attachmentsLastCleanupAt, 'Pp');
    }, [attachmentsLastCleanupAt]);
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

    const getLinuxPostDownloadNotice = useCallback((): string => {
        if (linuxFlavor === 'arch') {
            if (installSource === 'aur-source') {
                return `${t.downloadAURHint}: yay -Syu mindwtr / paru -Syu mindwtr`;
            }
            if (installSource === 'aur-bin') {
                return `${t.downloadAURHint}: yay -Syu mindwtr-bin / paru -Syu mindwtr-bin`;
            }
            return `${t.downloadAURHint}: yay -Syu mindwtr / paru -Syu mindwtr`;
        }
        if (linuxFlavor === 'debian') {
            return `${t.linuxUpdateHint} APT repo update: sudo apt update && sudo apt install --only-upgrade mindwtr. Local file install: sudo apt install ./<downloaded-file>.deb`;
        }
        if (linuxFlavor === 'rpm') {
            return `${t.linuxUpdateHint} Repo update: sudo dnf upgrade mindwtr. Local file install: sudo dnf install ./<downloaded-file>.rpm`;
        }
        return `${t.linuxUpdateHint} AppImage tip: chmod +x <downloaded-file>.AppImage && ./<downloaded-file>.AppImage`;
    }, [installSource, linuxFlavor, t.downloadAURHint, t.linuxUpdateHint]);

    const recommendedDownload = useMemo(() => {
        if (!updateInfo) return null;
        if (installSource === 'homebrew') {
            return { label: 'Homebrew' };
        }
        if (installSource === 'winget') {
            return { label: 'winget' };
        }
        if (installSource === 'mac-app-store') {
            return { label: 'App Store' };
        }
        if (installSource === 'microsoft-store') {
            return { label: 'Microsoft Store' };
        }
        const assets = updateInfo.assets || [];
        const findAsset = (patterns: RegExp[]) => assets.find((asset) => patterns.some((pattern) => pattern.test(asset.name)));

        if (updateInfo.platform === 'windows') {
            const asset = findAsset([/\.msi$/i, /\.exe$/i]);
            return asset ? { label: '.msi/.exe', url: asset.url } : null;
        }

        if (updateInfo.platform === 'macos') {
            return { label: 'Homebrew (recommended)', url: HOMEBREW_CASK_URL };
        }

        if (updateInfo.platform === 'linux') {
            if (linuxFlavor === 'arch') {
                return { label: 'AUR' };
            }
            if (linuxFlavor === 'debian') {
                const asset = findAsset([/\.deb$/i]);
                return asset?.url ? { label: '.deb', url: asset.url } : null;
            }
            if (linuxFlavor === 'rpm') {
                const asset = findAsset([/\.rpm$/i]);
                return asset?.url ? { label: '.rpm', url: asset.url } : null;
            }
            const asset = findAsset([/\.AppImage$/i]);
            return asset?.url ? { label: '.AppImage', url: asset.url } : null;
        }

        return null;
    }, [installSource, linuxFlavor, updateInfo]);

    const preferredDownloadUrl = useMemo(() => {
        if (!updateInfo) return null;
        if (installSource === 'homebrew' || installSource === 'winget' || installSource === 'mac-app-store' || installSource === 'microsoft-store') {
            return null;
        }
        if (updateInfo.platform === 'linux') {
            if (linuxFlavor === 'arch') return null;
            if (linuxFlavor === 'debian' || linuxFlavor === 'rpm') {
                return recommendedDownload?.url ?? updateInfo.releaseUrl ?? GITHUB_RELEASES_URL;
            }
        }
        return recommendedDownload?.url ?? updateInfo.downloadUrl ?? updateInfo.releaseUrl ?? GITHUB_RELEASES_URL;
    }, [installSource, linuxFlavor, recommendedDownload, updateInfo]);

    const isArchLinuxUpdate = updateInfo?.platform === 'linux' && linuxFlavor === 'arch';
    const canDownloadUpdate = useMemo(() => {
        if (installSource === 'homebrew' || installSource === 'winget' || installSource === 'mac-app-store' || installSource === 'microsoft-store') {
            return true;
        }
        return Boolean(preferredDownloadUrl) && !isArchLinuxUpdate;
    }, [installSource, isArchLinuxUpdate, preferredDownloadUrl]);

    const lastSyncAt = settings?.lastSyncAt;
    const lastSyncStats = settings?.lastSyncStats ?? null;
    const lastSyncStatus = settings?.lastSyncStatus;
    const lastSyncHistory = settings?.lastSyncHistory ?? [];
    const lastSyncDisplay = lastSyncAt ? safeFormatDate(lastSyncAt, 'PPpp', lastSyncAt) : t.lastSyncNever;
    const conflictCount = (lastSyncStats?.tasks.conflicts || 0) + (lastSyncStats?.projects.conflicts || 0);
    const weeklyReviewEnabled = settings?.weeklyReviewEnabled === true;
    const weeklyReviewTime = settings?.weeklyReviewTime || '18:00';
    const weeklyReviewDay = Number.isFinite(settings?.weeklyReviewDay) ? settings?.weeklyReviewDay as number : 0;
    const weekStart = settings?.weekStart === 'monday' ? 'monday' : 'sunday';
    const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : '';
    const locale = resolveDateLocaleTag({ language, dateFormat, systemLocale });
    const weekdayOptions = useMemo(() => (
        Array.from({ length: 7 }, (_, i) => {
            const base = new Date(2021, 7, 1 + i);
            return { value: i, label: base.toLocaleDateString(locale, { weekday: 'long' }) };
        })
    ), [locale]);

    const pageTitle = useMemo(() => {
        switch (page) {
            case 'gtd':
                return t.gtd;
            case 'notifications':
                return t.notifications;
            case 'ai':
                return t.ai;
            case 'sync':
                return t.sync;
            case 'calendar':
                return t.calendar;
            case 'about':
                return t.about;
            default:
                return t.general;
        }
    }, [page, t]);

    const navItems = useMemo<Array<{
        id: SettingsPage;
        icon: ComponentType<{ className?: string }>;
        label: string;
        description?: string;
        badge?: boolean;
        badgeLabel?: string;
    }>>(() => [
        { id: 'main', icon: Monitor, label: t.general, keywords: [t.appearance, t.density, t.language, t.weekStart, t.dateFormat, t.keybindings, t.windowDecorations, t.closeBehavior, t.showTray, 'theme', 'dark mode', 'light mode'] },
        { id: 'gtd', icon: ListChecks, label: t.gtd, keywords: ['auto-archive', 'priorities', 'time estimates', 'pomodoro', 'capture', 'inbox processing', '2-minute rule', 'task editor'] },
        { id: 'notifications', icon: Bell, label: t.notifications, keywords: ['review reminders', 'weekly review', 'daily digest', 'morning', 'evening'] },
        { id: 'sync', icon: Database, label: t.sync, keywords: ['file sync', 'WebDAV', 'cloud', 'sync now', 'attachments', 'diagnostics', 'logging'] },
        { id: 'ai', icon: Sparkles, label: t.ai, keywords: ['OpenAI', 'Gemini', 'Anthropic', 'API key', 'speech', 'whisper', 'copilot', 'model'] },
        { id: 'calendar', icon: CalendarDays, label: t.calendar, keywords: ['external calendar', 'iCal', 'subscription', 'URL'] },
        { id: 'about', icon: Info, label: t.about, badge: hasUpdateBadge, badgeLabel: t.updateAvailable, keywords: ['version', 'update', 'license', 'sponsor'] },
    ], [hasUpdateBadge, t]);

    const {
        syncPath,
        setSyncPath,
        isSyncing,
        syncQueued,
        syncLastResult,
        syncLastResultAt,
        syncError,
        syncBackend,
        webdavUrl,
        setWebdavUrl,
        webdavUsername,
        setWebdavUsername,
        webdavPassword,
        setWebdavPassword,
        webdavHasPassword,
        isSavingWebDav,
        cloudUrl,
        setCloudUrl,
        cloudToken,
        setCloudToken,
        handleSaveSyncPath,
        handleChangeSyncLocation,
        handleSetSyncBackend,
        handleSaveWebDav,
        handleSaveCloud,
        handleSync,
    } = useSyncSettings({
        isTauri,
        showSaved,
        selectSyncFolderTitle,
    });
    const syncPreferences = settings?.syncPreferences ?? {};
    const handleUpdateSyncPreferences = useCallback((updates: Partial<NonNullable<AppData['settings']['syncPreferences']>>) => {
        updateSettings({ syncPreferences: { ...syncPreferences, ...updates } })
            .then(showSaved)
            .catch((error) => reportError('Failed to update sync preferences', error));
    }, [syncPreferences, showSaved, updateSettings]);

    const CalendarPage = () => {
        const {
            externalCalendars,
            newCalendarName,
            newCalendarUrl,
            calendarError,
            setNewCalendarName,
            setNewCalendarUrl,
            handleAddCalendar,
            handleToggleCalendar,
            handleRemoveCalendar,
        } = useCalendarSettings({ showSaved, settings, updateSettings });

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
    };

    const renderPage = () => {
        if (page === 'main') {
            return (
                <SettingsMainPage
                    t={t}
                    themeMode={themeMode}
                    onThemeChange={saveThemePreference}
                    densityMode={densityMode}
                    onDensityChange={saveDensityPreference}
                    language={language}
                    onLanguageChange={saveLanguagePreference}
                    weekStart={weekStart}
                    onWeekStartChange={saveWeekStartPreference}
                    dateFormat={dateFormatForUi}
                    onDateFormatChange={saveDateFormatPreference}
                    keybindingStyle={keybindingStyle}
                    onKeybindingStyleChange={handleKeybindingStyleChange}
                    globalQuickAddShortcut={globalQuickAddShortcut}
                    onGlobalQuickAddShortcutChange={handleGlobalQuickAddShortcutChange}
                    onOpenHelp={openHelp}
                    languages={LANGUAGES}
                    showWindowDecorations={isLinux}
                    windowDecorationsEnabled={windowDecorationsEnabled}
                    onWindowDecorationsChange={handleWindowDecorationsChange}
                    showCloseBehavior={isTauri && !isFlatpak}
                    closeBehavior={closeBehavior}
                    onCloseBehaviorChange={handleCloseBehaviorChange}
                    showTrayToggle={isTauri && !isFlatpak}
                    trayVisible={trayVisible}
                    onTrayVisibleChange={handleTrayVisibleChange}
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
                    aiBaseUrl={aiBaseUrl}
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
                    speechOfflineReady={speechOfflineReady}
                    speechOfflineSize={speechOfflineSize}
                    speechDownloadState={speechDownloadState}
                    speechDownloadError={speechDownloadError}
                    onUpdateAISettings={onUpdateAISettings}
                    onUpdateSpeechSettings={onUpdateSpeechSettings}
                    onProviderChange={onProviderChange}
                    onSpeechProviderChange={onSpeechProviderChange}
                    onToggleAnthropicThinking={onToggleAnthropicThinking}
                    onAiApiKeyChange={onAiApiKeyChange}
                    onSpeechApiKeyChange={onSpeechApiKeyChange}
                    onDownloadWhisperModel={onDownloadWhisperModel}
                    onDeleteWhisperModel={onDeleteWhisperModel}
                />
            );
        }

        if (page === 'notifications') {
            return (
                <SettingsNotificationsPage
                    t={t}
                    notificationsEnabled={notificationsEnabled}
                    reviewAtNotificationsEnabled={reviewAtNotificationsEnabled}
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
            return <CalendarPage />;
        }

        if (page === 'sync') {
            return (
                <SettingsSyncPage
                    t={t}
                    isTauri={isTauri}
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
                    isSavingWebDav={isSavingWebDav}
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
                    syncQueued={syncQueued}
                    syncLastResult={syncLastResult}
                    syncLastResultAt={syncLastResultAt}
                    syncError={syncError}
                    syncPreferences={syncPreferences}
                    onUpdateSyncPreferences={handleUpdateSyncPreferences}
                    lastSyncDisplay={lastSyncDisplay}
                    lastSyncStatus={lastSyncStatus}
                    lastSyncStats={lastSyncStats}
                    lastSyncHistory={lastSyncHistory}
                    conflictCount={conflictCount}
                    lastSyncError={settings?.lastSyncError}
                    attachmentsLastCleanupDisplay={attachmentsLastCleanupDisplay}
                    onRunAttachmentsCleanup={handleAttachmentsCleanup}
                    isCleaningAttachments={isCleaningAttachments}
                />
            );
        }

        if (page === 'about') {
            const updateActionLabel = installSource === 'microsoft-store'
                ? t.checkStoreUpdates
                : t.checkForUpdates;
            return (
                <SettingsAboutPage
                    t={t}
                    appVersion={appVersion}
                    onOpenLink={openLink}
                    onCheckUpdates={handleCheckUpdates}
                    isCheckingUpdate={isCheckingUpdate}
                    updateActionLabel={updateActionLabel}
                    updateError={updateError}
                    updateNotice={updateNotice}
                />
            );
        }

        return null;
    };

    return (
        <ErrorBoundary>
            <div className="h-full overflow-y-auto">
            <div className="h-full px-4 py-3">
                <div className="mx-auto flex h-full w-full max-w-[calc(12rem+920px+1.5rem)] flex-col gap-6 lg:flex-row">
                    <SettingsSidebar
                        title={t.title}
                        subtitle={t.subtitle}
                        items={navItems}
                        activeId={page}
                        onSelect={(id) => setPage(id as SettingsPage)}
                    />

                    <main className="min-w-0 flex-1 lg:max-w-[920px]">
                        <div className="space-y-6">
                            <header className="flex items-start justify-between gap-4">
                                <div>
                                    <h2 className="text-xl font-semibold tracking-tight">{pageTitle}</h2>
                                </div>
                            </header>
                            <Suspense
                                fallback={(
                                    <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
                                        {translate('common.loading')}
                                    </div>
                                )}
                            >
                                {renderPage()}
                            </Suspense>
                        </div>
                    </main>
                </div>
            </div>

            {saved && (
                <div className="fixed bottom-8 right-8 bg-primary text-primary-foreground px-4 py-2 rounded-lg shadow-lg animate-in fade-in slide-in-from-bottom-2">
                    {t.saved}
                </div>
            )}

            <SettingsUpdateModal
                isOpen={showUpdateModal}
                updateInfo={updateInfo}
                t={t}
                recommendedDownload={recommendedDownload}
                linuxFlavor={linuxFlavor}
                isDownloading={isDownloadingUpdate}
                downloadNotice={downloadNotice}
                canDownload={canDownloadUpdate}
                onClose={() => {
                    setShowUpdateModal(false);
                    setIsDownloadingUpdate(false);
                    setDownloadNotice(null);
                }}
                onDownload={handleDownloadUpdate}
            />
            </div>
        </ErrorBoundary>
    );
}
