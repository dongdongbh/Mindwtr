import { useMemo } from 'react';
import {
    buildProjectGroups,
    countLiveProjectsByArea,
    type AppSettings,
    type Area,
    type AreaFilterSelection,
    projectTagSuggestions,
    type Project,
    type ProjectTagFilter,
    type Task,
} from '@mindwtr/core';

type UseProjectFilteringParams = {
    projects: Project[];
    tasks: Task[];
    settings?: AppSettings;
    sortedAreas: Area[];
    selectedTagFilter: string;
    selectedAreaFilter: AreaFilterSelection;
    allTagsValue: string;
    noTagsValue: string;
    focusedProjectCount: number;
};

export function useProjectFiltering({
    projects,
    tasks,
    settings,
    sortedAreas,
    selectedTagFilter,
    selectedAreaFilter,
    allTagsValue,
    noTagsValue,
    focusedProjectCount,
}: UseProjectFilteringParams) {
    const focusedCount = focusedProjectCount;

    const areaUsage = useMemo(() => countLiveProjectsByArea(projects), [projects]);

    const projectTagOptions = useMemo<string[]>(() => projectTagSuggestions(tasks, projects, settings), [tasks, projects, settings]);

    const groupedProjects = useMemo(() => {
        const tagFilter: ProjectTagFilter = selectedTagFilter === allTagsValue
            ? { kind: 'all' }
            : selectedTagFilter === noTagsValue
                ? { kind: 'untagged' }
                : { kind: 'tag', value: selectedTagFilter };

        return buildProjectGroups({
            projects,
            orderedAreas: sortedAreas,
            areaFilter: selectedAreaFilter,
            tagFilter,
            // This list has no drag order on the phone; the star is how a project moves up.
            pinFocused: true,
        });
    }, [
        allTagsValue,
        noTagsValue,
        projects,
        selectedAreaFilter,
        selectedTagFilter,
        sortedAreas,
    ]);

    return {
        areaUsage,
        focusedCount,
        groupedActiveProjects: groupedProjects.active,
        groupedDeferredProjects: groupedProjects.deferred,
        groupedArchivedProjects: groupedProjects.archived,
        projectTagOptions,
        tagFilterOptions: {
            list: groupedProjects.tagInventory.values,
            hasNoTags: groupedProjects.tagInventory.hasUntagged,
        },
    };
}
