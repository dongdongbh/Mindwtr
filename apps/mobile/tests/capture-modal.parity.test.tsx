


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Area,
  type Project,
  type Task,
} from '@mindwtr/core';

import CaptureScreen from '@/app/capture-modal';
import { QuickAddPreview } from '@/components/QuickAddPreview';

const FIXTURE_PATH = new URL('../../../packages/core/src/capture-modal-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_CAPTURE_MODAL === '1';
const CAPTURE_ONLY = process.env.MINDWTR_CAPTURE_CAPTURE_MODAL_SCENARIOS?.split('|').filter(Boolean) ?? [];

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  params: {} as Record<string, string>,
  canGoBack: false,
  suggestions: {} as Record<string, unknown>,
  refuseWrites: false,

  closed: false,
  log: {
    toasts: [] as unknown[],
    navigation: [] as unknown[],
    ai: [] as unknown[],
  },
  backHandler: null as null | (() => boolean),
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindwtr/core')>()),

  createAIProvider: () => ({
    predictMetadata: async (input: { title: string; contexts: string[]; tags: string[] }) => {
      if (!harness.closed) harness.log.ai.push(['predictMetadata', input]);
      return harness.suggestions[input.title] ?? {};
    },
  }),
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => harness.params,
  useRouter: () => ({
    back: () => { harness.closed = true; harness.log.navigation.push(['back']); },
    canGoBack: () => harness.canGoBack,
    replace: (path: unknown) => { harness.closed = true; harness.log.navigation.push(['replace', path]); },
  }),
}));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: () => undefined }),
  usePreventRemove: () => undefined,
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: (toast: { tone?: string; title?: string; message?: string; durationMs?: number }) => {
      harness.log.toasts.push([toast.tone ?? null, toast.title ?? null, toast.message ?? null, toast.durationMs ?? null]);
    },
    dismissToast: () => undefined,
  }),
  ToastViewport: () => null,
}));
vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff', cardBg: '#f8fafc', inputBg: '#fff', border: '#cbd5e1', text: '#0f172a',
    secondaryText: '#64748b', tint: '#3b82f6', danger: '#ef4444',
  }),
}));

vi.mock('@/lib/ai-config', () => ({
  buildCopilotConfig: () => ({}),
  isAIKeyRequired: () => true,
  loadAIKey: async () => 'test-key',
}));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(async () => undefined), logInfo: vi.fn(async () => undefined), logWarn: vi.fn(async () => undefined) }));
vi.mock('@/lib/share-intent-diagnostics', () => ({ logIosShareDiagnostic: () => undefined }));
vi.mock('@/lib/hardware-back', () => ({
  addHardwareBackPressListener: (handler: () => boolean) => {
    harness.backHandler = handler;
    return { remove: () => { if (harness.backHandler === handler) harness.backHandler = null; } };
  },
  returnToPreviousApp: () => {
    harness.log.navigation.push(['returnToPreviousApp']);
    return true;
  },
}));
vi.mock('@/lib/task-meta-navigation', () => ({
  openTaskScreen: (...args: unknown[]) => { harness.closed = true; harness.log.navigation.push(['openTaskScreen', ...args]); },
  stashPendingCaptureTaskOpen: (request: unknown) => { harness.log.navigation.push(['stashPendingCaptureTaskOpen', request]); },
}));
vi.mock('@/components/themed-alert', () => ({ ThemedAlertHost: () => null }));

vi.mock('@/lib/attachment-sync-utils', () => ({
  getAttachmentsDir: async () => 'file:///data/mindwtr/attachments/',
  canUploadAttachmentFrom: (uri: string) => {
    if (!uri.startsWith('file:///data/mindwtr/attachments/')) return false;
    const leaf = uri.slice('file:///data/mindwtr/attachments/'.length);
    return leaf.length > 0 && !leaf.includes('/');
  },
}));


export const TIME_ZONE = 'UTC';
export const NOW = '2026-09-28T14:00:00.000Z';
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
  project('p-gone', 'Removed', 'active', 3, { deletedAt: at('02') }),
];
const tasks: Task[] = [
  task('t-phone', 'Call bank', 'next', '10', { contexts: ['@phone'], tags: ['#finance'] }),
  task('t-desk', 'Write report', 'next', '11', { contexts: ['@computer', '@home office'], tags: ['#work'], projectId: 'p-launch' }),
  task('t-inbox', 'Loose idea', 'inbox', '13'),
];
const settingsVariants: Record<string, AppSettings> = {
  base: {},
  ai: { ai: { enabled: true, provider: 'openai' } },
  aiNoEstimates: { ai: { enabled: true, provider: 'openai' }, features: { timeEstimates: false } },
  fixedArea: { gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'a-home' }, features: { priorities: true } },
};

const encodedProps = (props: Record<string, unknown>) => encodeURIComponent(JSON.stringify(props));

export type CaptureModalAction =
  | ['type', string]
  | ['description', string]
  | ['help']
  | ['save']
  | ['saveAndEdit']
  | ['cancel']

  | ['back']
  | ['confirmBulk']
  | ['cancelBulk']

  | ['applyCopilot', string]
  | ['applyAllCopilot']

  | ['refuseWrites', boolean];
export type CaptureModalScenario = {
  name: string;

  params: Record<string, string>;
  settings: string;

  canGoBack: boolean;

  suggestions?: Record<string, { context?: string; timeEstimate?: string; tags?: string[] }>;
  actions: CaptureModalAction[];
};

const managedFile = {
  id: 'att-managed', kind: 'file', title: ' Receipt.pdf ', uri: 'file:///data/mindwtr/attachments/att-managed.pdf',
  mimeType: 'application/pdf', size: 2048, createdAt: at('20'), updatedAt: at('21'),
};

export const scenarios: CaptureModalScenario[] = [
  {

    name: 'a capture link with a note, tags and a project no project carries',
    params: {
      initialValue: 'Buy%20groceries',
      initialProps: '%7B%22description%22%3A%22From%20store%22%2C%22tags%22%3A%5B%22%23errands%22%2C%22%23home%22%5D%7D',
      project: 'Shopping',
    },
    settings: 'base',
    canGoBack: false,
    actions: [['save']],
  },
  {

    name: 'a capture link naming a project by its id',
    params: { initialValue: 'Plan%20trip', initialProps: '%7B%22description%22%3A%22Book%20flights%22%7D', project: 'p-launch' },
    settings: 'base',
    canGoBack: false,
    actions: [['type', 'Plan trip @phone'], ['save']],
  },
  {
    name: 'a capture link naming an archived project by title in another case: no project',
    params: { initialValue: 'Clear%20desk', project: 'OLD STUFF' },
    settings: 'base',
    canGoBack: true,
    actions: [['save']],
  },
  {
    name: 'a capture link naming a live project by title, overridden by a typed project token',
    params: { initialValue: 'Fix%20sink', project: 'home repairs' },
    settings: 'base',
    canGoBack: true,
    actions: [['type', 'Fix sink +Launch'], ['save']],
  },
  {

    name: 'a share with a subject, a body and a link; Save & edit opens the editor',
    params: {
      initialValue: 'Subject',
      initialProps: '%7B%22description%22%3A%22Body%20with%20https%3A%2F%2Fexample.com%2Fdoc%5Cnhttps%3A%2F%2Fexample.com%2Fdoc%22%7D',
    },
    settings: 'base',
    canGoBack: false,
    actions: [['description', 'Body with https://example.com/doc'], ['saveAndEdit']],
  },
  {

    name: 'a plain text share',
    params: { initialValue: 'The%20paragraph%20I%20selected%20in%20another%20app' },
    settings: 'base',
    canGoBack: false,
    actions: [['save']],
  },
  {

    name: 'a multi-line share asks first, then creates one task per line',
    params: { initialValue: 'Multi%0Aline%0Ashare' },
    settings: 'base',
    canGoBack: false,
    actions: [['save'], ['cancelBulk'], ['save'], ['back'], ['save'], ['confirmBulk']],
  },
  {

    name: 'an assistant note, its description merged with a typed /note: token',
    params: { initialValue: 'Voice%20note', initialProps: '%7B%22description%22%3A%22Longer%20spoken%20text%22%7D' },
    settings: 'base',
    canGoBack: false,
    actions: [['type', 'Voice note /note:said aloud'], ['description', '  Longer spoken text  '], ['save']],
  },
  {

    name: 'a widget quick capture saves, then returns to the previous app',
    params: { origin: 'system' },
    settings: 'base',
    canGoBack: false,
    actions: [['type', 'Call @phone about #finance +Launch /due:tomorrow'], ['save']],
  },
  {
    name: 'a widget quick capture cancelled over the app returns to the previous app',
    params: { origin: 'system' },
    settings: 'base',
    canGoBack: true,
    actions: [['type', 'Never mind'], ['cancel']],
  },
  {
    name: 'a widget quick capture: Save & edit stays in the app',
    params: { origin: 'system' },
    settings: 'base',
    canGoBack: false,
    actions: [['type', 'Draft agenda'], ['saveAndEdit']],
  },
  {

    name: "a project's add button: Save & edit stays on the project",
    params: { initialProps: encodedProps({ projectId: 'p-launch' }), returnTo: '/projects-screen?projectId=p-launch' },
    settings: 'base',
    canGoBack: true,
    actions: [['type', 'Order parts'], ['saveAndEdit']],
  },
  {
    name: "a project's add button: Save & edit into another project opens the editor",
    params: { initialProps: encodedProps({ projectId: 'p-launch' }), returnTo: '/projects-screen?projectId=p-launch' },
    settings: 'base',
    canGoBack: true,
    actions: [['type', 'Order parts +"Home Repairs"'], ['saveAndEdit']],
  },
  {
    name: 'returnTo is used only with nothing behind the screen, and only a safe app path',
    params: { initialValue: 'Unsafe', returnTo: 'https%3A%2F%2Fevil.example%2F' },
    settings: 'base',
    canGoBack: false,
    actions: [['save']],
  },
  {
    name: 'a safe returnTo with nothing behind the screen',
    params: { initialValue: 'Safe', returnTo: '%2Fprojects-screen%3FprojectId%3Dp-home' },
    settings: 'base',
    canGoBack: false,
    actions: [['cancel']],
  },
  {
    name: 'link presets: status, contexts, tags, an area, and an archived project',
    params: {
      initialValue: 'Preset%20task',
      initialProps: encodedProps({
        status: ' NEXT ', contexts: ['home', ' @phone ', 'Home', 7, ''], tags: ['x', '#y', 'X'], projectId: 'p-old', areaId: 'a-home', description: '   ',
      }),
    },
    settings: 'base',
    canGoBack: false,
    actions: [['save']],
  },
  {
    name: 'link presets: a live project wins over an area; a deleted area and a bad status are dropped',
    params: {
      text: 'From%20the%20text%20param',
      title: 'Ignored%20title',
      initialProps: encodedProps({ status: 'done', projectId: 'p-home', areaId: 'a-work' }),
    },
    settings: 'base',
    canGoBack: false,
    actions: [['save']],
  },
  {
    name: 'link presets: a deleted area, a malformed props param and the title param',
    params: { title: 'Only%20title', initialProps: '%7Bnot%20json' },
    settings: 'fixedArea',
    canGoBack: false,
    actions: [['save']],
  },
  {
    name: 'shared files: only files the app manages are saved',
    params: {
      initialValue: 'Receipt',
      initialProps: encodedProps({
        attachments: [
          managedFile,
          { id: 'att-outside', kind: 'file', title: 'Elsewhere', uri: 'file:///sdcard/Download/elsewhere.pdf', createdAt: at('20') },
          { id: 'att-nested', kind: 'file', title: '', uri: 'file:///data/mindwtr/attachments/sub/nested.pdf', createdAt: at('20') },
          { id: 'att-link', kind: 'link', title: 'A link', uri: 'https://example.com', createdAt: at('20') },
          { id: '', kind: 'file', title: 'No id', uri: 'file:///data/mindwtr/attachments/x.pdf', createdAt: at('20') },
        ],
        description: 'Scanned',
      }),
    },
    settings: 'base',
    canGoBack: false,
    actions: [['save']],
  },
  {
    name: 'shared files with several lines: only the first task carries them',
    params: { initialValue: 'Receipt%0APay%20it', initialProps: encodedProps({ attachments: [managedFile] }) },
    settings: 'base',
    canGoBack: false,
    actions: [['save'], ['confirmBulk']],
  },
  {
    name: 'an invalid date command warns and writes nothing, alone or in a line',
    params: {},
    settings: 'base',
    canGoBack: true,
    actions: [
      ['type', 'Pay rent /due:whenever'],
      ['save'],
      ['type', 'Plan beds +Garden plan\nPay rent /due:whenever'],
      ['save'],
      ['confirmBulk'],
    ],
  },
  {
    name: 'the store refuses: the card shows the error until a save lands',
    params: {},
    settings: 'base',
    canGoBack: true,
    actions: [
      ['type', 'Buy milk'],
      ['refuseWrites', true],
      ['save'],
      ['type', 'Buy milk and eggs'],
      ['type', 'one\ntwo'],
      ['save'],
      ['confirmBulk'],
      ['refuseWrites', false],
      ['type', 'Buy milk'],
      ['save'],
    ],
  },
  {
    name: 'a blank draft does nothing; a trailing blank line joins the lines',
    params: {},
    settings: 'base',
    canGoBack: true,
    actions: [['type', '   '], ['save'], ['saveAndEdit'], ['type', 'Buy eggs\nCall plumber\n\n'], ['save']],
  },
  {
    name: 'the syntax help and the fixed default area',
    params: {},
    settings: 'fixedArea',
    canGoBack: true,
    actions: [['help'], ['type', 'Water plants'], ['help'], ['help'], ['save']],
  },
  {
    name: 'the copilot: one part, then all, typing clears what was applied',
    params: { initialValue: 'Call%20the%20bank' },
    settings: 'ai',
    canGoBack: true,
    suggestions: {
      'Call the bank': { context: '@phone', timeEstimate: '15min', tags: ['#finance', '#urgent'] },
      'Call the bank today': { tags: ['#finance'] },
      'Pay': { context: '@computer' },
    },
    actions: [
      ['applyCopilot', '@phone'],
      ['applyAllCopilot'],
      ['type', 'Call the bank today'],
      ['applyCopilot', '#finance'],
      ['type', 'Pay'],
      ['type', 'Call the bank'],
      ['applyCopilot', '#urgent'],
      ['applyCopilot', '15min'],
      ['save'],
    ],
  },
  {
    name: 'the copilot with time estimates off: an estimate alone suggests nothing',
    params: {},
    settings: 'aiNoEstimates',
    canGoBack: true,
    suggestions: {
      'Write memo': { timeEstimate: '30min' },
      'Write memo now': { timeEstimate: '30min', context: '@computer' },
    },
    actions: [['type', 'Write memo'], ['type', 'Write memo now'], ['applyCopilot', '@computer'], ['save']],
  },
];


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

type RealActions = Pick<ReturnType<typeof useTaskStore.getState>, 'addTask' | 'addTasks' | 'addProject'>;
let realActions: RealActions | null = null;

async function seedStore(settings: AppSettings) {
  resetForTests();
  const initial = useTaskStore.getState();
  realActions ??= { addTask: initial.addTask, addTasks: initial.addTasks, addProject: initial.addProject };
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
      if (harness.refuseWrites) return { success: false, error: 'Disk full' };
      const result = await real.addTask(title, props, options);
      if (result.id) createdIds.set(result.id, `<created:${title}>`);
      return result;
    },
    addTasks: async (items) => {
      log('addTasks', [items]);
      if (harness.refuseWrites) return { success: false, error: 'Disk full' };
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
  });
}

const hostOf = (root: ReactTestInstance, type: string) => root.findAll((node) => (node.type as unknown) === type);
const textOf = (node: ReactTestInstance): string => node.children
  .map((child) => (typeof child === 'string' ? child : textOf(child)))
  .join('');

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
};


const observe = (root: ReactTestInstance) => {
  const preview = root.findAllByType(QuickAddPreview)[0];
  const inPreview = new Set(preview ? preview.findAll(() => true) : []);
  return {
    texts: hostOf(root, 'Text').filter((node) => !inPreview.has(node)).map(textOf),
    fields: hostOf(root, 'TextInput').map((node) => ({ placeholder: node.props.placeholder, value: node.props.value })),
    preview: preview ? preview.props.entries : [],
    controls: [...hostOf(root, 'TouchableOpacity'), ...hostOf(root, 'Pressable')]
      .map((node) => ({ label: node.props.accessibilityLabel ?? textOf(node), disabled: Boolean(node.props.disabled) })),
  };
};

const findControl = (root: ReactTestInstance, label: string) => {
  const control = [...hostOf(root, 'TouchableOpacity'), ...hostOf(root, 'Pressable')]
    .filter((node) => (node.props.accessibilityLabel ?? textOf(node)) === label)
    .pop();
  if (!control) throw new Error(`No control labelled ${label}`);
  return control;
};

async function runScenario(scenario: CaptureModalScenario) {
  await seedStore(settingsVariants[scenario.settings]);
  harness.params = scenario.params;
  harness.canGoBack = scenario.canGoBack;
  harness.suggestions = scenario.suggestions ?? {};
  harness.refuseWrites = false;
  harness.closed = false;
  harness.backHandler = null;
  writeLog.splice(0);
  harness.log.toasts.splice(0);
  harness.log.navigation.splice(0);
  harness.log.ai.splice(0);
  createdIds.clear();
  let renderer!: ReactTestRenderer;
  let open = true;
  await act(async () => { renderer = create(<CaptureScreen />); });
  await settle();

  const step = () => {
    const screen = open && !harness.closed ? observe(renderer.root) : null;
    if (open && harness.closed) {
      open = false;
      act(() => { renderer.unmount(); });
    }
    return {
      writes: writeLog.splice(0),
      toasts: harness.log.toasts.splice(0),
      navigation: harness.log.navigation.splice(0),
      ai: harness.log.ai.splice(0),
      screen,
    };
  };
  const observations: unknown[] = [normalize(step())];
  const t = (key: string) => harness.strings[key] ?? key;
  for (const action of scenario.actions) {
    if (!open) throw new Error(`${scenario.name}: ${JSON.stringify(action)} comes after the screen closed`);
    try {
      const root = renderer.root;
      const inputs = hostOf(root, 'TextInput');
      await act(async () => {
        switch (action[0]) {
          case 'type': inputs[0].props.onChangeText(action[1]); break;
          case 'description': inputs[1].props.onChangeText(action[1]); break;
          case 'help': findControl(root, '?').props.onPress(); break;
          case 'save': findControl(root, t('common.save')).props.onPress(); break;
          case 'saveAndEdit': findControl(root, t('quickAdd.saveAndEdit')).props.onPress(); break;

          case 'cancel': hostOf(root, 'TouchableOpacity').find((node) => textOf(node) === t('common.cancel'))!.props.onPress(); break;
          case 'cancelBulk': hostOf(root, 'TouchableOpacity').filter((node) => textOf(node) === t('common.cancel')).pop()!.props.onPress(); break;
          case 'confirmBulk': findControl(root, t('quickAdd.bulkConfirmCreate')).props.onPress(); break;
          case 'back':
            if (!harness.backHandler?.()) {
              harness.closed = true;
              harness.log.navigation.push(['systemBack']);
            }
            break;
          case 'applyCopilot': findControl(root, action[1]).props.onPress(); break;
          case 'applyAllCopilot': findControl(root, t('copilot.applyAll')).props.onPress(); break;
          case 'refuseWrites': harness.refuseWrites = action[1]; break;
          default: throw new Error(`Unknown action ${JSON.stringify(action)}`);
        }
      });
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
  const declared = process.env.MINDWTR_CAPTURE_CAPTURE_MODAL_COMMIT;
  if (declared !== head) {
    throw new Error(`Recapture needs MINDWTR_CAPTURE_CAPTURE_MODAL_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  }
  const allowed = new Set([
    'apps/mobile/tests/capture-modal.parity.test.tsx',
    'packages/core/src/capture-modal-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_CAPTURE_MODAL=1 MINDWTR_CAPTURE_CAPTURE_MODAL_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run tests/capture-modal.parity.test.tsx',
    capturedAt: head,
    rendering: 'Platform.OS is android. CaptureScreen renders under react-test-renderer with the real core store; timers are fake and each step advances them 1 s, so the copilot\'s 800 ms wait ends. The AI key is stored and required; createAIProvider answers from the scenario\'s suggestions.',
  };
}

describe('React Native capture confirmation screen parity fixture', () => {
  const originalTz = process.env.TZ;
  const originalOs = Platform.OS;
  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    process.env.TZ = TIME_ZONE;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    harness.strings = await loadTranslations('en');
  });
  afterAll(() => {
    vi.useRealTimers();
    resetForTests();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    const selected = CAPTURE && CAPTURE_ONLY.length > 0 ? scenarios.filter(({ name }) => CAPTURE_ONLY.includes(name)) : scenarios;
    if (selected.length !== (CAPTURE && CAPTURE_ONLY.length > 0 ? CAPTURE_ONLY.length : scenarios.length)) {
      throw new Error(`Unknown scenario in MINDWTR_CAPTURE_CAPTURE_MODAL_SCENARIOS: ${CAPTURE_ONLY.join(' | ')}`);
    }
    for (const scenario of selected) {
      vi.setSystemTime(new Date(NOW));
      captured[scenario.name] = await runScenario(scenario);
    }
    const inputs = normalize({ timeZone: TIME_ZONE, now: NOW, tasks, projects, areas, settings: settingsVariants, scenarios }) as Record<string, unknown>;
    if (CAPTURE) {
      const provenance = captureProvenance();
      if (CAPTURE_ONLY.length === 0) {
        writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance, ...inputs, observations: captured }, null, 1)}\n`);
      } else {
        const reason = process.env.MINDWTR_CAPTURE_CAPTURE_MODAL_REASON;
        if (!reason) throw new Error('A partial recapture needs MINDWTR_CAPTURE_CAPTURE_MODAL_REASON');
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
