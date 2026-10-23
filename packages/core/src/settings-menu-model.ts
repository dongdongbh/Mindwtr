/**
 * The mobile Settings menu as data: its rows (groups, order, icons, labels),
 * the Advanced sub-menu, the row badges, and the menu search. Shared by the
 * React Native screen (app/(drawer)/settings.tsx) and the native host contract
 * (native-host-contract-settings.ts).
 */
import {
    getSettingsSearchEntries,
    getSettingsSearchEntryKeys,
    resolveSettingsSearchI18nKey,
    SETTINGS_SEARCH_MOBILE_EXCLUSIONS,
    type SettingsSearchPageId,
} from './settings-search-keys';

type Translate = (key: string) => string;

// Root settings-menu rows the search field filters. Each id maps to the i18n
// keys of the settings its sub-screen(s) render, so the search keywords come
// from the *translated* setting labels and can't drift when new settings are
// added. Keep in step with the sub-screens under apps/mobile/components/settings.
export type SettingsMenuRowId =
    | 'general'
    | 'gtd'
    | 'manage'
    | 'notifications'
    | 'sync'
    | 'data'
    | 'advanced'
    | 'about';

/** The Advanced sub-menu's rows. */
export type SettingsAdvancedMenuRowId = 'ai' | 'calendar';

// Which desktop settings page(s) (see settings-search-keys.ts) feed each mobile
// row's derived keywords below. Mobile has 8 rows to desktop's 10 pages: 'ai'
// folds into 'advanced', and 'integrations' (Obsidian + local calendar-file
// import) has no mobile row at all — mobile has neither feature, and both keys
// are on SETTINGS_SEARCH_MOBILE_EXCLUSIONS.
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
// the default resolution (`settings.<key>`) when a key isn't listed here.
const MOBILE_SEARCH_KEY_OVERRIDES: Partial<Record<string, string>> = {
    showTaskAge: 'settings.mobile.showTaskAge',
    defaultScheduleTime: 'settings.gtdMobile.defaultScheduleTime',
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
            .filter((key) => key !== 'backgroundSync' && !(key in SETTINGS_SEARCH_MOBILE_EXCLUSIONS))
            .map(mobileI18nKey),
    );
}

// Settings that only exist on mobile, or aren't part of desktop's curated
// page-search roster at all — layered on top of the derived desktop baseline
// above. Every key here must be a REAL i18n key that the row's sub-screen
// actually renders. apps/mobile's settings.search.test.ts asserts every key in
// the combined roster resolves, so a wrong or invented key fails CI rather than
// silently contributing nothing.
const MOBILE_ROW_EXTRA_KEYS: Record<SettingsMenuRowId, readonly string[]> = {
    general: ['settings.theme', 'settings.mobile.appLock', 'settings.privacy', 'settings.appSearchLabel'],
    gtd: ['settings.gtdMobile.pomodoroSettings', 'settings.dailyReviewConfig', 'settings.gmailCapture', 'settings.gmailCaptureLabel'],
    // The Manage screen renders areas/contexts/tags via non-settings keys.
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
        // Desktop indexes these on its Integrations page, which has no mobile
        // row; mobile renders them on the Calendar screen under Advanced.
        'settings.calendar', 'settings.calendarMobile.icsSubscriptions', 'settings.externalCalendars',
    ],
    about: ['settings.changelog', 'settings.checkForUpdates', 'settings.documentation', 'settings.officialWebsite'],
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
    t: Translate,
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
    t: Translate,
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

/** A lucide icon name; mobile maps it to its own icon component. */
export type SettingsMenuIcon =
    | 'Monitor' | 'ListChecks' | 'Layers' | 'Bell' | 'RefreshCw' | 'Database' | 'Settings2' | 'Info' | 'Sparkles' | 'CalendarDays';

type RowDefinition<Id extends string> = { id: Id; titleKey: string; descriptionKey: string; icon: SettingsMenuIcon };

/** The root menu's cards, in order. Each row opens the settings screen of the same id. */
export const SETTINGS_MENU_GROUPS: readonly (readonly RowDefinition<SettingsMenuRowId>[])[] = [
    [
        { id: 'general', titleKey: 'settings.general', descriptionKey: 'settings.menuDesc.general', icon: 'Monitor' },
        { id: 'gtd', titleKey: 'settings.gtd', descriptionKey: 'settings.menuDesc.gtd', icon: 'ListChecks' },
        { id: 'manage', titleKey: 'settings.manage', descriptionKey: 'settings.menuDesc.manage', icon: 'Layers' },
        { id: 'notifications', titleKey: 'settings.notifications', descriptionKey: 'settings.menuDesc.notifications', icon: 'Bell' },
    ],
    [
        { id: 'sync', titleKey: 'settings.sync', descriptionKey: 'settings.menuDesc.sync', icon: 'RefreshCw' },
        { id: 'data', titleKey: 'settings.data', descriptionKey: 'settings.menuDesc.data', icon: 'Database' },
    ],
    [
        { id: 'advanced', titleKey: 'settings.advanced', descriptionKey: 'settings.menuDesc.advanced', icon: 'Settings2' },
        { id: 'about', titleKey: 'settings.about', descriptionKey: 'settings.menuDesc.about', icon: 'Info' },
    ],
];

/** The Advanced screen's rows, in order. */
export const SETTINGS_ADVANCED_MENU_ROWS: readonly RowDefinition<SettingsAdvancedMenuRowId>[] = [
    { id: 'ai', titleKey: 'settings.ai', descriptionKey: 'settings.menuDesc.ai', icon: 'Sparkles' },
    { id: 'calendar', titleKey: 'settings.calendar', descriptionKey: 'settings.menuDesc.calendar', icon: 'CalendarDays' },
];

/** The sync row's badge, as mobile's sync badge resolves it (apps/mobile/lib/sync-badge.ts). */
export type SettingsSyncBadgeState = 'hidden' | 'syncing' | 'healthy' | 'attention';

// Same values as apps/mobile/lib/sync-badge.ts MOBILE_SYNC_BADGE_COLORS; the
// settings parity fixture checks each against the React Native menu.
export const SETTINGS_SYNC_BADGE_COLORS: Record<Exclude<SettingsSyncBadgeState, 'hidden'>, string> = {
    syncing: '#F59E0B',
    healthy: '#22C55E',
    attention: '#EF4444',
};

/** The sync badge's color and spoken label (use-mobile-sync-badge.ts); null when hidden. */
export function getSettingsSyncBadge(state: SettingsSyncBadgeState, t: Translate): { color: string; accessibilityLabel: string } | null {
    if (state === 'hidden') return null;
    const key = state === 'syncing' ? 'settings.syncBadgeSyncing' : state === 'healthy' ? 'settings.syncBadgeHealthy' : 'settings.syncBadgeWarning';
    return { color: SETTINGS_SYNC_BADGE_COLORS[state], accessibilityLabel: t(key) };
}

/** A menu row's spoken label: title, description and badge, joined as sentences. */
export function getSettingsMenuItemAccessibilityLabel(title: string, description?: string, indicatorAccessibilityLabel?: string): string {
    return [title, description, indicatorAccessibilityLabel].filter(Boolean).join('. ');
}

export type SettingsMenuRow<Id extends string = SettingsMenuRowId> = {
    id: Id;
    title: string;
    /** The blurb; while searching, the matching setting and where it lives. */
    description?: string;
    icon: SettingsMenuIcon;
    showIndicator?: boolean;
    /** The dot's color; unset draws the default (update) dot. */
    indicatorColor?: string;
    indicatorAccessibilityLabel?: string;
    accessibilityLabel: string;
};

export type SettingsMenuModel = {
    title: string;
    searchPlaceholder: string;
    /** The cards that have a row left after the search, in order. */
    groups: SettingsMenuRow[][];
    /** Shown when the search leaves nothing. */
    noMatches: string | null;
};

const withLabel = <Id extends string>(row: Omit<SettingsMenuRow<Id>, 'accessibilityLabel'>): SettingsMenuRow<Id> => ({
    ...row,
    accessibilityLabel: getSettingsMenuItemAccessibilityLabel(row.title, row.description, row.indicatorAccessibilityLabel),
});

/**
 * The root menu for a search query. `sync` is the sync badge (color and label,
 * absent when hidden); `updateAvailable` is the About row's update dot.
 */
export function buildSettingsMenu(input: {
    t: Translate;
    query: string;
    sync?: { color?: string; accessibilityLabel?: string };
    updateAvailable: boolean;
}): SettingsMenuModel {
    const { t, query, sync, updateAvailable } = input;
    const indicators: Partial<Record<SettingsMenuRowId, Pick<SettingsMenuRow, 'showIndicator' | 'indicatorColor' | 'indicatorAccessibilityLabel'>>> = {
        sync: { showIndicator: Boolean(sync?.color), indicatorColor: sync?.color, indicatorAccessibilityLabel: sync?.accessibilityLabel },
        about: { showIndicator: updateAvailable, indicatorAccessibilityLabel: updateAvailable ? t('settings.updateAvailable') : undefined },
    };
    const groups = SETTINGS_MENU_GROUPS
        .map((group) => group
            .map((row) => ({ id: row.id, title: t(row.titleKey), description: t(row.descriptionKey), icon: row.icon, ...indicators[row.id] }))
            .filter((row) => settingsMenuMatchesQuery(buildSettingsMenuSearchText(row.id, row.title, row.description, t), query))
            // While searching, the row's second line says which setting
            // matched and where it lives, instead of the generic blurb.
            .map((row) => {
                const match = findSettingsMenuMatch(row.id, row.title, t, query);
                return withLabel(match ? { ...row, description: `${match.title} · ${match.path}` } : row);
            }))
        .filter((group) => group.length > 0);
    return {
        title: t('settings.title'),
        searchPlaceholder: t('common.search'),
        groups,
        noMatches: groups.length === 0 ? t('common.noMatches') : null,
    };
}

/** The Advanced screen: its title and rows. */
export function buildSettingsAdvancedMenu(t: Translate): { title: string; rows: SettingsMenuRow<SettingsAdvancedMenuRowId>[] } {
    return {
        title: t('settings.advanced'),
        rows: SETTINGS_ADVANCED_MENU_ROWS.map((row) => withLabel({ id: row.id, title: t(row.titleKey), description: t(row.descriptionKey), icon: row.icon })),
    };
}
