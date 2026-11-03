import type { AppData, Attachment } from './types';
import type { ActivationMissingAttachment } from './sync-run-ports';


export const UNREACHABLE_ATTACHMENTS_KEY = 'mindwtr-unreachable-attachments';

export type UnreachableAttachments = Record<string, string[]>;


let lastKnown: { record: UnreachableAttachments; scope: string | null } = { record: {}, scope: null };


export const rememberUnreachableAttachments = (record: UnreachableAttachments, scope?: string | null): void => {
    lastKnown = { record, scope: scope === undefined ? lastKnown.scope : scope };
};


export const isAttachmentKeptWithoutFile = (attachment: Pick<Attachment, 'id'>): boolean => {
    const { record, scope } = lastKnown;
    if (scope) return record[scope]?.includes(attachment.id) === true;
    return Object.values(record).some((ids) => ids.includes(attachment.id));
};

export const parseUnreachableAttachments = (raw: string | null | undefined): UnreachableAttachments => {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result: UnreachableAttachments = {};
        for (const [scope, ids] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(ids)) continue;
            const valid = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
            if (valid.length > 0) result[scope] = valid;
        }
        return result;
    } catch {
        return {};
    }
};


export const pruneUnreachableAttachments = (
    record: UnreachableAttachments,
    data: AppData,
    scope: string,
): UnreachableAttachments => {
    const live = new Map<string, Attachment>();
    for (const owner of [...data.tasks, ...data.projects]) {
        if (owner.deletedAt) continue;
        for (const attachment of owner.attachments ?? []) {
            if (attachment.kind === 'file' && !attachment.deletedAt) live.set(attachment.id, attachment);
        }
    }
    let changed = false;
    const next: UnreachableAttachments = {};
    for (const [entryScope, ids] of Object.entries(record)) {
        const kept = ids.filter((id) => {
            const attachment = live.get(id);
            return attachment !== undefined && (
                entryScope !== scope
                || attachment.localStatus !== 'available'
                || attachment.pendingContentUpload === true
            );
        });
        if (kept.length !== ids.length) changed = true;
        if (kept.length > 0) next[entryScope] = kept;
    }
    return changed ? next : record;
};


export const formatActivationMissingAttachments = (
    files: readonly ActivationMissingAttachment[],
    more: (count: number) => string,
    max = 5,
): string => {
    const lines = files.slice(0, max).map((file) => {
        const name = file.title.trim() || file.id;
        const owner = file.ownerTitle.trim();
        return owner ? `• ${name} (${owner})` : `• ${name}`;
    });
    if (files.length > max) lines.push(more(files.length - max));
    return lines.join('\n');
};
