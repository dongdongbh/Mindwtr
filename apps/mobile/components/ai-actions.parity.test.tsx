


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Alert, Platform } from 'react-native';
import {
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Language,
  type Project,
  type Task,
} from '@mindwtr/core';
import { createTaskDraft, taskDraftToUpdatePatch, type TaskDraft, type TaskDraftSetter } from '@mindwtr/core/task-draft';

import { useTaskEditCopilot } from './task-edit/use-task-edit-copilot';
import { useTaskEditActions } from './task-edit/use-task-edit-actions';
import { useTaskEditPreview } from './task-edit/use-task-edit-preview';
import { useInboxProcessingController } from './inbox-processing/useInboxProcessingController';
import { useReviewModalController } from './review/useReviewModalController';
import type { AIResponseAction } from './ai-response-modal';

const FIXTURE_PATH = new URL('../../../packages/core/src/ai-actions-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_AI_ACTIONS === '1';
const NOW = '2026-09-23T14:00:00.000Z';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  language: 'en',
  storage: new Map<string, string>(),
  secrets: new Map<string, string>(),
  queues: {} as Record<string, unknown[]>,
  calls: [] as unknown[][],
  alerts: [] as unknown[][],
  toasts: [] as unknown[][],
  routes: [] as unknown[],
  logs: [] as unknown[][],

  secretsFail: false,
}));

const translate = (key: string) => harness.strings[key] ?? key;


const answer = async (method: string): Promise<any> => {
  const queue = harness.queues[method];
  const entry = queue && queue.length > 0 ? queue.shift() : { error: `No ${method} answer queued` };
  if (entry && typeof entry === 'object' && 'error' in entry) throw new Error(String((entry as { error: string }).error));
  return (entry as { value: unknown }).value;
};

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  const record = (method: string, config: Record<string, unknown>, input: unknown) => {
    harness.calls.push(['ai', method, {
      provider: config.provider, apiKey: config.apiKey, model: config.model, reasoningEffort: config.reasoningEffort,
      thinkingBudget: config.thinkingBudget, timeoutMs: config.timeoutMs, endpoint: config.endpoint,
      extraBodyParams: config.extraBodyParams, language: config.language, onRequestStop: typeof config.onRequestStop,
    }, input]);
    return answer(method);
  };
  return {
    ...actual,
    createAIProvider: (config: Record<string, unknown>) => ({
      predictMetadata: (input: unknown) => record('predictMetadata', config, input),
      clarifyTask: (input: unknown) => record('clarifyTask', config, input),
      breakDownTask: (input: unknown) => record('breakDownTask', config, input),
      analyzeReview: (input: unknown) => record('analyzeReview', config, input),
    }),
  };
});
vi.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => true,
  getItemAsync: async (key: string) => {
    if (harness.secretsFail) throw new Error('Keystore unavailable');
    return harness.secrets.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => { harness.secrets.set(key, value); },
  deleteItemAsync: async (key: string) => { harness.secrets.delete(key); },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { harness.storage.set(key, value); },
    removeItem: async (key: string) => { harness.storage.delete(key); },
  },
}));
vi.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  notificationAsync: async () => undefined,
}));
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => true }));
vi.mock('../lib/apple-foundation-models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/apple-foundation-models')>()),
  isAppleClarificationPrototypeEnabled: () => false,
}));
vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: translate, language: harness.language }),
}));
vi.mock('../contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('../contexts/quick-capture-context', () => ({ useQuickCapture: () => ({ openQuickCapture: () => undefined }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: (route: unknown) => { harness.routes.push(route); }, back: () => undefined }),
}));
vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({
    showToast: (toast: { title?: string; message?: string; tone?: string; actionLabel?: string; durationMs?: number }) => {
      harness.toasts.push([toast.tone ?? null, toast.title ?? null, toast.message ?? null, toast.actionLabel ?? null, toast.durationMs ?? null]);
    },
    dismissToast: () => undefined,
  }),
  ToastViewport: () => null,
}));
vi.mock('@/hooks/use-theme-tokens', () => ({ useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }) }));
vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', icon: '#64748b', tint: '#3b82f6', onTint: '#fff',
    tabIconDefault: '#94a3b8', tabIconSelected: '#3b82f6', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('../lib/app-log', () => ({
  logError: async (error: unknown) => { harness.logs.push(['error', error instanceof Error ? error.message : String(error)]); },
  logInfo: async () => undefined,
  logWarn: async (message: string, context?: unknown) => { harness.logs.push(['warn', message, JSON.stringify(context ?? null)]); },
}));
vi.mock('../lib/external-calendar', () => ({ fetchExternalCalendarEvents: async () => ({ events: [] }) }));
vi.mock('../lib/store-review-prompt', () => ({ maybeRequestStoreReviewAfterPositiveMoment: async () => false }));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: () => undefined, openProjectScreen: () => undefined }));
vi.mock('../lib/task-meta-navigation', () => ({
  openContextsScreen: () => undefined, openProjectScreen: () => undefined, openTaskScreen: () => undefined,
}));


const at = (day: string, time = '12:00:00') => `2026-${day}T${time}.000Z`;
const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, title, status: 'next', contexts: [], tags: [], createdAt: at('09-01'), updatedAt: at('09-20'), ...extra,
});
const TASKS: Task[] = [
  task('t-dentist', 'Book the dentist', { contexts: ['@phone'], tags: ['#health'], dueDate: '2026-09-30', reviewAt: '2026-09-26' }),
  task('t-call', 'Call the bank', { contexts: ['@phone', '@errands'], tags: ['#money'] }),
  task('t-launch', 'Plan the launch party', { projectId: 'p-launch', description: 'Venue, food and invites', startTime: '2026-09-24T09:00' }),
  task('t-flyers', 'Print flyers', { projectId: 'p-launch', status: 'waiting' }),
  task('t-list', 'Pack for the trip', { taskMode: 'list', checklist: [{ id: 'c1', title: 'Passport', isCompleted: false }] }),
  task('t-stale', 'Fix bike', { updatedAt: at('08-01') }),
  task('t-stale-2', 'Hear back from vendor', { status: 'waiting', updatedAt: at('08-20') }),
  task('i-idea', 'Birthday gift for Sam', { status: 'inbox', contexts: ['@home'] }),
  task('i-note', 'Look into solar panels', { status: 'inbox' }),
];
const PROJECTS: Project[] = [
  { id: 'p-launch', title: 'Launch', status: 'active', color: '#2563eb', order: 0, tagIds: [], createdAt: at('09-01'), updatedAt: at('09-20') },
  { id: 'p-stale', title: 'Old project', status: 'active', color: '#94a3b8', order: 1, tagIds: [], createdAt: at('07-01'), updatedAt: at('07-01') },
];

const SETTINGS: Record<string, AppSettings> = {
  off: {},
  openai: { ai: { enabled: true, provider: 'openai', model: 'gpt-5.6', requestTimeoutSeconds: 60 } },
  custom: {
    ai: {
      enabled: true, provider: 'openai', baseUrl: 'http://10.0.0.5:11434/v1', model: 'qwen3:8b', copilotModel: 'qwen3:1.7b',
      openAIExtraBodyParams: { thinking: { type: 'disabled' } },
    },
  },
  gemini: { ai: { enabled: true, provider: 'gemini', thinkingBudget: 256 } },
  anthropic: { ai: { enabled: true, provider: 'anthropic', thinkingBudget: 2048 } },
  noEstimates: { ai: { enabled: true, provider: 'openai' }, features: { timeEstimates: false } },
};

const KEYS = { 'mindwtr-ai-key_openai': 'sk-open-111', 'mindwtr-ai-key_anthropic': 'sk-ant-222' };

type Device = { language?: Language; secrets?: Record<string, string>; queues?: Record<string, unknown[]> };


type Scenario = {
  name: string;
  screen: 'editor' | 'inbox' | 'review';
  settings: string;
  taskId?: string;
  device: Device;
  actions: [string, ...unknown[]][];
};

const clarifyAnswer = {
  value: {
    question: 'What is the very next step?',
    options: [
      { label: 'Call', action: 'Call the dentist to book a cleaning' },
      { label: 'Online', action: 'Book a cleaning on the dentist website' },
      { label: 'Ask', action: 'Ask Sam for a dentist recommendation' },
      { label: 'Wait', action: 'Wait until next month' },
    ],
    suggestedAction: { title: 'Call the dentist on Monday', context: '@calls', timeEstimate: '15min' },
  },
};

const scenarios: Scenario[] = [
  {
    name: 'editor: copilot suggestions, one part and then all',
    screen: 'editor', settings: 'openai', taskId: 't-dentist',
    device: {
      secrets: KEYS,
      queues: {
        predictMetadata: [
          { value: { context: '@calls', timeEstimate: '30min', tags: ['#health', '#errand'] } },
          { value: {} },
          { error: 'HTTP 500' },
        ],
      },
    },
    actions: [
      ['wait'], ['chip', '@calls'], ['applyAll'],
      ['description', 'Ask about the cleaning'], ['wait'],
      ['title', 'Bo'], ['wait'],
      ['title', 'Book the dentist again'], ['wait'],
      ['hide'],
    ],
  },
  {
    name: 'editor: copilot with time estimates off',
    screen: 'editor', settings: 'noEstimates', taskId: 't-call',
    device: { secrets: KEYS, queues: { predictMetadata: [{ value: { timeEstimate: '5min' } }, { value: { context: '@phone', timeEstimate: '5min' } }] } },
    actions: [['wait'], ['title', 'Call the bank today'], ['wait'], ['applyAll']],
  },
  {
    name: 'editor: a provider that needs a key it lacks asks nothing',
    screen: 'editor', settings: 'gemini', taskId: 't-dentist', device: { secrets: KEYS },
    actions: [['wait'], ['clarify'], ['breakdown']],
  },
  {
    name: 'editor: a custom endpoint needs no key',
    screen: 'editor', settings: 'custom', taskId: 't-dentist',
    device: { queues: { predictMetadata: [{ value: { tags: ['#health'] } }], clarifyTask: [clarifyAnswer] } },
    actions: [['wait'], ['clarify'], ['modal', 'k:common.cancel']],
  },
  {
    name: 'editor: AI off',
    screen: 'editor', settings: 'off', taskId: 't-dentist', device: { secrets: KEYS },
    actions: [['wait'], ['clarify'], ['breakdown']],
  },
  {
    name: 'editor: Clarify offers three options and the suggestion',
    screen: 'editor', settings: 'openai', taskId: 't-dentist',
    device: {
      secrets: KEYS,
      queues: {
        predictMetadata: [{ value: {} }, { value: {} }, { value: {} }],
        clarifyTask: [clarifyAnswer, clarifyAnswer, { value: { question: '', options: [] } }, { error: 'OpenAI API error: 401 Incorrect API key provided: sk-open-111' }],
      },
    },
    actions: [
      ['clarify'], ['modal', 'Online'],
      ['clarify'], ['modal', 'k:ai.applySuggestion'],
      ['clarify'], ['modal', 'k:common.cancel'],
      ['clarify'],
    ],
  },
  {
    name: 'editor: Clarify in a project sends the project context',
    screen: 'editor', settings: 'anthropic', taskId: 't-launch',
    device: { language: 'de', secrets: KEYS, queues: { predictMetadata: [{ value: {} }], clarifyTask: [clarifyAnswer] } },
    actions: [['clarify'], ['modal', 'k:ai.applySuggestion']],
  },
  {
    name: 'editor: Break down adds at most eight steps',
    screen: 'editor', settings: 'openai', taskId: 't-list',
    device: {
      secrets: KEYS,
      queues: {
        predictMetadata: [{ value: {} }, { value: {} }],
        breakDownTask: [
          { value: { steps: ['  Buy adapter ', '', 'Charge phone', 'Print tickets', 'Pack shoes', 'Pack shirts', '   ', 'Water plants', 'Lock windows', 'Take out trash', 'Call mum'] } },
          { value: { steps: ['   '] } },
          { value: { steps: ['Book taxi'] } },
          { error: 'timeout' },
        ],
      },
    },
    actions: [
      ['breakdown'], ['modal', 'k:ai.addSteps'],
      ['breakdown'],
      ['breakdown'], ['modal', 'k:common.cancel'],
      ['breakdown'],
    ],
  },
  {
    name: 'editor: Break down in a project with notes',
    screen: 'editor', settings: 'openai', taskId: 't-launch',
    device: { secrets: KEYS, queues: { predictMetadata: [{ value: {} }], breakDownTask: [{ value: { steps: ['Pick a venue', 'Order food'] } }] } },
    actions: [['breakdown'], ['modal', 'k:ai.addSteps']],
  },
  {
    name: 'inbox: Clarify, then an option and the suggestion',
    screen: 'inbox', settings: 'openai',
    device: { secrets: KEYS, queues: { clarifyTask: [clarifyAnswer, clarifyAnswer, { error: 'Network request failed' }] } },
    actions: [
      ['clarify'], ['modal', 'Ask'],
      ['title', 'Gift for Sam'], ['clarify'], ['modal', 'k:ai.applySuggestion'],
      ['clarify'],
    ],
  },
  {
    name: 'inbox: a missing key opens a toast',
    screen: 'inbox', settings: 'gemini', device: {},
    actions: [['clarify']],
  },
  {
    name: 'review: analysis, choices and apply',
    screen: 'review', settings: 'openai',
    device: {
      secrets: KEYS,
      queues: {
        analyzeReview: [{
          value: {
            suggestions: [
              { id: 't-stale', action: 'someday', reason: 'Untouched for weeks' },
              { id: 't-stale-2', action: 'archive', reason: 'Vendor went quiet' },
              { id: 'project:p-stale', action: 'archive', reason: 'Old project' },
              { id: 't-dentist', action: 'someday', reason: 'Not a stale item' },
              { id: 'unknown', action: 'keep', reason: 'Not offered' },
            ],
          },
        }, { error: 'Anthropic API error: 529 overloaded' }],
      },
    },
    actions: [['run'], ['toggle', 't-stale-2'], ['toggle', 't-stale-2'], ['toggle', 't-stale-2'], ['apply'], ['run']],
  },
  {
    name: 'review: a missing key',
    screen: 'review', settings: 'gemini', device: {},
    actions: [['run']],
  },
];


const writeLog: unknown[][] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

let realActions: Record<string, (...args: any[]) => Promise<any>> | null = null;

async function seedStore(scenario: Scenario) {
  await flushPendingSave();
  resetForTests();
  const state = useTaskStore.getState() as unknown as Record<string, (...args: any[]) => Promise<any>>;
  realActions ??= { updateTask: state.updateTask, batchUpdateTasks: state.batchUpdateTasks, updateSettings: state.updateSettings };
  const data = JSON.parse(JSON.stringify({ tasks: TASKS, projects: PROJECTS, sections: [], areas: [], people: [], settings: SETTINGS[scenario.settings] }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    ...realActions,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  const recorded = Object.fromEntries(Object.entries(realActions).map(([name, real]) => [name, async (...args: unknown[]) => {
    writeLog.push([name, ...(normalize(args) as unknown[])]);
    return real(...args);
  }]));
  useTaskStore.setState(recorded as never);
}

function setDevice(device: Device) {
  harness.language = device.language ?? 'en';
  harness.secrets = new Map(Object.entries(device.secrets ?? {}));
  harness.storage = new Map();
  harness.queues = JSON.parse(JSON.stringify(device.queues ?? {}));
  harness.calls.length = 0;
  harness.alerts.length = 0;
  harness.toasts.length = 0;
  harness.routes.length = 0;
  writeLog.length = 0;
}


type Modal = { title: string; message?: string; actions: AIResponseAction[] } | null;
const readModal = (modal: Modal) => (modal
  ? { title: modal.title, message: modal.message ?? null, actions: modal.actions.map((entry) => [entry.label, entry.variant ?? null]) }
  : null);

type EditorApi = {
  observe(): unknown;
  title(text: string): void;
  description(text: string): void;
  chip(value: string): void;
  applyAll(): void;
  clarify(): Promise<void>;
  breakdown(): Promise<void>;
  modal(label: string): void;
  hide(): void;
};

function EditorHost({ source, api }: { source: Task; api: { current: EditorApi | null } }) {
  const state = useTaskStore.getState();
  const settings = state.settings;
  const tasks = state.tasks;
  const [visible, setVisible] = React.useState(true);
  const [draft, setDraft] = React.useState<TaskDraft>(() => createTaskDraft(source));
  const [checklist, setChecklist] = React.useState(source.checklist ?? []);
  const [titleDraft, setTitleDraft] = React.useState(source.title);
  const [descriptionDraft, setDescriptionDraft] = React.useState(source.description ?? '');
  const titleDraftRef = React.useRef(source.title);
  const [aiModal, setAiModal] = React.useState<Modal>(null);
  const [isAIWorking, setIsAIWorking] = React.useState(false);
  const setDraftField = React.useCallback<TaskDraftSetter>((field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }, []);
  const setTitleImmediate = React.useCallback((text: string) => {
    titleDraftRef.current = text;
    setTitleDraft(text);
    setDraft((prev) => ({ ...prev, title: text }));
  }, []);
  const derived = state.getDerivedState();
  const aiEnabled = settings.ai?.enabled === true;
  const draftContexts = draft.contexts.split(',').map((entry) => entry.trim()).filter(Boolean);
  const draftTags = draft.tags.split(',').map((entry) => entry.trim()).filter(Boolean);
  const contextOptions = Array.from(new Set([...derived.allContexts, ...draftContexts])).filter(Boolean);
  const tagOptions = Array.from(new Set([...derived.allTags, ...draftTags])).filter(Boolean);
  const taskEditDraft = { draft, checklist, attachments: source.attachments ?? [] } as never;
  const mergedTask = { ...source, ...(taskDraftToUpdatePatch(draft, source, { attachments: source.attachments ?? [] }) ?? {}), checklist };
  const { projectContext } = useTaskEditPreview({
    editedProjectId: draft.projectId,
    includeProjectContext: aiEnabled,
    onClose: () => undefined,
    projectId: source.projectId,
    projects: state.projects,
    task: source,
    tasks,
  });
  const copilot = useTaskEditCopilot({
    settings,
    language: harness.language as Language,
    aiEnabled,
    aiProvider: settings.ai?.provider ?? 'openai',
    timeEstimatesEnabled: settings.features?.timeEstimates !== false,
    titleDraft,
    descriptionDraft,
    contextOptions,
    tagOptions,
    draft,
    visible,
    setDraftField,
  });
  const noop = async () => ({ success: true });
  const actions = useTaskEditActions({
    aiEnabled,
    language: harness.language as Language,
    closeAIModal: () => setAiModal(null),
    deleteTask: noop,
    descriptionDraft,
    draftLifecycle: {} as never,
    duplicateTask: noop,
    mergedTask,
    taskEditDraft,
    formatDate: (value) => String(value ?? ''),
    formatDueDate: (value) => String(value ?? ''),
    formatTimeEstimateLabel: (estimate) => estimate,
    isAIWorking,
    onClose: () => undefined,
    prioritiesEnabled: false,
    projectContext,
    resetTaskChecklist: noop,
    skipRecurringTaskOccurrence: noop,
    restoreTask: noop,
    setAiModal: setAiModal as never,
    setChecklist: setChecklist as never,
    setDraftField,
    setIsAIWorking,
    setTitleImmediate,
    settings,
    showToast: (toast) => { harness.toasts.push([toast.tone, toast.title, toast.message, toast.actionLabel ?? null, toast.durationMs ?? null]); },
    t: translate,
    task: source,
    tasks,
    timeEstimatesEnabled: settings.features?.timeEstimates !== false,
    titleDraftRef,
  });
  api.current = {
    observe: () => ({
      modal: readModal(aiModal),
      working: isAIWorking,
      parts: copilot.pendingCopilotParts,
      applied: { context: copilot.copilotContext ?? null, estimate: copilot.copilotEstimate ?? null, tags: copilot.copilotTags },
      draft: { title: draft.title, contexts: draft.contexts, tags: draft.tags, timeEstimate: draft.timeEstimate, status: draft.status },
      checklist: checklist.map((item) => [item.title, item.isCompleted]),
    }),
    title: (text) => { titleDraftRef.current = text; setTitleDraft(text); setDraft((prev) => ({ ...prev, title: text })); },
    description: (text) => { setDescriptionDraft(text); setDraft((prev) => ({ ...prev, description: text })); },
    chip: (value) => {
      const part = copilot.pendingCopilotParts.find((entry) => entry.value === value);
      if (!part) throw new Error(`No chip ${value}`);
      copilot.applyCopilotPart(part);
    },
    applyAll: () => copilot.applyCopilotSuggestion(),
    clarify: () => actions.handleAIClarify(),
    breakdown: () => actions.handleAIBreakdown(),
    modal: (label) => pressModal(aiModal, label),
    hide: () => setVisible(false),
  };
  return null;
}

function pressModal(modal: Modal, label: string) {
  const entry = modal?.actions.find((action) => action.label === label);
  if (!entry) throw new Error(`No dialog button ${label}`);
  entry.onPress();
}

type InboxApi = { observe(): unknown; clarify(): Promise<void>; modal(label: string): void; title(text: string): void };

function InboxHost({ api }: { api: { current: InboxApi | null } }) {
  const controller = useInboxProcessingController({ visible: true, onClose: () => undefined });
  api.current = {
    observe: () => ({
      taskId: controller.currentTask?.id ?? null,
      modal: readModal(controller.aiModal),
      working: controller.isAIWorking,
      title: controller.processingTitle,
      contexts: controller.selectedContexts,
    }),
    clarify: () => controller.handleAIClarifyInbox(),
    modal: (label) => pressModal(controller.aiModal, label),
    title: (text) => controller.setProcessingTitle(text),
  };
  return null;
}

type ReviewApi = { observe(): unknown; run(): Promise<void>; toggle(id: string): void; apply(): Promise<void> };

function ReviewHost({ api }: { api: { current: ReviewApi | null } }) {
  const controller = useReviewModalController({ visible: true, onClose: () => undefined });
  api.current = {
    observe: () => ({
      error: controller.aiError,
      loading: controller.aiLoading,
      ran: controller.aiRan,
      suggestions: controller.aiSuggestions.map((entry) => [entry.id, entry.action, entry.reason, entry.title]),
      selected: Array.from(controller.aiSelectedIds),
    }),
    run: () => controller.runAiAnalysis(),
    toggle: (id) => controller.toggleSuggestion(id),
    apply: () => controller.applyAiSuggestions(),
  };
  return null;
}


const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await flushPendingSave();
  });
};

const labelText = (label: string) => (label.startsWith('k:') ? translate(label.slice(2)) : label);

async function runScenario(scenario: Scenario) {
  await seedStore(scenario);
  setDevice(scenario.device);
  harness.strings = await loadTranslations(harness.language as Language);
  const api: { current: any } = { current: null };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(scenario.screen === 'editor'
      ? <EditorHost source={useTaskStore.getState()._tasksById.get(scenario.taskId!)!} api={api} />
      : scenario.screen === 'inbox' ? <InboxHost api={api} /> : <ReviewHost api={api} />);
  });
  await settle();
  const seen = { calls: 0, alerts: 0, toasts: 0, writes: 0, routes: 0 };
  const observe = () => {
    const out = normalize({
      ...api.current.observe(),
      calls: harness.calls.slice(seen.calls),
      alerts: harness.alerts.slice(seen.alerts),
      toasts: harness.toasts.slice(seen.toasts),
      writes: writeLog.slice(seen.writes),
      routes: harness.routes.slice(seen.routes),
    });
    Object.assign(seen, { calls: harness.calls.length, alerts: harness.alerts.length, toasts: harness.toasts.length, writes: writeLog.length, routes: harness.routes.length });
    return out;
  };
  const observations = [observe()];
  for (const [kind, target] of scenario.actions) {
    await act(async () => {
      switch (kind) {
        case 'wait':
          await vi.advanceTimersByTimeAsync(1000);
          return;
        case 'modal':
          api.current.modal(labelText(target as string));
          return;
        case 'title':
        case 'description':
        case 'chip':
        case 'toggle':
          api.current[kind](target);
          return;
        default:
          await api.current[kind]();
      }
    });
    await settle();
    observations.push(observe());
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

const inputs = () => normalize({ now: NOW, tasks: TASKS, projects: PROJECTS, settings: SETTINGS, scenarios }) as Record<string, unknown>;

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', '../../../apps').split('\n').filter(Boolean)
    .map((line) => line.slice(3))
    .filter((path) => path !== 'apps/mobile/components/ai-actions.parity.test.tsx'
      && path !== 'apps/mobile/components/settings/ai-settings-screen.parity.test.tsx');
  if (changed.length > 0) throw new Error(`Capture needs HEAD's apps/ code; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_AI_ACTIONS=1 TZ=UTC bunx vitest run components/ai-actions.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ was at HEAD except the parity harnesses. No React Native code imported core\'s AI request rules yet.',
    device: 'The device is stubbed: Android; the AI provider answers each method from the scenario\'s queue (none queued: it fails); the secure store holds the scenario\'s keys and AsyncStorage starts empty; the editor host holds the draft, checklist and dialog as the task editor does; Process Inbox and the Weekly Review run their real controllers over the real core store.',
  };
}

describe('React Native AI actions parity fixture', () => {
  const originalOs = Platform.OS;
  const originalAlert = Alert.alert;
  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (Platform as { OS: string }).OS = 'android';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(NOW));
    Alert.alert = ((title: string, message?: string) => { harness.alerts.push([title, message ?? null]); }) as typeof Alert.alert;
  });
  afterAll(() => {
    (Platform as { OS: string }).OS = originalOs;
    Alert.alert = originalAlert;
    vi.useRealTimers();
    resetForTests();
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    if (process.env.MINDWTR_DUMP_AI_ACTIONS) writeFileSync(process.env.MINDWTR_DUMP_AI_ACTIONS, JSON.stringify(captured));
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs(), observations: captured }, null, 1)}\n`);
    }
    const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs());
    for (const name of Object.keys(captured)) {
      expect({ [name]: captured[name] }).toEqual({ [name]: observations[name] });
    }
    expect(Object.keys(observations)).toEqual(Object.keys(captured));
  }, 300_000);

  it('shows the Weekly Review\'s AI errors in the app language', async () => {
    const [, missingKey] = await runScenario({ name: 'missing key', screen: 'review', settings: 'gemini', device: {}, actions: [['run']] }) as { error: string }[];
    expect(missingKey.error).toBe('Add your API key in Settings → AI assistant.');
    const [, empty] = await runScenario({
      name: 'blank failure', screen: 'review', settings: 'openai', device: { secrets: KEYS, queues: { analyzeReview: [{ error: '' }] } }, actions: [['run']],
    }) as { error: string }[];
    expect(empty.error).toBe('Please try again.');
  });

  it('answers an unreadable keystore with the AI error, never an unhandled failure', async () => {
    harness.secretsFail = true;
    try {
      const [, inbox] = await runScenario({ name: 'inbox', screen: 'inbox', settings: 'openai', device: {}, actions: [['clarify']] }) as { alerts: unknown[][]; working: boolean }[];
      expect(inbox.alerts).toEqual([['AI request failed', 'Please try again.\n\nKeystore unavailable']]);
      expect(inbox.working).toBe(false);
      const [, review] = await runScenario({ name: 'review', screen: 'review', settings: 'openai', device: {}, actions: [['run']] }) as { error: string; loading: boolean }[];
      expect(review).toMatchObject({ error: 'Keystore unavailable', loading: false });
    } finally {
      harness.secretsFail = false;
    }
  });

  it('never shows or logs the API key when a provider echoes it', async () => {
    const echo = (key: string) => ({ error: `Provider error: 401 Incorrect API key provided: ${key}` });
    const secrets = { 'mindwtr-ai-key_openai': 'local-secret-42' };
    harness.logs.length = 0;
    const shown = [
      ...await runScenario({
        name: 'editor', screen: 'editor', settings: 'openai', taskId: 't-dentist',
        device: { secrets, queues: { predictMetadata: [{ value: {} }], clarifyTask: [echo('local-secret-42')], breakDownTask: [echo('local-secret-42')] } },
        actions: [['clarify'], ['breakdown']],
      }),
      ...await runScenario({ name: 'inbox', screen: 'inbox', settings: 'openai', device: { secrets, queues: { clarifyTask: [echo('local-secret-42')] } }, actions: [['clarify']] }),
      ...await runScenario({ name: 'review', screen: 'review', settings: 'openai', device: { secrets, queues: { analyzeReview: [echo('local-secret-42')] } }, actions: [['run']] }),
    ].map((observation) => {
      const { alerts, error } = observation as { alerts: unknown[]; error?: string };
      return [alerts, error ?? null];
    });
    const text = JSON.stringify([shown, harness.logs]);

    expect(text.match(/Incorrect API key provided/g)?.length).toBeGreaterThanOrEqual(4);
    expect(text).not.toContain('local-secret-42');
  });
});
