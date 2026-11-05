import { computeStableValueFingerprint, isDeepJsonEqual, type AppData } from '@mindwtr/core';
import { logInfo } from './app-log';

const ENTITY_COLLECTION_KEYS = ['tasks', 'projects', 'sections', 'areas', 'people'] as const;
type EntityCollectionKey = typeof ENTITY_COLLECTION_KEYS[number];
export type ObservedEntityIds = Record<EntityCollectionKey, string[]>;
export type ChangedEntityBaseline = Partial<Pick<AppData, EntityCollectionKey | 'settings'>> & {
    observedEntityIds: ObservedEntityIds;
};

let reportedStructuralComparison = false;
const sameEntitySnapshot = (left: unknown, right: unknown): boolean => {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;


    if (isDeepJsonEqual(left, right)) {
        if (!reportedStructuralComparison) {
            reportedStructuralComparison = true;
            void logInfo('Storage snapshot comparison skipped fingerprinting', {
                scope: 'storage', extra: { releaseCheck: 'v1.3.0/storage-baseline-equality' },
            });
        }
        return true;
    }
    return computeStableValueFingerprint(left) === computeStableValueFingerprint(right);
};

const STORAGE_FALSE_DEFAULT_FIELDS: Partial<Record<EntityCollectionKey, readonly string[]>> = {
    tasks: ['showFutureRecurrence', 'isFocusedToday', 'suppressMindwtrReminders'],
    projects: ['isSequential', 'isFocused'],
    sections: ['isCollapsed'],
};

const normalizePersistedEntityDefaults = (
    key: EntityCollectionKey,
    entity: { id: string },
): Record<string, unknown> => {
    const normalized: Record<string, unknown> = { ...entity };
    for (const field of STORAGE_FALSE_DEFAULT_FIELDS[key] ?? []) {
        if (normalized[field] === undefined) normalized[field] = false;
    }
    return normalized;
};

const samePersistedEntitySnapshot = (
    key: EntityCollectionKey,
    left: { id: string },
    right: { id: string },
): boolean => sameEntitySnapshot(
    normalizePersistedEntityDefaults(key, left),
    normalizePersistedEntityDefaults(key, right),
);


export const buildChangedEntityBaseline = (
    baseline: AppData,
    target: AppData,
): ChangedEntityBaseline => {
    const observedEntityIds = {} as ObservedEntityIds;
    for (const key of ENTITY_COLLECTION_KEYS) {
        observedEntityIds[key] = (baseline[key] ?? []).map((entity) => entity.id);
    }
    const changed: ChangedEntityBaseline = { observedEntityIds };

    for (const key of ENTITY_COLLECTION_KEYS) {
        const targetById = new Map(
            (target[key] ?? []).map((entity) => [entity.id, entity]),
        );
        const changedEntities = (baseline[key] ?? []).filter((entity) => {
            const targetEntity = targetById.get(entity.id);
            return targetEntity === undefined || !sameEntitySnapshot(entity, targetEntity);
        });
        if (changedEntities.length > 0) {
            (changed as Record<string, unknown>)[key] = changedEntities;
        }
    }

    if (!sameEntitySnapshot(baseline.settings, target.settings)) {
        changed.settings = baseline.settings;
    }


    return changed;
};


export const advanceSaveProvenance = (
    provenance: AppData,
    attempted: AppData,
    canonical: AppData,
): AppData => {
    const next: AppData = {
        ...provenance,
        settings: canonical.settings ?? {},
    };

    for (const key of ENTITY_COLLECTION_KEYS) {
        const trustedById = new Map(
            (provenance[key] ?? []).map((entity) => [entity.id, entity]),
        );
        const attemptedById = new Map(
            (attempted[key] ?? []).map((entity) => [entity.id, entity]),
        );
        const canonicalById = new Map(
            (canonical[key] ?? []).map((entity) => [entity.id, entity]),
        );

        for (const [id, target] of attemptedById) {
            const confirmed = canonicalById.get(id);
            if (confirmed && samePersistedEntitySnapshot(key, target, confirmed)) {
                trustedById.set(id, confirmed);
            }
        }


        for (const id of [...trustedById.keys()]) {
            if (!attemptedById.has(id) && !canonicalById.has(id)) {
                trustedById.delete(id);
            }
        }

        const orderedIds = [
            ...(provenance[key] ?? []).map((entity) => entity.id),
            ...(attempted[key] ?? []).map((entity) => entity.id),
        ];
        const emitted = new Set<string>();
        (next as unknown as Record<EntityCollectionKey, unknown>)[key] = orderedIds
            .filter((id) => !emitted.has(id) && emitted.add(id))
            .map((id) => trustedById.get(id))
            .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity));
    }

    return next;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
    Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
);

const hasOwn = (value: Record<string, unknown>, key: string): boolean => (
    Object.prototype.hasOwnProperty.call(value, key)
);

const isStableIdRecordArray = (value: unknown[]): value is Array<Record<string, unknown> & { id: string }> => {
    const ids = new Set<string>();
    return value.every((item) => {
        if (!isPlainObject(item) || typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)) {
            return false;
        }
        ids.add(item.id);
        return true;
    });
};

const mergeStableIdArray = (
    baseline: Array<Record<string, unknown> & { id: string }>,
    target: Array<Record<string, unknown> & { id: string }>,
    canonical: Array<Record<string, unknown> & { id: string }>,
): unknown[] => {
    const baselineById = new Map(baseline.map((item) => [item.id, item]));
    const targetById = new Map(target.map((item) => [item.id, item]));
    const canonicalIds = new Set(canonical.map((item) => item.id));
    const merged: unknown[] = [];

    for (const canonicalItem of canonical) {
        const baselineItem = baselineById.get(canonicalItem.id);
        const targetItem = targetById.get(canonicalItem.id);
        if (!baselineItem) {


            merged.push(canonicalItem);
            continue;
        }
        if (!targetItem) {

            if (!sameEntitySnapshot(baselineItem, canonicalItem)) merged.push(canonicalItem);
            continue;
        }
        merged.push(applyJsonDelta(baselineItem, targetItem, canonicalItem));
    }

    for (const targetItem of target) {
        if (canonicalIds.has(targetItem.id)) continue;


        if (!baselineById.has(targetItem.id)) merged.push(targetItem);
    }
    return merged;
};


const applyJsonDelta = (baseline: unknown, target: unknown, canonical: unknown): unknown => {
    if (sameEntitySnapshot(baseline, target)) return canonical;
    if (sameEntitySnapshot(baseline, canonical)) return target;
    if (sameEntitySnapshot(target, canonical)) return canonical;

    if (Array.isArray(baseline) && Array.isArray(target) && Array.isArray(canonical)) {
        if (
            isStableIdRecordArray(baseline)
            && isStableIdRecordArray(target)
            && isStableIdRecordArray(canonical)
        ) {
            return mergeStableIdArray(baseline, target, canonical);
        }
        return canonical;
    }
    if (!isPlainObject(baseline) || !isPlainObject(target) || !isPlainObject(canonical)) {
        return canonical;
    }

    const rebased: Record<string, unknown> = { ...canonical };
    const keys = new Set([...Object.keys(baseline), ...Object.keys(target)]);
    for (const key of keys) {
        const baselineHasKey = hasOwn(baseline, key);
        const targetHasKey = hasOwn(target, key);
        const rebasedValue = applyJsonDelta(
            baselineHasKey ? baseline[key] : undefined,
            targetHasKey ? target[key] : undefined,
            hasOwn(canonical, key) ? canonical[key] : undefined,
        );
        if (rebasedValue === undefined) delete rebased[key];
        else rebased[key] = rebasedValue;
    }
    return rebased;
};

export const rebaseQueuedSettings = (
    queueRoot: AppData['settings'],
    queuedTarget: AppData['settings'],
    canonical: AppData['settings'],
): AppData['settings'] => (
    applyJsonDelta(queueRoot ?? {}, queuedTarget ?? {}, canonical ?? {}) as AppData['settings']
);
