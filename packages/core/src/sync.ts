
import type { AppData, Attachment, Project, Task, Area, Section, SettingsSyncGroup } from './types';
import { normalizeTaskForLoad } from './task-status';
import { logWarn } from './logger';
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

export interface EntityMergeStats {
    localTotal: number;
    incomingTotal: number;
    mergedTotal: number;
    localOnly: number;
    incomingOnly: number;
    conflicts: number;
    resolvedUsingLocal: number;
    resolvedUsingIncoming: number;
    deletionsWon: number;
    conflictIds: string[];
    maxClockSkewMs: number;
    timestampAdjustments: number;
    timestampAdjustmentIds: string[];
}

export interface MergeStats {
    tasks: EntityMergeStats;
    projects: EntityMergeStats;
    sections: EntityMergeStats;
    areas: EntityMergeStats;
}

export interface MergeResult {
    data: AppData;
    stats: MergeStats;
}

export type SyncHistoryEntry = {
    at: string;
    status: 'success' | 'conflict' | 'error';
    backend?: 'file' | 'webdav' | 'cloud' | 'cloudkit' | 'off';
    type?: 'push' | 'pull' | 'merge';
    conflicts: number;
    conflictIds: string[];
    maxClockSkewMs: number;
    timestampAdjustments: number;
    details?: string;
    error?: string;
};

// Log clock skew warnings if merges show >5 minutes drift.
export const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;
// Within a small delete-vs-live window, prefer the live record to avoid accidental data loss
// from near-simultaneous "edit vs delete" races across devices.
const DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS = 5 * 1000;
const DEFAULT_TOMBSTONE_RETENTION_DAYS = 90;
const MIN_TOMBSTONE_RETENTION_DAYS = 1;
const MAX_TOMBSTONE_RETENTION_DAYS = 3650;

export type SyncStep = 'read-local' | 'read-remote' | 'merge' | 'write-local' | 'write-remote';

export type SyncCycleIO = {
    readLocal: () => Promise<AppData>;
    readRemote: () => Promise<AppData | null | undefined>;
    writeLocal: (data: AppData) => Promise<void>;
    writeRemote: (data: AppData) => Promise<void>;
    historyContext?: {
        backend?: SyncHistoryEntry['backend'];
        type?: SyncHistoryEntry['type'];
        details?: string;
    };
    tombstoneRetentionDays?: number;
    now?: () => string;
    onStep?: (step: SyncStep) => void;
    yieldToUi?: () => Promise<void>;
};

export type SyncCycleResult = {
    data: AppData;
    stats: MergeStats;
    status: 'success' | 'conflict';
};

export const appendSyncHistory = (
    settings: AppData['settings'] | undefined,
    entry: SyncHistoryEntry,
    limit: number = 50
): SyncHistoryEntry[] => {
    const history = Array.isArray(settings?.lastSyncHistory) ? settings?.lastSyncHistory ?? [] : [];
    const items = [entry, ...history];
    const next = items.filter((item) => item && typeof item.at === 'string');
    const dropped = items.length - next.length;
    if (dropped > 0) {
        logWarn('Dropped invalid sync history entries', {
            scope: 'sync',
            context: { dropped },
        });
    }
    return next.slice(0, Math.max(1, limit));
};

export const normalizeAppData = (data: AppData): AppData => ({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
    areas: Array.isArray(data.areas) ? data.areas : [],
    settings: data.settings ?? {},
});

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isValidTimestamp = (value: unknown): value is string =>
    typeof value === 'string' && Number.isFinite(Date.parse(value));

const normalizeOptionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const normalizeStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

type RevisionMetadata = {
    rev?: unknown;
    revBy?: unknown;
};

const normalizeRevisionMetadata = <T extends RevisionMetadata>(item: T): T => {
    const normalized = { ...item };
    const rawRev = normalized.rev;
    if (
        typeof rawRev !== 'number'
        || !Number.isFinite(rawRev)
        || !Number.isInteger(rawRev)
        || rawRev < 0
    ) {
        delete normalized.rev;
    }
    const rawRevBy = normalized.revBy;
    if (typeof rawRevBy === 'string') {
        const trimmed = rawRevBy.trim();
        if (trimmed.length > 0) {
            normalized.revBy = trimmed;
        } else {
            delete normalized.revBy;
        }
    } else {
        delete normalized.revBy;
    }
    return normalized;
};

const normalizeProjectStatusForMerge = (value: unknown): Project['status'] => {
    if (value === 'active' || value === 'someday' || value === 'waiting' || value === 'archived') {
        return value;
    }
    if (typeof value === 'string') {
        const lowered = value.toLowerCase().trim();
        if (lowered === 'active' || lowered === 'someday' || lowered === 'waiting' || lowered === 'archived') {
            return lowered as Project['status'];
        }
    }
    return 'active';
};

const normalizeTaskForSyncMerge = (task: Task, nowIso: string): Task => {
    const normalized = normalizeTaskForLoad(task, nowIso);
    return {
        ...normalized,
        tags: normalizeStringArray(normalized.tags),
        contexts: normalizeStringArray(normalized.contexts),
        sectionId: normalizeOptionalString(normalized.sectionId),
        isFocusedToday: normalized.isFocusedToday === true,
    };
};

const normalizeProjectForSyncMerge = (project: Project): Project => {
    return {
        ...project,
        status: normalizeProjectStatusForMerge(project.status),
        color: normalizeOptionalString(project.color) ?? '#6B7280',
        tagIds: normalizeStringArray(project.tagIds),
        isSequential: project.isSequential === true,
        isFocused: project.isFocused === true,
        areaId: normalizeOptionalString(project.areaId),
        areaTitle: normalizeOptionalString(project.areaTitle),
    };
};

const validateRevisionFields = (
    item: Record<string, unknown>,
    label: string,
    index: number,
    errors: string[]
) => {
    const rev = item.rev;
    if (rev !== undefined) {
        if (typeof rev !== 'number' || !Number.isFinite(rev) || rev < 0 || !Number.isInteger(rev)) {
            errors.push(`${label}[${index}].rev must be a non-negative integer when present`);
        }
    }
    const revBy = item.revBy;
    if (revBy !== undefined && !isNonEmptyString(revBy)) {
        errors.push(`${label}[${index}].revBy must be a non-empty string when present`);
    }
};

const validateEntityShape = (
    items: unknown[],
    label: 'tasks' | 'projects' | 'sections',
    errors: string[]
) => {
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!isObjectRecord(item)) {
            errors.push(`${label}[${index}] must be an object`);
            continue;
        }
        if (!isNonEmptyString(item.id)) {
            errors.push(`${label}[${index}].id must be a non-empty string`);
        }
        if (item.createdAt !== undefined && !isNonEmptyString(item.createdAt)) {
            errors.push(`${label}[${index}].createdAt must be a non-empty string when present`);
        } else if (isNonEmptyString(item.createdAt) && !isValidTimestamp(item.createdAt)) {
            errors.push(`${label}[${index}].createdAt must be a valid ISO timestamp when present`);
        }
        if (!isNonEmptyString(item.updatedAt)) {
            errors.push(`${label}[${index}].updatedAt must be a non-empty string`);
        } else if (!isValidTimestamp(item.updatedAt)) {
            errors.push(`${label}[${index}].updatedAt must be a valid ISO timestamp`);
        }
        if (isValidTimestamp(item.createdAt) && isValidTimestamp(item.updatedAt)) {
            const createdMs = Date.parse(item.createdAt);
            const updatedMs = Date.parse(item.updatedAt);
            if (updatedMs < createdMs) {
                errors.push(`${label}[${index}].updatedAt must be greater than or equal to createdAt`);
            }
        }
        validateRevisionFields(item, label, index, errors);
    }
};

const validateMergedSyncData = (data: AppData): string[] => {
    const errors: string[] = [];
    if (!Array.isArray(data.tasks)) errors.push('tasks must be an array');
    if (!Array.isArray(data.projects)) errors.push('projects must be an array');
    if (!Array.isArray(data.sections)) errors.push('sections must be an array');
    if (!Array.isArray(data.areas)) errors.push('areas must be an array');
    if (!isObjectRecord(data.settings)) errors.push('settings must be an object');

    if (Array.isArray(data.tasks)) validateEntityShape(data.tasks as unknown[], 'tasks', errors);
    if (Array.isArray(data.projects)) validateEntityShape(data.projects as unknown[], 'projects', errors);
    if (Array.isArray(data.sections)) validateEntityShape(data.sections as unknown[], 'sections', errors);
    if (Array.isArray(data.areas)) {
        for (let index = 0; index < data.areas.length; index += 1) {
            const area = data.areas[index] as unknown;
            if (!isObjectRecord(area)) {
                errors.push(`areas[${index}] must be an object`);
                continue;
            }
            if (!isNonEmptyString(area.id)) {
                errors.push(`areas[${index}].id must be a non-empty string`);
            }
            if (!isNonEmptyString(area.name)) {
                errors.push(`areas[${index}].name must be a non-empty string`);
            }
            if (!isNonEmptyString(area.createdAt)) {
                errors.push(`areas[${index}].createdAt must be a non-empty string`);
            } else if (!isValidTimestamp(area.createdAt)) {
                errors.push(`areas[${index}].createdAt must be a valid ISO timestamp`);
            }
            if (!isNonEmptyString(area.updatedAt)) {
                errors.push(`areas[${index}].updatedAt must be a non-empty string`);
            } else if (!isValidTimestamp(area.updatedAt)) {
                errors.push(`areas[${index}].updatedAt must be a valid ISO timestamp`);
            }
            if (isValidTimestamp(area.createdAt) && isValidTimestamp(area.updatedAt)) {
                const createdMs = Date.parse(area.createdAt);
                const updatedMs = Date.parse(area.updatedAt);
                if (updatedMs < createdMs) {
                    errors.push(`areas[${index}].updatedAt must be greater than or equal to createdAt`);
                }
            }
            validateRevisionFields(area, 'areas', index, errors);
        }
    }
    return errors;
};

const validateSyncPayloadShape = (data: unknown, source: 'local' | 'remote'): string[] => {
    const errors: string[] = [];
    if (!isObjectRecord(data)) {
        errors.push(`${source} payload must be an object`);
        return errors;
    }
    const record = data as Record<string, unknown>;
    if (record.tasks !== undefined && !Array.isArray(record.tasks)) {
        errors.push(`${source} payload field "tasks" must be an array when present`);
    }
    if (record.projects !== undefined && !Array.isArray(record.projects)) {
        errors.push(`${source} payload field "projects" must be an array when present`);
    }
    if (record.sections !== undefined && !Array.isArray(record.sections)) {
        errors.push(`${source} payload field "sections" must be an array when present`);
    }
    if (record.areas !== undefined && !Array.isArray(record.areas)) {
        errors.push(`${source} payload field "areas" must be an array when present`);
    }
    if (record.settings !== undefined && !isObjectRecord(record.settings)) {
        errors.push(`${source} payload field "settings" must be an object when present`);
    }
    return errors;
};

const resolveTombstoneRetentionDays = (value?: number): number => {
    if (!Number.isFinite(value)) return DEFAULT_TOMBSTONE_RETENTION_DAYS;
    const rounded = Math.floor(value as number);
    return Math.min(MAX_TOMBSTONE_RETENTION_DAYS, Math.max(MIN_TOMBSTONE_RETENTION_DAYS, rounded));
};

const parseTimestampOrInfinity = (value?: string): number => {
    if (!value) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const pruneAttachmentTombstones = (
    attachments: Attachment[] | undefined,
    cutoffMs: number
): { next: Attachment[] | undefined; removed: number } => {
    if (!attachments || attachments.length === 0) return { next: attachments, removed: 0 };
    let removed = 0;
    const next = attachments.filter((attachment) => {
        if (!attachment.deletedAt) return true;
        const deletedMs = parseTimestampOrInfinity(attachment.deletedAt);
        if (deletedMs <= cutoffMs) {
            removed += 1;
            return false;
        }
        return true;
    });
    return {
        next: next.length > 0 ? next : undefined,
        removed,
    };
};

export const purgeExpiredTombstones = (
    data: AppData,
    nowIso: string,
    retentionDays?: number
): {
    data: AppData;
    removedTaskTombstones: number;
    removedAttachmentTombstones: number;
    removedPendingRemoteDeletes: number;
} => {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) {
        return { data, removedTaskTombstones: 0, removedAttachmentTombstones: 0, removedPendingRemoteDeletes: 0 };
    }
    const keepDays = resolveTombstoneRetentionDays(retentionDays);
    const cutoffMs = nowMs - keepDays * 24 * 60 * 60 * 1000;

    let removedTaskTombstones = 0;
    let removedAttachmentTombstones = 0;
    const nextTasks: Task[] = [];
    for (const task of data.tasks) {
        const tombstoneAt = task.purgedAt ? parseTimestampOrInfinity(task.purgedAt) : Number.POSITIVE_INFINITY;
        if (task.deletedAt && task.purgedAt && tombstoneAt <= cutoffMs) {
            removedTaskTombstones += 1;
            continue;
        }
        const pruned = pruneAttachmentTombstones(task.attachments, cutoffMs);
        removedAttachmentTombstones += pruned.removed;
        if (pruned.removed > 0) {
            nextTasks.push({ ...task, attachments: pruned.next });
            continue;
        }
        nextTasks.push(task);
    }

    const nextProjects: Project[] = data.projects.map((project) => {
        const pruned = pruneAttachmentTombstones(project.attachments, cutoffMs);
        removedAttachmentTombstones += pruned.removed;
        return pruned.removed > 0 ? { ...project, attachments: pruned.next } : project;
    });
    const previousPendingRemoteDeletes = data.settings.attachments?.pendingRemoteDeletes;
    let removedPendingRemoteDeletes = 0;
    const nextPendingRemoteDeletes = previousPendingRemoteDeletes?.filter((entry) => {
        const lastErrorMs = parseTimestampOrInfinity(entry.lastErrorAt);
        const expired = Number.isFinite(lastErrorMs) && lastErrorMs <= cutoffMs;
        if (expired) {
            removedPendingRemoteDeletes += 1;
            return false;
        }
        return true;
    });
    const hasPendingChanged = removedPendingRemoteDeletes > 0;
    const nextSettings = hasPendingChanged
        ? {
            ...data.settings,
            attachments: {
                ...data.settings.attachments,
                pendingRemoteDeletes: nextPendingRemoteDeletes && nextPendingRemoteDeletes.length > 0
                    ? nextPendingRemoteDeletes
                    : undefined,
            },
        }
        : data.settings;

    return {
        data: {
            ...data,
            tasks: nextTasks,
            projects: nextProjects,
            settings: nextSettings,
        },
        removedTaskTombstones,
        removedAttachmentTombstones,
        removedPendingRemoteDeletes,
    };
};

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

const mergeSettingsForSync = (localSettings: AppData['settings'], incomingSettings: AppData['settings']): AppData['settings'] => {
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

/**
 * Merge entities with soft-delete support using revision-aware conflict resolution.
 *
 * Rules:
 * 1. If an item exists only in one source, include it.
 * 2. When revisions are present, resolve by operation semantics:
 *    deletion op time, revision number, timestamp, then deterministic tie-break.
 * 3. Without revisions, fall back to timestamp-based conflict resolution.
 * 4. Deleted items (deletedAt set) are preserved so deletion propagates cross-device.
 */
function createEmptyEntityStats(localTotal: number, incomingTotal: number): EntityMergeStats {
    return {
        localTotal,
        incomingTotal,
        mergedTotal: 0,
        localOnly: 0,
        incomingOnly: 0,
        conflicts: 0,
        resolvedUsingLocal: 0,
        resolvedUsingIncoming: 0,
        deletionsWon: 0,
        conflictIds: [],
        maxClockSkewMs: 0,
        timestampAdjustments: 0,
        timestampAdjustmentIds: [],
    };
}

const CONTENT_DIFF_IGNORED_KEYS = new Set([
    'rev',
    'revBy',
    'updatedAt',
    'createdAt',
    'localStatus',
    'purgedAt',
    // Order fields can differ due local adapter fallbacks (for legacy rows) without user edits.
    'order',
    'orderNum',
]);

type ComparisonNormalizer<T> = (item: T) => unknown;

const normalizeOptionalArrayForComparison = <T>(value: T[] | undefined): T[] | undefined =>
    Array.isArray(value) && value.length > 0 ? value : undefined;

const normalizeTaskForContentComparison = (task: Task): Record<string, unknown> => {
    const comparable: Record<string, unknown> = {
        ...task,
        tags: normalizeOptionalArrayForComparison(task.tags),
        contexts: normalizeOptionalArrayForComparison(task.contexts),
        checklist: normalizeOptionalArrayForComparison(task.checklist),
        attachments: normalizeOptionalArrayForComparison(task.attachments),
        isFocusedToday: task.isFocusedToday ? true : undefined,
        pushCount: task.pushCount === 0 ? undefined : task.pushCount,
    };
    if (task.status === 'inbox') delete comparable.status;
    return comparable;
};

const normalizeProjectForContentComparison = (project: Project): Record<string, unknown> => {
    const comparable: Record<string, unknown> = {
        ...project,
        tagIds: normalizeOptionalArrayForComparison(project.tagIds),
        attachments: normalizeOptionalArrayForComparison(project.attachments),
        isSequential: project.isSequential ? true : undefined,
        isFocused: project.isFocused ? true : undefined,
    };
    if (project.status === 'active') delete comparable.status;
    if (project.color === '#6B7280') delete comparable.color;
    return comparable;
};

const normalizeSectionForContentComparison = (section: Section): Record<string, unknown> => ({
    ...section,
    isCollapsed: section.isCollapsed ? true : undefined,
});

const toComparableValue = (value: unknown, options?: { includeIgnoredKeys?: boolean }): unknown => {
    const includeIgnoredKeys = options?.includeIgnoredKeys === true;
    if (Array.isArray(value)) {
        return value.map((item) => toComparableValue(item, options));
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const comparable: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            if (!includeIgnoredKeys && CONTENT_DIFF_IGNORED_KEYS.has(key)) continue;
            if (!includeIgnoredKeys && key === 'uri' && record.kind === 'file') continue;
            comparable[key] = toComparableValue(record[key], options);
        }
        return comparable;
    }
    return value;
};

const hasContentDifference = (localItem: unknown, incomingItem: unknown): boolean =>
    JSON.stringify(toComparableValue(localItem)) !== JSON.stringify(toComparableValue(incomingItem));

const comparableSignatureCache = new WeakMap<object, string>();
const deterministicSignatureCache = new WeakMap<object, string>();

const toComparableSignature = (value: unknown): string => {
    if (value && typeof value === 'object') {
        const cached = comparableSignatureCache.get(value);
        if (cached) return cached;
        const signature = JSON.stringify(toComparableValue(value));
        comparableSignatureCache.set(value, signature);
        return signature;
    }
    return JSON.stringify(toComparableValue(value));
};

const toDeterministicSignature = (value: unknown): string => {
    if (value && typeof value === 'object') {
        const cached = deterministicSignatureCache.get(value);
        if (cached) return cached;
        const signature = JSON.stringify(toComparableValue(value, { includeIgnoredKeys: true }));
        deterministicSignatureCache.set(value, signature);
        return signature;
    }
    return JSON.stringify(toComparableValue(value, { includeIgnoredKeys: true }));
};

const chooseDeterministicWinner = <T>(localItem: T, incomingItem: T): T => {
    const localSignature = toComparableSignature(localItem);
    const incomingSignature = toComparableSignature(incomingItem);
    if (localSignature === incomingSignature) {
        const localFullSignature = toDeterministicSignature(localItem);
        const incomingFullSignature = toDeterministicSignature(incomingItem);
        if (localFullSignature === incomingFullSignature) return incomingItem;
        return incomingFullSignature > localFullSignature ? incomingItem : localItem;
    }
    return incomingSignature > localSignature ? incomingItem : localItem;
};

const parseMergeTimestamp = (value: unknown, maxAllowedMs?: number): number => {
    if (typeof value !== 'string') return -1;
    const parsed = new Date(value).getTime();
    if (!Number.isFinite(parsed)) return -1;
    if (maxAllowedMs !== undefined && parsed > maxAllowedMs) {
        return maxAllowedMs;
    }
    return parsed;
};

const containsAttachmentTraversalSegment = (value: string): boolean => {
    const candidates = [value];
    try {
        const decoded = decodeURIComponent(value);
        if (decoded !== value) {
            candidates.push(decoded);
        }
    } catch {
        // Ignore malformed URI escapes and fall back to the raw string check.
    }
    return candidates.some((candidate) => /(^|[\\/])\.\.([\\/]|$)/.test(candidate));
};

const sanitizeMergedAttachmentUri = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('\0')) return undefined;
    if (containsAttachmentTraversalSegment(trimmed)) return undefined;
    return trimmed;
};

function mergeEntitiesWithStats<T extends { id: string; updatedAt: string; deletedAt?: string; rev?: number; revBy?: string }>(
    local: T[],
    incoming: T[],
    mergeConflict?: (localItem: T, incomingItem: T, winner: T) => T,
    normalizeForComparison?: ComparisonNormalizer<T>
): { merged: T[]; stats: EntityMergeStats } {
    const localMap = new Map<string, T>(local.map((item) => [item.id, item]));
    const incomingMap = new Map<string, T>(incoming.map((item) => [item.id, item]));
    const allIds = new Set<string>([...localMap.keys(), ...incomingMap.keys()]);

    const stats = createEmptyEntityStats(local.length, incoming.length);
    const merged: T[] = [];
    let invalidDeletedAtWarnings = 0;
    // Reject timestamps in the future so a clock-skewed device cannot permanently dominate merges.
    const maxAllowedMergeTime = Date.now();
    const normalizeTimestamps = <Item extends { id?: string; updatedAt: string; createdAt?: string }>(item: Item): Item => {
        if (!('createdAt' in item) || !item.createdAt) return item;
        const createdTime = new Date(item.createdAt).getTime();
        const updatedTime = new Date(item.updatedAt).getTime();
        if (!Number.isFinite(createdTime) || !Number.isFinite(updatedTime)) return item;
        if (updatedTime >= createdTime) return item;
        stats.timestampAdjustments += 1;
        if (item.id && stats.timestampAdjustmentIds.length < 20) {
            stats.timestampAdjustmentIds.push(item.id);
        }
        if (stats.timestampAdjustments <= 5) {
            logWarn('Normalized createdAt after updatedAt', {
                scope: 'sync',
                category: 'sync',
                context: { id: item.id, createdAt: item.createdAt, updatedAt: item.updatedAt },
            });
        }
        return { ...item, createdAt: item.updatedAt } as Item;
    };

    for (const id of allIds) {
        const localItem = localMap.get(id);
        const incomingItem = incomingMap.get(id);

        if (!localItem && !incomingItem) {
            continue;
        }

        if (!incomingItem) {
            stats.localOnly += 1;
            stats.resolvedUsingLocal += 1;
            merged.push(normalizeTimestamps(localItem as unknown as { updatedAt: string; createdAt?: string }) as T);
            continue;
        }

        if (!localItem) {
            stats.incomingOnly += 1;
            stats.resolvedUsingIncoming += 1;
            merged.push(normalizeTimestamps(incomingItem as unknown as { updatedAt: string; createdAt?: string }) as T);
            continue;
        }

        const normalizedLocalItem = normalizeTimestamps(localItem as unknown as { updatedAt: string; createdAt?: string }) as T;
        const normalizedIncomingItem = normalizeTimestamps(incomingItem as unknown as { updatedAt: string; createdAt?: string }) as T;

        const safeLocalTime = parseMergeTimestamp(normalizedLocalItem.updatedAt, maxAllowedMergeTime);
        const safeIncomingTime = parseMergeTimestamp(normalizedIncomingItem.updatedAt, maxAllowedMergeTime);
        const localRev = typeof normalizedLocalItem.rev === 'number' && Number.isFinite(normalizedLocalItem.rev)
            ? normalizedLocalItem.rev
            : 0;
        const incomingRev = typeof normalizedIncomingItem.rev === 'number' && Number.isFinite(normalizedIncomingItem.rev)
            ? normalizedIncomingItem.rev
            : 0;
        const localRevBy = typeof normalizedLocalItem.revBy === 'string' ? normalizedLocalItem.revBy : '';
        const incomingRevBy = typeof normalizedIncomingItem.revBy === 'string' ? normalizedIncomingItem.revBy : '';
        const hasRevision = localRev > 0 || incomingRev > 0 || !!localRevBy || !!incomingRevBy;
        const localDeleted = !!normalizedLocalItem.deletedAt;
        const incomingDeleted = !!normalizedIncomingItem.deletedAt;
        const revDiff = localRev - incomingRev;
        const revByDiff = localRevBy !== incomingRevBy;
        const comparableLocalItem = normalizeForComparison ? normalizeForComparison(normalizedLocalItem) : normalizedLocalItem;
        const comparableIncomingItem = normalizeForComparison ? normalizeForComparison(normalizedIncomingItem) : normalizedIncomingItem;
        const shouldCheckContentDiff = hasRevision
            ? revDiff === 0 && localDeleted === incomingDeleted
            : localDeleted === incomingDeleted;
        const contentDiff = shouldCheckContentDiff ? hasContentDifference(comparableLocalItem, comparableIncomingItem) : false;

        const differs = hasRevision
            ? revDiff !== 0 || localDeleted !== incomingDeleted || contentDiff
            : localDeleted !== incomingDeleted || contentDiff;

        if (differs) {
            stats.conflicts += 1;
            if (stats.conflictIds.length < 20) stats.conflictIds.push(id);
        }

        const timeDiff = safeIncomingTime - safeLocalTime;
        const absoluteSkew = Math.abs(timeDiff);
        if (absoluteSkew > stats.maxClockSkewMs) {
            stats.maxClockSkewMs = absoluteSkew;
        }
        const withinSkew = Math.abs(timeDiff) <= CLOCK_SKEW_THRESHOLD_MS;
        const resolveOperationTime = (item: T): number => {
            const updatedTime = parseMergeTimestamp(item.updatedAt, maxAllowedMergeTime);
            if (!item.deletedAt) return updatedTime;

            const deletedTimeRaw = new Date(item.deletedAt).getTime();
            if (!Number.isFinite(deletedTimeRaw)) {
                invalidDeletedAtWarnings += 1;
                if (invalidDeletedAtWarnings <= 5) {
                    logWarn('Invalid deletedAt timestamp during merge; using updatedAt fallback', {
                        scope: 'sync',
                        category: 'sync',
                        context: { id: item.id, deletedAt: item.deletedAt, updatedAt: item.updatedAt, fallbackDeletedTime: updatedTime },
                    });
                }
                return updatedTime;
            }

            return deletedTimeRaw > maxAllowedMergeTime ? maxAllowedMergeTime : deletedTimeRaw;
        };
        let winner = safeIncomingTime > safeLocalTime ? normalizedIncomingItem : normalizedLocalItem;
        const resolveDeleteVsLiveWinner = (localCandidate: T, incomingCandidate: T): T => {
            const localOpTime = resolveOperationTime(localCandidate);
            const incomingOpTime = resolveOperationTime(incomingCandidate);
            const operationDiff = incomingOpTime - localOpTime;
            if (Math.abs(operationDiff) <= DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS) {
                return localCandidate.deletedAt ? incomingCandidate : localCandidate;
            }
            if (operationDiff > 0) return incomingCandidate;
            if (operationDiff < 0) return localCandidate;
            return localCandidate.deletedAt ? incomingCandidate : localCandidate;
        };

        if (hasRevision) {
            if (localDeleted !== incomingDeleted) {
                winner = resolveDeleteVsLiveWinner(normalizedLocalItem, normalizedIncomingItem);
            } else if (revDiff !== 0) {
                winner = revDiff > 0 ? normalizedLocalItem : normalizedIncomingItem;
            } else if (safeIncomingTime !== safeLocalTime) {
                // When revisions tie, prefer fresher timestamps before revBy tie-break.
                winner = safeIncomingTime > safeLocalTime ? normalizedIncomingItem : normalizedLocalItem;
            } else if (revByDiff && localRevBy && incomingRevBy) {
                winner = incomingRevBy > localRevBy ? normalizedIncomingItem : normalizedLocalItem;
            } else {
                // Preserve deterministic convergence when metadata ties but content differs.
                winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem);
            }
        } else if (localDeleted !== incomingDeleted) {
            winner = resolveDeleteVsLiveWinner(normalizedLocalItem, normalizedIncomingItem);
        } else if (withinSkew && safeIncomingTime === safeLocalTime) {
            winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem);
        }
        if (winner === normalizedIncomingItem) stats.resolvedUsingIncoming += 1;
        else stats.resolvedUsingLocal += 1;

        if (winner.deletedAt && (!normalizedLocalItem.deletedAt || !normalizedIncomingItem.deletedAt || differs)) {
            stats.deletionsWon += 1;
        }

        const mergedItem = mergeConflict ? mergeConflict(normalizedLocalItem, normalizedIncomingItem, winner) : winner;
        merged.push(normalizeTimestamps(mergedItem as unknown as { updatedAt: string; createdAt?: string }) as T);
    }

    stats.mergedTotal = merged.length;

    return { merged, stats };
}

const normalizeAreaForMerge = (area: Area, nowIso: string): Area & { createdAt: string; updatedAt: string } => {
    const createdAt = area.createdAt || area.updatedAt || nowIso;
    const updatedAt = area.updatedAt || area.createdAt || nowIso;
    return {
        ...area,
        createdAt,
        updatedAt,
    };
};

function mergeAreas(local: Area[], incoming: Area[], nowIso: string): { merged: Area[]; stats: EntityMergeStats } {
    const localNormalized = local.map((area) => normalizeAreaForMerge(area, nowIso));
    const incomingNormalized = incoming.map((area) => normalizeAreaForMerge(area, nowIso));
    const result = mergeEntitiesWithStats(localNormalized, incomingNormalized);
    let fallbackOrder = result.merged.reduce((maxOrder, area) => {
        const order = Number.isFinite(area.order) ? area.order : -1;
        return Math.max(maxOrder, order);
    }, -1) + 1;
    const merged = result.merged.map((area) => {
        if (Number.isFinite(area.order)) return area;
        const normalized = { ...area, order: fallbackOrder };
        fallbackOrder += 1;
        return normalized;
    });
    return { merged, stats: result.stats };
}

/**
 * Filter out soft-deleted items for display purposes.
 * Call this when loading data for the UI.
 */
export function filterDeleted<T extends { deletedAt?: string }>(items: T[]): T[] {
    return items.filter(item => !item.deletedAt);
}

/**
 * Merge two AppData objects for synchronization.
 * Uses revision-aware entity merge plus deterministic tie-breakers for convergence.
 * Preserves local-only settings while merging sync-enabled settings groups.
 */
export function mergeAppDataWithStats(local: AppData, incoming: AppData): MergeResult {
    const nowIso = new Date().toISOString();
    const localNormalized: AppData = {
        ...local,
        tasks: (local.tasks || []).map((t) => normalizeRevisionMetadata(normalizeTaskForSyncMerge(t, nowIso))),
        projects: (local.projects || []).map((project) => normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))),
        sections: (local.sections || []).map((section) => normalizeRevisionMetadata(section)),
        areas: (local.areas || []).map((area) => normalizeRevisionMetadata(area)),
    };
    const incomingNormalized: AppData = {
        ...incoming,
        tasks: (incoming.tasks || []).map((t) => normalizeRevisionMetadata(normalizeTaskForSyncMerge(t, nowIso))),
        projects: (incoming.projects || []).map((project) => normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))),
        sections: (incoming.sections || []).map((section) => normalizeRevisionMetadata(section)),
        areas: (incoming.areas || []).map((area) => normalizeRevisionMetadata(area)),
    };

    const mergeAttachments = (local?: Attachment[], incoming?: Attachment[]): Attachment[] | undefined => {
        const hadExplicitAttachments = local !== undefined || incoming !== undefined;
        const localList = local || [];
        const incomingList = incoming || [];
        if (localList.length === 0 && incomingList.length === 0) {
            return hadExplicitAttachments ? [] : undefined;
        }
        const localById = new Map(localList.map((item) => [item.id, item]));
        const incomingById = new Map(incomingList.map((item) => [item.id, item]));
        const hasAvailableUri = (attachment?: Attachment): boolean => {
            return attachment?.kind === 'file'
                && attachment.localStatus !== 'missing'
                && !!sanitizeMergedAttachmentUri(attachment.uri);
        };

        const merged = mergeEntitiesWithStats(localList, incomingList, (localAttachment, incomingAttachment, winner) => {
            if (winner.kind !== 'file' || localAttachment.kind !== 'file' || incomingAttachment.kind !== 'file') {
                return winner;
            }

            const winnerIsIncoming = winner === incomingAttachment;
            const winnerHasUri = hasAvailableUri(winner);
            const localHasUri = hasAvailableUri(localAttachment);
            const incomingHasUri = hasAvailableUri(incomingAttachment);
            const winnerUri = sanitizeMergedAttachmentUri(winner.uri);
            const localUri = sanitizeMergedAttachmentUri(localAttachment.uri);
            const incomingUri = sanitizeMergedAttachmentUri(incomingAttachment.uri);

            let uri = winner.uri;
            let localStatus = winner.localStatus;

            if (winnerHasUri) {
                uri = winnerUri || winner.uri;
                localStatus = winner.localStatus || 'available';
            } else if (winnerIsIncoming && localHasUri) {
                uri = localUri || localAttachment.uri;
                localStatus = localAttachment.localStatus || 'available';
            } else if (!winnerIsIncoming && incomingHasUri) {
                uri = incomingUri || incomingAttachment.uri;
                localStatus = incomingAttachment.localStatus || 'available';
            } else {
                uri = sanitizeMergedAttachmentUri(uri) ?? '';
            }
            if ((localStatus === undefined || localStatus === null) && !!sanitizeMergedAttachmentUri(uri)) {
                localStatus = 'available';
            }

            return {
                ...winner,
                cloudKey: winner.deletedAt
                    ? winner.cloudKey
                    : winner.cloudKey || localAttachment.cloudKey || incomingAttachment.cloudKey,
                fileHash: winner.deletedAt
                    ? winner.fileHash
                    : winner.fileHash || localAttachment.fileHash || incomingAttachment.fileHash,
                uri,
                localStatus,
            };
        }).merged;

        const normalized = merged.map((attachment) => {
            if (attachment.kind !== 'file') return attachment;
            const localAttachment = localById.get(attachment.id);
            const incomingAttachment = incomingById.get(attachment.id);
            const localFile = localAttachment?.kind === 'file' ? localAttachment : undefined;
            const incomingFile = incomingAttachment?.kind === 'file' ? incomingAttachment : undefined;
            const safeUri = sanitizeMergedAttachmentUri(attachment.uri);
            const uriAvailable = !!safeUri && hasAvailableUri(attachment);
            return {
                ...attachment,
                uri: safeUri ?? '',
                cloudKey: attachment.deletedAt
                    ? attachment.cloudKey
                    : attachment.cloudKey || localFile?.cloudKey || incomingFile?.cloudKey,
                fileHash: attachment.deletedAt
                    ? attachment.fileHash
                    : attachment.fileHash || localFile?.fileHash || incomingFile?.fileHash,
                localStatus: attachment.localStatus ?? (uriAvailable ? 'available' : undefined),
            };
        });

        if (normalized.length > 0) return normalized;
        return hadExplicitAttachments ? [] : undefined;
    };

    const tasksResult = mergeEntitiesWithStats(
        localNormalized.tasks,
        incomingNormalized.tasks,
        (localTask: Task, incomingTask: Task, winner: Task) => {
            const attachments = mergeAttachments(localTask.attachments, incomingTask.attachments);
            return { ...winner, attachments };
        },
        normalizeTaskForContentComparison
    );

    const projectsResult = mergeEntitiesWithStats(
        localNormalized.projects,
        incomingNormalized.projects,
        (localProject: Project, incomingProject: Project, winner: Project) => {
            const attachments = mergeAttachments(localProject.attachments, incomingProject.attachments);
            return { ...winner, attachments };
        },
        normalizeProjectForContentComparison
    );

    const sectionsResult = mergeEntitiesWithStats(
        localNormalized.sections,
        incomingNormalized.sections,
        undefined,
        normalizeSectionForContentComparison
    );

    const areasResult = mergeAreas(localNormalized.areas, incomingNormalized.areas, nowIso);

    return {
        data: {
            tasks: tasksResult.merged,
            projects: projectsResult.merged,
            sections: sectionsResult.merged,
            areas: areasResult.merged,
            settings: mergeSettingsForSync(localNormalized.settings, incomingNormalized.settings),
        },
        stats: {
            tasks: tasksResult.stats,
            projects: projectsResult.stats,
            sections: sectionsResult.stats,
            areas: areasResult.stats,
        },
    };
}

export function mergeAppData(local: AppData, incoming: AppData): AppData {
    return mergeAppDataWithStats(local, incoming).data;
}

const withPendingRemoteWriteFlag = (data: AppData, pendingAt: string): AppData => ({
    ...data,
    settings: {
        ...data.settings,
        pendingRemoteWriteAt: pendingAt,
    },
});

const clearPendingRemoteWriteFlag = (data: AppData): AppData => {
    if (!data.settings.pendingRemoteWriteAt) return data;
    return {
        ...data,
        settings: {
            ...data.settings,
            pendingRemoteWriteAt: undefined,
        },
    };
};

const hasPendingRemoteWriteFlag = (data: AppData): boolean => isValidTimestamp(data.settings.pendingRemoteWriteAt);

export async function performSyncCycle(io: SyncCycleIO): Promise<SyncCycleResult> {
    const nowIso = io.now ? io.now() : new Date().toISOString();
    const yieldToUi = async () => {
        if (typeof io.yieldToUi === 'function') {
            await io.yieldToUi();
        }
    };

    io.onStep?.('read-local');
    await yieldToUi();
    const localDataRaw = await io.readLocal();
    const localShapeErrors = validateSyncPayloadShape(localDataRaw, 'local');
    if (localShapeErrors.length > 0) {
        const sample = localShapeErrors.slice(0, 3).join('; ');
        throw new Error(`Invalid local sync payload: ${sample}`);
    }
    const localNormalized = normalizeAppData(localDataRaw);
    let localData = purgeExpiredTombstones(localNormalized, nowIso, io.tombstoneRetentionDays).data;

    if (hasPendingRemoteWriteFlag(localData)) {
        io.onStep?.('write-remote');
        await yieldToUi();
        await io.writeRemote(localData);
        const recoveredLocalData = clearPendingRemoteWriteFlag(localData);
        if (recoveredLocalData !== localData) {
            io.onStep?.('write-local');
            await yieldToUi();
            await io.writeLocal(recoveredLocalData);
        }
        localData = recoveredLocalData;
    }

    io.onStep?.('read-remote');
    await yieldToUi();
    const remoteDataRaw = await io.readRemote();
    if (remoteDataRaw) {
        const remoteShapeErrors = validateSyncPayloadShape(remoteDataRaw, 'remote');
        if (remoteShapeErrors.length > 0) {
            const sample = remoteShapeErrors.slice(0, 3).join('; ');
            logWarn('Invalid remote sync payload shape', {
                scope: 'sync',
                context: {
                    issues: remoteShapeErrors.length,
                    sample,
                },
            });
            throw new Error(`Invalid remote sync payload: ${sample}`);
        }
    }
    const remoteNormalized = normalizeAppData(remoteDataRaw || { tasks: [], projects: [], sections: [], areas: [], settings: {} });
    const remoteData = purgeExpiredTombstones(remoteNormalized, nowIso, io.tombstoneRetentionDays).data;

    io.onStep?.('merge');
    await yieldToUi();
    const mergeResult = mergeAppDataWithStats(localData, remoteData);
    const conflictCount = (mergeResult.stats.tasks.conflicts || 0)
        + (mergeResult.stats.projects.conflicts || 0)
        + (mergeResult.stats.sections.conflicts || 0)
        + (mergeResult.stats.areas.conflicts || 0);
    const nextSyncStatus: SyncCycleResult['status'] = conflictCount > 0 ? 'conflict' : 'success';
    const conflictIds = [
        ...(mergeResult.stats.tasks.conflictIds || []),
        ...(mergeResult.stats.projects.conflictIds || []),
        ...(mergeResult.stats.sections.conflictIds || []),
        ...(mergeResult.stats.areas.conflictIds || []),
    ].slice(0, 10);
    const maxClockSkewMs = Math.max(
        mergeResult.stats.tasks.maxClockSkewMs || 0,
        mergeResult.stats.projects.maxClockSkewMs || 0,
        mergeResult.stats.sections.maxClockSkewMs || 0,
        mergeResult.stats.areas.maxClockSkewMs || 0
    );
    if (maxClockSkewMs > CLOCK_SKEW_THRESHOLD_MS) {
        logWarn('Sync merge detected large clock skew', {
            scope: 'sync',
            context: {
                maxClockSkewMs: Math.round(maxClockSkewMs),
                thresholdMs: CLOCK_SKEW_THRESHOLD_MS,
            },
        });
    }
    const timestampAdjustments = (mergeResult.stats.tasks.timestampAdjustments || 0)
        + (mergeResult.stats.projects.timestampAdjustments || 0)
        + (mergeResult.stats.sections.timestampAdjustments || 0)
        + (mergeResult.stats.areas.timestampAdjustments || 0);
    const historyEntry: SyncHistoryEntry = {
        at: nowIso,
        status: nextSyncStatus,
        backend: io.historyContext?.backend,
        type: io.historyContext?.type ?? 'merge',
        conflicts: conflictCount,
        conflictIds,
        maxClockSkewMs,
        timestampAdjustments,
        details: io.historyContext?.details,
    };
    const nextHistory = appendSyncHistory(mergeResult.data.settings, historyEntry);
    const nextMergedData: AppData = {
        ...mergeResult.data,
        settings: {
            ...mergeResult.data.settings,
            lastSyncAt: nowIso,
            lastSyncStatus: nextSyncStatus,
            lastSyncError: undefined,
            lastSyncStats: mergeResult.stats,
            lastSyncHistory: nextHistory,
        },
    };
    const pruned = purgeExpiredTombstones(nextMergedData, nowIso, io.tombstoneRetentionDays);
    if (pruned.removedTaskTombstones > 0 || pruned.removedAttachmentTombstones > 0 || pruned.removedPendingRemoteDeletes > 0) {
        logWarn('Purged expired sync tombstones', {
            scope: 'sync',
            context: {
                removedTaskTombstones: pruned.removedTaskTombstones,
                removedAttachmentTombstones: pruned.removedAttachmentTombstones,
                removedPendingRemoteDeletes: pruned.removedPendingRemoteDeletes,
            },
        });
    }
    const finalData = pruned.data;
    const validationErrors = validateMergedSyncData(finalData);
    if (validationErrors.length > 0) {
        const sample = validationErrors.slice(0, 3).join('; ');
        logWarn('Sync merge validation failed', {
            scope: 'sync',
            context: {
                issues: validationErrors.length,
                sample,
            },
        });
        throw new Error(`Sync validation failed: ${sample}`);
    }

    const finalDataWithPendingRemoteWrite = withPendingRemoteWriteFlag(finalData, nowIso);
    io.onStep?.('write-local');
    await yieldToUi();
    await io.writeLocal(finalDataWithPendingRemoteWrite);

    // Write local first so a local persistence failure cannot leave remote ahead.
    io.onStep?.('write-remote');
    await yieldToUi();
    await io.writeRemote(finalDataWithPendingRemoteWrite);

    const persistedFinalData = clearPendingRemoteWriteFlag(finalDataWithPendingRemoteWrite);
    if (persistedFinalData !== finalDataWithPendingRemoteWrite) {
        await yieldToUi();
        await io.writeLocal(persistedFinalData);
    }

    return { data: persistedFinalData, stats: mergeResult.stats, status: nextSyncStatus };
}
