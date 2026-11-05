import type { Attachment } from './types';


export const ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;


export type AttachmentRemotePresence = boolean | null;


export type AttachmentPresenceStamp = { scope: string; at: number };


export const isAttachmentPresenceStampFresh = (
    stamp: AttachmentPresenceStamp | null,
    scope: string | null | undefined,
    nowMs: number,
): boolean => {
    if (!scope || !stamp || stamp.scope !== scope) return false;
    const elapsed = nowMs - stamp.at;
    return elapsed >= 0 && elapsed < ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS;
};


export const isAttachmentPresenceRepairCandidate = (attachment: Attachment): boolean => (
    attachment.kind === 'file'
    && !attachment.deletedAt
    && Boolean(attachment.cloudKey)
    && attachment.pendingContentUpload !== true
);

export type AttachmentPresenceRepairResult = {

    checked: number;

    cleared: number;


    complete: boolean;
};

export type AttachmentPresenceRepairOptions = {


    candidates: Iterable<Attachment>;

    probe: (attachment: Attachment) => Promise<AttachmentRemotePresence>;

    clear: (attachment: Attachment) => void;


    maxChecks?: number;


    log?: (message: string, fields: Record<string, string>) => void;
};


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


        if (present !== false) continue;
        clear(attachment);
        cleared += 1;
        log?.('Attachment is missing from the sync location; clearing its cloud reference', {
            id: attachment.id,
        });
    }

    return { checked, cleared, complete };
}
