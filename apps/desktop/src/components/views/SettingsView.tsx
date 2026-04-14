import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import {
  Bell,
  Database,
  Info,
  Layers,
  Link2,
  ListChecks,
  Monitor,
  Sparkles,
} from "lucide-react";
import {
  resolveDateLocaleTag,
  DEFAULT_ANTHROPIC_THINKING_BUDGET,
  safeFormatDate,
  useTaskStore,
  type AppData,
} from "@mindwtr/core";

import { useKeybindings } from "../../contexts/keybinding-context";
import { useLanguage, type Language } from "../../contexts/language-context";
import { isFlatpakRuntime, isTauriRuntime } from "../../lib/runtime";
import { reportError } from "../../lib/report-error";
import { SyncService } from "../../lib/sync-service";
import { clearLog } from "../../lib/app-log";
import {
  markSettingsOpenTrace,
  wrapSettingsOpenImport,
} from "../../lib/settings-open-diagnostics";
import {
  labelFallback,
  labelKeyOverrides,
  type SettingsLabels,
} from "./settings/labels";
import { SettingsUpdateModal } from "./settings/SettingsUpdateModal";
import { SettingsSidebar } from "./settings/SettingsSidebar";
import { useAiSettings } from "./settings/useAiSettings";
import { useCalendarSettings } from "./settings/useCalendarSettings";
import { useObsidianSettings } from "./settings/useObsidianSettings";
import { useSettingsAboutPage } from "./settings/useSettingsAboutPage";
import { useSettingsMainPage } from "./settings/useSettingsMainPage";
import { useSyncSettings } from "./settings/useSyncSettings";
import { useConfirmDialog } from "../../hooks/useConfirmDialog";
import { usePerformanceMonitor } from "../../hooks/usePerformanceMonitor";
import { checkBudget } from "../../config/performanceBudgets";

type SettingsPage =
  | "main"
  | "gtd"
  | "manage"
  | "notifications"
  | "sync"
  | "integrations"
  | "ai"
  | "about";

const SettingsMainPage = lazy(
  wrapSettingsOpenImport("page-chunk:main", () =>
    import("./settings/SettingsMainPage").then((m) => ({
      default: m.SettingsMainPage,
    })),
  ),
);
const SettingsGtdPage = lazy(
  wrapSettingsOpenImport("page-chunk:gtd", () =>
    import("./settings/SettingsGtdPage").then((m) => ({
      default: m.SettingsGtdPage,
    })),
  ),
);
const SettingsManagePage = lazy(
  wrapSettingsOpenImport("page-chunk:manage", () =>
    import("./settings/SettingsManagePage").then((m) => ({
      default: m.SettingsManagePage,
    })),
  ),
);
const SettingsAiPage = lazy(
  wrapSettingsOpenImport("page-chunk:ai", () =>
    import("./settings/SettingsAiPage").then((m) => ({
      default: m.SettingsAiPage,
    })),
  ),
);
const SettingsNotificationsPage = lazy(
  wrapSettingsOpenImport("page-chunk:notifications", () =>
    import("./settings/SettingsNotificationsPage").then((m) => ({
      default: m.SettingsNotificationsPage,
    })),
  ),
);
const SettingsIntegrationsPage = lazy(
  wrapSettingsOpenImport("page-chunk:integrations", () =>
    import("./settings/SettingsIntegrationsPage").then((m) => ({
      default: m.SettingsIntegrationsPage,
    })),
  ),
);
const SettingsSyncPage = lazy(
  wrapSettingsOpenImport("page-chunk:sync", () =>
    import("./settings/SettingsSyncPage").then((m) => ({
      default: m.SettingsSyncPage,
    })),
  ),
);
const SettingsAboutPage = lazy(
  wrapSettingsOpenImport("page-chunk:about", () =>
    import("./settings/SettingsAboutPage").then((m) => ({
      default: m.SettingsAboutPage,
    })),
  ),
);

const LANGUAGES: { id: Language; label: string; native: string }[] = [
  { id: "en", label: "English", native: "English" },
  { id: "zh", label: "Chinese (Simplified)", native: "中文（简体）" },
  { id: "zh-Hant", label: "Chinese (Traditional)", native: "中文（繁體）" },
  { id: "es", label: "Spanish", native: "Español" },
  { id: "hi", label: "Hindi", native: "हिन्दी" },
  { id: "ar", label: "Arabic", native: "العربية" },
  { id: "de", label: "German", native: "Deutsch" },
  { id: "ru", label: "Russian", native: "Русский" },
  { id: "ja", label: "Japanese", native: "日本語" },
  { id: "fr", label: "French", native: "Français" },
  { id: "pt", label: "Portuguese", native: "Português" },
  { id: "pl", label: "Polish", native: "Polski" },
  { id: "ko", label: "Korean", native: "한국어" },
  { id: "it", label: "Italian", native: "Italiano" },
  { id: "tr", label: "Turkish", native: "Türkçe" },
];

const maskCalendarUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^(https?:\/\/)?([^/?#]+)([^?#]*)/i);
  if (!match) {
    return trimmed.length <= 8
      ? "..."
      : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
  }
  const protocol = match[1] ?? "";
  const host = match[2] ?? "";
  const path = match[3] ?? "";
  const lastSegment = path.split("/").filter(Boolean).pop() ?? "";
  const suffix = lastSegment ? `...${lastSegment.slice(-6)}` : "...";
  return `${protocol}${host}/${suffix}`;
};

export function SettingsView() {
  const perf = usePerformanceMonitor("SettingsView");
  const [page, setPage] = useState<SettingsPage>("main");
  const { language, setLanguage, t: translate } = useLanguage();
  const {
    style: keybindingStyle,
    setStyle: setKeybindingStyle,
    quickAddShortcut: globalQuickAddShortcut,
    setQuickAddShortcut: setGlobalQuickAddShortcut,
    openHelp,
  } = useKeybindings();
  const settings =
    useTaskStore((state) => state.settings) ?? ({} as AppData["settings"]);
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
  const isMac = useMemo(() => {
    if (!isTauri) return false;
    try {
      return /mac/i.test(navigator.userAgent);
    } catch {
      return false;
    }
  }, [isTauri]);
  const [saved, setSaved] = useState(false);
  const notificationsEnabled = settings?.notificationsEnabled !== false;
  const reviewAtNotificationsEnabled =
    settings?.reviewAtNotificationsEnabled !== false;
  const dailyDigestMorningEnabled =
    settings?.dailyDigestMorningEnabled === true;
  const dailyDigestEveningEnabled =
    settings?.dailyDigestEveningEnabled === true;
  const dailyDigestMorningTime = settings?.dailyDigestMorningTime || "09:00";
  const dailyDigestEveningTime = settings?.dailyDigestEveningTime || "20:00";
  const autoArchiveDays = Number.isFinite(settings?.gtd?.autoArchiveDays)
    ? Math.max(0, Math.floor(settings?.gtd?.autoArchiveDays as number))
    : 7;
  const loggingEnabled = settings?.diagnostics?.loggingEnabled === true;
  const attachmentsLastCleanupAt = settings?.attachments?.lastCleanupAt;
  const { requestConfirmation, confirmModal } = useConfirmDialog();

  const showSaved = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

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
    const key = "settings.selectSyncFolderTitle";
    const translated = translate(key);
    return translated === key ? "Select sync folder" : translated;
  }, [translate]);
  const selectObsidianVaultTitle = useMemo(() => {
    const key = "settings.selectObsidianVaultTitle";
    const translated = translate(key);
    return translated === key ? "Select Obsidian vault" : translated;
  }, [translate]);
  const cancelLabel = useMemo(() => {
    const key = "common.cancel";
    const translated = translate(key);
    return translated === key ? "Cancel" : translated;
  }, [translate]);

  // Heavy settings hooks are only needed when their page is active.
  const [isCleaningAttachments, setIsCleaningAttachments] = useState(false);

  const t = useMemo(() => {
    const labelsFallback =
      language === "zh" || language === "zh-Hant"
        ? labelFallback.zh
        : labelFallback.en;
    const result = {} as SettingsLabels;
    (Object.keys(labelFallback.en) as Array<keyof SettingsLabels>).forEach(
      (key) => {
        const i18nKey = labelKeyOverrides[key] ?? `settings.${key}`;
        const translated = translate(i18nKey);
        result[key] = translated !== i18nKey ? translated : labelsFallback[key];
      },
    );
    return result;
  }, [language, translate]);
  const requestSettingsConfirmation = useCallback(
    ({ title, message }: { title: string; message: string }) =>
      requestConfirmation({
        title,
        description: message,
        confirmLabel: "Continue",
        cancelLabel,
      }),
    [cancelLabel, requestConfirmation],
  );
  const mainPageProps = useSettingsMainPage({
    globalQuickAddShortcut,
    isFlatpak,
    isLinux,
    isTauri,
    keybindingStyle,
    language,
    openHelp,
    setGlobalQuickAddShortcut,
    setKeybindingStyle,
    setLanguage,
    settings,
    showSaved,
    updateSettings,
  });
  const { aboutPageProps, hasUpdateBadge, logPath, updateModalProps } =
    useSettingsAboutPage({ t });

  useLayoutEffect(() => {
    markSettingsOpenTrace("settings-view-layout-effect", { page });
  }, [page]);

  useEffect(() => {
    markSettingsOpenTrace("settings-view-effect", { page });
    const frameId = window.requestAnimationFrame(() => {
      markSettingsOpenTrace("settings-view-first-paint", { page });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [page]);

  useEffect(() => {
    if (!perf.enabled) return;
    const timer = window.setTimeout(() => {
      checkBudget("SettingsView", perf.metrics, "settings");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [perf.enabled]);

  const handleAttachmentsCleanup = useCallback(async () => {
    if (!isTauri) return;
    try {
      setIsCleaningAttachments(true);
      await SyncService.cleanupAttachmentsNow();
    } catch (error) {
      reportError("Attachment cleanup failed", error);
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
    })
      .then(showSaved)
      .catch((error) =>
        reportError("Failed to update logging settings", error),
      );
  };

  const handleClearLog = async () => {
    await clearLog();
    showSaved();
  };

  const attachmentsLastCleanupDisplay = useMemo(() => {
    if (!attachmentsLastCleanupAt) return "";
    return safeFormatDate(attachmentsLastCleanupAt, "Pp");
  }, [attachmentsLastCleanupAt]);
  const anthropicThinkingOptions = [
    {
      value: DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024,
      label: t.aiThinkingLow,
    },
    { value: 2048, label: t.aiThinkingMedium },
    { value: 4096, label: t.aiThinkingHigh },
  ];

  const lastSyncAt = settings?.lastSyncAt;
  const lastSyncStats = settings?.lastSyncStats ?? null;
  const lastSyncStatus = settings?.lastSyncStatus;
  const lastSyncHistory = settings?.lastSyncHistory ?? [];
  const lastSyncDisplay = lastSyncAt
    ? safeFormatDate(lastSyncAt, "PPpp", lastSyncAt)
    : t.lastSyncNever;
  const conflictCount =
    (lastSyncStats?.tasks.conflicts || 0) +
    (lastSyncStats?.projects.conflicts || 0);
  const weeklyReviewEnabled = settings?.weeklyReviewEnabled === true;
  const weeklyReviewTime = settings?.weeklyReviewTime || "18:00";
  const weeklyReviewDay = Number.isFinite(settings?.weeklyReviewDay)
    ? (settings?.weeklyReviewDay as number)
    : 0;
  const systemLocale =
    typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function"
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : "";
  const locale = resolveDateLocaleTag({
    language,
    dateFormat: mainPageProps.dateFormat,
    systemLocale,
  });
  const weekdayOptions = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const base = new Date(2021, 7, 1 + i);
        return {
          value: i,
          label: base.toLocaleDateString(locale, { weekday: "long" }),
        };
      }),
    [locale],
  );

  const pageTitle = useMemo(() => {
    switch (page) {
      case "gtd":
        return t.gtd;
      case "manage":
        return t.manage;
      case "notifications":
        return t.notifications;
      case "ai":
        return t.ai;
      case "sync":
        return t.sync;
      case "integrations":
        return t.integrations;
      case "about":
        return t.about;
      default:
        return t.general;
    }
  }, [page, t]);

  const navItems = useMemo<
    Array<{
      id: SettingsPage;
      icon: ComponentType<{ className?: string }>;
      label: string;
      description?: string;
      badge?: boolean;
      badgeLabel?: string;
    }>
  >(
    () => [
      {
        id: "main",
        icon: Monitor,
        label: t.general,
        keywords: [
          t.appearance,
          t.density,
          t.textSize,
          t.language,
          t.weekStart,
          t.dateFormat,
          t.keybindings,
          t.windowDecorations,
          t.closeBehavior,
          t.showTray,
          "theme",
          "font size",
          "text size",
          "dark mode",
          "light mode",
        ],
      },
      {
        id: "gtd",
        icon: ListChecks,
        label: t.gtd,
        keywords: [
          "auto-archive",
          "priorities",
          "time estimates",
          "pomodoro",
          "capture",
          "inbox processing",
          "2-minute rule",
          "task editor",
        ],
      },
      {
        id: "manage",
        icon: Layers,
        label: t.manage,
        keywords: ["areas", "contexts", "tags", "rename", "delete", "reorder"],
      },
      {
        id: "notifications",
        icon: Bell,
        label: t.notifications,
        keywords: [
          "review reminders",
          "weekly review",
          "daily digest",
          "morning",
          "evening",
        ],
      },
      {
        id: "sync",
        icon: Database,
        label: t.sync,
        keywords: [
          "file sync",
          "WebDAV",
          "cloud",
          "sync now",
          "attachments",
          "diagnostics",
          "logging",
        ],
      },
      {
        id: "integrations",
        icon: Link2,
        label: t.integrations,
        keywords: [
          "obsidian",
          "vault",
          "calendar",
          "ICS",
          "apple calendar",
          "integration",
        ],
      },
      {
        id: "ai",
        icon: Sparkles,
        label: t.ai,
        keywords: [
          "OpenAI",
          "Gemini",
          "Anthropic",
          "API key",
          "speech",
          "whisper",
          "copilot",
          "model",
        ],
      },
      {
        id: "about",
        icon: Info,
        label: t.about,
        badge: hasUpdateBadge,
        badgeLabel: t.updateAvailable,
        keywords: ["version", "update", "license", "sponsor"],
      },
    ],
    [hasUpdateBadge, t],
  );

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
    isTestingWebDav,
    webdavTestState,
    cloudUrl,
    setCloudUrl,
    cloudToken,
    setCloudToken,
    cloudProvider,
    dropboxAppKey,
    dropboxConfigured,
    dropboxConnected,
    dropboxBusy,
    dropboxRedirectUri,
    dropboxTestState,
    snapshots,
    isLoadingSnapshots,
    isRestoringSnapshot,
    transferAction,
    handleSaveSyncPath,
    handleChangeSyncLocation,
    handleSetSyncBackend,
    handleSaveWebDav,
    handleTestWebDavConnection,
    handleSaveCloud,
    handleSetCloudProvider,
    handleConnectDropbox,
    handleDisconnectDropbox,
    handleTestDropboxConnection,
    handleSync,
    handleRestoreSnapshot,
    handleExportBackup,
    handleRestoreBackup,
    handleImportTodoist,
    handleImportDgt,
  } = useSyncSettings({
    appVersion: aboutPageProps.appVersion,
    isTauri,
    showSaved,
    selectSyncFolderTitle,
    requestConfirmation: requestSettingsConfirmation,
  });
  const {
    obsidianVaultPath,
    setObsidianVaultPath,
    obsidianEnabled,
    setObsidianEnabled,
    obsidianScanFoldersText,
    setObsidianScanFoldersText,
    obsidianInboxFile,
    setObsidianInboxFile,
    obsidianTaskNotesIncludeArchived,
    setObsidianTaskNotesIncludeArchived,
    obsidianNewTaskFormat,
    setObsidianNewTaskFormat,
    obsidianLastScannedAt,
    obsidianHasVaultMarker,
    obsidianVaultWarning,
    obsidianIsWatching,
    obsidianWatcherError,
    isSavingObsidian,
    isScanningObsidian,
    onBrowseObsidianVault,
    onSaveObsidian,
    onRemoveObsidian,
    onRescanObsidian,
  } = useObsidianSettings({
    isTauri,
    showSaved,
    selectVaultFolderTitle: selectObsidianVaultTitle,
    messages: {
      missingMarker: t.obsidianMissingMarker,
      chooseFailed: t.obsidianChooseVaultFailed,
      saveFailed: t.obsidianSaveFailed,
      removeFailed: t.obsidianRemoveFailed,
      scanFailed: t.obsidianScanFailed,
      scanSuccess: t.obsidianScanSuccess,
    },
  });
  // Keep integrations state at SettingsView scope so the page does not remount and flicker on parent rerenders.
  const {
    externalCalendars,
    newCalendarName,
    newCalendarUrl,
    calendarError,
    systemCalendarPermission,
    setNewCalendarName,
    setNewCalendarUrl,
    handleAddCalendar,
    handleToggleCalendar,
    handleRemoveCalendar,
    handleRequestSystemCalendarPermission,
  } = useCalendarSettings({ showSaved, settings, updateSettings, isMac });
  const syncPreferences = settings?.syncPreferences ?? {};
  const handleUpdateSyncPreferences = useCallback(
    (updates: Partial<NonNullable<AppData["settings"]["syncPreferences"]>>) => {
      updateSettings({ syncPreferences: { ...syncPreferences, ...updates } })
        .then(showSaved)
        .catch((error) =>
          reportError("Failed to update sync preferences", error),
        );
    },
    [syncPreferences, showSaved, updateSettings],
  );

  const renderPage = () => {
    if (page === "main") {
      return <SettingsMainPage t={t} languages={LANGUAGES} {...mainPageProps} />;
    }

    if (page === "gtd") {
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

    if (page === "manage") {
      return <SettingsManagePage t={t} translate={translate} />;
    }

    if (page === "ai") {
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

    if (page === "notifications") {
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

    if (page === "integrations") {
      return (
        <SettingsIntegrationsPage
          t={t}
          isTauri={isTauri}
          newCalendarName={newCalendarName}
          newCalendarUrl={newCalendarUrl}
          calendarError={calendarError}
          externalCalendars={externalCalendars}
          showSystemCalendarSection={isMac}
          systemCalendarPermission={systemCalendarPermission}
          onCalendarNameChange={setNewCalendarName}
          onCalendarUrlChange={setNewCalendarUrl}
          onAddCalendar={handleAddCalendar}
          onToggleCalendar={handleToggleCalendar}
          onRemoveCalendar={handleRemoveCalendar}
          onRequestSystemCalendarPermission={
            handleRequestSystemCalendarPermission
          }
          maskCalendarUrl={maskCalendarUrl}
          obsidianVaultPath={obsidianVaultPath}
          obsidianEnabled={obsidianEnabled}
          obsidianScanFoldersText={obsidianScanFoldersText}
          obsidianInboxFile={obsidianInboxFile}
          obsidianTaskNotesIncludeArchived={obsidianTaskNotesIncludeArchived}
          obsidianNewTaskFormat={obsidianNewTaskFormat}
          obsidianLastScannedAt={obsidianLastScannedAt}
          obsidianHasVaultMarker={obsidianHasVaultMarker}
          obsidianVaultWarning={obsidianVaultWarning}
          obsidianIsWatching={obsidianIsWatching}
          obsidianWatcherError={obsidianWatcherError}
          isSavingObsidian={isSavingObsidian}
          isScanningObsidian={isScanningObsidian}
          onObsidianVaultPathChange={setObsidianVaultPath}
          onObsidianEnabledChange={setObsidianEnabled}
          onObsidianScanFoldersTextChange={setObsidianScanFoldersText}
          onObsidianInboxFileChange={setObsidianInboxFile}
          onObsidianTaskNotesIncludeArchivedChange={
            setObsidianTaskNotesIncludeArchived
          }
          onObsidianNewTaskFormatChange={setObsidianNewTaskFormat}
          onBrowseObsidianVault={onBrowseObsidianVault}
          onSaveObsidian={onSaveObsidian}
          onRemoveObsidian={onRemoveObsidian}
          onRescanObsidian={onRescanObsidian}
        />
      );
    }

    if (page === "sync") {
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
          isTestingWebDav={isTestingWebDav}
          webdavTestState={webdavTestState}
          onWebdavUrlChange={setWebdavUrl}
          onWebdavUsernameChange={setWebdavUsername}
          onWebdavPasswordChange={setWebdavPassword}
          onSaveWebDav={handleSaveWebDav}
          onTestWebDavConnection={handleTestWebDavConnection}
          cloudUrl={cloudUrl}
          cloudToken={cloudToken}
          cloudProvider={cloudProvider}
          dropboxAppKey={dropboxAppKey}
          dropboxConfigured={dropboxConfigured}
          dropboxConnected={dropboxConnected}
          dropboxBusy={dropboxBusy}
          dropboxRedirectUri={dropboxRedirectUri}
          dropboxTestState={dropboxTestState}
          onCloudUrlChange={setCloudUrl}
          onCloudTokenChange={setCloudToken}
          onCloudProviderChange={handleSetCloudProvider}
          onSaveCloud={handleSaveCloud}
          onConnectDropbox={handleConnectDropbox}
          onDisconnectDropbox={handleDisconnectDropbox}
          onTestDropboxConnection={handleTestDropboxConnection}
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
          snapshots={snapshots}
          isLoadingSnapshots={isLoadingSnapshots}
          isRestoringSnapshot={isRestoringSnapshot}
          transferAction={transferAction}
          onRestoreSnapshot={handleRestoreSnapshot}
          onExportBackup={handleExportBackup}
          onRestoreBackup={handleRestoreBackup}
          onImportTodoist={handleImportTodoist}
          onImportDgt={handleImportDgt}
        />
      );
    }

    if (page === "about") {
      return <SettingsAboutPage t={t} {...aboutPageProps} />;
    }

    return null;
  };

  const PageFallback = ({ currentPage }: { currentPage: SettingsPage }) => {
    useEffect(() => {
      markSettingsOpenTrace("settings-page-fallback-mounted", {
        page: currentPage,
      });
    }, [currentPage]);

    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        {translate("common.loading")}
      </div>
    );
  };

  return (
    <ErrorBoundary>
      <div className="h-full overflow-y-auto">
        <div className="h-full px-4 py-3">
          <div className="mx-auto flex h-full w-full max-w-[calc(12rem+920px+1.5rem)] flex-col gap-6 lg:flex-row">
            <SettingsSidebar
              title={t.title}
              subtitle={t.subtitle}
              searchPlaceholder={t.searchPlaceholder}
              items={navItems}
              activeId={page}
              onSelect={(id) => setPage(id as SettingsPage)}
            />

            <main className="min-w-0 flex-1 lg:max-w-[920px]">
              <div className="space-y-6">
                <header className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight">
                      {pageTitle}
                    </h2>
                  </div>
                </header>
                <Suspense fallback={<PageFallback currentPage={page} />}>
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
          t={t}
          {...updateModalProps}
        />
        {confirmModal}
      </div>
    </ErrorBoundary>
  );
}
