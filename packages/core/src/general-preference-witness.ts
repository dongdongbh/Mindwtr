import type { AppSettings } from './types';

export type GeneralPreferenceType = 'appLockRelockDelay' | 'showTaskAge' | 'quickAccessView' | 'weekStart' | 'dateFormat' | 'timeFormat' | 'calendarSystem' | 'theme' | 'language';
export type GeneralPreferenceWitness = { present: boolean; value: boolean | string | number | null;
    stampPresent: boolean; stamp: string | null };

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const legacyGeneralPreferenceNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000;

/** The raw value and its local or sync-group revision used by a General journal. */
export const generalPreferenceWitness = (settings: AppSettings, type: GeneralPreferenceType): GeneralPreferenceWitness | null => {
    if (type === 'appLockRelockDelay') {
        const security = settings.security;
        if (security !== undefined && !record(security)) return null;
        const value = security?.mobileAppLockRelockDelayMinutes;
        const present = value !== undefined;
        const stamp = security?.mobileAppLockRelockDelayUpdatedAt;
        const stampPresent = stamp !== undefined;
        if (present && !legacyGeneralPreferenceNumber(value) || stampPresent && !iso(stamp)) return null;
        return { present, value: present ? value! : null, stampPresent, stamp: stampPresent ? stamp! : null };
    }
    const appearanceKey = type === 'showTaskAge' ? 'showTaskAge'
        : type === 'quickAccessView' ? 'mobileQuickAccessView' : null;
    const value = appearanceKey ? settings.appearance?.[appearanceKey]
        : type === 'weekStart' ? settings.weekStart
            : type === 'dateFormat' ? settings.dateFormat
                : type === 'timeFormat' ? settings.timeFormat
                    : type === 'calendarSystem' ? settings.calendarSystem
                        : type === 'theme' ? settings.theme : settings.language;
    const present = value !== undefined && (appearanceKey
        ? settings.appearance !== undefined && record(settings.appearance) && own(settings.appearance, appearanceKey)
        : own(settings, type));
    const group = appearanceKey || type === 'theme' ? 'appearance' : 'language';
    const stamps = settings.syncPreferencesUpdatedAt;
    if (appearanceKey && settings.appearance !== undefined && !record(settings.appearance)
        || stamps !== undefined && !record(stamps)) return null;
    const stampPresent = stamps !== undefined && own(stamps, group) && stamps[group] !== undefined;
    const stamp = stampPresent ? stamps?.[group] : null;
    if (present && !(type === 'showTaskAge' ? typeof value === 'boolean'
        : typeof value === 'string' && value.length <= 500
            || type !== 'quickAccessView' && type !== 'calendarSystem' && type !== 'theme' && type !== 'language'
                && legacyGeneralPreferenceNumber(value))
        || stampPresent && !iso(stamp)) return null;
    return { present, value: present ? value as boolean | string | number : null,
        stampPresent, stamp: stampPresent ? stamp! : null };
};
