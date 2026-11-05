


import {
    ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS,
    isAttachmentPresenceStampFresh,
    type AttachmentPresenceStamp,
} from '@mindwtr/core';

export { ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS };

const ATTACHMENT_PRESENCE_RECONCILE_KEY = 'mindwtr-attachment-presence-reconcile-v1';

const readAttachmentPresenceStamp = (): AttachmentPresenceStamp | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(ATTACHMENT_PRESENCE_RECONCILE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<AttachmentPresenceStamp> | null;
        if (typeof parsed?.scope !== 'string' || !Number.isFinite(parsed?.at)) return null;
        return { scope: parsed.scope, at: Number(parsed.at) };
    } catch {
        return null;
    }
};


export const isAttachmentPresenceReconciliationDue = (scope: string | null | undefined): boolean => {
    if (!scope) return true;
    return !isAttachmentPresenceStampFresh(readAttachmentPresenceStamp(), scope, Date.now());
};


export const markAttachmentPresenceReconciled = (
    scope: string | null | undefined,
    logWarning?: (message: string, error?: unknown) => void,
): void => {
    if (!scope) return;
    if (typeof localStorage === 'undefined') return;
    try {
        const stamp: AttachmentPresenceStamp = { scope, at: Date.now() };
        localStorage.setItem(ATTACHMENT_PRESENCE_RECONCILE_KEY, JSON.stringify(stamp));
    } catch (error) {
        logWarning?.('Failed to record the attachment presence reconciliation stamp', error);
    }
};


export const hasCompletedAttachmentPresenceReconciliation = (scope: string | null | undefined): boolean => {
    if (!scope) return false;
    const stamp = readAttachmentPresenceStamp();
    return stamp !== null && stamp.scope === scope;
};


export const clearAttachmentPresenceStamp = (): void => {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.removeItem(ATTACHMENT_PRESENCE_RECONCILE_KEY);
    } catch {

    }
};
