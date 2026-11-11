import { normalizeTaskReminderPolicy } from './task-reminder-policy';
import type { Area, Attachment, Person, Project, Section, Task } from './types';
import { normalizeProjectSequentialScope, normalizeProjectTaskSortBy } from './project-utils';

const CONTENT_DIFF_IGNORED_KEYS = new Set([
    'rev',
    'revBy',
    'updatedAt',
    'createdAt',
    'localStatus',
    'purgedAt',
    'order',
    'orderNum',
    'boardOrder',
    'focusOrder',
]);

const SIGNATURE_OPAQUE_KEYS = new Set([
    'statusBeforeProjectArchive',
    'completedAtBeforeProjectArchive',
    'isFocusedTodayBeforeProjectArchive',
    'deletedAtBeforeProjectArchive',
    'projectArchivedAt',
]);

const normalizeOptionalArrayForComparison = <T>(value: T[] | undefined): T[] | undefined =>
    Array.isArray(value) && value.length > 0 ? value : undefined;

export const canonicalizeStringMapForComparison = (
    value: unknown,
): Record<string, string> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (entries.length === 0) return undefined;
    const canonical: Record<string, string> = {};
    for (const [key, entryValue] of entries) canonical[key] = entryValue;
    return canonical;
};

const normalizeAttachmentForContentComparison = (attachment: Attachment): Record<string, unknown> => {
    if (attachment.kind === 'link') {
        return {
            id: attachment.id,
            kind: attachment.kind,
            title: attachment.title,
            uri: attachment.uri,
            deletedAt: attachment.deletedAt,
        };
    }

    return {
        id: attachment.id,
        kind: attachment.kind,
        title: attachment.title,
        deletedAt: attachment.deletedAt,
    };
};

const normalizeAttachmentsForContentComparison = (
    attachments: Attachment[] | undefined
): Record<string, unknown>[] | undefined => {
    if (!Array.isArray(attachments) || attachments.length === 0) {
        return undefined;
    }
    return [...attachments]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((attachment) => normalizeAttachmentForContentComparison(attachment));
};


export const TASK_CONTENT_COMPARISON_EXCLUDED_KEYS = [
    'rev',
    'revBy',
    'createdAt',
    'updatedAt',
    'purgedAt',
    'order',
    'orderNum',
    'boardOrder',
    'focusOrder',
    'statusBeforeProjectArchive',
    'completedAtBeforeProjectArchive',
    'isFocusedTodayBeforeProjectArchive',
    'projectArchivedAt',
] as const satisfies readonly (keyof Task)[];

type TaskContentComparisonExcludedKey = (typeof TASK_CONTENT_COMPARISON_EXCLUDED_KEYS)[number];

export const normalizeTaskForContentComparison = (task: Task): Record<string, unknown> => {
    const hasRecurrence = task.recurrence !== undefined && task.recurrence !== null;
    const comparable = {
        id: task.id,
        title: task.title,
        status: task.status === 'inbox' ? undefined : task.status,
        priority: task.priority,
        energyLevel: task.energyLevel,
        assignedTo: task.assignedTo,
        taskMode: task.taskMode,
        startTime: task.startTime,
        relativeStartOffset: task.relativeStartOffset,
        dueDate: task.dueDate,
        recurrence: task.recurrence,
        tags: normalizeOptionalArrayForComparison(task.tags),
        contexts: normalizeOptionalArrayForComparison(task.contexts),
        checklist: normalizeOptionalArrayForComparison(task.checklist),
        description: task.description,
        textDirection: task.textDirection,


        attachments: task.deletedAt ? undefined : normalizeAttachmentsForContentComparison(task.attachments),
        location: task.location,
        projectId: task.projectId,
        sectionId: task.sectionId,
        viewSectionIds: canonicalizeStringMapForComparison(task.viewSectionIds),
        areaId: task.areaId,
        isFocusedToday: task.isFocusedToday ? true : undefined,
        timeEstimate: task.timeEstimate,
        timeSpentMinutes: task.timeSpentMinutes ? task.timeSpentMinutes : undefined,
        showFutureRecurrence: hasRecurrence && task.showFutureRecurrence ? true : undefined,
        suppressMindwtrReminders: task.suppressMindwtrReminders ? true : undefined,
        reminderPolicy: normalizeTaskReminderPolicy(task.reminderPolicy),
        pushCount: task.pushCount === 0 ? undefined : task.pushCount,
        repeatReminderMinutes: task.repeatReminderMinutes ? task.repeatReminderMinutes : undefined,
        dueReminderLeadMinutes: task.dueReminderLeadMinutes || undefined,
        startReminderLeadMinutes: task.startReminderLeadMinutes || undefined,
        reviewAt: task.reviewAt,
        completedAt: task.completedAt,
        cancelledAt: task.cancelledAt,
        archivedAt: task.archivedAt,
        deletedAt: task.deletedAt,
    } satisfies Record<Exclude<keyof Task, TaskContentComparisonExcludedKey>, unknown>;
    return comparable;
};

export const normalizeProjectForContentComparison = (project: Project): Record<string, unknown> => {
    const comparable: Record<string, unknown> = {
        ...project,
        colorOverride: project.colorOverride ?? undefined,
        tagIds: normalizeOptionalArrayForComparison(project.tagIds),
        attachments: project.deletedAt ? undefined : normalizeAttachmentsForContentComparison(project.attachments),
        isSequential: project.isSequential ? true : undefined,
        sequentialScope: project.isSequential && normalizeProjectSequentialScope(project.sequentialScope) === 'section'
            ? 'section'
            : undefined,

        perSectionFlow: project.perSectionFlow === true ? true : undefined,
        taskSortBy: normalizeProjectTaskSortBy(project.taskSortBy),
        isFocused: project.isFocused ? true : undefined,
        viewSectionIds: canonicalizeStringMapForComparison(project.viewSectionIds),
    };
    if (project.status === 'active') delete comparable.status;
    if (project.color === '#6B7280') delete comparable.color;
    return comparable;
};

export const normalizeSectionForContentComparison = (section: Section): Record<string, unknown> => ({
    ...section,
    isCollapsed: section.isCollapsed ? true : undefined,
});

type AreaContentComparisonInput = Omit<Area, 'order'> & {
    order?: number;
};

export const normalizeAreaForContentComparison = (area: AreaContentComparisonInput): Record<string, unknown> => ({
    ...area,
    color: area.color === '#6B7280' ? undefined : area.color,
    order: undefined,
});

export const normalizePersonForContentComparison = (person: Person): Record<string, unknown> => ({
    ...person,
    note: person.note?.trim() || undefined,
    referenceLink: person.referenceLink?.trim() || undefined,
});

export const toComparableValue = (value: unknown, options?: { includeIgnoredKeys?: boolean }): unknown => {
    const includeIgnoredKeys = options?.includeIgnoredKeys === true;
    if (Array.isArray(value)) {
        const comparableArray = value
            .map((item) => toComparableValue(item, options))
            .filter((item) => item !== undefined && item !== null);
        return comparableArray.length > 0 ? comparableArray : undefined;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const comparable: Record<string, unknown> = {};


        const keys = Object.keys(record).filter((key) => (
            record[key] !== undefined && record[key] !== null
            && !SIGNATURE_OPAQUE_KEYS.has(key)
            && (includeIgnoredKeys || !CONTENT_DIFF_IGNORED_KEYS.has(key))
            && (includeIgnoredKeys || key !== 'uri' || record.kind !== 'file')
        ));
        for (const key of keys.sort()) {
            const comparableValue = toComparableValue(record[key], options);
            if (comparableValue === undefined || comparableValue === null) continue;
            comparable[key] = comparableValue;
        }
        return Object.keys(comparable).length > 0 ? comparable : undefined;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    return value;
};


const mergeComparableSignatureCache = new WeakMap<object, string>();
const plainComparableSignatureCache = new WeakMap<object, string>();
const deterministicSignatureCache = new WeakMap<object, string>();

const computeSignature = (value: unknown, options?: { includeIgnoredKeys?: boolean }): string =>
    JSON.stringify(toComparableValue(value, options));


let validateCacheHits = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';


export const setSignatureCacheValidationForTests = (enabled: boolean): void => {
    validateCacheHits = enabled;
};

const memoizedSignature = (
    cache: WeakMap<object, string>,
    value: unknown,
    compute: () => string,
): string => {
    if (!value || typeof value !== 'object') return compute();
    const cached = cache.get(value);
    if (cached !== undefined) {
        if (validateCacheHits && compute() !== cached) {
            throw new Error(
                'Signature cache hit diverged from recomputation: a synced entity was mutated in place. '
                + 'Synced entities must be replaced, never mutated (#766).',
            );
        }
        return cached;
    }
    const signature = compute();
    cache.set(value, signature);
    return signature;
};

export const toComparableSignature = (value: unknown): string =>
    memoizedSignature(plainComparableSignatureCache, value, () => computeSignature(value));


export const getMergeComparableSignature = <T>(
    item: T,
    normalizeForComparison?: (item: T) => unknown,
): string => {
    if (!normalizeForComparison) return toComparableSignature(item);
    return memoizedSignature(
        mergeComparableSignatureCache,
        item,
        () => computeSignature(normalizeForComparison(item)),
    );
};

const toDeterministicSignature = (value: unknown): string =>
    memoizedSignature(deterministicSignatureCache, value, () => computeSignature(value, { includeIgnoredKeys: true }));

export const hashComparableSignature = (signature: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < signature.length; index += 1) {
        hash ^= signature.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

export const collectComparableDiffKeys = (
    localValue: unknown,
    incomingValue: unknown,
    limit: number = 8
): string[] => {
    const diffKeys: string[] = [];
    const visit = (left: unknown, right: unknown, path: string) => {
        if (diffKeys.length >= limit) return;
        if (Object.is(left, right)) return;

        const leftIsArray = Array.isArray(left);
        const rightIsArray = Array.isArray(right);
        if (leftIsArray || rightIsArray) {
            if (!leftIsArray || !rightIsArray) {
                diffKeys.push(path || '(root)');
                return;
            }
            if (left.length !== right.length) {
                diffKeys.push(path || '(root)');
                return;
            }
            for (let index = 0; index < left.length; index += 1) {
                visit(left[index], right[index], `${path}[${index}]`);
                if (diffKeys.length >= limit) return;
            }
            return;
        }

        const leftIsObject = typeof left === 'object' && left !== null;
        const rightIsObject = typeof right === 'object' && right !== null;
        if (leftIsObject || rightIsObject) {
            if (!leftIsObject || !rightIsObject) {
                diffKeys.push(path || '(root)');
                return;
            }
            const leftRecord = left as Record<string, unknown>;
            const rightRecord = right as Record<string, unknown>;
            const keys = Array.from(new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])).sort();
            for (const key of keys) {
                const nextPath = path ? `${path}.${key}` : key;
                if (!(key in leftRecord) || !(key in rightRecord)) {
                    diffKeys.push(nextPath);
                    if (diffKeys.length >= limit) return;
                    continue;
                }
                visit(leftRecord[key], rightRecord[key], nextPath);
                if (diffKeys.length >= limit) return;
            }
            return;
        }

        diffKeys.push(path || '(root)');
    };

    visit(localValue, incomingValue, '');
    return diffKeys;
};

export const chooseDeterministicWinner = <T>(localItem: T, incomingItem: T): T => {
    const localSignature = toComparableSignature(localItem) ?? '';
    const incomingSignature = toComparableSignature(incomingItem) ?? '';
    if (localSignature === incomingSignature) {
        const localFullSignature = toDeterministicSignature(localItem) ?? '';
        const incomingFullSignature = toDeterministicSignature(incomingItem) ?? '';
        if (localFullSignature === incomingFullSignature) return incomingItem;
        return incomingFullSignature > localFullSignature ? incomingItem : localItem;
    }
    return incomingSignature > localSignature ? incomingItem : localItem;
};
