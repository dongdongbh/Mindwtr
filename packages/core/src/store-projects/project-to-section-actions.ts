import { clearDerivedCache } from '../store-settings';
import { getNextDataChangeAt, nextRevision, persist } from '../store-helpers';
import { logInfo } from '../logger';
import { planProjectToSection, sameProjectToSectionValue } from '../project-to-section';
import type { PreparedProjectToSection } from '../project-to-section';
import type { Project, Section, Task } from '../types';
import type { ProjectActionContext, ProjectToSectionActions } from './shared';

const fail = (reason: 'conflict' | 'save-failed' | 'invalid') => ({
    success: false as const, reason,
    error: reason === 'save-failed' ? 'Project conversion could not be saved'
        : reason === 'invalid' ? 'Invalid project conversion' : 'Project conversion conflicts with current data',
});

const one = <T extends { id: string }>(rows: readonly T[], id: string): T | undefined => {
    const matches = rows.filter((row) => row.id === id);
    return matches.length === 1 ? matches[0] : undefined;
};

const taskAssignment = (task: Task) => ({ projectId: task.projectId, sectionId: task.sectionId,
    areaId: task.areaId, order: task.order, orderNum: task.orderNum });
const sameAssignment = (left: Task, right: Task): boolean =>
    sameProjectToSectionValue(taskAssignment(left), taskAssignment(right));

const hasConvertedFootprint = (state: { _allProjects: Project[]; _allSections: Section[]; _allTasks: Task[] },
    command: PreparedProjectToSection): boolean => {
    const source = one(state._allProjects, command.sourceProjectId);
    const section = one(state._allSections, command.sectionId);
    const movedIds = new Set(command.tasks.map(({ before }) => before.id));
    if (!source || !section || !sameProjectToSectionValue(source, command.source.after)
        || !sameProjectToSectionValue(section, command.section)
        || !one(state._allProjects, command.destinationProjectId)
        || state._allTasks.some((task) => task.projectId === command.sourceProjectId
            && !task.deletedAt && !task.purgedAt)
        || state._allTasks.some((task) => task.sectionId === command.sectionId
            && !movedIds.has(task.id))) return false;
    return command.tasks.every(({ after }) => {
        const task = one(state._allTasks, after.id);
        return task && !task.deletedAt && !task.purgedAt && sameAssignment(task, after);
    });
};

const hasUndoneFootprint = (state: { _allProjects: Project[]; _allSections: Section[]; _allTasks: Task[] },
    command: PreparedProjectToSection): boolean => {
    const source = one(state._allProjects, command.sourceProjectId);
    const section = one(state._allSections, command.sectionId);
    if (!source || !section || source.deletedAt || source.purgedAt || !section.deletedAt
        || source.rev !== nextRevision(command.source.after.rev)
        || section.rev !== nextRevision(command.section.rev)
        || source.updatedAt !== section.deletedAt
        || source.revBy !== section.revBy
        || state._allTasks.some((task) => task.sectionId === command.sectionId))
        return false;
    const restoredSource = { ...command.source.after, deletedAt: undefined,
        updatedAt: source.updatedAt, rev: source.rev, revBy: source.revBy };
    if (!sameProjectToSectionValue(source, restoredSource)) return false;
    const deletedSection = { ...command.section, deletedAt: section.deletedAt,
        updatedAt: section.updatedAt, rev: section.rev, revBy: section.revBy };
    if (!sameProjectToSectionValue(section, deletedSection)) return false;
    return command.tasks.every(({ before, after }) => {
        const task = one(state._allTasks, before.id);
        return task && !task.deletedAt && !task.purgedAt
            && (task.rev ?? 0) >= nextRevision(after.rev)
            && sameAssignment(task, before);
    });
};

export const createProjectToSectionActions = ({ set, get, debouncedSave, flushPendingSave }:
    ProjectActionContext): ProjectToSectionActions => ({
    convertProjectToSection: async (command) => {
        if (!command || !command.sourceProjectId || !command.destinationProjectId || !command.sectionId)
            return fail('invalid');
        let outcome: 'applied' | 'replayed' | 'conflict' = 'conflict';
        set((state) => {
            if (hasConvertedFootprint(state, command)) {
                outcome = 'replayed';
                return state;
            }
            if ((state.settings.deviceId ?? null) !== command.deviceIdBefore
                || (command.deviceIdBefore === null ? !command.deviceIdToInitialize : command.deviceIdToInitialize !== null))
                return state;
            const planned = planProjectToSection(state, command.sourceProjectId,
                command.destinationProjectId, command.section.title, command.sectionId,
                command.preparedAt, command.deviceIdBefore, command.deviceIdToInitialize);
            if (!planned.ok || !sameProjectToSectionValue(planned.command, command)) return state;
            const changed = new Map(command.tasks.map(({ after }) => [after.id, after]));
            if (changed.size !== command.tasks.length) return state;
            const tasks = state._allTasks.map((task) => changed.get(task.id) ?? task);
            const projects = state._allProjects.map((project) => project.id === command.sourceProjectId
                ? command.source.after : project);
            const sections = [...state._allSections, command.section];
            const settings = command.deviceIdToInitialize
                ? { ...state.settings, deviceId: command.deviceIdToInitialize } : state.settings;
            clearDerivedCache();
            persist(set, debouncedSave, state, { tasks, projects, sections,
                ...(settings !== state.settings ? { settings } : {}) });
            outcome = 'applied';
            return { _allTasks: tasks, _allProjects: projects, _allSections: sections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        if (outcome === 'conflict') return fail('conflict');
        try {
            if (outcome === 'replayed' && get().persistenceFailure) await get().retryPersistence();
            else await flushPendingSave();
        } catch {
            return fail('save-failed');
        }
        if (!hasConvertedFootprint(get(), command)) return fail('conflict');
        logInfo('Project converted to section', { scope: 'store', category: 'storage',
            context: { releaseCheck: command.source.before.isSequential
                ? 'v1.3.7/sequential-project-to-section' : 'v1.3.4/project-to-section', operation: 'convert',
                outcome: 'confirmed', count: command.tasks.length } });
        return { success: true, receipt: command,
            sectionId: command.sectionId, destinationProjectId: command.destinationProjectId };
    },

    undoProjectToSection: async (receipt) => {
        if (!receipt || !receipt.sourceProjectId || !receipt.destinationProjectId || !receipt.sectionId)
            return fail('invalid');
        let outcome: 'applied' | 'replayed' | 'conflict' = 'conflict';
        set((state) => {
            if (hasUndoneFootprint(state, receipt)) {
                outcome = 'replayed';
                return state;
            }
            const source = one(state._allProjects, receipt.sourceProjectId);
            const destination = one(state._allProjects, receipt.destinationProjectId);
            const section = one(state._allSections, receipt.sectionId);
            const moved = new Map(receipt.tasks.map(({ after }) => [after.id, after]));
            if (!source || !destination || !section || moved.size !== receipt.tasks.length
                || destination.deletedAt || destination.purgedAt || destination.status !== 'active'
                || destination.archivedAt || destination.cancelledAt
                || !sameProjectToSectionValue(source, receipt.source.after)
                || !sameProjectToSectionValue(section, receipt.section)
                || state._allTasks.some((task) => task.sectionId === receipt.sectionId
                    && !moved.has(task.id))
                || state._allTasks.some((task) => task.projectId === receipt.sourceProjectId
                    && !task.deletedAt && !task.purgedAt)
                || (source.areaId && !state._allAreas.some((area) => area.id === source.areaId && !area.deletedAt))
                || receipt.tasks.some(({ after }) => {
                    const current = one(state._allTasks, after.id);
                    return !current || current.deletedAt || current.purgedAt || !sameAssignment(current, after);
                })) return state;
            const deviceId = state.settings.deviceId;
            if (!deviceId) return state;
            const now = new Date().toISOString();
            const sourceAfter: Project = { ...source, deletedAt: undefined, updatedAt: now,
                rev: nextRevision(source.rev), revBy: deviceId };
            const sectionAfter: Section = { ...section, deletedAt: now, updatedAt: now,
                rev: nextRevision(section.rev), revBy: deviceId };
            const beforeById = new Map(receipt.tasks.map(({ before }) => [before.id, before]));
            const tasks = state._allTasks.map((task) => {
                const before = beforeById.get(task.id);
                return before ? { ...task, ...taskAssignment(before), updatedAt: now,
                    rev: nextRevision(task.rev), revBy: deviceId } : task;
            });
            const projects = state._allProjects.map((project) => project.id === source.id ? sourceAfter : project);
            const sections = state._allSections.map((row) => row.id === section.id ? sectionAfter : row);
            clearDerivedCache();
            persist(set, debouncedSave, state, { tasks, projects, sections });
            outcome = 'applied';
            return { _allTasks: tasks, _allProjects: projects, _allSections: sections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        if (outcome === 'conflict') return fail('conflict');
        try {
            if (outcome === 'replayed' && get().persistenceFailure) await get().retryPersistence();
            else await flushPendingSave();
        } catch {
            return fail('save-failed');
        }
        if (!hasUndoneFootprint(get(), receipt)) return fail('conflict');
        logInfo('Project to section undone', { scope: 'store', category: 'storage',
            context: { releaseCheck: 'v1.3.4/project-to-section', operation: 'undo',
                outcome: 'confirmed', count: receipt.tasks.length } });
        return { success: true, sourceProjectId: receipt.sourceProjectId };
    },
});
