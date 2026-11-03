


import { readFileSync, writeFileSync } from 'node:fs';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  flushPendingSave,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type ExternalCalendarEvent,
  type Project,
  type Task,
} from '@mindwtr/core';

export const FIXTURE_PATH = new URL('../../../packages/core/src/review-views-parity.fixtures.json', import.meta.url).pathname;
export const CAPTURE = process.env.MINDWTR_CAPTURE_REVIEW_VIEWS === '1';
export const TIME_ZONE = 'America/New_York';

export const NOW = '2026-09-23T14:00:00.000Z';
export const DEVICE_LOCALE = 'en-US';

const at = (day: string, time = '12:00:00') => `2026-${day}T${time}.000Z`;
const task = (id: string, title: string, status: Task['status'], day: string, extra: Partial<Task> = {}): Task => ({
  id, title, status, contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});
const project = (id: string, title: string, order: number, extra: Partial<Project> = {}): Project => ({
  id, title, status: 'active', color: '#94a3b8', order, tagIds: [], createdAt: at('09-01'), updatedAt: at('09-21'), ...extra,
});

export const areas: Area[] = [
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('09-01'), updatedAt: at('09-01') },
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('09-01'), updatedAt: at('09-01') },
  { id: 'a-side', name: 'Side', order: 2, createdAt: at('09-01'), updatedAt: at('09-01') },
  { id: 'a-gone', name: 'Gone', color: '#000000', order: 3, deletedAt: at('09-10'), createdAt: at('09-01'), updatedAt: at('09-10') },
];

export const projects: Project[] = [
  project('p-launch', 'Launch', 0, { areaId: 'a-work' }),
  project('p-vendor', 'Vendor contract', 1, { areaId: 'a-work', reviewAt: '2026-09-21' }),
  project('p-garden', 'Garden', 0, { areaId: 'a-home' }),
  project('p-seq', 'Move house', 1, { areaId: 'a-home', isSequential: true }),
  project('p-stale', 'Old project', 2, { areaId: 'a-home', updatedAt: at('08-01'), createdAt: at('07-01') }),
  project('p-side', 'Side hustle', 0, { areaId: 'a-side', color: '#f59e0b' }),
  project('p-orphan', 'Orphan', 0, { areaId: 'a-gone' }),
  project('p-parked', 'Parked plan', 3, { areaId: 'a-home', status: 'someday' }),
  project('p-archived', 'Wrapped up', 4, { status: 'archived', updatedAt: at('09-21') }),
];

export const tasks: Task[] = [
  task('i-thought', 'Inbox thought', 'inbox', '09-22'),
  task('i-dentist', 'Call dentist', 'inbox', '09-21', { areaId: 'a-home' }),
  task('n-launch', 'Draft launch post', 'next', '09-21', { projectId: 'p-launch', contexts: ['@computer'], dueDate: '2026-09-24' }),
  task('n-demo', 'Record demo', 'next', '09-21', { projectId: 'p-launch', contexts: ['@computer'], startTime: '2026-09-25T15:00:00.000Z' }),
  task('w-vendor', 'Hear back from vendor', 'waiting', '08-30', { projectId: 'p-vendor', updatedAt: at('09-01') }),
  task('w-alice', 'Invoice from Alice', 'waiting', '09-15', { reviewAt: '2026-09-22', assignedTo: 'Alice' }),
  task('w-parcel', 'Parcel delivery', 'waiting', '09-18', { reviewAt: '2026-10-05', dueDate: '2026-09-23' }),
  task('s-tulips', 'Plant tulips', 'someday', '09-10', { projectId: 'p-garden' }),
  task('s-piano', 'Learn piano', 'someday', '09-05', { reviewAt: '2026-09-20' }),
  task('s-japan', 'Visit Japan', 'someday', '09-05', { reviewAt: '2026-12-01' }),
  task('n-passport', 'Renew passport', 'next', '09-10', { areaId: 'a-home', dueDate: '2026-09-20', contexts: ['@errands'] }),
  task('n-rent', 'Pay rent', 'next', '09-15', { dueDate: '2026-09-23', contexts: ['@computer', '@home'], priority: 'high' }),
  task('n-report', 'Write report', 'next', '09-19', { projectId: 'p-side', isFocusedToday: true }),
  task('n-logo', 'Sketch logo', 'next', '09-19', { projectId: 'p-side', contexts: ['@computer'] }),
  task('n-bike', 'Fix bike', 'next', '08-01', { contexts: ['@errands'], updatedAt: at('08-20') }),
  task('n-cv', 'Update CV', 'next', '09-20', { contexts: ['@computer'], tags: ['#career'] }),
  task('n-orphan', 'Orphan step', 'next', '09-20', { projectId: 'p-orphan', tags: ['#misc'] }),
  task('n-pack', 'Pack boxes', 'next', '09-20', { projectId: 'p-seq', order: 0 }),
  task('n-van', 'Book van', 'next', '09-20', { projectId: 'p-seq', order: 1 }),
  task('n-parked', 'Parked step', 'next', '09-20', { projectId: 'p-parked' }),
  task('d-shipped', 'Shipped v1', 'done', '09-10', { projectId: 'p-archived', completedAt: at('09-21', '15:00:00'), updatedAt: at('09-21', '15:00:00'), timeEstimate: '30min', timeSpentMinutes: 25 }),
  task('d-invoice', 'Sent invoice', 'done', '09-10', { projectId: 'p-launch', completedAt: at('09-22', '15:00:00'), updatedAt: at('09-22', '15:00:00'), timeEstimate: '1hr' }),
  task('d-old', 'Old win', 'done', '09-01', { completedAt: at('09-12'), updatedAt: at('09-12') }),
  task('r-manual', 'Manual', 'reference', '09-01'),
  task('t-trashed', 'Trashed idea', 'next', '09-01', { deletedAt: at('09-15'), updatedAt: at('09-15') }),
];


export const calendarEvents: ExternalCalendarEvent[] = [
  { id: 'e-standup', sourceId: 'cal', title: 'Standup', start: at('09-23', '13:00:00'), end: at('09-23', '13:30:00'), allDay: false },
  { id: 'e-holiday', sourceId: 'cal', title: 'Company holiday', start: '2026-09-23T04:00:00.000Z', end: '2026-09-24T04:00:00.000Z', allDay: true },
  { id: 'e-dentist', sourceId: 'cal', title: 'Dentist', start: at('09-24', '19:00:00'), end: at('09-24', '20:00:00'), allDay: false },
  { id: 'e-a', sourceId: 'cal', title: 'Planning', start: at('09-26', '14:00:00'), end: at('09-26', '15:00:00'), allDay: false },
  { id: 'e-b', sourceId: 'cal', title: 'Lunch', start: at('09-26', '16:00:00'), end: at('09-26', '17:00:00'), allDay: false },
  { id: 'e-c', sourceId: 'cal', title: 'Retro', start: at('09-26', '18:00:00'), end: at('09-26', '19:00:00'), allDay: false },
];

export type Scenario = {
  name: string;
  settings: string;

  taskIds?: string[];

  projectIds?: string[];

  calendar?: 'events' | 'error' | 'none';

  storage?: Record<string, string>;
  actions: [string, ...unknown[]][];
};

export type Observation = Record<string, unknown>;

export const writeLog: unknown[][] = [];
export const createdIds = new Map<string, string>();
export const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => createdIds.get(match) ?? match));

const RECORDED = ['updateTask', 'deleteTask', 'restoreTask', 'addTask', 'batchUpdateTasks', 'batchMoveTasks', 'batchDeleteTasks'] as const;
let realActions: Record<string, (...args: any[]) => Promise<any>> | null = null;


export async function seedStore(settings: AppSettings, seededTasks: Task[], seededProjects: Project[] = projects) {
  await flushPendingSave();
  resetForTests();
  const initial = useTaskStore.getState() as unknown as Record<string, (...args: any[]) => Promise<any>>;
  realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]]));
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ tasks: seededTasks, projects: seededProjects, sections: [], areas, people: [], settings }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    ...(real as object),
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    highlightTaskId: null,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  useTaskStore.setState(Object.fromEntries(RECORDED.map((name) => [name, async (...args: unknown[]) => {
    writeLog.push([name, ...(normalize(args) as unknown[])]);
    const result = await real[name](...args);
    if (name === 'addTask' && result?.id) createdIds.set(result.id, `<created:${String(args[0])}>`);
    return result;
  }])) as never);
}

export const scenarioTasks = (scenario: Scenario) => (
  scenario.taskIds ? tasks.filter((entry) => scenario.taskIds!.includes(entry.id)) : tasks
);
export const scenarioProjects = (scenario: Scenario) => (
  scenario.projectIds ? projects.filter((entry) => scenario.projectIds!.includes(entry.id)) : projects
);


const isText = (node: ReactTestInstance) => String(node.type) === 'Text';
const deepText = (node: ReactTestInstance | string | number | null | undefined | boolean): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((child) => deepText(child as ReactTestInstance | string)).join('');
};


export function visibleNodes(root: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && !node.props.visible) return;
    out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}


export function textsIn(root: ReactTestInstance): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Modal' && !node.props.visible) return;
    if (isText(node)) {
      out.push(deepText(node));
      return;
    }
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

export const hostsOf = (root: ReactTestInstance, type: string) => visibleNodes(root).filter((node) => String(node.type) === type);

export const flattenStyle = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flattenStyle)) : style && typeof style === 'object' ? style as Record<string, unknown> : {}
);


export function findPressable(root: ReactTestInstance, label: string): ReactTestInstance | undefined {
  const candidates = visibleNodes(root).filter((node) => typeof node.props?.onPress === 'function');
  return candidates.find((node) => node.props.accessibilityLabel === label)
    ?? candidates.find((node) => textsIn(node).join('') === label);
}

export function writeFixturePart(part: string, inputs: Record<string, unknown>, observations: Record<string, unknown>) {
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  } catch {
    previous = {};
  }
  writeFileSync(FIXTURE_PATH, `${JSON.stringify({ ...previous, [part]: { ...inputs, observations } }, null, 1)}\n`);
}

export function readFixturePart(part: string): { observations: Record<string, unknown>; [key: string]: unknown } {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))[part];
}

export const sharedInputs = (settings: Record<string, AppSettings>, scenarios: Scenario[]) => normalize({
  timeZone: TIME_ZONE, now: NOW, tasks, projects, areas, calendarEvents, settings, scenarios,
}) as Record<string, unknown>;
