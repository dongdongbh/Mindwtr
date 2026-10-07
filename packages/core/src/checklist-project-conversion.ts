import type { Task, Project } from './types';
import type { TaskStore } from './store-types';
import { buildNewProject } from './store-projects/project-actions';
import { buildNewTask } from './task-creation';
import { createProjectOrderReserver, ensureDeviceId, nextRevision, persist, getNextDataChangeAt } from './store-helpers';
import { taskEditValuesEqual as same } from './json-value-equality';
import { generateUUID } from './uuid';
import { logInfo } from './logger';

type State = Pick<TaskStore, '_allTasks' | '_allProjects' | '_allSections' | '_allAreas' | 'settings'>;
export type ChecklistProjectConversion = {
    source: Task; retired: Task; project: Project; tasks: Task[];
    deviceIdBefore?: string; deviceId: string;
};

/** These task-only commitments cannot be transferred to a project safely. */
export function checklistProjectBlockReason(task: Partial<Task>): string | null {
    if (!task.checklist?.length || task.checklist.some(item => !item.title.trim())) return 'task.expandChecklistInvalid';
    if (task.deletedAt || task.purgedAt || task.cancelledAt || task.archivedAt
        || (task.status && !['inbox', 'next', 'done'].includes(task.status))) return 'task.expandChecklistInactive';
    if (task.recurrence || task.relativeStartOffset || task.repeatReminderMinutes || task.reviewAt?.includes('T')
        || (!task.suppressMindwtrReminders && [task.startTime, task.dueDate].some(value => value?.includes('T'))))
        return 'task.expandChecklistSchedule';
    if (task.assignedTo || task.location || task.timeEstimate || task.timeSpentMinutes)
        return 'task.expandChecklistMetadata';
    return null;
}

export function prepareChecklistProjectConversion(state: State, source: Task, title: string,
    ids = { project: generateUUID(), tasks: source.checklist?.map(() => generateUUID()) ?? [] },
    now = new Date().toISOString(), deviceId?: string): { success: true; command: ChecklistProjectConversion } | { success: false; error: string } {
    const blocked = checklistProjectBlockReason(source);
    if (blocked) return { success: false, error: blocked };
    if (!title.trim()) return { success: false, error: 'common.validationRequired' };
    if (ids.tasks.length !== source.checklist!.length
        || new Set([source.id, ids.project, ...ids.tasks]).size !== ids.tasks.length + 2)
        return { success: false, error: 'task.expandChecklistConflict' };
    const sourceProject = state._allProjects.find(project => project.id === source.projectId);
    if (source.projectId && (!sourceProject || sourceProject.deletedAt || sourceProject.status !== 'active'))
        return { success: false, error: 'task.expandChecklistInactive' };
    const areaId = sourceProject?.areaId ?? source.areaId;
    if (areaId && !state._allAreas.some(area => area.id === areaId && !area.deletedAt))
        return { success: false, error: 'task.expandChecklistConflict' };
    if (state._allProjects.some(project => !project.deletedAt && project.areaId === areaId
        && project.title.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase()))
        return { success: false, error: 'task.expandChecklistNameExists' };
    const device = ensureDeviceId(deviceId ? { ...state.settings, deviceId } : state.settings);
    const project = buildNewProject({ title: title.trim(), id: ids.project, now, deviceId: device.deviceId,
        initialProps: { areaId, supportNotes: source.description, attachments: source.attachments,
            startDate: source.startTime, dueDate: source.dueDate, reviewAt: source.reviewAt, tagIds: source.tags },
        existingProjects: state._allProjects, existingAreas: state._allAreas, settings: state.settings });
    const tasks: Task[] = [];
    const reserve = createProjectOrderReserver([]);
    for (const [index, item] of source.checklist!.entries()) {
        const built = buildNewTask({ title: item.title, id: ids.tasks[index], now, deviceId: device.deviceId,
            initialTaskProps: { projectId: project.id, status: item.isCompleted ? 'done' : 'next',
                tags: source.tags, contexts: source.contexts, priority: source.priority, energyLevel: source.energyLevel },
            state: { ...state, _allProjects: [...state._allProjects, project] }, tasks: [],
            focusedCount: 0, focusTaskLimit: 0, projectOrderReserver: reserve });
        if (!built.ok) return { success: false, error: built.error };
        // Keep the shared creation-time completion fallback for checked items.
        tasks.push(built.task);
    }
    const retired = { ...source, deletedAt: now, updatedAt: now, rev: nextRevision(source.rev), revBy: device.deviceId };
    return { success: true, command: JSON.parse(JSON.stringify({ source, retired, project, tasks,
        deviceIdBefore: state.settings.deviceId, deviceId: device.deviceId })) };
}

type Context = {
    set: Parameters<typeof persist>[0];
    get: () => TaskStore;
    debouncedSave: Parameters<typeof persist>[1];
    flushPendingSave: () => Promise<void>;
};

const retiredChecklistTask = (task: Task, now: string, deviceId: Task['revBy']): Task => ({
    ...task, projectId: undefined, sectionId: undefined, order: undefined, orderNum: undefined,
    deletedAt: now, updatedAt: now, rev: nextRevision(task.rev), revBy: deviceId,
});

/** One snapshot write, with a frozen identity for save retries and conservative Undo. */
export function createChecklistProjectConversionActions({ set, get, debouncedSave, flushPendingSave }: Context):
    Pick<TaskStore, 'convertChecklistToProject' | 'undoChecklistToProject'> {
    const footprint = (state: State, command: ChecklistProjectConversion, undone = false) => {
        const source = state._allTasks.find(row => row.id === command.source.id);
        const project = state._allProjects.find(row => row.id === command.project.id);
        if (!source || !project) return false;
        const ids = new Set(command.tasks.map(task => task.id));
        if (state._allTasks.some(task => task.projectId === project.id && !ids.has(task.id))
            || state._allSections.some(section => section.projectId === project.id)) return false;
        if (!undone) return same(source, command.retired) && same(project, command.project)
            && command.tasks.every(task => same(state._allTasks.find(row => row.id === task.id), task));
        const now = project.deletedAt;
        if (!now || source.rev !== nextRevision(command.retired.rev) || project.rev !== nextRevision(command.project.rev)) return false;
        const restored = { ...command.source, rev: source.rev, revBy: source.revBy, updatedAt: now };
        const tombstone = <T extends Task | Project>(row: T) => ({ ...row, deletedAt: now, updatedAt: now,
            rev: nextRevision(row.rev), revBy: source.revBy });
        return same(source, restored) && same(project, tombstone(command.project))
            && command.tasks.every(task => same(state._allTasks.find(row => row.id === task.id), retiredChecklistTask(task, now, source.revBy)));
    };
    const run = async (command: ChecklistProjectConversion, undo: boolean) => {
        let accepted = false;
        set(state => {
            if (footprint(state, command, undo)) { accepted = true; return state; }
            if (undo ? !footprint(state, command) : !same(state._tasksById.get(command.source.id), command.source)) return state;
            if (!undo) {
                if (state.settings.deviceId !== command.deviceIdBefore
                    || state._allProjects.some(row => row.id === command.project.id)
                    || command.tasks.some(task => state._tasksById.has(task.id))) return state;
                const planned = prepareChecklistProjectConversion(state, command.source, command.project.title,
                    { project: command.project.id, tasks: command.tasks.map(task => task.id) }, command.project.createdAt, command.deviceId);
                if (!planned.success || !same(planned.command, command)) return state;
            } else {
                // Restoring must not put the source back in a deleted container.
                if (command.source.projectId && !state._allProjects.some(row => row.id === command.source.projectId
                    && !row.deletedAt && !row.purgedAt && row.status !== 'archived')) return state;
                if (command.source.sectionId && !state._allSections.some(row => row.id === command.source.sectionId && row.projectId === command.source.projectId && !row.deletedAt)) return state;
                if (command.source.areaId && !state._allAreas.some(row => row.id === command.source.areaId && !row.deletedAt)) return state;
            }
            const now = new Date().toISOString();
            const deviceId = state.settings.deviceId ?? command.deviceId;
            const tombstone = <T extends Task | Project>(row: T): T => ({ ...row, deletedAt: now, updatedAt: now,
                rev: nextRevision(row.rev), revBy: deviceId });
            const source = undo ? { ...command.source, updatedAt: now, rev: nextRevision(command.retired.rev), revBy: deviceId } : command.retired;
            const generated = new Map(command.tasks.map(task => [task.id, retiredChecklistTask(task, now, deviceId)]));
            const tasks = state._allTasks.map(task => task.id === source.id ? source : undo ? generated.get(task.id) ?? task : task);
            const projects = undo ? state._allProjects.map(project => project.id === command.project.id ? tombstone(project) : project)
                : [...state._allProjects, command.project];
            if (!undo) tasks.push(...command.tasks);
            const settings = { ...state.settings, deviceId };
            persist(set, debouncedSave, state, { tasks, projects, settings });
            accepted = true;
            return { _allTasks: tasks, _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        if (!accepted) return { success: false, error: 'task.expandChecklistConflict' };
        try {
            if (get().persistenceFailure) await get().retryPersistence();
            else await flushPendingSave();
        } catch { return { success: false, error: 'task.expandChecklistSaveFailed' }; }
        if (!footprint(get(), command, undo)) return { success: false, error: 'task.expandChecklistConflict' };
        logInfo('Checklist project conversion saved', { scope: 'store', category: 'storage',
            context: { releaseCheck: 'v1.3.5/checklist-project-canonical', operation: undo ? 'undo' : 'convert', count: command.tasks.length } });
        return { success: true, id: undo ? command.source.id : command.project.id };
    };
    return { convertChecklistToProject: command => run(command, false), undoChecklistToProject: command => run(command, true) };
}
