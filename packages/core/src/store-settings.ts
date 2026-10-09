import { logInfo, logWarn } from './logger';
import { summarizeTaskLifecycleCounts } from './task-utils';
import { markCoreStartupPhase, measureCoreStartupPhase } from './startup-profiler';
import { normalizeTaskForLoad } from './task-status';
import { normalizeProjectLifecycleFields } from './project-status';
import type { StorageAdapter } from './storage';
import type { AppData, AppSettings, Area, SavedFilter, Task, TaskEditorFieldId, TaskEditorSectionId } from './types';
import type { DerivedCache, SavedSearchWriteScope, TaskStore } from './store-types';
import type { FocusControlState } from './focus-controls';
import { buildFocusControlsModel } from './focus-controls';
import {
    computeProjectDerivedState,
    computeTaskDerivedState,
    ensureDeviceId,
    getNextDataChangeAt,
    hasSameEntityIdentity,
    normalizeAiSettingsForSync,
    persist,
    reconcileEntityCollection,
    reuseArrayIfShallowEqual,
    reuseSettingsIfEquivalent,
    selectFocusedCount,
    selectVisibleAreas,
    selectVisiblePeople,
    selectVisibleProjects,
    selectVisibleSections,
    selectVisibleTasks,
    stripSensitiveSettings,
    withTimeout,
} from './store-helpers';
import { advanceLatestSyncTimestamp, SYNC_STATUS_BOOKKEEPING_SETTINGS_KEYS } from './sync-helpers';
import { getGtdSyncSnapshot } from './settings-options';
import { DEFAULT_TOMBSTONE_RETENTION_DAYS, purgeExpiredTombstones } from './sync-tombstones';
import { buildLoadContext, runAutoArchive, runLoadMigrations } from './store-load-migrations';
import { createSeedGettingStartedAction } from './getting-started-seed';
import { beginNotifyProfile, endNotifyProfile, profilerNow, recordDerivedStateRebuild, type NotifyProfile } from './store-notify-profiler';
import { buildGeneralSettingsUpdate } from './general-settings-model';
import { buildGtdSettingsUpdate, GTD_DEFAULT_AREA_ACTIVE_OPTION, isGtdSettingStored } from './gtd-settings-model';
import { DEFAULT_TASK_EDITOR_ORDER, TASK_EDITOR_SECTION_ORDER } from './task-editor-layout';
import { generalPreferenceWitness } from './general-preference-witness';
import { notificationSettingWitness } from './notification-settings-model';
import { calendarSubscriptionSettingSource, planCalendarSubscriptionSetting } from './calendar-subscription-settings-witness';
import { taskEditValuesEqual } from './json-value-equality';
import { backfillArchiveClocks, getArchiveRetentionPreview, isArchiveRetentionDays } from './archive-retention';

const STORAGE_TIMEOUT_MS = 15_000;
// Runtime diagnostic threshold: loads slower than this get a phase-breakdown log line.
const SLOW_FETCH_LOG_THRESHOLD_MS = 1_000;
const getFetchDataErrorMessage = (error: unknown): string => {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = detail.trim();
    if (!trimmed) return 'Failed to fetch data';
    if (/timed out/i.test(trimmed)) return 'Storage request timed out. Try again.';
    return `Failed to fetch data: ${trimmed}`;
};
const NON_MUTATING_SETTINGS_KEYS = new Set<keyof AppData['settings']>(SYNC_STATUS_BOOKKEEPING_SETTINGS_KEYS);

let derivedCache: DerivedCache | null = null;

export const clearDerivedCache = () => {
    derivedCache = null;
};

let documentReplacementPending = false;

/**
 * Declares that the next load reads a document the caller just persisted in
 * full (Restore Backup, import apply). Such a document is authoritative and may
 * legitimately share no ids with what the store still holds, so its load guard
 * checks only that the migrations kept every row — unlike an ordinary load,
 * where missing live rows mean a bad or truncated storage read.
 */
export const markNextLoadAsDocumentReplacement = (): void => {
    documentReplacementPending = true;
};

const consumeDocumentReplacementMark = (): boolean => {
    const pending = documentReplacementPending;
    documentReplacementPending = false;
    return pending;
};

const settingsValueChanged = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);

export const timestampAtLeastAfter = (floor: string, ...knownValues: Array<string | undefined>): string => {
    const floorMs = Date.parse(floor);
    const beforeFloor = Number.isFinite(floorMs) ? new Date(floorMs - 1).toISOString() : undefined;
    return advanceLatestSyncTimestamp(beforeFloor, ...knownValues) ?? floor;
};

export type AppLockWitness = { groupPresent: boolean; present: boolean; value: boolean | null };
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
/** The raw saved local flag, distinct from a displayed false default. */
export const appLockWitness = (settings: AppSettings): AppLockWitness | null => {
    const groupPresent = owns(settings, 'security');
    if (!groupPresent) return { groupPresent: false, present: false, value: null };
    const group = settings.security;
    if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
    const present = owns(group, 'mobileAppLockEnabled');
    const value = present ? group.mobileAppLockEnabled : null;
    return present && typeof value !== 'boolean' ? null : { groupPresent: true, present, value: value ?? null };
};

export type GtdWorkflowDirectType = 'defaultScheduleTime' | 'focusTaskLimit' | 'focusIncludeStartDates'
    | 'defaultProjectFlowMode' | 'autoArchiveDays';
export type GtdWorkflowReviewType = 'dailyReviewFocusStep' | 'weeklyReviewContextStep';
export type GtdWorkflowInboxType = 'inboxTwoMinute' | 'inboxProjectFirst' | 'inboxContextStep' | 'inboxSchedule';
export type GtdWorkflowCaptureParseType = 'quickAddAutoClean' | 'naturalLanguageDates';
export type GtdWorkflowTaskEditorSection = 'scheduling' | 'organization' | 'details';
export type GtdWorkflowType = GtdWorkflowDirectType | GtdWorkflowReviewType | GtdWorkflowInboxType
    | GtdWorkflowCaptureParseType | 'defaultArea' | 'taskEditorSectionOpen' | 'taskEditorPreset'
    | 'taskEditorFieldVisible' | 'taskEditorFieldSection' | 'taskEditorOrder' | 'taskEditorReset';
export type GtdWorkflowDirectWitness = { present: boolean; value: string | number | boolean | null;
    stampPresent: boolean; stamp: string | null };
export type GtdWorkflowCaptureParseWitness = { present: boolean; value: boolean | null;
    stampPresent: boolean; stamp: string | null };
export type GtdWorkflowReviewWitness = { parentPresent: boolean; present: boolean; value: boolean | null;
    stampPresent: boolean; stamp: string | null };
export type GtdWorkflowInboxWitness = GtdWorkflowReviewWitness;
export type GtdWorkflowAreaWitness = { modePresent: boolean; mode: string | null;
    idPresent: boolean; id: string | null; stampPresent: boolean; stamp: string | null };
export type GtdWorkflowTaskEditorSelected = { taskEditorPresent: boolean; sectionOpenPresent: boolean;
    present: boolean; value: boolean | null };
export type GtdWorkflowTaskEditorWitness = GtdWorkflowTaskEditorSelected & { stampPresent: boolean; stamp: string | null };
export type GtdWorkflowPresetRaw<T> = { present: boolean; value: T | null };
export type GtdWorkflowPresetSelected = {
    taskEditorPresent: boolean;
    order: GtdWorkflowPresetRaw<TaskEditorFieldId[]>;
    hidden: GtdWorkflowPresetRaw<TaskEditorFieldId[]>;
    sections: GtdWorkflowPresetRaw<Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>>;
    sectionOpen: GtdWorkflowPresetRaw<Partial<Record<TaskEditorSectionId, boolean>>>;
    featuresPresent: boolean;
    priorities: GtdWorkflowPresetRaw<boolean>;
    timeEstimates: GtdWorkflowPresetRaw<boolean>;
};
export type GtdWorkflowPresetWitness = GtdWorkflowPresetSelected & { stampPresent: boolean; stamp: string | null };
export type GtdWorkflowTargetArea = { id: string; createdAt: string; updatedAt: string;
    revPresent: boolean; rev: number | null; revByPresent: boolean; revBy: string | null };
export type GtdWorkflowWitness = GtdWorkflowDirectWitness | GtdWorkflowCaptureParseWitness
    | GtdWorkflowReviewWitness | GtdWorkflowInboxWitness | GtdWorkflowAreaWitness
    | GtdWorkflowTaskEditorWitness | GtdWorkflowPresetWitness;
export const gtdWorkflowTaskEditorSelected = (witness: GtdWorkflowTaskEditorWitness): GtdWorkflowTaskEditorSelected => ({
    taskEditorPresent: witness.taskEditorPresent, sectionOpenPresent: witness.sectionOpenPresent,
    present: witness.present, value: witness.value,
});
export const gtdWorkflowPresetSelected = (witness: GtdWorkflowPresetWitness): GtdWorkflowPresetSelected => ({
    taskEditorPresent: witness.taskEditorPresent,
    order: witness.order, hidden: witness.hidden, sections: witness.sections, sectionOpen: witness.sectionOpen,
    featuresPresent: witness.featuresPresent, priorities: witness.priorities, timeEstimates: witness.timeEstimates,
});
/** The selected saved Area's identity and revision, without its name or other fields. */
export const gtdWorkflowTargetArea = (area: Area | undefined): GtdWorkflowTargetArea | null => {
    if (!area || area.deletedAt || typeof area.id !== 'string' || !area.id || area.id.length > 500
        || typeof area.createdAt !== 'string' || area.createdAt.length > 500
        || typeof area.updatedAt !== 'string' || area.updatedAt.length > 500) return null;
    const revPresent = owns(area, 'rev') && area.rev !== undefined;
    const revByPresent = owns(area, 'revBy') && area.revBy !== undefined;
    if (revPresent && (!Number.isSafeInteger(area.rev) || (area.rev ?? -1) < 0)
        || revByPresent && (typeof area.revBy !== 'string' || area.revBy.length > 500)) return null;
    return { id: area.id, createdAt: area.createdAt, updatedAt: area.updatedAt,
        revPresent, rev: revPresent ? area.rev! : null,
        revByPresent, revBy: revByPresent ? area.revBy! : null };
};
export const gtdWorkflowNestedPath = (type: GtdWorkflowReviewType | GtdWorkflowInboxType) => {
    switch (type) {
        case 'dailyReviewFocusStep': return { parent: 'dailyReview' as const, field: 'includeFocusStep' as const };
        case 'weeklyReviewContextStep': return { parent: 'weeklyReview' as const, field: 'includeContextStep' as const };
        case 'inboxTwoMinute': return { parent: 'inboxProcessing' as const, field: 'twoMinuteEnabled' as const };
        case 'inboxProjectFirst': return { parent: 'inboxProcessing' as const, field: 'projectFirst' as const };
        case 'inboxContextStep': return { parent: 'inboxProcessing' as const, field: 'contextStepEnabled' as const };
        case 'inboxSchedule': return { parent: 'inboxProcessing' as const, field: 'scheduleEnabled' as const };
    }
};
const boundedRawGtdValue = (type: GtdWorkflowDirectType, value: unknown): value is string | number | boolean =>
    type === 'focusIncludeStartDates'
        ? typeof value === 'boolean'
        : type === 'autoArchiveDays'
        ? typeof value === 'number' && Number.isFinite(value)
        : type === 'focusTaskLimit'
        ? typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000
        : typeof value === 'string' && value.length <= 500;
const plain = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const presetOrder = (value: unknown): value is TaskEditorFieldId[] =>
    Array.isArray(value) && value.length <= DEFAULT_TASK_EDITOR_ORDER.length
    && value.every((id) => DEFAULT_TASK_EDITOR_ORDER.includes(id));
const presetSections = (value: unknown): value is Partial<Record<TaskEditorFieldId, TaskEditorSectionId>> =>
    plain(value) && Object.keys(value).length <= DEFAULT_TASK_EDITOR_ORDER.length + 1
    && Object.entries(value).every(([field, section]) =>
        (DEFAULT_TASK_EDITOR_ORDER.includes(field as TaskEditorFieldId) || field === 'textDirection')
        && TASK_EDITOR_SECTION_ORDER.includes(section as TaskEditorSectionId));
const presetSectionOpen = (value: unknown): value is Partial<Record<TaskEditorSectionId, boolean>> =>
    plain(value) && Object.keys(value).length <= TASK_EDITOR_SECTION_ORDER.length
    && Object.entries(value).every(([section, open]) =>
        TASK_EDITOR_SECTION_ORDER.includes(section as TaskEditorSectionId) && typeof open === 'boolean');
const presetRaw = <T>(parent: Record<string, unknown> | undefined, field: string,
    valid: (value: unknown) => value is T): GtdWorkflowPresetRaw<T> | null => {
    const present = parent !== undefined && owns(parent, field) && parent[field] !== undefined;
    const value = present ? parent[field] : null;
    return present && !valid(value) ? null : { present, value: present ? value as T : null };
};
/** One raw GTD scalar and its group stamp, without carrying the Settings row. */
export function gtdWorkflowWitness(settings: AppSettings, type: GtdWorkflowDirectType): GtdWorkflowDirectWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: GtdWorkflowReviewType): GtdWorkflowReviewWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: GtdWorkflowInboxType): GtdWorkflowInboxWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: GtdWorkflowCaptureParseType): GtdWorkflowCaptureParseWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: 'defaultArea'): GtdWorkflowAreaWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: 'taskEditorSectionOpen', section: GtdWorkflowTaskEditorSection): GtdWorkflowTaskEditorWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: 'taskEditorPreset'): GtdWorkflowPresetWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: 'taskEditorFieldVisible'): GtdWorkflowPresetWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: 'taskEditorFieldSection'): GtdWorkflowPresetWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: 'taskEditorOrder'): GtdWorkflowPresetWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: 'taskEditorReset'): GtdWorkflowPresetWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: GtdWorkflowType, section?: GtdWorkflowTaskEditorSection): GtdWorkflowWitness | null;
export function gtdWorkflowWitness(settings: AppSettings, type: GtdWorkflowType, section?: GtdWorkflowTaskEditorSection): GtdWorkflowWitness | null {
    const group = settings.gtd;
    const stamps = settings.syncPreferencesUpdatedAt;
    if (type !== 'quickAddAutoClean' && group !== undefined && (!group || typeof group !== 'object' || Array.isArray(group))
        || stamps !== undefined && (!stamps || typeof stamps !== 'object' || Array.isArray(stamps))) return null;
    const stampPresent = stamps !== undefined && owns(stamps, 'gtd') && stamps.gtd !== undefined;
    const stamp = stampPresent ? stamps?.gtd : null;
    if (stampPresent && !(typeof stamp === 'string' && stamp.length <= 40
        && Number.isFinite(Date.parse(stamp)) && new Date(stamp).toISOString() === stamp)) return null;
    if (type === 'defaultArea') {
        const modePresent = group !== undefined && owns(group, 'defaultAreaMode') && group.defaultAreaMode !== undefined;
        const idPresent = group !== undefined && owns(group, 'defaultAreaId') && group.defaultAreaId !== undefined;
        const mode = modePresent ? group?.defaultAreaMode : null;
        const id = idPresent ? group?.defaultAreaId : null;
        if (modePresent && !(mode === null || typeof mode === 'string' && mode.length <= 500)
            || idPresent && !(id === null || typeof id === 'string' && id.length <= 500)) return null;
        return { modePresent, mode: modePresent ? mode as string | null : null,
            idPresent, id: idPresent ? id as string | null : null,
            stampPresent, stamp: stampPresent ? stamp! : null };
    }
    if (type === 'quickAddAutoClean' || type === 'naturalLanguageDates') {
        const present = type === 'quickAddAutoClean'
            ? owns(settings, 'quickAddAutoClean') && settings.quickAddAutoClean !== undefined
            : group !== undefined && owns(group, 'naturalLanguageDates') && group.naturalLanguageDates !== undefined;
        const value = present ? type === 'quickAddAutoClean'
            ? settings.quickAddAutoClean : group?.naturalLanguageDates : null;
        if (present && typeof value !== 'boolean') return null;
        return { present, value: present ? value as boolean : null,
            stampPresent, stamp: stampPresent ? stamp! : null };
    }
    if (type === 'taskEditorSectionOpen') {
        if (!section) return null;
        const taskEditorPresent = group !== undefined && owns(group, 'taskEditor') && group.taskEditor !== undefined;
        const taskEditor = taskEditorPresent ? group?.taskEditor as Record<string, unknown> : undefined;
        if (taskEditorPresent && (!taskEditor || typeof taskEditor !== 'object' || Array.isArray(taskEditor))) return null;
        const sectionOpenPresent = taskEditorPresent && owns(taskEditor!, 'sectionOpen') && taskEditor?.sectionOpen !== undefined;
        const sectionOpen = sectionOpenPresent ? taskEditor?.sectionOpen as Record<string, unknown> : undefined;
        if (sectionOpenPresent && (!sectionOpen || typeof sectionOpen !== 'object' || Array.isArray(sectionOpen))) return null;
        const present = sectionOpenPresent && owns(sectionOpen!, section) && sectionOpen?.[section] !== undefined;
        const value = present ? sectionOpen?.[section] : null;
        if (present && typeof value !== 'boolean') return null;
        return { taskEditorPresent, sectionOpenPresent, present, value: present ? value as boolean : null,
            stampPresent, stamp: stampPresent ? stamp! : null };
    }
    if (type === 'taskEditorPreset' || type === 'taskEditorFieldVisible' || type === 'taskEditorFieldSection'
        || type === 'taskEditorOrder' || type === 'taskEditorReset') {
        const taskEditorPresent = group !== undefined && owns(group, 'taskEditor') && group.taskEditor !== undefined;
        const taskEditor = taskEditorPresent ? group?.taskEditor : undefined;
        if (taskEditorPresent && !plain(taskEditor)) return null;
        const featuresPresent = owns(settings, 'features') && settings.features !== undefined;
        const features = featuresPresent ? settings.features : undefined;
        if (featuresPresent && !plain(features)) return null;
        const order = presetRaw(taskEditor as Record<string, unknown> | undefined, 'order', presetOrder);
        const hidden = presetRaw(taskEditor as Record<string, unknown> | undefined, 'hidden', presetOrder);
        const sections = presetRaw(taskEditor as Record<string, unknown> | undefined, 'sections', presetSections);
        const sectionOpen = presetRaw(taskEditor as Record<string, unknown> | undefined, 'sectionOpen', presetSectionOpen);
        const priorities = presetRaw(features as Record<string, unknown> | undefined, 'priorities',
            (value): value is boolean => typeof value === 'boolean');
        const timeEstimates = presetRaw(features as Record<string, unknown> | undefined, 'timeEstimates',
            (value): value is boolean => typeof value === 'boolean');
        if (!order || !hidden || !sections || !sectionOpen || !priorities || !timeEstimates) return null;
        return { taskEditorPresent, order, hidden, sections, sectionOpen,
            featuresPresent, priorities, timeEstimates, stampPresent, stamp: stampPresent ? stamp! : null };
    }
    if (type === 'dailyReviewFocusStep' || type === 'weeklyReviewContextStep'
        || type === 'inboxTwoMinute' || type === 'inboxProjectFirst'
        || type === 'inboxContextStep' || type === 'inboxSchedule') {
        const path = gtdWorkflowNestedPath(type);
        const parentPresent = group !== undefined && owns(group, path.parent) && group[path.parent] !== undefined;
        const parent = parentPresent ? group?.[path.parent] as Record<string, unknown> : undefined;
        if (parentPresent && (!parent || typeof parent !== 'object' || Array.isArray(parent))) return null;
        const present = parentPresent && owns(parent!, path.field) && parent?.[path.field] !== undefined;
        const value = present ? parent?.[path.field] : null;
        if (present && typeof value !== 'boolean') return null;
        return { parentPresent, present, value: present ? value as boolean : null,
            stampPresent, stamp: stampPresent ? stamp! : null };
    }
    const present = group !== undefined && owns(group, type) && group[type] !== undefined;
    const value = present ? group?.[type] : null;
    if (present && !boundedRawGtdValue(type, value)) return null;
    return { present, value: present ? value as string | number | boolean : null,
        stampPresent, stamp: stampPresent ? stamp! : null };
}

export type GtdArchiveEffect = { before: Task; after: Task };
/** The shared RN archive pass projected at a frozen clock; an empty list is a complete no-effect batch. */
export const gtdArchiveEffects = (tasks: Task[], settings: AppSettings,
    at: string, deviceId: string): GtdArchiveEffect[] => {
    const projected = runAutoArchive(tasks, settings, { nowIso: at, nowMs: Date.parse(at), deviceId });
    return tasks.flatMap((before, index) => before === projected.allTasks[index]
        ? [] : [{ before, after: projected.allTasks[index] }]);
};

export const prepareLocalSavedFilterUpdates = (
    previous: readonly SavedFilter[] | undefined,
    next: SavedFilter[],
    nowIso: string,
): SavedFilter[] => {
    const previousById = new Map((previous ?? []).map((filter) => [filter.id, filter]));
    return next.map((filter) => {
        const before = previousById.get(filter.id);
        if (!before || !settingsValueChanged(before, filter)) return filter;
        const requestedMs = Math.max(
            ...[nowIso, filter.updatedAt, filter.deletedAt]
                .map((value) => Date.parse(value ?? ''))
                .filter(Number.isFinite),
        );
        const requestedAt = Number.isFinite(requestedMs) ? new Date(requestedMs).toISOString() : nowIso;
        const operationAt = timestampAtLeastAfter(requestedAt, before.updatedAt, before.deletedAt);
        return {
            ...filter,
            updatedAt: operationAt,
            ...(filter.deletedAt ? { deletedAt: operationAt } : {}),
        };
    });
};

/** Stable ordinal-key JSON for a single raw saved-filter compare-and-swap witness. */
export const focusSavedFilterToken = (value: unknown): string => JSON.stringify(value, function (_key, item: unknown) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]));
});

export const savedSearchWriteScope = (settings: AppSettings): SavedSearchWriteScope => ({
    savedSearchesPresent: owns(settings, 'savedSearches'),
    savedSearches: settings.savedSearches ?? null,
    stampPresent: owns(settings, 'savedSearchesUpdatedAt'),
    stamp: settings.savedSearchesUpdatedAt ?? null,
});

export const focusSavedFilterCreation = (state: TaskStore, controls: FocusControlState) => {
    const model = buildFocusControlsModel({ state: controls, tasks: state.tasks, projects: state.projects,
        areas: state.areas, sections: state.sections, settings: state.settings, now: new Date(), t: (key) => key });
    return { canSave: model.perspective.canSavePerspective,
        currentCriteria: model.filter.currentCriteria,
        effectiveSortBy: model.perspective.effectiveSortBy,
        effectiveGroupBy: model.perspective.effectiveGroupBy };
};

const mergeSettingsUpdates = (
    settings: AppData['settings'],
    updates: Partial<AppData['settings']>
): AppData['settings'] => {
    const nextSettings = { ...settings, ...updates };
    if (Object.prototype.hasOwnProperty.call(updates, 'appearance')) {
        const appearanceUpdate = updates.appearance;
        nextSettings.appearance = appearanceUpdate && typeof appearanceUpdate === 'object'
            ? { ...(settings.appearance ?? {}), ...appearanceUpdate }
            : appearanceUpdate;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'network')) {
        const networkUpdate = updates.network;
        nextSettings.network = networkUpdate && typeof networkUpdate === 'object'
            ? { ...(settings.network ?? {}), ...networkUpdate }
            : networkUpdate;
    }
    return nextSettings;
};

const shouldTrackSettingsChange = (
    previous: AppData['settings'],
    next: AppData['settings'],
    updates: Partial<AppData['settings']>
): boolean => {
    const trackedKeys = Object.keys(updates)
        .filter((key) => !NON_MUTATING_SETTINGS_KEYS.has(key as keyof AppData['settings'])) as Array<keyof AppData['settings']>;
    if (trackedKeys.length === 0) return false;
    return trackedKeys.some((key) => settingsValueChanged(previous[key], next[key]));
};

type SettingsActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
    flushPendingSave: () => Promise<void>;
    hasPendingSaveWork: () => boolean;
    getSaveGeneration: () => number;
    getStorage: () => StorageAdapter;
};

type SettingsActions = Pick<TaskStore, 'fetchData' | 'seedGettingStarted' | 'updateSettings' | 'commitPreparedGeneralPreference' | 'commitPreparedGtdWorkflow' | 'commitPreparedAppLock' | 'retryPreparedAppLockSnapshot' | 'commitPreparedNotificationSetting' | 'retryPreparedNotificationSettingSnapshot' | 'commitPreparedCalendarSubscriptionSetting' | 'retryPreparedCalendarSubscriptionSettingSnapshot' | 'commitPreparedFocusSavedFilter' | 'commitPreparedSavedSearchWrite' | 'persistSnapshot' | 'getDerivedState' | 'getFocusedCount' | 'setHighlightTask'>;

export const createSettingsActions = ({
    set,
    get,
    debouncedSave,
    flushPendingSave,
    hasPendingSaveWork,
    getSaveGeneration,
    getStorage,
}: SettingsActionContext): SettingsActions => {
    let lastLoadWasRecovery = false;
    return {
    seedGettingStarted: createSeedGettingStartedAction(set, debouncedSave, flushPendingSave),

    /**
     * Fetch all data from the configured storage adapter.
     * Stores full data internally, filters for UI display.
     */
    fetchData: async (options) => {
        markCoreStartupPhase('core.fetch_data.start');
        // Consumed at entry so a fetch already in flight keeps its own answer.
        const isDocumentReplacement = consumeDocumentReplacementMark();
        const fetchInvokedAt = Date.now();
        const isResultStillRelevant = options?.isResultStillRelevant ?? (() => true);
        const finishIrrelevantFetch = () => {
            markCoreStartupPhase('core.fetch_data.skipped_irrelevant');
            if (!options?.silent) {
                set((state) => state.isLoading ? { isLoading: false } : state);
            }
        };
        let flushMs = 0;
        let storageReadMs = 0;
        let setStateMs = 0;
        if (hasPendingSaveWork()) {
            const flushStartedAt = Date.now();
            await measureCoreStartupPhase('core.fetch_data.flush_pending_save', async () => {
                await flushPendingSave();
            });
            flushMs = Date.now() - flushStartedAt;
        } else {
            markCoreStartupPhase('core.fetch_data.flush_pending_save.skipped', { reason: 'no_pending_work' });
        }
        const saveGenerationAtFetchStart = getSaveGeneration();
        if (!isResultStillRelevant()) {
            finishIrrelevantFetch();
            return;
        }
        if (options?.silent) {
            set((state) => state.error === null ? state : { error: null });
        } else {
            set((state) => state.isLoading && state.error === null
                ? state
                : { isLoading: true, error: null });
        }
        if (get().editLockCount > 0) {
            if (!options?.silent) {
                set({ isLoading: false });
            }
            logWarn('Skipped fetch while edits are in progress', {
                scope: 'store',
                category: 'storage',
                context: { editLockCount: get().editLockCount },
            });
            return;
        }
        const fetchStartedAt = get().lastDataChangeAt;
        try {
            // A preloaded snapshot must already be durably persisted (e.g. the merged
            // document sync just wrote); it skips the storage read but runs the exact
            // same load pipeline, and the lastDataChangeAt guard below still discards
            // it if local edits landed in the meantime.
            const storageReadStartedAt = Date.now();
            const sourceStorage = options?.preloadedData ? undefined : getStorage();
            const data = options?.preloadedData
                ?? await measureCoreStartupPhase('core.fetch_data.storage_get_data', async () =>
                    withTimeout(sourceStorage!.getData(), STORAGE_TIMEOUT_MS, 'Storage request timed out')
                );
            if (!isResultStillRelevant()) {
                finishIrrelevantFetch();
                return;
            }
            storageReadMs = options?.preloadedData ? 0 : Date.now() - storageReadStartedAt;
            const postProcessStartedAt = Date.now();
            markCoreStartupPhase('core.fetch_data.post_process:start');
            const nowIso = new Date().toISOString();
            const nowMs = Date.now();
            const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
            const rawProjects = Array.isArray(data.projects) ? data.projects : [];
            const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
            const rawSections = Array.isArray((data as AppData).sections) ? (data as AppData).sections : [];
            const rawAreas = Array.isArray((data as AppData).areas) ? (data as AppData).areas : [];
            const rawPeople = Array.isArray((data as AppData).people) ? (data as AppData).people ?? [] : [];
            const settings = stripSensitiveSettings(rawSettings as AppData['settings']);
            const isFreshInstall =
                rawTasks.length === 0 &&
                rawProjects.length === 0 &&
                rawSections.length === 0 &&
                rawAreas.length === 0 &&
                rawPeople.length === 0 &&
                Object.keys(settings).length === 0;

            // normalizeTaskForLoad is a per-load status/date/shape normalizer, not a
            // migration: it always runs and never itself is a reason to persist,
            // same as `stripSensitiveSettings` above. Loading data never mutates it
            // for persistence purposes — only the explicit one-time passes below do.
            // A pending native journal must compare the exact adapter rows before
            // clock-dependent normalization or maintenance can change its receipt.
            // The exclusive host runs a normal load after clearing that journal.
            const recoveryLoad = options?.recoveryLoad === true;
            const normalizedTasks = recoveryLoad ? rawTasks : rawTasks.map((task) => normalizeTaskForLoad(task, nowIso));
            const normalizedProjects = recoveryLoad ? rawProjects : rawProjects.map(normalizeProjectLifecycleFields);

            const loadContext = buildLoadContext(settings, isFreshInstall, nowIso, nowMs);
            const initialData: AppData = {
                tasks: normalizedTasks,
                projects: normalizedProjects,
                sections: rawSections,
                areas: rawAreas,
                people: rawPeople,
                settings,
            };
            const { data: migratedData, applied } = recoveryLoad
                ? { data: initialData, applied: [] }
                : runLoadMigrations(initialData, loadContext);
            const allTasks = migratedData.tasks;
            const allProjects = migratedData.projects;
            const allSections = migratedData.sections;
            const allAreas = migratedData.areas;
            const allPeople = migratedData.people ?? [];
            const nextSettings = migratedData.settings;

            const postProcessMs = Date.now() - postProcessStartedAt;
            markCoreStartupPhase('core.fetch_data.post_process:end', { durationMs: postProcessMs });
            let skippedDueToConcurrentLocalChange = false;
            let setProducerMs = 0;
            let tasksReplaced = 0;
            let projectsReplaced = 0;
            let attachmentOnlyTasksReplaced = 0;
            let normalizedFocusTasksReplaced = 0;
            let settingsReused = false;
            let visibleTasksReused = false;
            let stateUpdateSkipped = false;
            let resultAccepted = false;
            const setStateStartedAt = Date.now();
            const notifyProfilingEnabled = nextSettings?.diagnostics?.loggingEnabled === true;
            let notifyProfile: NotifyProfile | null = null;
            if (notifyProfilingEnabled) beginNotifyProfile();
            try {
                await measureCoreStartupPhase('core.fetch_data.zustand_set_state', async () => {
                    set((state) => {
                        const producerStartedAt = Date.now();
                        if (!isResultStillRelevant()) {
                            stateUpdateSkipped = true;
                            setProducerMs = Date.now() - producerStartedAt;
                            return state;
                        }
                        resultAccepted = true;
                        if (state.lastDataChangeAt > fetchStartedAt) {
                            skippedDueToConcurrentLocalChange = true;
                            setProducerMs = Date.now() - producerStartedAt;
                            return options?.silent || !state.isLoading ? state : { isLoading: false };
                        }
                        // Normalization can change a view-only field without a new
                        // revision. Reusing by revision across recovery boundaries
                        // would keep either the normalized receipt or the raw UI row.
                        const reuseEntities = recoveryLoad === lastLoadWasRecovery;
                        let previousTasksById: TaskStore['_tasksById'] = reuseEntities ? state._tasksById : new Map();
                        if (reuseEntities && !recoveryLoad) {
                            for (const task of allTasks) {
                                const existing = previousTasksById.get(task.id);
                                if (existing
                                    && (existing.isFocusedToday !== task.isFocusedToday || existing.focusOrder !== task.focusOrder)
                                    && hasSameEntityIdentity(existing, task)) {
                                    // Local-day normalization can change focus without a
                                    // revision. Keep all other cached rows and only copy the
                                    // lookup if a row would hide this load's normalized view.
                                    if (previousTasksById === state._tasksById) previousTasksById = new Map(previousTasksById);
                                    previousTasksById.delete(task.id);
                                    normalizedFocusTasksReplaced += 1;
                                }
                            }
                        }
                        const nextTasks = reconcileEntityCollection(state._allTasks, previousTasksById, allTasks);
                        const nextProjects = reconcileEntityCollection(state._allProjects, reuseEntities ? state._projectsById : new Map(), allProjects);
                        const nextSections = reconcileEntityCollection(state._allSections, state._sectionsById, allSections);
                        const nextAreas = reconcileEntityCollection(state._allAreas, state._areasById, allAreas);
                        const nextPeople = reconcileEntityCollection(state._allPeople, state._peopleById, allPeople);
                        const visibleTasks = reuseArrayIfShallowEqual(state.tasks, selectVisibleTasks(nextTasks.items));
                        const visibleProjects = reuseArrayIfShallowEqual(state.projects, selectVisibleProjects(nextProjects.items));
                        const visibleSections = reuseArrayIfShallowEqual(state.sections, selectVisibleSections(nextSections.items));
                        const visibleAreas = reuseArrayIfShallowEqual(state.areas, selectVisibleAreas(nextAreas.items));
                        const visiblePeople = reuseArrayIfShallowEqual(state.people, selectVisiblePeople(nextPeople.items));
                        const settingsForState = reuseSettingsIfEquivalent(state.settings, nextSettings);
                        tasksReplaced = nextTasks.replacedCount;
                        projectsReplaced = nextProjects.replacedCount;
                        attachmentOnlyTasksReplaced = nextTasks.attachmentOnlyReplacedCount;
                        settingsReused = settingsForState === state.settings;
                        visibleTasksReused = visibleTasks === state.tasks;
                        const nextLastDataChangeAt = applied.length > 0
                            ? getNextDataChangeAt(state.lastDataChangeAt)
                            : state.lastDataChangeAt;
                        if (
                            visibleTasks === state.tasks
                            && visibleProjects === state.projects
                            && visibleSections === state.sections
                            && visibleAreas === state.areas
                            && visiblePeople === state.people
                            && settingsForState === state.settings
                            && nextTasks.items === state._allTasks
                            && nextProjects.items === state._allProjects
                            && nextSections.items === state._allSections
                            && nextAreas.items === state._allAreas
                            && nextPeople.items === state._allPeople
                            && nextTasks.byId === state._tasksById
                            && nextProjects.byId === state._projectsById
                            && nextSections.byId === state._sectionsById
                            && nextAreas.byId === state._areasById
                            && nextPeople.byId === state._peopleById
                            && state.isLoading === false
                            && nextLastDataChangeAt === state.lastDataChangeAt
                        ) {
                            stateUpdateSkipped = true;
                            setProducerMs = Date.now() - producerStartedAt;
                            return state;
                        }
                        if (applied.length > 0) {
                            // Baseline for the partial-snapshot guard. Normally it is the
                            // pre-load store, so a bad or truncated storage read cannot be
                            // saved over live rows. After a caller-declared full replace
                            // (Restore Backup) the new document is authoritative and shares
                            // no ids with the store, so there the guard only has to prove
                            // the migrations kept every row the document arrived with.
                            //
                            // Tombstone GC ('purge-expired-tombstones', applied above via
                            // runLoadMigrations) legitimately shrinks these collections
                            // once a day. Run the identical age-based cleanup on the
                            // baseline so the partial-snapshot guard compares like for
                            // like instead of tripping on that expected GC shrink (it
                            // would otherwise fail every load on the day it runs).
                            //
                            // DEFAULT_TOMBSTONE_RETENTION_DAYS is passed explicitly (matching
                            // purgeExpiredTombstonesMigration's own implicit default) rather
                            // than left to purgeExpiredTombstones' internal fallback: the
                            // sync-merge path threads a configurable io.tombstoneRetentionDays
                            // (sync.ts) instead of the default. If the load-migration path ever
                            // grows the same knob, this explicit constant is what a grep for
                            // DEFAULT_TOMBSTONE_RETENTION_DAYS turns up as the thing to update.
                            //
                            // `settings` is omitted from the input (passed as `{}`) because
                            // only .tasks/.projects/.sections/.areas/.people below are read --
                            // the pruned settings purgeExpiredTombstones would otherwise compute
                            // (savedFilters/pendingRemoteDeletes) are unused here.
                            const guardBaseline = isDocumentReplacement
                                ? initialData
                                : {
                                    tasks: state._allTasks,
                                    projects: state._allProjects,
                                    sections: state._allSections,
                                    areas: state._allAreas,
                                    people: state._allPeople,
                                };
                            const gcReference = purgeExpiredTombstones(
                                {
                                    tasks: guardBaseline.tasks,
                                    projects: guardBaseline.projects,
                                    sections: guardBaseline.sections,
                                    areas: guardBaseline.areas,
                                    people: guardBaseline.people ?? [],
                                    settings: {},
                                },
                                nowIso,
                                DEFAULT_TOMBSTONE_RETENTION_DAYS
                            ).data;
                            persist(set, debouncedSave, {
                                _allTasks: gcReference.tasks,
                                _allProjects: gcReference.projects,
                                _allSections: gcReference.sections,
                                _allAreas: gcReference.areas,
                                _allPeople: gcReference.people ?? [],
                                settings: state.settings,
                            }, {
                                tasks: nextTasks.items,
                                projects: nextProjects.items,
                                sections: nextSections.items,
                                areas: nextAreas.items,
                                people: nextPeople.items,
                                settings: nextSettings,
                            });
                            markCoreStartupPhase('core.fetch_data.debounced_save_enqueued');
                        }
                        setProducerMs = Date.now() - producerStartedAt;
                        return {
                            settings: settingsForState,
                            _allTasks: nextTasks.items,
                            _allProjects: nextProjects.items,
                            _allSections: nextSections.items,
                            _allAreas: nextAreas.items,
                            _allPeople: nextPeople.items,
                            isLoading: false,
                            lastDataChangeAt: nextLastDataChangeAt,
                        };
                    });
                });
            } finally {
                if (notifyProfilingEnabled) notifyProfile = endNotifyProfile();
            }
            setStateMs = Date.now() - setStateStartedAt;
            if (!resultAccepted) {
                finishIrrelevantFetch();
                return;
            }
            const totalFetchMs = Date.now() - fetchInvokedAt;
            // Proves the #1136 fix actually fired: a task whose attachments changed
            // (another device deleted or updated one) without the task's own
            // revision/tombstone fields changing was replaced in the in-memory
            // store instead of stale-cached, so this load's post-load persist
            // writes the current attachments instead of overwriting them right
            // back. One line per store load (never per task) — this branch can
            // fire on every idle load once a peer starts touching attachments.
            if (attachmentOnlyTasksReplaced > 0) {
                logInfo('Sync store reconcile replaced tasks for an attachment-only change', {
                    scope: 'store',
                    category: 'storage',
                    context: {
                        entity: 'task',
                        count: attachmentOnlyTasksReplaced,
                    },
                });
            }
            // Runtime diagnostic for shared beta logs: break the load pipeline down so a
            // slow refresh can be attributed to save-flush, storage read, or JS processing.
            if (totalFetchMs >= SLOW_FETCH_LOG_THRESHOLD_MS) {
                // Content-free lifecycle breakdown: taskCount counts the whole
                // stored array, which reads far higher than what the app shows
                // once sync tombstones accumulate — log the composition so a
                // shared log can attribute counts and growth directly (#766).
                const lifecycle = summarizeTaskLifecycleCounts(allTasks);
                logInfo('Slow data load pipeline', {
                    scope: 'store',
                    category: 'storage',
                    context: {
                        totalMs: totalFetchMs,
                        flushMs,
                        storageReadMs,
                        postProcessMs,
                        setStateMs,
                        // setStateMs = producer (reconcile + visibility filtering)
                        // + notify (store subscribers, incl. synchronous React
                        // re-renders). The split plus the reuse flags attribute a
                        // slow refresh to recompute vs re-render storm (#766).
                        setProducerMs,
                        setNotifyMs: Math.max(0, setStateMs - setProducerMs),
                        ...(notifyProfile ? {
                            notifyListenerCount: String(notifyProfile.listenerCount),
                            notifyTimedCalls: String(notifyProfile.timedCalls),
                            notifyTimedMs: String(Math.round(notifyProfile.timedTotalMs)),
                            notifyMaxMs: String(Math.round(notifyProfile.maxMs)),
                            notifyTop5Ms: notifyProfile.top5Ms.map(Math.round).join(','),
                            notifyTop5Names: notifyProfile.top5Names.join(','),
                            notifyDerivedRebuilds: String(notifyProfile.derivedRebuildCount),
                            notifyDerivedRebuildMs: String(Math.round(notifyProfile.derivedRebuildMs)),
                        } : {}),
                        tasksReplaced,
                        projectsReplaced,
                        settingsReused,
                        visibleTasksReused,
                        stateUpdateSkipped,
                        preloaded: Boolean(options?.preloadedData),
                        taskCount: allTasks.length,
                        liveTasks: lifecycle.live,
                        trashedTasks: lifecycle.trashed,
                        tombstoneTasks: lifecycle.tombstones,
                        tasksCreatedLast7d: lifecycle.createdLast7d,
                        skippedByLocalChange: skippedDueToConcurrentLocalChange,
                    },
                });
            }
            if (skippedDueToConcurrentLocalChange) {
                markCoreStartupPhase('core.fetch_data.skipped_local_change');
                logWarn('Skipped fetch result because local data changed during fetch', {
                    scope: 'store',
                    category: 'storage',
                    context: {
                        fetchStartedAt,
                        currentChangeAt: get().lastDataChangeAt,
                    },
                });
                return;
            }

            // Storage may quarantine writes until the foreground store has
            // replaced a potentially stale snapshot. Only acknowledge the exact
            // object returned by this direct read after it was actually applied;
            // preloaded/background sync snapshots do not prove that lineage.
            // Deliberately count every full-snapshot enqueue, including a load
            // migration. That can require one more clean reload, but releasing a
            // recovery barrier while an unacknowledged snapshot is queued could
            // let that save erase the data the reload just recovered.
            if (getSaveGeneration() === saveGenerationAtFetchStart) {
                sourceStorage?.acknowledgeDataLoad?.(data);
            }

            markCoreStartupPhase('core.fetch_data.end');
            lastLoadWasRecovery = recoveryLoad;
            if (normalizedFocusTasksReplaced > 0) {
                try {
                    logInfo('Reload refreshed normalized task focus', {
                        scope: 'store',
                        category: 'storage',
                        context: {
                            releaseCheck: 'v1.3.3/reload-focus-normalization',
                            count: normalizedFocusTasksReplaced,
                        },
                    });
                } catch {
                    // Diagnostics must not turn an accepted reload into a failure.
                }
            }
        } catch (err) {
            if (!isResultStillRelevant()) {
                finishIrrelevantFetch();
                return;
            }
            markCoreStartupPhase('core.fetch_data.error');
            set({ error: getFetchDataErrorMessage(err), isLoading: false });
            if (options?.throwOnError) throw err;
        }
    },

    /**
     * Update application settings.
     * @param updates Settings to update
     */
    updateSettings: async (updates: Partial<AppData['settings']>) => {
        const focusStartDates = updates.gtd?.focusIncludeStartDates;
        if (focusStartDates !== undefined && typeof focusStartDates !== 'boolean') {
            set({ error: 'Focus start-date inclusion must be a boolean' });
            return;
        }
        const retentionUpdate = Object.prototype.hasOwnProperty.call(updates.gtd ?? {}, 'archiveRetentionDays');
        if (retentionUpdate && updates.gtd?.archiveRetentionDays !== undefined
            && !isArchiveRetentionDays(updates.gtd.archiveRetentionDays)) {
            set({ error: 'Archive retention must be an integer from 0 to 36500 days' });
            return;
        }
        if (retentionUpdate && (get().isLoading || get().editLockCount > 0 || get().persistenceFailure)) {
            set({ error: 'Archive retention is unavailable while data is loading, editing, or unsaved' });
            return;
        }
        // A store that never loaded a document has no device identity yet.
        // Persisting from it would enqueue a snapshot of the empty in-memory
        // state, which the pre-load save flush then writes over the on-disk
        // document (#852). Apply the update in memory only and let the first
        // load win; callers that still need the change re-apply after load.
        if (!get().settings.deviceId) {
            set((state) => ({ settings: mergeSettingsUpdates(state.settings, updates) }));
            logWarn('Skipped settings persistence before initial data load', {
                scope: 'store',
                category: 'storage',
                context: { keys: Object.keys(updates).join(',') },
            });
            return;
        }
        const archiveDaysUpdate = updates.gtd?.autoArchiveDays !== undefined;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const nowIso = new Date().toISOString();
            const preparedUpdates = updates.savedFilters
                ? {
                    ...updates,
                    savedFilters: prepareLocalSavedFilterUpdates(
                        deviceState.settings.savedFilters,
                        updates.savedFilters,
                        nowIso,
                    ),
                }
                : updates;
            const nextSettings = mergeSettingsUpdates(deviceState.settings, preparedUpdates);
            if (owns(updates, 'savedSearches')) {
                nextSettings.savedSearchesUpdatedAt = timestampAtLeastAfter(
                    nowIso, deviceState.settings.savedSearchesUpdatedAt,
                );
            }
            const nextSyncUpdatedAt = { ...(deviceState.settings.syncPreferencesUpdatedAt ?? {}) };
            let syncUpdated = false;

            const markSyncUpdated = (key: keyof NonNullable<AppData['settings']['syncPreferencesUpdatedAt']>) => {
                nextSyncUpdatedAt[key] = timestampAtLeastAfter(nowIso, nextSyncUpdatedAt[key]);
                syncUpdated = true;
            };

            if ('syncPreferences' in updates) {
                markSyncUpdated('preferences');
            }

            if ('theme' in updates || 'appearance' in updates || 'keybindingStyle' in updates) {
                markSyncUpdated('appearance');
            }

            if ('language' in updates || 'weekStart' in updates || 'dateFormat' in updates || 'timeFormat' in updates) {
                markSyncUpdated('language');
            }

            if (settingsValueChanged(
                getGtdSyncSnapshot(deviceState.settings),
                getGtdSyncSnapshot(nextSettings),
            )) {
                markSyncUpdated('gtd');
            }

            if ('externalCalendars' in updates) {
                markSyncUpdated('externalCalendars');
            }

            if ('savedFilters' in updates) {
                markSyncUpdated('savedFilters');
            }

            if ('ai' in updates) {
                const prevAi = normalizeAiSettingsForSync(deviceState.settings.ai);
                const nextAi = normalizeAiSettingsForSync(nextSettings.ai);
                if (JSON.stringify(prevAi ?? null) !== JSON.stringify(nextAi ?? null)) {
                    markSyncUpdated('ai');
                }
            }

            const newSettings = syncUpdated ? { ...nextSettings, syncPreferencesUpdatedAt: nextSyncUpdatedAt } : nextSettings;
            const shouldTrackChange = owns(updates, 'savedSearches')
                || shouldTrackSettingsChange(state.settings, newSettings, updates);
            if (retentionUpdate && newSettings.gtd?.archiveRetentionDays) {
                const preview = getArchiveRetentionPreview({
                    tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
                }, newSettings.gtd.archiveRetentionDays);
                const backfill = backfillArchiveClocks({ tasks: state._allTasks, projects: state._allProjects },
                    preview, nowIso, deviceState.deviceId);
                if (backfill.tasks !== state._allTasks || backfill.projects !== state._allProjects) {
                    clearDerivedCache();
                    persist(set, debouncedSave, state, { tasks: backfill.tasks, projects: backfill.projects, settings: newSettings });
                    return { _allTasks: backfill.tasks, _allProjects: backfill.projects, settings: newSettings,
                        lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
                }
            }
            if (archiveDaysUpdate) {
                const autoArchiveResult = runAutoArchive(state._allTasks, newSettings, {
                    nowIso,
                    nowMs: Date.now(),
                    deviceId: deviceState.deviceId,
                });

                if (autoArchiveResult.didAutoArchive) {
                    persist(set, debouncedSave, state, { tasks: autoArchiveResult.allTasks, settings: newSettings });
                    return {
                        _allTasks: autoArchiveResult.allTasks,
                        settings: newSettings,
                        lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt),
                    };
                }
            }

            persist(set, debouncedSave, state, { settings: newSettings });
            return {
                settings: newSettings,
                lastDataChangeAt: shouldTrackChange ? getNextDataChangeAt(state.lastDataChangeAt) : state.lastDataChangeAt,
            };
        });
    },

    commitPreparedGeneralPreference: async (input, authority) => {
        let result: import('./store-types').PreparedTaskEditResult = { success: false,
            reason: 'conflict', error: 'Prepared General preference changed; refresh General' };
        set((memory) => {
            const before = authority.state;
            if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            const { edit, expected } = input.request;
            const current = generalPreferenceWitness(durable.settings, edit.type);
            if (!current) return memory;
            const after = current.present && taskEditValuesEqual(current.value, input.after.value)
                && current.stampPresent && current.stamp === input.after.stamp
                && (durable.settings.deviceId ?? null)
                    === (input.deviceIdBefore ?? input.deviceIdToInitialize);
            if (after) {
                result = { success: true, outcome: 'replayed' };
                return memory;
            }
            if (!taskEditValuesEqual(current, expected)
                || (durable.settings.deviceId ?? null) !== input.deviceIdBefore) return memory;
            const update = buildGeneralSettingsUpdate(durable.settings, edit);
            if (!update || input.after.stamp !== timestampAtLeastAfter(input.preparedAt, expected.stamp ?? undefined))
                return memory;
            const group = edit.type === 'showTaskAge' || edit.type === 'quickAccessView' || edit.type === 'theme'
                ? 'appearance' : 'language';
            const settings: AppData['settings'] = { ...durable.settings, ...update,
                syncPreferencesUpdatedAt: { ...(durable.settings.syncPreferencesUpdatedAt ?? {}),
                    [group]: input.after.stamp },
                ...(input.deviceIdToInitialize ? { deviceId: input.deviceIdToInitialize } : {}) };
            const fresh = generalPreferenceWitness(settings, edit.type);
            if (!fresh || !fresh.present || !taskEditValuesEqual(fresh.value, input.after.value)
                || !fresh.stampPresent || fresh.stamp !== input.after.stamp) return memory;
            const freshTasks = durable.tasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = durable.projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks,
                _allProjects: durable.projects, _allSections: durable.sections ?? [],
                _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings },
            { ...durable, settings });
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: memory.persistenceFailure };
            result = { success: true, outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects,
                _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [],
                _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    },

    commitPreparedGtdWorkflow: async (input, authority) => {
        let result: import('./store-types').PreparedTaskEditResult = { success: false,
            reason: 'conflict', error: 'GTD workflow default changed; refresh GTD' };
        set((memory) => {
            const before = authority.state;
            if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            const { edit, expected } = input.request;
            const current = gtdWorkflowWitness(durable.settings, edit.type,
                edit.type === 'taskEditorSectionOpen' ? edit.section : undefined);
            if (!current) return memory;
            const update = buildGtdSettingsUpdate(durable.settings, edit);
            if (!update) return memory;
            const target = update.gtd;
            const after = (edit.type === 'taskEditorSectionOpen'
                ? !!input.after.selected && taskEditValuesEqual(
                    gtdWorkflowTaskEditorSelected(current as GtdWorkflowTaskEditorWitness), input.after.selected)
                : edit.type === 'taskEditorPreset' || edit.type === 'taskEditorFieldVisible'
                    || edit.type === 'taskEditorFieldSection' || edit.type === 'taskEditorOrder'
                    || edit.type === 'taskEditorReset'
                ? !!input.after.selected && taskEditValuesEqual(
                    gtdWorkflowPresetSelected(current as GtdWorkflowPresetWitness), input.after.selected)
                : edit.type === 'defaultArea'
                ? (current as GtdWorkflowAreaWitness).modePresent && (current as GtdWorkflowAreaWitness).idPresent
                    && taskEditValuesEqual((current as GtdWorkflowAreaWitness).mode, target?.defaultAreaMode)
                    && taskEditValuesEqual((current as GtdWorkflowAreaWitness).id, target?.defaultAreaId)
                : (current as GtdWorkflowDirectWitness | GtdWorkflowReviewWitness).present
                    && taskEditValuesEqual((current as GtdWorkflowDirectWitness | GtdWorkflowReviewWitness).value, input.after.value))
                && current.stampPresent && current.stamp === input.after.stamp
                && (durable.settings.deviceId ?? null)
                    === (input.deviceIdBefore ?? input.deviceIdToInitialize);
            const archiveReceipt = edit.type !== 'autoArchiveDays' || input.archiveEffects?.every((effect) =>
                taskEditValuesEqual(durable.tasks.find((task) => task.id === effect.after.id), effect.after));
            if (after && archiveReceipt) {
                result = { success: true, outcome: 'replayed' };
                return memory;
            }
            if (!taskEditValuesEqual(current, expected)
                || (durable.settings.deviceId ?? null) !== input.deviceIdBefore) return memory;
            if (isGtdSettingStored(durable.settings, edit)) return memory;
            if (edit.type === 'defaultArea' && (edit.value === '' || edit.value === GTD_DEFAULT_AREA_ACTIVE_OPTION
                ? input.targetArea !== null
                : !input.targetArea || !taskEditValuesEqual(input.targetArea,
                    gtdWorkflowTargetArea(durable.areas.find((area) => area.id === edit.value))))) return memory;
            if (input.after.stamp !== timestampAtLeastAfter(input.preparedAt, expected.stamp ?? undefined))
                return memory;
            const settings: AppData['settings'] = { ...durable.settings, ...update,
                syncPreferencesUpdatedAt: { ...(durable.settings.syncPreferencesUpdatedAt ?? {}),
                    gtd: input.after.stamp },
                ...(input.deviceIdToInitialize ? { deviceId: input.deviceIdToInitialize } : {}) };
            const fresh = gtdWorkflowWitness(settings, edit.type,
                edit.type === 'taskEditorSectionOpen' ? edit.section : undefined);
            if (!fresh || !(edit.type === 'taskEditorSectionOpen'
                ? !!input.after.selected && taskEditValuesEqual(
                    gtdWorkflowTaskEditorSelected(fresh as GtdWorkflowTaskEditorWitness), input.after.selected)
                : edit.type === 'taskEditorPreset' || edit.type === 'taskEditorFieldVisible'
                    || edit.type === 'taskEditorFieldSection' || edit.type === 'taskEditorOrder'
                    || edit.type === 'taskEditorReset'
                ? !!input.after.selected && taskEditValuesEqual(
                    gtdWorkflowPresetSelected(fresh as GtdWorkflowPresetWitness), input.after.selected)
                : edit.type === 'defaultArea'
                ? (fresh as GtdWorkflowAreaWitness).modePresent && (fresh as GtdWorkflowAreaWitness).idPresent
                    && taskEditValuesEqual((fresh as GtdWorkflowAreaWitness).mode, target?.defaultAreaMode)
                    && taskEditValuesEqual((fresh as GtdWorkflowAreaWitness).id, target?.defaultAreaId)
                : (fresh as GtdWorkflowDirectWitness | GtdWorkflowReviewWitness).present
                    && taskEditValuesEqual((fresh as GtdWorkflowDirectWitness | GtdWorkflowReviewWitness).value, input.after.value))
                || !fresh.stampPresent || fresh.stamp !== input.after.stamp) return memory;
            const archiveEffects = edit.type === 'autoArchiveDays'
                ? gtdArchiveEffects(durable.tasks, settings, input.preparedAt,
                    input.deviceIdBefore ?? input.deviceIdToInitialize!) : null;
            if (archiveEffects && !taskEditValuesEqual(archiveEffects, input.archiveEffects)) return memory;
            const archivedById = new Map(archiveEffects?.map((effect) => [effect.before.id, effect.after]) ?? []);
            const writtenTasks = archiveEffects
                ? durable.tasks.map((row) => archivedById.get(row.id) ?? row) : durable.tasks;
            const freshTasks = writtenTasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = durable.projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks,
                _allProjects: durable.projects, _allSections: durable.sections ?? [],
                _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings },
            { ...durable, tasks: writtenTasks, settings });
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: memory.persistenceFailure };
            result = { success: true, outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects,
                _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [],
                _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    },

    commitPreparedAppLock: async (request, authority) => {
        let result: import('./store-types').PreparedTaskEditResult = { success: false,
            reason: 'conflict', error: 'App lock changed; refresh General' };
        set((memory) => {
            const before = authority.state;
            if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            const current = appLockWitness(durable.settings);
            if (!current || !taskEditValuesEqual(current, request.expected)
                || current.present && current.value === request.value) return memory;
            const update = buildGeneralSettingsUpdate(durable.settings, { type: 'appLock', value: request.value });
            if (!update) return memory;
            const settings = { ...durable.settings, ...update };
            const rawSnapshot = { ...durable, settings };
            const freshTasks = durable.tasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = durable.projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks,
                _allProjects: durable.projects, _allSections: durable.sections ?? [],
                _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings },
            rawSnapshot);
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: memory.persistenceFailure };
            authority.rawSavedSnapshot = rawSnapshot;
            result = { success: true, outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects,
                _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [],
                _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    },

    retryPreparedAppLockSnapshot: async (authority) => {
        let result: import('./store-types').PreparedTaskEditResult = { success: false,
            reason: 'conflict', error: 'App lock save ownership changed' };
        set((memory) => {
            const boundary = authority.saveBoundary;
            const raw = authority.rawSavedSnapshot;
            if (!boundary || !raw || memory._allTasks !== boundary.taskReference
                || memory.lastDataChangeAt !== boundary.lastDataChangeAt
                || memory.settings !== raw.settings || memory.persistenceFailure === null
                || boundary.generation !== getSaveGeneration()) return memory;
            persist(set, debouncedSave, { ...memory, _allTasks: raw.tasks,
                _allProjects: raw.projects, _allSections: raw.sections ?? [],
                _allAreas: raw.areas ?? [], _allPeople: raw.people ?? [] }, raw);
            authority.saveBoundary = { ...boundary, generation: getSaveGeneration(),
                failure: memory.persistenceFailure };
            result = { success: true, outcome: 'applied' };
            return { ...memory };
        });
        return result;
    },

    commitPreparedNotificationSetting: async (request, authority) => {
        let result: import('./store-types').PreparedTaskEditResult = { success: false,
            reason: 'conflict', error: 'Notification setting changed; refresh Notifications' };
        set((memory) => {
            const before = authority.state;
            if (memory.persistenceFailure || memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            const current = notificationSettingWitness(durable.settings, request.edit.type);
            if (!current || !taskEditValuesEqual(current, request.expected)
                || current.present && current.value === request.edit.value) return memory;
            const settings = { ...durable.settings, [request.edit.type]: request.edit.value };
            const rawSnapshot = { ...durable, settings };
            const freshTasks = durable.tasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = durable.projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks,
                _allProjects: durable.projects, _allSections: durable.sections ?? [],
                _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings }, rawSnapshot);
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: memory.persistenceFailure };
            authority.rawSavedSnapshot = rawSnapshot;
            result = { success: true, outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects,
                _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [],
                _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    },

    retryPreparedNotificationSettingSnapshot: async (authority) => {
        let result: import('./store-types').PreparedTaskEditResult = { success: false,
            reason: 'conflict', error: 'Notification save ownership changed' };
        set((memory) => {
            const boundary = authority.saveBoundary, raw = authority.rawSavedSnapshot;
            if (!boundary || !raw || memory._allTasks !== boundary.taskReference
                || memory.lastDataChangeAt !== boundary.lastDataChangeAt
                || memory.settings !== raw.settings || memory.persistenceFailure === null
                || memory.persistenceFailure !== boundary.failure
                || boundary.generation !== getSaveGeneration()) return memory;
            persist(set, debouncedSave, { ...memory, _allTasks: raw.tasks,
                _allProjects: raw.projects, _allSections: raw.sections ?? [],
                _allAreas: raw.areas ?? [], _allPeople: raw.people ?? [] }, raw);
            authority.saveBoundary = { ...boundary, generation: getSaveGeneration(), failure: memory.persistenceFailure };
            result = { success: true, outcome: 'applied' };
            return { ...memory };
        });
        return result;
    },

    commitPreparedCalendarSubscriptionSetting: async (prepared, authority, legacyRaw) => {
        let result: import('./store-types').PreparedTaskEditResult = { success: false,
            reason: 'conflict', error: 'Calendar subscriptions changed; refresh Settings' };
        set((memory) => {
            const before = authority.state;
            if (memory.persistenceFailure || memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            const source = calendarSubscriptionSettingSource(durable.settings, legacyRaw);
            if (!source || !taskEditValuesEqual(source.witness, prepared.request.expected)
                || (durable.settings.deviceId ?? null) !== prepared.deviceIdBefore
                || prepared.stamp !== timestampAtLeastAfter(prepared.preparedAt, source.witness.stamp ?? undefined)) return memory;
            const planned = planCalendarSubscriptionSetting(source.feeds, prepared.request.edit);
            if (!planned?.changed) return memory;
            const settings = { ...durable.settings, externalCalendars: planned.feeds,
                syncPreferencesUpdatedAt: { ...(durable.settings.syncPreferencesUpdatedAt ?? {}), externalCalendars: prepared.stamp },
                ...(prepared.deviceIdToInitialize === null ? {} : { deviceId: prepared.deviceIdToInitialize }) };
            const rawSnapshot = { ...durable, settings };
            const freshTasks = durable.tasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = durable.projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks,
                _allProjects: durable.projects, _allSections: durable.sections ?? [],
                _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings }, rawSnapshot);
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: memory.persistenceFailure };
            authority.rawSavedSnapshot = rawSnapshot;
            result = { success: true, outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects,
                _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [],
                _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    },

    retryPreparedCalendarSubscriptionSettingSnapshot: async (authority) => {
        let result: import('./store-types').PreparedTaskEditResult = { success: false,
            reason: 'conflict', error: 'Calendar subscription save ownership changed' };
        set((memory) => {
            const boundary = authority.saveBoundary, raw = authority.rawSavedSnapshot;
            if (!boundary || !raw || memory._allTasks !== boundary.taskReference
                || memory.lastDataChangeAt !== boundary.lastDataChangeAt
                || memory.settings !== raw.settings || memory.persistenceFailure === null
                || memory.persistenceFailure !== boundary.failure
                || boundary.generation !== getSaveGeneration()) return memory;
            persist(set, debouncedSave, { ...memory, _allTasks: raw.tasks,
                _allProjects: raw.projects, _allSections: raw.sections ?? [],
                _allAreas: raw.areas ?? [], _allPeople: raw.people ?? [] }, raw);
            authority.saveBoundary = { ...boundary, generation: getSaveGeneration(), failure: memory.persistenceFailure };
            result = { success: true, outcome: 'applied' };
            return { ...memory };
        });
        return result;
    },

    commitPreparedFocusSavedFilter: async (input) => {
        let result: import('./store-types').PreparedTaskEditResult = {
            success: false, reason: 'conflict', error: 'Prepared Focus saved filter conflicts with current data',
        };
        set((state) => {
            const filters = state.settings.savedFilters ?? [];
            const matches = filters.filter((filter) => filter.id === input.after.id);
            if (matches.length > 1) return state;
            // The exact target row is the durable receipt, even after unrelated settings change.
            if (matches.length === 1 && focusSavedFilterToken(matches[0]) === focusSavedFilterToken(input.after)) {
                result = { success: true, outcome: 'replayed' };
                return state;
            }
            if (!state.settings.deviceId
                || (input.scope.before === null ? matches.length !== 0
                    : matches.length !== 1 || focusSavedFilterToken(matches[0]) !== focusSavedFilterToken(input.scope.before))
                || (input.request.operation.type === 'save'
                    && focusSavedFilterToken(focusSavedFilterCreation(state, input.request.controls))
                        !== focusSavedFilterToken(input.scope.creation))) return state;
            const savedFilters = input.scope.before === null
                ? [...filters, input.after]
                : filters.map((filter) => filter.id === input.after.id ? input.after : filter);
            const syncPreferencesUpdatedAt = { ...(state.settings.syncPreferencesUpdatedAt ?? {}),
                savedFilters: timestampAtLeastAfter(input.preparedAt, state.settings.syncPreferencesUpdatedAt?.savedFilters) };
            const settings = { ...state.settings, savedFilters, syncPreferencesUpdatedAt };
            persist(set, debouncedSave, state, { settings });
            result = { success: true, outcome: 'applied' };
            return { settings, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedSavedSearchWrite: async (input) => {
        let result: import('./store-types').PreparedTaskEditResult = {
            success: false, reason: 'conflict', error: 'Prepared saved search conflicts with current data',
        };
        set((state) => {
            const current = savedSearchWriteScope(state.settings);
            if (focusSavedFilterToken(current) === focusSavedFilterToken(input.after)) {
                result = { success: true, outcome: 'replayed' };
                return state;
            }
            if (!state.settings.deviceId || !input.after.savedSearchesPresent
                || !Array.isArray(input.after.savedSearches) || !input.after.stampPresent
                || typeof input.after.stamp !== 'string'
                || focusSavedFilterToken(current) !== focusSavedFilterToken(input.before)) return state;
            const settings = { ...state.settings, savedSearches: input.after.savedSearches,
                savedSearchesUpdatedAt: input.after.stamp };
            persist(set, debouncedSave, state, { settings });
            result = { success: true, outcome: 'applied' };
            return { settings, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    persistSnapshot: async () => {
        set((state) => {
            persist(set, debouncedSave, state);
            return {};
        });
    },

    getDerivedState: () => {
        const state = get();
        const now = new Date();
        const day = now.toDateString();
        if (
            derivedCache
            && derivedCache.visibleTasksRef === state.tasks
            && derivedCache.taskLookupRef === state._tasksById
            && derivedCache.projectLookupRef === state._projectsById
            && derivedCache.day === day
        ) {
            return derivedCache.value;
        }
        const rebuildStartedAt = profilerNow();
        const previous = derivedCache?.value;
        const taskDerived =
            derivedCache
                && derivedCache.visibleTasksRef === state.tasks
                && derivedCache.taskLookupRef === state._tasksById
                && derivedCache.day === day
                && previous
                ? {
                    tasksById: previous.tasksById,
                    activeTasksByStatus: previous.activeTasksByStatus,
                    tasksByProjectId: previous.tasksByProjectId,
                    tasksByContext: previous.tasksByContext,
                    tasksByTag: previous.tasksByTag,
                    focusedTasks: previous.focusedTasks,
                    projectTaskSummaryById: previous.projectTaskSummaryById,
                    allContexts: previous.allContexts,
                    allTags: previous.allTags,
                    contextTokenUsage: previous.contextTokenUsage,
                    tagTokenUsage: previous.tagTokenUsage,
                    dateCoherenceIssuesByTaskId: previous.dateCoherenceIssuesByTaskId,
                    focusedCount: previous.focusedCount,
                }
                : computeTaskDerivedState(state.tasks, state._tasksById, now);
        const projectDerived =
            derivedCache && derivedCache.projectLookupRef === state._projectsById && previous
                ? {
                    projectMap: previous.projectMap,
                    sequentialProjectIds: previous.sequentialProjectIds,
                    sequentialWithinSectionProjectIds: previous.sequentialWithinSectionProjectIds,
                    focusedProjectCount: previous.focusedProjectCount,
                }
                : computeProjectDerivedState(state._allProjects, state._projectsById);
        const derived = {
            ...projectDerived,
            ...taskDerived,
        };
        derivedCache = {
            visibleTasksRef: state.tasks,
            taskLookupRef: state._tasksById,
            projectLookupRef: state._projectsById,
            day,
            value: derived,
        };
        recordDerivedStateRebuild(profilerNow() - rebuildStartedAt);
        return derived;
    },

    setHighlightTask: (id: string | null) => {
        set({ highlightTaskId: id, highlightTaskAt: id ? Date.now() : null });
    },

    getFocusedCount: () => selectFocusedCount(get().tasks),
    };
};
