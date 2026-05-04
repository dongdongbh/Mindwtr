import type { Area, Project, Task } from '@mindwtr/core';

export type ReviewProjectTaskGroup = {
  hasNextAction: boolean;
  id: string;
  isSingleActions: boolean;
  order: number;
  projectId?: string;
  tasks: Task[];
  title: string;
};

export type ReviewAreaTaskGroup = {
  color: string;
  id: string;
  isUnassigned: boolean;
  needsActionCount: number;
  order: number;
  projectGroups: ReviewProjectTaskGroup[];
  projectCount: number;
  taskCount: number;
  title: string;
};

type BuildReviewTaskGroupsParams = {
  areaById: Map<string, Area>;
  areaOrderById: Map<string, number>;
  noAreaLabel: string;
  projectById: Map<string, Project>;
  singleActionsLabel: string;
  sortedTasks: Task[];
  fallbackAreaColor: string;
  unassignedAreaColor: string;
};

const UNASSIGNED_AREA_ORDER = -1;
const SINGLE_ACTION_ORDER = Number.MAX_SAFE_INTEGER;

export function buildReviewTaskGroups({
  areaById,
  areaOrderById,
  noAreaLabel,
  projectById,
  singleActionsLabel,
  sortedTasks,
  fallbackAreaColor,
  unassignedAreaColor,
}: BuildReviewTaskGroupsParams): ReviewAreaTaskGroup[] {
  const groups = new Map<string, Omit<ReviewAreaTaskGroup, 'needsActionCount' | 'projectCount' | 'projectGroups'> & {
    projectGroups: Map<string, ReviewProjectTaskGroup>;
  }>();

  sortedTasks.forEach((task) => {
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    const areaId = project?.areaId || task.areaId;
    const area = areaId ? areaById.get(areaId) : undefined;
    const isUnassigned = !areaId;
    const areaKey = areaId ? `area:${areaId}` : 'area:none';
    const areaGroup = groups.get(areaKey) ?? {
      color: isUnassigned ? unassignedAreaColor : (area?.color || project?.color || fallbackAreaColor),
      id: areaKey,
      isUnassigned,
      order: areaId ? (areaOrderById.get(areaId) ?? Number.MAX_SAFE_INTEGER - 1) : UNASSIGNED_AREA_ORDER,
      projectGroups: new Map<string, ReviewProjectTaskGroup>(),
      taskCount: 0,
      title: area?.name || project?.areaTitle || noAreaLabel,
    };

    const projectKey = project ? `project:${project.id}` : `single:${areaKey}`;
    const projectGroup = areaGroup.projectGroups.get(projectKey) ?? {
      hasNextAction: false,
      id: projectKey,
      isSingleActions: !project,
      order: project ? project.order : SINGLE_ACTION_ORDER,
      projectId: project?.id,
      tasks: [],
      title: project?.title || singleActionsLabel,
    };

    projectGroup.tasks.push(task);
    projectGroup.hasNextAction = projectGroup.hasNextAction || task.status === 'next';
    areaGroup.projectGroups.set(projectKey, projectGroup);
    areaGroup.taskCount += 1;
    groups.set(areaKey, areaGroup);
  });

  return Array.from(groups.values())
    .map((group) => {
      const projectGroups = Array.from(group.projectGroups.values()).sort((a, b) => (
        (a.order - b.order) || a.title.localeCompare(b.title)
      ));
      const projectCount = projectGroups.filter((projectGroup) => !projectGroup.isSingleActions).length;
      const needsActionCount = projectGroups.filter((projectGroup) => (
        !projectGroup.isSingleActions && !projectGroup.hasNextAction
      )).length;
      return {
        ...group,
        needsActionCount,
        projectCount,
        projectGroups,
      };
    })
    .sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
}
