import type { Attachment } from './types';
import { logInfo } from './logger';


export type LocalFileStat = {
    mtimeMs: number;
    size: number;
};

export type AttachmentContentCheckResult = {


    changed: boolean;


    stat: LocalFileStat;

    hash?: string;
};


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


        return { changed: true, stat };
    }
    if (attachment.fileHash && hash.toLowerCase() === attachment.fileHash.toLowerCase()) {
        return { changed: false, stat, hash };
    }
    return { changed: true, stat, hash };
}


export const isStaleCopyOfRemoteWinner = (
    attachment: Pick<Attachment, 'staleContentHash' | 'pendingContentUpload'>,
    diskHash: string | undefined,
): boolean => (
    attachment.pendingContentUpload !== true
    && /^[0-9a-f]{64}$/i.test(attachment.staleContentHash ?? '')
    && diskHash?.trim().toLowerCase() === attachment.staleContentHash?.toLowerCase()
);


const uninstalledWinnersLogged = new Set<string>();


export const logUninstalledRemoteWinner = (attachment: Pick<Attachment, 'id' | 'fileHash'>): void => {
    const key = `${attachment.id}|${attachment.fileHash ?? ''}`;
    if (uninstalledWinnersLogged.has(key)) return;
    uninstalledWinnersLogged.add(key);
    logInfo('Attachment kept for its newer remote version, not uploaded as a local edit', {
        scope: 'attachment',
        context: { attachmentId: attachment.id, releaseCheck: 'v1.3.7/attachment-remote-winner-pending' },
    });
};


export const bumpAttachmentContentRevision = (attachment: Pick<Attachment, 'contentRev'>): number =>
    (attachment.contentRev ?? 0) + 1;


export function applyAttachmentContentStat(
    attachment: Pick<Attachment, 'contentMtimeMs' | 'contentSize' | 'fileHash' | 'staleContentHash'>,
    stat: LocalFileStat,
    hash?: string,
): void {
    attachment.contentMtimeMs = stat.mtimeMs;
    attachment.contentSize = stat.size;
    if (hash) attachment.fileHash = hash;

    attachment.staleContentHash = undefined;
}
