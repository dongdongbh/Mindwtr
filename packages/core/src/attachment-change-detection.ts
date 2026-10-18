import type { Attachment } from './types';
import { logInfo } from './logger';

/** Local file stat, in a shape every platform's fs API can produce (mtime normalized
 *  to ms since epoch, regardless of the native API's own unit). */
export type LocalFileStat = {
    mtimeMs: number;
    size: number;
};

export type AttachmentContentCheckResult = {
    /** True only once a hash confirms the bytes actually differ from what's recorded.
     *  A bare mtime/size mismatch with a matching hash is NOT a change (#1057: only a
     *  hash change counts). */
    changed: boolean;
    /** The stat this check was run against — callers refresh the attachment's recorded
     *  mtime/size with this even when `changed` is false, so a cosmetic touch (e.g. a
     *  copy that preserves content) doesn't force a hash recompute every cycle. */
    stat: LocalFileStat;
    /** Present whenever a hash was actually computed, i.e. the stat mismatched. */
    hash?: string;
};

/**
 * Check-on-touch content-change detection for one file attachment (#1057). Compares
 * the live file's mtime+size against the attachment's recorded values first (the
 * O(1), no-I/O fast path the perf budget requires); only on a mismatch does it hash
 * the file and compare against the recorded `fileHash` to confirm a real change.
 *
 * Pure and platform-agnostic: `computeHash` is supplied by the caller (each platform
 * reads the file its own way) and is only invoked when the cheap stat check already
 * mismatched.
 */
export async function checkAttachmentContentChange(
    attachment: Pick<Attachment, 'contentMtimeMs' | 'contentSize' | 'fileHash'>,
    stat: LocalFileStat,
    computeHash: () => Promise<string | null>,
): Promise<AttachmentContentCheckResult> {
    const statMatches = attachment.contentMtimeMs === stat.mtimeMs && attachment.contentSize === stat.size;
    if (statMatches) {
        return { changed: false, stat };
    }
    const hash = await computeHash();
    if (!hash) {
        // Can't confirm either way — treat the stat mismatch as a real change rather
        // than silently refreshing recorded stat against unverified bytes.
        return { changed: true, stat };
    }
    if (attachment.fileHash && hash.toLowerCase() === attachment.fileHash.toLowerCase()) {
        return { changed: false, stat, hash };
    }
    return { changed: true, stat, hash };
}

/**
 * The file on disk is exactly this device's old copy of an attachment whose newer version, from another device, the merge
 * chose but this device has not installed yet ({@link Attachment.staleContentHash}). Uploading it as this device's edit would
 * raise contentRev past the winner and put the old bytes over the other device's newer file; the download installs instead.
 * Any other hash is a real edit made after the merge.
 */
export const isStaleCopyOfRemoteWinner = (
    attachment: Pick<Attachment, 'staleContentHash' | 'pendingContentUpload'>,
    diskHash: string | undefined,
): boolean => (
    attachment.pendingContentUpload !== true
    && /^[0-9a-f]{64}$/i.test(attachment.staleContentHash ?? '')
    && diskHash?.trim().toLowerCase() === attachment.staleContentHash?.toLowerCase()
);

// Once per attachment version per process: a prepare pass meets the same old file every cycle until the winner is installed.
const uninstalledWinnersLogged = new Set<string>();

/** Called where a prepare pass leaves such a file: the tester's proof that the old bytes stayed local. */
export const logUninstalledRemoteWinner = (attachment: Pick<Attachment, 'id' | 'fileHash'>): void => {
    const key = `${attachment.id}|${attachment.fileHash ?? ''}`;
    if (uninstalledWinnersLogged.has(key)) return;
    uninstalledWinnersLogged.add(key);
    logInfo('Attachment kept for its newer remote version, not uploaded as a local edit', {
        scope: 'attachment',
        context: { attachmentId: attachment.id, releaseCheck: 'v1.3.7/attachment-remote-winner-pending' },
    });
};

/** Next content revision after a confirmed change. Missing (old client / never
 *  bumped) is equivalent to 0. */
export const bumpAttachmentContentRevision = (attachment: Pick<Attachment, 'contentRev'>): number =>
    (attachment.contentRev ?? 0) + 1;

/** Mutates `attachment` to record the given stat (and hash, if provided) as the
 *  last known-synced content. Shared by every "a transfer just completed, or a
 *  cosmetic touch was confirmed" call site so the three fields always move together. */
export function applyAttachmentContentStat(
    attachment: Pick<Attachment, 'contentMtimeMs' | 'contentSize' | 'fileHash' | 'staleContentHash'>,
    stat: LocalFileStat,
    hash?: string,
): void {
    attachment.contentMtimeMs = stat.mtimeMs;
    attachment.contentSize = stat.size;
    if (hash) attachment.fileHash = hash;
    // The file this device recorded is now the known state: no older copy waits for a download any more.
    attachment.staleContentHash = undefined;
}
