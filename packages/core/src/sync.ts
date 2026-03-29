import type { AppData, Attachment, Area, Project, Task } from './types';
import { logWarn } from './logger';
import {
    type ConflictReason,
    type EntityMergeStats,
    type MergeResult,
    type SyncCycleIO,
    type SyncCycleResult,
    type SyncHistoryEntry,
    CLOCK_SKEW_THRESHOLD_MS,
} from './sync-types';
import {
    isValidTimestamp,
    normalizeAppData,
    normalizeProjectForSyncMerge,
    normalizeRevisionMetadata,
    normalizeTaskForSyncMerge,
    validateMergedSyncData,
    validateSyncPayloadShape,
} from './sync-normalization';
import { mergeSettingsForSync } from './sync-merge-settings';
import {
    chooseDeterministicWinner,
    collectComparableDiffKeys,
    hashComparableSignature,
    normalizeProjectForContentComparison,
    normalizeSectionForContentComparison,
    normalizeTaskForContentComparison,
    toComparableSignature,
    toComparableValue,
} from './sync-signatures';
import { purgeExpiredTombstones } from './sync-tombstones';

export type {
    ConflictReason,
    EntityMergeStats,
    MergeConflictSample,
    MergeResult,
    MergeStats,
    SyncCycleIO,
    SyncCycleResult,
    SyncHistoryEntry,
    SyncStep,
} from './sync-types';
export { CLOCK_SKEW_THRESHOLD_MS } from './sync-types';
export { normalizeAppData } from './sync-normalization';
export { purgeExpiredTombstones } from './sync-tombstones';

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
        conflictReasonCounts: {},
        conflictSamples: [],
    };
}

const CONFLICT_SAMPLE_LIMIT = 5;
const CONFLICT_DIFF_KEY_LIMIT = 8;
const DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS = 5 * 1000;

type ComparisonNormalizer<T> = (item: T) => unknown;

type MergeTimestampInfo = {
    raw: number;
    safe: number;
    wasClamped: boolean;
};

const parseMergeTimestamp = (value: unknown, maxAllowedMs?: number): MergeTimestampInfo => {
    if (typeof value !== 'string') {
        return { raw: -1, safe: -1, wasClamped: false };
    }
    const parsed = new Date(value).getTime();
    if (!Number.isFinite(parsed)) {
        return { raw: -1, safe: -1, wasClamped: false };
    }
    if (maxAllowedMs !== undefined && parsed > maxAllowedMs) {
        return { raw: parsed, safe: maxAllowedMs, wasClamped: true };
    }
    return { raw: parsed, safe: parsed, wasClamped: false };
};

const getMergeTimestampComparison = (
    localTime: MergeTimestampInfo,
    incomingTime: MergeTimestampInfo,
): number => {
    const safeDiff = incomingTime.safe - localTime.safe;
    if (safeDiff !== 0) return safeDiff;
    if (
        localTime.wasClamped
        && incomingTime.wasClamped
        && incomingTime.raw !== localTime.raw
    ) {
        return incomingTime.raw - localTime.raw;
    }
    return 0;
};

const containsAttachmentTraversalSegment = (value: string): boolean => {
    const candidates = new Set<string>([value]);
    let current = value;
    for (let depth = 0; depth < 8; depth += 1) {
        try {
            const decoded = decodeURIComponent(current);
            if (decoded === current) break;
            candidates.add(decoded);
            current = decoded;
        } catch {
            break;
        }
    }
    return Array.from(candidates).some((candidate) => /(^|[\\/])\.\.([\\/]|$)/.test(candidate));
};

const sanitizeMergedAttachmentUri = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('\0')) return undefined;
    if (containsAttachmentTraversalSegment(trimmed)) return undefined;
    return trimmed;
};

type MergeableEntity = {
    id: string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
    rev?: number;
    revBy?: string;
};

function mergeEntitiesWithStats<T extends MergeableEntity>(
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
    const maxAllowedMergeTime = Date.now();
    const normalizeTimestamps = (item: T): T => {
        if (!item.createdAt) return item;
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
        return { ...item, createdAt: item.updatedAt };
    };

    for (const id of allIds) {
        const localItem = localMap.get(id);
        const incomingItem = incomingMap.get(id);

        if (localItem === undefined && incomingItem === undefined) {
            continue;
        }

        if (incomingItem === undefined) {
            if (localItem === undefined) continue;
            stats.localOnly += 1;
            stats.resolvedUsingLocal += 1;
            merged.push(normalizeTimestamps(localItem));
            continue;
        }

        if (localItem === undefined) {
            stats.incomingOnly += 1;
            stats.resolvedUsingIncoming += 1;
            merged.push(normalizeTimestamps(incomingItem));
            continue;
        }

        const normalizedLocalItem = normalizeTimestamps(localItem);
        const normalizedIncomingItem = normalizeTimestamps(incomingItem);
        const localUpdatedTime = parseMergeTimestamp(normalizedLocalItem.updatedAt, maxAllowedMergeTime);
        const incomingUpdatedTime = parseMergeTimestamp(normalizedIncomingItem.updatedAt, maxAllowedMergeTime);
        const safeLocalTime = localUpdatedTime.safe;
        const safeIncomingTime = incomingUpdatedTime.safe;
        const comparableUpdatedTimeDiff = getMergeTimestampComparison(localUpdatedTime, incomingUpdatedTime);
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
        const localComparableSignature = toComparableSignature(comparableLocalItem);
        const incomingComparableSignature = toComparableSignature(comparableIncomingItem);
        const comparableContentMatches = localComparableSignature === incomingComparableSignature;
        const revisionOnlyDrift = hasRevision
            && revDiff !== 0
            && localDeleted === incomingDeleted
            && comparableContentMatches;
        const shouldCheckContentDiff = hasRevision
            ? revDiff === 0 && localDeleted === incomingDeleted
            : localDeleted === incomingDeleted;
        const contentDiff = shouldCheckContentDiff ? !comparableContentMatches : false;
        const meaningfulRevisionDiff = hasRevision && revDiff !== 0 && !revisionOnlyDrift;
        const conflictReasons: ConflictReason[] = [];
        if (localDeleted !== incomingDeleted) conflictReasons.push('deleteState');
        if (meaningfulRevisionDiff) conflictReasons.push('revision');
        if (contentDiff) conflictReasons.push('content');

        const differs = hasRevision
            ? meaningfulRevisionDiff || localDeleted !== incomingDeleted || contentDiff
            : localDeleted !== incomingDeleted || contentDiff;

        if (differs) {
            stats.conflicts += 1;
            if (stats.conflictIds.length < 20) stats.conflictIds.push(id);
            for (const reason of conflictReasons) {
                stats.conflictReasonCounts = stats.conflictReasonCounts ?? {};
                stats.conflictReasonCounts[reason] = (stats.conflictReasonCounts[reason] || 0) + 1;
            }
        }

        const safeTimeDiff = safeIncomingTime - safeLocalTime;
        const absoluteSkew = Math.abs(safeTimeDiff);
        if (absoluteSkew > stats.maxClockSkewMs) {
            stats.maxClockSkewMs = absoluteSkew;
        }
        const withinSkew = Math.abs(safeTimeDiff) <= CLOCK_SKEW_THRESHOLD_MS;
        const resolveOperationTime = (item: T): number => {
            const updatedTime = parseMergeTimestamp(item.updatedAt, maxAllowedMergeTime).safe;
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
        let winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
        const resolveDeleteVsLiveWinner = (localCandidate: T, incomingCandidate: T): T => {
            const localOpTime = resolveOperationTime(localCandidate);
            const incomingOpTime = resolveOperationTime(incomingCandidate);
            const operationDiff = incomingOpTime - localOpTime;
            if (Math.abs(operationDiff) <= DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS) {
                if (hasRevision) {
                    if (revDiff !== 0) {
                        return revDiff > 0 ? normalizedLocalItem : normalizedIncomingItem;
                    }
                    if (comparableUpdatedTimeDiff !== 0) {
                        return comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
                    }
                    if (revByDiff && localRevBy && incomingRevBy) {
                        return incomingRevBy > localRevBy ? normalizedIncomingItem : normalizedLocalItem;
                    }
                    return chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem);
                }
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
            } else if (comparableUpdatedTimeDiff !== 0) {
                winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
            } else if (revByDiff && localRevBy && incomingRevBy) {
                winner = incomingRevBy > localRevBy ? normalizedIncomingItem : normalizedLocalItem;
            } else {
                winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem);
            }
        } else if (localDeleted !== incomingDeleted) {
            winner = resolveDeleteVsLiveWinner(normalizedLocalItem, normalizedIncomingItem);
        } else if (withinSkew && comparableUpdatedTimeDiff === 0) {
            winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem);
        }
        if (winner === normalizedIncomingItem) stats.resolvedUsingIncoming += 1;
        else stats.resolvedUsingLocal += 1;

        if (winner.deletedAt && (!normalizedLocalItem.deletedAt || !normalizedIncomingItem.deletedAt || differs)) {
            stats.deletionsWon += 1;
        }

        if (differs && (stats.conflictSamples?.length || 0) < CONFLICT_SAMPLE_LIMIT) {
            const comparableLocalValue = contentDiff ? toComparableValue(comparableLocalItem) : undefined;
            const comparableIncomingValue = contentDiff ? toComparableValue(comparableIncomingItem) : undefined;
            const diffKeys = contentDiff && comparableLocalValue !== undefined && comparableIncomingValue !== undefined
                ? collectComparableDiffKeys(comparableLocalValue, comparableIncomingValue, CONFLICT_DIFF_KEY_LIMIT)
                : [];
            stats.conflictSamples = stats.conflictSamples ?? [];
            stats.conflictSamples.push({
                id,
                winner: winner === normalizedIncomingItem ? 'incoming' : 'local',
                reasons: conflictReasons,
                hasRevision,
                timeDiffMs: Number.isFinite(safeIncomingTime) && Number.isFinite(safeLocalTime)
                    ? safeIncomingTime - safeLocalTime
                    : 0,
                localUpdatedAt: normalizedLocalItem.updatedAt,
                incomingUpdatedAt: normalizedIncomingItem.updatedAt,
                localDeletedAt: normalizedLocalItem.deletedAt,
                incomingDeletedAt: normalizedIncomingItem.deletedAt,
                localRev,
                incomingRev,
                localRevBy: localRevBy || undefined,
                incomingRevBy: incomingRevBy || undefined,
                localComparableHash: hashComparableSignature(localComparableSignature),
                incomingComparableHash: hashComparableSignature(incomingComparableSignature),
                diffKeys,
            });
        }

        const mergedItem = mergeConflict ? mergeConflict(normalizedLocalItem, normalizedIncomingItem, winner) : winner;
        merged.push(normalizeTimestamps(mergedItem));
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

export function filterDeleted<T extends { deletedAt?: string }>(items: T[]): T[] {
    return items.filter((item) => !item.deletedAt);
}

export function mergeAppDataWithStats(local: AppData, incoming: AppData): MergeResult {
    const nowIso = new Date().toISOString();
    const localNormalized: AppData = {
        ...local,
        tasks: (local.tasks || []).map((task) => normalizeRevisionMetadata(normalizeTaskForSyncMerge(task, nowIso))),
        projects: (local.projects || []).map((project) => normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))),
        sections: (local.sections || []).map((section) => normalizeRevisionMetadata(section)),
        areas: (local.areas || []).map((area) => normalizeRevisionMetadata(area)),
    };
    const incomingNormalized: AppData = {
        ...incoming,
        tasks: (incoming.tasks || []).map((task) => normalizeRevisionMetadata(normalizeTaskForSyncMerge(task, nowIso))),
        projects: (incoming.projects || []).map((project) => normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))),
        sections: (incoming.sections || []).map((section) => normalizeRevisionMetadata(section)),
        areas: (incoming.areas || []).map((area) => normalizeRevisionMetadata(area)),
    };

    const mergeAttachments = (localAttachments?: Attachment[], incomingAttachments?: Attachment[]): Attachment[] | undefined => {
        const hadExplicitAttachments = localAttachments !== undefined || incomingAttachments !== undefined;
        const localList = localAttachments || [];
        const incomingList = incomingAttachments || [];
        if (localList.length === 0 && incomingList.length === 0) {
            return hadExplicitAttachments ? [] : undefined;
        }
        const localById = new Map(localList.map((item) => [item.id, item]));
        const incomingById = new Map(incomingList.map((item) => [item.id, item]));
        const normalizeMissingFileStatus = (
            status: Attachment['localStatus'],
            deletedAt?: string
        ): Attachment['localStatus'] | undefined => {
            if (deletedAt) return status;
            if (status === 'uploading' || status === 'downloading') return status;
            return 'missing';
        };
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
                uri = '';
                localStatus = normalizeMissingFileStatus(localStatus, winner.deletedAt);
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
                localStatus: attachment.deletedAt
                    ? attachment.localStatus
                    : uriAvailable
                        ? attachment.localStatus ?? 'available'
                        : normalizeMissingFileStatus(attachment.localStatus, attachment.deletedAt),
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
        const recoveredLocalData = clearPendingRemoteWriteFlag(localData);
        io.onStep?.('write-remote');
        await yieldToUi();
        await io.writeRemote(recoveredLocalData);
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
    const remoteNormalized = normalizeAppData(
        remoteDataRaw || { tasks: [], projects: [], sections: [], areas: [], settings: {} }
    );
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
    const persistedFinalData = clearPendingRemoteWriteFlag(finalDataWithPendingRemoteWrite);
    io.onStep?.('write-local');
    await yieldToUi();
    await io.writeLocal(finalDataWithPendingRemoteWrite);

    io.onStep?.('write-remote');
    await yieldToUi();
    await io.writeRemote(persistedFinalData);

    if (persistedFinalData !== finalDataWithPendingRemoteWrite) {
        await yieldToUi();
        await io.writeLocal(persistedFinalData);
    }

    return { data: persistedFinalData, stats: mergeResult.stats, status: nextSyncStatus };
}
