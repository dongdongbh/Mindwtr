import { createCompactLinkTitle } from './attachment-link-utils';
import { runSerializedSyncDocumentWriteOperation } from './data-transfer-transaction';
import { logInfo } from './logger';
import { isSandboxMode, isWorkspaceTransitionActive } from './sandbox';
import { flushPendingSave, getStorageAdapter, useTaskStore } from './store';
import { ensureDeviceId, getNextDataChangeAt, nextRevision } from './store-helpers';
import { runSyncStoreSave, tryRunIdleStoreSave } from './store-write-gate';
import { applySyncedDataToStore } from './sync-client-helpers';
import type { AppData, Attachment, Task } from './types';
import { fetchWebPageTitle, getWebPageTitleRequestUrl, normalizeWebPageTitle } from './web-page-title';

type AttachmentWitness = Pick<Attachment, 'id' | 'title' | 'uri' | 'updatedAt'>;
type PageTitleLoader = (url: string) => Promise<string | null>;
type LinkTitleChange = {
    kind: 'capture';
    id: string;
    uri: string;
    attachment: AttachmentWitness;
} | {
    kind: 'attachment';
    id: string;
    attachment: AttachmentWitness;
};

const sameLink = (row: Attachment, expected: AttachmentWitness): boolean =>
    row.kind === 'link' && !row.deletedAt
    && row.id === expected.id && row.uri === expected.uri
    && row.title === expected.title && row.updatedAt === expected.updatedAt;

const findCapturedLink = (task: Task, uri: string): Attachment | undefined =>
    task.attachments?.find((row) => row.kind === 'link' && !row.deletedAt && row.uri === uri);

const isStillEligible = (row: Task | undefined, change: LinkTitleChange): row is Task => {
    if (!row || row.deletedAt || row.purgedAt) return false;
    return change.kind === 'capture'
        ? row.title === change.uri && row.attachments?.some((item) =>
            item.kind === 'link' && !item.deletedAt && item.id === change.attachment.id && item.uri === change.uri) === true
        : row.attachments?.some((attachment) => sameLink(attachment, change.attachment)) === true;
};

function applyTitle(current: AppData, change: LinkTitleChange, title: string): AppData {
    if (current.settings.fetchLinkTitles === false) return current;
    const task = current.tasks.find((row) => row.id === change.id);
    if (!isStillEligible(task, change)) return current;
    if ((change.kind === 'capture' ? task.title : change.attachment.title) === title) return current;
    const device = ensureDeviceId(current.settings);
    const updatedAt = new Date().toISOString();
    const attachments = task.attachments?.map((attachment) =>
        sameLink(attachment, change.attachment) && (change.kind === 'attachment'
            || (attachment.title === createCompactLinkTitle(change.uri) && attachment.updatedAt === attachment.createdAt))
            ? { ...attachment, title, updatedAt } : attachment);
    const updated = {
        ...task, attachments, title: change.kind === 'capture' ? title : task.title,
        updatedAt, rev: nextRevision(task.rev), revBy: device.deviceId,
    };
    return { ...current, tasks: current.tasks.map((row) => row === task ? updated : row), settings: device.settings };
}

async function enrichLinkTitle(change: LinkTitleChange, loadTitle: PageTitleLoader): Promise<boolean> {
    const url = getWebPageTitleRequestUrl(change.kind === 'capture' ? change.uri : change.attachment.uri);
    const storage = getStorageAdapter();
    const saveIfUnchanged = storage.saveDataIfUnchanged?.bind(storage);
    if (!url || !saveIfUnchanged) return false;
    const eligibleInStore = () => {
        const state = useTaskStore.getState();
        const row = state._tasksById.get(change.id);
        return state.settings.fetchLinkTitles !== false && !state.persistenceFailure
            && !isSandboxMode() && !isWorkspaceTransitionActive() && getStorageAdapter() === storage && isStillEligible(row, change);
    };
    try {
        if (!eligibleInStore()) return false;
        const admitted = await runSyncStoreSave(async () => {
            await flushPendingSave();
            if (!eligibleInStore()) return false;
            const current = await storage.getData({ requireCanonical: true });
            return current.settings.fetchLinkTitles !== false
                && isStillEligible(current.tasks.find((row) => row.id === change.id), change);
        });
        if (!admitted) return false;
        if (!eligibleInStore()) return false;
        const result = await loadTitle(url);
        const title = result ? normalizeWebPageTitle(result) : null;
        if (!title || !eligibleInStore()) return false;
        const applied = await runSerializedSyncDocumentWriteOperation(() => tryRunIdleStoreSave(async () => {
            await flushPendingSave();
            if (!eligibleInStore()) return false;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const current = await storage.getData({ requireCanonical: true });
                if (!eligibleInStore()) return false;
                const next = applyTitle(current, change, title);
                if (next === current) return false;
                let saved: AppData | void;
                try {
                    saved = await saveIfUnchanged(next, current);
                } catch {
                    continue;
                }
                const canonical = saved ?? await storage.getData({ requireCanonical: true });
                if (getStorageAdapter() === storage && !isWorkspaceTransitionActive()) {
                    applySyncedDataToStore(canonical);
                    useTaskStore.setState((state) => ({ lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) }));
                }
                return true;
            }
            return false;
        }));
        if (applied) logInfo('Captured link title enriched', {
            scope: 'capture', category: 'storage', force: true,
            context: { releaseCheck: 'v1.3.10/captured-link-title', outcome: change.kind },
        });
        return applied;
    } catch {
        return false;
    }
}

export function enrichCapturedTaskLinkTitle(id: string, uri: string, loadTitle: PageTitleLoader = fetchWebPageTitle): Promise<boolean> {
    const task = useTaskStore.getState()._tasksById.get(id);
    const attachment = task && findCapturedLink(task, uri);
    return attachment ? enrichLinkTitle({ kind: 'capture', id, uri, attachment }, loadTitle) : Promise.resolve(false);
}

export function enrichAttachmentLinkTitle(owner: { kind: 'task'; id: string }, attachment: AttachmentWitness, loadTitle: PageTitleLoader = fetchWebPageTitle): Promise<boolean> {
    return enrichLinkTitle({ kind: 'attachment', id: owner.id, attachment }, loadTitle);
}
