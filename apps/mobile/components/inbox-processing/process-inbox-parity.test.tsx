/**
 * React Native's Process Inbox, replayed against the frozen parity fixture that
 * core's process-inbox-model and the native host contract are tested against.
 *
 * The fixture's `provenance` names the commit each scenario was captured at.
 * MINDWTR_CAPTURE_PROCESS_INBOX=1 rewrites it; MINDWTR_CAPTURE_PROCESS_INBOX_SCENARIOS
 * ('|'-separated names) limits the rewrite to those scenarios. Each scenario
 * drives the real modal through its buttons and inputs, with the real core
 * store, and records what a user sees and what the store is asked to write.
 */
import React, { useState } from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flushPendingSave,
  formatTimeEstimateLabel,
  loadTranslations,
  resetForTests,
  runSyncStoreSave,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type Person,
  type Project,
  type Task,
} from '@mindwtr/core';

import { InboxProcessingModal } from '../inbox-processing-modal';
import { InboxStepFlow } from './InboxStepFlow';

const FIXTURE_PATH = new URL('../../../../packages/core/src/process-inbox-model-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_PROCESS_INBOX === '1';
const CAPTURE_ONLY = process.env.MINDWTR_CAPTURE_PROCESS_INBOX_SCENARIOS?.split('|').filter(Boolean) ?? [];

const english = vi.hoisted(() => ({ strings: {} as Record<string, string> }));
const toastLog = vi.hoisted(() => ({ entries: [] as unknown[], lastAction: null as null | (() => void) }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn().mockResolvedValue(null), setItem: vi.fn().mockResolvedValue(undefined), removeItem: vi.fn() },
}));
vi.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  notificationAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => true }));
vi.mock('../../lib/apple-foundation-models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/apple-foundation-models')>()),
  isAppleClarificationPrototypeEnabled: () => false,
}));
vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => english.strings[key] ?? key, language: 'en' }),
}));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../contexts/toast-context', () => ({
  useToast: () => ({
    showToast: (toast: { title?: string; message?: string; tone?: string; actionLabel?: string; onAction?: () => void }) => {
      toastLog.entries.push([toast.tone ?? null, toast.title ?? null, toast.message ?? null, toast.actionLabel ?? null]);
      if (toast.onAction) toastLog.lastAction = toast.onAction;
    },
    dismissToast: vi.fn(),
  }),
  ToastViewport: () => null,
}));
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));
vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', icon: '#64748b', tint: '#3b82f6', onTint: '#fff',
    tabIconDefault: '#94a3b8', tabIconSelected: '#3b82f6', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  }),
}));
vi.mock('../../lib/ai-config', () => ({
  loadAIKey: vi.fn().mockResolvedValue(''),
  isAIKeyRequired: vi.fn().mockReturnValue(false),
  buildAIConfig: vi.fn().mockReturnValue({}),
}));
vi.mock('../../lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: any) => React.createElement('DateTimePicker', props, props.children),
}));

type Action =
  | ['press', string]
  | ['set', string, unknown]
  | ['chip', 'context' | 'tag' | 'suggestion' | 'project' | 'area' | 'priority' | 'energy' | 'estimate', string | null]
  | ['quickDate', DateField, string]
  | ['pickDate', DateField, string]
  | ['dateOnly', DateField]
  | ['clearDate', DateField]
  | ['addToken', 'context' | 'tag']
  | ['extraAction', 'add']
  | ['extraAction', 'enter', number | 'next']
  | ['extraAction', 'type', number, string]
  | ['extraAction', 'remove', number];
type DateField = 'startTime' | 'dueDate' | 'reviewAt' | 'followUp';
type Scenario = { name: string; settings: string; taskIds: string[]; actions: Action[] };

export const TIME_ZONE = 'America/New_York';
export const NOW = '2026-09-23T14:00:00.000Z';
const at = (day: string) => `2026-09-${day}T12:00:00.000Z`;
const baseTask = (id: string, title: string, day: string, extra: Partial<Task> = {}): Task => ({
  id, title, status: 'inbox', contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});

const areas: Area[] = [
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('01'), updatedAt: at('01') },
];
const projects: Project[] = [
  { id: 'p-launch', title: 'Launch', status: 'active', color: '#2563eb', order: 0, tagIds: [], areaId: 'a-work', createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-home', title: 'Home Repairs', status: 'active', color: '#16a34a', order: 1, tagIds: [], areaId: 'a-home', createdAt: at('01'), updatedAt: at('01') },
  { id: 'p-old', title: 'Old stuff', status: 'archived', color: '#94a3b8', order: 2, tagIds: [], createdAt: at('01'), updatedAt: at('01') },
];
const people: Person[] = [{ id: 'person-alex', name: 'Alex Kim', createdAt: at('02'), updatedAt: at('02') }];
const allTasks: Task[] = [
  baseTask('inbox-a', 'Call Alice about the launch', '20', { contexts: ['@phone'] }),
  baseTask('inbox-b', 'Fix sink', '21', {
    description: 'Kitchen sink drips', projectId: 'p-home', tags: ['#house'], priority: 'high', energyLevel: 'low',
    assignedTo: 'Bob', timeEstimate: '30min', startTime: '2026-09-25T14:30', dueDate: '2026-09-30',
  }),
  baseTask('inbox-c', 'Plan trip', '22', { areaId: 'a-home' }),
  baseTask('returning-d', 'Learn piano', '10', { status: 'someday', reviewAt: '2026-09-20', viewSectionIds: { someday: 's-later' } }),
  baseTask('next-e', 'Call Alice about budget', '15', {
    status: 'next', contexts: ['@phone', '@office'], tags: ['#work'], assignedTo: 'Alice Smith', projectId: 'p-launch',
  }),
  baseTask('done-f', 'Order sink parts', '16', { status: 'done', contexts: ['@errand'], tags: ['#house'], completedAt: at('16') }),
  baseTask('dated-1', 'Renew insurance', '17', { startTime: '2026-10-01', dueDate: '2026-10-10', reviewAt: '2026-10-03' }),
  baseTask('dated-2', 'Book dentist', '18', { startTime: '2026-10-02', dueDate: '2026-10-11', reviewAt: '2026-10-04' }),
  baseTask('dated-3', 'Service bike', '18', { startTime: '2026-10-06', dueDate: '2026-10-12', reviewAt: '2026-10-07' }),
  baseTask('dated-4', 'Call plumber', '19', { startTime: '2026-10-08', dueDate: '2026-10-13', reviewAt: '2026-10-09' }),
];
const somedaySections = [{ id: 's-later', title: 'Later', order: 0 }, { id: 's-ideas', title: 'Ideas', order: 1 }];
const settingsVariants: Record<string, AppSettings> = {
  base: { gtd: { inboxProcessing: {} } },
  full: {
    gtd: {
      inboxProcessing: { scheduleEnabled: true },
      defaultScheduleTime: '09:00',
      taskEditor: { hidden: [], defaultsVersion: 100 },
      viewSections: { someday: somedaySections },
    },
  },
  fullNoTime: { gtd: { inboxProcessing: { scheduleEnabled: true }, taskEditor: { hidden: [], defaultsVersion: 100 } } },
  twoMinuteFirst: { gtd: { inboxProcessing: { twoMinuteFirst: true } } },
  lean: { gtd: { inboxProcessing: { twoMinuteEnabled: false, projectFirst: true, contextStepEnabled: false } } },
  noProject: { gtd: { inboxProcessing: {}, taskEditor: { hidden: ['project'], defaultsVersion: 100 } }, features: { priorities: false, timeEstimates: false } },
};

const guidedToFile: Action[] = [['press', 'yes'], ['press', 'longer'], ['press', 'illDoIt'], ['press', 'oneActionNo']];
export const scenarios: Scenario[] = [
  {
    name: 'guided next action, then trash to the end of the queue',
    settings: 'base',
    taskIds: ['inbox-a', 'inbox-c'],
    actions: [
      ...guidedToFile,
      ['chip', 'context', '@phone'],
      ['set', 'tokenInput', '@of'],
      ['chip', 'suggestion', '@office'],
      ['set', 'tokenInput', 'desk'],
      ['addToken', 'context'],
      ['press', 'more'],
      ['press', 'more'],
      ['set', 'tokenInput', 'focus'],
      ['addToken', 'tag'],
      ['chip', 'project', 'p-launch'],
      ['press', 'fileIt'],
      ['press', 'trash'],
    ],
  },
  {
    name: 'back walks every guided step, then skip writes and moves on',
    settings: 'base',
    taskIds: ['inbox-a', 'inbox-c'],
    actions: [
      ...guidedToFile,
      ['press', 'back'], ['press', 'back'], ['press', 'back'], ['press', 'back'],
      ['press', 'later'], ['press', 'back'],
      ['press', 'yes'], ['press', 'longer'], ['press', 'delegate'], ['press', 'back'],
      ['set', 'title', 'Call Alice @calls'],
      ['press', 'skip'],
      ['press', 'someday'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'start later needs a date; date-only and default time',
    settings: 'full',
    taskIds: ['inbox-a', 'inbox-c', 'inbox-b'],
    actions: [
      ['press', 'later'],
      ['press', 'fileIt'],
      ['quickDate', 'startTime', 'tomorrow'],
      ['dateOnly', 'startTime'],
      ['dateOnly', 'startTime'],
      ['dateOnly', 'startTime'],
      ['chip', 'project', 'p-launch'],
      ['press', 'fileIt'],
      ['press', 'later'],
      ['pickDate', 'startTime', '2026-10-05'],
      ['press', 'fileIt'],
      ['press', 'yes'], ['press', 'longer'], ['press', 'illDoIt'], ['press', 'oneActionNo'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'incubate needs a return date and keeps the someday section',
    settings: 'full',
    taskIds: ['inbox-c', 'returning-d'],
    actions: [
      ['press', 'incubate'],
      ['press', 'fileIt'],
      ['quickDate', 'reviewAt', 'next_week'],
      ['quickDate', 'reviewAt', 'next_week'],
      ['quickDate', 'reviewAt', 'next_month'],
      ['set', 'somedaySection', 's-ideas'],
      ['press', 'fileIt'],
      ['press', 'someday'],
      ['set', 'somedaySection', null],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'two-minute done, reference, and a returning item',
    settings: 'base',
    taskIds: ['inbox-a', 'returning-d', 'inbox-c'],
    actions: [
      ['press', 'yes'],
      ['press', 'done'],
      ['press', 'reference'],
      ['press', 'yes'], ['press', 'longer'], ['press', 'illDoIt'], ['press', 'oneActionNo'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'delegate with people suggestions and a follow-up date',
    settings: 'base',
    taskIds: ['inbox-a', 'inbox-c'],
    actions: [
      ['press', 'yes'], ['press', 'longer'], ['press', 'delegate'],
      ['set', 'delegateWho', 'Al'],
      ['set', 'delegateWho', 'Alice Smith'],
      ['quickDate', 'followUp', 'in_3_days'],
      ['press', 'fileIt'],
      ['press', 'yes'], ['press', 'longer'], ['press', 'delegate'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'delegate with the review date visible and more options',
    settings: 'full',
    taskIds: ['inbox-b'],
    actions: [
      ['press', 'yes'], ['press', 'longer'], ['press', 'delegate'],
      ['set', 'assignedTo', 'Al'],
      ['chip', 'priority', 'urgent'],
      ['chip', 'priority', 'urgent'],
      ['chip', 'energy', 'high'],
      ['chip', 'estimate', '1hr'],
      ['clearDate', 'dueDate'],
      ['pickDate', 'reviewAt', '2026-10-02'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'make it a project with extra actions',
    settings: 'full',
    taskIds: ['inbox-c', 'inbox-a'],
    actions: [
      ['press', 'yes'], ['press', 'longer'], ['press', 'illDoIt'], ['press', 'oneActionYes'],
      ['set', 'nextAction', ''],
      ['press', 'createProject'],
      ['set', 'nextAction', 'Book flights @phone'],
      ['set', 'extraActions', ['Pack bags', '  ', 'Renew passport']],
      ['chip', 'area', 'a-work'],
      ['press', 'back'],
      ['press', 'oneActionYes'],
      ['set', 'nextAction', 'Book flights @phone'],
      ['set', 'extraActions', ['Pack bags', '  ', 'Renew passport']],
      ['press', 'createProject'],
      ['press', 'yes'], ['press', 'longer'], ['press', 'illDoIt'], ['press', 'oneActionYes'],
      ['set', 'title', 'Launch'],
      ['set', 'nextAction', 'Draft announcement'],
      ['press', 'createProject'],
    ],
  },
  {
    name: 'quick mode destinations',
    settings: 'base',
    taskIds: ['inbox-a', 'inbox-c', 'inbox-b'],
    actions: [
      ['press', 'mode'],
      ['press', 'later'], ['press', 'back'],
      ['press', 'delegate'], ['press', 'back'],
      ['press', 'someday'], ['press', 'back'],
      ['press', 'incubate'], ['press', 'back'],
      ['press', 'project'], ['press', 'oneActionNo'], ['press', 'back'],
      ['press', 'project'], ['press', 'oneActionYes'], ['press', 'back'],
      ['press', 'illDoIt'], ['press', 'fileIt'],
      ['press', 'done'],
      ['press', 'mode'],
      ['press', 'yes'],
      ['press', 'mode'],
      ['press', 'trash'],
    ],
  },
  {
    name: 'two-minute question first',
    settings: 'twoMinuteFirst',
    taskIds: ['inbox-a', 'inbox-c'],
    actions: [
      ['press', 'longer'],
      ['press', 'back'],
      ['press', 'longer'],
      ['press', 'yes'],
      ['press', 'back'],
      ['press', 'yes'],
      ['press', 'illDoIt'],
      ['press', 'back'],
      ['press', 'back'],
      ['press', 'back'],
      ['press', 'done'],
    ],
  },
  {
    name: 'no two-minute question, project first, no context step',
    settings: 'lean',
    taskIds: ['inbox-a', 'inbox-c'],
    actions: [
      ['press', 'yes'],
      ['press', 'illDoIt'],
      ['press', 'oneActionNo'],
      ['press', 'fileIt'],
      ['press', 'yes'],
      ['press', 'back'],
      ['press', 'reference'],
    ],
  },
  {
    name: 'project field hidden skips the one-action question',
    settings: 'noProject',
    taskIds: ['inbox-b', 'inbox-c'],
    actions: [
      ['press', 'yes'], ['press', 'longer'], ['press', 'illDoIt'],
      ['press', 'back'], ['press', 'illDoIt'],
      ['set', 'assignedTo', '  Casey  '],
      ['chip', 'energy', 'low'],
      ['press', 'fileIt'],
      ['press', 'yes'], ['press', 'longer'], ['press', 'illDoIt'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'title tokens, an invalid date command, and a timed task',
    settings: 'full',
    taskIds: ['inbox-b', 'inbox-a'],
    actions: [
      ...guidedToFile,
      ['set', 'title', 'Fix sink /due:someday-never'],
      ['press', 'fileIt'],
      ['set', 'title', 'Fix sink +Launch @home #diy !Work %Alex Kim /due:tomorrow'],
      ['set', 'description', 'Buy washer'],
      ['press', 'fileIt'],
      ...guidedToFile,
      ['set', 'title', 'Call Alice +Unknown thing /start:today *'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'dates without a default schedule time keep the date only',
    settings: 'fullNoTime',
    taskIds: ['inbox-b', 'inbox-a'],
    actions: [
      ...guidedToFile,
      ['press', 'fileIt'],
      ['press', 'later'],
      ['quickDate', 'startTime', 'today'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'skipping the last item ends the queue',
    settings: 'base',
    taskIds: ['inbox-c'],
    actions: [
      ['press', 'someday'],
      ['press', 'back'],
      ['set', 'title', 'Plan the trip #travel'],
      ['press', 'skip'],
    ],
  },
  {
    name: 'project search, create early, and area filter',
    settings: 'full',
    taskIds: ['inbox-a', 'inbox-c'],
    actions: [
      ...guidedToFile,
      ['set', 'projectSearch', 'home'],
      ['set', 'projectSearch', 'launch'],
      ['press', 'createProjectEarly'],
      ['chip', 'project', null],
      ['chip', 'area', 'a-home'],
      ['set', 'projectSearch', 'Garden'],
      ['press', 'createProjectEarly'],
      ['press', 'fileIt'],
      ...guidedToFile,
      ['set', 'title', 'Plan trip to Launch party'],
      ['set', 'tokenInput', '#wo'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'project split through the action rows, and No date',
    settings: 'full',
    taskIds: ['inbox-c', 'inbox-b'],
    actions: [
      ['press', 'yes'], ['press', 'longer'], ['press', 'illDoIt'], ['press', 'oneActionYes'],
      ['extraAction', 'enter', 'next'],
      ['extraAction', 'type', 0, 'Pack bags'],
      ['extraAction', 'enter', 0],
      ['extraAction', 'type', 1, '  '],
      ['extraAction', 'enter', 1],
      ['extraAction', 'add'],
      ['extraAction', 'type', 2, 'Renew passport'],
      ['extraAction', 'enter', 0],
      ['extraAction', 'remove', 1],
      ['extraAction', 'add'],
      ['extraAction', 'remove', 2],
      ['set', 'nextAction', ''],
      ['extraAction', 'enter', 'next'],
      ['set', 'nextAction', 'Book flights'],
      ['press', 'createProject'],
      ...guidedToFile,
      ['quickDate', 'dueDate', 'no_date'],
      ['quickDate', 'startTime', 'tomorrow'],
      ['quickDate', 'startTime', 'no_date'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'follow-up date through No date',
    settings: 'base',
    taskIds: ['inbox-a'],
    actions: [
      ['press', 'yes'], ['press', 'longer'], ['press', 'delegate'],
      ['quickDate', 'followUp', 'tomorrow'],
      ['quickDate', 'followUp', 'no_date'],
      ['quickDate', 'followUp', 'next_week'],
      ['press', 'fileIt'],
    ],
  },
  {
    name: 'the next item keeps its dates after Start later, Next, Incubate and Waiting',
    settings: 'full',
    taskIds: ['inbox-a', 'dated-1', 'dated-2', 'dated-3', 'dated-4'],
    actions: [
      ['press', 'later'],
      ['quickDate', 'startTime', 'tomorrow'],
      ['press', 'fileIt'],
      ...guidedToFile,
      ['press', 'fileIt'],
      ['press', 'incubate'],
      ['press', 'fileIt'],
      ['press', 'yes'], ['press', 'longer'], ['press', 'delegate'],
      ['press', 'fileIt'],
      ...guidedToFile,
      ['press', 'fileIt'],
    ],
  },
];

// ---------------------------------------------------------------------------
// Harness

const pad = (value: number) => String(value).padStart(2, '0');
const dateKey = (date: Date | null | undefined) => (date
  ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  : null);
const t = (key: string) => english.strings[key] ?? key;
const tf = (key: string, fallback: string) => {
  const value = t(key);
  return value && value !== key ? value : fallback;
};

const writeLog: unknown[] = [];
const createdIds = new Map<string, string>();
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)).replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, (match, id) => (
  createdIds.has(id) ? `"${createdIds.get(id)}"` : match
)));
// Keeps key presence: an update that clears a field sends it as undefined.
const encodeArgs = (args: unknown[]) => normalize(args.map((arg) => (
  arg && typeof arg === 'object' && !Array.isArray(arg)
    ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
    : arg
)));

/** Context tasks (suggestions, similar tasks) that every scenario keeps. */
export const CONTEXT_TASK_IDS = ['next-e', 'done-f'];
/** The scenario's queue in order, then the context tasks; other Inbox items stay out. */
export const scenarioTasks = (taskIds: string[]): Task[] => [
  ...taskIds.map((id) => allTasks.find((task) => task.id === id)!),
  ...allTasks.filter((task) => CONTEXT_TASK_IDS.includes(task.id)),
];

let realActions: Pick<ReturnType<typeof useTaskStore.getState>, 'updateTask' | 'deleteTask' | 'addTask' | 'addProject'> | null = null;

async function seedStore(settings: AppSettings, tasks: Task[]) {
  resetForTests();
  const initial = useTaskStore.getState();
  realActions ??= { updateTask: initial.updateTask, deleteTask: initial.deleteTask, addTask: initial.addTask, addProject: initial.addProject };
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ tasks, projects, sections: [], areas, people, settings }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  await flushPendingSave();
  useTaskStore.setState({
    ...real,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
  });
  await useTaskStore.getState().fetchData({ throwOnError: true });
  if (useTaskStore.getState()._allTasks.length !== tasks.length) throw new Error('Store seed did not load');
  useTaskStore.setState({
    updateTask: async (id, updates) => { writeLog.push(['updateTask', ...encodeArgs([id, updates]) as unknown[]]); return real.updateTask(id, updates); },
    deleteTask: async (id) => { writeLog.push(['deleteTask', id]); return real.deleteTask(id); },
    addTask: async (title, props, options) => {
      writeLog.push(['addTask', ...encodeArgs([title, props]) as unknown[]]);
      const result = await real.addTask(title, props, options);
      if (result.id) createdIds.set(result.id, `<created:${title}>`);
      return result;
    },
    addProject: async (title, color, initialProps) => {
      writeLog.push(['addProject', ...encodeArgs([title, color, initialProps]) as unknown[]]);
      const created = await real.addProject(title, color, initialProps);
      if (created) createdIds.set(created.id, `<created:${title}>`);
      return created;
    },
  });
}

const textOf = (node: ReactTestInstance): string[] => {
  const children = node.props?.children;
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  return list.filter((child): child is string => typeof child === 'string');
};
const hasText = (root: ReactTestInstance, text: string) => root.findAll((node) => (
  typeof node.type === 'string' && textOf(node).join('') === text
)).length > 0;
const pressables = (root: ReactTestInstance) => root.findAll((node) => (
  typeof node.type === 'string' && typeof node.props.onPress === 'function'
));
const findPressable = (root: ReactTestInstance, label: string) => {
  const byLabel = pressables(root).filter((node) => node.props.accessibilityLabel === label);
  if (byLabel.length > 0) return byLabel[0];
  const byText = pressables(root).filter((node) => node.findAll((child) => (
    typeof child.type === 'string' && textOf(child).join('') === label
  )).length > 0);
  if (byText.length === 0) throw new Error(`No pressable "${label}"`);
  return byText[0];
};

const PRESS_LABELS: Record<string, () => string> = {
  yes: () => t('inbox.yes'),
  later: () => tf('process.later', 'Start later'),
  someday: () => t('inbox.someday'),
  incubate: () => tf('process.incubate', 'Incubate'),
  reference: () => t('nav.reference'),
  trash: () => t('inbox.trash'),
  done: () => t('inbox.doneIt'),
  longer: () => t('inbox.takesLonger'),
  illDoIt: () => t('inbox.illDoIt'),
  delegate: () => t('inbox.delegate'),
  project: () => t('taskEdit.projectLabel'),
  oneActionNo: () => t('process.moreThanOneStepNo'),
  oneActionYes: () => t('process.moreThanOneStepYes'),
  fileIt: () => tf('inbox.fileIt', 'File it'),
  createProject: () => t('process.createProject'),
  back: () => `‹ ${tf('common.back', 'Back')}`,
  skip: () => tf('inbox.skip', 'Skip'),
  more: () => tf('common.more', 'More options'),
};
const DATE_LABELS: Record<DateField, () => string> = {
  startTime: () => t('taskEdit.startDateLabel'),
  dueDate: () => t('taskEdit.dueDateLabel'),
  reviewAt: () => t('taskEdit.reviewDateLabel'),
  followUp: () => t('process.delegateFollowUpLabel'),
};
const QUICK_DATE_LABEL_KEYS: Record<string, [string, string]> = {
  today: ['quickDate.today', 'Today'],
  tomorrow: ['quickDate.tomorrow', 'Tomorrow'],
  in_3_days: ['quickDate.in3Days', '+3 days'],
  next_week: ['quickDate.nextWeek', 'Next week'],
  next_month: ['quickDate.nextMonth', 'Next month'],
  no_date: ['quickDate.noDate', 'No date'],
};

function detectStep(root: ReactTestInstance): string {
  if (root.findAllByType(InboxStepFlow).length === 0) return 'none';
  if (hasText(root, t('inbox.isActionable'))) return 'actionable';
  if (hasText(root, t('inbox.twoMinRule'))) return 'twoMinute';
  if (hasText(root, t('inbox.whoShouldDoIt'))) return 'execution';
  if (hasText(root, t('process.moreThanOneStep'))) return 'oneAction';
  if (hasText(root, tf('process.laterHint', 'Set a start date and move this to Next Actions.'))) return 'later';
  if (hasText(root, tf('process.incubateHint', 'Park this without deciding. It comes back to clarify on the date you choose.'))) return 'incubate';
  if (hasText(root, t('process.delegateDesc'))) return 'waiting';
  if (hasText(root, t('inbox.trash'))) return 'decisions';
  if (hasText(root, tf('viewSections.somedaySection', 'Someday section'))) return 'someday';
  if (hasText(root, tf('inbox.fileIt', 'File it')) || hasText(root, t('process.createProject'))) return 'file';
  throw new Error('Unknown Process Inbox step');
}

type Harness = { renderer: ReactTestRenderer; closed: () => number };

function Root({ onClose }: { onClose: () => void }) {
  const [visible, setVisible] = useState(true);
  return <InboxProcessingModal visible={visible} onClose={() => { onClose(); setVisible(false); }} />;
}

const flush = async () => {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

function controllerOf(root: ReactTestInstance) {
  const flow = root.findAllByType(InboxStepFlow)[0];
  return flow ? flow.props.controller as any : null;
}

function observe(harness: Harness) {
  const root = harness.renderer.root;
  const c = controllerOf(root);
  const writes = normalize(writeLog.splice(0)) as unknown[];
  const toasts = normalize(toastLog.entries.splice(0)) as unknown[];
  if (!c) return { closed: harness.closed(), step: 'none', writes, toasts };
  const date = (value: Date | null, dateOnly: boolean) => (value ? { date: dateKey(value), dateOnly } : null);
  const progress = root.findAll((node) => (
    typeof node.type === 'string' && /^\d+\/\d+ /.test(textOf(node).join(''))
  ))[0];
  return normalize({
    closed: harness.closed(),
    taskId: c.currentTask?.id ?? null,
    step: detectStep(root),
    back: hasText(root, PRESS_LABELS.back()),
    fileIt: hasText(root, PRESS_LABELS.fileIt()),
    progress: progress ? textOf(progress).join('') : null,
    returning: c.isReturningItem,
    counts: [c.totalCount, c.processedCount],
    draft: {
      title: c.processingTitle,
      description: c.processingDescription,
      projectId: c.selectedProjectId,
      areaId: c.selectedAreaId,
      projectSearch: c.projectSearch,
      contexts: c.selectedContexts,
      tags: c.selectedTags,
      tokenInput: c.newContext,
      priority: c.selectedPriority ?? null,
      energyLevel: c.selectedEnergyLevel ?? null,
      assignedTo: c.selectedAssignedTo,
      timeEstimate: c.selectedTimeEstimate ?? null,
      startTime: date(c.pendingStartDate, c.pendingStartDateOnly),
      dueDate: date(c.pendingDueDate, c.pendingDueDateOnly),
      reviewAt: date(c.pendingReviewDate, c.pendingReviewDateOnly),
      delegateWho: c.delegateWho,
      followUp: date(c.delegateFollowUpDate, c.delegateFollowUpDateOnly),
      convertToProject: c.convertToProject,
      nextAction: c.nextActionDraft,
      extraActions: c.extraActionDrafts,
      somedaySectionId: c.selectedSomedaySectionId ?? null,
      showAdvancedOptions: c.showAdvancedOptions,
    },
    suggestions: {
      tokens: c.tokenSuggestions,
      contextCopilot: c.contextCopilotSuggestions,
      tagCopilot: c.tagCopilotSuggestions,
      assignedTo: c.assignedToSuggestions,
      delegateWho: c.delegateWhoSuggestions,
      projects: c.filteredProjects.map((project: Project) => project.id),
      exactProject: c.hasExactProjectMatch,
      similar: c.similarTasks.map((task: Task) => task.id),
      similarProjects: Object.fromEntries(c.similarTaskProjectTitles),
      timeEstimates: c.timeEstimateOptions,
    },
    writes,
    toasts,
  });
}

async function perform(harness: Harness, action: Action) {
  const root = harness.renderer.root;
  const c = controllerOf(root);
  const press = async (node: ReactTestInstance) => {
    await act(async () => { node.props.onPress(); });
    await flush();
  };
  switch (action[0]) {
    case 'press': {
      const [, id] = action;
      if (id === 'mode') {
        const label = pressables(root).find((node) => (
          node.props.accessibilityLabel === tf('process.modeQuick', 'Quick')
          || node.props.accessibilityLabel === tf('process.modeGuided', 'Guided')
        ));
        if (!label) throw new Error('No mode toggle');
        await press(label);
        return;
      }
      if (id === 'createProjectEarly') {
        // The keyboard's submit, which also picks an exact match (no Create button then).
        const inputs = root.findAll((node) => String(node.type) === 'TextInput' && node.props.accessibilityLabel === t('projects.search'));
        if (inputs.length !== 1) throw new Error(`Expected one project search, found ${inputs.length}`);
        await act(async () => { inputs[0].props.onSubmitEditing(); });
        await flush();
        return;
      }
      await press(findPressable(root, PRESS_LABELS[id]()));
      return;
    }
    case 'set': {
      const [, field, value] = action;
      const setter = {
        title: c.setProcessingTitle,
        description: c.setProcessingDescription,
        tokenInput: c.setNewContext,
        projectSearch: c.setProjectSearch,
        assignedTo: c.setSelectedAssignedTo,
        delegateWho: c.setDelegateWho,
        nextAction: c.setNextActionDraft,
        extraActions: c.setExtraActionDrafts,
        somedaySection: c.setSelectedSomedaySectionId,
      }[field];
      if (!setter) throw new Error(`Unknown field ${field}`);
      await act(async () => { setter(value ?? undefined); });
      await flush();
      return;
    }
    case 'chip': {
      const [, kind, value] = action;
      const label = (() => {
        switch (kind) {
          case 'context':
          case 'tag':
            return `${value} x`;
          case 'suggestion':
            return value!;
          case 'project':
            return `${t('taskEdit.projectLabel')}: ${value
              ? projects.find((project) => project.id === value)?.title
              : t('inbox.noProject')}`;
          case 'area':
            return `${t('taskEdit.areaLabel')}: ${value
              ? areas.find((area) => area.id === value)?.name
              : t('projects.noArea')}`;
          case 'priority':
            return t(`priority.${value}`);
          case 'energy':
            return t(`energyLevel.${value}`);
          case 'estimate':
            return formatTimeEstimateLabel(value as never);
        }
      })();
      await press(findPressable(root, label));
      return;
    }
    case 'quickDate': {
      const [, field, preset] = action;
      const [key, fallback] = QUICK_DATE_LABEL_KEYS[preset];
      await press(findPressable(root, `${DATE_LABELS[field]()}: ${tf(key, fallback)}`));
      return;
    }
    case 'pickDate': {
      const [, field, value] = action;
      await press(findPressable(root, DATE_LABELS[field]()));
      const pickers = root.findAll((node) => String(node.type) === 'DateTimePicker');
      if (pickers.length !== 1) throw new Error(`Expected one date picker, found ${pickers.length}`);
      const [year, month, day] = value.split('-').map(Number);
      await act(async () => { pickers[0].props.onChange({ type: 'set' }, new Date(year, month - 1, day, 15, 45)); });
      await flush();
      return;
    }
    case 'dateOnly': {
      const [, field] = action;
      const label = DATE_LABELS[field]();
      const toggle = pressables(root).find((node) => (
        node.props.accessibilityLabel === `${label}: ${t('taskEdit.dateOnly')}`
        || String(node.props.accessibilityLabel).startsWith(`${label}: ${t('settings.gtdMobile.defaultScheduleTime')}: `)
      ));
      if (!toggle) throw new Error(`No date-only toggle for ${field}`);
      await press(toggle);
      return;
    }
    case 'clearDate': {
      const [, field] = action;
      await press(findPressable(root, `${DATE_LABELS[field]()}: ${t('common.clear')}`));
      return;
    }
    case 'extraAction': {
      // The next-action field comes first, then one field per extra row.
      const fields = root.findAll((node) => String(node.type) === 'TextInput' && node.props.accessibilityLabel === t('process.nextAction'));
      if (action[1] === 'add') {
        await press(findPressable(root, `+ ${t('process.addAnotherAction')}`));
        return;
      }
      if (action[1] === 'remove') {
        const removes = pressables(root).filter((node) => node.props.accessibilityLabel === t('process.removeAction'));
        await press(removes[action[2]]);
        return;
      }
      const field = fields[action[2] === 'next' ? 0 : action[2] + 1];
      if (!field) throw new Error(`No action field ${action[2]}`);
      await act(async () => {
        if (action[1] === 'type') field.props.onChangeText(action[3]);
        else field.props.onSubmitEditing();
      });
      await flush();
      return;
    }
    case 'addToken': {
      const [, kind] = action;
      const inputs = root.findAll((node) => String(node.type) === 'TextInput' && node.props.placeholder === (kind === 'context' ? '@home' : '#deep-work'));
      if (inputs.length !== 1) throw new Error(`Expected one ${kind} input, found ${inputs.length}`);
      await act(async () => { inputs[0].props.onSubmitEditing(); });
      await flush();
      return;
    }
  }
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  toastLog.entries.length = 0;
  createdIds.clear();
  await seedStore(settingsVariants[scenario.settings], scenarioTasks(scenario.taskIds));
  let closedCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Root onClose={() => { closedCount += 1; }} />);
  });
  await flush();
  const harness: Harness = { renderer, closed: () => closedCount };
  const observations = [observe(harness)];
  for (const action of scenario.actions) {
    try {
      await perform(harness, action);
    } catch (error) {
      const texts = harness.renderer.root.findAll((node) => typeof node.type === 'string').map(textOf).flat().filter(Boolean);
      throw new Error(`${scenario.name}: ${JSON.stringify(action)} failed after ${JSON.stringify(observations.at(-1))}\n${texts.join(' | ')}\n${String(error)}`);
    }
    observations.push(observe(harness));
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

describe('React Native Process Inbox parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = TIME_ZONE;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    english.strings = await loadTranslations('en');
  });
  afterAll(() => {
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    const selected = CAPTURE && CAPTURE_ONLY.length > 0
      ? scenarios.filter(({ name }) => CAPTURE_ONLY.includes(name))
      : scenarios;
    for (const scenario of selected) {
      captured[scenario.name] = await runScenario(scenario);
    }
    const inputs = normalize({
      timeZone: TIME_ZONE, now: NOW, tasks: allTasks, projects, areas, people, settings: settingsVariants, scenarios,
    }) as Record<string, unknown>;
    if (CAPTURE) {
      let previous: { provenance?: unknown; observations?: Record<string, unknown> } = {};
      try {
        previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
      } catch {
        previous = {};
      }
      const observations = CAPTURE_ONLY.length === 0 ? captured : Object.fromEntries(scenarios.map(({ name }) => [
        name,
        CAPTURE_ONLY.includes(name) ? captured[name] : previous.observations?.[name],
      ]));
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: previous.provenance, ...inputs, observations }, null, 1)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const { observations, provenance: _provenance, ...frozenInputs } = fixture;
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of selected) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);

  // The controller used to reset dates after the next item had opened, so the
  // next item lost them and filing it erased them from the task.
  it('keeps the next item\'s dates after Start later, Next, Incubate and Waiting', async () => {
    const scenario = scenarios.find(({ name }) => name.startsWith('the next item keeps its dates'))!;
    const observed = await runScenario(scenario) as { taskId?: string; draft?: Record<string, { date: string } | null>; writes: unknown[][] }[];
    const dates = (taskId: string) => {
      const { draft } = observed.find((observation) => observation.taskId === taskId)!;
      return [draft?.startTime?.date, draft?.dueDate?.date, draft?.reviewAt?.date];
    };
    expect(dates('dated-1')).toEqual(['2026-10-01', '2026-10-10', '2026-10-03']);
    expect(dates('dated-2')).toEqual(['2026-10-02', '2026-10-11', '2026-10-04']);
    expect(dates('dated-3')).toEqual(['2026-10-06', '2026-10-12', '2026-10-07']);
    expect(dates('dated-4')).toEqual(['2026-10-08', '2026-10-13', '2026-10-09']);
    expect(observed.at(-1)!.writes[0][2]).toMatchObject({ startTime: '2026-10-08', dueDate: '2026-10-13', reviewAt: '2026-10-09' });
  }, 60_000);

  // The draft was built from the task as shown; filing it writes only what the user changed, field by field.
  it('keeps a context and a note another device synced while the decision waited', async () => {
    await seedStore(settingsVariants.base, scenarioTasks(['inbox-a', 'inbox-c']));
    useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, deviceId: 'this-device' } });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Root onClose={() => undefined} />); });
    await flush();
    const harness: Harness = { renderer, closed: () => 0 };
    const stored = () => useTaskStore.getState()._tasksById.get('inbox-a')!;
    for (const action of guidedToFile) await perform(harness, action);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const save = runSyncStoreSave(async () => {
      await held;
      useTaskStore.setState({
        _allTasks: useTaskStore.getState()._allTasks.map((entry) => (entry.id === 'inbox-a'
          ? { ...entry, rev: 5, revBy: 'other-device', contexts: ['@phone', '@remote'], description: 'Synced note' }
          : entry)),
      });
    });
    await perform(harness, ['press', 'fileIt']);
    release();
    await save;
    await flush();
    expect(stored()).toMatchObject({ status: 'next', contexts: ['@phone', '@remote'], description: 'Synced note' });
    await act(async () => { renderer.unmount(); });
    await flushPendingSave();
  }, 60_000);

  it('keeps a context and a note another device synced before File it was pressed, after the screen re-rendered', async () => {
    await seedStore(settingsVariants.base, scenarioTasks(['inbox-a', 'inbox-c']));
    useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, deviceId: 'this-device' } });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Root onClose={() => undefined} />); });
    await flush();
    const harness: Harness = { renderer, closed: () => 0 };
    const stored = () => useTaskStore.getState()._tasksById.get('inbox-a')!;
    for (const action of guidedToFile) await perform(harness, action);
    // The sync lands and the screen re-renders on the new row before the decision: the draft was filled before it.
    await act(async () => {
      useTaskStore.setState({
        _allTasks: useTaskStore.getState()._allTasks.map((entry) => (entry.id === 'inbox-a'
          ? { ...entry, rev: 5, revBy: 'other-device', contexts: ['@phone', '@remote'], description: 'Synced note' }
          : entry)),
      });
    });
    await flush();
    await perform(harness, ['press', 'fileIt']);
    await flush();
    expect(stored()).toMatchObject({ status: 'next', contexts: ['@phone', '@remote'], description: 'Synced note' });
    await act(async () => { renderer.unmount(); });
    await flushPendingSave();
  }, 60_000);

  it('keeps an attachment a sync save published while a title link waited, and refuses Undo once another device changed the task', async () => {
    toastLog.entries.length = 0;
    await seedStore(settingsVariants.base, scenarioTasks(['inbox-a', 'inbox-c']));
    useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, deviceId: 'this-device' } });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Root onClose={() => undefined} />); });
    await flush();
    const harness: Harness = { renderer, closed: () => 0 };
    const stored = () => useTaskStore.getState()._tasksById.get('inbox-a')!;
    const publish = (task: Task) => useTaskStore.setState({
      _allTasks: useTaskStore.getState()._allTasks.map((entry) => (entry.id === task.id ? task : entry)),
    });
    await perform(harness, ['set', 'title', 'Call Alice /link:https://notes.example']);
    for (const action of guidedToFile) await perform(harness, action);

    // The decision is filed while a sync save holds the gate; the save then publishes another device's attachment.
    const remote = { id: 'att-remote', kind: 'link' as const, title: 'Remote', uri: 'https://remote.example', createdAt: at('22'), updatedAt: at('22') };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const save = runSyncStoreSave(async () => {
      await held;
      publish({ ...stored(), rev: 5, attachments: [remote] });
    });
    await perform(harness, ['press', 'fileIt']);
    release();
    await save;
    await flush();
    expect(stored().status).toBe('next');
    expect(stored().attachments?.map((attachment) => attachment.uri)).toEqual(['https://remote.example', 'https://notes.example']);

    // Another device then edits the task; Undo must not put this device's old fields back over it.
    publish({ ...stored(), title: 'Edited elsewhere', rev: 9, revBy: 'other-device' });
    toastLog.entries.length = 0;
    await act(async () => { toastLog.lastAction?.(); });
    await flush();
    expect(stored()).toMatchObject({ title: 'Edited elsewhere', status: 'next' });
    expect(toastLog.entries).toEqual([['error', 'Error', expect.stringMatching(/^STALE_REVISION/), null]]);
    await act(async () => { renderer.unmount(); });
    await flushPendingSave();
  }, 60_000);
});
