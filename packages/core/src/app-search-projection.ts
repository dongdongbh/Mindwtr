import type { Area, Project, Task } from './types';
import { isTaskVisible } from './store-helpers';


export type AppSearchDocKind = 'task' | 'project' | 'area';

export type AppSearchDoc = {

    id: string;
    kind: AppSearchDocKind;
    title: string;
    status?: string;
    dueDate?: string;

    parentId?: string;

    deepLink: string;
};

export function appSearchDocId(kind: AppSearchDocKind, entityId: string): string {
    return `${kind}:${entityId}`;
}


export function isTaskIndexable(task: Task): boolean {
    return isTaskVisible(task) && task.status !== 'done';
}


export function isProjectIndexable(project: Project): boolean {
    return !project.deletedAt && project.status !== 'archived';
}

export function isAreaIndexable(area: Area): boolean {
    return !area.deletedAt;
}

export function buildTaskDoc(task: Task, scheme = 'mindwtr'): AppSearchDoc | null {
    if (!isTaskIndexable(task)) return null;
    return {
        id: appSearchDocId('task', task.id),
        kind: 'task',
        title: task.title,
        status: task.status,
        ...(task.dueDate ? { dueDate: task.dueDate } : {}),
        ...(task.projectId ? { parentId: task.projectId } : task.areaId ? { parentId: task.areaId } : {}),
        deepLink: `${scheme}://open?task=${encodeURIComponent(task.id)}`,
    };
}

export function buildProjectDoc(project: Project, scheme = 'mindwtr'): AppSearchDoc | null {
    if (!isProjectIndexable(project)) return null;
    return {
        id: appSearchDocId('project', project.id),
        kind: 'project',
        title: project.title,
        status: project.status,
        ...(project.areaId ? { parentId: project.areaId } : {}),
        deepLink: `${scheme}://open?project=${encodeURIComponent(project.id)}`,
    };
}

export function buildAreaDoc(area: Area, scheme = 'mindwtr'): AppSearchDoc | null {
    if (!isAreaIndexable(area)) return null;
    return {
        id: appSearchDocId('area', area.id),
        kind: 'area',
        title: area.name,
        deepLink: `${scheme}://open?area=${encodeURIComponent(area.id)}`,
    };
}

export function buildFullAppSearchIndex(params: {
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    scheme?: string;
}): AppSearchDoc[] {
    const docs: AppSearchDoc[] = [];
    for (const task of params.tasks) {
        const doc = buildTaskDoc(task, params.scheme);
        if (doc) docs.push(doc);
    }
    for (const project of params.projects) {
        const doc = buildProjectDoc(project, params.scheme);
        if (doc) docs.push(doc);
    }
    for (const area of params.areas) {
        const doc = buildAreaDoc(area, params.scheme);
        if (doc) docs.push(doc);
    }
    return docs;
}


function diffEntitiesById<T extends { id: string }>(
    prev: T[],
    next: T[],
): { changed: T[]; removedIds: string[] } {
    const prevMap = new Map(prev.map((item) => [item.id, item]));
    const nextIds = new Set<string>();
    const changed: T[] = [];
    for (const item of next) {
        nextIds.add(item.id);
        if (prevMap.get(item.id) !== item) changed.push(item);
    }
    const removedIds: string[] = [];
    for (const item of prev) {
        if (!nextIds.has(item.id)) removedIds.push(item.id);
    }
    return { changed, removedIds };
}

export type AppSearchDelta = {
    upserts: AppSearchDoc[];
    removeIds: string[];
};


export function buildAppSearchDelta(params: {
    prevTasks: Task[];
    nextTasks: Task[];
    prevProjects: Project[];
    nextProjects: Project[];
    prevAreas: Area[];
    nextAreas: Area[];
    scheme?: string;
}): AppSearchDelta {
    const upserts: AppSearchDoc[] = [];
    const removeIds: string[] = [];

    const taskDiff = diffEntitiesById(params.prevTasks, params.nextTasks);
    for (const task of taskDiff.changed) {
        const doc = buildTaskDoc(task, params.scheme);
        if (doc) upserts.push(doc); else removeIds.push(appSearchDocId('task', task.id));
    }
    for (const id of taskDiff.removedIds) removeIds.push(appSearchDocId('task', id));

    const projectDiff = diffEntitiesById(params.prevProjects, params.nextProjects);
    for (const project of projectDiff.changed) {
        const doc = buildProjectDoc(project, params.scheme);
        if (doc) upserts.push(doc); else removeIds.push(appSearchDocId('project', project.id));
    }
    for (const id of projectDiff.removedIds) removeIds.push(appSearchDocId('project', id));

    const areaDiff = diffEntitiesById(params.prevAreas, params.nextAreas);
    for (const area of areaDiff.changed) {
        const doc = buildAreaDoc(area, params.scheme);
        if (doc) upserts.push(doc); else removeIds.push(appSearchDocId('area', area.id));
    }
    for (const id of areaDiff.removedIds) removeIds.push(appSearchDocId('area', id));

    return { upserts, removeIds };
}
