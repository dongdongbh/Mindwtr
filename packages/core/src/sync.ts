import type { AppData, Attachment, Area, Person, Project, Task } from './types';
import { logWarn } from './logger';
import {
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
    normalizeTaskForSyncMerge,
    validateMergedSyncData,
} from './sync-normalization';
import { parseSyncDocument } from './sync-document';
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
export { purgeExpiredTombstones } from './sync-tombstones';
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

/**
 * Stats for a cycle that skipped the empty-remote merge (`io.skipEmptyRemoteMerge`):
 * with no incoming document every entity is local-only, nothing conflicts and
 * nothing is clamped. Kept in step with what the real merge reports for an empty
 * remote by `sync-canonical-reads.contract.test.ts`.
 */
function createLocalOnlyMergeStats(data: AppData): MergeStats {
    const forCollection = (items?: readonly unknown[]): EntityMergeStats => {
        const stats = createEmptyEntityStats(items?.length ?? 0, 0);
        stats.mergedTotal = stats.localTotal;
        stats.localOnly = stats.localTotal;
        // The reconcile counts an entity with no counterpart as resolved using
        // the local side, so a skipped merge has to report it the same way.
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
            // Ignore malformed URI segments and keep evaluating other candidates.
        }

        const trimmed = current.trim();
        if (trimmed.startsWith('//')) {
            try {
                enqueueCandidate(new URL(`file:${trimmed}`).pathname);
            } catch {
                // Ignore URL parse failures and keep evaluating the raw candidate.
            }
            continue;
        }

        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
            try {
                enqueueCandidate(new URL(trimmed).pathname);
            } catch {
                // Ignore URL parse failures and keep evaluating the raw candidate.
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
};

const getRecurrenceSeriesShape = (value: Task['recurrence']): string | null => {
    const normalized = normalizeRecurrenceForLoad(value);
    if (!normalized) return null;
    const { seriesId: _seriesId, rrule, ...shape } = normalized;
    return JSON.stringify({
        ...shape,
        interval: rrule ? parseRRuleString(rrule).interval : undefined,
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
        // Only the immediately following revision proves this was an edit of the known series.
        // Equal or skipped revisions may be concurrent work or a cleared-and-recreated series.
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

function mergeEntitiesWithStats<T extends MergeableEntity>(
    local: T[],
    incoming: T[],
    mergeConflict?: (localItem: T, incomingItem: T, winner: T) => T,
    normalizeForComparison?: ComparisonNormalizer<T>,
    entityType: string = 'entity',
    nowIso?: string,
): { merged: T[]; stats: EntityMergeStats } {
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
        const contentDiff = shouldCheckContentDiff ? !comparableContentMatches : false;
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
            // Only use revBy when both sides provide it; otherwise older clients without revBy
            // fall back to deterministic convergence instead of silently losing to partial metadata.
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
            // Only conflict samples need the expanded comparable views; the loop's
            // equality check runs on cached signatures now, so these are built lazily.
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

        const mergedItem = mergeConflict ? mergeConflict(normalizedLocalItem, normalizedIncomingItem, winner) : winner;
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
    const nowIso = isValidTimestamp(options.nowIso) ? options.nowIso : new Date().toISOString();
    // Compaction repairs must converge to zero after one cycle; a steady nonzero
    // count here is a rev-bump loop that rewrites every purged tombstone each
    // cycle (#766). Counted per cycle and surfaced via stats.tombstoneRepairs.
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
        tasks: (local.tasks || []).map((task) => normalizeRevisionMetadata(countRepair(task, normalizeTaskForSyncMerge(task, nowIso, true)))),
        projects: (local.projects || []).map((project) => normalizeRevisionMetadata(countRepair(project, normalizeProjectForSyncMerge(project, true)))),
        sections: localSections.map((section) => normalizeRevisionMetadata(section)),
        areas: (local.areas || []).map((area) => normalizeRevisionMetadata(normalizeAreaForSyncMerge(area, nowIso))),
        people: (local.people || []).map((person) => normalizeRevisionMetadata(normalizePersonForSyncMerge(person, nowIso))),
    };
    const incomingNormalized = {
        ...incoming,
        tasks: (incoming.tasks || []).map((task) => normalizeRevisionMetadata(countRepair(task, normalizeTaskForSyncMerge(task, nowIso)))),
        projects: (incoming.projects || []).map((project) => normalizeRevisionMetadata(countRepair(project, normalizeProjectForSyncMerge(project)))),
        sections: incomingSections.map((section) => normalizeRevisionMetadata(section)),
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
            // The first durable cycle after activation reads the exact remote
            // document written by the candidate probe. Its live cloud key is
            // therefore proof for the newly active destination; an equal-time
            // deterministic winner from the previous backend must not replace
            // it. An explicit missing key remains missing so the cycle fails
            // safe and a later attachment pass can upload it.
            if (
                options.preferIncomingAttachmentCloudKeys
                && incomingAttachment
                && !incomingAttachment.deletedAt
            ) {
                return incomingAttachment.cloudKey;
            }
            return mergedAttachment.cloudKey
                || localAttachment?.cloudKey
                || incomingAttachment?.cloudKey;
        };

        // #1057: content-revision conflicts resolve independently of which side wins
        // the task-level LWW above — a higher `contentRev` always wins outright. On a
        // tie (including the common case where neither side ever set one — old
        // clients, or genuinely identical content) there's no separate signal to
        // prefer, so this defers to `winner`: deterministic and symmetric, since
        // `winner` is computed the same way regardless of which side calls itself
        // "local" vs "incoming", so both devices converge on the same merged object.
        //
        // `contentMtimeMs`/`contentSize` follow the same `contentSource` as `fileHash`
        // (review B1's actual mechanism, not a separate rule): these two fields never
        // travel over the wire (`sanitizeAppDataForRemote` strips them — see there), so
        // `incomingAttachment`'s copy is always already absent by the time it reaches this
        // merge. When `contentSource` is `incoming` (its `contentRev` won), the merged
        // result correctly ends up with an ABSENT recorded stat — which is exactly what
        // makes the receiving device's next check-on-touch pass detect a mismatch against
        // its own (stale) disk file and re-download, per design point 4. If this instead
        // preferred `localAttachment` unconditionally, a losing device's own unchanged
        // stat would keep matching its own disk forever and it would never re-download.
        const resolveContentIdentity = (
            winner: Attachment,
            localAttachment: Attachment,
            incomingAttachment: Attachment,
        ): Pick<Attachment, 'fileHash' | 'contentRev' | 'contentMtimeMs' | 'contentSize' | 'pendingContentUpload'> => {
            if (winner.deletedAt) {
                return {
                    fileHash: winner.fileHash,
                    contentRev: winner.contentRev,
                    contentMtimeMs: winner.contentMtimeMs,
                    contentSize: winner.contentSize,
                    pendingContentUpload: undefined,
                };
            }
            const localRev = localAttachment.contentRev ?? 0;
            const incomingRev = incomingAttachment.contentRev ?? 0;
            const contentSource = localRev === incomingRev
                ? winner
                : (localRev > incomingRev ? localAttachment : incomingAttachment);
            const contentRev = contentSource.contentRev;
            // An unproven local replacement is its own content generation. Falling
            // back to the incoming digest here would falsely label its bytes as the
            // previous remote blob and then let the restored metadata escape without
            // a hash-bound upload. Keep the digest absent until the prepare lifecycle
            // snapshots these local bytes; the durable pending marker blocks remote
            // publication if that proof cannot be obtained.
            const localPendingCandidateWon = localAttachment.pendingContentUpload === true
                && contentSource === localAttachment;
            const fileHash = localPendingCandidateWon
                ? localAttachment.fileHash
                : contentSource.fileHash || localAttachment.fileHash || incomingAttachment.fileHash;
            const normalizedLocalFileHash = localAttachment.fileHash?.trim().toLowerCase();
            const normalizedResolvedFileHash = fileHash?.trim().toLowerCase();
            // Merge kept the exact local content identity: same contentRev, same
            // fileHash. This is the steady state of every device merging against its
            // own stripped remote twin, and the attachment-level tie can still hand
            // `winner` to the incoming copy.
            const localIdentitySurvived = (contentRev ?? 0) === localRev
                && (
                    (Boolean(normalizedLocalFileHash)
                        && normalizedResolvedFileHash === normalizedLocalFileHash)
                    || (localPendingCandidateWon
                        && !normalizedLocalFileHash
                        && !normalizedResolvedFileHash)
                );
            // `pendingContentUpload` is device-local retry state, never an LWW
            // field. Preserve this device's marker whenever merge kept the exact
            // local content identity, even if an otherwise-identical remote record
            // won the attachment-level tie after its local-only fields were stripped.
            const localPendingIdentitySurvived = localAttachment.pendingContentUpload === true
                && localIdentitySurvived;
            // The recorded stat describes THIS device's disk file and never travels, so
            // when the identity survived it must come from the local copy: taking it
            // from an incoming winner yields an absent stat, the post-merge pass
            // re-records it, and that local write triggers another sync, every cycle.
            // Design point 4 is untouched: newer remote content arrives with a higher
            // contentRev or a different fileHash and still lands with an absent stat.
            const statSource = localIdentitySurvived ? localAttachment : contentSource;
            return {
                fileHash,
                contentRev,
                contentMtimeMs: statSource.contentMtimeMs,
                contentSize: statSource.contentSize,
                pendingContentUpload: localPendingIdentitySurvived ? true : undefined,
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

    const tasksResult = mergeEntitiesWithStats(
        localNormalized.tasks,
        incomingNormalized.tasks,
        (localTask: Task, incomingTask: Task, winner: Task) => {
            const attachments = winner.purgedAt
                ? compactAttachmentCleanupMetadata(localTask.attachments)
                : mergeAttachments(
                    localTask.purgedAt ? undefined : localTask.attachments,
                    incomingTask.purgedAt ? undefined : incomingTask.attachments,
                );
            const otherTask = winner === localTask ? incomingTask : localTask;
            const winnerWithForwardCompatibleViewSections = Object.prototype.hasOwnProperty.call(winner, 'viewSectionIds')
                ? winner
                : Object.prototype.hasOwnProperty.call(otherTask, 'viewSectionIds')
                    ? { ...winner, viewSectionIds: otherTask.viewSectionIds }
                    : winner;
            return repairTaskRecurrenceSeriesIdentity(
                localTask,
                incomingTask,
                { ...winnerWithForwardCompatibleViewSections, attachments },
            );
        },
        normalizeTaskForContentComparison,
        'task',
        nowIso
    );

    const projectsResult = mergeEntitiesWithStats(
        localNormalized.projects,
        incomingNormalized.projects,
        (localProject: Project, incomingProject: Project, winner: Project) => {
            const attachments = winner.purgedAt
                ? compactAttachmentCleanupMetadata(localProject.attachments)
                : mergeAttachments(
                    localProject.purgedAt ? undefined : localProject.attachments,
                    incomingProject.purgedAt ? undefined : incomingProject.attachments,
                );
            return { ...winner, attachments };
        },
        normalizeProjectForContentComparison,
        'project',
        nowIso
    );

    const sectionsResult = mergeEntitiesWithStats(
        localNormalized.sections,
        incomingNormalized.sections,
        undefined,
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

    const data = repairMergedSyncReferences({
        tasks: tasksResult.merged,
        projects: projectsResult.merged,
        sections: sectionsResult.merged,
        areas: areasResult.merged,
        people: peopleResult.merged as Person[],
        settings: mergeSettingsForSync(localNormalized.settings, incomingNormalized.settings),
    }, nowIso);
    data.sections = compactSectionsForPurgedProjects(data.sections, data.projects);

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
            // This path only runs after the merged snapshot was saved locally and
            // the remote write failed, so the UI should show an error until retry clears it.
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
    const yieldToUi = async () => {
        if (typeof io.yieldToUi === 'function') {
            await io.yieldToUi();
        }
    };

    const readLocalDataForSync = async (): Promise<AppData> => {
        io.onStep?.('read-local');
        await yieldToUi();
        const localDocument = parseSyncDocument(await io.readLocal(), 'local');
        if (!localDocument.ok) {
            const sample = localDocument.errors.slice(0, 3).join('; ');
            throw new Error(`Invalid local sync payload: ${sample}`);
        }
        return purgeExpiredTombstones(localDocument.data, nowIso, io.tombstoneRetentionDays).data;
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
    const remoteDocument = parseSyncDocument(await io.readRemote() ?? {}, 'remote');
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
    const remoteData = purgeExpiredTombstones(remoteDocument.data, nowIso, io.tombstoneRetentionDays).data;

    io.onStep?.('merge');
    await yieldToUi();
    // The skip is refused unless the remote really is empty, so a caller that
    // sets the flag on a cycle that read a document cannot discard it.
    const remoteIsEmpty = remoteData.tasks.length === 0
        && remoteData.projects.length === 0
        && remoteData.sections.length === 0
        && remoteData.areas.length === 0
        && (remoteData.people?.length ?? 0) === 0
        && Object.keys(remoteData.settings ?? {}).length === 0;
    const mergeResult: MergeResult = io.skipEmptyRemoteMerge?.() === true && remoteIsEmpty
        ? { data: localData, stats: createLocalOnlyMergeStats(localData) }
        : mergeAppDataWithStats(localData, remoteData, {
            nowIso,
            preferIncomingAttachmentCloudKeys: io.preferIncomingAttachmentCloudKeys,
        });
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
    const pruned = purgeExpiredTombstones(nextMergedData, nowIso, io.tombstoneRetentionDays);
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

    if (typeof io.prepareRemoteWrite === 'function') {
        const preparedData = await io.prepareRemoteWrite(finalData);
        finalData = preparedData ?? finalData;
        const preparedValidationErrors = validateMergedSyncData(finalData);
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

    // The merge produced nothing the local store does not already hold. Both
    // document writes below would rewrite the same bytes, and the pending
    // remote-write marker they carry has nothing to protect: it exists so a
    // crash between the local write and the remote write cannot leave local
    // holding merged-in remote changes that were never published, and here
    // local absorbed nothing. Persist the cycle's own bookkeeping and go
    // straight to the remote write, which keeps its own unchanged-guard.
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
                // Nothing durable to roll back, but the retry schedule still
                // has to land or the next cycle hammers a failing backend.
                io.onStep?.('write-local');
                await yieldToUi();
                await io.writeLocal(withPendingRemoteWriteRetry(finalData, nowIso, error));
            }
            throw error;
        }
        try {
            await io.persistSyncStatusOnly(finalData);
        } catch (error) {
            // The remote write already succeeded and no document changed locally;
            // a failed status write must not report the whole cycle as an error
            // (same swallow-and-warn as persistUnchangedSyncStatus).
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
        if (isLocalSyncAbortError(error)) {
            await io.clearPendingRemoteWriteAfterLocalAbort?.(finalDataWithPendingRemoteWrite.settings.pendingRemoteWriteAt as string);
            throw error;
        }
        const localDataWithRetry = withPendingRemoteWriteRetry(canonicalWithPendingRemoteWrite, nowIso, error);
        io.onStep?.('write-local');
        await yieldToUi();
        await io.writeLocal(localDataWithRetry);
        throw error;
    }

    io.onStep?.('write-local');
    await yieldToUi();
    try {
        const canonicalPersistedData = await io.writeLocal(persistedFinalData) ?? persistedFinalData;
        return {
            data: canonicalPersistedData,
            stats: mergeResult.stats,
            status: nextSyncStatus,
            clockSkewWarning: mergeResult.clockSkewWarning,
        };
    } catch (error) {
        if (isLocalSyncAbortError(error)) {
            await io.clearPendingRemoteWriteAfterLocalAbort?.(finalDataWithPendingRemoteWrite.settings.pendingRemoteWriteAt as string);
        }
        throw error;
    }
}

export async function performSyncCycle(io: SyncCycleIO): Promise<SyncCycleResult> {
    return executeSyncCycle(() => performSyncCycleUnlocked(io));
}
