


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, loadTranslations, resetForTests, setStorageAdapter, useTaskStore } from '@mindwtr/core';

import { MindSweepModalContent } from './mind-sweep-modal-content';

const FIXTURE_PATH = new URL('../../../packages/core/src/mind-sweep-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_MIND_SWEEP === '1';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  closes: 0,
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => harness.strings[key] ?? key, language: 'en' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', inputBg: '#fff', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/hooks/use-filled-button-colors', () => ({ useFilledButtonColors: () => ({ backgroundColor: '#filled', textColor: undefined }) }));

export const NOW = '2026-09-27T14:00:00.000Z';
const TINT = '#3b82f6';

type Action =
  | ['scope', 'all' | 'personal' | 'work']
  | ['start' | 'add' | 'submit' | 'back' | 'next' | 'finish' | 'close']
  | ['type', string]
  | ['failAdd', 'refuse' | 'throw'];
type Scenario = { name: string; actions: Action[] };

const next = (count: number): Action[] => Array.from({ length: count }, () => ['next'] as Action);

export const scenarios: Scenario[] = [
  { name: 'the intro', actions: [['scope', 'work'], ['scope', 'personal'], ['scope', 'all'], ['close']] },
  {
    name: 'a personal sweep with captures',
    actions: [
      ['scope', 'personal'],
      ['start'],
      ['type', '  Fix the sink  '],
      ['add'],
      ['type', 'Call mom'],
      ['submit'],
      ['next'],
      ['type', 'Book dentist'],
      ['add'],
      ['back'],
      ...next(5),
      ['finish'],
    ],
  },
  {
    name: 'a work sweep with nothing captured',
    actions: [['scope', 'work'], ['start'], ['type', '   '], ['add'], ['submit'], ...next(4), ['close']],
  },
  { name: 'every group of a full sweep', actions: [['start'], ...next(9)] },
  {
    name: 'a refused or failed capture keeps the draft',
    actions: [
      ['start'],
      ['type', 'Buy milk'],
      ['failAdd', 'refuse'],
      ['add'],
      ['failAdd', 'throw'],
      ['submit'],
      ['add'],
      ['type', 'Buy milk'],
      ['add'],
      ['next'],
      ['back'],
      ...next(9),
    ],
  },
];

const writeLog: unknown[][] = [];
let failure: 'refuse' | 'throw' | null = null;
let realAddTask: ((...args: any[]) => Promise<unknown>) | null = null;
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

async function seedStore() {
  await flushPendingSave();
  resetForTests();
  realAddTask ??= useTaskStore.getState().addTask as unknown as (...args: any[]) => Promise<unknown>;
  const real = realAddTask;
  const data = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
  setStorageAdapter({ getData: async () => JSON.parse(JSON.stringify(data)), saveData: async () => undefined });
  useTaskStore.setState({
    addTask: real,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  useTaskStore.setState({
    addTask: async (...args: unknown[]) => {
      writeLog.push(['addTask', ...(normalize(args.slice(0, 2)) as unknown[])]);
      const mode = failure;
      failure = null;
      if (mode === 'refuse') return { success: false, error: 'disk full' };
      if (mode === 'throw') throw new Error('disk unavailable');
      return real(...args);
    },
  } as never);
}

const textOf = (node: ReactTestInstance): string => {
  const children = node.props?.children;
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  return list.filter((child) => typeof child === 'string' || typeof child === 'number').map(String).join('');
};
const flatten = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style && typeof style === 'object' ? style as Record<string, unknown> : {}
);
const hostsOf = (root: ReactTestInstance, type: string) => root.findAll((node) => String(node.type) === type);
const byTestId = (root: ReactTestInstance, testID: string) => root.findAll((node) => (
  String(node.type) === 'TouchableOpacity' && node.props.testID === testID
))[0];

function observe(root: ReactTestInstance, seen: { writes: number; closes: number }) {
  const input = hostsOf(root, 'TextInput')[0];
  const observation = {
    texts: hostsOf(root, 'Text').map(textOf),
    buttons: hostsOf(root, 'TouchableOpacity').map((node) => [
      node.props.testID ?? null,
      node.props.accessibilityLabel ?? null,
      hostsOf(node, 'Text').map(textOf).join(''),
      node.props.disabled === true,
      flatten(node.props.style).backgroundColor === TINT,
    ]),
    input: input ? [input.props.value, input.props.placeholder] : null,
    writes: writeLog.slice(seen.writes),
    closes: harness.closes - seen.closes,
  };
  seen.writes = writeLog.length;
  seen.closes = harness.closes;
  return observation;
}

const TEST_IDS: Record<string, string> = {
  start: 'mind-sweep-start', add: 'mind-sweep-add', back: 'mind-sweep-back', next: 'mind-sweep-next',
  finish: 'mind-sweep-finish', close: 'mind-sweep-close',
};

async function perform(root: ReactTestInstance, action: Action) {
  const [kind] = action;
  if (kind === 'failAdd') {
    failure = action[1];
    return;
  }
  if (kind === 'type') {
    await act(async () => { hostsOf(root, 'TextInput')[0].props.onChangeText(action[1]); });
    return;
  }
  if (kind === 'submit') {
    await act(async () => { await hostsOf(root, 'TextInput')[0].props.onSubmitEditing(); });
    return;
  }
  const testID = kind === 'scope' ? `mind-sweep-scope-${action[1]}` : TEST_IDS[kind];
  const node = byTestId(root, testID);
  if (!node) throw new Error(`Nothing to press for ${testID}`);

  if (node.props.disabled === true) return;
  await act(async () => { await node.props.onPress(); });
}

async function runScenario(scenario: Scenario) {
  writeLog.length = 0;
  failure = null;
  harness.closes = 0;
  await seedStore();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<MindSweepModalContent onClose={() => { harness.closes += 1; }} />); });
  const seen = { writes: 0, closes: 0 };
  const observations = [observe(renderer.root, seen)];
  for (const action of scenario.actions) {
    await perform(renderer.root, action);
    await act(async () => { await flushPendingSave(); });
    observations.push(observe(renderer.root, seen));
  }
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_MIND_SWEEP_COMMIT;
  if (declared !== head) throw new Error(`Recapture needs MINDWTR_CAPTURE_MIND_SWEEP_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  const allowed = new Set([
    'apps/mobile/components/mind-sweep-modal-content.parity.test.tsx',
    'apps/mobile/app/(drawer)/saved-search/saved-search.parity.test.tsx',
    'packages/core/src/mind-sweep-parity.fixtures.json',
    'packages/core/src/saved-search-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '')).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_MIND_SWEEP=1 MINDWTR_CAPTURE_MIND_SWEEP_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run components/mind-sweep-modal-content.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ and packages/ was at HEAD except the Mind Sweep and saved search parity harnesses and their fixtures.',
    rendering: 'react-test-renderer over the apps/mobile react-native shim (host elements by name). The filled button color is a marker, so `selected` is true only for a scope chip drawn in the tint. Strings are English. addTask records its title and props; `failAdd` makes the next addTask resolve { success: false } (refuse) or throw.',
  };
}

describe('React Native Mind Sweep parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    harness.strings = await loadTranslations('en');
  }, 30_000);
  afterAll(() => {
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);
    const inputs = normalize({ timeZone: 'UTC', now: NOW, scenarios }) as Record<string, unknown>;
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs, observations: captured }, null, 1)}\n`);
    }
    const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs);
    for (const scenario of scenarios) {
      expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
    }
  }, 120_000);
});
