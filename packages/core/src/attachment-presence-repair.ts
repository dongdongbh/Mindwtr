import type { Attachment } from './types';

// Re-verify remote attachment presence daily (#1001).
export const ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * #1119 follow-up. When an attachment's remote blob is gone — deleted on the server, left
 * behind at a previous sync location, a lost upload — the only device that can repair it is
 * one that still holds the bytes locally. Clearing `cloudKey` is that repair: the normal
 * transfer lifecycle sees an attachment with no cloud copy and uploads it again.
 *
 * WebDAV has done this since #1119 with a per-attachment HEAD. This module is the same pass
 * for the backends that do their own thing (Dropbox's one folder listing, the self-hosted
 * cloud's per-blob probe) and for both apps, so the rule that makes it safe lives in ONE
 * place instead of four:
 *
 *   **Only a definitive "the remote does not have this" clears anything.** A network error,
 *   a 401, a 429, a 5xx, a timeout, a partial listing — every one of those is `null` here
 *   and changes nothing. Clearing on a "don't know" would re-upload the whole library every
 *   time a server hiccuped.
 */

/** `true` = the remote holds it, `false` = the remote definitively does not, `null` = the
 *  probe could not tell. Only `false` is allowed to change anything. */
export type AttachmentRemotePresence = boolean | null;

/** The device-local "when did a full presence pass last complete against this scope" record
 *  each platform's IO wrapper reads and writes; see `isAttachmentPresenceStampFresh` below. */
export type AttachmentPresenceStamp = { scope: string; at: number };

/**
 * Is a stamped presence pass still current for `scope` at `nowMs`? `false` for every "don't
 * know" case — no stamp, a stamp for a different scope (a stamp from a previous sync location
 * must never vouch for a new one), a clock that moved backwards since the stamp was written,
 * or a stamp older than `ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS` — so a caller using this
 * to gate a daily reconciliation pass reconciles on every doubt rather than trusting a stale
 * or mismatched record.
 *
 * A falsy `scope` also means doubt and always returns `false`: a caller with no scope has
 * nothing to compare the stamp against.
 */
export const isAttachmentPresenceStampFresh = (
    stamp: AttachmentPresenceStamp | null,
    scope: string | null | undefined,
    nowMs: number,
): boolean => {
    if (!scope || !stamp || stamp.scope !== scope) return false;
    const elapsed = nowMs - stamp.at;
    return elapsed >= 0 && elapsed < ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS;
};

/**
 * The document-side half of "may a presence pass clear this attachment's cloud reference?".
 * The caller supplies the half only it can know — that this device can still read the local
 * bytes — because a clear without local bytes would strip the only pointer to the blob.
 *
 * `pendingContentUpload` is excluded on purpose: that attachment already has a replacement
 * queued, and its recorded identity owns the next upload (#1057).
 */
export const isAttachmentPresenceRepairCandidate = (attachment: Attachment): boolean => (
    attachment.kind === 'file'
    && !attachment.deletedAt
    && Boolean(attachment.cloudKey)
    && attachment.pendingContentUpload !== true
);

export type AttachmentPresenceRepairResult = {
    /** How many attachments the pass actually asked about. */
    checked: number;
    /** How many had their cloud reference cleared for re-upload. */
    cleared: number;
    /**
     * Whether the proof ran to the end. `false` only when the pass stopped on a "don't
     * know"; callers must not advance their once-a-day stamp in that case, so the next
     * cycle retries instead of parking the repair for a day. Reaching `maxChecks` still
     * counts as complete — see the ceiling note on that option.
     */
    complete: boolean;
};

export type AttachmentPresenceRepairOptions = {
    /** Attachments this pass may judge. Filter with `isAttachmentPresenceRepairCandidate`
     *  and the caller's own local-bytes check before passing them in. */
    candidates: Iterable<Attachment>;
    /** Asks the remote about one attachment. Must never guess: see `AttachmentRemotePresence`. */
    probe: (attachment: Attachment) => Promise<AttachmentRemotePresence>;
    /** Clears the cloud reference and records the patch the caller's own way. */
    clear: (attachment: Attachment) => void;
    /**
     * ponytail: a flat per-pass ceiling for backends that need one request per attachment,
     * and it always cuts the SAME tail of the iteration order — a library above the ceiling
     * never gets its later attachments checked. Upgrade path if that ever matters: rotate
     * the starting offset with the daily stamp. A backend that answers the whole folder in
     * one listing (Dropbox) passes no limit at all.
     */
    maxChecks?: number;
    /** Info-level logger. Field names must not contain `key`: the log sanitizer redacts by
     *  substring, so a field called `cloudKey` would come out as `[redacted]`. */
    log?: (message: string, fields: Record<string, string>) => void;
};

/**
 * Runs the presence proof over `candidates` and returns what it did. Stops at the first
 * "don't know", because every backend here answers from one connection to one server: if it
 * cannot answer for one attachment it almost certainly cannot answer for the rest, and
 * hammering it with the remaining requests buys nothing.
 */
export async function repairMissingRemoteAttachments(
    options: AttachmentPresenceRepairOptions,
): Promise<AttachmentPresenceRepairResult> {
    const { candidates, probe, clear, maxChecks, log } = options;
    let checked = 0;
    let cleared = 0;
    let complete = true;

    for (const attachment of candidates) {
        if (maxChecks !== undefined && checked >= maxChecks) {
            log?.('Attachment presence pass reached the per-pass limit', { limit: String(maxChecks) });
            break;
        }
        checked += 1;
        const present = await probe(attachment);
        if (present === null) {
            complete = false;
            break;
        }
        // Strict `false` on purpose: any other value a probe manages to return is "don't
        // know", and only a definitive not-found may clear a cloud reference.
        if (present !== false) continue;
        clear(attachment);
        cleared += 1;
        log?.('Attachment is missing from the sync location; clearing its cloud reference', {
            id: attachment.id,
        });
    }

    return { checked, cleared, complete };
}
