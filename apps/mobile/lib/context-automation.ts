import {
  isTaskInActiveProject,
  matchesHierarchicalToken,
  resolveFeatureFlags,
  safeParseDate,
  sortFocusNextActions,
  type AppSettings,
  type Project,
  type Task,
} from '@mindwtr/core';

export const ANDROID_CONTEXT_ACTIVATE_ACTION = 'tech.dongdongbh.mindwtr.action.ACTIVATE_CONTEXT';
export const ANDROID_CONTEXT_DEACTIVATE_ACTION = 'tech.dongdongbh.mindwtr.action.DEACTIVATE_CONTEXT';
export const CONTEXT_AUTOMATION_NOTIFICATION_KIND = 'context-automation';

export type ContextAutomationAction = 'activate' | 'deactivate';

export type ContextAutomationPayload = {
  action: ContextAutomationAction;
  context: string;
};

export type ContextAutomationNotificationCopy = {
  title: string;
  message: string;
};

export type ContextAutomationNotificationTemplates = {
  noTasksTitle: string;
  noTasksMessage: string;
  oneTaskTitle: string;
  manyTasksTitle: string;
  moreTasksLine: string;
};

const CONTEXT_ROUTE_NAMES = new Set(['context', 'contexts']);

const trimOrUndefined = (value: string | null | undefined): string | undefined => {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : undefined;
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeRouteSegments = (url: URL): string[] => {
  const host = trimOrUndefined(url.hostname);
  const pathSegments = url.pathname
    .split('/')
    .map((segment) => trimOrUndefined(safeDecode(segment)))
    .filter((segment): segment is string => Boolean(segment));
  return [
    ...(host ? [safeDecode(host)] : []),
    ...pathSegments,
  ];
};

const normalizeAction = (value: string | null | undefined): ContextAutomationAction | null => {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'activate' || normalized === 'active' || normalized === 'on') return 'activate';
  if (normalized === 'deactivate' || normalized === 'inactive' || normalized === 'off') return 'deactivate';
  return null;
};

const firstQueryValue = (searchParams: URLSearchParams, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = trimOrUndefined(searchParams.get(key));
    if (value) return value;
  }
  return undefined;
};

export function normalizeContextToken(value: string | null | undefined): string {
  const trimmed = trimOrUndefined(value);
  if (!trimmed) return '';
  const withoutLeadingSlashes = trimmed.replace(/^\/+/, '');
  const withoutPrefix = withoutLeadingSlashes.replace(/^[@#]+/, '').trim();
  return withoutPrefix ? `@${withoutPrefix}` : '';
}

export function parseContextAutomationUrl(rawUrl: string): ContextAutomationPayload | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if ((parsed.protocol || '').toLowerCase() !== 'mindwtr:') return null;

  const segments = normalizeRouteSegments(parsed);
  const route = String(segments[0] ?? '').toLowerCase();
  const routeAction = route === 'activate-context'
    ? 'activate'
    : route === 'deactivate-context'
      ? 'deactivate'
      : null;
  const action = routeAction
    ?? normalizeAction(firstQueryValue(parsed.searchParams, ['contextAction', 'action', 'mode']))
    ?? (CONTEXT_ROUTE_NAMES.has(route) ? normalizeAction(segments[1]) : null);
  if (!action) return null;

  const contextFromPath = (() => {
    if (route === 'activate-context' || route === 'deactivate-context') return segments.slice(1).join('/');
    if (!CONTEXT_ROUTE_NAMES.has(route)) return undefined;
    const second = segments[1];
    if (!second) return undefined;
    return normalizeAction(second) ? segments.slice(2).join('/') : segments.slice(1).join('/');
  })();
  const context = normalizeContextToken(
    firstQueryValue(parsed.searchParams, ['context', 'name', 'token'])
    ?? contextFromPath
  );
  if (!context) return null;

  return { action, context };
}

const startsInFuture = (task: Pick<Task, 'startTime'>, now: Date): boolean => {
  if (!task.startTime) return false;
  const start = safeParseDate(task.startTime);
  return Boolean(start && start.getTime() > now.getTime());
};

export function selectContextNextActions(
  tasks: Task[],
  projects: Project[],
  context: string,
  now: Date = new Date(),
  settings?: { features?: AppSettings['features'] } | null,
): Task[] {
  const normalizedContext = normalizeContextToken(context);
  if (!normalizedContext) return [];

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const matchingTasks = tasks.filter((task) => {
    if (task.deletedAt || task.status !== 'next') return false;
    if (!isTaskInActiveProject(task, projectById)) return false;
    if (startsInFuture(task, now)) return false;
    return (task.contexts ?? []).some((taskContext) => {
      const normalizedTaskContext = normalizeContextToken(taskContext);
      return normalizedTaskContext ? matchesHierarchicalToken(normalizedContext, normalizedTaskContext) : false;
    });
  });

  // Every other sortFocusNextActions caller passes the flag; omitting it here
  // meant the context notification listed next actions in an order that
  // ignored priority even while the feature was on.
  return sortFocusNextActions(matchingTasks, {
    now,
    prioritizeByPriority: resolveFeatureFlags(settings).priorities,
  });
}

export function buildContextAutomationNotificationCopy(
  context: string,
  tasks: Pick<Task, 'title'>[],
  templates: Partial<ContextAutomationNotificationTemplates> = {},
): ContextAutomationNotificationCopy {
  const normalizedContext = normalizeContextToken(context);
  const count = tasks.length;
  const interpolate = (template: string) => template
    .replace(/{{context}}/g, normalizedContext)
    .replace(/{{count}}/g, String(count));

  if (count === 0) {
    return {
      title: interpolate(templates.noTasksTitle ?? 'No {{context}} next actions'),
      message: interpolate(templates.noTasksMessage ?? 'Mindwtr did not find any /next tasks for {{context}}.'),
    };
  }

  if (count === 1) {
    return {
      title: interpolate(templates.oneTaskTitle ?? '{{context}} next action'),
      message: tasks[0]?.title || normalizedContext,
    };
  }

  const visibleTasks = tasks.slice(0, 5);
  const hiddenCount = count - visibleTasks.length;
  const taskLines = visibleTasks.map((task) => `- ${task.title}`);
  if (hiddenCount > 0) {
    taskLines.push((templates.moreTasksLine ?? '+{{count}} more').replace(/{{count}}/g, String(hiddenCount)));
  }

  return {
    title: interpolate(templates.manyTasksTitle ?? '{{count}} {{context}} next actions'),
    message: taskLines.join('\n'),
  };
}
