import { getProjectAccentColor } from '@mindwtr/core';
import { useEffect, useMemo, useState } from 'react';
import type { Project, Section, Task, TaskDraftSetter, Area } from '@mindwtr/core';
import { getFrequentTaskTokens, getPersonOptionNames, getRetainedTaskContexts, getSavedTaxonomyTokens, getUsedTaskTokens, useTaskStore,
    baseTextCollator,
} from '@mindwtr/core';

type UseTaskItemProjectContextParams = {
    task: Task;
    project?: Project;
    projectArea?: Area;
    taskArea?: Area;
    sections: Section[];
    isEditing: boolean;
    loadTokenOptions?: boolean;
    editProjectId: string;
    setField: TaskDraftSetter;
};

const normalizeTokenOption = (token: string, prefix: '@' | '#'): string => {
    const bareToken = token.trim().replace(/^[@#]/, '');
    return bareToken ? `${prefix}${bareToken}` : '';
};

const uniquePrefixedTokenOptions = (tokens: string[], prefix: '@' | '#'): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    tokens.forEach((token) => {
        const normalized = normalizeTokenOption(token, prefix);
        const key = normalized.toLowerCase();
        if (!normalized || seen.has(key)) return;
        seen.add(key);
        result.push(normalized);
    });
    return result;
};

const sortTokenOptions = (tokens: string[]): string[] =>
    [...tokens].sort((a, b) => baseTextCollator.compare(a, b));

export function useTaskItemProjectContext({
    task,
    project,
    projectArea,
    taskArea,
    sections,
    isEditing,
    loadTokenOptions = isEditing,
    editProjectId,
    setField,
}: UseTaskItemProjectContextParams) {
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

    const [projectContext, setProjectContext] = useState<{ projectTitle: string; projectTasks: string[] } | null>(null);
    const [tagOptions, setTagOptions] = useState<string[]>([]);
    const [popularTagOptions, setPopularTagOptions] = useState<string[]>([]);
    const [allContexts, setAllContexts] = useState<string[]>([]);
    const [popularContextOptions, setPopularContextOptions] = useState<string[]>([]);
    const [assignedToOptions, setAssignedToOptions] = useState<string[]>([]);
    const tokenSettings = useTaskStore((state) => loadTokenOptions ? state.settings : null);
    const retainedTaskRevision = useTaskStore((state) => loadTokenOptions ? state._allTasks : null);

    useEffect(() => {
        if (!isEditing && !loadTokenOptions) return;
        const { tasks: storeTasks, _allTasks: retainedTasks, projects: storeProjects, people: storePeople, settings } = useTaskStore.getState();
        if (isEditing) {
            if (editProjectId) {
                setField('areaId', '');
            }
            const projectId = editProjectId || task.projectId;
            const activeProject = project || (projectId ? storeProjects.find((item) => item.id === projectId) : undefined);
            if (projectId) {
                const projectTasks = storeTasks
                    .filter((candidate) => candidate.projectId === projectId && candidate.id !== task.id && !candidate.deletedAt)
                    .map((candidate) => `${candidate.title}${candidate.status ? ` (${candidate.status})` : ''}`)
                    .filter(Boolean)
                    .slice(0, 20);
                setProjectContext({
                    projectTitle: activeProject?.title || '',
                    projectTasks,
                });
            } else {
                setProjectContext(null);
            }
        }
        if (!loadTokenOptions) return;

        const allTagOptions = uniquePrefixedTokenOptions(
            [...getUsedTaskTokens(storeTasks, (candidate) => candidate.tags), ...getSavedTaxonomyTokens(settings, 'tag')],
            '#'
        );
        const frequentTagOptions = uniquePrefixedTokenOptions(
            getFrequentTaskTokens(storeTasks, (candidate) => candidate.tags, 8),
            '#'
        );
        const allContextOptions = uniquePrefixedTokenOptions(
            [...getRetainedTaskContexts(retainedTasks), ...getSavedTaxonomyTokens(settings, 'context')],
            '@'
        );
        const frequentContextOptions = uniquePrefixedTokenOptions(
            getFrequentTaskTokens(storeTasks, (candidate) => candidate.contexts, 5),
            '@'
        );
        setTagOptions(sortTokenOptions(allTagOptions));
        setPopularTagOptions(frequentTagOptions);
        setAllContexts(sortTokenOptions(allContextOptions));
        setPopularContextOptions(frequentContextOptions);
        setAssignedToOptions(getPersonOptionNames(storePeople, storeTasks));
    }, [editProjectId, isEditing, loadTokenOptions, project, retainedTaskRevision, tokenSettings, setField, task.id, task.projectId]);

    return {
        sectionsByProject,
        currentProject: project,
        currentTaskArea: project?.areaId ? projectArea : taskArea,
        currentProjectColor: project ? getProjectAccentColor(project, new Map(projectArea ? [[projectArea.id, projectArea]] : [])) : undefined,
        projectContext,
        tagOptions,
        popularTagOptions,
        allContexts,
        popularContextOptions,
        assignedToOptions,
    };
}
