import {
    applyAttachmentContentStat,
    bumpAttachmentContentRevision,
    checkAttachmentContentChange,
    type LocalFileStat,
} from './attachment-change-detection';
import { computeSha256Hex, isSha256Hex } from './attachment-hash';
import { globalProgressTracker } from './attachment-progress';
import type { AppData, Attachment, AttachmentSettings } from './types';

type PendingRemoteAttachmentDeleteEntry = NonNullable<AttachmentSettings['pendingRemoteDeletes']>[number];

export const normalizePendingRemoteDeletes = (
    value: unknown,
): PendingRemoteAttachmentDeleteEntry[] => {
    if (!Array.isArray(value)) return [];
    const deduped = new Map<string, PendingRemoteAttachmentDeleteEntry>();
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const cloudKey = typeof item.cloudKey === 'string' ? item.cloudKey.trim() : '';
        if (!cloudKey) continue;
        const next: PendingRemoteAttachmentDeleteEntry = {
            cloudKey,
            title: typeof item.title === 'string' ? item.title : undefined,
            attempts: typeof item.attempts === 'number' && Number.isFinite(item.attempts)
                ? Math.max(0, Math.floor(item.attempts))
                : 0,
            lastErrorAt: typeof item.lastErrorAt === 'string' ? item.lastErrorAt : undefined,
        };
        const existing = deduped.get(cloudKey);
        if (!existing || (next.attempts ?? 0) >= (existing.attempts ?? 0)) {
            deduped.set(cloudKey, next);
        }
    }
    return Array.from(deduped.values());
};

/**
 * Fail closed: once an attachment carries a usable digest, bytes that don't match it —
 * and bytes we cannot digest at all — are both rejected. Silently skipping either turns
 * the whole integrity check off on any platform without a digest (Hermes has no
 * WebCrypto; see setSha256HexProvider). A `fileHash` that is not a syntactically valid
 * digest is the one thing left unvalidated, because there is nothing to compare against;
 * the sync-merge normalizer drops those before they reach here.
 */
export const validateAttachmentHash = async (attachment: Attachment, bytes: Uint8Array): Promise<void> => {
    const expected = attachment.fileHash;
    if (!isSha256Hex(expected)) return;
    const computed = await computeSha256Hex(bytes);
    if (!computed) {
        throw new Error('Integrity validation unavailable: no SHA-256 implementation');
    }
    if (computed.toLowerCase() !== expected.toLowerCase()) {
        throw new Error('Integrity validation failed');
    }
};

/**
 * Stats we already failed to hash, keyed by attachment id (BUG-16). A file whose stat
 * moved but whose bytes could not be read would otherwise be re-read on every single
 * cycle — up to the 50 MB attachment cap each time — with nothing to show for it. The
 * marker is deliberately in-memory and device-local: it describes this device's failed
 * read, not synced content. Ceiling: cleared on restart, which costs one extra read.
 */
const unhashableStats = new Map<string, string>();

const statMarker = (stat: LocalFileStat): string => `${stat.mtimeMs}:${stat.size}`;

export const resetUnhashableAttachmentStatsForTests = (): void => {
    unhashableStats.clear();
};

export const reportProgress = (
    attachmentId: string,
    operation: 'upload' | 'download',
    loaded: number,
    total: number,
    status: 'active' | 'completed' | 'failed',
    error?: string,
) => {
    const percentage = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    globalProgressTracker.updateProgress(attachmentId, {
        operation,
        bytesTransferred: loaded,
        totalBytes: total,
        percentage,
        status,
        error,
    });
};

/**
 * Collect the live attachment objects of non-deleted tasks and projects, keyed
 * by id. The map holds the same object references that sit inside `appData`.
 * {@link runAttachmentTransferLifecycle} never mutates them — it works on
 * per-attachment copies and reports changes as patches for
 * {@link applyAttachmentPatches} to fold into a fresh document.
 */
export const collectAttachmentsById = (appData: AppData): Map<string, Attachment> => {
    const attachmentsById = new Map<string, Attachment>();
    for (const task of appData.tasks) {
        if (task.deletedAt) continue;
        for (const attachment of task.attachments || []) {
            attachmentsById.set(attachment.id, attachment);
        }
    }
    for (const project of appData.projects) {
        if (project.deletedAt) continue;
        for (const attachment of project.attachments || []) {
            attachmentsById.set(attachment.id, attachment);
        }
    }
    return attachmentsById;
};

/** Immutable byte source prepared immediately before an attachment upload.
 * Adapters may provide in-memory bytes (desktop/small mobile transports) or a
 * private staged path (streaming mobile transports), but every retry must read
 * this source rather than the live attachment URI. */
export type AttachmentUploadSnapshot = {
    sourcePath: string;
    fileHash: string;
    stat: LocalFileStat;
    bytes?: Uint8Array;
    dispose: () => Promise<void>;
};

export type AttachmentTransferLifecycleOptions = {
    attachmentsById: Map<string, Attachment>;
    localFileExists: (path: string, attachment: Attachment) => Promise<boolean>;
    onUpload: (
        attachment: Attachment,
        localPath: string,
        snapshot?: AttachmentUploadSnapshot,
    ) => Promise<boolean>;
    onUploadError: (attachment: Attachment, error: unknown) => void;
    onDownload: (attachment: Attachment) => Promise<boolean>;
    onDownloadError: (attachment: Attachment, error: unknown) => void;
    resolveLocalPath?: (uri: string) => string;
    /**
     * Byte-source containment (SEC-07). `uri` travels inside the synced document and an
     * absolute path there passes the merge sanitizer, so without this a hostile sync
     * document makes the next cycle read an arbitrary local file and upload it to the
     * remote. Each platform supplies its managed-attachment-directory predicate; a
     * refused attachment still gets its `localStatus` reconciled, but is never read,
     * hashed, or uploaded. Omitting it (the default) allows everything, unchanged.
     */
    canUploadFrom?: (localPath: string, attachment: Attachment) => boolean;
    beforeEachAttachment?: () => Promise<void>;
    /**
     * Whether `attachment` already has a cloud copy. Defaults to `Boolean(attachment.cloudKey)`.
     * CloudKit overrides this: a `cloudKey` written by a different backend before a provider
     * switch isn't a valid CloudKit record key, so CloudKit must still treat it as needing upload.
     */
    hasCloudCopy?: (attachment: Attachment) => boolean;
    /**
     * Prepare-phase safety: inspect local content and record a durable pending
     * candidate, but do not mutate remote bytes until after the remote document
     * has been merged. Missing-cloud-key uploads are deferred as well.
     */
    deferUploads?: boolean;
    /**
     * Optional throttle/backoff/cap gate. Every field is optional, and the whole object may be
     * omitted; omitting it (the default) preserves today's unthrottled behaviour, so the callers
     * that don't need it are unaffected. A backend that needs rate-limit protection (e.g. WebDAV)
     * supplies these as closures over its own counters and backoff state.
     */
    policy?: {
        /** Return true to skip `attachment` entirely this run (including its local-status
         *  refresh) — e.g. once a backend has detected it is rate-limited. */
        shouldSkip?: (attachment: Attachment) => boolean;
        /** Gate before attempting an upload, e.g. to enforce a per-run upload cap. */
        shouldUpload?: (attachment: Attachment) => boolean;
        /** Gate before attempting a download, e.g. to enforce a per-run download cap or a
         *  per-attachment backoff window. */
        shouldDownload?: (attachment: Attachment) => boolean;
    };
    /**
     * Predicate for errors that must abort the whole lifecycle run rather than being treated as
     * an isolated per-attachment failure — e.g. an AbortSignal firing mid-transfer. When it
     * matches an upload/download error, the lifecycle rethrows immediately instead of calling
     * onUploadError/onDownloadError: the promise this function returns rejects and the whole
     * run's patches go with it, so the caller's document is byte-identical to what it passed
     * in. Only the side effects the callbacks performed outside the document (bytes already
     * uploaded, files already written) are the caller's to reason about.
     */
    isFatalError?: (error: unknown) => boolean;
    /**
     * Check-on-touch content-change detection (#1057). Both optional; omitting either
     * (the default) preserves today's behaviour exactly — an attachment with a cloud
     * copy that's already present locally is left alone, same as before this feature.
     * Supplying both turns on, for every attachment that already `hasCloudCopy` and
     * exists locally, the cheap mtime/size compare against the attachment's recorded
     * `contentMtimeMs`/`contentSize`, hash-confirmed via `computeLocalFileHash` before
     * anything is treated as a real change.
     */
    getLocalFileStat?: (path: string, attachment: Attachment) => Promise<LocalFileStat | null>;
    /** Only invoked when the cheap stat compare already mismatched. */
    computeLocalFileHash?: (path: string, attachment: Attachment) => Promise<string | null>;
    /** Prepare one immutable upload source and its digest. When present, the
     * lifecycle never asks the uploader to reread the live attachment path. */
    createUploadSnapshot?: (
        path: string,
        attachment: Attachment,
    ) => Promise<AttachmentUploadSnapshot | null>;
    /** Production backends opt in so a missing/unhashable snapshot fails closed
     * instead of silently falling back to the mutable live path. */
    requireUploadSnapshot?: boolean;
    /**
     * Which half of the sync cycle this call represents (see sync-run.ts's
     * `SyncRunAttachmentPhase`). Meaningless without `getLocalFileStat`. A confirmed
     * content change is only ever this device's own edit during 'prepare' (it runs on
     * local data before this cycle's remote pull/merge, so there is nothing else it
     * could be) — record a deferred upload candidate. During 'post-merge', a surviving
     * candidate uploads; an unmarked mismatch means the merge adopted another device's
     * newer content and this device's on-disk copy is stale, so it re-downloads instead.
     * Getting this backwards would ping-pong the two devices' uploads forever.
     */
    contentChangePhase?: 'prepare' | 'post-merge';
    /**
     * Called (review S3) when a post-merge re-download was about to overwrite a local
     * file, but a stat taken immediately before the download no longer matches the
     * stat that triggered detection — evidence of a local edit landing in the window
     * between this cycle's prepare pass and this post-merge pass. The download is
     * always skipped in that case (never optional); this is purely an observability
     * hook for callers that want to log it. The skipped attachment is retried as a
     * normal local edit by the next cycle's prepare pass.
     */
    onLocalEditRace?: (attachment: Attachment) => void;
};

export type AttachmentTransferResult = {
    /** True when at least one attachment changed (same meaning the old boolean had). */
    changed: boolean;
    /** Fresh attachment objects to swap in, keyed by attachment id. The input
     *  objects are never touched. */
    patches: Map<string, Attachment>;
};

/**
 * Fold lifecycle patches into a new document with copy-on-write structural
 * sharing: only owners holding a patched attachment are re-allocated (plus
 * their attachments array); every untouched task/project keeps its identity,
 * so the SQLite adapter's identity-keyed row cache stays valid for them and
 * only genuinely changed rows re-serialize. Returns the input unchanged when
 * there is nothing to apply.
 *
 * This replaces the old contract where the whole document had to be cloned up
 * front so the lifecycle could mutate it (#766 — a full clone of a 7k-task
 * library per cycle, busting the row cache for every row).
 */
export const applyAttachmentPatches = (
    appData: AppData,
    patches: Map<string, Attachment>,
): AppData => {
    if (patches.size === 0) return appData;
    let changed = false;
    const patchOwners = <T extends { deletedAt?: string; attachments?: Attachment[] }>(items: T[]): T[] => {
        let itemsChanged = false;
        const next = items.map((owner) => {
            if (owner.deletedAt || !owner.attachments?.some((attachment) => patches.has(attachment.id))) {
                return owner;
            }
            itemsChanged = true;
            return {
                ...owner,
                attachments: owner.attachments.map(
                    (attachment) => patches.get(attachment.id) ?? attachment,
                ),
            };
        });
        if (itemsChanged) changed = true;
        return itemsChanged ? next : items;
    };
    const tasks = patchOwners(appData.tasks);
    const projects = patchOwners(appData.projects);
    return changed ? { ...appData, tasks, projects } : appData;
};

/**
 * Companion to {@link applyAttachmentPatches} for the settings-level channel
 * backends use (`settings.attachments`, e.g. the pendingRemoteDeletes queue).
 * `undefined` means unchanged and returns the input as-is.
 */
export const withAttachmentSettingsPatch = (
    appData: AppData,
    attachmentSettings: AttachmentSettings | undefined,
): AppData => (
    attachmentSettings === undefined
        ? appData
        : { ...appData, settings: { ...appData.settings, attachments: attachmentSettings } }
);

const defaultResolveLocalPath = (uri: string): string => {
    if (!/^file:\/\//i.test(uri)) return uri;
    try {
        const parsed = new URL(uri);
        let path = decodeURIComponent(parsed.pathname);
        if (/^\/[A-Za-z]:\//.test(path)) {
            path = path.slice(1);
        }
        return path;
    } catch {
        return uri.replace(/^file:\/\//i, '');
    }
};

/**
 * Reconcile each file attachment's local presence with its cloud state:
 * refresh `localStatus`, upload local-only files, download cloud-only ones.
 *
 * Never mutates the input objects. Each attachment is processed on a shallow
 * working copy (the copy is what the upload/download callbacks receive and may
 * write to — `cloudKey`, `uri`, `localStatus`…), and every copy that changed is
 * returned as a patch. Callers fold the patches into a fresh document with
 * {@link applyAttachmentPatches} and persist THAT — the store's own objects and
 * the sync cycle's cached snapshots stay byte-stable, which is what the
 * serialization/signature layers and the SQLite identity-keyed row cache
 * rely on (#766).
 */
export async function runAttachmentTransferLifecycle(
    options: AttachmentTransferLifecycleOptions,
): Promise<AttachmentTransferResult> {
    const patches = new Map<string, Attachment>();
    const hasCloudCopy = options.hasCloudCopy ?? ((attachment: Attachment) => Boolean(attachment.cloudKey));
    const resolveLocalPath = options.resolveLocalPath ?? defaultResolveLocalPath;

    // First-transfer bookkeeping: populate contentMtimeMs/contentSize (and, on
    // upload, fileHash) from whatever's actually on disk once a transfer succeeds, so
    // the next cycle's check-on-touch compare has a baseline. Best-effort — a stat
    // failure here doesn't undo an otherwise-successful transfer.
    const refreshContentStat = async (attachment: Attachment, path: string): Promise<void> => {
        if (!options.getLocalFileStat) return;
        const stat = await options.getLocalFileStat(path, attachment).catch(() => null);
        if (stat) applyAttachmentContentStat(attachment, stat);
    };

    const attemptUpload = async (
        attachment: Attachment,
        localPath: string,
        expectedHash?: string,
    ): Promise<boolean> => {
        const snapshot = options.createUploadSnapshot
            ? await options.createUploadSnapshot(localPath, attachment)
            : null;
        if (!snapshot) {
            if (options.requireUploadSnapshot) return false;
            return await options.onUpload(attachment, localPath);
        }

        try {
            const snapshotHash = snapshot.fileHash.trim().toLowerCase();
            const normalizedExpectedHash = expectedHash?.trim().toLowerCase();
            if (!isSha256Hex(snapshotHash)
                || (expectedHash !== undefined
                    && (!isSha256Hex(normalizedExpectedHash) || snapshotHash !== normalizedExpectedHash))) {
                options.onLocalEditRace?.(attachment);
                return false;
            }
            if (!await options.onUpload(attachment, snapshot.sourcePath, snapshot)) return false;
            applyAttachmentContentStat(attachment, snapshot.stat, snapshotHash);
            return true;
        } finally {
            try {
                await snapshot.dispose();
            } catch (error) {
                // Cleanup failure must not discard a successful remote mutation;
                // surface it through the existing per-attachment warning channel.
                options.onUploadError(attachment, error);
            }
        }
    };

    for (const original of options.attachmentsById.values()) {
        await options.beforeEachAttachment?.();
        if (original.kind !== 'file') continue;
        if (original.deletedAt) continue;
        if (options.policy?.shouldSkip?.(original)) continue;

        // The working copy is the only object this iteration writes to. It is
        // recorded as a patch when anything changed; `original` stays pristine.
        const attachment: Attachment = { ...original };
        let itemMutated = false;
        let uploadedThisPass = false;

        const rawUri = attachment.uri ? resolveLocalPath(attachment.uri) : '';
        const isHttp = /^https?:\/\//i.test(rawUri);
        const localPath = isHttp ? '' : rawUri;
        const hasLocalPath = Boolean(localPath);
        const existsLocally = hasLocalPath
            ? await options.localFileExists(localPath, attachment)
            : false;

        const nextStatus: Attachment['localStatus'] = existsLocally ? 'available' : 'missing';
        if (attachment.localStatus !== nextStatus) {
            attachment.localStatus = nextStatus;
            itemMutated = true;
        }

        // Refused paths still reconcile localStatus above; what they never do is get read.
        const mayReadForSync = existsLocally && (options.canUploadFrom?.(localPath, attachment) ?? true);

        const hasPendingContentUpload = attachment.pendingContentUpload === true && hasCloudCopy(attachment);
        if (hasPendingContentUpload && !options.deferUploads) {
            // The marker describes the exact content identity selected by merge. Recheck
            // the file immediately before upload so an edit landing between prepare and
            // post-merge cannot be published under stale hash/revision metadata. A missing
            // or unhashable file fails closed and remains pending for the next prepare pass.
            if (
                !existsLocally
                && isSha256Hex(attachment.fileHash?.trim().toLowerCase())
                && (!options.policy?.shouldDownload || options.policy.shouldDownload(attachment))
            ) {
                // A crash can land after the blob upload but before the cleared
                // marker is durably saved. Let the adapter fetch and validate the
                // remote bytes against the pending hash, but isolate its metadata
                // mutations until it proves the same cloud identity is available
                // locally. Old/missing/unreadable remote bytes leave the durable
                // marker untouched for a later retry or user restoration.
                const expectedCloudKey = attachment.cloudKey;
                const expectedFileHash = attachment.fileHash!.trim().toLowerCase();
                const recovered: Attachment = { ...attachment };
                try {
                    const downloaded = await options.onDownload(recovered);
                    if (
                        downloaded
                        && recovered.cloudKey === expectedCloudKey
                        && recovered.fileHash?.trim().toLowerCase() === expectedFileHash
                        && recovered.localStatus === 'available'
                    ) {
                        recovered.pendingContentUpload = undefined;
                        const freshPath = recovered.uri ? resolveLocalPath(recovered.uri) : '';
                        if (freshPath) await refreshContentStat(recovered, freshPath);
                        Object.assign(attachment, recovered);
                        itemMutated = true;
                    }
                } catch (error) {
                    if (options.isFatalError?.(error)) throw error;
                    options.onDownloadError(attachment, error);
                }
            } else if (mayReadForSync && options.createUploadSnapshot) {
                if (!options.policy?.shouldUpload || options.policy.shouldUpload(attachment)) {
                    try {
                        if (await attemptUpload(attachment, localPath, attachment.fileHash)) {
                            attachment.pendingContentUpload = undefined;
                            itemMutated = true;
                        }
                    } catch (error) {
                        if (options.isFatalError?.(error)) throw error;
                        options.onUploadError(attachment, error);
                    }
                }
            } else if (mayReadForSync && options.getLocalFileStat) {
                const stat = await options.getLocalFileStat(localPath, attachment).catch(() => null);
                if (stat) {
                    const check = await checkAttachmentContentChange(
                        attachment,
                        stat,
                        () => options.computeLocalFileHash
                            ? options.computeLocalFileHash(localPath, attachment)
                            : Promise.resolve(null),
                    );
                    if (check.changed) {
                        options.onLocalEditRace?.(attachment);
                    } else {
                        if (
                            check.stat.mtimeMs !== attachment.contentMtimeMs
                            || check.stat.size !== attachment.contentSize
                        ) {
                            applyAttachmentContentStat(attachment, check.stat, check.hash);
                            itemMutated = true;
                        }
                        if (!options.policy?.shouldUpload || options.policy.shouldUpload(attachment)) {
                            try {
                                if (await attemptUpload(attachment, localPath, attachment.fileHash)) {
                                    attachment.pendingContentUpload = undefined;
                                    itemMutated = true;
                                    if (!options.createUploadSnapshot) {
                                        await refreshContentStat(attachment, localPath);
                                    }
                                }
                            } catch (error) {
                                if (options.isFatalError?.(error)) throw error;
                                options.onUploadError(attachment, error);
                            }
                        }
                    }
                }
            }

            // A pending candidate's cloud key still addresses the previous blob. Never
            // fall through to the ordinary download/change path until that candidate has
            // either uploaded successfully or lost a later merge.
            if (itemMutated) patches.set(attachment.id, attachment);
            continue;
        }

        if (!hasCloudCopy(attachment) && mayReadForSync && !options.deferUploads) {
            if (!options.policy?.shouldUpload || options.policy.shouldUpload(attachment)) {
                try {
                    if (await attemptUpload(attachment, localPath)) {
                        attachment.pendingContentUpload = undefined;
                        itemMutated = true;
                        uploadedThisPass = true;
                        if (!options.createUploadSnapshot && !attachment.fileHash && options.computeLocalFileHash) {
                            const hash = await options.computeLocalFileHash(localPath, attachment).catch(() => null);
                            if (hash) attachment.fileHash = hash;
                        }
                        if (!options.createUploadSnapshot) {
                            await refreshContentStat(attachment, localPath);
                        }
                    }
                } catch (error) {
                    if (options.isFatalError?.(error)) throw error;
                    options.onUploadError(attachment, error);
                }
            }
        }

        // The immutable snapshot is now the published remote identity. The live
        // path may already contain a newer edit; post-merge change detection would
        // misclassify that as stale local content and download over it. Leave the
        // newer live bytes for the next cycle's prepare phase instead.
        if (uploadedThisPass) {
            patches.set(attachment.id, attachment);
            continue;
        }

        if (hasCloudCopy(attachment) && !existsLocally && !hasPendingContentUpload) {
            if (!options.policy?.shouldDownload || options.policy.shouldDownload(attachment)) {
                try {
                    if (await options.onDownload(attachment)) {
                        itemMutated = true;
                        // Loop safety (#1057): stat the file we just wrote and record it
                        // immediately, using the (possibly just-updated) uri — otherwise
                        // every subsequent cycle re-detects this download as a "change".
                        const freshPath = attachment.uri ? resolveLocalPath(attachment.uri) : localPath;
                        if (freshPath) await refreshContentStat(attachment, freshPath);
                    }
                } catch (error) {
                    if (options.isFatalError?.(error)) throw error;
                    options.onDownloadError(attachment, error);
                }
            }
        }

        // Check-on-touch content-change detection (#1057): an attachment that already
        // has a cloud copy AND exists locally was, until now, left untouched by this
        // loop. Only runs when the caller wired both stat/hash callbacks; otherwise
        // this is a no-op and behaviour is unchanged from before this feature.
        if (hasCloudCopy(attachment) && mayReadForSync && options.getLocalFileStat && options.contentChangePhase) {
            const stat = await options.getLocalFileStat(localPath, attachment).catch(() => null);
            if (stat) {
                const check = await checkAttachmentContentChange(
                    attachment,
                    stat,
                    () => {
                        if (unhashableStats.get(attachment.id) === statMarker(stat)) return Promise.resolve(null);
                        return options.computeLocalFileHash ? options.computeLocalFileHash(localPath, attachment) : Promise.resolve(null);
                    },
                );
                if (check.hash) unhashableStats.delete(attachment.id);
                if (!check.changed) {
                    if (check.stat.mtimeMs !== attachment.contentMtimeMs || check.stat.size !== attachment.contentSize) {
                        applyAttachmentContentStat(attachment, check.stat, check.hash);
                        itemMutated = true;
                    }
                } else if (!check.hash) {
                    // The stat mismatched but no hash could be computed to confirm it (review
                    // S2) — do nothing this cycle rather than bump/upload/download on an
                    // unconfirmed guess, which could publish a `fileHash` that describes the
                    // wrong content or overwrite a file for no real reason. Remember the stat
                    // we failed on so the retry waits for the file to move again instead of
                    // re-reading it every cycle (BUG-16).
                    unhashableStats.set(attachment.id, statMarker(check.stat));
                } else if (!attachment.fileHash && options.contentChangePhase === 'post-merge') {
                    // Nothing to compare the fresh hash against — an attachment uploaded by a
                    // client that predates `fileHash`, so the merge cannot have adopted newer
                    // remote content either (`fileHash` is synced). Record what is on disk as
                    // the baseline (BUG-16) instead of downloading over the local file on the
                    // strength of a bare stat move. The prepare pass records the same state
                    // as a pending local candidate; it is published only if that identity
                    // survives the remote merge.
                    applyAttachmentContentStat(attachment, check.stat, check.hash);
                    itemMutated = true;
                } else if (options.contentChangePhase === 'prepare') {
                    // This device's own edit, detected before this cycle's remote pull.
                    // Normal sync records the content identity as a durable pending candidate
                    // without touching the remote blob. Merge either discards the marker when
                    // newer remote content wins, or carries it into the post-merge upload.
                    // Direct lifecycle callers that do not opt into deferral keep the legacy
                    // immediate-upload contract and publish metadata only after success.
                    if (options.deferUploads) {
                        applyAttachmentContentStat(attachment, check.stat, check.hash);
                        attachment.contentRev = bumpAttachmentContentRevision(attachment);
                        attachment.pendingContentUpload = true;
                        itemMutated = true;
                    } else if (!options.policy?.shouldUpload || options.policy.shouldUpload(attachment)) {
                        try {
                            if (await attemptUpload(attachment, localPath, check.hash ?? undefined)) {
                                if (!options.createUploadSnapshot) {
                                    applyAttachmentContentStat(attachment, check.stat, check.hash);
                                }
                                attachment.contentRev = bumpAttachmentContentRevision(attachment);
                                itemMutated = true;
                            }
                        } catch (error) {
                            if (options.isFatalError?.(error)) throw error;
                            options.onUploadError(attachment, error);
                        }
                    }
                } else {
                    // Post-merge: the merge just adopted another device's newer content
                    // and this device's on-disk copy is stale — re-download it.
                    //
                    // Review S3: the local file may have been edited again in the window
                    // between this cycle's prepare pass and this post-merge pass (or the
                    // prepare pass may have missed a transient stat failure) — re-stat
                    // immediately before overwriting. A fresh mismatch here means this is
                    // actually an in-flight local edit, not remote's content; skip the
                    // download (never stomp it) and leave it for the next cycle's prepare
                    // pass to detect and re-upload properly. This re-stat runs before the
                    // download-budget gate below, so a skip from a local-edit race never
                    // consumes a download slot.
                    const restat = await options.getLocalFileStat(localPath, attachment).catch(() => null);
                    const stillMatchesDetectedState = restat
                        && restat.mtimeMs === check.stat.mtimeMs
                        && restat.size === check.stat.size;
                    if (!stillMatchesDetectedState) {
                        options.onLocalEditRace?.(attachment);
                    } else if (!options.policy?.shouldDownload || options.policy.shouldDownload(attachment)) {
                        try {
                            if (await options.onDownload(attachment)) {
                                itemMutated = true;
                                const freshPath = attachment.uri ? resolveLocalPath(attachment.uri) : localPath;
                                if (freshPath) await refreshContentStat(attachment, freshPath);
                            }
                        } catch (error) {
                            if (options.isFatalError?.(error)) throw error;
                            options.onDownloadError(attachment, error);
                        }
                    }
                }
            }
        }

        if (itemMutated) {
            patches.set(attachment.id, attachment);
        }
    }

    return { changed: patches.size > 0, patches };
}
