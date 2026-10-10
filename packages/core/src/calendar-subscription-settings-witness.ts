import { sha256 } from '@noble/hashes/sha2.js';
import { strToU8 } from 'fflate';
import { removeCalendarFeed, setCalendarFeedColor, setCalendarFeedEnabled } from './calendar-settings-model';
import { decodeExternalCalendarSubscriptions } from './external-calendar-feeds';
import { taskEditValuesEqual } from './json-value-equality';
import type { NativeCalendarSettingsEdit } from './native-host-contract-settings-calendar';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import type { ExternalCalendarSubscription } from './ics';
import type { AppSettings } from './types';
import { deterministicHash128Hex } from './uuid';
import { calendarSubscriptionModules } from './store-calendar-subscription-modules';

export type CalendarSubscriptionSettingEdit = Extract<NativeCalendarSettingsEdit, { type: 'feed' | 'removeFeed' }>;
export type CalendarSubscriptionSettingWitness = {
    source: 'canonical' | 'legacy'; revision: string; fingerprint: string; stampPresent: boolean; stamp: string | null;
};
export type CalendarSubscriptionSettingSource = { feeds: ExternalCalendarSubscription[]; witness: CalendarSubscriptionSettingWitness };
export const CALENDAR_SUBSCRIPTION_SOURCE_BYTES = 1_048_576;
export const CALENDAR_SUBSCRIPTION_REQUEST_BYTES = 1_048_576;
export const CALENDAR_SUBSCRIPTION_ENVELOPE_BYTES = 4_194_304;
export const CALENDAR_SUBSCRIPTION_OPTIONS_BYTES = 2_000_000;

const own = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum;
const id = (value: unknown): value is string => text(value, 200) && value.trim().length > 0;
const dense = (value: unknown): value is unknown[] => Array.isArray(value)
    && Object.keys(value).length === value.length && Array.from(value.keys()).every((key) => own(value, String(key)));
const canonical = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

export const readCalendarSubscriptionSettingEdit = (value: unknown): CalendarSubscriptionSettingEdit | null => {
    if (!record(value) || !id(value.feedId) || !text(value.revision, 200)) return null;
    if (value.type === 'removeFeed' && exact(value, ['type', 'feedId', 'revision'])) return detach(value);
    if (value.type !== 'feed' || !exact(value, ['type', 'feedId', 'field', 'value', 'revision'])) return null;
    if (!(value.field === 'enabled' && typeof value.value === 'boolean'
        || value.field === 'color' && (value.value === null || text(value.value, 20))
        || value.field === 'areaIds' && dense(value.value) && value.value.length <= 500
            && value.value.every((entry) => text(entry, 200)))) return null;
    return detach(value);
};

export const readCalendarSubscriptionSettingWitness = (value: unknown): CalendarSubscriptionSettingWitness | null => {
    if (!record(value) || !exact(value, ['source', 'revision', 'fingerprint', 'stampPresent', 'stamp'])
        || !['canonical', 'legacy'].includes(String(value.source)) || !text(value.revision, 200)
        || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)
        || typeof value.stampPresent !== 'boolean' || (value.stampPresent ? !iso(value.stamp) : value.stamp !== null)
        || value.source === 'canonical' && value.revision !== `synced:${value.stamp ?? ''}`
        || value.source === 'legacy' && !/^device:[0-9a-f]{32}$/.test(value.revision)) return null;
    return detach(value);
};

/** Saved JSON and exact legacy bytes, never the display cache or its stamp alone. */
export function calendarSubscriptionSettingSource(settings: AppSettings, legacyRaw: string | null): CalendarSubscriptionSettingSource | null {
    try {
        const present = own(settings, 'externalCalendars');
        const canonicalSource = Array.isArray(settings.externalCalendars);
        const raw = present ? settings.externalCalendars : null;
        if (!canonicalSource && legacyRaw !== null && (typeof legacyRaw !== 'string'
            || strToU8(legacyRaw).length > CALENDAR_SUBSCRIPTION_SOURCE_BYTES)) return null;
        const tuple = ['calendarSubscriptionSetting:v1', present, raw, canonicalSource ? null : legacyRaw];
        if (!isNativeJsonWithinBytes(tuple, CALENDAR_SUBSCRIPTION_SOURCE_BYTES) || !detach(tuple)) return null;
        const stored: unknown = canonicalSource ? raw : legacyRaw === null ? [] : JSON.parse(legacyRaw);
        if (!dense(stored)) return null;
        const seen = new Set<string>();
        for (const row of stored) {
            if (!record(row) || !id(row.id) || seen.has(row.id) || typeof row.url !== 'string' || !row.url.trim()
                || row.name !== undefined && typeof row.name !== 'string'
                || row.enabled !== undefined && typeof row.enabled !== 'boolean'
                || row.color !== undefined && typeof row.color !== 'string'
                || row.areaIds !== undefined && (!dense(row.areaIds) || !row.areaIds.every((entry) => text(entry, 200)))) return null;
            seen.add(row.id);
        }
        const feeds = canonicalSource ? detach<ExternalCalendarSubscription[]>(stored)
            : decodeExternalCalendarSubscriptions(legacyRaw);
        if (!feeds || feeds.length !== stored.length) return null;
        const stamps = settings.syncPreferencesUpdatedAt;
        const stampPresent = Boolean(stamps && own(stamps, 'externalCalendars'));
        const stamp = stampPresent ? stamps!.externalCalendars : null;
        if (stampPresent && !iso(stamp)) return null;
        const witness: CalendarSubscriptionSettingWitness = {
            source: canonicalSource ? 'canonical' : 'legacy',
            revision: canonicalSource ? `synced:${stamp ?? ''}` : `device:${deterministicHash128Hex(JSON.stringify(feeds))}`,
            fingerprint: Array.from(sha256(strToU8(canonical(tuple))), (byte) => byte.toString(16).padStart(2, '0')).join(''),
            stampPresent, stamp: stamp ?? null,
        };
        return { feeds, witness };
    } catch { return null; }
}

/** Existing RN no-op/edit rules. Staleness is checked only for a changed plan. */
export function planCalendarSubscriptionSetting(feeds: readonly ExternalCalendarSubscription[], edit: CalendarSubscriptionSettingEdit)
    : { changed: boolean; feeds: ExternalCalendarSubscription[] } | null {
    const matches = feeds.filter((feed) => feed.id === edit.feedId);
    if (matches.length > 1) return null;
    if (edit.type === 'removeFeed') return { changed: matches.length > 0, feeds: removeCalendarFeed(feeds, edit.feedId) };
    const feed = matches[0];
    if (!feed) return null;
    const before = edit.field === 'enabled' ? feed.enabled : edit.field === 'color' ? feed.color ?? null : feed.areaIds ?? [];
    if (taskEditValuesEqual(before, edit.value)) return { changed: false, feeds: [...feeds] };
    const next = edit.field === 'color' ? setCalendarFeedColor(feeds, edit.feedId, edit.value ?? undefined)
        : edit.field === 'enabled' ? setCalendarFeedEnabled(feeds, edit.feedId, edit.value)
            : feeds.map((row) => row.id === edit.feedId ? { ...row, areaIds: [...edit.value] } : row);
    return next ? { changed: true, feeds: next } : null;
}

calendarSubscriptionModules.setting = { source: calendarSubscriptionSettingSource, plan: planCalendarSubscriptionSetting };
