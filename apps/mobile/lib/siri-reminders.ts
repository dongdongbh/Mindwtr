import { applySiriReminderAction, getSiriReminderItem, type SiriReminderItem, type Task } from '@mindwtr/core';
import {
    acknowledge,
    claimPending,
    type MindwtrSiriActionRequest,
    type MindwtrSiriActionResult,
} from '../modules/ios-siri-actions';
import { logInfo } from './app-log';

const MAX_SNAPSHOT_ITEMS = 100;
const MAX_SNAPSHOT_CODE_UNITS = 300_000;
type SiriReminderResponse = { outcome: 'persisted'; task: SiriReminderItem }
    | { outcome: 'rejected'; reason: NonNullable<MindwtrSiriActionResult['reason']> };

export function projectSiriReminders(tasks: readonly Task[], preferredId?: string) {
    const preferredTask = preferredId && tasks.find((task) => task.id === preferredId);
    const preferred = preferredTask ? getSiriReminderItem(preferredTask) : null;
    const items: SiriReminderItem[] = preferred ? [preferred] : [];
    let omittedCount = 0;
    let itemCodeUnits = preferred ? JSON.stringify(preferred).length + 1 : 0;
    for (const task of tasks) {
        if (task === preferredTask) continue;
        const item = getSiriReminderItem(task);
        if (!item) continue;
        if (items.length === MAX_SNAPSHOT_ITEMS) {
            omittedCount += 1;
            continue;
        }
        const nextCodeUnits = itemCodeUnits + JSON.stringify(item).length + 1;
        if (nextCodeUnits > MAX_SNAPSHOT_CODE_UNITS) {
            omittedCount += 1;
            continue;
        }
        itemCodeUnits = nextCodeUnits;
        items.push(item);
    }
    return { items, omittedCount };
}

async function applyRequest(
    request: MindwtrSiriActionRequest,
    canWrite: () => boolean,
    claimedIds: readonly string[],
): Promise<SiriReminderResponse> {
    const { id, version, createdAt, expiresAt, operation, fields, clearFields, targetId, expectedToken } = request;
    if (version !== 1) return { outcome: 'rejected', reason: 'unsupported' };
    const identity = { id, createdAt, expiresAt };
    const options = { replayOnly: request.replayOnly !== false };
    switch (operation) {
        case 'create': {
            if (targetId !== undefined || expectedToken !== undefined
                || clearFields.length !== 0 || Object.keys(fields).some((field) => field !== 'title' && field !== 'dueDate')) {
                return { outcome: 'rejected', reason: 'unsupported' };
            }
            if (typeof fields.title !== 'string') return { outcome: 'rejected', reason: 'invalid' };
            return applySiriReminderAction({ ...identity, operation, title: fields.title, dueDate: fields.dueDate }, canWrite, claimedIds, options);
        }
        case 'update': {
            if (Object.keys(fields).some((field) => field !== 'dueDate')
                || clearFields.some((field) => field !== 'dueDate')) {
                return { outcome: 'rejected', reason: 'unsupported' };
            }
            const dueDate = clearFields.length === 1 && fields.dueDate === undefined ? null : fields.dueDate;
            if (!targetId || !expectedToken || (clearFields.length !== 0 && dueDate !== null) || dueDate === undefined) {
                return { outcome: 'rejected', reason: 'invalid' };
            }
            return applySiriReminderAction({ ...identity, operation, targetId, expectedToken, dueDate }, canWrite, claimedIds, options);
        }
        case 'delete':
            return { outcome: 'rejected', reason: 'unsupported' };
    }
}

export async function drainSiriReminderActions(
    canWrite: () => boolean,
    publishPersistedTask: (id: string) => Promise<void>,
): Promise<void> {
    if (!canWrite()) return;
    const requests = await claimPending();
    const claimedIds = requests.map(({ id }) => id);
    for (const request of requests) {
        if (!canWrite()) return;
        const result = await applyRequest(request, canWrite, claimedIds);
        if (!canWrite()) return;
        if (result.outcome === 'persisted') {
            await publishPersistedTask(result.task.id);
            if (!canWrite()) return;
        }
        const response = result.outcome === 'persisted'
            ? { outcome: 'persisted', task: JSON.stringify(result.task) }
            : result;
        await acknowledge(request.id, JSON.stringify(response));
        void logInfo('Siri Reminder request acknowledged', {
            scope: 'shortcuts',
            force: true,
            extra: {
                releaseCheck: 'v1.3.10/ios-siri-reminder-action',
                operation: request.operation,
                outcome: result.outcome,
                reason: result.outcome === 'rejected' ? result.reason : undefined,
            },
        }).catch(() => undefined);
    }
}
