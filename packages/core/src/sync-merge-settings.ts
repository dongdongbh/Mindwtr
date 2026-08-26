import type { AiSettings, AppData, GtdSettings, SavedFilter, SettingsSyncGroup, SettingsSyncPreferences } from './types';
import {
    AI_PROVIDER_VALUE_SET,
    AI_REASONING_EFFORT_VALUE_SET,
    GTD_SYNCED_FIELD_KEYS,
    SETTINGS_DEFAULT_PROJECT_FLOW_MODE_VALUE_SET,
    SETTINGS_DEFAULT_TASK_AREA_MODE_VALUE_SET,
    SETTINGS_DENSITY_VALUE_SET,
    SETTINGS_FOCUS_GROUP_BY_VALUE_SET,
    SETTINGS_KEYBINDING_STYLE_VALUE_SET,
    SETTINGS_LANGUAGE_VALUE_SET,
    SETTINGS_MOBILE_QUICK_ACCESS_VIEW_VALUE_SET,
    SETTINGS_TEXT_SIZE_VALUE_SET,
    SETTINGS_THEME_VALUE_SET,
    SETTINGS_TIME_FORMAT_VALUE_SET,
    SETTINGS_WEEK_START_VALUE_SET,
    STT_FIELD_STRATEGY_VALUE_SET,
    STT_MODE_VALUE_SET,
    STT_PROVIDER_VALUE_SET,
    type GtdSyncedFieldKey,
} from './settings-options';
import { isNonEmptyString, isObjectRecord, isValidTimestamp } from './sync-normalization';
import { MAX_FOCUS_TASK_LIMIT, MIN_FOCUS_TASK_LIMIT, normalizeFocusTaskLimit } from './focus-utils';
import { normalizeSavedFilters } from './saved-filters';
import { chooseDeterministicWinner } from './sync-signatures';
import { DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS } from './sync-types';
import { normalizeExternalCalendarColor } from './external-calendar-colors';

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

const getSavedFilterOperationTime = (filter: SavedFilter): number => {
    const updatedAt = parseSyncTimestamp(filter.updatedAt);
    const deletedAt = parseSyncTimestamp(filter.deletedAt);
    if (!Number.isFinite(deletedAt)) return updatedAt;
    if (!Number.isFinite(updatedAt)) return deletedAt;
    return Math.max(updatedAt, deletedAt);
};

const chooseDeletedSavedFilter = (localFilter: SavedFilter, incomingFilter: SavedFilter): SavedFilter => {
    if (localFilter.deletedAt && !incomingFilter.deletedAt) return localFilter;
    if (incomingFilter.deletedAt && !localFilter.deletedAt) return incomingFilter;
    return chooseDeterministicWinner(localFilter, incomingFilter);
};

const chooseSavedFilter = (localFilter: SavedFilter, incomingFilter: SavedFilter, incomingWins: boolean): SavedFilter => {
    const localDeleted = !!localFilter.deletedAt;
    const incomingDeleted = !!incomingFilter.deletedAt;
    if (localDeleted !== incomingDeleted) {
        const localOperationTime = getSavedFilterOperationTime(localFilter);
        const incomingOperationTime = getSavedFilterOperationTime(incomingFilter);
        if (Number.isFinite(localOperationTime) && Number.isFinite(incomingOperationTime)) {
            const operationDiff = incomingOperationTime - localOperationTime;
            if (Math.abs(operationDiff) <= DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS) {
                return chooseDeletedSavedFilter(localFilter, incomingFilter);
            }
            return operationDiff > 0 ? incomingFilter : localFilter;
        }
        return chooseDeletedSavedFilter(localFilter, incomingFilter);
    }

    const localUpdatedAt = parseSyncTimestamp(localFilter.updatedAt);
    const incomingUpdatedAt = parseSyncTimestamp(incomingFilter.updatedAt);
    if (Number.isFinite(incomingUpdatedAt) && !Number.isFinite(localUpdatedAt)) return incomingFilter;
    if (!Number.isFinite(incomingUpdatedAt) && Number.isFinite(localUpdatedAt)) return localFilter;
    if (Number.isFinite(incomingUpdatedAt) && Number.isFinite(localUpdatedAt)) {
        const updatedAtDiff = incomingUpdatedAt - localUpdatedAt;
        if (updatedAtDiff > 0) return incomingFilter;
        if (updatedAtDiff < 0) return localFilter;
        return chooseDeterministicWinner(localFilter, incomingFilter);
    }
    return incomingWins ? incomingFilter : localFilter;
};

const mergeSavedFiltersById = (
    localValue: AppData['settings']['savedFilters'],
    incomingValue: AppData['settings']['savedFilters'],
    incomingWins: boolean
): AppData['settings']['savedFilters'] => {
    const localFilters = normalizeSavedFilters(localValue);
    const incomingFilters = normalizeSavedFilters(incomingValue);
    const incomingById = new Map(incomingFilters.map((filter) => [filter.id, filter]));
    const mergedById = new Map<string, SavedFilter>();

    for (const localFilter of localFilters) {
        const incomingFilter = incomingById.get(localFilter.id);
        mergedById.set(
            localFilter.id,
            incomingFilter ? chooseSavedFilter(localFilter, incomingFilter, incomingWins) : localFilter
        );
    }
    for (const incomingFilter of incomingFilters) {
        if (!mergedById.has(incomingFilter.id)) {
            mergedById.set(incomingFilter.id, incomingFilter);
        }
    }

    return normalizeSavedFilters(Array.from(mergedById.values()));
};

const sanitizeAiForSync = (
    ai: AiSettings | undefined,
    localAi?: AiSettings
): AiSettings | undefined => {
    if (!ai) return ai;
    const sanitized: AiSettings = {
        ...ai,
        apiKey: undefined,
    };
    if (sanitized.speechToText) {
        const localSpeechToText = localAi?.speechToText;
        const keepLocalOfflineModelPath = Boolean(localSpeechToText?.offlineModelPath)
            && sanitized.speechToText.provider === localSpeechToText?.provider
            && sanitized.speechToText.model === localSpeechToText?.model;
        sanitized.speechToText = {
            ...sanitized.speechToText,
            offlineModelPath: keepLocalOfflineModelPath ? localSpeechToText?.offlineModelPath : undefined,
        };
    }
    return sanitized;
};

const SETTINGS_SYNC_GROUP_KEYS: SettingsSyncGroup[] = ['appearance', 'language', 'gtd', 'externalCalendars', 'ai', 'savedFilters'];
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

const setContainsValue = <T extends string>(set: ReadonlySet<T>, value: unknown): value is T => (
    typeof value === 'string' && set.has(value as T)
);

const sanitizeSyncPreferences = (
    value: SettingsSyncPreferences | undefined,
    fallback: SettingsSyncPreferences | undefined
): SettingsSyncPreferences | undefined => {
    if (value === undefined) return fallback ? cloneSettingValue(fallback) : undefined;
    if (!isObjectRecord(value)) return fallback ? cloneSettingValue(fallback) : undefined;
    const next: SettingsSyncPreferences = {};
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
    const isValidCalendar = (item: unknown): item is { color?: unknown; id: string; name: string; url: string; enabled: boolean } =>
        isObjectRecord(item)
        && isNonEmptyString(item.id)
        && isNonEmptyString(item.name)
        && isNonEmptyString(item.url)
        && typeof item.enabled === 'boolean';
    const isLocalCalendarSource = (item: { url: string }): boolean => {
        const url = item.url.trim().toLowerCase();
        return url.startsWith('file://') || url.startsWith('content://');
    };
    const sanitizeCalendar = (item: { color?: unknown; id: string; name: string; url: string; enabled: boolean }) => {
        const color = normalizeExternalCalendarColor(item.color);
        return {
            id: item.id.trim(),
            name: item.name.trim(),
            url: item.url.trim(),
            enabled: item.enabled,
            ...(color ? { color } : {}),
        };
    };
    const next = value
        .filter(isValidCalendar)
        .filter((item) => !isLocalCalendarSource(item))
        .map(sanitizeCalendar);
    const deduped = new Map<string, (typeof next)[number]>();
    for (const item of next) {
        deduped.set(item.id, item);
    }
    for (const item of fallback ?? []) {
        if (!isValidCalendar(item) || !isLocalCalendarSource(item)) continue;
        const localSource = sanitizeCalendar(item);
        if (!deduped.has(localSource.id)) {
            deduped.set(localSource.id, localSource);
        }
    }
    if (value.length > 0 && deduped.size === 0 && fallback) {
        return cloneSettingValue(fallback);
    }
    return Array.from(deduped.values());
};

const sanitizeAiSettings = (
    value: AiSettings | undefined,
    fallback: AiSettings | undefined
): AiSettings | undefined => {
    if (value === undefined) return fallback ? sanitizeAiForSync(cloneSettingValue(fallback), fallback) : undefined;
    if (!isObjectRecord(value)) return fallback ? sanitizeAiForSync(cloneSettingValue(fallback), fallback) : undefined;
    const next: AiSettings = cloneSettingValue(value as AiSettings);
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
    if (next.openAIExtraBodyParams !== undefined && !isObjectRecord(next.openAIExtraBodyParams)) {
        next.openAIExtraBodyParams = fallback?.openAIExtraBodyParams;
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
        if (next.speechToText.provider !== undefined && !setContainsValue(STT_PROVIDER_VALUE_SET, next.speechToText.provider)) {
            next.speechToText.provider = speechFallback?.provider;
        }
        if (next.speechToText.model !== undefined && !isNonEmptyString(next.speechToText.model)) {
            next.speechToText.model = speechFallback?.model;
        }
        if (next.speechToText.language !== undefined && !isNonEmptyString(next.speechToText.language)) {
            next.speechToText.language = speechFallback?.language;
        }
        if (next.speechToText.mode !== undefined && !setContainsValue(STT_MODE_VALUE_SET, next.speechToText.mode)) {
            next.speechToText.mode = speechFallback?.mode;
        }
        if (
            next.speechToText.fieldStrategy !== undefined
            && !setContainsValue(STT_FIELD_STRATEGY_VALUE_SET, next.speechToText.fieldStrategy)
        ) {
            next.speechToText.fieldStrategy = speechFallback?.fieldStrategy;
        }
    }
    return sanitizeAiForSync(next, fallback);
};

export const sanitizeMergedSettingsForSync = (
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
    } else if (next.appearance) {
        const fallbackAppearance = localSettings.appearance ? cloneSettingValue(localSettings.appearance) : {};
        let didSanitizeAppearance = false;

        if (next.appearance.density !== undefined && !setContainsValue(SETTINGS_DENSITY_VALUE_SET, next.appearance.density)) {
            next.appearance = {
                ...fallbackAppearance,
                ...next.appearance,
                density: localSettings.appearance?.density,
            };
            didSanitizeAppearance = true;
        }
        const sanitizedAppearance = next.appearance;
        if (
            sanitizedAppearance
            && sanitizedAppearance.textSize !== undefined
            && !setContainsValue(SETTINGS_TEXT_SIZE_VALUE_SET, sanitizedAppearance.textSize)
        ) {
            next.appearance = {
                ...fallbackAppearance,
                ...sanitizedAppearance,
                textSize: localSettings.appearance?.textSize,
            };
            didSanitizeAppearance = true;
        }
        const appearanceWithTextSize = next.appearance;
        if (
            appearanceWithTextSize
            && appearanceWithTextSize.showFutureStarts !== undefined
            && typeof appearanceWithTextSize.showFutureStarts !== 'boolean'
        ) {
            next.appearance = {
                ...fallbackAppearance,
                ...appearanceWithTextSize,
                showFutureStarts: localSettings.appearance?.showFutureStarts,
            };
            if (next.appearance.showFutureStarts === undefined) {
                delete next.appearance.showFutureStarts;
            }
            didSanitizeAppearance = true;
        }
        const appearanceWithFutureStarts = next.appearance;
        if (
            appearanceWithFutureStarts
            && appearanceWithFutureStarts.mobileQuickAccessView !== undefined
            && !setContainsValue(SETTINGS_MOBILE_QUICK_ACCESS_VIEW_VALUE_SET, appearanceWithFutureStarts.mobileQuickAccessView)
        ) {
            next.appearance = {
                ...fallbackAppearance,
                ...appearanceWithFutureStarts,
                mobileQuickAccessView: localSettings.appearance?.mobileQuickAccessView,
            };
            if (next.appearance.mobileQuickAccessView === undefined) {
                delete next.appearance.mobileQuickAccessView;
            }
            didSanitizeAppearance = true;
        }

        const finalAppearance = next.appearance;
        if (
            didSanitizeAppearance
            && finalAppearance
            && Object.values(finalAppearance).every((value) => value === undefined)
        ) {
            next.appearance = Object.keys(fallbackAppearance).length > 0 ? next.appearance : undefined;
        }
    }

    if (next.gtd !== undefined && !isObjectRecord(next.gtd)) {
        next.gtd = localSettings.gtd ? cloneSettingValue(localSettings.gtd) : undefined;
    } else if (next.gtd) {
        if (next.gtd.focusTaskLimit !== undefined) {
            const rawLimit = next.gtd.focusTaskLimit;
            if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < MIN_FOCUS_TASK_LIMIT || rawLimit > MAX_FOCUS_TASK_LIMIT) {
                next.gtd = {
                    ...next.gtd,
                    focusTaskLimit: localSettings.gtd?.focusTaskLimit,
                };
                if (next.gtd.focusTaskLimit === undefined) {
                    delete next.gtd.focusTaskLimit;
                }
            } else {
                next.gtd = {
                    ...next.gtd,
                    focusTaskLimit: normalizeFocusTaskLimit(rawLimit),
                };
            }
        }

        if (next.gtd.focusGroupBy !== undefined && !setContainsValue(SETTINGS_FOCUS_GROUP_BY_VALUE_SET, next.gtd.focusGroupBy)) {
            next.gtd = {
                ...next.gtd,
                focusGroupBy: localSettings.gtd?.focusGroupBy,
            };
            if (next.gtd.focusGroupBy === undefined) {
                delete next.gtd.focusGroupBy;
            }
        }

        if (
            next.gtd.defaultAreaMode !== undefined
            && !setContainsValue(SETTINGS_DEFAULT_TASK_AREA_MODE_VALUE_SET, next.gtd.defaultAreaMode)
        ) {
            next.gtd = {
                ...next.gtd,
                defaultAreaMode: localSettings.gtd?.defaultAreaMode,
            };
            if (next.gtd.defaultAreaMode === undefined) {
                delete next.gtd.defaultAreaMode;
            }
        }

        if (
            next.gtd.defaultAreaId !== undefined
            && next.gtd.defaultAreaId !== null
            && !isNonEmptyString(next.gtd.defaultAreaId)
        ) {
            next.gtd = {
                ...next.gtd,
                defaultAreaId: localSettings.gtd?.defaultAreaId,
            };
            if (next.gtd.defaultAreaId === undefined) {
                delete next.gtd.defaultAreaId;
            }
        }

        if (next.gtd.taskEditor !== undefined) {
            // Structural guard only: unknown field ids and extra keys pass
            // through so an older device never strips (and then re-uploads
            // without) layout values a newer client wrote — that asymmetry
            // would churn forever. Wrong-typed sub-values are dropped because
            // the load-time defaults migration calls .filter on order/hidden.
            const rawTaskEditor = next.gtd.taskEditor;
            if (!isObjectRecord(rawTaskEditor)) {
                next.gtd = { ...next.gtd, taskEditor: localSettings.gtd?.taskEditor };
                if (next.gtd.taskEditor === undefined) {
                    delete next.gtd.taskEditor;
                }
            } else {
                const sanitizedTaskEditor: Record<string, unknown> = { ...rawTaskEditor };
                for (const key of ['order', 'hidden'] as const) {
                    if (key in sanitizedTaskEditor && !Array.isArray(sanitizedTaskEditor[key])) {
                        delete sanitizedTaskEditor[key];
                    }
                }
                for (const key of ['sections', 'sectionOpen'] as const) {
                    if (key in sanitizedTaskEditor && !isObjectRecord(sanitizedTaskEditor[key])) {
                        delete sanitizedTaskEditor[key];
                    }
                }
                if ('presentation' in sanitizedTaskEditor && typeof sanitizedTaskEditor.presentation !== 'string') {
                    delete sanitizedTaskEditor.presentation;
                }
                if ('defaultsVersion' in sanitizedTaskEditor && typeof sanitizedTaskEditor.defaultsVersion !== 'number') {
                    delete sanitizedTaskEditor.defaultsVersion;
                }
                next.gtd = { ...next.gtd, taskEditor: sanitizedTaskEditor as GtdSettings['taskEditor'] };
            }
        }

        if (
            next.gtd.defaultProjectFlowMode !== undefined
            && !setContainsValue(SETTINGS_DEFAULT_PROJECT_FLOW_MODE_VALUE_SET, next.gtd.defaultProjectFlowMode)
        ) {
            next.gtd = {
                ...next.gtd,
                defaultProjectFlowMode: localSettings.gtd?.defaultProjectFlowMode,
            };
            if (next.gtd.defaultProjectFlowMode === undefined) {
                delete next.gtd.defaultProjectFlowMode;
            }
        }
    }

    next.syncPreferences = sanitizeSyncPreferences(next.syncPreferences, localSettings.syncPreferences);
    next.syncPreferencesUpdatedAt = sanitizeSyncPreferencesUpdatedAt(
        next.syncPreferencesUpdatedAt,
        localSettings.syncPreferencesUpdatedAt
    );
    next.externalCalendars = sanitizeExternalCalendars(next.externalCalendars, localSettings.externalCalendars);
    next.ai = sanitizeAiSettings(next.ai, localSettings.ai);
    if (next.savedFilters !== undefined) {
        next.savedFilters = normalizeSavedFilters(next.savedFilters);
    }

    return next;
};

export const mergeSettingsForSync = (
    localSettings: AppData['settings'],
    incomingSettings: AppData['settings']
): AppData['settings'] => {
    const merged: AppData['settings'] = { ...localSettings };
    const nextSyncUpdatedAt: NonNullable<AppData['settings']['syncPreferencesUpdatedAt']> = {};

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
    // Picks the synced subset of gtd fields, driven by GTD_SYNCED_FIELD_KEYS
    // (settings-options.ts) — the single source of truth shared with the
    // upload allowlist in sanitizeSettingsForRemote (sync-helpers.ts). Add new
    // synced gtd fields there, not here.
    const pickGtdSyncedFields = (gtd: GtdSettings | undefined): Pick<GtdSettings, GtdSyncedFieldKey> => {
        const picked: Pick<GtdSettings, GtdSyncedFieldKey> = {};
        for (const key of GTD_SYNCED_FIELD_KEYS) {
            (picked as Record<GtdSyncedFieldKey, unknown>)[key] = gtd?.[key];
        }
        return picked;
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
    type AppearanceSyncValue = {
        theme: AppData['settings']['theme'];
        appearance: AppData['settings']['appearance'];
        keybindingStyle: AppData['settings']['keybindingStyle'];
    };
    const mergeAppearanceGroupValue = (
        localValue: AppearanceSyncValue,
        incomingValue: AppearanceSyncValue,
        incomingWins: boolean
    ): AppearanceSyncValue => {
        const mergedValue = mergeRecordFields(localValue, incomingValue, incomingWins);
        const mergedAppearance = mergeRecordFields(
            (localValue.appearance ?? {}) as Record<string, unknown>,
            (incomingValue.appearance ?? {}) as Record<string, unknown>,
            incomingWins
        ) as AppData['settings']['appearance'];
        mergedValue.appearance = mergedAppearance && Object.keys(mergedAppearance).length > 0
            ? mergedAppearance
            : undefined;
        return mergedValue;
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
        const localOptedOut = localSettings.syncPreferences?.[key] === false;
        const incomingWins = localOptedOut ? false : isIncomingNewer(localAt, incomingAt);
        const effectiveIncomingValue = localOptedOut ? localValue : incomingValue;
        const resolvedValue = mergeValues
            ? mergeValues(localValue, effectiveIncomingValue, incomingWins)
            : (incomingWins ? effectiveIncomingValue : localValue);
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
        (localValue, incomingValue, incomingWins) => mergeAppearanceGroupValue(localValue, incomingValue, incomingWins)
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
        'gtd',
        pickGtdSyncedFields(localSettings.gtd),
        pickGtdSyncedFields(incomingSettings.gtd),
        (value) => {
            const nextGtd = { ...(merged.gtd ?? {}) } as Record<string, unknown>;
            for (const key of GTD_SYNCED_FIELD_KEYS) {
                const fieldValue = value[key];
                if (fieldValue === undefined) {
                    delete nextGtd[key];
                } else {
                    nextGtd[key] = fieldValue;
                }
            }
            if (Object.keys(nextGtd).length === 0) {
                if (merged.gtd) {
                    delete merged.gtd;
                }
            } else {
                merged.gtd = nextGtd as GtdSettings;
            }
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
        'savedFilters',
        localSettings.savedFilters,
        incomingSettings.savedFilters,
        (value) => {
            merged.savedFilters = normalizeSavedFilters(value);
        },
        (localValue, incomingValue, incomingWins) => mergeSavedFiltersById(localValue, incomingValue, incomingWins)
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
