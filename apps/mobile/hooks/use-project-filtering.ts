import { useMemo } from 'react';
import { type Area, getUsedTaskTokens, type Project, type Task } from '@mindwtr/core';

import { projectMatchesAreaFilter, type AreaFilterValue } from '@/lib/area-filter';

export type ProjectSectionItem = { type: 'project'; data: Project };

export type ProjectSection = {
    title: string;
    areaId: string;
    data: ProjectSectionItem[];
};

type UseProjectFilteringParams = {
    projects: Project[];
    tasks: Task[];
    sortedAreas: Area[];
    areaById: Map<string, Area>;
    selectedTagFilter: string;
    selectedAreaFilter: AreaFilterValue;
    allTagsValue: string;
    noTagsValue: string;
    t: (key: string) => string;
};

export function useProjectFiltering({
    projects,
    tasks,
    sortedAreas,
    areaById,
    selectedTagFilter,
    selectedAreaFilter,
    allTagsValue,
    noTagsValue,
    t,
}: UseProjectFilteringParams) {
    const focusedCount = useMemo(
        () => projects.filter((project) => project.isFocused).length,
        [projects],
    );

    const areaUsage = useMemo(() => {
        const counts = new Map<string, number>();
        projects.forEach((project) => {
            if (project.deletedAt || !project.areaId) return;
            counts.set(project.areaId, (counts.get(project.areaId) || 0) + 1);
        });
        return counts;
    }, [projects]);

    const projectTagOptions = useMemo<string[]>(() => {
        const projectTags = projects.flatMap((project) => project.tagIds || []);
        return Array.from(new Set([
            ...getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' }),
            ...projectTags,
        ])).filter(Boolean);
    }, [tasks, projects]);

    const tagFilterOptions = useMemo<{ list: string[]; hasNoTags: boolean }>(() => {
        const tags = new Set<string>();
        let hasNoTags = false;
        projects.forEach((project) => {
            if (project.deletedAt) return;
            const list = project.tagIds || [];
            if (list.length === 0) {
                hasNoTags = true;
                return;
            }
            list.forEach((tag) => tags.add(tag));
        });
        return {
            list: Array.from(tags).sort(),
            hasNoTags,
        };
    }, [projects]);

    const groupedProjects = useMemo<ProjectSection[]>(() => {
        const visibleProjects = projects.filter((project) => !project.deletedAt);
        const sortedProjects = [...visibleProjects].sort((a, b) => {
            const orderA = Number.isFinite(a.order) ? a.order : 0;
            const orderB = Number.isFinite(b.order) ? b.order : 0;
            if (orderA !== orderB) return orderA - orderB;
            return a.title.localeCompare(b.title);
        });

        const tagFilteredProjects = sortedProjects.filter((project) => {
            const tags = project.tagIds || [];
            if (selectedTagFilter === allTagsValue) return true;
            if (selectedTagFilter === noTagsValue) return tags.length === 0;
            return tags.includes(selectedTagFilter);
        });

        const areaFilteredProjects = tagFilteredProjects.filter((project) => (
            projectMatchesAreaFilter(project, selectedAreaFilter, areaById)
        ));

        const groups = new Map<string, Project[]>();
        areaFilteredProjects.forEach((project) => {
            const areaId = project.areaId && areaById.has(project.areaId) ? project.areaId : 'no-area';
            if (!groups.has(areaId)) {
                groups.set(areaId, []);
            }
            groups.get(areaId)?.push(project);
        });

        const sections = sortedAreas
            .filter((area) => (groups.get(area.id) || []).length > 0)
            .map((area) => ({
                title: area.name,
                areaId: area.id,
                data: (groups.get(area.id) || []).map((project) => ({ type: 'project' as const, data: project })),
            }));

        const noAreaProjects = groups.get('no-area') || [];
        if (noAreaProjects.length > 0) {
            sections.push({
                title: t('projects.noArea'),
                areaId: 'no-area',
                data: noAreaProjects.map((project) => ({ type: 'project' as const, data: project })),
            });
        }

        return sections;
    }, [
        allTagsValue,
        areaById,
        noTagsValue,
        projects,
        selectedAreaFilter,
        selectedTagFilter,
        sortedAreas,
        t,
    ]);

    return {
        areaUsage,
        focusedCount,
        groupedProjects,
        projectTagOptions,
        tagFilterOptions,
    };
}
