import { Dimensions } from 'react-native';
import {
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_SECTION_BY_FIELD,
    DEFAULT_TASK_EDITOR_SECTION_OPEN,
    DEFAULT_TASK_EDITOR_VISIBLE,
    isTaskEditorSectionableField,
    type TaskEditorFieldId,
    type TaskEditorSectionId,
    type TaskStatus,
} from '@mindwtr/core';
import { logError, logWarn } from '../../lib/app-log';

export const STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];
const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const buildTaskExtra = (message?: string, error?: unknown): Record<string, string> | undefined => {
    const extra: Record<string, string> = {};
    if (message) extra.message = message;
    if (error) extra.error = formatError(error);
    return Object.keys(extra).length ? extra : undefined;
};

export const logTaskWarn = (message: string, error?: unknown) => {
    void logWarn(message, { scope: 'task', extra: buildTaskExtra(undefined, error) });
};

export const logTaskError = (message: string, error?: unknown) => {
    const err = error instanceof Error ? error : new Error(message);
    void logError(err, { scope: 'task', extra: buildTaskExtra(message, error) });
};

export const isReleasedAudioPlayerError = (error: unknown): boolean => {
    const message = formatError(error).toLowerCase();
    return (
        message.includes('already released')
        || message.includes('cannot use shared object')
        || message.includes('cannot be cast to type expo.modules.audio.audioplayer')
    );
};

export const isValidLinkUri = (value: string): boolean => {
    try {
        const parsed = new URL(value);
        return parsed.protocol.length > 0;
    } catch {
        return false;
    }
};

export const QUICK_TOKEN_LIMIT = 6;

export const getInitialWindowWidth = (): number => {
    const width = Dimensions?.get?.('window')?.width;
    return Number.isFinite(width) && width > 0 ? Math.round(width) : 1;
};

export const getTaskEditTabOffset = (mode: 'task' | 'view', containerWidth: number): number =>
    mode === 'task' ? 0 : containerWidth;

type ScrollValueLike = {
    setValue?: (value: number) => void;
};

type ScrollNodeLike = {
    scrollTo?: (options: { x: number; animated?: boolean }) => void;
    getNode?: () => ScrollNodeLike | null | undefined;
} | null | undefined;

export const syncTaskEditPagerPosition = ({
    mode,
    containerWidth,
    scrollValue,
    scrollNode,
    animated = true,
}: {
    mode: 'task' | 'view';
    containerWidth: number;
    scrollValue?: ScrollValueLike | null;
    scrollNode?: ScrollNodeLike;
    animated?: boolean;
}): void => {
    if (!containerWidth) return;
    const x = getTaskEditTabOffset(mode, containerWidth);
    scrollValue?.setValue?.(x);
    if (scrollNode?.scrollTo) {
        scrollNode.scrollTo({ x, animated });
        return;
    }
    scrollNode?.getNode?.()?.scrollTo?.({ x, animated });
};

export type TaskEditorPresetId = 'simple' | 'standard' | 'full' | 'custom';

export type TaskEditorPresetConfig = {
    order: TaskEditorFieldId[];
    hidden: TaskEditorFieldId[];
    sections: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>;
    sectionOpen: Partial<Record<TaskEditorSectionId, boolean>>;
};

const isTaskEditorSectionId = (value: unknown): value is TaskEditorSectionId =>
    value === 'basic' || value === 'scheduling' || value === 'organization' || value === 'details';

const TASK_EDITOR_PRESET_VISIBLE_FIELDS: Record<Exclude<TaskEditorPresetId, 'custom'>, TaskEditorFieldId[]> = {
    simple: ['status', 'project', 'area', 'contexts', 'dueDate'],
    standard: [...DEFAULT_TASK_EDITOR_VISIBLE],
    full: [...DEFAULT_TASK_EDITOR_ORDER],
};

const normalizeTaskEditorHidden = (
    hidden: Iterable<TaskEditorFieldId>,
    featureHiddenFields: Set<TaskEditorFieldId>
): TaskEditorFieldId[] => {
    const next = new Set<TaskEditorFieldId>();
    for (const fieldId of hidden) {
        if (DEFAULT_TASK_EDITOR_ORDER.includes(fieldId)) {
            next.add(fieldId);
        }
    }
    featureHiddenFields.forEach((fieldId) => next.add(fieldId));
    return DEFAULT_TASK_EDITOR_ORDER.filter((fieldId) => next.has(fieldId));
};

const normalizeTaskEditorSectionOverrides = (
    sections?: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>
): Partial<Record<TaskEditorFieldId, TaskEditorSectionId>> => {
    const next: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>> = {};
    (Object.entries(sections ?? {}) as Array<[TaskEditorFieldId, TaskEditorSectionId | undefined]>).forEach(([fieldId, sectionId]) => {
        if (!isTaskEditorSectionableField(fieldId) || !isTaskEditorSectionId(sectionId)) return;
        if (sectionId === DEFAULT_TASK_EDITOR_SECTION_BY_FIELD[fieldId]) return;
        next[fieldId] = sectionId;
    });
    return next;
};

const normalizeTaskEditorSectionOpenOverrides = (
    sectionOpen?: Partial<Record<TaskEditorSectionId, boolean>>
): Partial<Record<TaskEditorSectionId, boolean>> => {
    const next: Partial<Record<TaskEditorSectionId, boolean>> = {};
    (['scheduling', 'organization', 'details'] as const).forEach((sectionId) => {
        const value = sectionOpen?.[sectionId];
        if (typeof value !== 'boolean') return;
        if (value === DEFAULT_TASK_EDITOR_SECTION_OPEN[sectionId]) return;
        next[sectionId] = value;
    });
    return next;
};

const areTaskEditorArraysEqual = (left: TaskEditorFieldId[], right: TaskEditorFieldId[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

const areTaskEditorSectionMapsEqual = (
    left: Partial<Record<TaskEditorFieldId | TaskEditorSectionId, TaskEditorSectionId | boolean>>,
    right: Partial<Record<TaskEditorFieldId | TaskEditorSectionId, TaskEditorSectionId | boolean>>
): boolean => {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && left[key as keyof typeof left] === right[key as keyof typeof right]);
};

export const buildTaskEditorPresetConfig = (
    presetId: Exclude<TaskEditorPresetId, 'custom'>,
    featureHiddenFields: Iterable<TaskEditorFieldId> = []
): TaskEditorPresetConfig => {
    const featureHiddenSet = new Set(featureHiddenFields);
    const visibleSet = new Set(TASK_EDITOR_PRESET_VISIBLE_FIELDS[presetId]);
    const hidden = DEFAULT_TASK_EDITOR_ORDER.filter((fieldId) => !visibleSet.has(fieldId));
    const simpleOrder: TaskEditorFieldId[] = ['status', 'project', 'area', 'contexts', 'dueDate'];
    const base: TaskEditorPresetConfig = {
        order: presetId === 'simple'
            ? [...simpleOrder, ...DEFAULT_TASK_EDITOR_ORDER.filter((fieldId) => !simpleOrder.includes(fieldId))]
            : [...DEFAULT_TASK_EDITOR_ORDER],
        hidden: normalizeTaskEditorHidden(hidden, featureHiddenSet),
        sections: {},
        sectionOpen: {},
    };
    if (presetId === 'full') {
        base.hidden = normalizeTaskEditorHidden([], featureHiddenSet);
        base.sectionOpen = { scheduling: true, organization: true };
    }
    return base;
};

export const resolveTaskEditorPresetId = ({
    order,
    hidden,
    sections,
    sectionOpen,
    featureHiddenFields = [],
}: {
    order: TaskEditorFieldId[];
    hidden: Iterable<TaskEditorFieldId>;
    sections?: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>;
    sectionOpen?: Partial<Record<TaskEditorSectionId, boolean>>;
    featureHiddenFields?: Iterable<TaskEditorFieldId>;
}): TaskEditorPresetId => {
    const featureHiddenSet = new Set(featureHiddenFields);
    const normalizedHidden = normalizeTaskEditorHidden(hidden, featureHiddenSet);
    const normalizedSections = normalizeTaskEditorSectionOverrides(sections);
    const normalizedSectionOpen = normalizeTaskEditorSectionOpenOverrides(sectionOpen);

    for (const presetId of ['simple', 'standard', 'full'] as const) {
        const preset = buildTaskEditorPresetConfig(presetId, featureHiddenSet);
        if (!areTaskEditorArraysEqual(order, preset.order)) continue;
        if (!areTaskEditorArraysEqual(normalizedHidden, preset.hidden)) continue;
        if (!areTaskEditorSectionMapsEqual(normalizedSections, preset.sections)) continue;
        if (!areTaskEditorSectionMapsEqual(normalizedSectionOpen, preset.sectionOpen)) continue;
        return presetId;
    }

    return 'custom';
};
