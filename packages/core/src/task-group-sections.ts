import { buildCompletionDateSections } from './completion-grouping';
import type { DateFormatter } from './date';
import { tFallback } from './i18n';
import { baseTextCollator } from './task-utils';
import type { Area, Project, Task } from './types';


export type TaskGroupBy = 'none' | 'context' | 'area' | 'project' | 'tag' | 'completedDate';

export type TaskGroupSectionItem = {
  type: 'section';
  id: string;
  title: string;
  count: number;
  muted?: boolean;

  collapsible?: boolean;
  collapsed?: boolean;
};

export type TaskGroupTaskItem = {
  type: 'task';
  task: Task;
  groupId?: string;
};

export type TaskGroupItem = TaskGroupSectionItem | TaskGroupTaskItem;

type TaskTokenGroup = {
  id: string;
  title: string;
  tasks: Task[];
  muted?: boolean;
};

function groupTasksByToken(
  tasks: Task[],
  tokensForTask: (task: Task) => readonly string[] | undefined,
  idPrefix: 'context' | 'tag',
  noTokenLabel: string,
): TaskTokenGroup[] {
  const grouped = new Map<string, Task[]>();
  const tokenlessTasks: Task[] = [];

  tasks.forEach((task) => {
    const tokens = tokensForTask(task)
      ?.map((token) => token.trim())
      .filter((token) => token.length > 0) ?? [];
    if (tokens.length === 0) {
      tokenlessTasks.push(task);
      return;
    }
    new Set(tokens).forEach((token) => {
      const tokenTasks = grouped.get(token) ?? [];
      tokenTasks.push(task);
      grouped.set(token, tokenTasks);
    });
  });

  const groups: TaskTokenGroup[] = [...grouped.keys()]
    .sort((a, b) => baseTextCollator.compare(a, b))
    .map((token) => ({
      id: `${idPrefix}:${token}`,
      title: token,
      tasks: grouped.get(token) ?? [],
    }));
  if (tokenlessTasks.length > 0) {
    groups.push({
      id: `${idPrefix}:none`,
      title: noTokenLabel,
      tasks: tokenlessTasks,
      muted: true,
    });
  }
  return groups;
}

export function groupTasksByContext({
  tasks,
  noContextLabel,
}: {
  tasks: Task[];
  noContextLabel: string;
}): TaskTokenGroup[] {
  return groupTasksByToken(tasks, (task) => task.contexts, 'context', noContextLabel);
}

export function groupTasksByTag({
  tasks,
  noTagLabel,
}: {
  tasks: Task[];
  noTagLabel: string;
}): TaskTokenGroup[] {
  return groupTasksByToken(tasks, (task) => task.tags, 'tag', noTagLabel);
}


export function getTaskGroupByLabel(groupBy: TaskGroupBy, t: (key: string) => string): string {
  switch (groupBy) {
    case 'none':
      return tFallback(t, 'list.groupByNone', 'No grouping');
    case 'context':
      return tFallback(t, 'list.groupByContext', 'Context');
    case 'area':
      return tFallback(t, 'list.groupByArea', 'Area');
    case 'project':
      return tFallback(t, 'taskEdit.projectLabel', 'Project');
    case 'tag':
      return tFallback(t, 'taskEdit.tagsLabel', 'Tags');
    case 'completedDate':
      return tFallback(t, 'list.groupByCompletedDate', 'Completion date');
    default:
      return groupBy;
  }
}

export type BuildTaskGroupSectionsParams = {
  groupBy: TaskGroupBy;

  tasks: Task[];
  areas: Area[];
  projectById: Map<string, Project>;
  t: (key: string) => string;


  now?: Date;


  collapsedGroupIds?: ReadonlySet<string>;


  formatDate?: DateFormatter;
};


const COMPLETION_MONTH_ID = /^completedDate:(\d{4})-(\d{2})$/;
const completionMonthTitle = (id: string, title: string, formatDate: DateFormatter | undefined): string => {
  const month = formatDate ? COMPLETION_MONTH_ID.exec(id) : null;
  return month ? formatDate!(new Date(Number(month[1]), Number(month[2]) - 1, 1), 'LLLL yyyy', `${month[1]}-${month[2]}`) : title;
};


export function buildTaskGroupSections({
  groupBy,
  tasks,
  areas,
  projectById,
  t,
  now,
  collapsedGroupIds,
  formatDate,
}: BuildTaskGroupSectionsParams): TaskGroupItem[] {
  const appendSection = (items: TaskGroupItem[], id: string, title: string, tasksForGroup: Task[], muted = false) => {
    if (tasksForGroup.length === 0) return;
    const collapsed = collapsedGroupIds?.has(id) === true;
    items.push({
      type: 'section',
      id,
      title,
      count: tasksForGroup.length,
      muted,
      ...(collapsedGroupIds ? { collapsible: true, collapsed } : {}),
    });
    if (collapsed) return;
    tasksForGroup.forEach((task) => items.push({ type: 'task', task, groupId: id }));
  };

  if (groupBy === 'project') {
    const grouped = new Map<string, Task[]>();
    const noProjectTasks: Task[] = [];

    tasks.forEach((task) => {
      if (!task.projectId) {
        noProjectTasks.push(task);
        return;
      }
      const project = projectById.get(task.projectId);
      if (!project) {
        noProjectTasks.push(task);
        return;
      }
      const items = grouped.get(project.id) ?? [];
      items.push(task);
      grouped.set(project.id, items);
    });

    const items: TaskGroupItem[] = [];
    const sortedProjects = [...grouped.keys()]
      .map((itemProjectId) => projectById.get(itemProjectId))
      .filter((project): project is Project => Boolean(project))
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      });
    sortedProjects.forEach((project) => appendSection(items, `project:${project.id}`, project.title, grouped.get(project.id) ?? []));
    appendSection(items, 'project:none', tFallback(t, 'taskEdit.noProjectOption', 'No project'), noProjectTasks, true);
    return items;
  }

  if (groupBy === 'completedDate') {


    const items: TaskGroupItem[] = [];
    buildCompletionDateSections({ tasks, t, now }).forEach((section) => {
      appendSection(items, section.id, completionMonthTitle(section.id, section.title, formatDate), section.tasks, section.muted);
    });
    return items;
  }

  if (groupBy === 'context') {
    const items: TaskGroupItem[] = [];
    groupTasksByContext({
      tasks,
      noContextLabel: tFallback(t, 'contexts.none', 'No context'),
    }).forEach((group) => appendSection(items, group.id, group.title, group.tasks, group.muted));
    return items;
  }

  if (groupBy === 'tag') {
    const items: TaskGroupItem[] = [];
    groupTasksByTag({
      tasks,
      noTagLabel: tFallback(t, 'taskEdit.noTags', 'No tags'),
    }).forEach((group) => appendSection(items, group.id, group.title, group.tasks, group.muted));
    return items;
  }

  const activeAreas = [...areas].filter((area) => !area.deletedAt).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
  const areaIds = new Set(activeAreas.map((area) => area.id));
  const grouped = new Map<string, Task[]>();
  const generalTasks: Task[] = [];

  tasks.forEach((task) => {
    const projectAreaId = task.projectId ? projectById.get(task.projectId)?.areaId : undefined;
    const resolvedAreaId = task.areaId || projectAreaId;
    if (resolvedAreaId && areaIds.has(resolvedAreaId)) {
      const items = grouped.get(resolvedAreaId) ?? [];
      items.push(task);
      grouped.set(resolvedAreaId, items);
    } else {
      generalTasks.push(task);
    }
  });

  const items: TaskGroupItem[] = [];
  activeAreas.forEach((area) => {
    const tasksForArea = grouped.get(area.id) ?? [];
    appendSection(items, area.id, area.name, tasksForArea);
  });
  appendSection(items, 'general', tFallback(t, 'settings.general', 'General'), generalTasks, true);
  return items;
}
