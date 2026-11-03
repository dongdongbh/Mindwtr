


import { CALENDAR_PUSH_COLOR_OPTIONS, normalizeCalendarPushColor, type CalendarPushTargetCalendar } from './calendar-push-service';
import {
    EXTERNAL_CALENDAR_COLORS,
    hasExplicitExternalCalendarColor,
    normalizeExternalCalendarColor,
    themeExternalCalendarDisplayColor,
} from './external-calendar-colors';
import type { SystemCalendarSettings } from './external-calendar-feeds';
import { tFallback, type I18nTemplateValues } from './i18n';
import type { ExternalCalendarSubscription } from './ics';
import type { Area } from './types';

type Translate = (key: string) => string;
type TranslateText = (key: string, values?: I18nTemplateValues) => string;

export type CalendarSettingsToast = { title: string; message: string; tone: 'success' | 'warning' | 'info'; durationMs?: number };


export type CalendarPushTargetOption = { id: string | null; name: string; description: string; color?: string };

export type CalendarPushTargetChoices = {
    options: CalendarPushTargetOption[];

    localHint: boolean;

    sharedAccountHint: boolean;

    showColors: boolean;
};

export function describeCalendarPushTarget(calendar: CalendarPushTargetCalendar, tr: TranslateText): string {
    const kind = calendar.isMindwtrDedicated
        ? calendar.isLocalOnly
            ? tr('settings.calendarMobile.dedicatedLocalCalendar')
            : tr('settings.calendarMobile.dedicatedAccountCalendar')
        : calendar.isLocalOnly
            ? tr('settings.calendarMobile.sharedLocalCalendar')
            : tr('settings.calendarMobile.sharedAccountCalendar');
    return calendar.sourceName ? `${kind} · ${calendar.sourceName}` : kind;
}


export function buildCalendarPushTargetChoices(input: {
    targets: readonly CalendarPushTargetCalendar[];
    targetId: string | null;
    color: string;
    tr: TranslateText;

    platform: string;
}): CalendarPushTargetChoices {
    const { targets, targetId, color, tr } = input;
    const selected = targetId ? targets.find((calendar) => calendar.id === targetId) : null;
    const hasDedicatedAccount = targets.some((calendar) => calendar.isMindwtrDedicated && !calendar.isLocalOnly);
    const managed = targets.find((calendar) => calendar.isMindwtrManaged);
    const managedLocalOnly = managed ? managed.isLocalOnly : input.platform !== 'android';
    const managedKind = managedLocalOnly
        ? tr('settings.calendarMobile.dedicatedLocalCalendar')
        : tr('settings.calendarMobile.dedicatedAccountCalendar');
    const defaultLocal: CalendarPushTargetOption = {
        id: null,
        name: tr('settings.calendarMobile.mindwtrCalendar'),
        description: managed?.sourceName ? `${managedKind} · ${managed.sourceName}` : managedKind,
        color,
    };
    return {
        options: [
            ...(!hasDedicatedAccount || targetId === null ? [defaultLocal] : []),
            ...targets
                .filter((calendar) => {
                    if (calendar.isMindwtrManaged && calendar.id !== targetId) return false;
                    if (hasDedicatedAccount && calendar.isMindwtrDedicated && calendar.isLocalOnly && calendar.id !== targetId) {
                        return false;
                    }
                    return true;
                })
                .map((calendar) => ({
                    id: calendar.id as string | null,
                    name: calendar.name,
                    description: describeCalendarPushTarget(calendar, tr),
                    color: calendar.color,
                })),
        ],
        localHint: targetId === null ? managedLocalOnly : Boolean(selected?.isLocalOnly),
        sharedAccountHint: Boolean(selected && !selected.isMindwtrDedicated && !selected.isLocalOnly),
        showColors: targetId === null || selected?.isMindwtrManaged === true,
    };
}


export const planCalendarPushColor = (current: string, picked: string): string | null => (
    normalizeCalendarPushColor(picked) === normalizeCalendarPushColor(current) ? null : picked
);


export const keptPushTargetEvents = (before: string | null, after: string | null): boolean => before !== null && after === before;

export const getCalendarPushColorLabel = (t: Translate): string => (
    tFallback(t, 'settings.calendarMobile.mindwtrCalendarColor', 'Mindwtr calendar color')
);

export const getCalendarPushColorDescription = (t: Translate): string => tFallback(
    t,
    'settings.calendarMobile.mindwtrCalendarColorDesc',
    'Applies to the Mindwtr-created calendar; shared account calendars keep their own color.',
);

export const getCalendarPushColorOptions = (current: string, t: Translate) => CALENDAR_PUSH_COLOR_OPTIONS.map((color) => ({
    color: color as string,
    selected: color.toUpperCase() === current.toUpperCase(),
    accessibilityLabel: `${getCalendarPushColorLabel(t)} ${color}`,
}));


export function nextDeviceCalendarSelection(input: {
    calendarIds: readonly string[];
    selectAll: boolean;
    selectedCalendarIds: readonly string[];
    calendarId: string;
    enabled: boolean;
}): Pick<SystemCalendarSettings, 'selectAll' | 'selectedCalendarIds'> | null {
    const allIds = [...input.calendarIds];
    if (allIds.length === 0) return null;
    const currentSelection = input.selectAll
        ? allIds
        : Array.from(new Set(input.selectedCalendarIds.filter((id) => allIds.includes(id))));
    const nextSelection = input.enabled
        ? Array.from(new Set([...currentSelection, input.calendarId]))
        : currentSelection.filter((id) => id !== input.calendarId);
    const selectAll = nextSelection.length === allIds.length;
    return { selectAll, selectedCalendarIds: selectAll ? [] : nextSelection };
}


export function pruneDeviceCalendarSelection(
    stored: Pick<SystemCalendarSettings, 'selectAll' | 'selectedCalendarIds'>,
    calendarIds: readonly string[],
): string[] | null {
    if (stored.selectAll) return null;
    const validIds = new Set(calendarIds);
    const filtered = stored.selectedCalendarIds.filter((id) => validIds.has(id));
    if (filtered.length === stored.selectedCalendarIds.length
        && filtered.every((id, index) => id === stored.selectedCalendarIds[index])) {
        return null;
    }
    return filtered;
}

export const toggleCalendarAreaId = (current: readonly string[], areaId: string): string[] => (
    current.includes(areaId) ? current.filter((id) => id !== areaId) : [...current, areaId]
);


export type CalendarAreaChoice = {

    label: string;

    options: { areaId: string; label: string; accessibilityLabel: string; checked: boolean }[];
};


export function buildCalendarAreaChoice(selectedIds: readonly string[], areas: readonly Area[], t: Translate): CalendarAreaChoice | null {
    const areaOptions = areas.filter((area) => !area.deletedAt);
    if (areaOptions.length === 0) return null;
    const names = areaOptions.filter((area) => selectedIds.includes(area.id)).map((area) => area.name).join(', ');
    return {
        label: `${t('settings.calendarShowInAreas')}: ${selectedIds.length === 0 ? t('settings.calendarAllAreas') : names || t('settings.calendarAllAreas')}`,
        options: areaOptions.map((area) => ({
            areaId: area.id,
            label: `${selectedIds.includes(area.id) ? '☑' : '☐'} ${area.name}`,
            accessibilityLabel: area.name,
            checked: selectedIds.includes(area.id),
        })),
    };
}


export function resolveCalendarFeedsOnLoad(
    synced: ExternalCalendarSubscription[] | undefined,
    stored: readonly ExternalCalendarSubscription[],
): { feeds: ExternalCalendarSubscription[]; saveDeviceCopy: boolean } {
    if (Array.isArray(synced)) {
        return { feeds: synced, saveDeviceCopy: synced.length > 0 || stored.length > 0 };
    }
    return { feeds: [...stored], saveDeviceCopy: false };
}


export function addCalendarFeed(
    feeds: readonly ExternalCalendarSubscription[],
    input: { id: string; name: string; url: string; defaultName: string },
): ExternalCalendarSubscription[] | null {
    const url = input.url.trim();
    if (!url) return null;
    const name = (input.name.trim() || input.defaultName).trim();
    return [...feeds, { id: input.id, name, url, enabled: true }];
}


export function addCalendarFile(
    feeds: readonly ExternalCalendarSubscription[],
    input: { id: string; name: string; fileName: string | null | undefined; uri: string; defaultName: string },
): ExternalCalendarSubscription[] {
    const fileName = (input.fileName || input.uri.split('/').pop() || '').trim();
    const inferredName = fileName.replace(/\.ics$/iu, '').trim();
    const name = (input.name.trim() || inferredName || input.defaultName).trim();
    return [...feeds, { id: input.id, name, url: input.uri.trim(), enabled: true }];
}

export const setCalendarFeedEnabled = (feeds: readonly ExternalCalendarSubscription[], id: string, enabled: boolean): ExternalCalendarSubscription[] => (
    feeds.map((feed) => (feed.id === id ? { ...feed, enabled } : feed))
);


export function setCalendarFeedColor(
    feeds: readonly ExternalCalendarSubscription[],
    id: string,
    color: string | undefined,
): ExternalCalendarSubscription[] | null {
    const normalized = color === undefined ? undefined : normalizeExternalCalendarColor(color);
    if (color !== undefined && !normalized) return null;
    if (feeds.find((feed) => feed.id === id)?.color === normalized) return null;
    return feeds.map((feed) => {
        if (feed.id !== id) return feed;
        if (normalized) return { ...feed, color: normalized };
        const { color: _cleared, ...rest } = feed;
        return rest;
    });
}

export const toggleCalendarFeedArea = (feeds: readonly ExternalCalendarSubscription[], id: string, areaId: string): ExternalCalendarSubscription[] => (
    feeds.map((feed) => (feed.id === id ? { ...feed, areaIds: toggleCalendarAreaId(feed.areaIds ?? [], areaId) } : feed))
);

export const removeCalendarFeed = (feeds: readonly ExternalCalendarSubscription[], id: string): ExternalCalendarSubscription[] => (
    feeds.filter((feed) => feed.id !== id)
);


export const maskCalendarFeedUrl = (url: string): string => {
    const trimmed = url.trim();
    if (!trimmed) return '';
    const origin = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)/i.exec(trimmed)!;
    const scheme = origin[1] ?? '';
    const host = (origin[2] ?? '').replace(/^.*@/, '');
    return trimmed.length > origin[0].length ? `${scheme}${host}/...` : `${scheme}${host}`;
};


export function getCalendarFeedColorOptions(feed: ExternalCalendarSubscription, t: Translate, themePreset?: string) {
    const explicit = hasExplicitExternalCalendarColor(feed.id, feed.color);
    return [
        { color: null as string | null, fill: null as string | null, selected: !explicit, accessibilityLabel: `${feed.name} ${t('taskEdit.textDirection.auto')}` },
        ...EXTERNAL_CALENDAR_COLORS.map((color) => ({
            color: color as string | null,

            fill: themeExternalCalendarDisplayColor(color, themePreset) as string | null,
            selected: explicit && feed.color === color,
            accessibilityLabel: `${feed.name} ${color}`,
        })),
    ];
}


export function getCalendarTestRange(now: Date): { start: Date; end: Date } {
    return {
        start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    };
}

export const isChineseCalendarSettingsLanguage = (language: string): boolean => language === 'zh' || language === 'zh-Hant';


export const calendarSettingsToasts = (tr: TranslateText, t: Translate) => ({
    loadWritableCalendarsFailed: (): CalendarSettingsToast => ({
        title: tr('settings.syncMobile.error'), message: tr('settings.calendarMobile.failedToLoadWritableCalendars'), tone: 'warning', durationMs: 4200,
    }),
    pushPermissionRequired: (): CalendarSettingsToast => ({
        title: tr('settings.calendarMobile.permissionRequired'),
        message: tr('settings.calendarMobile.calendarAccessIsRequiredToPushTasksToYourCalendar'),
        tone: 'warning',
        durationMs: 4200,
    }),
    pushDisabled: (): CalendarSettingsToast => ({
        title: tr('settings.calendarMobile.calendarSyncDisabled'),
        message: tr('settings.calendarMobile.tasksWillNoLongerBePushedToYourCalendarExisting'),
        tone: 'info',
        durationMs: 4200,
    }),
    pushTargetUpdated: (): CalendarSettingsToast => ({
        title: tr('settings.calendarMobile.calendarTargetUpdated'),
        message: tr('settings.calendarMobile.dueDateTasksWillBeWrittenToTheSelectedCalendar'),
        tone: 'success',
        durationMs: 3200,
    }),
    pushColorUpdated: (updated: boolean): CalendarSettingsToast => ({
        title: tFallback(t, 'settings.calendarMobile.calendarColorUpdated', 'Calendar color updated'),
        message: updated
            ? tFallback(t, 'settings.calendarMobile.calendarColorUpdatedMessage', 'Mindwtr calendar color was updated.')
            : tFallback(t, 'settings.calendarMobile.calendarColorSavedMessage', 'Mindwtr will use this color when it creates the calendar.'),
        tone: 'success',
        durationMs: 3000,
    }),


    pushColorFailed: (): CalendarSettingsToast => ({
        title: tr('settings.syncMobile.error'),
        message: tr('settings.calendarMobile.calendarColorUpdateFailed'),
        tone: 'warning',
        durationMs: 4200,
    }),
    mindwtrCalendarDeleted: (keptTargetEvents: boolean): CalendarSettingsToast => ({
        title: tr('settings.calendarMobile.calendarDeleted'),
        message: keptTargetEvents
            ? tr('settings.calendarMobile.mindwtrCalendarRemovedPushedEventsKept')
            : tr('settings.calendarMobile.theMindwtrCalendarAndAllItsEventsHaveBeenRemoved'),
        tone: 'success',
        durationMs: 3500,
    }),
    loadDeviceCalendarsFailed: (): CalendarSettingsToast => ({
        title: tr('settings.syncMobile.error'), message: tr('settings.calendarMobile.failedToLoadDeviceCalendarSettings'), tone: 'warning', durationMs: 4200,
    }),
    loadSavedCalendarsFailed: (): CalendarSettingsToast => ({
        title: tr('settings.syncMobile.error'), message: tr('settings.calendarMobile.failedToLoadSavedCalendars'), tone: 'warning', durationMs: 4200,
    }),
    localFileAdded: (): CalendarSettingsToast => ({
        title: tr('settings.calendarMobile.localIcsFileAdded'),
        message: tr('settings.calendarMobile.localIcsFilesAreReadOnly'),
        tone: 'success',
        durationMs: 3500,
    }),

    testResult: (count: number, failedFeeds: number, language: string): CalendarSettingsToast => (
        failedFeeds > 0 ? calendarSettingsToasts(tr, t).testFailed() : calendarSettingsToasts(tr, t).testLoaded(count, language)
    ),
    testLoaded: (count: number, language: string): CalendarSettingsToast => ({
        title: tr('common.success'),
        message: isChineseCalendarSettingsLanguage(language) ? `已加载 ${count} 个日程` : `Loaded ${count} events`,
        tone: 'success',
    }),
    testFailed: (): CalendarSettingsToast => ({
        title: tr('settings.syncMobile.error'), message: tr('settings.calendarMobile.failedToLoadEvents'), tone: 'warning',
    }),
});
