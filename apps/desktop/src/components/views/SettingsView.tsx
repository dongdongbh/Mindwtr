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
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import {
  resolveDateLocaleTag,
  DEFAULT_ANTHROPIC_THINKING_BUDGET,
  safeFormatDate,
  translateText,
  translateWithFallback,
  submitFeedbackSubmission,
  useTaskStore,
  type AppData,
} from "@mindwtr/core";

import { useKeybindings } from "../../contexts/keybinding-context";
import { useLanguage, type Language } from "../../contexts/language-context";
import { isFlatpakRuntime, isTauriRuntime } from "../../lib/runtime";
import {
  getCalendarSourceFileName,
  isLocalCalendarFileUrl,
  localCalendarFileUrlToPath,
} from "../../lib/external-calendar-source";
import { reportError } from "../../lib/report-error";
import { SyncService } from "../../lib/sync-service";
import { isSupportedProxyUrl, normalizeProxyUrl } from "../../lib/tauri-http";
import { clearLog, readRecentLogText } from "../../lib/app-log";
import {
  markSettingsOpenTrace,
  wrapSettingsOpenImport,
} from "../../lib/settings-open-diagnostics";
import {
  getSettingsLabelFallback,
  labelFallback,
  labelKeyOverrides,
  type SettingsLabels,
} from "./settings/labels";
import {
  isDesktopAnalyticsHeartbeatConfigured,
  resetDesktopAnalyticsOptOutMarker,
  sendDesktopAnalyticsOptOut,
} from "../../lib/analytics-heartbeat";
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
import { useUiStore } from "../../store/ui-store";
import {
  DEFAULT_LOCAL_API_PORT,
  getLocalApiServerStatus,
  normalizeLocalApiPortInput,
  setLocalApiServerConfig,
  type LocalApiServerStatus,
} from "../../lib/local-api-server";
import {
  dismissDesktopOnboardingHandoffHint,
  isDesktopOnboardingHandoffHintDismissed,
  type DesktopOnboardingHandoffPage,
} from "../../lib/desktop-onboarding-events";
import type { FeedbackSubmitInput } from "./settings/SettingsFeedbackModal";

export type SettingsPage =
  | "main"
  | "gtd"
  | "manage"
  | "notifications"
  | "sync"
  | "data"
  | "integrations"
  | "ai"
  | "advanced"
  | "about";

export type SettingsOnboardingHintPage = DesktopOnboardingHandoffPage;

const FEEDBACK_ENDPOINT_URL = String(import.meta.env.VITE_FEEDBACK_ENDPOINT_URL || '').trim();

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
const SettingsDataPage = lazy(
  wrapSettingsOpenImport("page-chunk:data", () =>
    import("./settings/SettingsDataPage").then((m) => ({
      default: m.SettingsDataPage,
    })),
  ),
);
const SettingsAdvancedPage = lazy(
  wrapSettingsOpenImport("page-chunk:advanced", () =>
    import("./settings/SettingsAdvancedPage").then((m) => ({
      default: m.SettingsAdvancedPage,
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
  { id: "cs", label: "Czech", native: "Čeština" },
  { id: "ko", label: "Korean", native: "한국어" },
  { id: "it", label: "Italian", native: "Italiano" },
  { id: "tr", label: "Turkish", native: "Türkçe" },
  { id: "nl", label: "Dutch", native: "Nederlands" },
];

const maskCalendarUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (isLocalCalendarFileUrl(trimmed)) {
    const path = localCalendarFileUrlToPath(trimmed);
    const filename = getCalendarSourceFileName(trimmed);
    return filename ? `Local file /.../${filename}` : `Local file ${path}`;
  }
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

type SettingsViewProps = {
  initialPage?: SettingsPage;
  onboardingHintPage?: SettingsOnboardingHintPage;
  onResumeOnboarding?: () => void;
};

export function SettingsView({ initialPage, onboardingHintPage, onResumeOnboarding }: SettingsViewProps = {}) {
  const perf = usePerformanceMonitor("SettingsView");
  const [page, setPage] = useState<SettingsPage>(initialPage ?? "main");
  const [dismissedOnboardingHintPages, setDismissedOnboardingHintPages] = useState<
    Set<SettingsOnboardingHintPage>
  >(() => {
    const dismissed = new Set<SettingsOnboardingHintPage>();
    (["sync", "data"] as SettingsOnboardingHintPage[]).forEach((hintPage) => {
      if (isDesktopOnboardingHandoffHintDismissed(hintPage)) {
        dismissed.add(hintPage);
      }
    });
    return dismissed;
  });
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
  const seedGettingStarted = useTaskStore((state) => state.seedGettingStarted);
  const visibleDataCount = useTaskStore((state) => (
    state.tasks.length + state.projects.length + state.sections.length + state.areas.length
  ));
  const showToast = useUiStore((state) => state.showToast);
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
  const [localApiStatus, setLocalApiStatus] = useState<LocalApiServerStatus>({
    enabled: false,
    running: false,
    port: DEFAULT_LOCAL_API_PORT,
    url: null,
    error: null,
  });
  const [localApiPortInput, setLocalApiPortInput] = useState(
    String(DEFAULT_LOCAL_API_PORT),
  );
  const [localApiBusy, setLocalApiBusy] = useState(false);
  const [localApiPortError, setLocalApiPortError] = useState("");
  const [networkProxyUrl, setNetworkProxyUrl] = useState(() =>
    normalizeProxyUrl(settings?.network?.proxyUrl),
  );
  const notificationsEnabled = settings?.notificationsEnabled !== false;
  const startDateNotificationsEnabled =
    settings?.startDateNotificationsEnabled !== false;
  const dueDateNotificationsEnabled =
    settings?.dueDateNotificationsEnabled !== false;
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
  const analyticsHeartbeatAvailable = isDesktopAnalyticsHeartbeatConfigured();
  const analyticsHeartbeatEnabled =
    analyticsHeartbeatAvailable && settings?.analytics?.heartbeatEnabled !== false;
  const attachmentsLastCleanupAt = settings?.attachments?.lastCleanupAt;
  const pendingRemoteDeleteCount =
    settings?.attachments?.pendingRemoteDeletes?.length ?? 0;
  const { requestConfirmation, confirmModal } = useConfirmDialog();

  const showSaved = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

  useEffect(() => {
    if (!initialPage) return;
    setPage(initialPage);
  }, [initialPage]);

  useEffect(() => {
    setNetworkProxyUrl(normalizeProxyUrl(settings?.network?.proxyUrl));
  }, [settings?.network?.proxyUrl]);

  const applyLocalApiStatus = useCallback((status: LocalApiServerStatus) => {
    setLocalApiStatus(status);
    setLocalApiPortInput(String(status.port || DEFAULT_LOCAL_API_PORT));
    setLocalApiPortError("");
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    getLocalApiServerStatus()
      .then((status) => {
        if (!cancelled) applyLocalApiStatus(status);
      })
      .catch((error) => {
        if (!cancelled) {
          setLocalApiPortError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyLocalApiStatus, isTauri]);

  const {
    aiEnabled,
    aiProvider,
    aiModel,
    aiBaseUrl,
    aiOpenAIExtraBodyParams,
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
    return translateWithFallback(translate, "settings.selectSyncFolderTitle", "Select sync folder");
  }, [translate]);
  const selectObsidianVaultTitle = useMemo(() => {
    return translateWithFallback(translate, "settings.selectObsidianVaultTitle", "Select Obsidian vault");
  }, [translate]);
  const cancelLabel = useMemo(() => {
    return translateWithFallback(translate, "common.cancel", "Cancel");
  }, [translate]);

  // Heavy settings hooks are only needed when their page is active.
  const [isCleaningAttachments, setIsCleaningAttachments] = useState(false);

  const t = useMemo(() => {
    const labelsFallback = getSettingsLabelFallback(language);
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

  const handleSaveNetworkProxy = useCallback(async () => {
    const trimmedProxyUrl = normalizeProxyUrl(networkProxyUrl);
    if (!isSupportedProxyUrl(trimmedProxyUrl)) {
      showToast(t.networkProxyInvalid, "error");
      return;
    }
    await updateSettings({
      network: {
        proxyUrl: trimmedProxyUrl || undefined,
      },
    });
    setNetworkProxyUrl(trimmedProxyUrl);
    showSaved();
  }, [networkProxyUrl, showSaved, showToast, t.networkProxyInvalid, updateSettings]);

  const handleLocalApiToggle = useCallback(
    async (enabled: boolean) => {
      if (!isTauri || localApiBusy) return;
      const port = normalizeLocalApiPortInput(localApiPortInput);
      if (!port) {
        setLocalApiPortError(t.localApiPortInvalid);
        return;
      }
      setLocalApiBusy(true);
      try {
        const status = await setLocalApiServerConfig({ enabled, port });
        applyLocalApiStatus(status);
        if (enabled && !status.running && status.error) {
          setLocalApiPortError(status.error);
          return;
        }
        showSaved();
      } catch (error) {
        setLocalApiPortError(error instanceof Error ? error.message : String(error));
        reportError("Failed to update local API server", error);
      } finally {
        setLocalApiBusy(false);
      }
    },
    [
      applyLocalApiStatus,
      isTauri,
      localApiBusy,
      localApiPortInput,
      showSaved,
      t.localApiPortInvalid,
    ],
  );

  const handleLocalApiPortCommit = useCallback(async () => {
    if (!isTauri || localApiBusy) return;
    const port = normalizeLocalApiPortInput(localApiPortInput);
    if (!port) {
      setLocalApiPortError(t.localApiPortInvalid);
      return;
    }
    if (port === localApiStatus.port) {
      setLocalApiPortError("");
      return;
    }
    setLocalApiBusy(true);
    try {
      const status = await setLocalApiServerConfig({
        enabled: localApiStatus.enabled,
        port,
      });
      applyLocalApiStatus(status);
      if (localApiStatus.enabled && !status.running && status.error) {
        setLocalApiPortError(status.error);
        return;
      }
      showSaved();
    } catch (error) {
      setLocalApiPortError(error instanceof Error ? error.message : String(error));
      reportError("Failed to update local API server port", error);
    } finally {
      setLocalApiBusy(false);
    }
  }, [
    applyLocalApiStatus,
    isTauri,
    localApiBusy,
    localApiPortInput,
    localApiStatus.enabled,
    localApiStatus.port,
    showSaved,
    t.localApiPortInvalid,
  ]);

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
  const handleSubmitFeedback = useCallback(async (input: FeedbackSubmitInput) => {
    const diagnosticsLogs = input.includeDiagnostics && input.category === 'bug'
      ? await readRecentLogText()
      : null;
    await submitFeedbackSubmission(FEEDBACK_ENDPOINT_URL, {
      category: input.category,
      email: input.email,
      message: input.message,
      metadata: {
        appVersion: aboutPageProps.appVersion,
        installChannel: aboutPageProps.installChannel ?? undefined,
        locale: language,
        os: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        platform: 'desktop',
      },
      ...(diagnosticsLogs ? { diagnostics: { logs: diagnosticsLogs } } : {}),
    });
  }, [aboutPageProps.appVersion, aboutPageProps.installChannel, language]);

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

  const handleClearPendingRemoteDeletes = useCallback(async () => {
    if (pendingRemoteDeleteCount === 0) return;
    const confirmed = await requestSettingsConfirmation({
      title: t.attachmentsCleanupPendingDeletesConfirmTitle,
      message: t.attachmentsCleanupPendingDeletesConfirm,
    });
    if (!confirmed) return;
    await updateSettings({
      attachments: {
        ...(settings?.attachments ?? {}),
        pendingRemoteDeletes: undefined,
      },
    })
      .then(showSaved)
      .catch((error) =>
        reportError("Failed to clear pending attachment deletes", error),
      );
  }, [
    pendingRemoteDeleteCount,
    requestSettingsConfirmation,
    settings?.attachments,
    showSaved,
    t.attachmentsCleanupPendingDeletesConfirm,
    t.attachmentsCleanupPendingDeletesConfirmTitle,
    updateSettings,
  ]);

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

  const handleAnalyticsHeartbeatChange = useCallback(async (enabled: boolean) => {
    if (!analyticsHeartbeatAvailable) return;
    if (!enabled) {
      const confirmed = await requestConfirmation({
        title: t.analyticsHeartbeatDisableTitle,
        description: t.analyticsHeartbeatDisableDesc,
        confirmLabel: t.analyticsHeartbeatDisableConfirm,
        cancelLabel: t.analyticsHeartbeatKeepEnabled,
      });
      if (!confirmed) return;
    }

    await updateSettings({
      analytics: {
        ...(settings?.analytics ?? {}),
        heartbeatEnabled: enabled,
      },
    })
      .then(async () => {
        if (enabled) {
          await resetDesktopAnalyticsOptOutMarker();
          return;
        }
        await sendDesktopAnalyticsOptOut();
      })
      .then(showSaved)
      .catch((error) =>
        reportError("Failed to update analytics heartbeat setting", error),
      );
  }, [
    analyticsHeartbeatAvailable,
    requestConfirmation,
    settings?.analytics,
    showSaved,
    t.analyticsHeartbeatDisableConfirm,
    t.analyticsHeartbeatDisableDesc,
    t.analyticsHeartbeatDisableTitle,
    t.analyticsHeartbeatKeepEnabled,
    updateSettings,
  ]);

  const handleClearLog = async () => {
    await clearLog();
    showSaved();
  };

  const handleAddGettingStartedContent = useCallback(async () => {
    if (visibleDataCount > 0) {
      const confirmed = await requestConfirmation({
        title: "Add Getting Started content?",
        description: "This adds a guided Getting Started project and sample inbox items to your current data. Existing Getting Started content will not be duplicated.",
        confirmLabel: "Add content",
        cancelLabel,
      });
      if (!confirmed) return;
    }

    try {
      const result = await seedGettingStarted();
      if (result.id) {
        useUiStore.getState().setProjectView({ selectedProjectId: result.id });
        showToast("Getting Started content is ready in Projects.", "success");
        return;
      }
      showToast("Getting Started content was not created.", "info");
    } catch (error) {
      showToast("Failed to add Getting Started content.", "error");
      reportError("Failed to add Getting Started content", error);
    }
  }, [cancelLabel, requestConfirmation, seedGettingStarted, showToast, visibleDataCount]);

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
    calendarSystem: mainPageProps.calendarSystem,
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
      case "advanced":
        return t.advanced;
      case "sync":
        return t.sync;
      case "data":
        if (language === "zh") return "数据";
        if (language === "zh-Hant") return "數據";
        return translateText("Data", language);
      case "integrations":
        return t.integrations;
      case "about":
        return t.about;
      default:
        return t.general;
    }
  }, [language, page, t]);
  const activeOnboardingHintPage =
    onboardingHintPage === page && !dismissedOnboardingHintPages.has(onboardingHintPage)
      ? onboardingHintPage
      : undefined;
  const onboardingHintContent = useMemo(() => {
    if (activeOnboardingHintPage === "sync") {
      return {
        title: "Recommended sync path",
        body: "Dropbox is easiest for most cross-platform setups. Apple-only users can use iCloud. Use WebDAV or self-hosted if you already know you need custom storage.",
      };
    }
    if (activeOnboardingHintPage === "data") {
      return {
        title: "Import before organizing",
        body: "Pick the app you exported from, then use the Import guide for file formats and mappings. Imports add data; sync is configured separately.",
      };
    }
    return null;
  }, [activeOnboardingHintPage]);
  const dismissOnboardingHint = useCallback(() => {
    if (!activeOnboardingHintPage) return;
    dismissDesktopOnboardingHandoffHint(activeOnboardingHintPage);
    setDismissedOnboardingHintPages((current) => {
      if (current.has(activeOnboardingHintPage)) return current;
      const next = new Set(current);
      next.add(activeOnboardingHintPage);
      return next;
    });
  }, [activeOnboardingHintPage]);

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
          t.launchAtStartup,
          "theme",
          "font size",
          "text size",
          "dark mode",
          "light mode",
          "launch at startup",
          "autostart",
          "login item",
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
        icon: RefreshCw,
        label: t.sync,
        keywords: [
          "file sync",
          "WebDAV",
          "cloud",
          "sync now",
          "sync history",
          "recovery snapshots",
          "dropbox",
          "self-hosted",
          "iCloud",
          "settings sync",
        ],
      },
      {
        id: "data",
        icon: Database,
        label:
          language === "zh"
            ? "数据"
            : language === "zh-Hant"
              ? "數據"
              : translateText("Data", language),
        keywords: [
          "backup",
          "restore",
          "import",
          "Todoist",
          "DGT GTD",
          "OmniFocus",
          "attachments",
          "cleanup",
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
        id: "advanced",
        icon: SlidersHorizontal,
        label: t.advanced,
        keywords: [
          "automation",
          "local api",
          "localhost",
          "port",
          "mcp",
          "Claude",
          "LLM",
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
    [hasUpdateBadge, language, t],
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
    webdavAllowInsecureHttp,
    setWebdavAllowInsecureHttp,
    isSavingWebDav,
    isTestingWebDav,
    webdavTestState,
    cloudUrl,
    setCloudUrl,
    cloudToken,
    setCloudToken,
    cloudAllowInsecureHttp,
    setCloudAllowInsecureHttp,
    cloudProvider,
    dropboxAppKey,
    dropboxConfigured,
    dropboxConnected,
    dropboxBusy,
    dropboxAuthInProgress,
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
    handleImportOmniFocus,
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
    calendarPushEnabled,
    calendarPushTargetCalendarId,
    calendarPushTargets,
    calendarPushLoading,
    setNewCalendarName,
    setNewCalendarUrl,
    handleAddCalendar,
    handleChooseLocalCalendarFile,
    handleToggleCalendar,
    handleCalendarColorChange,
    handleRemoveCalendar,
    handleRequestSystemCalendarPermission,
    handleToggleCalendarPush,
    handleCalendarPushTargetChange,
    handleRefreshCalendarPushTargets,
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
          aiOpenAIExtraBodyParams={aiOpenAIExtraBodyParams}
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
          startDateNotificationsEnabled={startDateNotificationsEnabled}
          dueDateNotificationsEnabled={dueDateNotificationsEnabled}
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
          calendarPushEnabled={calendarPushEnabled}
          calendarPushTargetCalendarId={calendarPushTargetCalendarId}
          calendarPushTargets={calendarPushTargets}
          calendarPushLoading={calendarPushLoading}
          onCalendarNameChange={setNewCalendarName}
          onCalendarUrlChange={setNewCalendarUrl}
          onAddCalendar={handleAddCalendar}
          onChooseLocalCalendarFile={handleChooseLocalCalendarFile}
          onToggleCalendar={handleToggleCalendar}
          onCalendarColorChange={handleCalendarColorChange}
          onRemoveCalendar={handleRemoveCalendar}
          onRequestSystemCalendarPermission={
            handleRequestSystemCalendarPermission
          }
          onToggleCalendarPush={handleToggleCalendarPush}
          onCalendarPushTargetChange={handleCalendarPushTargetChange}
          onRefreshCalendarPushTargets={handleRefreshCalendarPushTargets}
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
          analyticsHeartbeatAvailable={analyticsHeartbeatAvailable}
          analyticsHeartbeatEnabled={analyticsHeartbeatEnabled}
          logPath={logPath}
          onToggleLogging={toggleLogging}
          onAnalyticsHeartbeatChange={handleAnalyticsHeartbeatChange}
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
          webdavAllowInsecureHttp={webdavAllowInsecureHttp}
          isSavingWebDav={isSavingWebDav}
          isTestingWebDav={isTestingWebDav}
          webdavTestState={webdavTestState}
          onWebdavUrlChange={setWebdavUrl}
          onWebdavUsernameChange={setWebdavUsername}
          onWebdavPasswordChange={setWebdavPassword}
          onWebdavAllowInsecureHttpChange={setWebdavAllowInsecureHttp}
          onSaveWebDav={handleSaveWebDav}
          onTestWebDavConnection={handleTestWebDavConnection}
          cloudUrl={cloudUrl}
          cloudToken={cloudToken}
          cloudAllowInsecureHttp={cloudAllowInsecureHttp}
          cloudProvider={cloudProvider}
          dropboxAppKey={dropboxAppKey}
          dropboxConfigured={dropboxConfigured}
          dropboxConnected={dropboxConnected}
          dropboxBusy={dropboxBusy}
          dropboxAuthInProgress={dropboxAuthInProgress}
          dropboxRedirectUri={dropboxRedirectUri}
          dropboxTestState={dropboxTestState}
          onCloudUrlChange={setCloudUrl}
          onCloudTokenChange={setCloudToken}
          onCloudAllowInsecureHttpChange={setCloudAllowInsecureHttp}
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
          pendingRemoteDeleteCount={pendingRemoteDeleteCount}
          onClearPendingRemoteDeletes={handleClearPendingRemoteDeletes}
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
          onImportOmniFocus={handleImportOmniFocus}
        />
      );
    }

    if (page === "data") {
      return (
        <SettingsDataPage
          t={t}
          isTauri={isTauri}
          loggingEnabled={loggingEnabled}
          analyticsHeartbeatAvailable={analyticsHeartbeatAvailable}
          analyticsHeartbeatEnabled={analyticsHeartbeatEnabled}
          logPath={logPath}
          onToggleLogging={toggleLogging}
          onAnalyticsHeartbeatChange={handleAnalyticsHeartbeatChange}
          onClearLog={handleClearLog}
          transferAction={transferAction}
          onExportBackup={handleExportBackup}
          onRestoreBackup={handleRestoreBackup}
          onImportTodoist={handleImportTodoist}
          onImportDgt={handleImportDgt}
          onImportOmniFocus={handleImportOmniFocus}
          onAddGettingStartedContent={handleAddGettingStartedContent}
          attachmentsLastCleanupDisplay={attachmentsLastCleanupDisplay}
          pendingRemoteDeleteCount={pendingRemoteDeleteCount}
          onClearPendingRemoteDeletes={handleClearPendingRemoteDeletes}
          onRunAttachmentsCleanup={handleAttachmentsCleanup}
          isCleaningAttachments={isCleaningAttachments}
        />
      );
    }

    if (page === "advanced") {
      return (
        <SettingsAdvancedPage
          t={t}
          isTauri={isTauri}
          localApiStatus={localApiStatus}
          localApiPortInput={localApiPortInput}
          localApiBusy={localApiBusy}
          localApiPortError={localApiPortError}
          networkProxyUrl={networkProxyUrl}
          onLocalApiToggle={handleLocalApiToggle}
          onLocalApiPortInputChange={setLocalApiPortInput}
          onLocalApiPortCommit={handleLocalApiPortCommit}
          onNetworkProxyUrlChange={setNetworkProxyUrl}
          onSaveNetworkProxy={handleSaveNetworkProxy}
        />
      );
    }

    if (page === "about") {
      return (
        <SettingsAboutPage
          t={t}
          {...aboutPageProps}
          feedbackConfigured={Boolean(FEEDBACK_ENDPOINT_URL)}
          onSubmitFeedback={handleSubmitFeedback}
        />
      );
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
                {onboardingHintContent ? (
                  <div
                    className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-foreground"
                    role="note"
                  >
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{onboardingHintContent.title}</div>
                      <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                        {onboardingHintContent.body}
                      </div>
                    </div>
                    {onResumeOnboarding ? (
                      <button
                        type="button"
                        onClick={onResumeOnboarding}
                        className="shrink-0 rounded-md border border-primary/30 bg-background/50 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
                      >
                        Continue setup
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={dismissOnboardingHint}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label="Dismiss onboarding hint"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
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
