import type { AppData, Project, Task } from './types';
import { normalizeTaskForLoad } from './task-status';
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

export const normalizeAppData = (data: AppData): AppData => ({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
    areas: Array.isArray(data.areas) ? data.areas : [],
    settings: data.settings ?? {},
});

export const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

export const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const isValidTimestamp = (value: unknown): value is string =>
    typeof value === 'string' && Number.isFinite(Date.parse(value));

const normalizeOptionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const normalizeStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

type RevisionMetadata = {
    rev?: unknown;
    revBy?: unknown;
};

export const normalizeRevisionMetadata = <T extends RevisionMetadata>(item: T): T => {
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

export const normalizeTaskForSyncMerge = (task: Task, nowIso: string): Task => {
    const normalized = normalizeTaskForLoad(task, nowIso);
    return {
        ...normalized,
        tags: normalizeStringArray(normalized.tags),
        contexts: normalizeStringArray(normalized.contexts),
        sectionId: normalizeOptionalString(normalized.sectionId),
        isFocusedToday: normalized.isFocusedToday === true,
    };
};

export const normalizeProjectForSyncMerge = (project: Project): Project => {
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

export const validateMergedSyncData = (data: AppData): string[] => {
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

export const validateSyncPayloadShape = (data: unknown, source: 'local' | 'remote'): string[] => {
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

export const sanitizeMergedSettingsForSync = (
    merged: AppData['settings'],
    localSettings: AppData['settings']
): AppData['settings'] => {
    const next: AppData['settings'] = typeof globalThis.structuredClone === 'function'
        ? globalThis.structuredClone(merged)
        : JSON.parse(JSON.stringify(merged));

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
        next.appearance = localSettings.appearance
            ? (typeof globalThis.structuredClone === 'function'
                ? globalThis.structuredClone(localSettings.appearance)
                : JSON.parse(JSON.stringify(localSettings.appearance)))
            : undefined;
    } else if (next.appearance?.density !== undefined && !SETTINGS_DENSITY_VALUE_SET.has(next.appearance.density)) {
        next.appearance = {
            ...(localSettings.appearance
                ? (typeof globalThis.structuredClone === 'function'
                    ? globalThis.structuredClone(localSettings.appearance)
                    : JSON.parse(JSON.stringify(localSettings.appearance)))
                : {}),
            ...next.appearance,
            density: localSettings.appearance?.density,
        };
    }

    if (next.ai?.enabled !== undefined && typeof next.ai.enabled !== 'boolean') {
        next.ai.enabled = localSettings.ai?.enabled;
    }
    if (next.ai?.provider !== undefined && !AI_PROVIDER_VALUE_SET.has(next.ai.provider)) {
        next.ai.provider = localSettings.ai?.provider;
    }
    if (next.ai?.reasoningEffort !== undefined && !AI_REASONING_EFFORT_VALUE_SET.has(next.ai.reasoningEffort)) {
        next.ai.reasoningEffort = localSettings.ai?.reasoningEffort;
    }
    if (next.ai?.speechToText?.provider !== undefined && !STT_PROVIDER_VALUE_SET.has(next.ai.speechToText.provider)) {
        next.ai.speechToText.provider = localSettings.ai?.speechToText?.provider;
    }
    if (next.ai?.speechToText?.mode !== undefined && !STT_MODE_VALUE_SET.has(next.ai.speechToText.mode)) {
        next.ai.speechToText.mode = localSettings.ai?.speechToText?.mode;
    }
    if (
        next.ai?.speechToText?.fieldStrategy !== undefined
        && !STT_FIELD_STRATEGY_VALUE_SET.has(next.ai.speechToText.fieldStrategy)
    ) {
        next.ai.speechToText.fieldStrategy = localSettings.ai?.speechToText?.fieldStrategy;
    }

    return next;
};
