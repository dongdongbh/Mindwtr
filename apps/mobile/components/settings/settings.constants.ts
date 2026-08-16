import { WHISPER_MODELS as CORE_WHISPER_MODELS, WHISPER_MODEL_BASE_URL, type WhisperModelDescriptor } from '@mindwtr/core/whisper-models';
import {
    getSettingsSearchEntries,
    getSettingsSearchEntryKeys,
    LOCALES,
    resolveSettingsSearchI18nKey,
    SETTINGS_SEARCH_MOBILE_EXCLUSIONS,
    type SettingsSearchPageId,
} from '@mindwtr/core';

import type { Language } from '@/contexts/language-context';

export type SettingsScreen =
    | 'main'
    | 'general'
    | 'notifications'
    | 'ai'
    | 'calendar'
    | 'advanced'
    | 'gtd'
    | 'gtd-archive'
    | 'gtd-capture'
    | 'gtd-inbox'
    | 'gtd-pomodoro'
    | 'gtd-review'
    | 'gtd-time-estimates'
    | 'gtd-task-editor'
    | 'manage'
    | 'sync'
    | 'data'
    | 'about';

export const SETTINGS_SCREEN_SET: Record<SettingsScreen, true> = {
    main: true,
    general: true,
    notifications: true,
    ai: true,
    calendar: true,
    advanced: true,
    gtd: true,
    'gtd-archive': true,
    'gtd-capture': true,
    'gtd-inbox': true,
    'gtd-pomodoro': true,
    'gtd-review': true,
    'gtd-time-estimates': true,
    'gtd-task-editor': true,
    manage: true,
    sync: true,
    data: true,
    about: true,
};

// Root settings-menu rows the search field filters (see settings.tsx). Each id
// maps to the i18n keys of the settings its sub-screen(s) render, so the search
// keywords come from the *translated* setting labels and can't drift when new
// settings are added. Keep in step with the sub-screens under components/settings.
export type SettingsMenuRowId =
    | 'general'
    | 'gtd'
    | 'manage'
    | 'notifications'
    | 'sync'
    | 'data'
    | 'advanced'
    | 'about';

// Which desktop settings page(s) (see packages/core/src/settings-search-keys.ts)
// feed each mobile row's derived keywords below. Mobile has 8 rows to
// desktop's 10 pages: 'ai' folds into 'advanced', and 'integrations' (Obsidian
// + local calendar-file import) has no mobile row at all — mobile has neither
// feature, and both keys are on core's SETTINGS_SEARCH_MOBILE_EXCLUSIONS list.
const DESKTOP_PAGES_FOR_ROW: Record<SettingsMenuRowId, readonly SettingsSearchPageId[]> = {
    general: ['main'],
    gtd: ['gtd'],
    manage: ['manage'],
    notifications: ['notifications'],
    sync: ['sync'],
    data: ['data'],
    advanced: ['ai', 'advanced'],
    about: ['about'],
};

// Desktop search keys mobile renders under a DIFFERENT i18n key. Mobile
// namespaces mobile-only labels under settings.mobile.*, settings.gtdMobile.*
// and settings.syncMobile.* — same English text as the desktop default, a
// separate key so each platform's translation can diverge. Falls back to
// core's default resolution (`settings.<key>`) when a key isn't listed here.
const MOBILE_SEARCH_KEY_OVERRIDES: Partial<Record<string, string>> = {
    showTaskAge: 'settings.mobile.showTaskAge',
    defaultScheduleTime: 'settings.gtdMobile.defaultScheduleTime',
    backgroundSync: 'settings.syncMobile.backgroundSync',
    restoreBackup: 'settings.syncMobile.restoreBackup',
    importTodoist: 'settings.syncMobile.importFromTodoist',
    importTickTick: 'settings.syncMobile.importFromTicktick',
    importDgt: 'settings.syncMobile.importFromDgtGtd',
    importOmniFocus: 'settings.syncMobile.importFromOmnifocus',
};

function mobileI18nKey(key: string): string {
    return MOBILE_SEARCH_KEY_OVERRIDES[key] ?? resolveSettingsSearchI18nKey(key);
}

function derivedRowKeys(row: SettingsMenuRowId): string[] {
    return DESKTOP_PAGES_FOR_ROW[row].flatMap((pageId) =>
        getSettingsSearchEntryKeys(pageId)
            .filter((key) => !(key in SETTINGS_SEARCH_MOBILE_EXCLUSIONS))
            .map(mobileI18nKey),
    );
}

// Settings that only exist on mobile, or aren't part of desktop's curated
// page-search roster at all — layered on top of the derived desktop baseline
// above. Every key here must be a REAL i18n key that the row's sub-screen
// actually renders — verified against packages/core/src/i18n/locales/en.ts
// and the screen source. settings.search.test.ts asserts every key in the
// combined roster resolves, so a wrong or invented key fails CI rather than
// silently contributing nothing.
const MOBILE_ROW_EXTRA_KEYS: Record<SettingsMenuRowId, readonly string[]> = {
    general: ['settings.theme', 'settings.mobile.appLock', 'settings.privacy', 'settings.appSearchLabel'],
    gtd: ['settings.gtdMobile.pomodoroSettings', 'settings.dailyReviewConfig'],
    // manage-settings-screen renders areas/contexts/tags via non-settings keys.
    // People has no dedicated title key in en.ts, so it is intentionally omitted.
    manage: ['areas.manage', 'contexts.title', 'tags.title', 'settings.unassignedAreaColor'],
    notifications: [
        'settings.dailyDigest', 'settings.weeklyReview',
        'settings.dueDateNotifications', 'settings.startDateNotifications', 'settings.persistentCaptureLabel',
    ],
    // Sync screen (mode === 'sync'): backends + recovery snapshots.
    sync: [
        'settings.syncBackend', 'settings.syncBackendWebdav',
        'settings.cloudProviderDropbox', 'settings.syncHistory', 'settings.recoverySnapshots',
    ],
    // Data screen (mode === 'data'): backup/export, diagnostics (imports/restore are derived above).
    // No desktop bare key resolves to 'settings.data' itself (the data page's
    // roster starts at 'dataTransfer'), so it's listed here rather than derived.
    data: ['settings.data', 'settings.backup', 'settings.exportBackup', 'settings.diagnostics', 'settings.debugLogging'],
    // Advanced is a two-level menu; index the real AI + Calendar leaf settings
    // (the row's own title + 'ai' page title are derived above).
    advanced: [
        'settings.aiProvider', 'settings.aiModel', 'settings.aiApiKey',
        'settings.aiProviderOpenAI', 'settings.aiProviderAnthropic', 'settings.aiProviderGemini',
        'settings.aiProviderOrcaRouter',
        // Desktop indexes these on its Integrations page, which has no mobile
        // row; mobile renders them on the Calendar screen under Advanced.
        'settings.calendar', 'settings.calendarMobile.icsSubscriptions', 'settings.externalCalendars',
    ],
    about: ['settings.changelog', 'settings.checkForUpdates', 'settings.documentation'],
};

export const SETTINGS_MENU_KEYWORD_KEYS: Record<SettingsMenuRowId, readonly string[]> = {
    general: [...derivedRowKeys('general'), ...MOBILE_ROW_EXTRA_KEYS.general],
    gtd: [...derivedRowKeys('gtd'), ...MOBILE_ROW_EXTRA_KEYS.gtd],
    manage: [...derivedRowKeys('manage'), ...MOBILE_ROW_EXTRA_KEYS.manage],
    notifications: [...derivedRowKeys('notifications'), ...MOBILE_ROW_EXTRA_KEYS.notifications],
    sync: [...derivedRowKeys('sync'), ...MOBILE_ROW_EXTRA_KEYS.sync],
    data: [...derivedRowKeys('data'), ...MOBILE_ROW_EXTRA_KEYS.data],
    advanced: [...derivedRowKeys('advanced'), ...MOBILE_ROW_EXTRA_KEYS.advanced],
    about: [...derivedRowKeys('about'), ...MOBILE_ROW_EXTRA_KEYS.about],
};

// Build the searchable haystack for a menu row: its title, description, and the
// translated labels of the settings its sub-screen renders. `t` returns the key
// itself when a translation is missing, so those non-labels are dropped.
export function buildSettingsMenuSearchText(
    id: SettingsMenuRowId,
    title: string,
    description: string | undefined,
    t: (key: string) => string,
): string {
    const keywordLabels = (SETTINGS_MENU_KEYWORD_KEYS[id] ?? [])
        .map((key) => ({ key, value: t(key) }))
        // `t` returns the key when a translation is missing; drop those non-labels.
        .filter(({ key, value }) => value && value !== key)
        .map(({ value }) => value);
    return [title, description ?? '', ...keywordLabels].join(' ').toLowerCase();
}

// Which setting inside a menu row the query actually hit, and where it lives
// ("GTD → Default capture method"). The row itself still navigates to its
// sub-screen; this only tells the user why the row matched — the same
// page/section path desktop shows in its results list.
export type SettingsMenuMatch = { title: string; path: string };

export function findSettingsMenuMatch(
    id: SettingsMenuRowId,
    rowTitle: string,
    t: (key: string) => string,
    query: string,
): SettingsMenuMatch | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    // `t` echoes the key back when a translation is missing; those aren't labels.
    const label = (key: string): string | null => {
        const value = t(key);
        return value && value !== key ? value : null;
    };
    let fallback: SettingsMenuMatch | null = null;
    for (const pageId of DESKTOP_PAGES_FOR_ROW[id]) {
        for (const entry of getSettingsSearchEntries(pageId)) {
            if (entry.key in SETTINGS_SEARCH_MOBILE_EXCLUSIONS) continue;
            const title = label(mobileI18nKey(entry.key));
            if (!title || title === rowTitle) continue;
            const lower = title.toLowerCase();
            if (!lower.includes(q)) continue;
            const sectionTitle = entry.section ? label(mobileI18nKey(entry.section)) : null;
            const match: SettingsMenuMatch = {
                title,
                path: sectionTitle && sectionTitle !== title ? `${rowTitle} → ${sectionTitle}` : rowTitle,
            };
            if (lower.startsWith(q)) return match;
            fallback = fallback ?? match;
        }
    }
    return fallback;
}

export function settingsMenuMatchesQuery(searchText: string, query: string): boolean {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return true;
    return searchText.includes(trimmed);
}

// 'en' plus every locale in the LOCALES table (@mindwtr/core, from i18n/i18n-locales.ts) —
// see that module's header comment for why English isn't a table entry.
export const LANGUAGES: { id: Language; native: string }[] = [
    { id: 'en', native: 'English' },
    ...Object.entries(LOCALES).map(([id, descriptor]) => ({ id: id as Language, native: descriptor.native })),
];

export { WHISPER_MODEL_BASE_URL };

// Mobile only offers the small models people can realistically download over
// a phone connection — the full catalogue (including whisper-large-v3-turbo,
// desktop-only) lives in core as the single source of truth for hashes and
// sizes. This subset is a product decision, not a data copy: the numbers
// themselves always come from @mindwtr/core/whisper-models.
const MOBILE_WHISPER_MODEL_IDS = new Set(['whisper-tiny', 'whisper-tiny.en', 'whisper-base', 'whisper-base.en']);
export const WHISPER_MODELS: WhisperModelDescriptor[] = CORE_WHISPER_MODELS
    .filter((model) => MOBILE_WHISPER_MODEL_IDS.has(model.id));
export const DEFAULT_WHISPER_MODEL = WHISPER_MODELS[0]?.id ?? 'whisper-tiny';

export const UPDATE_BADGE_AVAILABLE_KEY = 'mindwtr-update-available';
export const UPDATE_BADGE_LAST_CHECK_KEY = 'mindwtr-update-last-check';
export const UPDATE_BADGE_LATEST_KEY = 'mindwtr-update-latest';
export const UPDATE_BADGE_INTERVAL_MS = 1000 * 60 * 60 * 24;
export const AI_PROVIDER_CONSENT_KEY = 'mindwtr-ai-provider-consent-v1';

export const FOSS_LOCAL_LLM_MODEL_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];
export const FOSS_LOCAL_LLM_COPILOT_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];

export type MobileExtraConfig = {
    analyticsHeartbeatUrl?: string;
    analyticsHeartbeatChannel?: string;
    analyticsReleaseVersion?: string;
    feedbackEndpointUrl?: string;
    isFossBuild?: boolean | string;
    dropboxAppKey?: string;
    promptTestControlsEnabled?: boolean | string;
};

export type CloudProvider = 'selfhosted' | 'dropbox' | 'cloudkit';

export const isValidHttpUrl = (value: string): boolean => {
    if (!value.trim()) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};
