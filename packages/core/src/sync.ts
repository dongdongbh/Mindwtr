import type { AppData, Attachment, Area, Person, Project, Section, Task } from './types';
import { logInfo, logWarn } from './logger';
import {
    PREPARED_UNCHANGED,
    type ClockSkewWarning,
    type ConflictReason,
    type EntityMergeStats,
    type MergeResult,
    type MergeStats,
    type SyncCycleIO,
    type SyncCycleResult,
    type SyncHistoryEntry,
    CLOCK_SKEW_THRESHOLD_MS,
    DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS,
    SYNC_REPAIR_REV_BY,
} from './sync-types';
import {
    isValidTimestamp,
    type SyncMergeArea,
    normalizeAreaForSyncMerge,
    normalizePersonForSyncMerge,
    normalizeProjectForSyncMerge,
    repairMergedSyncReferences,
    normalizeRevisionMetadata,
    normalizeSectionForSyncMerge,
    normalizeTaskForSyncMerge,
    validateMergedSyncDataPass,
} from './sync-normalization';
import { parseSyncDocument } from './sync-document';
import { traceSection } from './perf-trace';
import { mapPass, runSliced, runToEnd, SLICE_ITEMS, type CooperativePass } from './cooperative';
import { mergeSettingsForSync } from './sync-merge-settings';
import {
    chooseDeterministicWinner,
    collectComparableDiffKeys,
    hashComparableSignature,
    normalizeAreaForContentComparison,
    normalizePersonForContentComparison,
    normalizeProjectForContentComparison,
    normalizeSectionForContentComparison,
    normalizeTaskForContentComparison,
    getMergeComparableSignature,
    toComparableValue,
} from './sync-signatures';
import { purgeExpiredTombstones } from './sync-tombstones';
import { nextRevision, SYNC_BACKUP_RESTORE_REV_BY } from './sync-revision';
import { normalizeRecurrenceForLoad, parseRRuleString } from './recurrence';
import { summarizeMergeStats } from './sync-log-utils';
import { executeSyncCycle } from './sync-cycle';
import {
    compactAttachmentCleanupMetadata,
    compactSectionsForPurgedProjects,
} from './tombstone-compaction';
import { hasValidArchiveClock } from './archive-retention';

export type {
    ClockSkewDirection,
    ClockSkewWarning,
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
export { CLOCK_SKEW_THRESHOLD_MS, DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS, SYNC_REPAIR_REV_BY } from './sync-types';
export { normalizeAppData } from './sync-normalization';
export { DEFAULT_TOMBSTONE_RETENTION_DAYS, purgeExpiredTombstones } from './sync-tombstones';
export { createSyncCycleExecutor, executeSyncCycle } from './sync-cycle';
export type { SyncCycleExecutor, SyncCycleOperation } from './sync-cycle';

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

const buildSyncHistoryDetails = (stats: MergeStats): string | undefined => {
    const summary = summarizeMergeStats(stats);
    const details: string[] = [];
    if (summary.deleteVsLiveConflicts > 0) {
        const itemLabel = summary.deleteVsLiveConflicts === 1 ? 'item' : 'items';
        details.push(`Delete-vs-live conflict on ${summary.deleteVsLiveConflicts} ${itemLabel}; live edits can be preserved when delete and edit times are ambiguous.`);
    }
    if (summary.futureTimestampClamps > 0) {
        const itemLabel = summary.futureTimestampClamps === 1 ? 'timestamp' : 'timestamps';
        details.push(`Future sync timestamp clamp on ${summary.futureTimestampClamps} ${itemLabel}; check device clocks if this repeats.`);
    }
    return details.length > 0 ? details.join(' ') : undefined;
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
        maxClockSkewDirection: undefined,
        invalidTimestamps: 0,
        timestampAdjustments: 0,
        timestampAdjustmentIds: [],
        futureTimestampClamps: 0,
        futureTimestampClampIds: [],
        conflictReasonCounts: {},
        conflictSamples: [],
    };
}


function createLocalOnlyMergeStats(data: AppData): MergeStats {
    const forCollection = (items?: readonly unknown[]): EntityMergeStats => {
        const stats = createEmptyEntityStats(items?.length ?? 0, 0);
        stats.mergedTotal = stats.localTotal;
        stats.localOnly = stats.localTotal;


        stats.resolvedUsingLocal = stats.localTotal;
        return stats;
    };
    return {
        tasks: forCollection(data.tasks),
        projects: forCollection(data.projects),
        sections: forCollection(data.sections),
        areas: forCollection(data.areas),
        people: forCollection(data.people),
        tombstoneRepairs: 0,
    };
}

const CONFLICT_SAMPLE_LIMIT = 5;
const CONFLICT_DIFF_KEY_LIMIT = 8;
const PENDING_REMOTE_WRITE_RETRY_BASE_MS = 5 * 1000;
const PENDING_REMOTE_WRITE_RETRY_MAX_MS = 5 * 60 * 1000;
const PENDING_REMOTE_WRITE_MAX_ATTEMPTS = 12;
const ATTACHMENT_URI_DECODE_LIMIT = 32;
const ATTACHMENT_TRAVERSAL_SEGMENT_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;
const ATTACHMENT_TRAVERSAL_SEGMENT_CACHE_LIMIT = 1024;

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
    if (maxAllowedMs !== undefined && parsed > maxAllowedMs + CLOCK_SKEW_THRESHOLD_MS) {
        return { raw: parsed, safe: maxAllowedMs, wasClamped: true };
    }
    return { raw: parsed, safe: parsed, wasClamped: false };
};

const attachmentTraversalSegmentSafetyCache = new Map<string, boolean>();

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
    const cached = attachmentTraversalSegmentSafetyCache.get(value);
    if (cached !== undefined) {
        return cached;
    }

    const candidates = new Set<string>([value]);
    const queue: string[] = [value];

    const enqueueCandidate = (candidate: string) => {
        if (!candidate || candidates.has(candidate)) return;
        candidates.add(candidate);
        queue.push(candidate);
    };

    for (let index = 0; index < queue.length && index < ATTACHMENT_URI_DECODE_LIMIT; index += 1) {
        const current = queue[index];
        try {
            const decoded = decodeURIComponent(current);
            if (decoded !== current) {
                enqueueCandidate(decoded);
            }
        } catch {

        }

        const trimmed = current.trim();
        if (trimmed.startsWith('//')) {
            try {
                enqueueCandidate(new URL(`file:${trimmed}`).pathname);
            } catch {

            }
            continue;
        }

        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
            try {
                enqueueCandidate(new URL(trimmed).pathname);
            } catch {

            }
        }
    }

    const hasTraversalSegment = Array.from(candidates).some((candidate) => ATTACHMENT_TRAVERSAL_SEGMENT_PATTERN.test(candidate));
    if (attachmentTraversalSegmentSafetyCache.size >= ATTACHMENT_TRAVERSAL_SEGMENT_CACHE_LIMIT) {
        attachmentTraversalSegmentSafetyCache.clear();
    }
    attachmentTraversalSegmentSafetyCache.set(value, hasTraversalSegment);
    return hasTraversalSegment;
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

type MergeAppDataOptions = {
    nowIso?: string;
    preferIncomingAttachmentCloudKeys?: boolean;


    preferIncomingAttachmentCloudKeyIds?: ReadonlySet<string>;
};

const getRecurrenceSeriesShape = (value: Task['recurrence']): string | null => {
    const normalized = normalizeRecurrenceForLoad(value);
    if (!normalized) return null;
    const { seriesId: _seriesId, rrule, ...shape } = normalized;
    const parsed = rrule ? parseRRuleString(rrule) : undefined;
    return JSON.stringify({
        ...shape,
        interval: parsed?.interval,
        bySetPos: parsed?.bySetPos,
    });
};

const repairTaskRecurrenceSeriesIdentity = (
    localTask: Task,
    incomingTask: Task,
    winner: Task,
): Task => {
    const localRecurrence = normalizeRecurrenceForLoad(localTask.recurrence);
    const incomingRecurrence = normalizeRecurrenceForLoad(incomingTask.recurrence);
    const localSeriesId = localRecurrence?.seriesId;
    const incomingSeriesId = incomingRecurrence?.seriesId;
    if (Boolean(localSeriesId) === Boolean(incomingSeriesId)) return winner;
    const sameSeriesShape = getRecurrenceSeriesShape(localRecurrence) === getRecurrenceSeriesShape(incomingRecurrence);
    if (!sameSeriesShape) {
        const identifiedTask = localSeriesId ? localTask : incomingTask;
        const legacyTask = localSeriesId ? incomingTask : localTask;


        if ((legacyTask.rev ?? 0) !== (identifiedTask.rev ?? 0) + 1) return winner;
        if (normalizeRecurrenceForLoad(winner.recurrence)?.seriesId) return winner;
    }

    const seriesId = localSeriesId ?? incomingSeriesId;
    const winnerRecurrence = normalizeRecurrenceForLoad(winner.recurrence);
    if (!seriesId || !winnerRecurrence) return winner;
    return {
        ...winner,
        recurrence: normalizeRecurrenceForLoad({ ...winnerRecurrence, seriesId }),
        rev: nextRevision(Math.max(localTask.rev ?? 0, incomingTask.rev ?? 0)),
        revBy: SYNC_REPAIR_REV_BY,
    };
};

const hasSamePersistedOperationIdentity = (left: MergeableEntity, right: MergeableEntity): boolean => (
    (left.rev ?? 0) === (right.rev ?? 0)
    && (left.revBy ?? '') === (right.revBy ?? '')
    && left.updatedAt === right.updatedAt
);


const preserveTaskCancellationFromStrippedPeer = (
    localTask: Task,
    incomingTask: Task,
    winner: Task,
): Task => {
    if (
        localTask.status !== 'archived'
        || incomingTask.status !== 'archived'
        || !hasSamePersistedOperationIdentity(localTask, incomingTask)
    ) return winner;
    const cancelledAt = localTask.cancelledAt || incomingTask.cancelledAt;
    if (!cancelledAt || (localTask.cancelledAt && incomingTask.cancelledAt)) return winner;
    if (winner.cancelledAt === cancelledAt && winner.completedAt === undefined) return winner;
    return { ...winner, cancelledAt, completedAt: undefined };
};

const preserveProjectCancellationFromStrippedPeer = (
    localProject: Project,
    incomingProject: Project,
    winner: Project,
): Project => {
    if (
        localProject.status !== 'archived'
        || incomingProject.status !== 'archived'
        || !hasSamePersistedOperationIdentity(localProject, incomingProject)
    ) return winner;
    const cancelledAt = localProject.cancelledAt || incomingProject.cancelledAt;
    if (!cancelledAt || (localProject.cancelledAt && incomingProject.cancelledAt)) return winner;
    return winner.cancelledAt === cancelledAt ? winner : { ...winner, cancelledAt };
};


const isArchiveClockTwin = <T,>(
    local: T,
    incoming: T,
    entityType: string,
    normalizeForComparison?: ComparisonNormalizer<T>,
): boolean => {
    if (entityType !== 'task') return false;
    const localTask = local as unknown as Task;
    const incomingTask = incoming as unknown as Task;
    if (localTask.status !== 'archived' || incomingTask.status !== 'archived') return false;
    if (!hasValidArchiveClock(localTask.archivedAt) || !hasValidArchiveClock(incomingTask.archivedAt)) return false;
    return getMergeComparableSignature({ ...local, archivedAt: undefined }, normalizeForComparison)
        === getMergeComparableSignature({ ...incoming, archivedAt: undefined }, normalizeForComparison);
};

function mergeEntitiesWithStats<T extends MergeableEntity>(
    local: T[],
    incoming: T[],
    mergeConflict?: (localItem: T, incomingItem: T, winner: T) => T,
    normalizeForComparison?: ComparisonNormalizer<T>,
    entityType: string = 'entity',
    nowIso?: string,
): { merged: T[]; stats: EntityMergeStats } {
    return runToEnd(mergeEntitiesPass(local, incoming, mergeConflict, normalizeForComparison, entityType, nowIso));
}


function* mergeEntitiesPass<T extends MergeableEntity>(
    local: T[],
    incoming: T[],
    mergeConflict?: (localItem: T, incomingItem: T, winner: T) => T,
    normalizeForComparison?: ComparisonNormalizer<T>,
    entityType: string = 'entity',
    nowIso?: string,
): CooperativePass<{ merged: T[]; stats: EntityMergeStats }> {
    const localMap = new Map<string, T>(local.map((item) => [item.id, item]));
    const incomingMap = new Map<string, T>(incoming.map((item) => [item.id, item]));
    const allIds = new Set<string>([...localMap.keys(), ...incomingMap.keys()]);

    const stats = createEmptyEntityStats(local.length, incoming.length);
    const merged: T[] = [];
    let invalidDeletedAtWarnings = 0;
    let ambiguousResurrectionWarnings = 0;
    let discardedLiveConflictWarnings = 0;
    let taskStatusResolutionWarnings = 0;
    let futureTimestampClampWarnings = 0;
    let archiveTwinMerges = 0;
    let strippedArchiveClockMerges = 0;
    const nowTime = nowIso ? new Date(nowIso).getTime() : NaN;
    const maxAllowedMergeTime = Number.isFinite(nowTime) ? nowTime : Date.now();
    const getStringField = (item: T, field: string): string | undefined => {
        const value = (item as Record<string, unknown>)[field];
        return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    };
    const recoverCreatedAtFromCounterpart = (item: T, counterpart?: T): string | undefined => {
        if (!counterpart?.createdAt) return undefined;
        const updatedTime = new Date(item.updatedAt).getTime();
        const counterpartCreatedTime = new Date(counterpart.createdAt).getTime();
        if (!Number.isFinite(updatedTime) || !Number.isFinite(counterpartCreatedTime)) return undefined;
        if (counterpartCreatedTime > updatedTime) return undefined;
        return counterpart.createdAt;
    };
    const normalizeTimestamps = (item: T, counterpart?: T): T => {
        if (!item.createdAt) return item;
        const createdTime = new Date(item.createdAt).getTime();
        const updatedTime = new Date(item.updatedAt).getTime();
        if (!Number.isFinite(createdTime) || !Number.isFinite(updatedTime)) return item;
        if (updatedTime >= createdTime) return item;
        const recoveredCreatedAt = recoverCreatedAtFromCounterpart(item, counterpart);
        const normalizedCreatedAt = recoveredCreatedAt ?? item.updatedAt;
        stats.timestampAdjustments += 1;
        if (item.id && stats.timestampAdjustmentIds.length < 20) {
            stats.timestampAdjustmentIds.push(item.id);
        }
        if (stats.timestampAdjustments <= 5) {
            logWarn('Normalized createdAt after updatedAt', {
                scope: 'sync',
                category: 'sync',
                context: {
                    id: item.id,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt,
                    normalizedCreatedAt,
                    counterpartCreatedAt: recoveredCreatedAt,
                },
            });
        }
        return { ...item, createdAt: normalizedCreatedAt };
    };

    let visited = 0;
    for (const id of allIds) {
        visited += 1;
        if (visited % SLICE_ITEMS === 0) yield;
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

        const normalizedLocalItem = normalizeTimestamps(localItem, incomingItem);
        const normalizedIncomingItem = normalizeTimestamps(incomingItem, localItem);
        const localUpdatedTime = parseMergeTimestamp(normalizedLocalItem.updatedAt, maxAllowedMergeTime);
        const incomingUpdatedTime = parseMergeTimestamp(normalizedIncomingItem.updatedAt, maxAllowedMergeTime);
        if (localUpdatedTime.wasClamped || incomingUpdatedTime.wasClamped) {
            stats.futureTimestampClamps += Number(localUpdatedTime.wasClamped) + Number(incomingUpdatedTime.wasClamped);
            if (stats.futureTimestampClampIds.length < 20) stats.futureTimestampClampIds.push(id);
            if (localUpdatedTime.wasClamped && incomingUpdatedTime.wasClamped) {
                futureTimestampClampWarnings += 1;
                if (futureTimestampClampWarnings <= 5) {
                    logWarn('Both merge candidates had future updatedAt timestamps clamped', {
                        scope: 'sync',
                        category: 'sync',
                        context: {
                            entityType,
                            id,
                            localUpdatedAt: normalizedLocalItem.updatedAt,
                            incomingUpdatedAt: normalizedIncomingItem.updatedAt,
                            clampTime: new Date(maxAllowedMergeTime).toISOString(),
                        },
                    });
                }
            }
        }
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
        const localComparableSignature = getMergeComparableSignature(normalizedLocalItem, normalizeForComparison);
        const incomingComparableSignature = getMergeComparableSignature(normalizedIncomingItem, normalizeForComparison);
        const comparableContentMatches = localComparableSignature === incomingComparableSignature;
        const shouldCheckContentDiff = hasRevision
            ? revDiff === 0 && localDeleted === incomingDeleted
            : localDeleted === incomingDeleted;
        let strippedArchiveClock: string | undefined;
        if (shouldCheckContentDiff && !comparableContentMatches && (entityType === 'task' || entityType === 'project')) {
            const localArchive = normalizedLocalItem as unknown as Task | Project;
            const incomingArchive = normalizedIncomingItem as unknown as Task | Project;

            if (hasValidArchiveClock(localArchive.archivedAt) !== hasValidArchiveClock(incomingArchive.archivedAt)
                && localArchive.rev === incomingArchive.rev && localArchive.revBy === incomingArchive.revBy
                && localArchive.updatedAt === incomingArchive.updatedAt
                && localArchive.status === incomingArchive.status
                && localArchive.deletedAt === incomingArchive.deletedAt
                && localArchive.purgedAt === incomingArchive.purgedAt
                && JSON.stringify(toComparableValue({ ...normalizedLocalItem, archivedAt: undefined }))
                    === JSON.stringify(toComparableValue({ ...normalizedIncomingItem, archivedAt: undefined }))) {
                strippedArchiveClock = hasValidArchiveClock(localArchive.archivedAt) ? localArchive.archivedAt : incomingArchive.archivedAt;
            }
        }

        const archiveTwin = shouldCheckContentDiff && !comparableContentMatches && !localDeleted
            && isArchiveClockTwin(normalizedLocalItem, normalizedIncomingItem, entityType, normalizeForComparison);
        const contentDiff = shouldCheckContentDiff ? !comparableContentMatches && !archiveTwin && !strippedArchiveClock : false;
        const unresolvedDeleteStateDiff = localDeleted !== incomingDeleted && (!hasRevision || revDiff === 0);
        const conflictReasons: ConflictReason[] = [];
        if (unresolvedDeleteStateDiff) conflictReasons.push('deleteState');
        if (contentDiff) conflictReasons.push('content');
        let deleteVsLiveOperationDiffMs: number | undefined;

        const differs = hasRevision
            ? unresolvedDeleteStateDiff || contentDiff
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
        if (differs && absoluteSkew > stats.maxClockSkewMs) {
            stats.maxClockSkewMs = absoluteSkew;
            stats.maxClockSkewDirection = safeTimeDiff >= 0 ? 'remote-ahead' : 'local-ahead';
        }
        const withinSkew = Math.abs(safeTimeDiff) <= CLOCK_SKEW_THRESHOLD_MS;
        const resolveOperationTime = (item: T, updatedTime: MergeTimestampInfo): number => {
            const safeUpdatedTime = updatedTime.safe;
            if (!item.deletedAt) return safeUpdatedTime;

            const deletedTimeRaw = new Date(item.deletedAt).getTime();
            if (!Number.isFinite(deletedTimeRaw)) {
                stats.invalidTimestamps += 1;
                invalidDeletedAtWarnings += 1;
                if (invalidDeletedAtWarnings <= 5) {
                    logWarn('Invalid deletedAt timestamp during merge; using updatedAt fallback', {
                        scope: 'sync',
                        category: 'sync',
                        context: { id: item.id, deletedAt: item.deletedAt, updatedAt: item.updatedAt, fallbackDeletedTime: safeUpdatedTime },
                    });
                }
                return safeUpdatedTime;
            }

            const safeDeletedTime = deletedTimeRaw > maxAllowedMergeTime + CLOCK_SKEW_THRESHOLD_MS ? maxAllowedMergeTime : deletedTimeRaw;
            return Math.max(safeUpdatedTime, safeDeletedTime);
        };
        let winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
        const preferDeletedCandidate = (left: T, right: T): T => {
            if (left.deletedAt && !right.deletedAt) return left;
            if (right.deletedAt && !left.deletedAt) return right;
            return chooseDeterministicWinner(left, right);
        };
        const preferLiveCandidate = (left: T, right: T): T => {
            if (left.deletedAt && !right.deletedAt) return right;
            if (right.deletedAt && !left.deletedAt) return left;
            return chooseDeterministicWinner(left, right);
        };
        const isBackupRestoreLiveCandidate = (item: T): boolean => (
            !item.deletedAt && item.revBy === SYNC_BACKUP_RESTORE_REV_BY
        );
        const resolveDeleteVsLiveWinner = (
            localCandidate: T,
            incomingCandidate: T,
        ): { winner: T; preservedLiveInAmbiguousWindow: boolean; operationDiffMs: number } => {
            const localOpTime = resolveOperationTime(localCandidate, localUpdatedTime);
            const incomingOpTime = resolveOperationTime(incomingCandidate, incomingUpdatedTime);
            const operationDiff = incomingOpTime - localOpTime;
            const restoreLiveCandidate = isBackupRestoreLiveCandidate(localCandidate)
                ? localCandidate
                : isBackupRestoreLiveCandidate(incomingCandidate)
                    ? incomingCandidate
                    : undefined;
            if (restoreLiveCandidate) {
                const restoreOpTime = restoreLiveCandidate === localCandidate ? localOpTime : incomingOpTime;
                const tombstoneOpTime = restoreLiveCandidate === localCandidate ? incomingOpTime : localOpTime;
                if (restoreOpTime >= tombstoneOpTime) {
                    return {
                        winner: restoreLiveCandidate,
                        preservedLiveInAmbiguousWindow: Math.abs(operationDiff) <= DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS,
                        operationDiffMs: operationDiff,
                    };
                }
            }
            if (Math.abs(operationDiff) <= DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS) {
                if (hasRevision && revDiff !== 0) {
                    const winner = revDiff > 0 ? normalizedLocalItem : normalizedIncomingItem;
                    return {
                        winner,
                        preservedLiveInAmbiguousWindow: !winner.deletedAt,
                        operationDiffMs: operationDiff,
                    };
                }
                const winner = hasRevision
                    ? preferLiveCandidate(localCandidate, incomingCandidate)
                    : preferDeletedCandidate(localCandidate, incomingCandidate);
                return {
                    winner,
                    preservedLiveInAmbiguousWindow: !winner.deletedAt,
                    operationDiffMs: operationDiff,
                };
            }
            if (operationDiff > 0) {
                return { winner: incomingCandidate, preservedLiveInAmbiguousWindow: false, operationDiffMs: operationDiff };
            }
            if (operationDiff < 0) {
                return { winner: localCandidate, preservedLiveInAmbiguousWindow: false, operationDiffMs: operationDiff };
            }
            return {
                winner: preferDeletedCandidate(localCandidate, incomingCandidate),
                preservedLiveInAmbiguousWindow: false,
                operationDiffMs: operationDiff,
            };
        };

        if (localDeleted !== incomingDeleted) {
            const resolution = resolveDeleteVsLiveWinner(normalizedLocalItem, normalizedIncomingItem);
            winner = resolution.winner;
            deleteVsLiveOperationDiffMs = resolution.operationDiffMs;
            if (resolution.preservedLiveInAmbiguousWindow) {
                ambiguousResurrectionWarnings += 1;
                if (ambiguousResurrectionWarnings <= 5) {
                    logWarn('Preserved live item during ambiguous delete-vs-live merge', {
                        scope: 'sync',
                        category: 'sync',
                        context: {
                            entityType,
                            id,
                            operationDiffMs: resolution.operationDiffMs,
                            localDeletedAt: normalizedLocalItem.deletedAt,
                            incomingDeletedAt: normalizedIncomingItem.deletedAt,
                            localUpdatedAt: normalizedLocalItem.updatedAt,
                            incomingUpdatedAt: normalizedIncomingItem.updatedAt,
                            localRev,
                            incomingRev,
                            localRevBy: localRevBy || undefined,
                            incomingRevBy: incomingRevBy || undefined,
                        },
                    });
                }
            }
        } else if (hasRevision) {
            if (revDiff !== 0) {
                winner = revDiff > 0 ? normalizedLocalItem : normalizedIncomingItem;
            } else if (comparableUpdatedTimeDiff !== 0) {
                winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;


            } else if (revByDiff && localRevBy && incomingRevBy) {
                winner = incomingRevBy > localRevBy ? normalizedIncomingItem : normalizedLocalItem;
            } else {
                winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem);
            }
        } else {
            const hasInvalidTimestamp = localUpdatedTime.raw < 0 || incomingUpdatedTime.raw < 0;
            const requiresStrictTimestampOrdering = comparableUpdatedTimeDiff !== 0
                && (hasInvalidTimestamp || localUpdatedTime.wasClamped || incomingUpdatedTime.wasClamped);
            if (requiresStrictTimestampOrdering) {
                winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
            } else if (withinSkew) {
                winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem);
            } else if (comparableUpdatedTimeDiff !== 0) {
                winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
            } else {
                winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem);
            }
        }
        if (winner === normalizedIncomingItem) stats.resolvedUsingIncoming += 1;
        else stats.resolvedUsingLocal += 1;

        if (entityType === 'task') {
            const localStatus = getStringField(normalizedLocalItem, 'status');
            const incomingStatus = getStringField(normalizedIncomingItem, 'status');
            if (localStatus && incomingStatus && localStatus !== incomingStatus) {
                taskStatusResolutionWarnings += 1;
                if (taskStatusResolutionWarnings <= 10) {
                    const winnerSide = winner === normalizedIncomingItem ? 'incoming' : 'local';
                    const resolutionReason = localDeleted !== incomingDeleted
                        ? 'deleteState'
                        : hasRevision && revDiff !== 0
                            ? 'revision'
                            : comparableUpdatedTimeDiff !== 0
                                ? 'timestamp'
                                : revByDiff && localRevBy && incomingRevBy
                                    ? 'revBy'
                                    : 'deterministic';
                    logWarn('syncTaskStatusResolution', {
                        scope: 'sync',
                        category: 'sync',
                        context: {
                            id,
                            winnerSide,
                            resolutionReason,
                            countedConflict: differs,
                            localStatus,
                            incomingStatus,
                            localCompletedAt: getStringField(normalizedLocalItem, 'completedAt'),
                            incomingCompletedAt: getStringField(normalizedIncomingItem, 'completedAt'),
                            localUpdatedAt: normalizedLocalItem.updatedAt,
                            incomingUpdatedAt: normalizedIncomingItem.updatedAt,
                            localRev,
                            incomingRev,
                            localRevBy: localRevBy || undefined,
                            incomingRevBy: incomingRevBy || undefined,
                        },
                    });
                }
            }
        }

        if (winner.deletedAt && (!normalizedLocalItem.deletedAt || !normalizedIncomingItem.deletedAt || differs)) {
            stats.deletionsWon += 1;
        }

        if (localDeleted !== incomingDeleted && winner.deletedAt) {
            discardedLiveConflictWarnings += 1;
            if (discardedLiveConflictWarnings <= 5) {
                logWarn('syncConflictDiscarded', {
                    scope: 'sync',
                    category: 'sync',
                    context: {
                        entityType,
                        id,
                        discardedSide: localDeleted ? 'incoming' : 'local',
                        winnerSide: winner === normalizedIncomingItem ? 'incoming' : 'local',
                        reason: 'deleteState',
                        operationDiffMs: deleteVsLiveOperationDiffMs,
                        localDeletedAt: normalizedLocalItem.deletedAt,
                        incomingDeletedAt: normalizedIncomingItem.deletedAt,
                        localUpdatedAt: normalizedLocalItem.updatedAt,
                        incomingUpdatedAt: normalizedIncomingItem.updatedAt,
                        localRev,
                        incomingRev,
                        localRevBy: localRevBy || undefined,
                        incomingRevBy: incomingRevBy || undefined,
                    },
                });
            }
        }

        if (differs && (stats.conflictSamples?.length || 0) < CONFLICT_SAMPLE_LIMIT) {


            const comparableLocalValue = contentDiff
                ? toComparableValue(normalizeForComparison ? normalizeForComparison(normalizedLocalItem) : normalizedLocalItem)
                : undefined;
            const comparableIncomingValue = contentDiff
                ? toComparableValue(normalizeForComparison ? normalizeForComparison(normalizedIncomingItem) : normalizedIncomingItem)
                : undefined;
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

        let mergedItem = mergeConflict ? mergeConflict(normalizedLocalItem, normalizedIncomingItem, winner) : winner;
        if (archiveTwin) {


            archiveTwinMerges += 1;
            const localArchivedAt = (normalizedLocalItem as unknown as Task).archivedAt as string;
            const incomingArchivedAt = (normalizedIncomingItem as unknown as Task).archivedAt as string;
            const timeDiff = Date.parse(incomingArchivedAt) - Date.parse(localArchivedAt);
            const archivedAt = timeDiff > 0 || (timeDiff === 0 && incomingArchivedAt > localArchivedAt)
                ? incomingArchivedAt
                : localArchivedAt;
            if ((mergedItem as unknown as Task).archivedAt !== archivedAt) mergedItem = { ...mergedItem, archivedAt };
        }
        if (strippedArchiveClock) {
            strippedArchiveClockMerges += 1;
            mergedItem = { ...mergedItem, archivedAt: strippedArchiveClock };
        }
        merged.push(normalizeTimestamps(mergedItem));
    }

    if (discardedLiveConflictWarnings > 5) {
        logWarn('syncConflictDiscardedSummary', {
            scope: 'sync',
            category: 'sync',
            context: {
                entityType,
                total: discardedLiveConflictWarnings,
                elided: discardedLiveConflictWarnings - 5,
            },
        });
    }
    if (taskStatusResolutionWarnings > 10) {
        logWarn('syncTaskStatusResolutionSummary', {
            scope: 'sync',
            category: 'sync',
            context: {
                entityType,
                total: taskStatusResolutionWarnings,
                elided: taskStatusResolutionWarnings - 10,
            },
        });
    }

    if (archiveTwinMerges > 0) {
        logInfo('Sync merge joined copies archived on two devices', {
            scope: 'sync',
            context: { releaseCheck: 'v1.3.7/auto-archive-converge', count: archiveTwinMerges },
        });
    }
    if (strippedArchiveClockMerges > 0) {
        logInfo('Sync merge retained archive clocks omitted by an equivalent peer', {
            scope: 'sync', force: true,
            context: { releaseCheck: 'v1.3.8/archive-clock-converge', entityType, count: strippedArchiveClockMerges },
        });
    }

    stats.mergedTotal = merged.length;

    return { merged, stats };
}

function mergeAreas(
    local: SyncMergeArea[],
    incoming: SyncMergeArea[],
    nowIso?: string,
): { merged: Area[]; stats: EntityMergeStats } {
    const result = mergeEntitiesWithStats(local, incoming, undefined, normalizeAreaForContentComparison, 'area', nowIso);
    let fallbackOrder = result.merged.reduce((maxOrder, area) => {
        const order = typeof area.order === 'number' && Number.isFinite(area.order) ? area.order : -1;
        return Math.max(maxOrder, order);
    }, -1) + 1;
    const merged: Area[] = result.merged.map((area) => {
        if (typeof area.order === 'number' && Number.isFinite(area.order)) {
            return { ...area, order: area.order };
        }
        const normalized: Area = {
            ...area,
            order: fallbackOrder,
            rev: nextRevision(area.rev),
            revBy: SYNC_REPAIR_REV_BY,
        };
        fallbackOrder += 1;
        return normalized;
    });
    return { merged, stats: result.stats };
}

const getClockSkewWarning = (stats: MergeResult['stats']): ClockSkewWarning | undefined => {
    const candidates = [
        stats.tasks,
        stats.projects,
        stats.sections,
        stats.areas,
        stats.people,
    ].filter((entityStats): entityStats is EntityMergeStats => {
        if (!entityStats) return false;
        return (entityStats.maxClockSkewMs || 0) > CLOCK_SKEW_THRESHOLD_MS
            && !!entityStats.maxClockSkewDirection;
    });
    if (candidates.length === 0) return undefined;
    candidates.sort((left, right) => (right.maxClockSkewMs || 0) - (left.maxClockSkewMs || 0));
    const winner = candidates[0];
    if (!winner.maxClockSkewDirection) return undefined;
    return {
        skewMs: winner.maxClockSkewMs,
        direction: winner.maxClockSkewDirection,
    };
};

export function mergeAppDataWithStats(local: AppData, incoming: AppData, options: MergeAppDataOptions = {}): MergeResult {
    return runToEnd(mergeAppDataWithStatsPass(local, incoming, options));
}


export function* mergeAppDataWithStatsPass(local: AppData, incoming: AppData, options: MergeAppDataOptions = {}): CooperativePass<MergeResult> {
    const nowIso = isValidTimestamp(options.nowIso) ? options.nowIso : new Date().toISOString();


    let tombstoneRepairs = 0;
    const countRepair = <T extends { rev?: number; purgedAt?: string }>(before: T, after: T): T => {
        if (before.purgedAt && after.rev !== before.rev) tombstoneRepairs += 1;
        return after;
    };
    const localSections = compactSectionsForPurgedProjects(local.sections || [], local.projects || [], true);
    const incomingSections = compactSectionsForPurgedProjects(incoming.sections || [], incoming.projects || [], true);
    (local.sections || []).forEach((section, index) => {
        if (localSections[index]?.rev !== section.rev) tombstoneRepairs += 1;
    });
    (incoming.sections || []).forEach((section, index) => {
        if (incomingSections[index]?.rev !== section.rev) tombstoneRepairs += 1;
    });
    const localNormalized = {
        ...local,
        tasks: yield* mapPass(local.tasks || [], (task) => normalizeRevisionMetadata(countRepair(task, normalizeTaskForSyncMerge(task, nowIso, true)))),
        projects: (local.projects || []).map((project) => normalizeRevisionMetadata(countRepair(project, normalizeProjectForSyncMerge(project, true)))),
        sections: localSections.map((section) => normalizeRevisionMetadata(normalizeSectionForSyncMerge(section))),
        areas: (local.areas || []).map((area) => normalizeRevisionMetadata(normalizeAreaForSyncMerge(area, nowIso))),
        people: (local.people || []).map((person) => normalizeRevisionMetadata(normalizePersonForSyncMerge(person, nowIso))),
    };
    const incomingNormalized = {
        ...incoming,
        tasks: yield* mapPass(incoming.tasks || [], (task) => normalizeRevisionMetadata(countRepair(task, normalizeTaskForSyncMerge(task, nowIso)))),
        projects: (incoming.projects || []).map((project) => normalizeRevisionMetadata(countRepair(project, normalizeProjectForSyncMerge(project)))),
        sections: incomingSections.map((section) => normalizeRevisionMetadata(normalizeSectionForSyncMerge(section))),
        areas: (incoming.areas || []).map((area) => normalizeRevisionMetadata(normalizeAreaForSyncMerge(area, nowIso))),
        people: (incoming.people || []).map((person) => normalizeRevisionMetadata(normalizePersonForSyncMerge(person, nowIso))),
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
        const resolveCloudKey = (
            mergedAttachment: Attachment,
            localAttachment?: Attachment,
            incomingAttachment?: Attachment,
        ): string | undefined => {
            if (mergedAttachment.deletedAt) return mergedAttachment.cloudKey;


            if (
                options.preferIncomingAttachmentCloudKeys
                && incomingAttachment
                && !incomingAttachment.deletedAt
            ) {
                return incomingAttachment.cloudKey;
            }
            if (
                incomingAttachment?.cloudKey
                && !incomingAttachment.deletedAt
                && options.preferIncomingAttachmentCloudKeyIds?.has(mergedAttachment.id)
            ) {
                return incomingAttachment.cloudKey;
            }
            return mergedAttachment.cloudKey
                || localAttachment?.cloudKey
                || incomingAttachment?.cloudKey;
        };


        const resolveContentIdentity = (
            winner: Attachment,
            localAttachment: Attachment,
            incomingAttachment: Attachment,
        ): Pick<Attachment, 'fileHash' | 'contentRev' | 'contentMtimeMs' | 'contentSize' | 'pendingContentUpload' | 'staleContentHash'> => {
            if (winner.deletedAt) {
                return {
                    fileHash: winner.fileHash,
                    contentRev: winner.contentRev,
                    contentMtimeMs: winner.contentMtimeMs,
                    contentSize: winner.contentSize,
                    pendingContentUpload: undefined,
                    staleContentHash: undefined,
                };
            }
            const localRev = localAttachment.contentRev ?? 0;
            const incomingRev = incomingAttachment.contentRev ?? 0;
            const contentSource = localRev === incomingRev
                ? winner
                : (localRev > incomingRev ? localAttachment : incomingAttachment);
            const contentRev = contentSource.contentRev;


            const localPendingCandidateWon = localAttachment.pendingContentUpload === true
                && contentSource === localAttachment;
            const fileHash = localPendingCandidateWon
                ? localAttachment.fileHash
                : contentSource.fileHash || localAttachment.fileHash || incomingAttachment.fileHash;
            const normalizedLocalFileHash = localAttachment.fileHash?.trim().toLowerCase();
            const normalizedResolvedFileHash = fileHash?.trim().toLowerCase();


            const localIdentitySurvived = (contentRev ?? 0) === localRev
                && (
                    (Boolean(normalizedLocalFileHash)
                        && normalizedResolvedFileHash === normalizedLocalFileHash)
                    || (localPendingCandidateWon
                        && !normalizedLocalFileHash
                        && !normalizedResolvedFileHash)
                );


            const localPendingIdentitySurvived = localAttachment.pendingContentUpload === true
                && localIdentitySurvived;


            const localFileStatSource = localIdentitySurvived ? localAttachment : contentSource;


            const hasRecordedFileStat = (attachment: Attachment) => attachment.contentMtimeMs !== undefined && attachment.contentSize !== undefined;
            const normalizedLocalStaleHash = localAttachment.staleContentHash?.trim().toLowerCase();
            const staleContentHash = hasRecordedFileStat(localFileStatSource)
                ? undefined
                : localIdentitySurvived
                    ? localAttachment.staleContentHash
                    : hasRecordedFileStat(localAttachment)
                        ? normalizedLocalFileHash
                        : normalizedLocalStaleHash || normalizedLocalFileHash;
            return {
                fileHash,
                contentRev,
                contentMtimeMs: localFileStatSource.contentMtimeMs,
                contentSize: localFileStatSource.contentSize,
                pendingContentUpload: localPendingIdentitySurvived ? true : undefined,
                staleContentHash: staleContentHash || undefined,
            };
        };

        const merged = mergeEntitiesWithStats(localList, incomingList, (localAttachment, incomingAttachment, winner) => {
            if (winner.kind !== 'file' || localAttachment.kind !== 'file' || incomingAttachment.kind !== 'file') {
                return winner;
            }

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
            } else if (localHasUri || incomingHasUri) {
                if (localHasUri) {
                    uri = localUri || localAttachment.uri;
                    localStatus = localAttachment.localStatus || 'available';
                } else {
                    uri = incomingUri || incomingAttachment.uri;
                    localStatus = incomingAttachment.localStatus || 'available';
                }
            } else {
                uri = winnerUri || localUri || incomingUri || '';
                localStatus = normalizeMissingFileStatus(localStatus, winner.deletedAt);
            }
            if ((localStatus === undefined || localStatus === null) && !!sanitizeMergedAttachmentUri(uri)) {
                localStatus = 'available';
            }

            return {
                ...winner,
                cloudKey: resolveCloudKey(winner, localAttachment, incomingAttachment),
                ...resolveContentIdentity(winner, localAttachment, incomingAttachment),
                uri,
                localStatus,
            };
        }, undefined, 'attachment', nowIso).merged;

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
                cloudKey: resolveCloudKey(attachment, localFile, incomingFile),
                fileHash: attachment.deletedAt
                    ? attachment.fileHash
                    : attachment.pendingContentUpload === true
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

    let unchangedAttachmentCopiesSkipped = 0;


    const keepViewSectionIdsFromPeer = <T extends Task | Project>(winner: T, other: T): T => (
        Object.prototype.hasOwnProperty.call(winner, 'viewSectionIds')
            || !Object.prototype.hasOwnProperty.call(other, 'viewSectionIds')
            ? winner
            : { ...winner, viewSectionIds: other.viewSectionIds }
    );


    const keepProjectCalendarReferenceFromPeer = (winner: Project, other: Project): Project => (
        winner.calendarReference !== undefined || other.calendarReference === undefined || winner.purgedAt
            ? winner
            : { ...winner, calendarReference: other.calendarReference }
    );

    const keepProjectFlowFromPeer = (winner: Project, other: Project): Project => (
        winner.perSectionFlow !== undefined || other.perSectionFlow === undefined || winner.purgedAt
            ? winner
            : { ...winner, perSectionFlow: other.perSectionFlow }
    );

    const keepReminderLeadsFromPeer = (winner: Task, other: Task): Task => {
        let preserved = winner;
        for (const field of ['dueReminderLeadMinutes', 'startReminderLeadMinutes'] as const) {
            if (preserved[field] === undefined && other[field] !== undefined && !preserved.purgedAt) {
                preserved = { ...preserved, [field]: other[field] };
            }
        }
        return preserved;
    };
    const withMergedAttachments = <T extends Task | Project>(winner: T, attachments: Attachment[] | undefined): T => {


        if (winner.attachments === attachments) {
            unchangedAttachmentCopiesSkipped += 1;
            return winner;
        }
        return { ...winner, attachments };
    };
    const tasksResult = yield* mergeEntitiesPass(
        localNormalized.tasks,
        incomingNormalized.tasks,
        (localTask: Task, incomingTask: Task, winner: Task) => {
            const attachments = winner.purgedAt
                ? compactAttachmentCleanupMetadata(localTask.attachments)
                : mergeAttachments(
                    localTask.purgedAt ? undefined : localTask.attachments,
                    incomingTask.purgedAt ? undefined : incomingTask.attachments,
                );
            const winnerWithForwardCompatibleViewSections = keepViewSectionIdsFromPeer(
                winner,
                winner === localTask ? incomingTask : localTask,
            );
            return repairTaskRecurrenceSeriesIdentity(
                localTask,
                incomingTask,
                preserveTaskCancellationFromStrippedPeer(
                    localTask,
                    incomingTask,
                    withMergedAttachments(keepReminderLeadsFromPeer(winnerWithForwardCompatibleViewSections, winner === localTask ? incomingTask : localTask), attachments),
                ),
            );
        },
        normalizeTaskForContentComparison,
        'task',
        nowIso
    );

    const projectsResult = yield* mergeEntitiesPass(
        localNormalized.projects,
        incomingNormalized.projects,
        (localProject: Project, incomingProject: Project, winner: Project) => {
            const attachments = winner.purgedAt
                ? compactAttachmentCleanupMetadata(localProject.attachments)
                : mergeAttachments(
                    localProject.purgedAt ? undefined : localProject.attachments,
                    incomingProject.purgedAt ? undefined : incomingProject.attachments,
                );
            return preserveProjectCancellationFromStrippedPeer(
                localProject,
                incomingProject,
                withMergedAttachments(
                    keepProjectFlowFromPeer(
                        keepProjectCalendarReferenceFromPeer(
                            keepViewSectionIdsFromPeer(winner, winner === localProject ? incomingProject : localProject),
                            winner === localProject ? incomingProject : localProject,
                        ),
                        winner === localProject ? incomingProject : localProject,
                    ),
                    attachments,
                ),
            );
        },
        normalizeProjectForContentComparison,
        'project',
        nowIso
    );

    const sectionsResult = mergeEntitiesWithStats(
        localNormalized.sections,
        incomingNormalized.sections,


        (localSection: Section, incomingSection: Section, winner: Section) => {
            const other = winner === localSection ? incomingSection : localSection;
            return winner.isSequential !== undefined || other.isSequential === undefined
                || (winner.deletedAt && !winner.projectArchivedAt)
                ? winner
                : { ...winner, isSequential: other.isSequential };
        },
        normalizeSectionForContentComparison,
        'section',
        nowIso
    );

    const areasResult = mergeAreas(localNormalized.areas, incomingNormalized.areas, nowIso);
    const peopleResult = mergeEntitiesWithStats(
        localNormalized.people,
        incomingNormalized.people,
        undefined,
        normalizePersonForContentComparison,
        'person',
        nowIso
    );

    const stats = {
        tasks: tasksResult.stats,
        projects: projectsResult.stats,
        sections: sectionsResult.stats,
        areas: areasResult.stats,
        people: peopleResult.stats,
        tombstoneRepairs,
    };

    yield;
    const data = traceSection('sync:mergeRepair', () => repairMergedSyncReferences({
        tasks: tasksResult.merged,
        projects: projectsResult.merged,
        sections: sectionsResult.merged,
        areas: areasResult.merged,
        people: peopleResult.merged as Person[],
        settings: mergeSettingsForSync(localNormalized.settings, incomingNormalized.settings),
    }, nowIso));
    data.sections = compactSectionsForPurgedProjects(data.sections, data.projects);
    if (unchangedAttachmentCopiesSkipped > 0) {
        logInfo('Sync merge skipped unchanged attachment copies', {
            scope: 'sync',
            context: {
                releaseCheck: 'v1.3.0/sync-attachment-copy-elision',
                count: unchangedAttachmentCopiesSkipped,
            },
        });
    }

    return {
        data,
        stats,
        clockSkewWarning: getClockSkewWarning(stats),
    };
}

export function mergeAppData(local: AppData, incoming: AppData, options: MergeAppDataOptions = {}): AppData {
    return mergeAppDataWithStats(local, incoming, options).data;
}

const withPendingRemoteWriteFlag = (
    data: AppData,
    pendingAt: string,
    attempts?: number,
): AppData => ({
    ...data,
    settings: {
        ...data.settings,
        pendingRemoteWriteAt: pendingAt,
        pendingRemoteWriteRetryAt: undefined,
        pendingRemoteWriteAttempts: attempts && attempts > 0 ? attempts : undefined,
    },
});

const clearPendingRemoteWriteFlag = (data: AppData): AppData => {
    if (
        !data.settings.pendingRemoteWriteAt
        && data.settings.pendingRemoteWriteRetryAt === undefined
        && data.settings.pendingRemoteWriteAttempts === undefined
    ) {
        return data;
    }
    return {
        ...data,
        settings: {
            ...data.settings,
            pendingRemoteWriteAt: undefined,
            pendingRemoteWriteRetryAt: undefined,
            pendingRemoteWriteAttempts: undefined,
        },
    };
};

const hasPendingRemoteWriteFlag = (data: AppData): boolean => isValidTimestamp(data.settings.pendingRemoteWriteAt);

const isLocalSyncAbortError = (error: unknown): boolean => (
    error instanceof Error && error.name === 'LocalSyncAbort'
);


const saveRemoteWriteRetrySchedule = async (io: SyncCycleIO, data: AppData): Promise<void> => {
    try {
        await io.writeLocal(data);
    } catch (saveError) {
        if (!io.slicer || !isLocalSyncAbortError(saveError)) throw saveError;
        logWarn('Sync retry schedule save refused; the remote write error stands', { scope: 'sync' });
    }
};

const getPendingRemoteWriteAttemptCount = (data: AppData): number => {
    const attempts = data.settings.pendingRemoteWriteAttempts;
    if (typeof attempts !== 'number' || !Number.isFinite(attempts) || attempts < 0) {
        return 0;
    }
    return Math.floor(attempts);
};

const getPendingRemoteWriteBlockedMs = (data: AppData, nowIso: string): number => {
    if (!isValidTimestamp(data.settings.pendingRemoteWriteRetryAt)) return 0;
    const retryAtMs = Date.parse(data.settings.pendingRemoteWriteRetryAt as string);
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(retryAtMs) || !Number.isFinite(nowMs)) return 0;
    return Math.max(0, retryAtMs - nowMs);
};

const getSyncErrorMessage = (error: unknown): string | undefined => {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    if (typeof error === 'string' && error.trim()) return error.trim();
    return undefined;
};

const withPendingRemoteWriteRetry = (data: AppData, nowIso: string, error?: unknown): AppData => {
    const rawNextAttempts = getPendingRemoteWriteAttemptCount(data) + 1;
    const nextAttempts = Math.min(rawNextAttempts, PENDING_REMOTE_WRITE_MAX_ATTEMPTS);
    const reachedAttemptCeiling = rawNextAttempts >= PENDING_REMOTE_WRITE_MAX_ATTEMPTS;
    const backoffMs = Math.min(
        PENDING_REMOTE_WRITE_RETRY_MAX_MS,
        PENDING_REMOTE_WRITE_RETRY_BASE_MS * (2 ** Math.max(0, nextAttempts - 1))
    );
    const baseMs = Date.parse(nowIso);
    const retryAt = Number.isFinite(baseMs)
        ? new Date(baseMs + backoffMs).toISOString()
        : new Date(Date.now() + backoffMs).toISOString();
    return {
        ...data,
        settings: {
            ...data.settings,


            lastSyncStatus: 'error',
            lastSyncError: reachedAttemptCeiling
                ? `Remote write failed after ${PENDING_REMOTE_WRITE_MAX_ATTEMPTS} attempts. Check your sync backend, then sync again.`
                : getSyncErrorMessage(error) ?? 'Remote write failed. Retrying in the background.',
            pendingRemoteWriteRetryAt: retryAt,
            pendingRemoteWriteAttempts: nextAttempts,
        },
    };
};

async function performSyncCycleUnlocked(io: SyncCycleIO): Promise<SyncCycleResult> {
    const nowIso = io.now ? io.now() : new Date().toISOString();

    const slicer = io.slicer;
    const yieldToUi = async () => {
        if (typeof io.yieldToUi === 'function') {
            await io.yieldToUi();
        }
    };

    const readLocalDataForSync = async (): Promise<AppData> => {
        io.onStep?.('read-local');
        await yieldToUi();
        const rawLocal = await io.readLocal();
        const localDocument = traceSection('sync:parseLocal', () => parseSyncDocument(rawLocal, 'local'));
        if (!localDocument.ok) {
            const sample = localDocument.errors.slice(0, 3).join('; ');
            throw new Error(`Invalid local sync payload: ${sample}`);
        }
        return traceSection('sync:purge', () => purgeExpiredTombstones(localDocument.data, nowIso, io.tombstoneRetentionDays).data);
    };

    let localData = await readLocalDataForSync();
    let pendingRemoteWriteMeta:
        | {
            pendingAt: string;
            attempts: number;
        }
        | undefined;

    if (hasPendingRemoteWriteFlag(localData)) {
        const blockedMs = getPendingRemoteWriteBlockedMs(localData, nowIso);
        if (blockedMs > 0) {
            const seconds = Math.max(1, Math.ceil(blockedMs / 1000));
            return {
                data: localData,
                status: 'skipped',
                skipped: 'pendingRemoteWriteBackoff',
                retryInMs: blockedMs,
                message: `Sync paused briefly after remote write failure. Retry in about ${seconds}s.`,
            };
        }
        pendingRemoteWriteMeta = {
            pendingAt: localData.settings.pendingRemoteWriteAt as string,
            attempts: getPendingRemoteWriteAttemptCount(localData),
        };
        if (typeof io.flushPendingLocalBeforeRetryRead === 'function') {
            await io.flushPendingLocalBeforeRetryRead();
        }
        localData = clearPendingRemoteWriteFlag(await readLocalDataForSync());
    }

    io.onStep?.('read-remote');
    await yieldToUi();
    const rawRemote = await io.readRemote() ?? {};
    const remoteDocument = traceSection('sync:parseRemote', () => parseSyncDocument(rawRemote, 'remote'));
    if (!remoteDocument.ok) {
        const sample = remoteDocument.errors.slice(0, 3).join('; ');
        logWarn('Invalid remote sync payload shape', {
            scope: 'sync',
            context: {
                issues: remoteDocument.errors.length,
                sample,
            },
        });
        throw new Error(`Invalid remote sync payload: ${sample}`);
    }
    const remoteData = traceSection('sync:purge', () => purgeExpiredTombstones(remoteDocument.data, nowIso, io.tombstoneRetentionDays).data);

    io.onStep?.('merge');
    await yieldToUi();


    const remoteIsEmpty = remoteData.tasks.length === 0
        && remoteData.projects.length === 0
        && remoteData.sections.length === 0
        && remoteData.areas.length === 0
        && (remoteData.people?.length ?? 0) === 0
        && Object.keys(remoteData.settings ?? {}).length === 0;
    const skipMerge = io.skipEmptyRemoteMerge?.() === true && remoteIsEmpty;
    const mergeStartedAt = performance.now();
    const mergeResult: MergeResult = skipMerge
        ? { data: localData, stats: createLocalOnlyMergeStats(localData) }
        : await runSliced('sync:merge', mergeAppDataWithStatsPass(localData, remoteData, {
            nowIso,
            preferIncomingAttachmentCloudKeys: io.preferIncomingAttachmentCloudKeys,
            preferIncomingAttachmentCloudKeyIds: io.preferIncomingAttachmentCloudKeyIds,
        }), slicer);
    if (!skipMerge) {
        logInfo('Full sync merge completed', {
            scope: 'sync',
            context: {
                releaseCheck: 'v1.3.0/sync-signature-pruning',
                elapsedMs: Math.round(performance.now() - mergeStartedAt),
                count: mergeResult.data.tasks.length,
            },
        });
    }
    const mergeSummary = summarizeMergeStats(mergeResult.stats);
    const conflictCount = mergeSummary.conflicts;
    const nextSyncStatus: SyncCycleResult['status'] = conflictCount > 0 ? 'conflict' : 'success';
    const conflictIds = mergeSummary.conflictIds.slice(0, 10);
    const maxClockSkewMs = mergeSummary.maxClockSkewMs;
    if (maxClockSkewMs > CLOCK_SKEW_THRESHOLD_MS) {
        logWarn('Sync merge detected large clock skew', {
            scope: 'sync',
            context: {
                maxClockSkewMs: Math.round(maxClockSkewMs),
                thresholdMs: CLOCK_SKEW_THRESHOLD_MS,
                direction: mergeResult.clockSkewWarning?.direction,
            },
        });
    }
    const timestampAdjustments = mergeSummary.timestampAdjustments;
    const historyEntry: SyncHistoryEntry = {
        at: nowIso,
        status: nextSyncStatus,
        backend: io.historyContext?.backend,
        type: io.historyContext?.type ?? 'merge',
        conflicts: conflictCount,
        conflictIds,
        maxClockSkewMs,
        timestampAdjustments,
        details: io.historyContext?.details ?? buildSyncHistoryDetails(mergeResult.stats),
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


    const remoteSectionIds = new Set(remoteData.sections.map((section) => section.id));
    const remoteProjectIds = new Set(remoteData.projects.map((project) => project.id));


    const referencedSectionIds = new Set(
        nextMergedData.tasks.map((task) => task.sectionId).filter((id): id is string => Boolean(id)),
    );
    const peerPurgedSectionIds = new Set(
        nextMergedData.sections
            .filter((section) => !remoteSectionIds.has(section.id)
                && !referencedSectionIds.has(section.id)
                && remoteProjectIds.has(section.projectId))
            .map((section) => section.id),
    );
    const pruned = traceSection('sync:purge', () => purgeExpiredTombstones(nextMergedData, nowIso, io.tombstoneRetentionDays, {
        peerPurgedSectionIds,
    }));
    if (
        pruned.removedTaskTombstones > 0
        || pruned.removedProjectTombstones > 0
        || pruned.removedSectionTombstones > 0
        || pruned.removedAreaTombstones > 0
        || pruned.removedPersonTombstones > 0
        || pruned.removedAttachmentTombstones > 0
        || pruned.removedSavedFilterTombstones > 0
        || pruned.removedPendingRemoteDeletes > 0
    ) {
        logWarn('Purged expired sync tombstones', {
            scope: 'sync',
            context: {
                removedTaskTombstones: pruned.removedTaskTombstones,
                removedProjectTombstones: pruned.removedProjectTombstones,
                removedSectionTombstones: pruned.removedSectionTombstones,
                removedAreaTombstones: pruned.removedAreaTombstones,
                removedPersonTombstones: pruned.removedPersonTombstones,
                removedAttachmentTombstones: pruned.removedAttachmentTombstones,
                removedSavedFilterTombstones: pruned.removedSavedFilterTombstones,
                removedPendingRemoteDeletes: pruned.removedPendingRemoteDeletes,
            },
        });
    }
    let finalData = pruned.data;
    const validationErrors = await runSliced('sync:validate', validateMergedSyncDataPass(finalData), slicer);
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

    if (typeof io.prepareRemoteWrite === 'function') {
        const preparedData = await io.prepareRemoteWrite(finalData);

        const unchanged = preparedData === PREPARED_UNCHANGED;
        if (preparedData && !unchanged) finalData = preparedData;
        const preparedValidationErrors = unchanged
            ? []
            : await runSliced('sync:validate', validateMergedSyncDataPass(finalData), slicer);
        if (preparedValidationErrors.length > 0) {
            const sample = preparedValidationErrors.slice(0, 3).join('; ');
            logWarn('Sync remote-write preparation validation failed', {
                scope: 'sync',
                context: {
                    issues: preparedValidationErrors.length,
                    sample,
                },
            });
            throw new Error(`Sync validation failed: ${sample}`);
        }
    }


    if (
        !pendingRemoteWriteMeta
        && typeof io.isLocalPersistUnchanged === 'function'
        && typeof io.persistSyncStatusOnly === 'function'
        && io.isLocalPersistUnchanged(finalData)
    ) {
        io.onStep?.('write-remote');
        await yieldToUi();
        try {
            await io.writeRemote(finalData);
        } catch (error) {
            if (!isLocalSyncAbortError(error)) {


                io.onStep?.('write-local');
                await yieldToUi();
                await saveRemoteWriteRetrySchedule(io, withPendingRemoteWriteRetry(finalData, nowIso, error));
            }
            throw error;
        }
        try {
            await io.persistSyncStatusOnly(finalData);
        } catch (error) {


            logWarn('Failed to persist sync status after an unchanged local write', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return {
            data: finalData,
            stats: mergeResult.stats,
            status: nextSyncStatus,
            clockSkewWarning: mergeResult.clockSkewWarning,
            localWriteSkipped: true,
        };
    }

    const finalDataWithPendingRemoteWrite = withPendingRemoteWriteFlag(
        finalData,
        pendingRemoteWriteMeta?.pendingAt ?? nowIso,
        pendingRemoteWriteMeta?.attempts,
    );
    io.onStep?.('write-local');
    await yieldToUi();
    const canonicalWithPendingRemoteWrite = await io.writeLocal(finalDataWithPendingRemoteWrite)
        ?? finalDataWithPendingRemoteWrite;
    const persistedFinalData = clearPendingRemoteWriteFlag(canonicalWithPendingRemoteWrite);

    io.onStep?.('write-remote');
    await yieldToUi();
    try {
        await io.writeRemote(persistedFinalData);
    } catch (error) {

        if (isLocalSyncAbortError(error)) throw error;
        const localDataWithRetry = withPendingRemoteWriteRetry(canonicalWithPendingRemoteWrite, nowIso, error);
        io.onStep?.('write-local');
        await yieldToUi();
        await saveRemoteWriteRetrySchedule(io, localDataWithRetry);
        throw error;
    }

    io.onStep?.('write-local');
    await yieldToUi();

    const canonicalPersistedData = await io.writeLocal(persistedFinalData) ?? persistedFinalData;
    return {
        data: canonicalPersistedData,
        stats: mergeResult.stats,
        status: nextSyncStatus,
        clockSkewWarning: mergeResult.clockSkewWarning,
    };
}

export async function performSyncCycle(io: SyncCycleIO): Promise<SyncCycleResult> {
    return executeSyncCycle(() => performSyncCycleUnlocked(io));
}
