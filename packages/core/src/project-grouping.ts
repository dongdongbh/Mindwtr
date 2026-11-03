import { projectMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import type { Area, Project } from './types';

export type ProjectTagFilter =
    | { kind: 'all' }
    | { kind: 'untagged' }
    | { kind: 'tag'; value: string };

export type ProjectAreaGroup = {
    areaId?: string;
    projects: Project[];
};

export type ProjectGroups = {
    active: ProjectAreaGroup[];
    deferred: ProjectAreaGroup[];
    archived: ProjectAreaGroup[];
    tagInventory: {
        values: string[];
        hasUntagged: boolean;
    };
};

type BuildProjectGroupsInput = {
    projects: Project[];
    orderedAreas: Area[];
    areaFilter: AreaFilterSelection;
    tagFilter: ProjectTagFilter;


    pinFocused?: boolean;
};

const projectOrder = (project: Project): number => (
    Number.isFinite(project.order) ? project.order : 0
);

const groupProjectsByArea = (
    projects: Project[],
    orderedAreas: Area[],
    areaById: Map<string, Area>,
): ProjectAreaGroup[] => {
    const byArea = new Map<string | undefined, Project[]>();
    projects.forEach((project) => {
        const areaId = project.areaId && areaById.has(project.areaId)
            ? project.areaId
            : undefined;
        const entries = byArea.get(areaId) ?? [];
        entries.push(project);
        byArea.set(areaId, entries);
    });

    const groups: ProjectAreaGroup[] = orderedAreas.flatMap((area) => {
        const entries = byArea.get(area.id);
        return entries?.length ? [{ areaId: area.id, projects: entries }] : [];
    });
    const noAreaProjects = byArea.get(undefined);
    if (noAreaProjects?.length) groups.push({ areaId: undefined, projects: noAreaProjects });
    return groups;
};

export function buildProjectGroups({
    projects,
    orderedAreas,
    areaFilter,
    tagFilter,
    pinFocused = false,
}: BuildProjectGroupsInput): ProjectGroups {
    const visibleProjects = projects
        .filter((project) => !project.deletedAt)
        .sort((a, b) => {
            if (pinFocused && (a.isFocused === true) !== (b.isFocused === true)) return a.isFocused === true ? -1 : 1;
            const orderDiff = projectOrder(a) - projectOrder(b);
            return orderDiff || a.title.localeCompare(b.title);
        });
    const activeAreas = orderedAreas.filter((area) => !area.deletedAt);
    const areaById = new Map(activeAreas.map((area) => [area.id, area]));
    const tagValues = new Set<string>();
    let hasUntagged = false;
    visibleProjects.forEach((project) => {
        const values = project.tagIds ?? [];
        if (values.length === 0) hasUntagged = true;
        values.forEach((value) => tagValues.add(value));
    });
    const filteredProjects = visibleProjects.filter((project) => {
        if (!projectMatchesAreaFilterSelection(project, areaFilter, areaById)) return false;
        const values = project.tagIds ?? [];
        if (tagFilter.kind === 'untagged') return values.length === 0;
        if (tagFilter.kind === 'tag') return values.includes(tagFilter.value);
        return true;
    });

    const active: Project[] = [];
    const deferred: Project[] = [];
    const archived: Project[] = [];
    filteredProjects.forEach((project) => {
        if (project.status === 'archived') {
            archived.push(project);
        } else if (project.status === 'waiting' || project.status === 'someday') {
            deferred.push(project);
        } else {
            active.push(project);
        }
    });

    return {
        active: groupProjectsByArea(active, activeAreas, areaById),
        deferred: groupProjectsByArea(deferred, activeAreas, areaById),
        archived: groupProjectsByArea(archived, activeAreas, areaById),
        tagInventory: {
            values: Array.from(tagValues).sort(),
            hasUntagged,
        },
    };
}


const canSwapProjects = (project: Project | undefined, neighbour: Project | undefined): boolean =>
    Boolean(project && neighbour) && (project!.isFocused === true) === (neighbour!.isFocused === true)
    && (project!.areaId ?? undefined) === (neighbour!.areaId ?? undefined);


export function getProjectMoveOptions(group: ProjectAreaGroup): Array<{ up: boolean; down: boolean }> {
    return group.projects.map((project, index) => ({
        up: canSwapProjects(project, group.projects[index - 1]),
        down: canSwapProjects(project, group.projects[index + 1]),
    }));
}


export function planProjectMove(
    group: ProjectAreaGroup,
    projects: Project[],
    projectId: string,
    direction: 'up' | 'down',
): { areaId?: string; orderedIds: string[] } | null {
    const index = group.projects.findIndex((project) => project.id === projectId);
    const project = group.projects[index];
    const neighbour = project ? group.projects[index + (direction === 'up' ? -1 : 1)] : undefined;
    if (!project || !neighbour || !canSwapProjects(project, neighbour)) return null;
    const areaId = project.areaId ?? undefined;
    const orderedIds = projects
        .filter((candidate) => !candidate.deletedAt && (candidate.areaId ?? undefined) === areaId)
        .sort((a, b) => projectOrder(a) - projectOrder(b) || a.title.localeCompare(b.title))
        .map((candidate) => candidate.id);
    const from = orderedIds.indexOf(project.id);
    const to = orderedIds.indexOf(neighbour.id);
    if (from < 0 || to < 0) return null;
    [orderedIds[from], orderedIds[to]] = [orderedIds[to], orderedIds[from]];
    return { areaId, orderedIds };
}
