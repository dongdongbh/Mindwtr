import type { AppData, SettingsSyncGroup } from './types';
import {
    AI_PROVIDER_VALUE_SET,
    AI_REASONING_EFFORT_VALUE_SET,
    SETTINGS_DENSITY_VALUE_SET,
    SETTINGS_KEYBINDING_STYLE_VALUE_SET,
    SETTINGS_LANGUAGE_VALUE_SET,
    SETTINGS_THEME_VALUE_SET,
    SETTINGS_TIME_FORMAT_VALUE_SET,
    SETTINGS_WEEK_START_VALUE_SET,
    STT_FIELD_STRATEGY_VALUE_SET,
    STT_MODE_VALUE_SET,
    STT_PROVIDER_VALUE_SET,
} from './settings-options';
import { isNonEmptyString, isObjectRecord, isValidTimestamp } from './sync-normalization';

const parseSyncTimestamp = (value?: string): number => {
    if (!value) return NaN;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
};

const isIncomingNewer = (localAt?: string, incomingAt?: string): boolean => {
    const localTime = parseSyncTimestamp(localAt);
    const incomingTime = parseSyncTimestamp(incomingAt);
    if (!Number.isFinite(incomingTime)) return false;
    if (!Number.isFinite(localTime)) return true;
    return incomingTime > localTime;
};

const sanitizeAiForSync = (
    ai: AppData['settings']['ai'] | undefined,
    localAi?: AppData['settings']['ai']
): AppData['settings']['ai'] | undefined => {
    if (!ai) return ai;
    const sanitized: AppData['settings']['ai'] = {
        ...ai,
        apiKey: undefined,
    };
    if (sanitized.speechToText) {
        sanitized.speechToText = {
            ...sanitized.speechToText,
            offlineModelPath: localAi?.speechToText?.offlineModelPath,
        };
    }
    return sanitized;
};

const SETTINGS_SYNC_GROUP_KEYS: SettingsSyncGroup[] = ['appearance', 'language', 'externalCalendars', 'ai'];
const SETTINGS_SYNC_UPDATED_AT_KEYS: Array<SettingsSyncGroup | 'preferences'> = ['preferences', ...SETTINGS_SYNC_GROUP_KEYS];

const cloneSettingValue = <T>(value: T): T => {
    if (typeof globalThis.structuredClone === 'function') {
        try {
            return globalThis.structuredClone(value);
        } catch {
            // Fallback to manual deep clone for environments/values unsupported by structuredClone.
        }
    }
    if (Array.isArray(value)) {
        return value.map((item) => cloneSettingValue(item)) as unknown as T;
    }
    if (value && typeof value === 'object') {
        const cloned: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            cloned[key] = cloneSettingValue(item);
        }
        return cloned as T;
    }
    return value;
};

const sanitizeSyncPreferences = (
    value: AppData['settings']['syncPreferences'] | undefined,
    fallback: AppData['settings']['syncPreferences'] | undefined
): AppData['settings']['syncPreferences'] | undefined => {
    if (value === undefined) return fallback ? cloneSettingValue(fallback) : undefined;
    if (!isObjectRecord(value)) return fallback ? cloneSettingValue(fallback) : undefined;
    const next: NonNullable<AppData['settings']['syncPreferences']> = {};
    for (const key of SETTINGS_SYNC_GROUP_KEYS) {
        const candidate = (value as Record<string, unknown>)[key];
        if (typeof candidate === 'boolean') {
            next[key] = candidate;
        }
    }
    return Object.keys(next).length > 0 ? next : (fallback ? cloneSettingValue(fallback) : undefined);
};

const sanitizeSyncPreferencesUpdatedAt = (
    value: AppData['settings']['syncPreferencesUpdatedAt'] | undefined,
    fallback: AppData['settings']['syncPreferencesUpdatedAt'] | undefined
): AppData['settings']['syncPreferencesUpdatedAt'] | undefined => {
    if (value === undefined) return fallback ? cloneSettingValue(fallback) : undefined;
    if (!isObjectRecord(value)) return fallback ? cloneSettingValue(fallback) : undefined;
    const next: NonNullable<AppData['settings']['syncPreferencesUpdatedAt']> = {};
    for (const key of SETTINGS_SYNC_UPDATED_AT_KEYS) {
        const candidate = (value as Record<string, unknown>)[key];
        if (isValidTimestamp(candidate)) {
            next[key] = candidate;
        }
    }
    return Object.keys(next).length > 0 ? next : (fallback ? cloneSettingValue(fallback) : undefined);
};

const sanitizeExternalCalendars = (
    value: AppData['settings']['externalCalendars'] | undefined,
    fallback: AppData['settings']['externalCalendars'] | undefined
): AppData['settings']['externalCalendars'] | undefined => {
    if (value === undefined) return fallback ? cloneSettingValue(fallback) : undefined;
    if (!Array.isArray(value)) return fallback ? cloneSettingValue(fallback) : undefined;
    const next = value
        .filter((item): item is { id: string; name: string; url: string; enabled: boolean } =>
            isObjectRecord(item)
            && isNonEmptyString(item.id)
            && isNonEmptyString(item.name)
            && isNonEmptyString(item.url)
            && typeof item.enabled === 'boolean'
        )
        .map((item) => ({
            id: item.id.trim(),
            name: item.name.trim(),
            url: item.url.trim(),
            enabled: item.enabled,
        }));
    const deduped = new Map<string, (typeof next)[number]>();
    for (const item of next) {
        deduped.set(item.id, item);
    }
    if (value.length > 0 && deduped.size === 0 && fallback) {
        return cloneSettingValue(fallback);
    }
    return Array.from(deduped.values());
};

const sanitizeAiSettings = (
    value: AppData['settings']['ai'] | undefined,
    fallback: AppData['settings']['ai'] | undefined
): AppData['settings']['ai'] | undefined => {
    if (value === undefined) return fallback ? sanitizeAiForSync(cloneSettingValue(fallback), fallback) : undefined;
    if (!isObjectRecord(value)) return fallback ? sanitizeAiForSync(cloneSettingValue(fallback), fallback) : undefined;
    const next: NonNullable<AppData['settings']['ai']> = cloneSettingValue(
        value as NonNullable<AppData['settings']['ai']>
    );
    if (next.enabled !== undefined && typeof next.enabled !== 'boolean') {
        next.enabled = fallback?.enabled;
    }
    if (next.provider !== undefined && !AI_PROVIDER_VALUE_SET.has(next.provider)) {
        next.provider = fallback?.provider;
    }
    if (next.baseUrl !== undefined && !isNonEmptyString(next.baseUrl)) {
        next.baseUrl = fallback?.baseUrl;
    }
    if (next.model !== undefined && !isNonEmptyString(next.model)) {
        next.model = fallback?.model;
    }
    if (next.reasoningEffort !== undefined && !AI_REASONING_EFFORT_VALUE_SET.has(next.reasoningEffort)) {
        next.reasoningEffort = fallback?.reasoningEffort;
    }
    if (next.thinkingBudget !== undefined && (!Number.isFinite(next.thinkingBudget) || next.thinkingBudget < 0)) {
        next.thinkingBudget = fallback?.thinkingBudget;
    }
    if (next.copilotModel !== undefined && !isNonEmptyString(next.copilotModel)) {
        next.copilotModel = fallback?.copilotModel;
    }
    if (next.speechToText !== undefined && !isObjectRecord(next.speechToText)) {
        next.speechToText = fallback?.speechToText ? cloneSettingValue(fallback.speechToText) : undefined;
    } else if (next.speechToText) {
        const speechFallback = fallback?.speechToText;
        if (next.speechToText.enabled !== undefined && typeof next.speechToText.enabled !== 'boolean') {
            next.speechToText.enabled = speechFallback?.enabled;
        }
        if (next.speechToText.provider !== undefined && !STT_PROVIDER_VALUE_SET.has(next.speechToText.provider)) {
            next.speechToText.provider = speechFallback?.provider;
        }
        if (next.speechToText.model !== undefined && !isNonEmptyString(next.speechToText.model)) {
            next.speechToText.model = speechFallback?.model;
        }
        if (next.speechToText.language !== undefined && !isNonEmptyString(next.speechToText.language)) {
            next.speechToText.language = speechFallback?.language;
        }
        if (next.speechToText.mode !== undefined && !STT_MODE_VALUE_SET.has(next.speechToText.mode)) {
            next.speechToText.mode = speechFallback?.mode;
        }
        if (
            next.speechToText.fieldStrategy !== undefined
            && !STT_FIELD_STRATEGY_VALUE_SET.has(next.speechToText.fieldStrategy)
        ) {
            next.speechToText.fieldStrategy = speechFallback?.fieldStrategy;
        }
    }
    return sanitizeAiForSync(next, fallback);
};

const sanitizeMergedSettingsForSync = (
    merged: AppData['settings'],
    localSettings: AppData['settings']
): AppData['settings'] => {
    const next: AppData['settings'] = cloneSettingValue(merged);

    if (next.theme !== undefined && !SETTINGS_THEME_VALUE_SET.has(next.theme)) {
        next.theme = localSettings.theme;
    }
    if (next.language !== undefined && !SETTINGS_LANGUAGE_VALUE_SET.has(next.language)) {
        next.language = localSettings.language;
    }
    if (next.weekStart !== undefined && !SETTINGS_WEEK_START_VALUE_SET.has(next.weekStart)) {
        next.weekStart = localSettings.weekStart;
    }
    if (next.timeFormat !== undefined && !SETTINGS_TIME_FORMAT_VALUE_SET.has(next.timeFormat)) {
        next.timeFormat = localSettings.timeFormat;
    }
    if (next.keybindingStyle !== undefined && !SETTINGS_KEYBINDING_STYLE_VALUE_SET.has(next.keybindingStyle)) {
        next.keybindingStyle = localSettings.keybindingStyle;
    }
    if (next.dateFormat !== undefined && typeof next.dateFormat !== 'string') {
        next.dateFormat = localSettings.dateFormat;
    }
    if (next.appearance !== undefined && !isObjectRecord(next.appearance)) {
        next.appearance = localSettings.appearance ? cloneSettingValue(localSettings.appearance) : undefined;
    } else if (next.appearance?.density !== undefined && !SETTINGS_DENSITY_VALUE_SET.has(next.appearance.density)) {
        next.appearance = {
            ...(localSettings.appearance ? cloneSettingValue(localSettings.appearance) : {}),
            ...next.appearance,
            density: localSettings.appearance?.density,
        };
    }

    next.syncPreferences = sanitizeSyncPreferences(next.syncPreferences, localSettings.syncPreferences);
    next.syncPreferencesUpdatedAt = sanitizeSyncPreferencesUpdatedAt(
        next.syncPreferencesUpdatedAt,
        localSettings.syncPreferencesUpdatedAt
    );
    next.externalCalendars = sanitizeExternalCalendars(next.externalCalendars, localSettings.externalCalendars);
    next.ai = sanitizeAiSettings(next.ai, localSettings.ai);

    return next;
};

export const mergeSettingsForSync = (
    localSettings: AppData['settings'],
    incomingSettings: AppData['settings']
): AppData['settings'] => {
    const merged: AppData['settings'] = { ...localSettings };
    const nextSyncUpdatedAt: NonNullable<AppData['settings']['syncPreferencesUpdatedAt']> = {
        ...(localSettings.syncPreferencesUpdatedAt ?? {}),
        ...(incomingSettings.syncPreferencesUpdatedAt ?? {}),
    };

    const localPrefs = localSettings.syncPreferences ?? {};
    const incomingPrefs = incomingSettings.syncPreferences ?? {};
    const localPrefsAt = localSettings.syncPreferencesUpdatedAt?.preferences;
    const incomingPrefsAt = incomingSettings.syncPreferencesUpdatedAt?.preferences;
    const incomingPrefsWins = isIncomingNewer(localPrefsAt, incomingPrefsAt);
    const mergedPrefs = incomingPrefsWins ? incomingPrefs : localPrefs;

    merged.syncPreferences = cloneSettingValue(mergedPrefs);
    if (incomingPrefsWins) {
        if (incomingPrefsAt) nextSyncUpdatedAt.preferences = incomingPrefsAt;
    } else if (localPrefsAt) {
        nextSyncUpdatedAt.preferences = localPrefsAt;
    }

    const isSameValue = (left: unknown, right: unknown): boolean => {
        if (left === right) return true;
        return JSON.stringify(left) === JSON.stringify(right);
    };
    const chooseGroupFieldValue = <T>(localValue: T, incomingValue: T, incomingWins: boolean): T => {
        if (incomingValue === undefined) return cloneSettingValue(localValue);
        if (localValue === undefined) return cloneSettingValue(incomingValue);
        if (isSameValue(localValue, incomingValue)) return cloneSettingValue(localValue);
        return cloneSettingValue(incomingWins ? incomingValue : localValue);
    };
    const mergeRecordFields = <T extends Record<string, unknown>>(localValue: T, incomingValue: T, incomingWins: boolean): T => {
        const mergedValue: Record<string, unknown> = {};
        const localRecord = (localValue ?? {}) as Record<string, unknown>;
        const incomingRecord = (incomingValue ?? {}) as Record<string, unknown>;
        const keys = new Set([...Object.keys(localRecord), ...Object.keys(incomingRecord)]);
        for (const fieldKey of keys) {
            mergedValue[fieldKey] = chooseGroupFieldValue(localRecord[fieldKey], incomingRecord[fieldKey], incomingWins);
        }
        return mergedValue as T;
    };
    const mergeGroup = <T>(
        key: SettingsSyncGroup,
        localValue: T,
        incomingValue: T,
        apply: (value: T, incomingWins: boolean) => void,
        mergeValues?: (localValue: T, incomingValue: T, incomingWins: boolean) => T
    ) => {
        const localAt = localSettings.syncPreferencesUpdatedAt?.[key];
        const incomingAt = incomingSettings.syncPreferencesUpdatedAt?.[key];
        const incomingWins = isIncomingNewer(localAt, incomingAt);
        const resolvedValue = mergeValues
            ? mergeValues(localValue, incomingValue, incomingWins)
            : (incomingWins ? incomingValue : localValue);
        apply(cloneSettingValue(resolvedValue), incomingWins);
        const winnerAt = incomingWins ? incomingAt : localAt;
        if (winnerAt) nextSyncUpdatedAt[key] = winnerAt;
    };

    mergeGroup(
        'appearance',
        {
            theme: localSettings.theme,
            appearance: localSettings.appearance,
            keybindingStyle: localSettings.keybindingStyle,
        },
        {
            theme: incomingSettings.theme,
            appearance: incomingSettings.appearance,
            keybindingStyle: incomingSettings.keybindingStyle,
        },
        (value) => {
            merged.theme = value.theme;
            merged.appearance = value.appearance;
            merged.keybindingStyle = value.keybindingStyle;
        },
        (localValue, incomingValue, incomingWins) => mergeRecordFields(localValue, incomingValue, incomingWins)
    );

    mergeGroup(
        'language',
        {
            language: localSettings.language,
            weekStart: localSettings.weekStart,
            dateFormat: localSettings.dateFormat,
            timeFormat: localSettings.timeFormat,
        },
        {
            language: incomingSettings.language,
            weekStart: incomingSettings.weekStart,
            dateFormat: incomingSettings.dateFormat,
            timeFormat: incomingSettings.timeFormat,
        },
        (value) => {
            merged.language = value.language;
            merged.weekStart = value.weekStart;
            merged.dateFormat = value.dateFormat;
            merged.timeFormat = value.timeFormat;
        },
        (localValue, incomingValue, incomingWins) => mergeRecordFields(localValue, incomingValue, incomingWins)
    );

    mergeGroup(
        'externalCalendars',
        localSettings.externalCalendars,
        incomingSettings.externalCalendars,
        (value) => {
            merged.externalCalendars = value;
        }
    );

    mergeGroup(
        'ai',
        localSettings.ai,
        incomingSettings.ai,
        (value) => {
            merged.ai = sanitizeAiForSync(value, localSettings.ai);
        },
        (localValue, incomingValue, incomingWins) => chooseGroupFieldValue(localValue, incomingValue, incomingWins)
    );

    merged.syncPreferencesUpdatedAt = Object.keys(nextSyncUpdatedAt).length > 0 ? nextSyncUpdatedAt : merged.syncPreferencesUpdatedAt;
    return sanitizeMergedSettingsForSync(merged, localSettings);
};
