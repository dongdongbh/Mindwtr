


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flushPendingSave,
  getQuickDateLabel,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type Project,
  type Task,
  type TaskPriority,
} from '@mindwtr/core';

import { QuickCaptureSheet } from '../quick-capture-sheet';
import { QuickCaptureSheetBody } from './QuickCaptureSheetBody';
import { QuickCaptureSheetPickers } from './QuickCaptureSheetPickers';
import { QuickDateChips } from '../QuickDateChips';

const FIXTURE_PATH = new URL('../../../../packages/core/src/quick-capture-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_QUICK_CAPTURE === '1';
const CAPTURE_ONLY = process.env.MINDWTR_CAPTURE_QUICK_CAPTURE_SCENARIOS?.split('|').filter(Boolean) ?? [];

const english = vi.hoisted(() => ({ strings: {} as Record<string, string> }));
const toastLog = vi.hoisted(() => ({ entries: [] as unknown[] }));
const navigationLog = vi.hoisted(() => ({ entries: [] as unknown[] }));
const preference = vi.hoisted(() => ({ addAnother: false }));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => english.strings[key] ?? key, language: 'en' }),
}));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: (toast: { tone?: string; title?: string; message?: string; durationMs?: number }) => {
      toastLog.entries.push([toast.tone ?? null, toast.title ?? null, toast.message ?? null, toast.durationMs ?? null]);
    },
    dismissToast: vi.fn(),
  }),
  ToastViewport: () => null,
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', icon: '#64748b', tint: '#3b82f6', onTint: '#fff',
    tabIconDefault: '#94a3b8', tabIconSelected: '#3b82f6', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/hooks/use-android-activity-session', () => ({
  useAndroidActivitySession: () => ({ clear: vi.fn(), rearm: vi.fn(), sourceActivityId: null }),
}));

vi.mock('../use-quick-capture-audio', () => ({
  useQuickCaptureAudio: () => ({
    recording: false,
    recordingBusy: false,
    recordingReady: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));
vi.mock('@/lib/quick-capture-preferences', () => ({
  readQuickCaptureAddAnother: async () => preference.addAnother,
  writeQuickCaptureAddAnother: async (enabled: boolean) => { preference.addAnother = enabled; },
}));
vi.mock('@/lib/task-meta-navigation', () => ({
  openTaskScreen: (...args: unknown[]) => { navigationLog.entries.push(['openTaskScreen', ...args]); },
}));
vi.mock('@/lib/recovery-snapshot', () => ({ createMobileRecoverySnapshot: async () => 'data.snapshot.json' }));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), isLoggingEnabled: () => false }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-file-system', () => ({
  File: class {
    info() { return { exists: false }; }
    delete() {}
  },
  readAsStringAsync: vi.fn(),
}));
vi.mock('@react-native-community/datetimepicker', () => ({
  default: (props: Record<string, unknown>) => React.createElement('DateTimePicker', props),
}));


export const TIME_ZONE = 'America/New_York';
export const NOW = '2026-09-23T14:00:00.000Z';
const at = (day: string) => `2026-09-${day}T12:00:00.000Z`;
const task = (id: string, title: string, status: Task['status'], day: string, extra: Partial<Task> = {}): Task => ({
  id, title, status, contexts: [], tags: [], createdAt: at(day), updatedAt: at(day), ...extra,
});
const project = (id: string, title: string, status: Project['status'], order: number, extra: Partial<Project> = {}): Project => ({
  id, title, status, color: '#94a3b8', order, tagIds: [], createdAt: at('01'), updatedAt: at('01'), ...extra,
});

const areas: Area[] = [
  { id: 'a-home', name: 'Home', color: '#16a34a', order: 1, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-work', name: 'Work', color: '#2563eb', order: 0, createdAt: at('01'), updatedAt: at('01') },
  { id: 'a-gone', name: 'Gone', color: '#6b7280', order: 2, createdAt: at('01'), updatedAt: at('01'), deletedAt: at('02') },
];
const projects: Project[] = [
  project('p-launch', 'Launch', 'active', 0, { color: '#2563eb', areaId: 'a-work' }),
  project('p-home', 'Home Repairs', 'active', 1, { areaId: 'a-home' }),
  project('p-old', 'Old stuff', 'archived', 2, { areaId: 'a-work' }),
  project('p-later', 'Learn Spanish', 'someday', 3),
  project('p-gone', 'Removed', 'active', 4, { deletedAt: at('02') }),
];
const tasks: Task[] = [
  task('t-phone', 'Call bank', 'next', '10', { contexts: ['@phone'], tags: ['#finance'], assignedTo: 'Alice Smith' }),
  task('t-desk', 'Write report', 'next', '11', { contexts: ['@computer', '@home office'], tags: ['#work'], projectId: 'p-launch' }),
  task('t-focus', 'Focused already', 'next', '12', { isFocusedToday: true }),
  task('t-inbox', 'Loose idea', 'inbox', '13'),
];
const settingsVariants: Record<string, AppSettings> = {
  base: {},
  priorities: { features: { priorities: true } },
  noPriorities: { features: { priorities: false } },
  autoClean: { quickAddAutoClean: true },
  focusFull: { gtd: { focusTaskLimit: 1 } },
  fixedArea: { gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'a-home' } },
  activeArea: { gtd: { defaultAreaMode: 'active' }, filters: { areaIds: ['a-work'] } },
  schedule: { gtd: { defaultScheduleTime: '09:00', naturalLanguageDates: false } },
};

type Picker = 'project' | 'area' | 'context' | 'priority';
export type QuickCaptureAction =
  | ['type', string]
  | ['note', string]
  | ['save']
  | ['saveAndEdit']
  | ['addAnother', boolean]
  | ['focus']
  | ['more']
  | ['quickDate', 'today' | 'tomorrow' | 'next_week']

  | ['pickDue', string]

  | ['pickDueTime', string]
  | ['clearDueTime']
  | ['clearDue']
  | ['openPicker', Picker]
  | ['closePicker', Picker]
  | ['query', 'project' | 'area' | 'context', string]
  | ['submitQuery', 'project' | 'area' | 'context']
  | ['selectProject', string | null]
  | ['selectArea', string | null]
  | ['selectPriority', TaskPriority | null]
  | ['toggleContext', string]
  | ['removeContext', string]

  | ['clearContexts']

  | ['addContexts']

  | ['reset', 'project' | 'area' | 'priority' | 'contexts']
  | ['confirmBulk']
  | ['cancelBulk']
  | ['close']
  | ['reopen']

  | ['elsewhere', { title: string; contexts?: string[] }];
export type QuickCaptureScenario = {
  name: string;
  settings: string;

  initialProps?: Partial<Task>;
  initialValue?: string;

  addAnotherPreference?: boolean;
  actions: QuickCaptureAction[];
};

export const scenarios: QuickCaptureScenario[] = [
  {
    name: 'empty and whitespace-only drafts cannot be saved',
    settings: 'base',
    actions: [['type', '   '], ['save'], ['saveAndEdit'], ['type', ''], ['save']],
  },
  { name: 'a plain title', settings: 'base', actions: [['type', 'Buy milk'], ['save']] },
  {
    name: 'context, tag, person, project, status and focus tokens',
    settings: 'base',
    actions: [
      ['type', 'Call @phone about #finance with %"Alice Smith"'],
      ['type', 'Plan launch +Launch /next /*'],
      ['type', 'Plan launch +Launch /next /* @home office'],
      ['save'],
    ],
  },
  {
    name: 'date commands and a bare natural-language date',
    settings: 'base',
    actions: [
      ['type', 'Pay rent /due:friday at noon /start:tomorrow'],
      ['type', 'Pay rent /due:2026-10-01 renew lease'],
      ['type', 'Check filters /review:in 2 weeks /waiting'],
      ['type', 'Dentist tomorrow at 4pm'],
      ['save'],
    ],
  },
  {
    name: 'date commands without natural-language dates and with a default time',
    settings: 'schedule',
    actions: [['type', 'Dentist tomorrow'], ['type', 'Dentist /due:tomorrow'], ['type', 'Dentist /start:tomorrow'], ['save']],
  },
  {
    name: 'an invalid date command warns and writes nothing',
    settings: 'base',
    actions: [['type', 'Pay rent /due:whenever'], ['save'], ['type', 'Pay rent /due:someday /start:blorp'], ['save']],
  },
  {
    name: 'new, archived and area project tokens',
    settings: 'base',
    actions: [
      ['type', 'Sketch beds +Garden plan !Home'],
      ['save'],
      ['reopen'],
      ['type', 'Clean up +Old stuff /area:Work'],
      ['save'],
      ['reopen'],
      ['type', 'Water +Garden plan'],
      ['save'],
    ],
  },
  {
    name: 'priority, energy, note and link tokens',
    settings: 'base',
    actions: [['type', 'Fix bug /priority:high /energy:low /note:check logs /link:https://example.com/a'], ['save']],
  },
  {
    name: 'status tokens',
    settings: 'base',
    actions: [['type', 'Read book /someday'], ['type', 'Wifi password /reference'], ['type', 'Ask Bob /waiting %Bob'], ['save']],
  },
  {
    name: 'with Priorities off the priority token stays in the title and the control is hidden',
    settings: 'noPriorities',
    actions: [['type', 'Fix bug /priority:urgent'], ['more'], ['openPicker', 'priority'], ['save']],
  },
  {
    name: 'with Priorities off a preset priority is not saved',
    settings: 'noPriorities',
    initialProps: { priority: 'high' },
    actions: [['type', 'Fix bug'], ['more'], ['save']],
  },
  {
    name: 'priority token and priority picker with priorities on',
    settings: 'priorities',
    actions: [
      ['type', 'Fix bug /priority:high'],
      ['more'],
      ['openPicker', 'priority'],
      ['selectPriority', 'urgent'],
      ['reset', 'priority'],
      ['openPicker', 'priority'],
      ['selectPriority', 'low'],
      ['save'],
    ],
  },
  {
    name: 'tokens stripped with auto-clean',
    settings: 'autoClean',
    actions: [['type', 'Call @phone #finance +Launch /due:tomorrow'], ['save']],
  },
  {
    name: 'the project picker: search, select, create and reset',
    settings: 'base',
    actions: [
      ['type', 'Draft plan'],
      ['openPicker', 'project'],
      ['query', 'project', 'la'],
      ['selectProject', 'p-launch'],
      ['more'],
      ['reset', 'project'],
      ['openPicker', 'area'],
      ['selectArea', 'a-home'],
      ['openPicker', 'project'],
      ['query', 'project', 'launch'],
      ['closePicker', 'project'],
      ['openPicker', 'project'],
      ['query', 'project', '  Kitchen remodel '],
      ['submitQuery', 'project'],
      ['openPicker', 'project'],
      ['selectProject', null],
      ['openPicker', 'project'],
      ['query', 'project', 'home repairs'],
      ['submitQuery', 'project'],
      ['save'],
    ],
  },
  {
    name: 'the area picker: search, select, create and reset',
    settings: 'base',
    actions: [
      ['type', 'Tidy garage +Launch'],
      ['more'],
      ['openPicker', 'area'],
      ['query', 'area', 'o'],
      ['selectArea', 'a-home'],
      ['openPicker', 'project'],
      ['selectProject', 'p-home'],
      ['openPicker', 'area'],
      ['query', 'area', 'Garden '],
      ['submitQuery', 'area'],
      ['reset', 'area'],
      ['openPicker', 'area'],
      ['query', 'area', 'work'],
      ['submitQuery', 'area'],
      ['openPicker', 'area'],
      ['selectArea', null],
      ['save'],
    ],
  },
  {
    name: 'the context picker: toggle, add from the query, remove and clear',
    settings: 'base',
    actions: [
      ['type', 'Errands run'],
      ['openPicker', 'context'],
      ['query', 'context', 'ph'],
      ['toggleContext', '@phone'],
      ['query', 'context', 'errands, @Phone, ＠desk,  ,errands'],
      ['addContexts'],
      ['query', 'context', 'home office'],
      ['submitQuery', 'context'],
      ['toggleContext', '@phone'],
      ['closePicker', 'context'],
      ['more'],
      ['type', 'Errands run @phone'],
      ['openPicker', 'context'],
      ['removeContext', '@DESK'],
      ['clearContexts'],
      ['openPicker', 'context'],
      ['query', 'context', 'waiting room'],
      ['addContexts'],
      ['closePicker', 'context'],
      ['reset', 'contexts'],
      ['openPicker', 'context'],
      ['toggleContext', '@computer'],
      ['closePicker', 'context'],
      ['save'],
    ],
  },
  {
    name: 'due date chips, a picked date and time, and clearing them',
    settings: 'base',
    actions: [
      ['type', 'Submit form'],
      ['more'],
      ['quickDate', 'tomorrow'],
      ['quickDate', 'tomorrow'],
      ['quickDate', 'next_week'],
      ['pickDueTime', '15:30'],
      ['quickDate', 'today'],
      ['pickDue', '2026-10-05'],
      ['clearDueTime'],
      ['pickDueTime', '08:05'],
      ['clearDue'],
      ['pickDueTime', '07:00'],
      ['pickDue', '2026-10-09'],
      ['type', 'Submit form /due:tomorrow /start:friday'],
      ['save'],
    ],
  },
  {
    name: 'a picked due date alone saves date-only and outranks a bare date',
    settings: 'base',
    actions: [['type', 'Call mom next week'], ['more'], ['quickDate', 'today'], ['save']],
  },
  {
    name: 'focus for today and the focus limit',
    settings: 'base',
    actions: [['type', 'Deep work'], ['focus'], ['more'], ['focus'], ['focus'], ['save']],
  },
  {
    name: 'focus is refused at the focus limit',
    settings: 'focusFull',
    actions: [['type', 'Deep work'], ['focus'], ['more'], ['focus'], ['type', 'Deep work /*'], ['save']],
  },
  {
    name: 'the note field and a /note: token',
    settings: 'base',
    actions: [
      ['type', 'Book flights /note:window seat'],
      ['more'],
      ['note', '  Use miles  '],
      ['save'],
      ['reopen'],
      ['type', 'Pack bags /note:Use miles'],
      ['more'],
      ['note', 'Use miles'],
      ['save'],
    ],
  },
  {
    name: 'an Add another burst knows the multi-word context capture 1 created',
    settings: 'base',
    actions: [
      ['addAnother', true],
      ['type', 'plan review @"deep work"'],
      ['more'],
      ['openPicker', 'project'],
      ['selectProject', 'p-launch'],
      ['quickDate', 'tomorrow'],
      ['save'],
      ['type', 'write notes @deep work'],
      ['save'],
      ['type', '   '],
      ['save'],
      ['addAnother', false],
      ['type', 'last one @deep work'],
      ['save'],
      ['reopen'],
    ],
  },
  {
    name: 'the stored Add another preference and reopening',
    settings: 'base',
    addAnotherPreference: true,
    actions: [['type', 'first'], ['save'], ['type', 'second'], ['close'], ['reopen'], ['type', 'third'], ['save']],
  },
  {
    name: 'a sync while the sheet is open stays unknown until the next capture',
    settings: 'base',
    actions: [
      ['addAnother', true],
      ['type', 'x @focus time'],
      ['elsewhere', { title: 'Synced', contexts: ['@focus time'] }],
      ['type', 'y @focus time'],
      ['save'],
      ['type', 'z @focus time'],
      ['save'],
    ],
  },
  {
    name: 'save and edit opens the created task',
    settings: 'base',
    actions: [['type', 'Plan party +Launch'], ['saveAndEdit']],
  },
  {
    name: 'save and edit in an Add another burst',
    settings: 'base',
    actions: [['addAnother', true], ['type', 'Plan party'], ['saveAndEdit']],
  },
  {
    name: 'a capture preset by the project screen',
    settings: 'base',
    initialProps: { projectId: 'p-home', status: 'next', contexts: ['home', '@Home', '  '], description: 'From the project', priority: 'high', dueDate: '2026-09-30', startTime: '2026-09-28T09:00', isFocusedToday: true },
    initialValue: 'Fix fence',
    actions: [['more'], ['save']],
  },
  {
    name: 'a preset project is kept through an Add another burst',
    settings: 'priorities',
    initialProps: { projectId: 'p-home', dueDate: '2026-09-30T17:00', priority: 'high' },
    actions: [['addAnother', true], ['type', 'Buy paint'], ['save'], ['type', 'Buy brushes'], ['save'], ['addAnother', false], ['type', 'Paint'], ['save']],
  },
  {
    name: 'an archived preset project is dropped and the area is kept',
    settings: 'base',
    initialProps: { projectId: 'p-old', areaId: 'a-home' },
    actions: [['type', 'Old thing'], ['save']],
  },
  {
    name: 'a preset project deleted elsewhere is not saved; the task goes to the area the popup shows',
    settings: 'base',
    initialProps: { projectId: 'p-gone', areaId: 'a-work' },
    actions: [['type', 'Orphan'], ['save']],
  },
  {
    name: 'the fixed default area',
    settings: 'fixedArea',
    actions: [['type', 'Water plants'], ['more'], ['openPicker', 'project'], ['selectProject', 'p-launch'], ['reset', 'project'], ['save']],
  },
  {
    name: 'the active area filter as the default area',
    settings: 'activeArea',
    actions: [['type', 'Prepare slides'], ['more'], ['openPicker', 'project'], ['save']],
  },
  {
    name: 'several lines ask first, then create one task per line',
    settings: 'base',
    actions: [
      ['type', 'Buy eggs @errands\nCall plumber +Plumbing\n'],
      ['save'],
      ['cancelBulk'],
      ['save'],
      ['confirmBulk'],
    ],
  },
  {
    name: 'a bad line stops the batch, and a blank line joins pasted lines',
    settings: 'base',
    actions: [
      ['type', 'one\ntwo /due:whenever\nthree\nfour\nfive\nsix\nseven'],
      ['save'],
      ['confirmBulk'],
      ['type', 'First paragraph\n\nsecond paragraph'],
      ['save'],
    ],
  },
  {
    name: 'a bad line refuses the whole batch before any project is created',
    settings: 'base',
    actions: [['type', 'Plan beds +Garden plan\nPay rent /due:whenever'], ['save'], ['confirmBulk']],
  },
  {
    name: 'a trailing blank line also joins the lines into one task',
    settings: 'base',
    actions: [['type', 'Buy eggs\nCall plumber\n\n'], ['save']],
  },
];


const t = (key: string) => english.strings[key] ?? key;
const writeLog: unknown[] = [];
const createdIds = new Map<string, string>();

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => (
  createdIds.get(match) ?? '<uuid>'
)));
const encodeArgs = (args: unknown[]) => normalize(args.map((arg) => (
  arg && typeof arg === 'object' && !Array.isArray(arg)
    ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
    : arg
)));

type RealActions = Pick<ReturnType<typeof useTaskStore.getState>, 'addTask' | 'addTasks' | 'addProject' | 'addArea'>;
let realActions: RealActions | null = null;

async function seedStore(settings: AppSettings) {
  resetForTests();
  const initial = useTaskStore.getState();
  realActions ??= { addTask: initial.addTask, addTasks: initial.addTasks, addProject: initial.addProject, addArea: initial.addArea };
  const real = realActions;
  const data = JSON.parse(JSON.stringify({ tasks, projects, sections: [], areas, people: [], settings }));
  await flushPendingSave();
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    ...real,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    highlightTaskId: null,
  });
  await useTaskStore.getState().fetchData({ throwOnError: true });
  if (useTaskStore.getState()._allTasks.length !== data.tasks.length) throw new Error('Store seed did not load');
  const log = (name: string, args: unknown[]) => { writeLog.push([name, ...encodeArgs(args) as unknown[]]); };
  useTaskStore.setState({
    addTask: async (title, props, options) => {
      log('addTask', [title, props]);
      const result = await real.addTask(title, props, options);
      if (result.id) createdIds.set(result.id, `<created:${title}>`);
      return result;
    },
    addTasks: async (items) => {
      log('addTasks', [items]);
      const result = await real.addTasks(items);
      result.ids?.forEach((id, index) => createdIds.set(id, `<created:${items[index]?.title}>`));
      return result;
    },
    addProject: async (title, color, props) => {
      log('addProject', [title, color, props]);
      const created = await real.addProject(title, color, props);
      if (created) createdIds.set(created.id, `<created-project:${title}>`);
      return created;
    },
    addArea: async (name, props) => {
      log('addArea', [name, props]);
      const created = await real.addArea(name, props);
      if (created) createdIds.set(created.id, `<created-area:${name}>`);
      return created;
    },
  });
}

const hostOf = (root: ReactTestInstance, type: string) => root.findAll((node) => (node.type as unknown) === type);
const textOf = (node: ReactTestInstance | null | undefined): string => {
  if (!node) return '';
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
};
const settle = async () => {
  await act(async () => {
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    }
  });
};
const localDate = (day: string, hours: number, minutes: number) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, hours, minutes, 17, 250);
};

const observe = (root: ReactTestInstance) => {
  const bodyNode = root.findByType(QuickCaptureSheetBody);
  const body = bodyNode.props;
  const pickers = root.findAllByType(QuickCaptureSheetPickers).find((node) => node.props.pickerLayer === 'overlay')!.props;
  const pressable = (onPress: unknown) => [...hostOf(bodyNode, 'TouchableOpacity'), ...hostOf(bodyNode, 'Pressable')]
    .find((node) => node.props.onPress === onPress);
  const save = pressable(body.handleSave)!;
  const saveAndEdit = pressable(body.handleSaveAndEdit)!;
  const focus = pressable(body.onToggleFocusNewTask)!;
  const more = pressable(body.onToggleOptions)!;
  const chips = root.findAllByType(QuickDateChips)[0];
  const customDate = pressable(body.onOpenDueDatePicker);
  const dueTime = pressable(body.onOpenDueTimePicker);
  const bulk = root.findAll((node) => typeof node.type === 'function' && (node.type as { name?: string }).name === 'BulkQuickAddConfirm')[0];
  return {
    text: body.value,
    note: body.noteValue,
    saveEnabled: !save.props.disabled,
    saveAndEditEnabled: !saveAndEdit.props.disabled,
    preview: body.preview ? body.preview.props.entries : [],
    labels: {
      due: body.dueLabel,
      dueTime: body.dueTimeLabel,
      contexts: body.contextLabel,
      project: body.projectLabel,
      area: body.areaLabel,
      priority: body.priorityLabel,
    },
    dueDate: body.dueDate ? body.dueDate.toISOString() : null,
    showDueTime: body.showDueTime,
    projectSelected: body.projectSelected,
    prioritiesEnabled: body.prioritiesEnabled,
    priority: body.selectedPriority,
    areaId: pickers.selectedAreaId,
    contexts: pickers.contextTags,
    focus: {
      on: body.focusNewTask,
      canFocus: body.canFocusNewTask,
      disabledReason: body.focusNewTaskDisabledReason,
      label: focus.props.accessibilityLabel,
    },
    addAnother: body.addAnother,
    expanded: body.optionsExpanded,
    moreLabel: more.props.accessibilityLabel,
    quickDates: chips
      ? hostOf(chips, 'Pressable').map((node) => ({ label: node.props.accessibilityLabel, selected: node.props.accessibilityState.selected }))
      : null,
    customDate: customDate ? { label: textOf(customDate), accessibilityLabel: customDate.props.accessibilityLabel } : null,
    dueTimeChip: dueTime ? dueTime.props.accessibilityLabel : null,
    pickers: {
      project: pickers.showProjectPicker
        ? { query: pickers.projectQuery, items: pickers.filteredProjects.map((entry: Project) => entry.id), exact: pickers.hasExactProjectMatch }
        : null,
      area: pickers.showAreaPicker
        ? { query: pickers.areaQuery, items: pickers.filteredAreas.map((entry: Area) => entry.id), exact: pickers.hasExactAreaMatch }
        : null,
      context: pickers.showContextPicker
        ? { query: pickers.contextQuery, items: pickers.filteredContexts, addable: pickers.hasAddableContextTokens, loading: pickers.contextOptionsLoading }
        : null,
      priority: pickers.showPriorityPicker && pickers.prioritiesEnabled ? { options: pickers.priorityOptions } : null,
    },
    bulk: bulk ? { title: bulk.props.title, message: bulk.props.message, confirm: bulk.props.confirmLabel, cancel: bulk.props.cancelLabel } : null,
  };
};

async function runScenario(scenario: QuickCaptureScenario) {
  await seedStore(scenario.settings === 'base' ? {} : settingsVariants[scenario.settings]);
  preference.addAnother = scenario.addAnotherPreference ?? false;
  writeLog.splice(0);
  toastLog.entries.splice(0);
  navigationLog.entries.splice(0);
  createdIds.clear();
  let openRequestId = 1;
  let open = true;
  let closes = 0;
  const element = () => (
    <QuickCaptureSheet
      visible
      openRequestId={openRequestId}
      onClose={() => { closes += 1; }}
      initialProps={scenario.initialProps}
      initialValue={scenario.initialValue}
    />
  );
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(element()); });
  await settle();
  const observations: unknown[] = [];
  const step = () => {

    const closed = closes > 0;
    if (closed && open) {
      open = false;
      act(() => { renderer.unmount(); });
    }
    closes = 0;
    return {
      writes: writeLog.splice(0),
      toasts: toastLog.entries.splice(0),
      navigation: navigationLog.entries.splice(0),
      closed,
      highlight: useTaskStore.getState().highlightTaskId ?? null,
      sheet: open ? observe(renderer.root) : null,
    };
  };
  observations.push(normalize(step()));
  for (const action of scenario.actions) {
    try {
      if (action[0] === 'reopen') {
        openRequestId += 1;
        if (open) act(() => { renderer.unmount(); });
        await act(async () => { renderer = create(element()); });
        open = true;
      } else if (action[0] === 'elsewhere') {
        await act(async () => { await realActions!.addTask(action[1].title, { contexts: action[1].contexts ?? [] }); });
      } else {
        const root = renderer.root;
        const body = root.findByType(QuickCaptureSheetBody).props;
        const overlay = () => root.findAllByType(QuickCaptureSheetPickers).find((node) => node.props.pickerLayer === 'overlay')!.props;
        const dateLayer = () => root.findAllByType(QuickCaptureSheetPickers).find((node) => node.props.pickerLayer === 'date')!.props;
        await act(async () => {
          switch (action[0]) {
            case 'type': body.onValueChange(action[1]); break;
            case 'note': body.onNoteChange(action[1]); break;
            case 'save': body.handleSave(); break;
            case 'saveAndEdit': body.handleSaveAndEdit(); break;
            case 'addAnother': body.onToggleAddAnother(action[1]); break;
            case 'focus': body.onToggleFocusNewTask(); break;
            case 'more': body.onToggleOptions(); break;
            case 'quickDate': {
              const label = getQuickDateLabel(action[1], t);
              const chip = hostOf(root.findAllByType(QuickDateChips)[0], 'Pressable')
                .find((node) => node.props.accessibilityLabel === label);
              if (!chip) throw new Error(`No quick date chip ${action[1]}`);
              chip.props.onPress();
              break;
            }
            case 'pickDue': body.onOpenDueDatePicker(); break;
            case 'pickDueTime': body.onOpenDueTimePicker(); break;
            case 'clearDueTime': body.onResetDueTime(); break;
            case 'clearDue': body.onResetDueDate(); break;
            case 'openPicker':
              if (action[1] === 'project') body.onOpenProjectPicker();
              if (action[1] === 'area') body.onOpenAreaPicker();
              if (action[1] === 'context') body.onOpenContextPicker();
              if (action[1] === 'priority') body.onOpenPriorityPicker();
              break;
            case 'closePicker':
              if (action[1] === 'project') overlay().onCloseProjectPicker();
              if (action[1] === 'area') overlay().onCloseAreaPicker();
              if (action[1] === 'context') overlay().onCloseContextPicker();
              if (action[1] === 'priority') overlay().onClosePriorityPicker();
              break;
            case 'query':
              if (action[1] === 'project') overlay().onProjectQueryChange(action[2]);
              if (action[1] === 'area') overlay().onAreaQueryChange(action[2]);
              if (action[1] === 'context') overlay().onContextQueryChange(action[2]);
              break;
            case 'submitQuery':
              if (action[1] === 'project') overlay().onSubmitProjectQuery();
              if (action[1] === 'area') overlay().onSubmitAreaQuery();
              if (action[1] === 'context') overlay().onSubmitContextQuery();
              break;
            case 'selectProject': overlay().onSelectProject(action[1]); break;
            case 'selectArea': overlay().onSelectArea(action[1]); break;
            case 'selectPriority': overlay().onSelectPriority(action[1]); break;
            case 'toggleContext': overlay().onSelectContext(action[1]); break;
            case 'removeContext': overlay().onRemoveContext(action[1]); break;
            case 'clearContexts': overlay().onClearContexts(); overlay().onCloseContextPicker(); break;
            case 'addContexts': overlay().onAddContextFromQuery(); break;
            case 'reset':
              if (action[1] === 'project') body.onResetProject();
              if (action[1] === 'area') body.onResetArea();
              if (action[1] === 'priority') body.onResetPriority();
              if (action[1] === 'contexts') body.onResetContexts();
              break;
            case 'confirmBulk':
            case 'cancelBulk': {
              const bulk = root.findAll((node) => typeof node.type === 'function' && (node.type as { name?: string }).name === 'BulkQuickAddConfirm')[0];
              if (!bulk) throw new Error('No bulk confirmation');
              if (action[0] === 'confirmBulk') bulk.props.onConfirm(); else bulk.props.onCancel();
              break;
            }
            case 'close': body.handleClose(); break;
            default: throw new Error(`Unknown action ${JSON.stringify(action)}`);
          }
        });
        if (action[0] === 'pickDue' || action[0] === 'pickDueTime') {
          await settle();
          const layer = dateLayer();
          if (action[0] === 'pickDue') {
            await act(async () => { layer.onDueDateChange({ type: 'set' }, localDate(action[1], 15, 45)); });
          } else {
            const [hours, minutes] = action[1].split(':').map(Number);
            await act(async () => { layer.onDueTimeChange({ type: 'set' }, localDate('2026-01-15', hours, minutes)); });
          }
        }
      }
      await settle();
    } catch (error) {
      throw new Error(`${scenario.name}: ${JSON.stringify(action)} failed\n${String(error)}\n${(error as Error).stack ?? ''}`);
    }
    observations.push(normalize(step()));
  }
  if (open) act(() => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}


function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_QUICK_CAPTURE_COMMIT;
  if (declared !== head) {
    throw new Error(`Recapture needs MINDWTR_CAPTURE_QUICK_CAPTURE_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  }
  const allowed = new Set([
    'apps/mobile/components/quick-capture-sheet/quick-capture-parity.test.tsx',
    'packages/core/src/quick-capture-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_QUICK_CAPTURE=1 MINDWTR_CAPTURE_QUICK_CAPTURE_COMMIT=$(git rev-parse HEAD) bunx vitest run components/quick-capture-sheet/quick-capture-parity.test.tsx',
    capturedAt: head,
  };
}

describe('React Native capture popup parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
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
    const selected = CAPTURE && CAPTURE_ONLY.length > 0 ? scenarios.filter(({ name }) => CAPTURE_ONLY.includes(name)) : scenarios;
    if (selected.length !== (CAPTURE && CAPTURE_ONLY.length > 0 ? CAPTURE_ONLY.length : scenarios.length)) {
      throw new Error(`Unknown scenario in MINDWTR_CAPTURE_QUICK_CAPTURE_SCENARIOS: ${CAPTURE_ONLY.join(' | ')}`);
    }
    for (const scenario of selected) {
      captured[scenario.name] = await runScenario(scenario);
    }
    const inputs = normalize({ timeZone: TIME_ZONE, now: NOW, tasks, projects, areas, settings: settingsVariants, scenarios }) as Record<string, unknown>;
    if (CAPTURE) {
      const provenance = captureProvenance();
      if (CAPTURE_ONLY.length === 0) {
        writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance, ...inputs, observations: captured }, null, 1)}\n`);
      } else {
        const reason = process.env.MINDWTR_CAPTURE_QUICK_CAPTURE_REASON;
        if (!reason) throw new Error('A partial recapture needs MINDWTR_CAPTURE_QUICK_CAPTURE_REASON');
        const previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
        writeFileSync(FIXTURE_PATH, `${JSON.stringify({
          provenance: {
            ...previous.provenance,
            recaptured: [...(previous.provenance.recaptured ?? []), { commit: provenance.capturedAt, reason, scenarios: CAPTURE_ONLY }],
          },
          ...inputs,
          observations: Object.fromEntries(scenarios.map(({ name }) => [
            name,
            CAPTURE_ONLY.includes(name) ? captured[name] : previous.observations[name],
          ])),
        }, null, 1)}\n`);
      }
    }
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const { observations, provenance: _provenance, ...frozenInputs } = fixture;
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of selected) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 180_000);
});
