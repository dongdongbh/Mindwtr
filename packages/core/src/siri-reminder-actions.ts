import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { strToU8 } from 'fflate';
import { runSerializedSyncDocumentWriteOperation } from './data-transfer-transaction';
import { resolveTaskFocusUpdate } from './focus-star';
import { normalizeFocusTaskLimit } from './focus-utils';
import { taskRevisionOf } from './native-request-receipts';
import { isSandboxMode, isWorkspaceTransitionActive } from './sandbox';
import { isSiriReminderDueDate, isSiriReminderTitle, isSiriReminderToken, SIRI_REMINDER_ID,
    type SiriReminderItem, type SiriReminderReceipt } from './siri-reminder-receipts';
import { StorageConflictError } from './storage';
import { flushPendingSave, getStorageAdapter, useTaskStore } from './store';
import { createProjectOrderReserver, ensureDeviceId, getNextDataChangeAt } from './store-helpers';
import { planTaskUpdateEffects, prepareTaskUpdatesForStore } from './store-tasks';
import { runSyncStoreSave } from './store-write-gate';
import { applySyncedDataToStore } from './sync-client-helpers';
import { retainTaskTaxonomy } from './taxonomy-catalog';
import { buildNewTask } from './task-creation';
import { countFocusedTasksBeforeBoundary } from './task-utils';
import type { AppData, Task } from './types';

type SiriReminderTiming = { id: string; createdAt: number; expiresAt: number };
export type SiriReminderAction = SiriReminderTiming & (
    { operation: 'create'; title: string; dueDate?: string }
    | { operation: 'update'; targetId: string; expectedToken: string; dueDate: string | null }
);
type SiriReminderRejection = { outcome: 'rejected'; reason: 'cancelled' | 'expired' | 'invalid' | 'missing' | 'stale' };
export type SiriReminderActionResult = { outcome: 'persisted'; task: SiriReminderItem } | SiriReminderRejection;

export function getSiriReminderItem(task: Task): SiriReminderItem | null {
    if (!SIRI_REMINDER_ID.test(task.id) || !isSiriReminderTitle(task.title) || task.status !== 'inbox'
        || task.projectId || task.sectionId || task.deletedAt || task.purgedAt || task.cancelledAt || task.projectArchivedAt
        || task.recurrence || task.taskMode === 'list'
        || (task.dueDate !== undefined && !isSiriReminderDueDate(task.dueDate))) return null;
    const token = taskRevisionOf(task);
    return isSiriReminderToken(token)
        ? { id: task.id, title: task.title, token, ...(task.dueDate ? { dueDate: task.dueDate } : {}) }
        : null;
}

const rejected = (reason: SiriReminderRejection['reason']): SiriReminderRejection => ({ outcome: 'rejected', reason });

function planSiriReminderAction(input: SiriReminderAction, current: AppData, now: Date):
    | { data: AppData; task: SiriReminderItem }
    | SiriReminderRejection {
    const device = ensureDeviceId(current.settings);
    const context = { allProjects: current.projects, allSections: current.sections, allAreas: current.areas, settings: device.settings };
    const dueDate = input.dueDate ?? undefined;
    const nowIso = now.toISOString();
    const focusTaskLimit = normalizeFocusTaskLimit(current.settings.gtd?.focusTaskLimit);
    if (input.operation === 'create') {
        if (current.tasks.some((task) => task.id === input.id)) return rejected('invalid');
        const built = buildNewTask({
            title: input.title, initialTaskProps: { status: 'inbox', dueDate }, id: input.id, now: nowIso,
            deviceId: device.deviceId, tasks: current.tasks, focusedCount: 0, focusTaskLimit,
            state: { _allProjects: current.projects, _allSections: current.sections, _allAreas: current.areas, settings: device.settings },
            projectOrderReserver: createProjectOrderReserver(current.tasks),
        });
        const task = built.ok ? getSiriReminderItem(built.task) : null;
        if (!built.ok || !task) return rejected('invalid');
        return { task, data: { ...current, tasks: [...current.tasks, built.task],
            settings: retainTaskTaxonomy(device.settings, undefined, built.task) } };
    }
    const target = current.tasks.find((task) => task.id === input.targetId);
    if (!target || target.deletedAt || target.purgedAt) return rejected('missing');
    const original = getSiriReminderItem(target);
    if (!original || original.token !== input.expectedToken) return rejected('stale');
    if (dueDate === original.dueDate) return { data: current, task: original };
    const prepared = prepareTaskUpdatesForStore({ ...context, task: target, updates: { dueDate } });
    if (!prepared.ok) return rejected('stale');
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const focus = resolveTaskFocusUpdate(target, { ...target, ...prepared.updates }, {
        focusedCount: countFocusedTasksBeforeBoundary(current.tasks, endOfToday.toISOString()), focusTaskLimit, now,
    });
    if (focus.outcome === 'refused-limit') return rejected('stale');
    const { tasks, updatedTask, projects: nextProjects, sections } = planTaskUpdateEffects({
        task: target, preparedUpdates: prepared.updates, allTasks: current.tasks, allProjects: current.projects, allSections: current.sections,
        now: nowIso, deviceId: device.deviceId,
    });
    const task = getSiriReminderItem(updatedTask);
    if (!task || task.dueDate !== dueDate) return rejected('invalid');
    return { task, data: { ...current, tasks, projects: nextProjects, sections,
        settings: retainTaskTaxonomy(device.settings, target, updatedTask) } };
}

export async function applySiriReminderAction(raw: SiriReminderAction, canWrite: () => boolean,
    claimedIds?: readonly string[], options: { replayOnly?: boolean } = {}): Promise<SiriReminderActionResult> {
    if (!raw || typeof raw.id !== 'string' || !SIRI_REMINDER_ID.test(raw.id)
        || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.expiresAt) || raw.createdAt < 0
        || raw.createdAt > Date.now() + 5_000 || raw.expiresAt <= raw.createdAt || raw.expiresAt - raw.createdAt > 120_000) {
        return rejected('invalid');
    }
    const id = raw.id.toLowerCase();
    let input: SiriReminderAction;
    let fields: (string | null)[];
    if (raw.operation === 'create' && isSiriReminderTitle(raw.title)
        && (raw.dueDate === undefined || isSiriReminderDueDate(raw.dueDate))) {
        input = { ...raw, id, title: raw.title.trim() };
        fields = [raw.title, raw.dueDate ?? null];
    } else if (raw.operation === 'update' && typeof raw.targetId === 'string' && SIRI_REMINDER_ID.test(raw.targetId)
        && isSiriReminderToken(raw.expectedToken) && (raw.dueDate === null || isSiriReminderDueDate(raw.dueDate))) {
        input = { ...raw, id };
        fields = [raw.targetId, raw.expectedToken, raw.dueDate];
    } else {
        return rejected('invalid');
    }
    const fingerprint = bytesToHex(sha256(strToU8(JSON.stringify([input.operation, input.createdAt, input.expiresAt, ...fields]))));
    const claims = claimedIds?.map((claimed) => claimed.toLowerCase());
    if (claims && (claims.length > 32 || !claims.includes(id) || !claims.every((claim) => SIRI_REMINDER_ID.test(claim)))) {
        throw new Error('Siri reminder claims are invalid');
    }
    const storage = getStorageAdapter();
    const available = () => getStorageAdapter() === storage && !isSandboxMode() && !isWorkspaceTransitionActive() && canWrite();
    const assertAvailable = () => {
        if (!available()) throw new Error('Siri reminder workspace is unavailable');
    };
    const publish = (data: AppData) => {
        if (getStorageAdapter() !== storage) return;
        const tasks = useTaskStore.getState()._allTasks;
        applySyncedDataToStore(data);
        if (useTaskStore.getState()._allTasks !== tasks) {
            useTaskStore.setState((state) => ({ lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) }));
        }
    };
    const persisted = (task: SiriReminderItem): SiriReminderActionResult => {
        assertAvailable();
        return { outcome: 'persisted', task };
    };
    return runSerializedSyncDocumentWriteOperation(() => runSyncStoreSave(async () => {
        assertAvailable();
        if (!storage.getSiriReminderReceipt || !storage.saveSiriReminder) throw new Error('Siri reminder storage is unavailable');
        await flushPendingSave();
        if (useTaskStore.getState().persistenceFailure) throw new Error('The task store has an unsaved change');
        for (let attempt = 0; attempt < 3; attempt += 1) {
            assertAvailable();
            const receipt = await storage.getSiriReminderReceipt(id);
            const current = await storage.getData({ requireCanonical: true });
            assertAvailable();
            if (receipt) {
                const targetId = input.operation === 'create' ? id : input.targetId;
                if (receipt.fingerprint !== fingerprint || receipt.task.id !== targetId) return rejected('invalid');
                publish(current);
                return persisted(receipt.task);
            }
            if (options.replayOnly) return rejected('cancelled');
            const now = new Date();
            if (input.expiresAt <= now.getTime()) return rejected('expired');
            const plan = planSiriReminderAction(input, current, now);
            if ('outcome' in plan) return plan;
            const nextReceipt: SiriReminderReceipt = { id, fingerprint, task: plan.task };
            try {
                await storage.saveSiriReminder(plan.data, current, nextReceipt, () => available() && Date.now() < input.expiresAt, claims);
            } catch (error) {
                if (error instanceof StorageConflictError) continue;
                throw error;
            }
            try {
                publish(await storage.getData({ requireCanonical: true }));
            } catch {
                publish(plan.data);
            }
            return persisted(plan.task);
        }
        throw new StorageConflictError();
    }));
}

export type { SiriReminderItem, SiriReminderReceipt } from './siri-reminder-receipts';
