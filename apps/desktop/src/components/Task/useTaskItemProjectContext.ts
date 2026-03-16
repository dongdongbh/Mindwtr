import { useEffect, useMemo, useState } from 'react';
import type { Project, Section, Task, Area } from '@mindwtr/core';
import { getFrequentTaskTokens, getUsedTaskTokens, useTaskStore } from '@mindwtr/core';

type UseTaskItemProjectContextParams = {
    task: Task;
    propProject?: Project;
    projects: Project[];
    sections: Section[];
    areas: Area[];
    isEditing: boolean;
    editProjectId: string;
    setEditAreaId: (value: string) => void;
};

export function useTaskItemProjectContext({
    task,
    propProject,
    projects,
    sections,
    areas,
    isEditing,
    editProjectId,
    setEditAreaId,
}: UseTaskItemProjectContextParams) {
    const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const sectionsByProject = useMemo(() => {
        const map = new Map<string, Section[]>();
        sections.forEach((section) => {
            if (section.deletedAt) return;
            const list = map.get(section.projectId) ?? [];
            list.push(section);
            map.set(section.projectId, list);
        });
        map.forEach((list, key) => {
            list.sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? a.order : 0;
                const bOrder = Number.isFinite(b.order) ? b.order : 0;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            });
            map.set(key, list);
        });
        return map;
    }, [sections]);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);

    const [projectContext, setProjectContext] = useState<{ projectTitle: string; projectTasks: string[] } | null>(null);
    const [tagOptions, setTagOptions] = useState<string[]>([]);
    const [popularTagOptions, setPopularTagOptions] = useState<string[]>([]);
    const [allContexts, setAllContexts] = useState<string[]>([]);
    const [popularContextOptions, setPopularContextOptions] = useState<string[]>([]);

    useEffect(() => {
        if (!isEditing) return;
        if (editProjectId) {
            setEditAreaId('');
        }
        const { tasks: storeTasks, projects: storeProjects } = useTaskStore.getState();
        const projectId = editProjectId || task.projectId;
        const project = propProject || (projectId ? storeProjects.find((item) => item.id === projectId) : undefined);
        if (projectId) {
            const projectTasks = storeTasks
                .filter((candidate) => candidate.projectId === projectId && candidate.id !== task.id && !candidate.deletedAt)
                .map((candidate) => `${candidate.title}${candidate.status ? ` (${candidate.status})` : ''}`)
                .filter(Boolean)
                .slice(0, 20);
            setProjectContext({
                projectTitle: project?.title || '',
                projectTasks,
            });
        } else {
            setProjectContext(null);
        }

        setTagOptions(getUsedTaskTokens(storeTasks, (candidate) => candidate.tags, { prefix: '#' }));
        setPopularTagOptions(getFrequentTaskTokens(storeTasks, (candidate) => candidate.tags, 8, { prefix: '#' }));
        setAllContexts(getUsedTaskTokens(storeTasks, (candidate) => candidate.contexts, { prefix: '@' }));
        setPopularContextOptions(getFrequentTaskTokens(storeTasks, (candidate) => candidate.contexts, 5, { prefix: '@' }));
    }, [editProjectId, isEditing, propProject, setEditAreaId, task.id, task.projectId]);

    return {
        projectById,
        sectionsByProject,
        areaById,
        projectContext,
        tagOptions,
        popularTagOptions,
        allContexts,
        popularContextOptions,
    };
}
