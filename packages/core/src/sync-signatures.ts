import type { Project, Section, Task } from './types';

const CONTENT_DIFF_IGNORED_KEYS = new Set([
    'rev',
    'revBy',
    'updatedAt',
    'createdAt',
    'localStatus',
    'purgedAt',
    'order',
    'orderNum',
]);

const normalizeOptionalArrayForComparison = <T>(value: T[] | undefined): T[] | undefined =>
    Array.isArray(value) && value.length > 0 ? value : undefined;

export const normalizeTaskForContentComparison = (task: Task): Record<string, unknown> => {
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

export const normalizeProjectForContentComparison = (project: Project): Record<string, unknown> => {
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

export const normalizeSectionForContentComparison = (section: Section): Record<string, unknown> => ({
    ...section,
    isCollapsed: section.isCollapsed ? true : undefined,
});

export const toComparableValue = (value: unknown, options?: { includeIgnoredKeys?: boolean }): unknown => {
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

const comparableSignatureCache = new WeakMap<object, string>();
const deterministicSignatureCache = new WeakMap<object, string>();

export const toComparableSignature = (value: unknown): string => {
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
