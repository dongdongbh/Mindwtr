import {
    advanceProcessInboxSession,
    skipCurrentProcessInboxTask,
    type ProcessInboxCandidate,
    type ProcessInboxSession,
    type ProcessInboxTaskTransitionOptions,
} from './process-inbox-session';
import type { StoreActionResult } from './store-types';
import type { Task } from './types';

export type ProcessInboxWorkflowFields = Partial<Pick<
    Task,
    | 'projectId'
    | 'areaId'
    | 'contexts'
    | 'tags'
    | 'priority'
    | 'energyLevel'
    | 'assignedTo'
    | 'timeEstimate'
    | 'startTime'
    | 'dueDate'
    | 'reviewAt'
>>;

/**
 * Container exclusivity: a project home outranks a direct area, so a task
 * never keeps both. Every Inbox-processing decision writes this pair so a
 * picked project survives whichever destination the user lands on (#958).
 */
export function resolveProcessInboxContainerFields(
    projectId: string | null | undefined,
    areaId: string | null | undefined,
): Pick<ProcessInboxWorkflowFields, 'projectId' | 'areaId'> {
    return {
        projectId: projectId || undefined,
        areaId: projectId ? undefined : (areaId || undefined),
    };
}

/**
 * Domain decisions emitted by an Inbox-processing UI.
 *
 * Platforms collect and normalize UI input; process-inbox-plan validates and
 * prepares these events. This boundary owns status/effect mapping so every
 * client commits the same GTD decision once input is ready.
 */
export type ProcessInboxWorkflowEvent =
    | { type: 'discard' }
    | { type: 'skip'; fields: ProcessInboxWorkflowFields }
    | { type: 'someday'; fields?: ProcessInboxWorkflowFields }
    | { type: 'reference'; fields?: ProcessInboxWorkflowFields }
    | { type: 'complete'; fields?: ProcessInboxWorkflowFields }
    | { type: 'later'; fields: ProcessInboxWorkflowFields }
    | { type: 'waiting'; fields: ProcessInboxWorkflowFields; followUpAt?: string }
    | { type: 'next'; fields: ProcessInboxWorkflowFields };

export type ProcessInboxWorkflowEffect =
    | { type: 'delete' }
    | { type: 'update'; updates: Partial<Task> };

export type ProcessInboxWorkflowWriteActions = {
    deleteTask: (taskId: string) => Promise<StoreActionResult>;
    updateTask: (taskId: string, updates: Partial<Task>) => Promise<StoreActionResult>;
};

export type ProcessInboxWorkflowCommitOptions<Step extends string> =
    ProcessInboxTaskTransitionOptions<Step> & {
        /** Platform-prepared title, description, and date updates applied over the workflow effect. */
        taskUpdates?: Partial<Task>;
        /** Multi-write flows can defer advancing until their remaining writes succeed. */
        advance?: boolean;
    };

export type ProcessInboxWorkflowCommitResult<Step extends string> = {
    session: ProcessInboxSession<Step>;
    writeResult: StoreActionResult;
};

function normalizeFields(fields: ProcessInboxWorkflowFields): ProcessInboxWorkflowFields {
    if (!Object.prototype.hasOwnProperty.call(fields, 'assignedTo')) return fields;
    const assignedTo = fields.assignedTo?.trim() || undefined;
    return assignedTo === fields.assignedTo ? fields : { ...fields, assignedTo };
}

function updateEffect(
    status: Task['status'],
    fields: ProcessInboxWorkflowFields = {},
): ProcessInboxWorkflowEffect {
    return {
        type: 'update',
        updates: { status, ...normalizeFields(fields) },
    };
}

export function resolveProcessInboxWorkflowEvent(
    event: ProcessInboxWorkflowEvent,
): ProcessInboxWorkflowEffect {
    switch (event.type) {
        case 'discard':
            return { type: 'delete' };
        case 'skip':
            return { type: 'update', updates: normalizeFields(event.fields) };
        case 'someday':
            return updateEffect('someday', event.fields);
        case 'reference':
            return updateEffect('reference', event.fields);
        case 'complete':
            return updateEffect('done', event.fields);
        case 'later':
        case 'next':
            return updateEffect('next', event.fields);
        case 'waiting': {
            const fields = event.followUpAt === undefined
                ? event.fields
                : { ...event.fields, reviewAt: event.followUpAt };
            return updateEffect('waiting', fields);
        }
    }
}

/**
 * Commit one Inbox-processing decision and advance only after persistence
 * confirms success. Platforms keep input collection and error presentation.
 */
export async function commitProcessInboxWorkflowEvent<
    Candidate extends ProcessInboxCandidate,
    Step extends string,
>(
    session: ProcessInboxSession<Step>,
    candidates: readonly Candidate[],
    event: ProcessInboxWorkflowEvent,
    actions: ProcessInboxWorkflowWriteActions,
    options: ProcessInboxWorkflowCommitOptions<Step> = {},
): Promise<ProcessInboxWorkflowCommitResult<Step>> {
    const taskId = session.currentTaskId;
    if (!taskId) {
        return {
            session,
            writeResult: { success: false, error: 'No current Inbox task' },
        };
    }

    const effect = resolveProcessInboxWorkflowEvent(event);
    const writeResult = effect.type === 'delete'
        ? await actions.deleteTask(taskId)
        : await actions.updateTask(taskId, { ...effect.updates, ...options.taskUpdates });
    if (!writeResult.success || options.advance === false) {
        return { session, writeResult };
    }

    return {
        session: event.type === 'skip'
            ? skipCurrentProcessInboxTask(session, candidates, options)
            : advanceProcessInboxSession(session, candidates, options),
        writeResult,
    };
}
