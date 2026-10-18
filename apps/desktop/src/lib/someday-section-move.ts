import {
    buildTaskViewSectionUndoUpdates,
    buildTaskViewSectionUpdates,
    flushPendingSave,
    isTaskInActiveProject,
    runStoreCommand,
    sortViewSectionDefinitions,
    useTaskStore,
    type Task,
} from '@mindwtr/core';

type PreviousAssignment = { id: string; sectionId?: string };

export type SomedaySectionMove = {
    changedCount: number;
    destinationTitle: string;
    destinationId?: string;
    previous: PreviousAssignment[];
};

export class SomedaySectionMoveSaveError extends Error {
    readonly originalError: unknown;
    constructor(public readonly pendingMove: SomedaySectionMove, cause: unknown) {
        super('Could not persist Someday section assignments');
        this.originalError = cause;
    }
}

export class SomedaySectionUndoSaveError extends Error {
    readonly originalError: unknown;
    constructor(public readonly pendingCount: number, cause: unknown) {
        super('Could not persist Someday section undo');
        this.originalError = cause;
    }
}

function assertSaved(result: unknown): void {
    if (result && typeof result === 'object' && 'success' in result && result.success === false) {
        throw new Error('Could not save Someday section assignments');
    }
}

/** Re-read the catalogue and tasks at Apply, rather than using picker-open rows. */
export async function saveSomedaySectionMove(
    taskIds: readonly string[],
    destinationId: string | undefined,
    selectableIds: readonly string[],
    noSectionTitle: string,
): Promise<SomedaySectionMove> {
    // The read, the plan and the write run as one command, so a sync save's newer rows are what the move builds on.
    const move = await runStoreCommand(() => writeSomedaySectionMove(taskIds, destinationId, selectableIds, noSectionTitle));
    if (move.changedCount) {
        try {
            await flushPendingSave();
        } catch (error) {
            throw new SomedaySectionMoveSaveError(move, error);
        }
    }
    return move;
}

async function writeSomedaySectionMove(
    taskIds: readonly string[],
    destinationId: string | undefined,
    selectableIds: readonly string[],
    noSectionTitle: string,
): Promise<SomedaySectionMove> {
    const state = useTaskStore.getState();
    const sections = sortViewSectionDefinitions(state.settings?.gtd?.viewSections?.someday);
    const destination = destinationId
        ? sections.find((section) => section.id === destinationId)
        : undefined;
    if (destinationId && !destination) throw new Error('Someday section no longer exists');

    const selected = new Set(selectableIds);
    const wanted = new Set(taskIds);
    const projectsById = new Map(state.projects.map((project) => [project.id, project]));
    const currentTasks = state.tasks.filter((task) => (
        wanted.has(task.id)
        && selected.has(task.id)
        && !task.deletedAt
        && task.status === 'someday'
        && isTaskInActiveProject(task, projectsById)
    ));
    if (currentTasks.length !== wanted.size) throw new Error('Selection is no longer editable');

    const updates = buildTaskViewSectionUpdates(currentTasks, 'someday', destinationId);
    const changedIds = new Set(updates.map((update) => update.id));
    const previous = currentTasks
        .filter((task) => changedIds.has(task.id))
        .map((task) => ({ id: task.id, sectionId: task.viewSectionIds?.someday }));
    const move = {
        changedCount: updates.length,
        destinationId,
        destinationTitle: destination?.title ?? noSectionTitle,
        previous,
    };
    if (updates.length) assertSaved(await state.batchUpdateTasks(updates));
    return move;
}

/** Retry a queued write without replacing the pre-write Undo snapshot. */
export async function retryPendingSomedaySectionMove(move: SomedaySectionMove): Promise<SomedaySectionMove> {
    const state = useTaskStore.getState();
    const latestById = new Map(state.tasks.map((task) => [task.id, task]));
    if (move.previous.some(({ id }) => (
        !latestById.has(id)
        || latestById.get(id)?.deletedAt
        || (latestById.get(id)?.viewSectionIds?.someday || undefined) !== move.destinationId
    ))) {
        throw new Error('Someday assignments changed before persistence retry');
    }
    await state.retryPersistence();
    return move;
}

/** Only restore this scope on tasks still assigned by the move. */
export async function undoSomedaySectionMove(move: SomedaySectionMove, pendingCount?: number): Promise<number> {
    const state = useTaskStore.getState();
    if (pendingCount !== undefined) {
        await state.retryPersistence();
        return pendingCount;
    }
    const previousIds = new Set(move.previous.map((assignment) => assignment.id));
    // Built on the rows as they are when the write is admitted, so a sync save's newer sections stay.
    const updates = await runStoreCommand(async () => {
        const latest = useTaskStore.getState();
        const latestTasks: Task[] = latest.tasks.filter((task) => previousIds.has(task.id));
        const built = buildTaskViewSectionUndoUpdates(latestTasks, 'someday', move.previous, move.destinationId);
        if (built.length) assertSaved(await latest.batchUpdateTasks(built));
        return built;
    });
    if (updates.length) {
        try {
            await flushPendingSave();
        } catch (error) {
            throw new SomedaySectionUndoSaveError(updates.length, error);
        }
    }
    return updates.length;
}
