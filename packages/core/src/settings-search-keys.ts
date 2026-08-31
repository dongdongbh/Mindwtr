import { getEnglishI18nValue } from './i18n';

// Single source for which settings each settings page surfaces to search.
// Desktop builds its settings-search results from this directly (see
// apps/desktop/src/components/views/settings/settings-search.ts); mobile
// derives its row keywords from the same arrays (see
// apps/mobile/components/settings/settings.constants.ts).
//
// ⚠️ A settings row that is not listed here is unfindable by search on BOTH
// platforms — that was the whole of issue #884. When you add a row to a
// settings page, add its label key to that page's list below, with the
// `section` of the subheading or disclosure card it renders inside.
export type SettingsSearchPageId =
    | 'main'
    | 'gtd'
    | 'manage'
    | 'notifications'
    | 'sync'
    | 'data'
    | 'integrations'
    | 'ai'
    | 'advanced'
    | 'about';

// A searchable settings row. A bare string is a row that sits directly on the
// page; the object form names the subheading or disclosure card containing it,
// so results can show "Page → Section" and the desktop UI knows which
// disclosure to expand before scrolling the row into view. `section` is a
// label key resolved the same way as `key`.
export type SettingsSearchEntry = string | { key: string; section?: string };

export const SETTINGS_SEARCH_PAGE_KEYS: Record<SettingsSearchPageId, readonly SettingsSearchEntry[]> = {
    main: [
        'general',
        { key: 'appearance', section: 'lookAndFeel' },
        { key: 'density', section: 'lookAndFeel' },
        { key: 'textSize', section: 'lookAndFeel' },
        { key: 'showTaskAge', section: 'lookAndFeel' },
        { key: 'sidebarViews', section: 'lookAndFeel' },
        { key: 'language', section: 'localization' },
        { key: 'weekStart', section: 'localization' },
        { key: 'dateFormat', section: 'localization' },
        { key: 'calendarSystem', section: 'localization' },
        { key: 'timeFormat', section: 'localization' },
        { key: 'keybindings', section: 'input' },
        { key: 'globalQuickAddShortcut', section: 'input' },
        { key: 'undoNotifications', section: 'input' },
        { key: 'windowDecorations', section: 'windowBehavior' },
        { key: 'closeBehavior', section: 'windowBehavior' },
        { key: 'showTray', section: 'windowBehavior' },
        { key: 'launchAtStartup', section: 'windowBehavior' },
    ],
    gtd: [
        'gtd',
        'autoArchive',
        'defaultScheduleTime',
        'focusTaskLimit',
        'defaultProjectFlowMode',
        'features',
        { key: 'featureTimeline', section: 'features' },
        { key: 'featurePomodoro', section: 'features' },
        { key: 'pomodoroCustomPreset', section: 'features' },
        { key: 'pomodoroLinkTask', section: 'features' },
        { key: 'pomodoroAutoStartBreaks', section: 'features' },
        { key: 'pomodoroAutoStartFocus', section: 'features' },
        { key: 'pomodoroCompletionAlert', section: 'features' },
        'timeEstimatePresets',
        'captureDefault',
        { key: 'defaultArea', section: 'captureDefault' },
        { key: 'captureSaveAudio', section: 'captureDefault' },
        { key: 'quickAddAutoClean', section: 'captureDefault' },
        { key: 'naturalLanguageDates', section: 'captureDefault' },
        { key: 'markdownEditorAssist', section: 'captureDefault' },
        'weeklyReviewConfig',
        { key: 'weeklyReviewIncludeContextsStep', section: 'weeklyReviewConfig' },
        'inboxProcessing',
        { key: 'inboxDefaultMode', section: 'inboxProcessing' },
        { key: 'inboxTwoMinuteEnabled', section: 'inboxProcessing' },
        { key: 'inboxTwoMinuteFirst', section: 'inboxProcessing' },
        { key: 'inboxProjectFirst', section: 'inboxProcessing' },
        { key: 'inboxContextStepEnabled', section: 'inboxProcessing' },
        { key: 'inboxScheduleEnabled', section: 'inboxProcessing' },
        'taskEditorLayout',
        // The per-field visibility/order/section toggles inside this card are
        // covered by the card itself — they are one control per task-editor
        // field, not settings people search for by name.
        { key: 'taskEditorPresentation', section: 'taskEditorLayout' },
    ],
    manage: ['manage', 'manageAreas', 'managePeople', 'manageSomedaySections', 'manageContexts', 'manageTags'],
    notifications: [
        'notifications',
        'notificationsEnable',
        'startDateNotifications',
        'dueDateNotifications',
        'reviewAtNotifications',
        'weeklyReview',
        { key: 'weeklyReviewDay', section: 'weeklyReview' },
        { key: 'weeklyReviewTime', section: 'weeklyReview' },
        'dailyDigest',
        { key: 'dailyDigestMorning', section: 'dailyDigest' },
        { key: 'dailyDigestEvening', section: 'dailyDigest' },
    ],
    sync: [
        'sync',
        'syncBackend',
        // Backend-specific fields; only the selected backend's rows render.
        { key: 'syncFolderLocation', section: 'syncBackend' },
        { key: 'cloudUrl', section: 'syncBackend' },
        { key: 'cloudToken', section: 'syncBackend' },
        { key: 'webdavUrl', section: 'syncBackend' },
        { key: 'webdavUsername', section: 'syncBackend' },
        { key: 'webdavPassword', section: 'syncBackend' },
        { key: 'dropboxAppKey', section: 'syncBackend' },
        'calendarFeed',
        // Only rendered for the blob backends that can be encrypted (file, WebDAV,
        // Dropbox); the self-hosted and CloudKit variants have no such section.
        'syncEncryption',
        'syncPreferences',
        'backgroundSync',
        'syncHistory',
        'recoverySnapshots',
    ],
    data: [
        'backup',
        { key: 'exportBackup', section: 'backup' },
        { key: 'exportCsv', section: 'backup' },
        { key: 'exportTaskNotes', section: 'backup' },
        { key: 'restoreBackup', section: 'backup' },
        { key: 'mergeBackup', section: 'backup' },
        'importData',
        { key: 'importTodoist', section: 'importData' },
        { key: 'importTickTick', section: 'importData' },
        { key: 'importDgt', section: 'importData' },
        { key: 'importOmniFocus', section: 'importData' },
        { key: 'importMindwtrCsv', section: 'importData' },
        'attachmentsCleanup',
        'diagnostics',
        { key: 'analyticsHeartbeat', section: 'diagnostics' },
        { key: 'debugLogging', section: 'diagnostics' },
        { key: 'logFile', section: 'diagnostics' },
    ],
    integrations: [
        'integrations',
        'calendar',
        { key: 'calendarName', section: 'calendar' },
        { key: 'calendarUrl', section: 'calendar' },
        { key: 'calendarChooseLocalFile', section: 'calendar' },
        'externalCalendars',
        'calendarSystemTitle',
        { key: 'calendarPushTitle', section: 'calendarSystemTitle' },
        { key: 'calendarPushTarget', section: 'calendarSystemTitle' },
        'obsidianVault',
        { key: 'obsidianVaultPath', section: 'obsidianVault' },
        { key: 'obsidianScanFolders', section: 'obsidianVault' },
        { key: 'obsidianInboxFile', section: 'obsidianVault' },
        { key: 'obsidianDataviewMetadata', section: 'obsidianVault' },
        { key: 'obsidianTaskNotesIncludeArchived', section: 'obsidianVault' },
        { key: 'obsidianNewTaskFormat', section: 'obsidianVault' },
        'emailCapture',
        { key: 'emailCaptureHost', section: 'emailCapture' },
        { key: 'emailCapturePort', section: 'emailCapture' },
        { key: 'emailCaptureUsername', section: 'emailCapture' },
        { key: 'emailCapturePassword', section: 'emailCapture' },
        { key: 'emailCaptureFolder', section: 'emailCapture' },
    ],
    ai: [
        'ai',
        // The assistant's own settings only render once its card is expanded,
        // so they hang off the aiEnable toggle that expands it.
        'aiEnable',
        { key: 'aiProvider', section: 'aiEnable' },
        { key: 'aiModel', section: 'aiEnable' },
        { key: 'aiApiKey', section: 'aiEnable' },
        { key: 'aiBaseUrl', section: 'aiEnable' },
        { key: 'aiExtraBodyParams', section: 'aiEnable' },
        { key: 'aiCopilotModel', section: 'aiEnable' },
        { key: 'aiReasoning', section: 'aiEnable' },
        { key: 'aiThinkingEnable', section: 'aiEnable' },
        { key: 'aiThinkingBudget', section: 'aiEnable' },
        'speechTitle',
        { key: 'speechProvider', section: 'speechTitle' },
        { key: 'speechModel', section: 'speechTitle' },
        { key: 'speechBaseUrl', section: 'speechTitle' },
        { key: 'speechOfflineModel', section: 'speechTitle' },
        { key: 'speechLanguage', section: 'speechTitle' },
        { key: 'speechMode', section: 'speechTitle' },
        { key: 'speechFieldStrategy', section: 'speechTitle' },
    ],
    advanced: [
        'advanced',
        { key: 'localApiServer', section: 'automation' },
        { key: 'localApiPort', section: 'automation' },
        { key: 'localApiToken', section: 'automation' },
        { key: 'softwareRendering', section: 'rendering' },
        { key: 'networkProxyUrl', section: 'network' },
    ],
    about: [
        'about',
        'version',
        'installChannel',
        'checkForUpdates',
        'feedback',
        'documentation',
        'videoTutorials',
        'privacy',
        'github',
        'sponsorProject',
        'license',
    ],
};

// The page title each result's "Page → Section" path starts with.
export const SETTINGS_SEARCH_PAGE_TITLE_KEYS: Record<SettingsSearchPageId, string> = {
    main: 'settings.general',
    gtd: 'settings.gtd',
    manage: 'settings.manage',
    notifications: 'settings.notifications',
    sync: 'settings.sync',
    data: 'settings.data',
    integrations: 'settings.integrations',
    ai: 'settings.ai',
    advanced: 'settings.advanced',
    about: 'settings.about',
};

// Bare keys above whose real i18n key isn't the default `settings.<key>`.
// `keybindings` mirrors desktop's own `labelKeyOverrides`; the `manage*` keys
// exist only here, because the Manage page's cards are titled from the shared
// areas/contexts/tags namespaces rather than `settings.*`.
const SEARCH_KEY_I18N_OVERRIDES: Record<string, string> = {
    keybindings: 'keybindings.helpTitle',
    manageAreas: 'areas.manage',
    managePeople: 'people.title',
    manageSomedaySections: 'viewSections.somedaySections',
    manageContexts: 'contexts.title',
    manageTags: 'tags.title',
};

export function resolveSettingsSearchI18nKey(key: string): string {
    return SEARCH_KEY_I18N_OVERRIDES[key] ?? `settings.${key}`;
}

export type SettingsSearchIndexEntry = {
    pageId: SettingsSearchPageId;
    key: string;
    section?: string;
};

export function getSettingsSearchEntries(pageId: SettingsSearchPageId): SettingsSearchIndexEntry[] {
    return SETTINGS_SEARCH_PAGE_KEYS[pageId].map((entry) =>
        typeof entry === 'string'
            ? { pageId, key: entry }
            : { pageId, key: entry.key, ...(entry.section ? { section: entry.section } : {}) },
    );
}

// Bare label keys for a page, section information dropped — for consumers that
// only need "which settings live here" (mobile's row keywords).
export function getSettingsSearchEntryKeys(pageId: SettingsSearchPageId): string[] {
    return SETTINGS_SEARCH_PAGE_KEYS[pageId].map((entry) => (typeof entry === 'string' ? entry : entry.key));
}

export const SETTINGS_SEARCH_PAGE_IDS = Object.keys(SETTINGS_SEARCH_PAGE_KEYS) as SettingsSearchPageId[];

// Every indexed setting across every page, flattened — the list search UIs
// walk to build results.
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchIndexEntry[] =
    SETTINGS_SEARCH_PAGE_IDS.flatMap((pageId) => getSettingsSearchEntries(pageId));

// Desktop page-search keys that mobile does not need to index verbatim, each
// with the reason it's safe to skip: the feature doesn't exist on mobile, or
// the key is a value-option/section-heading label whose parent setting is
// indexed on its own. Every key in SETTINGS_SEARCH_PAGE_KEYS must be either
// resolvable on mobile or listed here — see settings-search-keys.test.ts.
export const SETTINGS_SEARCH_MOBILE_EXCLUSIONS: Record<string, string> = {
    density: 'No adjustable list density setting on mobile.',
    textSize: 'Mobile follows the OS text-size setting automatically; no in-app override.',
    keybindings: 'No hardware-keyboard shortcuts configuration on mobile.',
    globalQuickAddShortcut: 'System-wide hotkey; no equivalent on mobile.',
    windowDecorations: 'Desktop window chrome; not applicable on mobile.',
    closeBehavior: 'Desktop window-close behavior (ask/tray/quit); mobile apps background instead of closing.',
    showTray: 'No system tray on mobile.',
    launchAtStartup: 'No user-facing autostart setting on mobile.',
    undoNotifications: 'Desktop-only preference; not present on mobile.',
    inboxDefaultMode: 'Mobile inbox processing has no guided/quick default-mode row.',
    inboxTwoMinuteFirst: 'Mobile inbox processing has no two-minute-rule ordering row.',
    taskEditorPresentation: 'Desktop-only inline/modal task-editor choice; the mobile editor has one fixed presentation.',
    attachmentsCleanup: 'Desktop-only attachments cleanup section.',
    localApiServer: 'No local API server on mobile.',
    localApiPort: 'Part of the desktop-only local API server above.',
    localApiToken: 'Part of the desktop-only local API server above.',
    softwareRendering: 'Desktop WebView rendering switch; not applicable on mobile.',
    networkProxyUrl: 'Desktop-only HTTP proxy override.',
    calendarFeed: 'The self-hosted server\'s calendar subscription is published and revoked from desktop settings only (#952).',
    integrations: 'No mobile settings row for this desktop page (folds Obsidian + local calendar-file import, neither of which exists on mobile).',
    calendarName: 'Field of desktop\'s external-calendar add form; mobile\'s ICS subscription screen has its own labels.',
    calendarUrl: 'Field of desktop\'s external-calendar add form; mobile\'s ICS subscription screen has its own labels.',
    calendarSystemTitle: 'Desktop system-calendar (EventKit/EDS) integration; mobile uses expo-calendar with its own screen.',
    calendarPushTitle: 'Part of the desktop system-calendar integration above.',
    calendarPushTarget: 'Part of the desktop system-calendar integration above.',
    obsidianVault: 'No Obsidian vault integration on mobile (desktop-only, needs local filesystem access).',
    obsidianVaultPath: 'Part of the desktop-only Obsidian integration above.',
    obsidianScanFolders: 'Part of the desktop-only Obsidian integration above.',
    obsidianInboxFile: 'Part of the desktop-only Obsidian integration above.',
    obsidianDataviewMetadata: 'Part of the desktop-only Obsidian integration above.',
    obsidianTaskNotesIncludeArchived: 'Part of the desktop-only Obsidian integration above.',
    obsidianNewTaskFormat: 'Part of the desktop-only Obsidian integration above.',
    calendarChooseLocalFile: 'No local .ics file picker on mobile (same Integrations page as obsidianVault above).',
    emailCapture: 'No IMAP email capture on mobile (desktop-only background poller).',
    emailCaptureHost: 'Part of the desktop-only email capture above.',
    emailCapturePort: 'Part of the desktop-only email capture above.',
    emailCaptureUsername: 'Part of the desktop-only email capture above.',
    emailCapturePassword: 'Part of the desktop-only email capture above.',
    emailCaptureFolder: 'Part of the desktop-only email capture above.',
    version: 'Mobile\'s About screen renders the version from expo-constants under its own label.',
    installChannel: 'Desktop install source (AUR, Flatpak, MS Store, …); mobile builds come from the app stores.',
    github: 'No repository link row on mobile\'s About screen.',
};

// A settings row as search shows it: the translated setting name plus the
// "Page → Section" path that says where it lives.
export type SettingsSearchResult = {
    pageId: SettingsSearchPageId;
    key: string;
    title: string;
    pageTitle: string;
    sectionKey?: string;
    sectionTitle?: string;
    // Extra terms that match this row without appearing in its title (the
    // desktop sidebar's hand-curated page synonyms, e.g. "dark mode").
    keywords?: readonly string[];
};

// Build the searchable list of every indexed setting. `translate` takes an
// i18n key and returns the localized string; anything falsy, or the key echoed
// back (how the app translators signal "missing"), falls back to English.
export function buildSettingsSearchResults(
    translate: (i18nKey: string) => string | undefined,
    pageKeywords: Partial<Record<SettingsSearchPageId, readonly string[]>> = {},
): SettingsSearchResult[] {
    const resolve = (i18nKey: string): string | undefined => {
        const translated = translate(i18nKey);
        if (translated && translated !== i18nKey && translated.trim()) return translated.trim();
        return getEnglishI18nValue(i18nKey)?.trim() || undefined;
    };
    const results: SettingsSearchResult[] = [];
    for (const entry of SETTINGS_SEARCH_INDEX) {
        const title = resolve(resolveSettingsSearchI18nKey(entry.key));
        if (!title) continue;
        const pageTitle = resolve(SETTINGS_SEARCH_PAGE_TITLE_KEYS[entry.pageId]) ?? entry.pageId;
        const sectionTitle = entry.section
            ? resolve(resolveSettingsSearchI18nKey(entry.section))
            : undefined;
        results.push({
            pageId: entry.pageId,
            key: entry.key,
            title,
            pageTitle,
            ...(entry.section ? { sectionKey: entry.section } : {}),
            ...(sectionTitle ? { sectionTitle } : {}),
            // Synonyms belong to the page, so they ride on the row that IS the
            // page (title === page title) rather than matching every row on it.
            ...(title === pageTitle && pageKeywords[entry.pageId]
                ? { keywords: pageKeywords[entry.pageId] }
                : {}),
        });
    }
    return results;
}

// "General → Input", or just the page title for a row that sits directly on
// the page.
export function formatSettingsSearchPath(result: SettingsSearchResult): string {
    return result.sectionTitle ? `${result.pageTitle} → ${result.sectionTitle}` : result.pageTitle;
}

// Substring match over the setting name, its section, its page and any
// synonyms, ranked title-first so typing "add" leads with the settings that
// have "add" in their name rather than everything on a page that does.
export function matchSettingsSearchResults(
    results: readonly SettingsSearchResult[],
    query: string,
    limit = 12,
): SettingsSearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const ranked: Array<{ result: SettingsSearchResult; rank: number }> = [];
    for (const result of results) {
        const title = result.title.toLowerCase();
        const rank = title.startsWith(q)
            ? 0
            : title.includes(q)
                ? 1
                : [result.sectionTitle, result.pageTitle, ...(result.keywords ?? [])]
                    .some((value) => value?.toLowerCase().includes(q))
                    ? 2
                    : -1;
        if (rank >= 0) ranked.push({ result, rank });
    }
    return ranked
        .map((entry, index) => ({ ...entry, index }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.result);
}

// English text for a page's search keys, skipping excluded keys — the actual
// "resolves to a real string" invariant the original bug report was about.
export function getSettingsSearchPageEnglishText(pageId: SettingsSearchPageId): string[] {
    return getSettingsSearchEntryKeys(pageId)
        .filter((key) => !(key in SETTINGS_SEARCH_MOBILE_EXCLUSIONS))
        .map((key) => getEnglishI18nValue(resolveSettingsSearchI18nKey(key)))
        .filter((value): value is string => Boolean(value && value.trim()));
}
