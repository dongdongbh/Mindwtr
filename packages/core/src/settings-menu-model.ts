


import {
    getSettingsSearchEntries,
    getSettingsSearchEntryKeys,
    resolveSettingsSearchI18nKey,
    SETTINGS_SEARCH_MOBILE_EXCLUSIONS,
    type SettingsSearchPageId,
} from './settings-search-keys';
import { einkSafeColor } from './color-constants';

type Translate = (key: string) => string;


export type SettingsMenuRowId =
    | 'general'
    | 'gtd'
    | 'manage'
    | 'notifications'
    | 'sync'
    | 'data'
    | 'advanced'
    | 'about';


export type SettingsAdvancedMenuRowId = 'ai' | 'calendar';


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


const MOBILE_ROW_EXTRA_KEYS: Record<SettingsMenuRowId, readonly string[]> = {
    general: ['settings.theme', 'settings.mobile.appLock', 'settings.privacy', 'settings.appSearchLabel'],
    gtd: ['settings.gtdMobile.pomodoroSettings', 'settings.dailyReviewConfig', 'settings.gmailCapture', 'settings.gmailCaptureLabel'],


    manage: ['areas.manage', 'contexts.title', 'tags.title', 'settings.unassignedAreaColor'],
    notifications: [
        'settings.dailyDigest', 'settings.weeklyReview',
        'settings.dueDateNotifications', 'settings.startDateNotifications', 'settings.persistentCaptureLabel',
    ],

    sync: [
        'settings.syncBackend', 'settings.syncBackendWebdav',
        'settings.cloudProviderDropbox', 'settings.syncHistory', 'settings.recoverySnapshots',
    ],


    data: ['settings.data', 'settings.backup', 'settings.exportBackup', 'settings.diagnostics', 'settings.debugLogging'],


    advanced: [
        'settings.aiProvider', 'settings.aiModel', 'settings.aiApiKey',
        'settings.aiProviderOpenAI', 'settings.aiProviderAnthropic', 'settings.aiProviderGemini',


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


export function buildSettingsMenuSearchText(
    id: SettingsMenuRowId,
    title: string,
    description: string | undefined,
    t: Translate,
): string {
    const keywordLabels = (SETTINGS_MENU_KEYWORD_KEYS[id] ?? [])
        .map((key) => ({ key, value: t(key) }))

        .filter(({ key, value }) => value && value !== key)
        .map(({ value }) => value);
    return [title, description ?? '', ...keywordLabels].join(' ').toLowerCase();
}


export type SettingsMenuMatch = { title: string; path: string };

export function findSettingsMenuMatch(
    id: SettingsMenuRowId,
    rowTitle: string,
    t: Translate,
    query: string,
): SettingsMenuMatch | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;

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


export type SettingsMenuIcon =
    | 'Monitor' | 'ListChecks' | 'Layers' | 'Bell' | 'RefreshCw' | 'Database' | 'Settings2' | 'Info' | 'Sparkles' | 'CalendarDays';

type RowDefinition<Id extends string> = { id: Id; titleKey: string; descriptionKey: string; icon: SettingsMenuIcon };


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


export const SETTINGS_ADVANCED_MENU_ROWS: readonly RowDefinition<SettingsAdvancedMenuRowId>[] = [
    { id: 'ai', titleKey: 'settings.ai', descriptionKey: 'settings.menuDesc.ai', icon: 'Sparkles' },
    { id: 'calendar', titleKey: 'settings.calendar', descriptionKey: 'settings.menuDesc.calendar', icon: 'CalendarDays' },
];


export type SettingsSyncBadgeState = 'hidden' | 'syncing' | 'healthy' | 'attention';


export const SETTINGS_SYNC_BADGE_COLORS: Record<Exclude<SettingsSyncBadgeState, 'hidden'>, string> = {
    syncing: '#F59E0B',
    healthy: '#22C55E',
    attention: '#EF4444',
};


export type SettingsSyncBadgeIcon = 'refresh' | 'check' | 'warning';

export function getSettingsSyncBadge(state: SettingsSyncBadgeState, t: Translate, themePreset?: string | null): { color: string; accessibilityLabel: string; icon?: SettingsSyncBadgeIcon } | null {
    if (state === 'hidden') return null;
    const key = state === 'syncing' ? 'settings.syncBadgeSyncing' : state === 'healthy' ? 'settings.syncBadgeHealthy' : 'settings.syncBadgeWarning';
    const icon: SettingsSyncBadgeIcon = state === 'syncing' ? 'refresh' : state === 'healthy' ? 'check' : 'warning';
    return { color: einkSafeColor(SETTINGS_SYNC_BADGE_COLORS[state], themePreset), accessibilityLabel: t(key),
        ...(themePreset === 'eink' ? { icon } : {}) };
}


export function getSettingsMenuItemAccessibilityLabel(title: string, description?: string, indicatorAccessibilityLabel?: string): string {
    return [title, description, indicatorAccessibilityLabel].filter(Boolean).join('. ');
}

export type SettingsMenuRow<Id extends string = SettingsMenuRowId> = {
    id: Id;
    title: string;

    description?: string;
    icon: SettingsMenuIcon;
    showIndicator?: boolean;

    indicatorColor?: string;
    indicatorIcon?: SettingsSyncBadgeIcon;
    indicatorAccessibilityLabel?: string;
    accessibilityLabel: string;
};

export type SettingsMenuModel = {
    title: string;
    searchPlaceholder: string;

    groups: SettingsMenuRow[][];

    noMatches: string | null;
};

const withLabel = <Id extends string>(row: Omit<SettingsMenuRow<Id>, 'accessibilityLabel'>): SettingsMenuRow<Id> => ({
    ...row,
    accessibilityLabel: getSettingsMenuItemAccessibilityLabel(row.title, row.description, row.indicatorAccessibilityLabel),
});


export function buildSettingsMenu(input: {
    t: Translate;
    query: string;
    sync?: { color?: string; accessibilityLabel?: string; icon?: SettingsSyncBadgeIcon };
    updateAvailable: boolean;
}): SettingsMenuModel {
    const { t, query, sync, updateAvailable } = input;
    const indicators: Partial<Record<SettingsMenuRowId, Pick<SettingsMenuRow, 'showIndicator' | 'indicatorColor' | 'indicatorAccessibilityLabel' | 'indicatorIcon'>>> = {
        sync: { showIndicator: Boolean(sync?.color), indicatorColor: sync?.color, indicatorAccessibilityLabel: sync?.accessibilityLabel,
            ...(sync?.icon ? { indicatorIcon: sync.icon } : {}) },
        about: { showIndicator: updateAvailable, indicatorAccessibilityLabel: updateAvailable ? t('settings.updateAvailable') : undefined },
    };
    const groups = SETTINGS_MENU_GROUPS
        .map((group) => group
            .map((row) => ({ id: row.id, title: t(row.titleKey), description: t(row.descriptionKey), icon: row.icon, ...indicators[row.id] }))
            .filter((row) => settingsMenuMatchesQuery(buildSettingsMenuSearchText(row.id, row.title, row.description, t), query))


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


export function buildSettingsAdvancedMenu(t: Translate): { title: string; rows: SettingsMenuRow<SettingsAdvancedMenuRowId>[] } {
    return {
        title: t('settings.advanced'),
        rows: SETTINGS_ADVANCED_MENU_ROWS.map((row) => withLabel({ id: row.id, title: t(row.titleKey), description: t(row.descriptionKey), icon: row.icon })),
    };
}
