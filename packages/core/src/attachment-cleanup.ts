import type { AppData, Attachment, PendingRemoteAttachmentDelete } from './types';
import { normalizePendingRemoteDeletes } from './attachment-transfer';
import { isFileSyncGenerationCloudKey } from './attachment-paths';
import { getErrorStatus } from './sync-runtime-utils';
import { sanitizeAttachmentCloudKeyForSyncMerge } from './sync-normalization';

export const PENDING_REMOTE_ATTACHMENT_DELETE_MAX_ATTEMPTS = 12;
export const PENDING_REMOTE_ATTACHMENT_DELETE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CleanupResult {
    orphanedCount: number;
    cleanedIds: string[];
    errors: Array<{ id: string; error: string }>;
}

export function findOrphanedAttachments(appData: AppData): Attachment[] {
    const allAttachments = new Map<string, Attachment>();
    const activeReferenceIds = new Set<string>();

    for (const task of appData.tasks) {
        const taskPurged = Boolean(task.purgedAt);
        for (const attachment of task.attachments || []) {
            allAttachments.set(attachment.id, attachment);
            if (!taskPurged && !attachment.deletedAt) {
                activeReferenceIds.add(attachment.id);
            }
        }
    }

    for (const project of appData.projects) {
        const projectPurged = Boolean(project.purgedAt);
        for (const attachment of project.attachments || []) {
            allAttachments.set(attachment.id, attachment);
            if (!projectPurged && !attachment.deletedAt) {
                activeReferenceIds.add(attachment.id);
            }
        }
    }

    return Array.from(allAttachments.values()).filter((attachment) => !activeReferenceIds.has(attachment.id));
}

/** Attachment ids whose parent task/project is purged. These records never
 *  reach a peer (purged tombstones are compacted for the remote payload), so
 *  removing them from the doc is the one removal sync cannot resurrect. */
function findPurgedParentAttachmentIds(appData: AppData): Set<string> {
    const ids = new Set<string>();
    for (const task of appData.tasks) {
        if (!task.purgedAt) continue;
        for (const attachment of task.attachments || []) ids.add(attachment.id);
    }
    for (const project of appData.projects) {
        if (!project.purgedAt) continue;
        for (const attachment of project.attachments || []) ids.add(attachment.id);
    }
    return ids;
}

/**
 * Whether cleanup has work it should not wait the daily interval for (#1064).
 *
 * Soft-deleted records STAY in the doc as tombstones — removing them never
 * stuck, because the merge unions attachments by id and the peer's copy
 * resurrected the record next cycle, renewing an attachments conflict forever.
 * "Processed" is therefore marked on the record instead: `localStatus`
 * becomes 'missing' once this device has dealt with its local file (the field
 * never syncs), and `cloudKey` is cleared once the remote copy is gone (that
 * change syncs, so peers do not re-delete). Failed remote deletes move to
 * pendingRemoteDeletes, which deliberately waits for the interval so retries
 * don't burn the attempt budget in minutes.
 */
export function hasFreshAttachmentCleanupWork(appData: AppData): boolean {
    const pendingRemoteDeletes = normalizePendingRemoteDeletes(appData.settings.attachments?.pendingRemoteDeletes);
    // A fresh File Sync publication journal is safe to reconcile only after the
    // authoritative document write returns. This predicate runs at exactly that
    // boundary, so process it immediately; failed deletes increment attempts and
    // fall back to the existing bounded cleanup interval instead of hot-looping.
    if (
        pendingRemoteDeletes.some(
            (entry) => isFileSyncGenerationCloudKey(entry.cloudKey) && (entry.attempts ?? 0) === 0,
        )
    ) {
        return true;
    }
    const pendingCloudKeys = new Set(pendingRemoteDeletes.map((entry) => entry.cloudKey));
    const hasWork = (attachments: readonly Attachment[] | undefined, parentPurged: boolean): boolean => {
        if (!attachments?.length) return false;
        if (parentPurged) return true;
        return attachments.some((attachment) => {
            if (!attachment.deletedAt) return false;
            if (attachment.kind === 'file' && attachment.localStatus !== 'missing') return true;
            const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(attachment.cloudKey);
            return Boolean(cloudKey && !pendingCloudKeys.has(cloudKey));
        });
    };
    return appData.tasks.some((task) => hasWork(task.attachments, Boolean(task.purgedAt)))
        || appData.projects.some((project) => hasWork(project.attachments, Boolean(project.purgedAt)));
}

export function findDeletedAttachmentsForFileCleanup(appData: AppData): Attachment[] {
    const deleted = new Map<string, Attachment>();

    for (const task of appData.tasks) {
        for (const attachment of task.attachments || []) {
            if (!attachment.deletedAt) continue;
            deleted.set(attachment.id, attachment);
        }
    }

    for (const project of appData.projects) {
        for (const attachment of project.attachments || []) {
            if (!attachment.deletedAt) continue;
            deleted.set(attachment.id, attachment);
        }
    }

    return Array.from(deleted.values());
}

export type LiveAttachmentResourceReferences = {
    localUris: ReadonlySet<string>;
    cloudKeys: ReadonlySet<string>;
};

export type AttachmentCleanupRemoteTarget = {
    cloudKey: string;
    title: string;
};

export type AttachmentCleanupRemoteDelete = (
    target: AttachmentCleanupRemoteTarget,
) => Promise<void>;

export type AttachmentCleanupLifecycleOptions = {
    appData: AppData;
    deleteLocalAttachment: (attachment: Attachment) => Promise<void>;
    deleteRemoteAttachment?: AttachmentCleanupRemoteDelete;
    resolveRemoteDeleteAttachment?: () => Promise<AttachmentCleanupRemoteDelete | undefined>;
    /**
     * Treat the remote object as intentionally retained while clearing local
     * cleanup bookkeeping. File Sync uses this for immutable generations:
     * without a distributed GC tombstone, a peer can reselect any existing
     * generation between its existence check and document CAS.
     */
    shouldRetainRemoteAttachment?: (target: AttachmentCleanupRemoteTarget) => boolean;
    now?: () => string;
    maxAttachmentTargets?: number;
    beforeEachAttachment?: () => void | Promise<void>;
    beforeEachRemoteDelete?: () => void | Promise<void>;
    isRemoteMissingError?: (error: unknown) => boolean;
    onRemoteAttachmentMissing?: (target: AttachmentCleanupRemoteTarget) => void;
    onRemoteDeleteError?: (target: AttachmentCleanupRemoteTarget, error: unknown) => void;
    onBatchLimitReached?: (info: { limit: number; total: number }) => void;
};

export type AttachmentCleanupLifecycleResult = {
    appData: AppData;
    orphanedAttachments: readonly Attachment[];
    processedOrphanedIds: ReadonlySet<string>;
    reachedBatchLimit: boolean;
    shouldInvalidateFastSyncState: boolean;
};

const isLocalSyncAbortError = (error: unknown): boolean => (
    error instanceof Error && error.name === 'LocalSyncAbort'
);

// Both spellings of the same file reach us: percent-encoded (file:// URIs) and
// decoded (plain paths), plus `\` separators on Windows. Collapsing them keeps a
// live reference from being missed, which would delete a file still in use.
export function normalizeAttachmentCleanupUri(uri?: string): string | undefined {
    if (!uri) return undefined;
    if (/^https?:\/\//i.test(uri) || uri.startsWith('content://')) return undefined;
    let path = uri.replace(/^file:\/\//i, '').replace(/\\/g, '/');
    // A canonical Windows file URI spells C:\ as file:///C:/; strip the URI's
    // extra root slash before applying Windows' case-insensitive identity.
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    try {
        path = decodeURIComponent(path);
    } catch {
        // Keep the undecoded spelling; malformed user paths must not abort GC.
    }
    return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

export function findLiveAttachmentResourceReferences(appData: AppData): LiveAttachmentResourceReferences {
    const localUris = new Set<string>();
    const cloudKeys = new Set<string>();

    const collect = (attachments: readonly Attachment[] | undefined, parentDeleted: boolean) => {
        if (parentDeleted) return;
        for (const attachment of attachments || []) {
            if (attachment.deletedAt) continue;
            const localUri = normalizeAttachmentCleanupUri(attachment.uri);
            if (localUri) localUris.add(localUri);
            // Lookups sanitize before comparing, so the live set must too.
            const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(attachment.cloudKey);
            if (cloudKey) cloudKeys.add(cloudKey);
        }
    };

    for (const task of appData.tasks) {
        collect(task.attachments, Boolean(task.purgedAt));
    }

    for (const project of appData.projects) {
        collect(project.attachments, Boolean(project.purgedAt));
    }

    return { localUris, cloudKeys };
}

export function isAttachmentLocalResourceReferenced(
    attachment: Attachment,
    references: LiveAttachmentResourceReferences,
): boolean {
    const localUri = normalizeAttachmentCleanupUri(attachment.uri);
    return Boolean(localUri && references.localUris.has(localUri));
}

export function isAttachmentCloudResourceReferenced(
    attachment: Pick<Attachment, 'cloudKey'>,
    references: LiveAttachmentResourceReferences,
): boolean {
    return Boolean(attachment.cloudKey && references.cloudKeys.has(attachment.cloudKey));
}


export type AttachmentCleanupApplyResult = {
    lastCleanupAt: string;
    pendingRemoteDeletes?: readonly PendingRemoteAttachmentDelete[];
    orphanedAttachments?: readonly Attachment[];
    processedOrphanedIds?: Iterable<string>;
    reachedBatchLimit?: boolean;
    /** Purged-parent record ids to drop from the doc — the only removal the
     *  merge cannot resurrect (#1064). */
    removableAttachmentIds?: Iterable<string>;
    /** File tombstones whose local file this device has dealt with; stamped
     *  `localStatus: 'missing'` (device-local, never syncs). */
    processedFileTombstoneIds?: Iterable<string>;
    /** Cloud keys whose remote copy is confirmed gone (deleted, 404, or still
     *  referenced by a live record); cleared from tombstones with a fresh
     *  `updatedAt` so the clear wins the per-attachment merge and syncs. */
    clearedCloudKeys?: Iterable<string>;
};

const parseTimestampMs = (value: unknown): number | null => {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
};

export function shouldRetainPendingRemoteAttachmentDelete(
    entry: PendingRemoteAttachmentDelete,
    nowIso: string,
): boolean {
    const attempts = typeof entry.attempts === 'number' && Number.isFinite(entry.attempts)
        ? Math.max(0, Math.floor(entry.attempts))
        : 0;
    if (attempts >= PENDING_REMOTE_ATTACHMENT_DELETE_MAX_ATTEMPTS) return false;

    const lastErrorMs = parseTimestampMs(entry.lastErrorAt);
    if (lastErrorMs === null) return true;
    const nowMs = parseTimestampMs(nowIso);
    if (nowMs === null) return true;
    return nowMs - lastErrorMs <= PENDING_REMOTE_ATTACHMENT_DELETE_MAX_AGE_MS;
}

export function prunePendingRemoteAttachmentDeletes(
    pendingRemoteDeletes: readonly PendingRemoteAttachmentDelete[] | undefined,
    nowIso: string,
): PendingRemoteAttachmentDelete[] {
    if (!pendingRemoteDeletes?.length) return [];
    return pendingRemoteDeletes.filter((entry) =>
        shouldRetainPendingRemoteAttachmentDelete(entry, nowIso)
    );
}

export function applyAttachmentCleanupResult(appData: AppData, result: AttachmentCleanupApplyResult): AppData {
    const removableIds = new Set(result.removableAttachmentIds ?? []);
    const processedFileTombstoneIds = new Set(result.processedFileTombstoneIds ?? []);
    const clearedCloudKeys = new Set(result.clearedCloudKeys ?? []);
    const markProcessed = (attachment: Attachment): Attachment => {
        let next = attachment;
        if (processedFileTombstoneIds.has(attachment.id) && attachment.localStatus !== 'missing') {
            next = { ...next, localStatus: 'missing' };
        }
        const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(next.cloudKey);
        if (next.deletedAt && cloudKey && clearedCloudKeys.has(cloudKey)) {
            next = { ...next, cloudKey: undefined, updatedAt: result.lastCleanupAt };
        }
        return next;
    };
    const cleaned = removableIds.size > 0 || processedFileTombstoneIds.size > 0 || clearedCloudKeys.size > 0
        ? {
            ...appData,
            tasks: appData.tasks.map((task) => ({
                ...task,
                attachments: task.attachments
                    ?.filter((attachment) => !removableIds.has(attachment.id))
                    .map(markProcessed),
            })),
            projects: appData.projects.map((project) => ({
                ...project,
                attachments: project.attachments
                    ?.filter((attachment) => !removableIds.has(attachment.id))
                    .map(markProcessed),
            })),
        }
        : appData;
    const pendingRemoteDeletes = prunePendingRemoteAttachmentDeletes(
        result.pendingRemoteDeletes,
        result.lastCleanupAt,
    );
    const nextPendingRemoteDeletes = pendingRemoteDeletes.length
        ? pendingRemoteDeletes
        : undefined;

    return {
        ...cleaned,
        settings: {
            ...cleaned.settings,
            attachments: {
                ...cleaned.settings.attachments,
                lastCleanupAt: result.lastCleanupAt,
                pendingRemoteDeletes: nextPendingRemoteDeletes,
            },
        },
    };
}

export async function runAttachmentCleanupLifecycle(
    options: AttachmentCleanupLifecycleOptions,
): Promise<AttachmentCleanupLifecycleResult> {
    const orphanedAttachments = findOrphanedAttachments(options.appData);
    const deletedAttachments = findDeletedAttachmentsForFileCleanup(options.appData);
    const cleanupTargets = new Map<string, Attachment>();
    for (const attachment of orphanedAttachments) cleanupTargets.set(attachment.id, attachment);
    for (const attachment of deletedAttachments) cleanupTargets.set(attachment.id, attachment);

    const previousPendingRemoteDeletes = normalizePendingRemoteDeletes(
        options.appData.settings.attachments?.pendingRemoteDeletes,
    );
    const previousPendingByCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const pending of previousPendingRemoteDeletes) {
        const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(pending.cloudKey);
        if (!cloudKey) continue;
        previousPendingByCloudKey.set(cloudKey, { ...pending, cloudKey });
    }

    const liveResourceReferences = findLiveAttachmentResourceReferences(options.appData);
    const remoteCleanupTargets = new Map<string, AttachmentCleanupRemoteTarget>();
    for (const pending of previousPendingByCloudKey.values()) {
        if (isAttachmentCloudResourceReferenced(pending, liveResourceReferences)) continue;
        remoteCleanupTargets.set(pending.cloudKey, {
            cloudKey: pending.cloudKey,
            title: pending.title || pending.cloudKey,
        });
    }

    const requestedLimit = options.maxAttachmentTargets;
    const maxAttachmentTargets = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
        ? Math.max(0, Math.floor(requestedLimit))
        : Number.POSITIVE_INFINITY;
    let reachedBatchLimit = cleanupTargets.size > maxAttachmentTargets;
    const orphanedIds = new Set(orphanedAttachments.map((attachment) => attachment.id));
    const purgedParentAttachmentIds = findPurgedParentAttachmentIds(options.appData);
    const processedOrphanedIds = new Set<string>();
    const processedFileTombstoneIds = new Set<string>();
    const clearedCloudKeys = new Set<string>();
    let processedCount = 0;

    for (const attachment of cleanupTargets.values()) {
        if (processedCount >= maxAttachmentTargets) break;
        processedCount += 1;
        if (orphanedIds.has(attachment.id)) {
            processedOrphanedIds.add(attachment.id);
        }
        await options.beforeEachAttachment?.();
        const alreadyStampedTombstone = Boolean(attachment.deletedAt) && attachment.localStatus === 'missing';
        if (!alreadyStampedTombstone && !isAttachmentLocalResourceReferenced(attachment, liveResourceReferences)) {
            await options.deleteLocalAttachment(attachment);
        }
        // Attempted counts as processed: the pre-#1064 flow dropped the record
        // outright here, so a failed local delete was never retried either —
        // the marker keeps that bar while letting the tombstone survive.
        if (attachment.kind === 'file' && !purgedParentAttachmentIds.has(attachment.id)) {
            processedFileTombstoneIds.add(attachment.id);
        }
        const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(attachment.cloudKey);
        if (!cloudKey) continue;
        if (isAttachmentCloudResourceReferenced({ cloudKey }, liveResourceReferences)) {
            // A live record shares this remote file; the tombstone must not
            // keep pointing at it or it would re-trigger cleanup forever.
            clearedCloudKeys.add(cloudKey);
            continue;
        }
        remoteCleanupTargets.set(cloudKey, {
            cloudKey,
            title: attachment.title || cloudKey,
        });
    }

    const lastCleanupAt = (options.now ?? (() => new Date().toISOString()))();
    const nextPendingRemoteDeletesByCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    const remoteTargetsInBatch = Array.from(remoteCleanupTargets.values()).slice(0, maxAttachmentTargets);
    const remoteDeleteTargetCount = remoteTargetsInBatch
        .filter((target) => !options.shouldRetainRemoteAttachment?.(target))
        .length;
    if (remoteCleanupTargets.size > maxAttachmentTargets) reachedBatchLimit = true;
    const deleteRemoteAttachment = options.deleteRemoteAttachment
        ?? (
            remoteDeleteTargetCount > 0 && maxAttachmentTargets > 0
                ? await options.resolveRemoteDeleteAttachment?.()
                : undefined
        );
    let processedRemoteTargetCount = 0;
    for (const target of remoteCleanupTargets.values()) {
        const previous = previousPendingByCloudKey.get(target.cloudKey);
        if (processedRemoteTargetCount >= maxAttachmentTargets) {
            nextPendingRemoteDeletesByCloudKey.set(target.cloudKey, {
                cloudKey: target.cloudKey,
                title: target.title,
                attempts: previous?.attempts ?? 0,
                lastErrorAt: previous?.lastErrorAt,
            });
            continue;
        }
        processedRemoteTargetCount += 1;
        if (options.shouldRetainRemoteAttachment?.(target)) {
            // Clearing the tombstone's cloudKey and any legacy pending entry is
            // safe; deleting the immutable File Sync object is not.
            clearedCloudKeys.add(target.cloudKey);
            continue;
        }
        if (!deleteRemoteAttachment) {
            nextPendingRemoteDeletesByCloudKey.set(target.cloudKey, {
                cloudKey: target.cloudKey,
                title: target.title,
                attempts: previous?.attempts ?? 0,
                lastErrorAt: previous?.lastErrorAt,
            });
            continue;
        }

        await options.beforeEachRemoteDelete?.();
        try {
            await deleteRemoteAttachment(target);
            clearedCloudKeys.add(target.cloudKey);
        } catch (error) {
            // Freshness guards deliberately throw this sentinel. It must abort
            // the whole cycle rather than being converted into a retryable
            // provider failure/pending delete.
            if (isLocalSyncAbortError(error)) throw error;
            if (getErrorStatus(error) === 404 || options.isRemoteMissingError?.(error)) {
                options.onRemoteAttachmentMissing?.(target);
                clearedCloudKeys.add(target.cloudKey);
                continue;
            }
            options.onRemoteDeleteError?.(target, error);
            nextPendingRemoteDeletesByCloudKey.set(target.cloudKey, {
                cloudKey: target.cloudKey,
                title: target.title,
                attempts: (previous?.attempts ?? 0) + 1,
                lastErrorAt: lastCleanupAt,
            });
        }
    }

    if (reachedBatchLimit && Number.isFinite(maxAttachmentTargets)) {
        options.onBatchLimitReached?.({
            limit: maxAttachmentTargets,
            total: Math.max(cleanupTargets.size, remoteCleanupTargets.size),
        });
    }

    const removableAttachmentIds = Array.from(processedOrphanedIds)
        .filter((id) => purgedParentAttachmentIds.has(id));
    const appData = applyAttachmentCleanupResult(options.appData, {
        lastCleanupAt,
        orphanedAttachments,
        pendingRemoteDeletes: Array.from(nextPendingRemoteDeletesByCloudKey.values()),
        processedOrphanedIds,
        reachedBatchLimit,
        removableAttachmentIds,
        processedFileTombstoneIds,
        clearedCloudKeys,
    });

    return {
        appData,
        orphanedAttachments,
        processedOrphanedIds,
        reachedBatchLimit,
        // Only remote-visible changes need the fast unchanged-check invalidated:
        // record removals and cloudKey clears travel; localStatus stamps never do.
        shouldInvalidateFastSyncState: removableAttachmentIds.length > 0 || clearedCloudKeys.size > 0,
    };
}
