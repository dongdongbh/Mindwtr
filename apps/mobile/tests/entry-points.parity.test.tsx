


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations, translateWithFallback } from '@mindwtr/core';
import { parseShareIntent } from 'expo-share-intent/build/utils.js';

import { useRootLayoutExternalCapture } from '@/hooks/root-layout/use-root-layout-external-capture';
import { redirectSystemPath } from '@/app/+native-intent';
import {
  isEntityOpenUrl,
  isOpenFeatureUrl,
  isShortcutCaptureUrl,
  normalizeShortcutTags,
  parseEntityOpenUrl,
  parseOpenFeatureUrl,
  parseShortcutCaptureUrl,
  resolveOpenFeaturePath,
} from '@/lib/capture-deeplink';

const FIXTURE_PATH = new URL('../../../packages/core/src/entry-points-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_ENTRY_POINTS === '1';
const NOW = '2026-09-28T09:00:00.000Z';

vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn(async () => null), isLoggingEnabled: () => false }));
vi.mock('@/lib/app-search-service', () => ({ syncAppSearchIndexingWithPreference: vi.fn(async () => undefined) }));
vi.mock('@/lib/attachment-sync', () => ({ persistAttachmentLocallyDetailed: vi.fn() }));
vi.mock('expo-file-system', () => ({ deleteAsync: vi.fn().mockResolvedValue(undefined) }));

vi.mock('expo-linking', () => ({ createURL: () => 'mindwtr://dataUrl=', useLinkingURL: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { scheme: 'mindwtr' } } }));

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, string>,
  highlights: [] as string[],
  tasks: new Map<string, unknown>(),
  projects: new Map<string, unknown>(),
  areas: new Map<string, unknown>(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  return mockCore(importOriginal, () => ({
    _tasksById: harness.tasks,
    _projectsById: harness.projects,
    _areasById: harness.areas,
    setHighlightTask: (id: string) => { harness.highlights.push(id); },
  }));
});


export const STORE = {
  tasks: [{ id: 't-live' }, { id: 't-deleted', deletedAt: '2026-09-01T00:00:00.000Z' }],
  projects: [{ id: 'p-live' }, { id: 'p-deleted', deletedAt: '2026-09-01T00:00:00.000Z' }],
  areas: [{ id: 'a-live' }, { id: 'a-deleted', deletedAt: '2026-09-01T00:00:00.000Z' }],
};


export const URLS = [
  'mindwtr://capture?title=Buy%20groceries&note=From%20store&project=Shopping&tags=errands,%20home',
  'mindwtr:///capture?text=Pay%20bill&description=Utility',
  'mindwtr:///capture?name=Call%20dentist&description=Tomorrow',
  'mindwtr:///capture?thingName=Water%20plants&thingDescription=Balcony',
  'mindwtr:///capture?itemListName=Groceries&itemListElementName=Milk',
  'mindwtr:///capture?itemListName=Groceries',
  'mindwtr://capture?title=%20Task%20&tags=%20alpha%20,%20,%20%23beta%20,Alpha',
  'mindwtr://capture?title=Plan%20trip&project=p-live&body=Book%20flights',
  'mindwtr://capture?title=Plan&project=%20',
  'mindwtr:capture?title=Voice%20note&source=create_note&note=Longer%20spoken%20text',
  'MINDWTR://CAPTURE?title=Upper%20case',
  'mindwtr://capture?title=&note=Only%20a%20note',
  'mindwtr://capture',
  'mindwtr:///capture',
  'mindwtr://capture-quick',
  'mindwtr:///capture-quick?source=control',
  'mindwtr://open-feature?feature=capture',
  'mindwtr:///open-feature?feature=quick_capture',
  'mindwtr:///open-feature?feature=FEATURE_ADD-TASK',
  'mindwtr:///open-feature?feature=new%20task',
  'mindwtr:///open-feature?feature=today',
  'mindwtr:///open-feature?feature=next_actions',
  'mindwtr:///open-feature?feature=Waiting%20For',
  'mindwtr:///open-feature?feature=someday%20maybe',
  'mindwtr:///open-feature?feature=project-list',
  'mindwtr:///open-feature?feature=weekly-review',
  'mindwtr:///open-feature?feature=schedule',
  'mindwtr:///open-feature?feature=inbox',
  'mindwtr:///open-feature?feature=unknown',
  'mindwtr:///open-feature?feature=',
  'mindwtr://open-feature',
  'mindwtr://open?task=t-live',
  'mindwtr:///open?task=t-deleted',
  'mindwtr://open?task=missing',
  'mindwtr://open?project=p-live',
  'mindwtr://open?project=p-deleted',
  'mindwtr://open?area=a-live',
  'mindwtr://open?area=a-deleted',
  'mindwtr://open?task=%20&project=p-live',
  'mindwtr://open',
  'mindwtr://redirect',
  'mindwtr://redirect?code=abc&state=xyz',
  'mindwtr:///redirect/',
  'mindwtr:///focus',
  'mindwtr://inbox',
  'mindwtr:///global-search?q=milk',
  'mindwtr:///calendar',
  'mindwtr://waiting',
  'mindwtr:///review-tab',
  'mindwtr:///board',
  'mindwtr://dataUrl=mindwtrShareKey',
  'https://mindwtr.app/capture?title=Test',
  'other://capture?title=Test',
  'mindwtr-native-dev://capture?title=Other%20scheme',
];

export const FEATURES: (string | null)[] = [
  null, '', 'capture', 'Quick-Capture', 'feature_add_task', 'FEATURE-NEW-TASK', 'focus', 'today', 'next', 'next actions', 'waiting',
  'waiting_for', 'someday', 'maybe', 'Someday Maybe', 'projects', 'project list', 'review', 'daily review', 'weekly_review', 'calendar',
  'schedule', 'inbox', 'settings', '  Focus  ',
];

export const TAG_LISTS: string[][] = [
  [], ['a'], ['a', '#a', 'A'], ['  x  ', '', '#y', 'Y'], ['#', 'two words'],
];


export const SHARES: { text: string | null; title: string | null; subject: string | null }[] = [
  { text: 'The paragraph I selected in another app', title: null, subject: null },
  { text: 'https://example.com/article', title: null, subject: null },
  { text: 'Read this https://example.com/a?b=1 later', title: null, subject: null },
  { text: 'Two links http://one.example.com and https://two.example.org/x', title: null, subject: null },
  { text: '  padded text  ', title: null, subject: null },
  { text: 'Body of the email', title: null, subject: 'Email subject' },
  { text: 'Body with https://example.com/doc', title: null, subject: 'Subject' },
  { text: 'https://example.com/only-link', title: 'Page title', subject: 'Ignored subject' },
  { text: 'text', title: '', subject: 'Subject after empty title' },
  { text: '   ', title: null, subject: null },
  { text: '   ', title: null, subject: 'Subject only' },
  { text: '', title: null, subject: 'Subject without text' },
  { text: null, title: null, subject: 'Subject without text' },
  { text: 'mail me at someone@example.com', title: null, subject: null },
  { text: 'www.example.com without scheme', title: null, subject: null },
  { text: 'Multi\nline\nshare', title: null, subject: null },
];

type RouterCall = ['push' | 'replace', unknown];
type Outcome = { router: RouterCall[]; toasts: unknown[]; highlights: string[] };

function Harness(props: {
  hasShareIntent?: boolean; incomingUrl?: string | null; router: unknown; showToast: (options: unknown) => void;
  shareText?: string | null; shareSubject?: string | null; shareWebUrl?: string | null;
}) {
  useRootLayoutExternalCapture({
    canonicalDataReady: true,
    dataReady: true,
    hasShareIntent: props.hasShareIntent ?? false,
    incomingUrl: props.incomingUrl ?? null,
    incomingUrlKey: props.incomingUrl ? 1 : 0,
    providerReady: true,
    resolveText: (key, fallback) => translateWithFallback((name) => harness.strings[name] ?? name, key, fallback),
    resetShareIntent: () => undefined,
    router: props.router as never,
    shareText: props.shareText,
    shareSubject: props.shareSubject,
    shareWebUrl: props.shareWebUrl,
    showToast: props.showToast as never,
  });
  return null;
}

function run(props: Omit<Parameters<typeof Harness>[0], 'router' | 'showToast'>): Outcome {
  const calls: RouterCall[] = [];
  const toasts: unknown[] = [];
  harness.highlights = [];
  const router = {
    canGoBack: () => false,
    push: (route: unknown) => { calls.push(['push', route]); },
    replace: (route: unknown) => { calls.push(['replace', route]); },
  };
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<Harness {...props} router={router} showToast={(options) => toasts.push(options)} />); });
  act(() => tree.unmount());
  return { router: calls, toasts, highlights: [...harness.highlights] };
}

function captureAll() {
  const urls = URLS.map((url) => ({
    url,
    isShortcutCaptureUrl: isShortcutCaptureUrl(url),
    parseShortcutCaptureUrl: parseShortcutCaptureUrl(url),
    isOpenFeatureUrl: isOpenFeatureUrl(url),
    parseOpenFeatureUrl: parseOpenFeatureUrl(url),
    isEntityOpenUrl: isEntityOpenUrl(url),
    parseEntityOpenUrl: parseEntityOpenUrl(url),
    redirectCold: redirectSystemPath({ path: url, initial: true }),
    redirectWarm: redirectSystemPath({ path: url, initial: false }),
    delivered: run({ incomingUrl: url }),
  }));
  const features = FEATURES.map((feature) => ({ feature, path: resolveOpenFeaturePath(feature) }));
  const tags = TAG_LISTS.map((list) => ({ tags: list, normalized: normalizeShortcutTags(list) }));
  const shares = SHARES.map((share) => {
    const read = parseShareIntent({ text: share.text, type: 'text', meta: { title: share.title ?? share.subject ?? undefined } }, {});
    const hasShareIntent = Boolean(read.text || read.webUrl || read.files);
    return {
      share,
      read: { text: read.text ?? null, webUrl: read.webUrl ?? null, subject: read.meta?.title ?? null, hasShareIntent },
      delivered: run({ hasShareIntent, shareText: read.text, shareSubject: read.meta?.title, shareWebUrl: read.webUrl }),
    };
  });
  return { urls, features, tags, shares };
}

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const declared = process.env.MINDWTR_CAPTURE_ENTRY_POINTS_COMMIT;
  if (declared !== head) throw new Error(`Recapture needs MINDWTR_CAPTURE_ENTRY_POINTS_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
  const allowed = new Set([
    'apps/mobile/tests/entry-points.parity.test.tsx',
    'packages/core/src/entry-points-parity.fixtures.json',
  ]);
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '')).filter((path) => !allowed.has(path));
  if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_ENTRY_POINTS=1 MINDWTR_CAPTURE_ENTRY_POINTS_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run tests/entry-points.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ and packages/ was at HEAD except this entry-points parity harness and its fixture.',
    rendering: 'Platform.OS is android. useRootLayoutExternalCapture runs under react-test-renderer with canonical data ready, one delivery per link or share, and a router that cannot go back; the store holds `store`. resolveText is core\'s translateWithFallback over the English strings. A share is read by expo-share-intent\'s parseShareIntent from the payload its Android module sends for ACTION_SEND text/plain.',
  };
}

describe('React Native entry points parity fixture', () => {
  const originalTz = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    harness.strings = await loadTranslations('en');
    for (const task of STORE.tasks) harness.tasks.set(task.id, task);
    for (const project of STORE.projects) harness.projects.set(project.id, project);
    for (const area of STORE.areas) harness.areas.set(area.id, area);
  }, 30_000);
  afterAll(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every entry point exactly as frozen', async () => {
    const captured = captureAll();
    await vi.dynamicImportSettled();
    const inputs = { timeZone: 'UTC', now: NOW, store: STORE };
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs, ...captured }, null, 1)}\n`);
    }
    const { provenance: _provenance, timeZone, now, store, ...frozen } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect({ timeZone, now, store }).toEqual(inputs);
    expect(JSON.parse(JSON.stringify(captured))).toEqual(frozen);
  }, 120_000);
});
