import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import {
    SETTINGS_SEARCH_PAGE_IDS,
    SETTINGS_SEARCH_PAGE_TITLE_KEYS,
    getSettingsSearchEntryKeys,
    resolveSettingsSearchI18nKey,
    type SettingsSearchPageId,
} from '@mindwtr/core';

import { getEnglishSettingsLabels } from './labels';
import { SettingsAboutPage } from './SettingsAboutPage';
import { SettingsAdvancedPage } from './SettingsAdvancedPage';
import { SettingsAiPage } from './SettingsAiPage';
import { SettingsDataPage } from './SettingsDataPage';
import { SettingsGtdPage } from './SettingsGtdPage';
import { SettingsIntegrationsPage } from './SettingsIntegrationsPage';
import { SettingsMainPage } from './SettingsMainPage';
import { SettingsManagePage } from './SettingsManagePage';
import { SettingsNotificationsPage } from './SettingsNotificationsPage';
import { SettingsSyncPage } from './SettingsSyncPage';

// Both directions of the search index contract (#884):
//
//   forwards  — every settings row that renders carries a `data-settings-key`
//               listed in the core roster for its page. A row added without a
//               roster entry is unfindable by search, which was the bug.
//   backwards — every roster key still renders as a row, so no search result
//               leads to a row that no longer exists.
//
// Pages are rendered with the props that reveal the most rows, and every
// collapsed disclosure is opened first (the same click the search reveal makes
// through `expandSettingsSection`). Rows behind a mutually exclusive choice — a
// sync backend, an AI provider — get one render variant each.

const t = getEnglishSettingsLabels();
const noop = () => undefined;
const asyncNoop = async () => undefined;

// Roster keys with no row of their own, each with the reason it cannot render
// here. Empty today: every indexed setting reaches the DOM under the props and
// variants below. Prefer another prop or variant over an entry here.
const CONDITIONALLY_RENDERED: Record<string, string> = {};

// A roster entry whose label IS the page title ("Sync" on the Sync page) is the
// "take me to this page" result — selecting it navigates, and there is nothing
// on the page to highlight. Derived rather than listed so adding a page can't
// forget it.
function isPageLevelEntry(pageId: SettingsSearchPageId, key: string): boolean {
    return resolveSettingsSearchI18nKey(key) === SETTINGS_SEARCH_PAGE_TITLE_KEYS[pageId];
}

function collectRenderedKeys(ui: ReactElement): Set<string> {
    const { container, unmount } = render(ui);
    // Disclosure contents are absent from the DOM until opened, and a few
    // disclosures nest, so keep opening until nothing is collapsed.
    for (let pass = 0; pass < 6; pass += 1) {
        const collapsed = container.querySelectorAll<HTMLElement>('[aria-expanded="false"]');
        if (collapsed.length === 0) break;
        collapsed.forEach((toggle) => fireEvent.click(toggle));
    }
    const keys = new Set<string>();
    container.querySelectorAll<HTMLElement>('[data-settings-key]').forEach((row) => {
        const key = row.getAttribute('data-settings-key');
        if (key) keys.add(key);
    });
    unmount();
    return keys;
}

const mainProps: Parameters<typeof SettingsMainPage>[0] = {
    t,
    languages: [{ id: 'en', native: 'English' }],
    themeMode: 'system',
    onThemeChange: noop,
    densityMode: 'comfortable',
    onDensityChange: noop,
    textSizeMode: 'default',
    onTextSizeChange: noop,
    showTaskAge: false,
    onShowTaskAgeChange: noop,
    language: 'en',
    onLanguageChange: noop,
    weekStart: 'sunday',
    onWeekStartChange: noop,
    dateFormat: 'system',
    onDateFormatChange: noop,
    calendarSystem: 'gregorian',
    // Only offered for locales that use a non-Gregorian calendar.
    showCalendarSystem: true,
    onCalendarSystemChange: noop,
    timeFormat: 'system',
    onTimeFormatChange: noop,
    keybindingStyle: 'vim',
    onKeybindingStyleChange: noop,
    globalQuickAddShortcut: 'Control+Alt+M',
    onGlobalQuickAddShortcutChange: noop,
    undoNotificationsEnabled: true,
    onUndoNotificationsChange: noop,
    onOpenHelp: noop,
    // Window behavior only exists in the desktop shell (decorations are Linux).
    showWindowDecorations: true,
    showCloseBehavior: true,
    showLaunchAtStartup: true,
    showTrayToggle: true,
};

const gtdProps: Parameters<typeof SettingsGtdPage>[0] = {
    t,
    language: 'en',
    settings: {
        // Pomodoro rows hang off the feature flag; the save-audio row needs the
        // audio capture default and speech-to-text both on.
        features: { pomodoro: true },
        gtd: { defaultCaptureMethod: 'audio', taskEditor: { presentation: 'inline' } },
        ai: { speechToText: { enabled: true } },
    },
    updateSettings: asyncNoop,
    showSaved: noop,
    autoArchiveDays: 7,
    areas: [],
};

const notificationsProps: Parameters<typeof SettingsNotificationsPage>[0] = {
    t,
    notificationsEnabled: true,
    startDateNotificationsEnabled: true,
    dueDateNotificationsEnabled: true,
    reviewAtNotificationsEnabled: true,
    weeklyReviewEnabled: true,
    weeklyReviewDay: 0,
    weeklyReviewTime: '09:00',
    weekdayOptions: [{ value: 0, label: 'Sunday' }],
    dailyDigestMorningEnabled: true,
    dailyDigestEveningEnabled: true,
    dailyDigestMorningTime: '08:00',
    dailyDigestEveningTime: '18:00',
    updateSettings: asyncNoop,
    showSaved: noop,
};

const syncProps: Parameters<typeof SettingsSyncPage>[0] = {
    t,
    isTauri: true,
    isMacOS: false,
    syncBackend: 'file',
    onSetSyncBackend: noop,
    syncPath: '',
    onSyncPathChange: noop,
    onSaveSyncPath: noop,
    onBrowseSyncPath: noop,
    isTestingSyncPath: false,
    onTestSyncPath: noop,
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    webdavHasPassword: false,
    webdavAllowInsecureHttp: false,
    webdavUrlError: false,
    isSavingWebDav: false,
    isTestingWebDav: false,
    webdavTestState: 'idle',
    onWebdavUrlChange: noop,
    onWebdavUsernameChange: noop,
    onWebdavPasswordChange: noop,
    onWebdavAllowInsecureHttpChange: noop,
    onSaveWebDav: noop,
    onTestWebDavConnection: noop,
    cloudUrl: '',
    cloudUrlError: false,
    cloudToken: '',
    cloudRememberToken: false,
    cloudAllowInsecureHttp: false,
    cloudProvider: 'selfhosted',
    dropboxConfigured: true,
    dropboxConnected: false,
    dropboxBusy: false,
    dropboxAuthInProgress: false,
    dropboxRedirectUri: 'http://127.0.0.1:53682/oauth/dropbox/callback',
    dropboxTestState: 'idle',
    onCloudUrlChange: noop,
    onCloudTokenChange: noop,
    onCloudRememberTokenChange: noop,
    onCloudAllowInsecureHttpChange: noop,
    onCloudProviderChange: noop,
    onSaveCloud: noop,
    calendarFeedUrl: null,
    calendarFeedBusy: false,
    onCopyCalendarFeedUrl: noop,
    onGenerateCalendarFeed: noop,
    onRevokeCalendarFeed: noop,
    onConnectDropbox: noop,
    onDisconnectDropbox: noop,
    onTestDropboxConnection: noop,
    encryption: {
        state: 'off',
        supported: true,
        pendingFirstSync: false,
        busy: false,
        progress: null,
        error: null,
        clearError: noop,
        generatePassphrase: () => 'correct horse battery staple extra words',
        enable: async () => true,
        disable: async () => true,
        changePassphrase: async () => true,
        unlock: async () => true,
        decline: asyncNoop,
    },
    isSyncTargetValid: true,
    syncPreferences: undefined,
    onUpdateSyncPreferences: noop,
    onSyncNow: noop,
    isSyncing: false,
    syncQueued: false,
    syncLastResult: null,
    syncLastResultAt: null,
    syncError: null,
    lastSyncDisplay: 'Never',
    lastSyncStatus: 'success',
    lastSyncStats: null,
    // The history disclosure only exists once there is something to show.
    lastSyncHistory: [{
        at: '2026-07-30T09:00:00.000Z',
        status: 'success',
        backend: 'file',
        type: 'merge',
        conflicts: 0,
        conflictIds: [],
        maxClockSkewMs: 0,
        timestampAdjustments: 0,
    }],
    conflictCount: 0,
    snapshots: [],
    isLoadingSnapshots: false,
    isRestoringSnapshot: false,
    onRestoreSnapshot: noop,
};

const dataProps: Parameters<typeof SettingsDataPage>[0] = {
    t,
    // Diagnostics is a Tauri-only section; the log path row needs logging on.
    isTauri: true,
    loggingEnabled: true,
    logPath: '/tmp/mindwtr.log',
    analyticsHeartbeatAvailable: true,
    analyticsHeartbeatEnabled: true,
    onToggleLogging: noop,
    onAnalyticsHeartbeatChange: noop,
    onClearLog: noop,
    transferAction: null,
    onExportBackup: noop,
    onExportCsv: noop,
    onExportTaskNotes: noop,
    onRestoreBackup: noop,
    onMergeBackup: noop,
    onImportTodoist: noop,
    onImportTickTick: noop,
    onImportDgt: noop,
    onImportOmniFocus: noop,
    onImportMindwtrCsv: noop,
    onAddGettingStartedContent: noop,
    attachmentsLastCleanupDisplay: 'Never',
    pendingRemoteDeleteCount: 0,
    onClearPendingRemoteDeletes: noop,
    onRunAttachmentsCleanup: noop,
    isCleaningAttachments: false,
};

const integrationsProps: Parameters<typeof SettingsIntegrationsPage>[0] = {
    t,
    isTauri: true,
    showSaved: noop,
    newCalendarName: '',
    newCalendarUrl: '',
    calendarError: null,
    // The subscription list only renders once a calendar is subscribed.
    externalCalendars: [{
        id: 'work',
        name: 'Work',
        url: 'https://calendar.example/work.ics',
        enabled: true,
        color: '#2563EB',
    }],
    // System calendars are macOS/Linux only, and the target picker needs both
    // the push toggle and granted permission.
    showSystemCalendarSection: true,
    systemCalendarPermission: 'granted',
    calendarPushEnabled: true,
    calendarPushTargetCalendarId: null,
    calendarPushTargets: [],
    calendarPushLoading: false,
    onCalendarNameChange: noop,
    onCalendarUrlChange: noop,
    onAddCalendar: noop,
    onChooseLocalCalendarFile: noop,
    onToggleCalendar: noop,
    onCalendarColorChange: noop,
    onRemoveCalendar: noop,
    onRequestSystemCalendarPermission: noop,
    onToggleCalendarPush: noop,
    onCalendarPushTargetChange: noop,
    onRefreshCalendarPushTargets: noop,
    maskCalendarUrl: (url: string) => url,
    obsidianVaultPath: '',
    obsidianEnabled: true,
    obsidianScanFoldersText: '',
    obsidianInboxFile: '',
    obsidianTaskNotesIncludeArchived: false,
    obsidianDataviewMetadataEnabled: false,
    obsidianNewTaskFormat: 'auto',
    obsidianLastScannedAt: null,
    obsidianHasVaultMarker: null,
    obsidianVaultWarning: null,
    obsidianIsWatching: false,
    obsidianWatcherError: null,
    isSavingObsidian: false,
    isScanningObsidian: false,
    onObsidianVaultPathChange: noop,
    onObsidianEnabledChange: noop,
    onObsidianScanFoldersTextChange: noop,
    onObsidianInboxFileChange: noop,
    onObsidianTaskNotesIncludeArchivedChange: noop,
    onObsidianDataviewMetadataEnabledChange: noop,
    onObsidianNewTaskFormatChange: noop,
    onBrowseObsidianVault: noop,
    onSaveObsidian: noop,
    onRemoveObsidian: noop,
    onRescanObsidian: noop,
};

const aiProps: Parameters<typeof SettingsAiPage>[0] = {
    t,
    anthropicThinkingOptions: [{ value: 1024, label: 'Low' }],
    aiEnabled: true,
    aiProvider: 'openai',
    aiModel: 'gpt-5-mini',
    aiModelOptions: ['gpt-5-mini'],
    aiBaseUrl: '',
    aiOpenAIExtraBodyParams: undefined,
    aiCopilotModel: 'gpt-4o-mini',
    aiCopilotOptions: ['gpt-4o-mini'],
    aiReasoningEffort: 'medium',
    aiThinkingBudget: 1024,
    anthropicThinkingEnabled: true,
    aiApiKey: '',
    speechEnabled: true,
    speechProvider: 'openai',
    speechModel: 'whisper-1',
    speechModelOptions: ['whisper-1'],
    speechBaseUrl: '',
    speechLanguage: '',
    speechMode: 'smart_parse',
    speechFieldStrategy: 'smart',
    speechApiKey: '',
    speechOfflineReady: false,
    speechOfflineModelPath: '',
    speechOfflineEstimatedSize: null,
    speechOfflineSize: null,
    speechDownloadState: 'idle',
    speechDownloadError: null,
    speechDownloadProgress: null,
    onUpdateAISettings: noop,
    onUpdateSpeechSettings: noop,
    onProviderChange: noop,
    onSpeechProviderChange: noop,
    onAiApiKeyChange: noop,
    onSpeechApiKeyChange: noop,
    onToggleAnthropicThinking: noop,
    onDownloadWhisperModel: noop,
    onDeleteWhisperModel: noop,
};

const advancedProps: Parameters<typeof SettingsAdvancedPage>[0] = {
    t,
    // Rendering and network sections, and the API token row, are Tauri-only.
    isTauri: true,
    localApiStatus: {
        enabled: true,
        running: true,
        port: 3456,
        url: 'http://127.0.0.1:3456',
        error: null,
        token: 'local-api-token',
    },
    localApiPortInput: '3456',
    localApiBusy: false,
    localApiPortError: '',
    networkProxyUrl: '',
    desktopRenderingConfig: { disableHardwareAcceleration: false },
    desktopRenderingBusy: false,
    onLocalApiToggle: noop,
    onLocalApiPortInputChange: noop,
    onLocalApiPortCommit: noop,
    onNetworkProxyUrlChange: noop,
    onSaveNetworkProxy: noop,
    onDesktopRenderingToggle: noop,
};

const aboutProps: Parameters<typeof SettingsAboutPage>[0] = {
    t,
    appVersion: '1.1.5',
    // The channel row is omitted when the install source is unknown.
    installChannel: 'github-release',
    onOpenLink: noop,
    onCheckUpdates: noop,
    isCheckingUpdate: false,
    updateError: null,
    updateNotice: null,
    feedbackConfigured: true,
    onSubmitFeedback: asyncNoop,
};

// One entry per page id; several renders where a page can only show one branch
// of an exclusive choice at a time.
const PAGE_VARIANTS: Record<SettingsSearchPageId, ReactElement[]> = {
    main: [<SettingsMainPage key="main" {...mainProps} />],
    gtd: [<SettingsGtdPage key="gtd" {...gtdProps} />],
    manage: [<SettingsManagePage key="manage" t={t} translate={(key) => key} requestConfirmation={async () => true} />],
    notifications: [<SettingsNotificationsPage key="notifications" {...notificationsProps} />],
    sync: [
        <SettingsSyncPage key="file" {...syncProps} />,
        <SettingsSyncPage key="webdav" {...syncProps} syncBackend="webdav" />,
        <SettingsSyncPage
            key="selfhosted"
            {...syncProps}
            syncBackend="cloud"
            cloudProvider="selfhosted"
            calendarFeedUrl="https://cloud.example/feed.ics"
        />,
        <SettingsSyncPage key="dropbox" {...syncProps} syncBackend="cloud" cloudProvider="dropbox" />,
    ],
    data: [<SettingsDataPage key="data" {...dataProps} />],
    integrations: [<SettingsIntegrationsPage key="integrations" {...integrationsProps} />],
    ai: [
        <SettingsAiPage key="openai" {...aiProps} />,
        <SettingsAiPage key="anthropic" {...aiProps} aiProvider="anthropic" speechProvider="whisper" />,
    ],
    advanced: [<SettingsAdvancedPage key="advanced" {...advancedProps} />],
    about: [<SettingsAboutPage key="about" {...aboutProps} />],
};

describe('desktop settings search coverage', () => {
    it.each(SETTINGS_SEARCH_PAGE_IDS)('indexes every rendered row on the %s page', (pageId) => {
        const rosterKeys = new Set(getSettingsSearchEntryKeys(pageId));
        const renderedKeys = new Set(
            PAGE_VARIANTS[pageId].flatMap((variant) => [...collectRenderedKeys(variant)]),
        );

        const unindexed = [...renderedKeys].filter((key) => !rosterKeys.has(key)).sort();
        expect(
            unindexed,
            `Settings rows on the "${pageId}" page carry a data-settings-key that search does not index: `
            + `${unindexed.join(', ')}. Add them to SETTINGS_SEARCH_PAGE_KEYS.${pageId} in `
            + 'packages/core/src/settings-search-keys.ts (with the section they render inside), '
            + 'or search will never find them (#884).',
        ).toEqual([]);
    });

    it.each(SETTINGS_SEARCH_PAGE_IDS)('renders a row for every indexed setting on the %s page', (pageId) => {
        const renderedKeys = new Set(
            PAGE_VARIANTS[pageId].flatMap((variant) => [...collectRenderedKeys(variant)]),
        );

        const missing = getSettingsSearchEntryKeys(pageId)
            .filter((key) => !renderedKeys.has(key))
            .filter((key) => !isPageLevelEntry(pageId, key))
            .filter((key) => !(key in CONDITIONALLY_RENDERED))
            .sort();
        expect(
            missing,
            `Search offers settings on the "${pageId}" page that no row renders: ${missing.join(', ')}. `
            + 'Either the row lost its data-settings-key, the entry should leave '
            + 'SETTINGS_SEARCH_PAGE_KEYS in packages/core/src/settings-search-keys.ts, or the row only '
            + 'renders under a condition this test should set up (last resort: CONDITIONALLY_RENDERED).',
        ).toEqual([]);
    });
});
