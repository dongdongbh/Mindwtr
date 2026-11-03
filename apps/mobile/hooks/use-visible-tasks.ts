import {
  isTaskVisibleInArea,
  useTaskStore,
  type Area,
  type AreaFilterSelection,
  type AreaVisibilityContext,
  type Project,
  type Task,
} from '@mindwtr/core';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';

export type VisibleTaskContext = {
  areaById: Map<string, Area>;
  projectById: Map<string, Project>;
  resolvedAreaFilter: AreaFilterSelection;

  visibility: AreaVisibilityContext;

  visibleTasks: Task[];
};

type VisibleTaskContextInput = {
  areas: Area[];
  projects: Project[];
  resolvedAreaFilter: AreaFilterSelection;
  tasks: Task[];
};

const sameIds = (left: string[], right: string[]) => (
  left.length === right.length && left.every((id, index) => id === right[index])
);


export function createVisibleTaskContextDeriver() {
  let previousInput: VisibleTaskContextInput | undefined;
  let previousResult: VisibleTaskContext | undefined;

  return (input: VisibleTaskContextInput): VisibleTaskContext => {
    const hasSameFilter = previousInput
      && sameIds(
        previousInput.resolvedAreaFilter.included,
        input.resolvedAreaFilter.included,
      )
      && sameIds(
        previousInput.resolvedAreaFilter.excluded,
        input.resolvedAreaFilter.excluded,
      );
    if (
      previousResult
      && previousInput?.areas === input.areas
      && previousInput.projects === input.projects
      && previousInput.tasks === input.tasks
      && hasSameFilter
    ) {
      return previousResult;
    }

    const sortedAreas = [...input.areas]
      .filter((area) => !area.deletedAt)
      .sort((left, right) => {
        if (left.order !== right.order) return left.order - right.order;
        return left.name.localeCompare(right.name);
      });
    const areaById = new Map(sortedAreas.map((area) => [area.id, area]));
    const projectById = new Map(input.projects.map((project) => [project.id, project]));
    const visibility: AreaVisibilityContext = {
      areaById,
      projectById,
      resolvedAreaFilter: input.resolvedAreaFilter,
    };
    const visibleTasks = input.tasks.filter((task) => isTaskVisibleInArea(task, visibility));
    const result = {
      areaById,
      projectById,
      resolvedAreaFilter: input.resolvedAreaFilter,
      visibility,
      visibleTasks,
    };

    previousInput = input;
    previousResult = result;
    return result;
  };
}

const deriveVisibleTaskContext = createVisibleTaskContextDeriver();


export function useVisibleTaskContext(): VisibleTaskContext {
  const tasks = useTaskStore((state) => state.tasks);
  const projects = useTaskStore((state) => state.projects);
  const areas = useTaskStore((state) => state.areas ?? []);
  const { resolvedAreaFilter } = useMobileAreaFilter();

  return deriveVisibleTaskContext({ areas, projects, resolvedAreaFilter, tasks });
}
