import { CLOCK_SKEW_THRESHOLD_MS } from './sync-types';
import type { AppData, Section, Task } from './types';

export type SqliteCopyRepairCounts = {

    nullEntries: number;
    untitledTasks: number;
    untitledProjects: number;
    untitledSections: number;
    unnamedAreas: number;

    missingCreatedAt: number;

    orphanSections: number;
};

const PLACEHOLDER_TITLE = 'Untitled';


const REPAIRED_ROW_AGE_MS = CLOCK_SKEW_THRESHOLD_MS + 1;
const ENTITY_LISTS = ['tasks', 'projects', 'sections', 'areas', 'people'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);


export function repairAppDataForSqlite(
    data: AppData,
    current: Partial<Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas'>> = {},
): { data: AppData; counts: SqliteCopyRepairCounts } {
    const counts: SqliteCopyRepairCounts = {
        nullEntries: 0,
        untitledTasks: 0,
        untitledProjects: 0,
        untitledSections: 0,
        unnamedAreas: 0,
        missingCreatedAt: 0,
        orphanSections: 0,
    };
    const repaired = { ...data };
    for (const list of ENTITY_LISTS) {
        const entries = (Array.isArray(data[list]) ? data[list] : []) as unknown[];
        const kept = entries.filter(isRecord);
        counts.nullEntries += entries.length - kept.length;
        (repaired as Record<string, unknown>)[list] = kept;
    }

    const byId = <T extends { id: string }>(rows: T[] | undefined) => new Map((rows ?? []).map((row) => [row.id, row] as const));
    const currentTasks = byId(current.tasks);
    const currentProjects = byId(current.projects);
    const currentSections = byId(current.sections);
    const currentAreas = byId(current.areas);

    type Dated = { createdAt?: string; updatedAt?: string };
    const withCreatedAt = <T extends Dated>(row: T, stored: Dated | undefined): T => {
        if (row.createdAt != null) return row;
        counts.missingCreatedAt += 1;
        return { ...row, createdAt: stored?.createdAt ?? row.updatedAt ?? new Date().toISOString() };
    };

    const aged = <T extends Dated>(row: T): T => {
        const updatedMs = typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : Number.NaN;
        if (!Number.isFinite(updatedMs)) return row;
        const updatedAt = new Date(updatedMs - REPAIRED_ROW_AGE_MS).toISOString();
        const createdMs = typeof row.createdAt === 'string' ? Date.parse(row.createdAt) : Number.NaN;


        const createdAt = Number.isFinite(createdMs) && createdMs > updatedMs - REPAIRED_ROW_AGE_MS ? updatedAt : row.createdAt;
        return { ...row, updatedAt, createdAt };
    };

    repaired.projects = repaired.projects.map((project) => {
        const stored = currentProjects.get(project.id);
        let next = project;
        if (next.title == null) {
            counts.untitledProjects += 1;
            next = { ...next, title: stored?.title ?? PLACEHOLDER_TITLE };
        }
        next = withCreatedAt(next, stored);
        return next === project ? project : aged(next);
    });

    const projectIds = new Set<string>(currentProjects.keys());
    for (const project of repaired.projects) projectIds.add(project.id);
    const droppedSectionIds = new Set<string>();
    repaired.sections = repaired.sections.flatMap((section): Section[] => {
        if (typeof section.projectId !== 'string' || !projectIds.has(section.projectId)) {
            counts.orphanSections += 1;
            droppedSectionIds.add(section.id);
            return [];
        }
        const stored = currentSections.get(section.id);
        let next = section;
        if (next.title == null) {
            counts.untitledSections += 1;
            next = { ...next, title: stored?.title ?? PLACEHOLDER_TITLE };
        }
        next = withCreatedAt(next, stored);
        return [next === section ? section : aged(next)];
    });

    repaired.areas = repaired.areas.map((area) => {
        if (area.name != null) return area;
        counts.unnamedAreas += 1;
        return aged({ ...area, name: currentAreas.get(area.id)?.name ?? PLACEHOLDER_TITLE });
    });

    repaired.tasks = repaired.tasks.map((task): Task => {
        let next = task;
        if (next.title == null) {
            counts.untitledTasks += 1;
            next = { ...next, title: currentTasks.get(task.id)?.title ?? PLACEHOLDER_TITLE };
        }
        if (next.sectionId && droppedSectionIds.has(next.sectionId)) {
            next = { ...next, sectionId: undefined };
        }
        return next === task ? task : aged(next);
    });

    return { data: repaired, counts };
}

export const countSqliteCopyRepairs = (counts: SqliteCopyRepairCounts): number => (
    Object.values(counts).reduce((total, count) => total + count, 0)
);
