import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { planManageEditorSave } from './manage-settings-model';
import { taskEditValuesEqual } from './json-value-equality';
import { areaToSqliteRow } from './area-sync-schema';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import { sectionToSqliteRow } from './section-sync-schema';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from './task-sync-schema';
import { nextRevision } from './store-helpers';
import type { Area, Project, Section, Task } from './types';

export type AreaRenameRows = { areas: Area[]; projects: Project[]; tasks: Task[] };
export type AreaRenameResult = { id: string; areaId: string; name: string };
export type AreaRenameScope = AreaRenameRows;
export type AreaRenameEffect = {
    areas: Array<{ before: Area; after: Area }>;
    projects: Array<{ before: Project; after: Project }>;
    tasks: Array<{ before: Task; after: Task }>;
};

export type AreaRenamePlan = AreaRenameRows & {
    result: AreaRenameResult;
    merged: boolean;
    projectsChanged: boolean;
    repairedDestinationProjects: number;
};

/** Version 1 retains frozen pre-override journals; new writes use the current color policy. */
export function planAreaRename(rows: AreaRenameRows, areaId: string, updates: Partial<Area>,
    deviceId: string, now: string, version: 1 | 2 = 2): AreaRenamePlan | null {
    const source = rows.areas.find((area) => area.id === areaId);
    const name = updates.name?.trim() ?? '';
    if (!source || !name) return null;
    const normalized = name.toLowerCase();
    const destination = rows.areas.find((area) => area.id !== areaId && !area.deletedAt
        && area.name?.trim().toLowerCase() === normalized);

    if (destination) {
        const deletedSource: Area = { ...source, deletedAt: now, updatedAt: now,
            rev: nextRevision(source.rev), revBy: deviceId };
        const survivingArea: Area = { ...destination, ...updates, name, updatedAt: now,
            rev: nextRevision(destination.rev), revBy: deviceId };
        let projectsChanged = false;
        let repairedDestinationProjects = 0;
        const projects = rows.projects.map((project) => {
            if (project.areaId === destination.id) {
                if (project.areaTitle === survivingArea.name) return project;
                projectsChanged = true;
                repairedDestinationProjects += 1;
                return { ...project, areaTitle: survivingArea.name, updatedAt: now,
                    rev: nextRevision(project.rev), revBy: deviceId };
            }
            if (project.areaId !== areaId) return project;
            projectsChanged = true;
            return { ...project, areaId: destination.id, areaTitle: survivingArea.name,
                color: version === 1 ? survivingArea.color ?? project.color
                    : project.colorOverride ?? survivingArea.color ?? DEFAULT_PROJECT_COLOR, updatedAt: now,
                rev: nextRevision(project.rev), revBy: deviceId };
        });
        const tasks = rows.tasks.map((task) => {
            if (task.areaId !== areaId) return task;
            return { ...task, areaId: task.projectId ? undefined : destination.id, updatedAt: now,
                rev: nextRevision(task.rev), revBy: deviceId };
        });
        return {
            areas: rows.areas.filter((area) => area.id !== areaId && area.id !== destination.id)
                .concat(deletedSource, survivingArea).sort((left, right) => left.order - right.order),
            projects,
            tasks,
            result: { id: areaId, areaId: destination.id, name },
            merged: true,
            projectsChanged,
            repairedDestinationProjects,
        };
    }

    const nextOrder = Number.isFinite(updates.order) ? updates.order! : source.order;
    const repaintColor = Object.prototype.hasOwnProperty.call(updates, 'color');
    const nextColor = updates.color ?? DEFAULT_PROJECT_COLOR;
    let projectsChanged = false;
    const projects = !repaintColor && name === source.name.trim() ? rows.projects : rows.projects.map((project) => {
        if (project.areaId !== areaId) return project;
        const wantsColor = repaintColor && (version === 1 || project.colorOverride == null) && project.color !== nextColor;
        const wantsTitle = project.areaTitle !== name;
        if (!wantsColor && !wantsTitle) return project;
        projectsChanged = true;
        return { ...project, ...(wantsColor ? { color: nextColor } : {}),
            ...(wantsTitle ? { areaTitle: name } : {}), updatedAt: now,
            rev: nextRevision(project.rev), revBy: deviceId };
    });
    const renamed: Area = { ...source, ...updates, name, order: nextOrder, updatedAt: now,
        rev: nextRevision(source.rev), revBy: deviceId };
    return {
        areas: rows.areas.map((area) => area.id === areaId ? renamed : area)
            .sort((left, right) => left.order - right.order),
        projects,
        tasks: rows.tasks,
        result: { id: areaId, areaId, name },
        merged: false,
        projectsChanged,
        repairedDestinationProjects: 0,
    };
}

/** The existing updateArea color branch, including its denormalized Project title repair. */
export function planAreaColorChange(area: Area, projects: Project[], color: string | undefined,
    deviceId: string, now: string, version: 1 | 2 = 2): { area: Area; projects: Project[]; projectsChanged: boolean } {
    const targetColor = color ?? DEFAULT_PROJECT_COLOR;
    const title = area.name.trim() || undefined;
    let projectsChanged = false;
    const nextProjects = projects.map((project) => {
        if (project.areaId !== area.id) return project;
        const wantsColor = (version === 1 || project.colorOverride == null) && project.color !== targetColor;
        const wantsTitle = project.areaTitle !== title;
        if (!wantsColor && !wantsTitle) return project;
        projectsChanged = true;
        return { ...project,
            ...(wantsColor ? { color: targetColor } : {}),
            ...(wantsTitle ? { areaTitle: title } : {}),
            updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId };
    });
    return { area: { ...area, color, name: area.name, order: area.order,
        updatedAt: now, rev: nextRevision(area.rev), revBy: deviceId },
        projects: nextProjects, projectsChanged };
}

/** One Settings editor save, using the same diff policy as the React Native editor. */
export function planAreaEditorSave(rows: AreaRenameRows, areaId: string, name: string,
    manageColor: string | undefined, deviceId: string, now: string, version: 1 | 2 = 2): AreaRenamePlan | null {
    const source = rows.areas.find((area) => area.id === areaId);
    if (!source || !name.trim()) return null;
    if (manageColor === undefined) return planAreaRename(rows, areaId, { name }, deviceId, now, version);
    const writes = planManageEditorSave({ type: 'area', id: source.id, name: source.name, color: source.color },
        { name, color: manageColor, note: '', referenceLink: '' }, {});
    if (!writes?.length || writes[0].kind !== 'updateArea') return null;
    const updates = writes[0].updates;
    if (updates.name !== undefined) return planAreaRename(rows, areaId, updates, deviceId, now, version);
    const planned = planAreaColorChange(source, rows.projects, updates.color, deviceId, now, version);
    return { areas: rows.areas.map((row) => row.id === areaId ? planned.area : row),
        projects: planned.projects, tasks: rows.tasks,
        result: { id: areaId, areaId, name: source.name }, merged: false,
        projectsChanged: planned.projectsChanged, repairedDestinationProjects: 0 };
}

export function selectAreaRenameScope(rows: AreaRenameRows, sourceId: string,
    destinationId: string): AreaRenameScope {
    const linkedAreaIds = new Set([sourceId, destinationId]);
    return {
        areas: rows.areas.filter((area) => !area.deletedAt),
        projects: rows.projects.filter((project) => project.areaId && linkedAreaIds.has(project.areaId)),
        tasks: rows.tasks.filter((task) => task.areaId === sourceId),
    };
}

const sameJsonSqliteRow = (columns: readonly string[], jsonColumns: ReadonlySet<string>,
    left: unknown[], right: unknown[]): boolean => left.length === right.length && left.every((value, index) => {
    const other = right[index];
    if (!jsonColumns.has(columns[index]) || typeof value !== 'string' || typeof other !== 'string') {
        return Object.is(value, other);
    }
    return taskEditValuesEqual(JSON.parse(value), JSON.parse(other));
});
const projectJsonColumns = new Set(['tagIds', 'attachments']);
const taskJsonColumns = new Set(['relativeStartOffset', 'recurrence', 'tags', 'contexts',
    'checklist', 'attachments', 'viewSectionIds']);

/** SQLite-row equality used by every prepared Area command. */
export const sameAreaAdditionRow = {
    area: (left: Area, right: Area) => JSON.stringify(areaToSqliteRow(left, left.updatedAt))
        === JSON.stringify(areaToSqliteRow(right, right.updatedAt)),
    project: (left: Project, right: Project) => sameJsonSqliteRow(PROJECT_SQLITE_COLUMNS, projectJsonColumns,
        projectToSqliteRow(left), projectToSqliteRow(right)),
    section: (left: Section, right: Section) => JSON.stringify(sectionToSqliteRow(left))
        === JSON.stringify(sectionToSqliteRow(right)),
    task: (left: Task, right: Task) => sameJsonSqliteRow(TASK_SQLITE_COLUMNS, taskJsonColumns,
        taskToSqliteRow(left), taskToSqliteRow(right)),
};

export function areaRenameEffect(scope: AreaRenameScope, areaId: string, name: string,
    deviceId: string, now: string, manageColor?: string, version: 1 | 2 = 2): { effect: AreaRenameEffect; result: AreaRenameResult } | null {
    const planned = planAreaEditorSave(scope, areaId, name, manageColor, deviceId, now, version);
    if (!planned) return null;
    const changed = <T extends { id: string }>(before: T[], after: T[],
        same: (left: T, right: T) => boolean): Array<{ before: T; after: T }> => {
        const afterById = new Map(after.map((row) => [row.id, row]));
        return before.flatMap((row) => {
            const next = afterById.get(row.id);
            return next && !same(row, next) ? [{ before: row, after: next }] : [];
        });
    };
    return { result: planned.result, effect: {
        areas: changed(scope.areas, planned.areas, sameAreaAdditionRow.area),
        projects: changed(scope.projects, planned.projects, sameAreaAdditionRow.project),
        tasks: changed(scope.tasks, planned.tasks, sameAreaAdditionRow.task),
    } };
}
