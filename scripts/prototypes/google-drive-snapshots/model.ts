import { sanitizeAppDataForRemote } from '../../../packages/core/src/sync-helpers';
import { validateMergedSyncData, validateSyncPayloadShape } from '../../../packages/core/src/sync-normalization';
import { mergeAppData } from '../../../packages/core/src/sync';
import { TASK_STATUS_VALUES } from '../../../packages/core/src/task-status';
import type { AppData } from '../../../packages/core/src/types';

const MAX_SNAPSHOT_FILES = 128;
const MAX_PARENTS_PER_SNAPSHOT = 128;
const compareIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export type Snapshot = {
    format: 'mindwtr-drive-snapshot-prototype';
    version: 1;
    id: string;
    namespace: string;
    parents: string[];
    data: AppData;
};

type SnapshotGraph = {
    snapshots: Snapshot[];
    heads: Snapshot[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

function assertIdentifier(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
}

const assertNowIso = (nowIso: string): void => {
    assertIdentifier(nowIso, 'nowIso');
    if (!Number.isFinite(Date.parse(nowIso))) {
        throw new Error('nowIso must be a valid ISO timestamp');
    }
};

const assertNoDuplicateEntityIds = (data: AppData, label: string): void => {
    const collections: Array<[string, unknown[]]> = [
        ['tasks', data.tasks],
        ['projects', data.projects],
        ['sections', data.sections],
        ['areas', data.areas],
        ['people', data.people ?? []],
    ];

    for (const [collectionName, entities] of collections) {
        const ids = new Set<string>();
        for (const entity of entities) {
            if (!isRecord(entity)) {
                throw new Error(`${label}.${collectionName} contains a non-object entity`);
            }
            assertIdentifier(entity.id, `${label}.${collectionName} entity id`);
            if (ids.has(entity.id)) {
                throw new Error(`${label}.${collectionName} contains duplicate id ${entity.id}`);
            }
            ids.add(entity.id);
        }
    }
};

const assertNoAttachments = (data: AppData, label: string): void => {
    for (const [collectionName, entities] of [
        ['tasks', data.tasks],
        ['projects', data.projects],
    ] as const) {
        for (const entity of entities) {
            if (Object.prototype.hasOwnProperty.call(entity, 'attachments') && entity.attachments !== undefined) {
                throw new Error(`${label}.${collectionName} attachments are not supported by this prototype`);
            }
        }
    }

    if (
        Object.prototype.hasOwnProperty.call(data.settings, 'attachments')
        && data.settings.attachments !== undefined
    ) {
        throw new Error(`${label}.settings attachments are not supported by this prototype`);
    }
};

const assertRequiredEntityFields = (data: AppData, label: string): void => {
    const assertTimestamp = (value: unknown, fieldLabel: string): void => {
        assertIdentifier(value, fieldLabel);
        if (!Number.isFinite(Date.parse(value))) throw new Error(`${fieldLabel} must be a valid ISO timestamp`);
    };
    const assertOptionalTimestamp = (value: unknown, fieldLabel: string): void => {
        if (value === undefined || value === null) return;
        assertTimestamp(value, fieldLabel);
    };

    data.tasks.forEach((entity, index) => {
        assertIdentifier(entity.title, `${label}.tasks[${index}].title`);
        if (!(TASK_STATUS_VALUES as readonly string[]).includes(entity.status)) {
            throw new Error(`${label}.tasks[${index}].status is invalid`);
        }
        assertTimestamp(entity.createdAt, `${label}.tasks[${index}].createdAt`);
        assertTimestamp(entity.updatedAt, `${label}.tasks[${index}].updatedAt`);
        assertOptionalTimestamp(entity.deletedAt, `${label}.tasks[${index}].deletedAt`);
        assertOptionalTimestamp(entity.purgedAt, `${label}.tasks[${index}].purgedAt`);
    });
    data.projects.forEach((entity, index) => {
        assertIdentifier(entity.title, `${label}.projects[${index}].title`);
        if (!['active', 'someday', 'waiting', 'archived'].includes(entity.status)) {
            throw new Error(`${label}.projects[${index}].status is invalid`);
        }
        assertTimestamp(entity.createdAt, `${label}.projects[${index}].createdAt`);
        assertTimestamp(entity.updatedAt, `${label}.projects[${index}].updatedAt`);
        assertOptionalTimestamp(entity.deletedAt, `${label}.projects[${index}].deletedAt`);
        assertOptionalTimestamp(entity.purgedAt, `${label}.projects[${index}].purgedAt`);
    });
    data.sections.forEach((entity, index) => {
        assertIdentifier(entity.projectId, `${label}.sections[${index}].projectId`);
        assertIdentifier(entity.title, `${label}.sections[${index}].title`);
        assertTimestamp(entity.createdAt, `${label}.sections[${index}].createdAt`);
        assertTimestamp(entity.updatedAt, `${label}.sections[${index}].updatedAt`);
        assertOptionalTimestamp(entity.deletedAt, `${label}.sections[${index}].deletedAt`);
    });
};

const assertAppData = (value: unknown, label: string): AppData => {
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    for (const collectionName of ['tasks', 'projects', 'sections', 'areas'] as const) {
        if (!Array.isArray(value[collectionName])) {
            throw new Error(`${label}.${collectionName} must be an array`);
        }
    }
    if (value.people !== undefined && !Array.isArray(value.people)) {
        throw new Error(`${label}.people must be an array when present`);
    }
    if (!isRecord(value.settings)) throw new Error(`${label}.settings must be an object`);

    const shapeErrors = validateSyncPayloadShape(value, 'remote');
    if (shapeErrors.length > 0) throw new Error(`${label}: ${shapeErrors.join('; ')}`);
    const data = value as unknown as AppData;
    const validationErrors = validateMergedSyncData(data);
    if (validationErrors.length > 0) throw new Error(`${label}: ${validationErrors.join('; ')}`);
    assertRequiredEntityFields(data, label);
    assertNoDuplicateEntityIds(data, label);
    assertNoAttachments(data, label);
    return data;
};

const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!isRecord(value)) return value;

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const normalizeData = (data: AppData, nowIso: string): AppData => {
    const left = structuredClone(data);
    const right = structuredClone(data);
    return sanitizeAppDataForRemote(mergeAppData(left, right, { nowIso }));
};

const sortedEntityData = (data: AppData): AppData => {
    const byId = <T extends { id: string }>(left: T, right: T): number => compareIds(left.id, right.id);
    return {
        ...data,
        tasks: [...data.tasks].sort(byId),
        projects: [...data.projects].sort(byId),
        sections: [...data.sections].sort(byId),
        areas: [...data.areas].sort(byId),
        people: data.people === undefined ? undefined : [...data.people].sort(byId),
    };
};

const dataSignature = (data: AppData): string => canonicalJson(sortedEntityData(data));

const validateGraph = (snapshots: Snapshot[], namespace: string, nowIso: string): SnapshotGraph => {
    if (!Array.isArray(snapshots)) throw new Error('snapshots must be an array');
    assertIdentifier(namespace, 'namespace');
    if (snapshots.length > MAX_SNAPSHOT_FILES) {
        throw new Error(`snapshot history exceeds ${MAX_SNAPSHOT_FILES} files`);
    }

    const snapshotsById = new Map<string, Snapshot>();
    const serializedById = new Map<string, string>();

    for (const [index, candidate] of snapshots.entries()) {
        const label = `snapshot[${index}]`;
        if (!isRecord(candidate)) throw new Error(`${label} must be an object`);
        if (candidate.format !== 'mindwtr-drive-snapshot-prototype') {
            throw new Error(`${label} has an unsupported format`);
        }
        if (candidate.version !== 1) throw new Error(`${label} has an unsupported version`);
        assertIdentifier(candidate.id, `${label}.id`);
        assertIdentifier(candidate.namespace, `${label}.namespace`);
        if (candidate.namespace !== namespace) throw new Error(`${label} has the wrong namespace`);
        if (!Array.isArray(candidate.parents)) throw new Error(`${label}.parents must be an array`);
        if (candidate.parents.length > MAX_PARENTS_PER_SNAPSHOT) {
            throw new Error(`${label} exceeds ${MAX_PARENTS_PER_SNAPSHOT} parents`);
        }

        const parentIds = new Set<string>();
        for (const [parentIndex, parent] of candidate.parents.entries()) {
            assertIdentifier(parent, `${label}.parents[${parentIndex}]`);
            if (parentIds.has(parent)) throw new Error(`${label} contains duplicate parent ${parent}`);
            parentIds.add(parent);
        }

        assertAppData(candidate.data, `${label}.data`);
        const snapshot = candidate as unknown as Snapshot;
        const serialized = canonicalJson(snapshot);
        const previousSerialized = serializedById.get(snapshot.id);
        if (previousSerialized !== undefined) {
            if (previousSerialized !== serialized) {
                throw new Error(`duplicate snapshot id ${snapshot.id} has mismatched content`);
            }
            continue;
        }
        serializedById.set(snapshot.id, serialized);
        snapshotsById.set(snapshot.id, snapshot);
    }

    for (const snapshot of snapshotsById.values()) {
        for (const parentId of snapshot.parents) {
            if (!snapshotsById.has(parentId)) {
                throw new Error(`snapshot ${snapshot.id} is missing parent ${parentId}`);
            }
        }
    }

    const visitState = new Map<string, 'visiting' | 'visited'>();
    const visit = (id: string): void => {
        const state = visitState.get(id);
        if (state === 'visiting') throw new Error(`snapshot graph contains a cycle at ${id}`);
        if (state === 'visited') return;
        visitState.set(id, 'visiting');
        for (const parentId of snapshotsById.get(id)?.parents ?? []) visit(parentId);
        visitState.set(id, 'visited');
    };
    for (const id of snapshotsById.keys()) visit(id);

    for (const child of snapshotsById.values()) {
        const normalizedChild = normalizeData(child.data, nowIso);
        const childSignature = dataSignature(normalizedChild);
        for (const parentId of [...child.parents].sort(compareIds)) {
            const parent = snapshotsById.get(parentId)!;
            const normalizedParent = normalizeData(parent.data, nowIso);
            const childWithParent = normalizeData(
                mergeAppData(structuredClone(normalizedChild), normalizedParent, { nowIso }),
                nowIso,
            );
            if (dataSignature(childWithParent) !== childSignature) {
                throw new Error(`snapshot ${child.id} does not cover parent ${parentId}`);
            }
        }
    }

    const parentIds = new Set<string>();
    for (const snapshot of snapshotsById.values()) {
        for (const parentId of snapshot.parents) parentIds.add(parentId);
    }
    const uniqueSnapshots = [...snapshotsById.values()];
    const heads = uniqueSnapshots
        .filter((snapshot) => !parentIds.has(snapshot.id))
        .sort((left, right) => compareIds(left.id, right.id));
    return { snapshots: uniqueSnapshots, heads };
};

const resolveGraphData = (graph: SnapshotGraph, nowIso: string): AppData | null => {
    if (graph.heads.length === 0) return null;
    let merged = structuredClone(graph.heads[0]!.data);
    for (const head of graph.heads.slice(1)) {
        merged = mergeAppData(merged, structuredClone(head.data), { nowIso });
    }
    return normalizeData(merged, nowIso);
};

export const resolveSnapshots = (
    snapshots: Snapshot[],
    namespace: string,
    nowIso: string,
): { heads: string[]; data: AppData | null } => {
    assertNowIso(nowIso);
    const graph = validateGraph(snapshots, namespace, nowIso);
    return {
        heads: graph.heads.map((head) => head.id),
        data: resolveGraphData(graph, nowIso),
    };
};

export const prepareSnapshot = (
    id: string,
    namespace: string,
    local: AppData,
    snapshots: Snapshot[],
    nowIso: string,
): Snapshot | null => {
    assertIdentifier(id, 'id');
    assertNowIso(nowIso);
    const graph = validateGraph(snapshots, namespace, nowIso);
    const validLocal = assertAppData(local, 'local');
    const resolved = resolveGraphData(graph, nowIso);
    const merged = resolved === null
        ? normalizeData(validLocal, nowIso)
        : normalizeData(mergeAppData(structuredClone(validLocal), resolved, { nowIso }), nowIso);

    if (graph.heads.length === 1 && resolved !== null && dataSignature(resolved) === dataSignature(merged)) {
        return null;
    }
    if (graph.snapshots.length >= MAX_SNAPSHOT_FILES) {
        throw new Error(`publishing would exceed ${MAX_SNAPSHOT_FILES} snapshot files`);
    }
    if (graph.snapshots.some((snapshot) => snapshot.id === id)) {
        throw new Error(`snapshot id ${id} already exists`);
    }

    return {
        format: 'mindwtr-drive-snapshot-prototype',
        version: 1,
        id,
        namespace,
        parents: graph.heads.map((head) => head.id),
        data: merged,
    };
};
