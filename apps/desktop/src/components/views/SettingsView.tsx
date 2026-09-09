import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useTransition,
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
  DEFAULT_ANTHROPIC_THINKING_BUDGET,
  translateWithFallback,
  LOCALES,
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
import { collectFeedbackDiagnostics } from "../../lib/app-log";
import {
  markSettingsOpenTrace,
  wrapSettingsOpenImport,
} from "../../lib/settings-open-diagnostics";
import { buildSettingsLabels } from "./settings/labels";
import {
  buildDesktopSettingsSearchResults,
  clearSettingsRowHighlight,
  expandSettingsSection,
  findSettingsRow,
  highlightSettingsRow,
  type SettingsSearchResult,
} from "./settings/settings-search";
import { LIST_END_GAP } from "./list/list-toolbar";
import { SettingsUpdateModal } from "./settings/SettingsUpdateModal";
import { SettingsSidebar } from "./settings/SettingsSidebar";
// The default page travels with this already-lazy route. A second lazy
// boundary here delays the first useful Settings content after the shell loads.
import { SettingsMainPage } from "./settings/SettingsMainPage";
import { useAiSettings } from "./settings/useAiSettings";
import { useCalendarSettings } from "./settings/useCalendarSettings";
import { useObsidianSettings } from "./settings/useObsidianSettings";
import { useSettingsAboutPage } from "./settings/useSettingsAboutPage";
import { useSettingsAdvancedPage } from "./settings/useSettingsAdvancedPage";
import { useSettingsDataPage } from "./settings/useSettingsDataPage";
import { useSettingsMainPage } from "./settings/useSettingsMainPage";
import { useSettingsNotificationsPage } from "./settings/useSettingsNotificationsPage";
import { useSyncSettings } from "./settings/useSyncSettings";
import { useConfirmDialog } from "../../hooks/useConfirmDialog";
import { usePerformanceMonitor } from "../../hooks/usePerformanceMonitor";
import { checkBudget } from "../../config/performanceBudgets";
import {
  dismissDesktopOnboardingHint,
  isDesktopOnboardingHintDismissed,
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

// 'en' plus every locale in the LOCALES table (@mindwtr/core, from i18n/i18n-locales.ts) —
// see that module's header comment for why English isn't a table entry. `label` used to carry the
// English display name here too, but nothing reads it (SettingsMainPage's LanguageOption
// only has `native`), so it isn't reintroduced.
const LANGUAGES: { id: Language; native: string }[] = [
  { id: "en", native: "English" },
  ...Object.entries(LOCALES).map(([id, descriptor]) => ({ id: id as Language, native: descriptor.native })),
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
  const [isPagePending, startPageTransition] = useTransition();
  // Keep the current page usable while the next lazy chunk resolves. Urgent
  // switches replace it with a fallback and can pay Suspense's reveal delay.
  const selectPage = useCallback((next: SettingsPage) => {
    startPageTransition(() => setPage(next));
  }, [startPageTransition]);
  // Defer section-specific IO, not hook ownership: once visited, keep state
  // alive so navigating away and back cannot reload over an unfinished draft.
  const [visitedPages, setVisitedPages] = useState(() => new Set<SettingsPage>([initialPage ?? "main"]));
  useEffect(() => {
    setVisitedPages((visited) => visited.has(page) ? visited : new Set([...visited, page]));
  }, [page]);
  const hasVisited = (target: SettingsPage) => page === target || visitedPages.has(target);
  const integrationsLoadEnabled = hasVisited("integrations");
  const syncLoadEnabled = hasVisited("sync") || hasVisited("data");
  const advancedLoadEnabled = hasVisited("advanced");
  useEffect(() => {
    markSettingsOpenTrace("settings-resource-activation", {
      releaseCheck: "v1.3.0/settings-lazy-resources",
      page,
      integrationsLoadEnabled,
      syncLoadEnabled,
      advancedLoadEnabled,
    });
  }, [page, integrationsLoadEnabled, syncLoadEnabled, advancedLoadEnabled]);
  const [dismissedOnboardingHintPages, setDismissedOnboardingHintPages] = useState<
    Set<SettingsOnboardingHintPage>
  >(() => {
    const dismissed = new Set<SettingsOnboardingHintPage>();
    (["sync", "data"] as SettingsOnboardingHintPage[]).forEach((hintPage) => {
      if (isDesktopOnboardingHintDismissed(hintPage)) {
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
  const areas = useTaskStore((state) => state.areas);
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
  const autoArchiveDays = Number.isFinite(settings?.gtd?.autoArchiveDays)
    ? Math.max(0, Math.floor(settings?.gtd?.autoArchiveDays as number))
    : 7;
  const { requestConfirmation, confirmModal } = useConfirmDialog();

  const showSaved = useCallback(() => {
    // Visible settings update immediately; successful saves stay silent.
  }, []);

  useEffect(() => {
    if (!initialPage) return;
    selectPage(initialPage);
  }, [initialPage, selectPage]);

  const aiPageProps = useAiSettings({
    isTauri,
    settings,
    updateSettings,
    showSaved,
    enabled: page === "ai",
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

  const t = useMemo(() => buildSettingsLabels(translate), [language, translate]);

  const searchResults = useMemo(
    () => buildDesktopSettingsSearchResults((key) => translateWithFallback(translate, key, "")),
    [language, translate],
  );
  const [revealSetting, setRevealSetting] = useState<SettingsSearchResult | null>(null);

  // Take the user to the setting they picked: switch pages, open the
  // disclosure it hides inside, then scroll it into view and mark it. The page
  // chunk loads lazily, so retry across a few frames before giving up.
  useEffect(() => {
    if (!revealSetting) return;
    let cancelled = false;
    let frameId = 0;
    let highlighted: HTMLElement | null = null;
    let clearTimer = 0;
    const attempt = (remaining: number) => {
      if (cancelled) return;
      const expanded = expandSettingsSection(revealSetting.sectionKey);
      const row = expanded ? null : findSettingsRow(revealSetting.key);
      if (row) {
        highlighted = row;
        highlightSettingsRow(row);
        clearTimer = window.setTimeout(() => setRevealSetting(null), 4000);
        return;
      }
      if (remaining > 0) {
        frameId = window.requestAnimationFrame(() => attempt(remaining - 1));
      }
    };
    attempt(20);
    return () => {
      cancelled = true;
      if (frameId) window.cancelAnimationFrame(frameId);
      if (clearTimer) window.clearTimeout(clearTimer);
      if (highlighted) clearSettingsRowHighlight(highlighted);
    };
  }, [revealSetting]);

  const handleSelectSearchResult = useCallback((result: SettingsSearchResult) => {
    startPageTransition(() => {
      setPage(result.pageId as SettingsPage);
      // Reveal only after the requested page commits, including a slow chunk.
      // Fresh object so picking the same result twice re-runs the reveal effect.
      setRevealSetting({ ...result });
    });
  }, [startPageTransition]);

  const advancedPageProps = useSettingsAdvancedPage({ loadEnabled: advancedLoadEnabled, isTauri, showSaved, t });

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
      ? await collectFeedbackDiagnostics()
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
    markSettingsOpenTrace("settings-view-layout-effect", {
      page,
      releaseCheck: page === "main"
        ? "v1.3.0/settings-default-coload"
        : "v1.3.0/settings-page-transition",
    });
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

  const anthropicThinkingOptions = [
    {
      value: DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024,
      label: t.aiThinkingLow,
    },
    { value: 2048, label: t.aiThinkingMedium },
    { value: 4096, label: t.aiThinkingHigh },
  ];

  const notificationsPageProps = useSettingsNotificationsPage({
    language,
    dateFormat: mainPageProps.dateFormat,
    calendarSystem: mainPageProps.calendarSystem,
    showSaved,
  });

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
        return t.data;
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
    dismissDesktopOnboardingHint(activeOnboardingHintPage);
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
      },
      {
        id: "gtd",
        icon: ListChecks,
        label: t.gtd,
      },
      {
        id: "manage",
        icon: Layers,
        label: t.manage,
      },
      {
        id: "notifications",
        icon: Bell,
        label: t.notifications,
      },
      {
        id: "sync",
        icon: RefreshCw,
        label: t.sync,
      },
      {
        id: "data",
        icon: Database,
        label: t.data,
      },
      {
        id: "integrations",
        icon: Link2,
        label: t.integrations,
      },
      {
        id: "ai",
        icon: Sparkles,
        label: t.ai,
      },
      {
        id: "advanced",
        icon: SlidersHorizontal,
        label: t.advanced,
      },
      {
        id: "about",
        icon: Info,
        label: t.about,
        badge: hasUpdateBadge,
        badgeLabel: t.updateAvailable,
      },
    ],
    [hasUpdateBadge, language, t],
  );

  const { syncPageProps, dataTransferProps } = useSyncSettings({
    loadEnabled: syncLoadEnabled,
    appVersion: aboutPageProps.appVersion,
    isTauri,
    showSaved,
    selectSyncFolderTitle,
    lastSyncNeverLabel: t.lastSyncNever,
    requestConfirmation: requestSettingsConfirmation,
  });
  const dataPageProps = useSettingsDataPage({
    isTauri,
    language,
    logPath,
    cancelLabel,
    translate,
    showSaved,
    requestConfirmation,
    t,
    dataTransferProps,
  });
  const obsidianPageProps = useObsidianSettings({
    loadEnabled: integrationsLoadEnabled,
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
  const calendarPageProps = useCalendarSettings({
    loadEnabled: integrationsLoadEnabled,
    showSaved,
    settings,
    updateSettings,
    supportsSystemCalendar: isMac || isLinux,
  });

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
          areas={areas}
        />
      );
    }

    if (page === "manage") {
      return <SettingsManagePage t={t} translate={translate} requestConfirmation={requestConfirmation} />;
    }

    if (page === "ai") {
      return (
        <SettingsAiPage
          t={t}
          anthropicThinkingOptions={anthropicThinkingOptions}
          {...aiPageProps}
        />
      );
    }

    if (page === "notifications") {
      return <SettingsNotificationsPage t={t} {...notificationsPageProps} />;
    }

    if (page === "integrations") {
      return (
        <SettingsIntegrationsPage
          t={t}
          isTauri={isTauri}
          showSaved={showSaved}
          maskCalendarUrl={maskCalendarUrl}
          {...calendarPageProps}
          {...obsidianPageProps}
        />
      );
    }

    if (page === "sync") {
      return <SettingsSyncPage t={t} {...syncPageProps} />;
    }

    if (page === "data") {
      return <SettingsDataPage t={t} {...dataPageProps} />;
    }

    if (page === "advanced") {
      return <SettingsAdvancedPage t={t} {...advancedPageProps} />;
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
        <div className="h-full px-4 pt-3">
          <div className="mx-auto flex h-full w-full max-w-[calc(12rem+920px+1.5rem)] flex-col gap-6 lg:flex-row">
            <SettingsSidebar
              title={t.title}
              subtitle={t.subtitle}
              searchPlaceholder={t.searchPlaceholder}
              items={navItems}
              activeId={page}
              onSelect={(id) => selectPage(id as SettingsPage)}
              searchResults={searchResults}
              onSelectSearchResult={handleSelectSearchResult}
              noResultsLabel={translateWithFallback(translate, "common.noMatches", "No matches")}
            />

            <main className="min-w-0 flex-1 lg:max-w-[920px]" aria-busy={isPagePending}>
              <div className={`space-y-6 ${LIST_END_GAP}`} data-list-end>
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

        <SettingsUpdateModal
          t={t}
          {...updateModalProps}
        />
        {confirmModal}
      </div>
    </ErrorBoundary>
  );
}
