import type { AppData, Attachment, Area, Project, Task } from './types';
import { logWarn } from './logger';
import {
    type ClockSkewWarning,
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
    type SyncMergeArea,
    normalizeAreaForSyncMerge,
    normalizeAppData,
    normalizeProjectForSyncMerge,
    repairMergedSyncReferences,
    normalizeRevisionMetadata,
    normalizeTaskForSyncMerge,
    validateMergedSyncData,
    validateSyncPayloadShape,
} from './sync-normalization';
import { mergeSettingsForSync } from './sync-merge-settings';
import {
    chooseDeterministicWinner,
    collectComparableDiffKeys,
    createSyncSignatureMemo,
    hashComparableSignature,
    normalizeProjectForContentComparison,
    normalizeSectionForContentComparison,
    normalizeTaskForContentComparison,
    toComparableSignature,
    toComparableValue,
} from './sync-signatures';
import { purgeExpiredTombstones } from './sync-tombstones';
import { filterNotDeleted } from './sync-helpers';

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
export { CLOCK_SKEW_THRESHOLD_MS, SYNC_REPAIR_REV_BY } from './sync-types';
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
        maxClockSkewDirection: undefined,
        invalidTimestamps: 0,
        timestampAdjustments: 0,
        timestampAdjustmentIds: [],
        conflictReasonCounts: {},
        conflictSamples: [],
    };
}

const CONFLICT_SAMPLE_LIMIT = 5;
const CONFLICT_DIFF_KEY_LIMIT = 8;
const DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS = 30 * 1000;
const PENDING_REMOTE_WRITE_RETRY_BASE_MS = 5 * 1000;
const PENDING_REMOTE_WRITE_RETRY_MAX_MS = 5 * 60 * 1000;
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
    if (maxAllowedMs !== undefined && parsed > maxAllowedMs) {
        return { raw: parsed, safe: maxAllowedMs, wasClamped: true };
    }
    return { raw: parsed, safe: parsed, wasClamped: false };
};

const attachmentTraversalSegmentCache = new Map<string, boolean>();

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
    const cached = attachmentTraversalSegmentCache.get(value);
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
    if (attachmentTraversalSegmentCache.size >= ATTACHMENT_TRAVERSAL_SEGMENT_CACHE_LIMIT) {
        attachmentTraversalSegmentCache.clear();
    }
    attachmentTraversalSegmentCache.set(value, hasTraversalSegment);
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
};

function mergeEntitiesWithStats<T extends MergeableEntity>(
    local: T[],
    incoming: T[],
    mergeConflict?: (localItem: T, incomingItem: T, winner: T) => T,
    normalizeForComparison?: ComparisonNormalizer<T>,
    entityType: string = 'entity',
): { merged: T[]; stats: EntityMergeStats } {
    const localMap = new Map<string, T>(local.map((item) => [item.id, item]));
    const incomingMap = new Map<string, T>(incoming.map((item) => [item.id, item]));
    const allIds = new Set<string>([...localMap.keys(), ...incomingMap.keys()]);

    const stats = createEmptyEntityStats(local.length, incoming.length);
    const merged: T[] = [];
    const signatureMemo = createSyncSignatureMemo();
    let invalidDeletedAtWarnings = 0;
    let ambiguousResurrectionWarnings = 0;
    const maxAllowedMergeTime = Date.now();
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
        const localComparableSignature = toComparableSignature(comparableLocalItem, signatureMemo);
        const incomingComparableSignature = toComparableSignature(comparableIncomingItem, signatureMemo);
        const comparableContentMatches = localComparableSignature === incomingComparableSignature;
        const shouldCheckContentDiff = hasRevision
            ? revDiff === 0 && localDeleted === incomingDeleted
            : localDeleted === incomingDeleted;
        const contentDiff = shouldCheckContentDiff ? !comparableContentMatches : false;
        const unresolvedDeleteStateDiff = localDeleted !== incomingDeleted && (!hasRevision || revDiff === 0);
        const conflictReasons: ConflictReason[] = [];
        if (unresolvedDeleteStateDiff) conflictReasons.push('deleteState');
        if (contentDiff) conflictReasons.push('content');

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

            return deletedTimeRaw > maxAllowedMergeTime ? maxAllowedMergeTime : deletedTimeRaw;
        };
        let winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
        const preferDeletedCandidate = (left: T, right: T): T => {
            if (left.deletedAt && !right.deletedAt) return left;
            if (right.deletedAt && !left.deletedAt) return right;
            return chooseDeterministicWinner(left, right, signatureMemo);
        };
        const preferLiveCandidate = (left: T, right: T): T => {
            if (left.deletedAt && !right.deletedAt) return right;
            if (right.deletedAt && !left.deletedAt) return left;
            return chooseDeterministicWinner(left, right, signatureMemo);
        };
        const resolveDeleteVsLiveWinner = (
            localCandidate: T,
            incomingCandidate: T,
        ): { winner: T; preservedLiveInAmbiguousWindow: boolean; operationDiffMs: number } => {
            const localOpTime = resolveOperationTime(localCandidate, localUpdatedTime);
            const incomingOpTime = resolveOperationTime(incomingCandidate, incomingUpdatedTime);
            const operationDiff = incomingOpTime - localOpTime;
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

        if (hasRevision) {
            if (localDeleted !== incomingDeleted) {
                const resolution = resolveDeleteVsLiveWinner(normalizedLocalItem, normalizedIncomingItem);
                winner = resolution.winner;
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
            } else if (revDiff !== 0) {
                winner = revDiff > 0 ? normalizedLocalItem : normalizedIncomingItem;
            } else if (comparableUpdatedTimeDiff !== 0) {
                winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
            // Only use revBy when both sides provide it; otherwise older clients without revBy
            // fall back to deterministic convergence instead of silently losing to partial metadata.
            } else if (revByDiff && localRevBy && incomingRevBy) {
                winner = incomingRevBy > localRevBy ? normalizedIncomingItem : normalizedLocalItem;
            } else {
                winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem, signatureMemo);
            }
        } else if (localDeleted !== incomingDeleted) {
            const resolution = resolveDeleteVsLiveWinner(normalizedLocalItem, normalizedIncomingItem);
            winner = resolution.winner;
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
        } else {
            const hasInvalidTimestamp = localUpdatedTime.raw < 0 || incomingUpdatedTime.raw < 0;
            const requiresStrictTimestampOrdering = comparableUpdatedTimeDiff !== 0
                && (hasInvalidTimestamp || localUpdatedTime.wasClamped || incomingUpdatedTime.wasClamped);
            if (requiresStrictTimestampOrdering) {
                winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
            } else if (withinSkew) {
                winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem, signatureMemo);
            } else if (comparableUpdatedTimeDiff !== 0) {
                winner = comparableUpdatedTimeDiff > 0 ? normalizedIncomingItem : normalizedLocalItem;
            } else {
                winner = chooseDeterministicWinner(normalizedLocalItem, normalizedIncomingItem, signatureMemo);
            }
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

function mergeAreas(local: SyncMergeArea[], incoming: SyncMergeArea[]): { merged: Area[]; stats: EntityMergeStats } {
    const result = mergeEntitiesWithStats(local, incoming, undefined, undefined, 'area');
    let fallbackOrder = result.merged.reduce((maxOrder, area) => {
        const order = typeof area.order === 'number' && Number.isFinite(area.order) ? area.order : -1;
        return Math.max(maxOrder, order);
    }, -1) + 1;
    const merged: Area[] = result.merged.map((area) => {
        const order = typeof area.order === 'number' && Number.isFinite(area.order)
            ? area.order
            : fallbackOrder;
        const normalized: Area = { ...area, order };
        fallbackOrder += 1;
        return normalized;
    });
    return { merged, stats: result.stats };
}

export function filterDeleted<T extends { deletedAt?: string }>(items: T[]): T[] {
    return filterNotDeleted(items);
}

const getClockSkewWarning = (stats: MergeResult['stats']): ClockSkewWarning | undefined => {
    const candidates = [
        stats.tasks,
        stats.projects,
        stats.sections,
        stats.areas,
    ].filter((entityStats) =>
        (entityStats.maxClockSkewMs || 0) > CLOCK_SKEW_THRESHOLD_MS
        && !!entityStats.maxClockSkewDirection
    );
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
    const localNormalized = {
        ...local,
        tasks: (local.tasks || []).map((task) => normalizeRevisionMetadata(normalizeTaskForSyncMerge(task, nowIso))),
        projects: (local.projects || []).map((project) => normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))),
        sections: (local.sections || []).map((section) => normalizeRevisionMetadata(section)),
        areas: (local.areas || []).map((area) => normalizeRevisionMetadata(normalizeAreaForSyncMerge(area, nowIso))),
    };
    const incomingNormalized = {
        ...incoming,
        tasks: (incoming.tasks || []).map((task) => normalizeRevisionMetadata(normalizeTaskForSyncMerge(task, nowIso))),
        projects: (incoming.projects || []).map((project) => normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))),
        sections: (incoming.sections || []).map((section) => normalizeRevisionMetadata(section)),
        areas: (incoming.areas || []).map((area) => normalizeRevisionMetadata(normalizeAreaForSyncMerge(area, nowIso))),
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
                cloudKey: winner.deletedAt
                    ? winner.cloudKey
                    : winner.cloudKey || localAttachment.cloudKey || incomingAttachment.cloudKey,
                fileHash: winner.deletedAt
                    ? winner.fileHash
                    : winner.fileHash || localAttachment.fileHash || incomingAttachment.fileHash,
                uri,
                localStatus,
            };
        }, undefined, 'attachment').merged;

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
        normalizeTaskForContentComparison,
        'task'
    );

    const projectsResult = mergeEntitiesWithStats(
        localNormalized.projects,
        incomingNormalized.projects,
        (localProject: Project, incomingProject: Project, winner: Project) => {
            const attachments = mergeAttachments(localProject.attachments, incomingProject.attachments);
            return { ...winner, attachments };
        },
        normalizeProjectForContentComparison,
        'project'
    );

    const sectionsResult = mergeEntitiesWithStats(
        localNormalized.sections,
        incomingNormalized.sections,
        undefined,
        normalizeSectionForContentComparison,
        'section'
    );

    const areasResult = mergeAreas(localNormalized.areas, incomingNormalized.areas);

    const stats = {
        tasks: tasksResult.stats,
        projects: projectsResult.stats,
        sections: sectionsResult.stats,
        areas: areasResult.stats,
    };

    return {
        data: repairMergedSyncReferences({
            tasks: tasksResult.merged,
            projects: projectsResult.merged,
            sections: sectionsResult.merged,
            areas: areasResult.merged,
            settings: mergeSettingsForSync(localNormalized.settings, incomingNormalized.settings),
        }, nowIso),
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

const withPendingRemoteWriteRetry = (data: AppData, nowIso: string): AppData => {
    const nextAttempts = getPendingRemoteWriteAttemptCount(data) + 1;
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
            pendingRemoteWriteRetryAt: retryAt,
            pendingRemoteWriteAttempts: nextAttempts,
        },
    };
};

export async function performSyncCycle(io: SyncCycleIO): Promise<SyncCycleResult> {
    const nowIso = io.now ? io.now() : new Date().toISOString();
    const yieldToUi = async () => {
        if (typeof io.yieldToUi === 'function') {
            await io.yieldToUi();
        }
    };

    const readLocalDataForSync = async (): Promise<AppData> => {
        io.onStep?.('read-local');
        await yieldToUi();
        const localDataRaw = await io.readLocal();
        const localShapeErrors = validateSyncPayloadShape(localDataRaw, 'local');
        if (localShapeErrors.length > 0) {
            const sample = localShapeErrors.slice(0, 3).join('; ');
            throw new Error(`Invalid local sync payload: ${sample}`);
        }
        const localNormalized = normalizeAppData(localDataRaw);
        return purgeExpiredTombstones(localNormalized, nowIso, io.tombstoneRetentionDays).data;
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
            throw new Error(`Sync paused briefly after remote write failure. Retry in about ${seconds}s.`);
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
    const mergeResult = mergeAppDataWithStats(localData, remoteData, { nowIso });
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
                direction: mergeResult.clockSkewWarning?.direction,
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
    if (
        pruned.removedTaskTombstones > 0
        || pruned.removedProjectTombstones > 0
        || pruned.removedSectionTombstones > 0
        || pruned.removedAreaTombstones > 0
        || pruned.removedAttachmentTombstones > 0
        || pruned.removedPendingRemoteDeletes > 0
    ) {
        logWarn('Purged expired sync tombstones', {
            scope: 'sync',
            context: {
                removedTaskTombstones: pruned.removedTaskTombstones,
                removedProjectTombstones: pruned.removedProjectTombstones,
                removedSectionTombstones: pruned.removedSectionTombstones,
                removedAreaTombstones: pruned.removedAreaTombstones,
                removedAttachmentTombstones: pruned.removedAttachmentTombstones,
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

    const finalDataWithPendingRemoteWrite = withPendingRemoteWriteFlag(
        finalData,
        pendingRemoteWriteMeta?.pendingAt ?? nowIso,
        pendingRemoteWriteMeta?.attempts,
    );
    const persistedFinalData = clearPendingRemoteWriteFlag(finalDataWithPendingRemoteWrite);
    io.onStep?.('write-local');
    await yieldToUi();
    await io.writeLocal(finalDataWithPendingRemoteWrite);

    io.onStep?.('write-remote');
    await yieldToUi();
    try {
        await io.writeRemote(persistedFinalData);
    } catch (error) {
        const localDataWithRetry = withPendingRemoteWriteRetry(finalDataWithPendingRemoteWrite, nowIso);
        io.onStep?.('write-local');
        await yieldToUi();
        await io.writeLocal(localDataWithRetry);
        throw error;
    }

    io.onStep?.('write-local');
    await yieldToUi();
    await io.writeLocal(persistedFinalData);

    return {
        data: persistedFinalData,
        stats: mergeResult.stats,
        status: nextSyncStatus,
        clockSkewWarning: mergeResult.clockSkewWarning,
    };
}
