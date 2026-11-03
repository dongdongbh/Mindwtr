import { normalizeAttachmentCleanupUri } from './attachment-cleanup';
import { logInfo } from './logger';
import type { Attachment } from './types';

export type AttachmentDraftSettlementReason =
    | 'uncommitted-draft'
    | 'replaced-baseline'
    | 'deleted-after-save';

export type AttachmentDraftCleanupCandidate = {
    attachment: Attachment;
    reason: AttachmentDraftSettlementReason;
};

export type AttachmentDraftSettlementInput = {

    baselineAttachments?: readonly Attachment[];

    draftAttachments?: readonly Attachment[];

    committedAttachments?: readonly Attachment[];
};


export function planAttachmentDraftSettlement({
    baselineAttachments = [],
    draftAttachments = [],
    committedAttachments = [],
}: AttachmentDraftSettlementInput): AttachmentDraftCleanupCandidate[] {
    const baselineById = new Map(baselineAttachments.map((attachment) => [attachment.id, attachment]));
    const committedById = new Map(committedAttachments.map((attachment) => [attachment.id, attachment]));
    const candidates = new Map<string, AttachmentDraftCleanupCandidate>();
    const addCandidate = (attachment: Attachment, reason: AttachmentDraftSettlementReason) => {
        if (attachment.kind !== 'file' || !attachment.uri) return;
        candidates.set(`${attachment.id}\0${attachment.uri}`, { attachment, reason });
    };

    for (const draft of draftAttachments) {
        const baseline = baselineById.get(draft.id);
        const committed = committedById.get(draft.id);
        const draftWasBaseline = baseline?.kind === 'file' && baseline.uri === draft.uri;
        const draftSurvived = committed?.kind === 'file' && committed.uri === draft.uri && !committed.deletedAt;
        if (!draftWasBaseline && !draftSurvived) addCandidate(draft, 'uncommitted-draft');
    }

    for (const baseline of baselineAttachments) {
        const committed = committedById.get(baseline.id);
        if (!committed) continue;
        const baselineSurvived = committed.kind === 'file' && committed.uri === baseline.uri && !committed.deletedAt;
        if (!baselineSurvived) {
            addCandidate(baseline, committed.deletedAt ? 'deleted-after-save' : 'replaced-baseline');
        }
    }

    return Array.from(candidates.values());
}


export function isAttachmentFileInUse(
    uri: string,
    owners: Iterable<{ deletedAt?: string; attachments?: readonly Attachment[] }>,
): boolean {
    const identity = normalizeAttachmentCleanupUri(uri) ?? uri;
    for (const owner of owners) {
        if (owner.deletedAt) continue;
        const match = owner.attachments?.find((item) => !item.deletedAt && item.kind === 'file' && item.uri
            && (normalizeAttachmentCleanupUri(item.uri) ?? item.uri) === identity);
        if (!match) continue;
        if (match.uri !== uri) {
            try { logInfo('Attachment file kept for an equivalent reference spelling', { scope: 'attachments', category: 'storage',
                context: { releaseCheck: 'v1.3.7/attachment-equivalent-reference' } }); }
            catch {                                                    }
        }
        return true;
    }
    return false;
}
