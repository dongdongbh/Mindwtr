/**
 * React Native's notification open routing, replayed against the frozen parity
 * fixture (packages/core/src/notification-open-parity.fixtures.json) that core's
 * mobile-notification-open routing is tested against.
 *
 * The fixture's `provenance` names the commit it was captured at. To recapture,
 * commit every other change first, then run
 *   MINDWTR_CAPTURE_REMINDER_ALARMS=1 MINDWTR_CAPTURE_REMINDER_ALARMS_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run tests/use-root-layout-notification-open-handler.parity.test.tsx
 * The capture refuses to run unless that commit is HEAD and the checkout holds
 * nothing but HEAD's code and the reminder parity harnesses. Each scenario mounts
 * the real root-layout hook, sends its payloads to the handler it registers, and
 * records every navigation, highlight, store write and log line in order.
 */
import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { useRootLayoutNotificationOpenHandler } from '@/hooks/root-layout/use-root-layout-notification-open-handler';

const FIXTURE_PATH = new URL('../../../packages/core/src/notification-open-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_REMINDER_ALARMS === '1';

type Payload = Record<string, unknown>;
type Scenario = { name: string; tasks: Record<string, unknown>[]; payloads: Payload[] };

const harness = vi.hoisted(() => ({
  log: [] as unknown[][],
  tasksById: new Map<string, unknown>(),
  handler: null as ((payload: unknown) => void) | null,
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  return mockCore(importOriginal, () => ({
    _tasksById: harness.tasksById,
    tasks: Array.from(harness.tasksById.values()),
    setHighlightTask: (taskId: string) => harness.log.push(['setHighlightTask', taskId]),
    updateTask: async (taskId: string, updates: unknown) => {
      harness.log.push(['updateTask', taskId, updates]);
    },
  }));
});

vi.mock('@/lib/notification-service', () => ({
  setNotificationOpenHandler: (handler: ((payload: unknown) => void) | null) => {
    harness.handler = handler;
  },
}));

vi.mock('@/modules/notification-open-intents', () => ({
  consumePendingNotificationOpenPayload: async () => null,
  peekPendingNotificationCompletions: async () => [],
}));

vi.mock('@/lib/app-log', () => ({
  logInfo: async (message: string, context?: { extra?: unknown }) => {
    harness.log.push(['logInfo', message, context?.extra ?? null]);
  },
}));

const NOW = '2026-09-28T10:00:00.000Z';
const CREATED = '2026-09-01T00:00:00.000Z';
const task = (id: string, fields: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, status: 'next', tags: [], contexts: [], createdAt: CREATED, updatedAt: CREATED, ...fields,
});
const TASKS = [
  task('t-next'),
  task('t-inbox', { status: 'inbox' }),
  task('t-done', { status: 'done' }),
  task('t-archived', { status: 'archived' }),
  task('t-reference', { status: 'reference' }),
  task('t-deleted', { deletedAt: CREATED }),
];

export const scenarios: Scenario[] = [
  {
    name: 'dismiss and snooze open nothing',
    tasks: TASKS,
    payloads: [
      { actionIdentifier: 'dismiss', taskId: 't-next', notificationId: 'n-1' },
      { actionIdentifier: 'DISMISS_ACTION', taskId: 't-next' },
      { actionIdentifier: 'snooze', taskId: 't-next', notificationId: 'n-2' },
      { actionIdentifier: ' Snooze_Action ', kind: 'weekly-review' },
      { actionIdentifier: 'snooze_action', kind: 'daily-digest', notificationId: 'digest:morning' },
    ],
  },
  {
    name: 'Done completes an actionable task once per notification',
    tasks: TASKS,
    payloads: [
      { actionIdentifier: 'complete', taskId: 't-next', notificationId: 'task:t-next' },
      { actionIdentifier: 'complete', taskId: 't-next', notificationId: 'task:t-next' },
      { actionIdentifier: 'COMPLETE_ACTION', taskId: 't-next', notificationId: ' task:t-next ' },
      { actionIdentifier: 'complete_action', taskId: 't-inbox', notificationId: 'task:t-inbox:r2' },
      { actionIdentifier: 'complete', taskId: 't-inbox' },
      { actionIdentifier: 'complete', taskId: 't-inbox' },
    ],
  },
  {
    name: 'Done on a missing, deleted or finished task changes nothing',
    tasks: TASKS,
    payloads: [
      { actionIdentifier: 'complete', taskId: 't-missing', notificationId: 'task:t-missing' },
      { actionIdentifier: 'complete', taskId: 't-deleted', notificationId: 'task:t-deleted' },
      { actionIdentifier: 'complete', taskId: 't-done', notificationId: 'task:t-done' },
      { actionIdentifier: 'complete', taskId: 't-archived', notificationId: 'task:t-archived' },
      { actionIdentifier: 'complete', taskId: 't-reference', notificationId: 'task:t-reference' },
      { actionIdentifier: 'complete', notificationId: 'digest:weekly-review' },
      { actionIdentifier: 'complete', projectId: 'p-1', notificationId: 'project:p-1' },
    ],
  },
  {
    name: 'review reminders open Review before any task or project',
    tasks: TASKS,
    payloads: [
      { kind: 'task-review', taskId: 't-next', notificationId: 'task:t-next' },
      { kind: 'project-review', projectId: 'p-1', notificationId: 'project:p-1' },
      { kind: 'task-review', taskId: 't-next', projectId: 'p-1', notificationId: '  ' },
      { kind: 'project-review' },
      { kind: 'task-review', actionIdentifier: 'open', taskId: 't-missing', notificationId: 'review-1' },
    ],
  },
  {
    name: 'task, project and context opens',
    tasks: TASKS,
    payloads: [
      { taskId: 't-next', notificationId: 'task:t-next' },
      { taskId: 't-next', notificationId: 'task:t-next' },
      { taskId: 't-done', actionIdentifier: 'open' },
      { taskId: 't-next', projectId: 'p-1', kind: 'task-reminder', notificationId: ' task:t-next:r1 ' },
      { projectId: 'p-1', notificationId: 'project:p-1' },
      { kind: 'context-automation', context: '@home', notificationId: 'ctx-1' },
      { kind: 'context-automation', notificationId: 'ctx-2' },
      { kind: 'pomodoro', taskId: 't-next' },
    ],
  },
  {
    name: 'daily and weekly review opens, by kind or by alarm key',
    tasks: TASKS,
    payloads: [
      { kind: 'daily-digest', notificationId: 'daily-1' },
      { kind: 'daily-digest' },
      { notificationId: 'digest:morning' },
      { notificationId: 'digest:evening' },
      { kind: 'weekly-review', notificationId: 'weekly-1' },
      { notificationId: ' digest:weekly-review ' },
      { kind: 'weekly-review', actionIdentifier: 'OPEN' },
    ],
  },
  {
    name: 'payloads that open nothing, and values that are not text',
    tasks: TASKS,
    payloads: [
      {},
      { notificationId: 'something-else' },
      { kind: 'pomodoro', notificationId: 'pomodoro-1' },
      { taskId: 42, projectId: false, kind: 7, notificationId: 9, actionIdentifier: 3 },
      { kind: 'daily-digest', notificationId: 12 },
    ],
  },
];

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

function Harness({ router }: { router: { push: (...args: unknown[]) => void } }) {
  useRootLayoutNotificationOpenHandler({ appReady: true, pathname: '/inbox', router });
  return null;
}

async function runScenario(scenario: Scenario) {
  harness.tasksById.clear();
  for (const item of scenario.tasks) harness.tasksById.set(item.id as string, item);
  harness.log.length = 0;
  harness.handler = null;
  const router = { push: (...args: unknown[]) => harness.log.push(['push', ...args]) };
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<Harness router={router} />);
  });
  const handler = harness.handler as ((payload: unknown) => void) | null;
  if (!handler) throw new Error('The hook registered no handler');
  harness.log.length = 0;
  const observations: unknown[] = [];
  for (const payload of scenario.payloads) {
    await act(async () => {
      handler(payload);
    });
    observations.push(normalize([...harness.log]));
    harness.log.length = 0;
  }
  act(() => tree.unmount());
  return observations;
}

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_REMINDER_ALARMS_COMMIT;
  if (declared !== head) throw new Error(`Recapture needs MINDWTR_CAPTURE_REMINDER_ALARMS_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  const allowed = new Set([
    'apps/mobile/lib/notification-service-local.parity.test.ts',
    'apps/mobile/tests/use-root-layout-notification-open-handler.parity.test.tsx',
    'packages/core/src/reminder-alarms-parity.fixtures.json',
    'packages/core/src/notification-open-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '')).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_REMINDER_ALARMS=1 MINDWTR_CAPTURE_REMINDER_ALARMS_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run tests/use-root-layout-notification-open-handler.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ and packages/ was at HEAD except the reminder alarm and notification open parity harnesses and their fixtures.',
    rendering: 'hooks/root-layout/use-root-layout-notification-open-handler.ts mounted with react-test-renderer (appReady, pathname /inbox) under a fake Date. The store (tasks by ID, setHighlightTask, updateTask), the handler registration, the cold-start payload (none) and the log are replaced. Each observation lists, in order, what one payload made the hook do: router pushes, highlights, store writes and log lines.',
  };
}

describe('React Native notification open parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });
  afterAll(() => {
    vi.useRealTimers();
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
  }, 60_000);
});
