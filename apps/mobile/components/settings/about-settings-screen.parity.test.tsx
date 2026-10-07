/**
 * React Native's Settings › About (its update checks and its feedback modal), the analytics heartbeat and the store review
 * prompt, replayed against the frozen parity fixture (packages/core/src/about-settings-parity.fixtures.json) that core's About
 * model and the native host contract are tested against.
 *
 * To recapture, keep every file under apps/ at HEAD except this one, then run
 *   MINDWTR_CAPTURE_ABOUT_SETTINGS=1 TZ=UTC bunx vitest run components/settings/about-settings-screen.parity.test.tsx
 * The capture refuses to run while any other file under apps/ differs from HEAD, so the provenance names the RN code that ran.
 *
 * Each scenario renders the real screen with the real core, on a stubbed device: Android, a pinned clock, AsyncStorage in
 * memory, the install referrer, the Play update answer, GitHub's answer and the feedback endpoint from the scenario. It
 * records what a user sees (the screen's texts, its alerts and toasts), what the screen stores, every request it sends, every
 * link it opens and the update dot it reports.
 */
import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Alert, Platform, Switch, Text, TextInput, TouchableOpacity } from 'react-native';
import { getTranslator, loadTranslations, resolveI18nText } from '@mindwtr/core';

const FIXTURE_PATH = new URL('../../../../packages/core/src/about-settings-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_ABOUT_SETTINGS === '1';
const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const FEEDBACK_URL = 'https://feedback.example.test/submit';
const HEARTBEAT_URL = 'https://analytics.example.test/';

// The screen requires its icon PNG; Node would parse the image as JavaScript.
vi.hoisted(() => {
  const nodeModule = process.getBuiltinModule('module') as unknown as { _extensions: Record<string, (module: { exports: unknown }) => void> };
  nodeModule._extensions['.png'] = (module) => { module.exports = 1; };
});

const harness = vi.hoisted(() => ({
  language: 'en',
  foss: false,
  feedbackEndpointUrl: '',
  releaseVersion: '',
  referrer: { value: '' as string } as { value?: string; error?: string },
  play: [] as ({ value: unknown } | { error: string })[],
  github: [] as ({ status: number; body?: unknown })[],
  feedbackStatus: 200,
  storage: new Map<string, string>(),
  hasReviewAction: true,
  reviewRequests: 0,
  events: [] as unknown[][],
  openAlert: null as null | { buttons: { text?: string; style?: string; onPress?: () => void }[] },
}));

const record = (...event: unknown[]) => { harness.events.push(event); };

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: 'android', Version: 34, constants: { Release: '14' } },
    Linking: {
      canOpenURL: async (url: string) => { record('canOpenURL', url); return url.startsWith('market://'); },
      openURL: async (url: string) => { record('openURL', url); },
    },
  };
});
vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return {
        name: 'Mindwtr',
        version: '1.3.4',
        android: { package: 'tech.dongdongbh.mindwtr' },
        ios: { bundleIdentifier: 'tech.dongdongbh.mindwtr' },
        extra: { isFossBuild: harness.foss, analyticsReleaseVersion: harness.releaseVersion, feedbackEndpointUrl: harness.feedbackEndpointUrl },
      };
    },
    appOwnership: null,
  },
}));
vi.mock('expo-application', () => ({
  applicationName: 'Mindwtr',
  applicationId: 'tech.dongdongbh.mindwtr',
  nativeBuildVersion: '154',
  getInstallReferrerAsync: async () => {
    if (harness.referrer.error) throw new Error(harness.referrer.error);
    return harness.referrer.value;
  },
}));
vi.mock('expo-store-review', () => ({
  hasAction: async () => harness.hasReviewAction,
  requestReview: async () => { harness.reviewRequests += 1; },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { record('storage.set', key, value); harness.storage.set(key, value); },
    removeItem: async (key: string) => { record('storage.remove', key); harness.storage.delete(key); },
  },
}));
vi.mock('react-native-safe-area-context', async () => {
  const { View } = await import('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: (toast: unknown) => record('toast', toast) }),
}));
vi.mock('@/lib/play-store-updates', () => ({
  getPlayStoreUpdateInfoAsync: async () => {
    const next = harness.play.shift();
    if (!next) throw new Error('No Play answer queued');
    if ('error' in next) throw new Error(next.error);
    return next.value;
  },
}));
vi.mock('@/lib/app-log', () => ({
  collectFeedbackDiagnostics: async () => '{"ts":"2026-10-07T09:59:00.000Z","level":"warn","scope":"sync","message":"x"}',
  logError: async () => null,
  logWarn: async () => null,
  logInfo: async () => null,
}));
vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a', cardBg: '#111827', border: '#334155', danger: '#ef4444', onTint: '#ffffff',
    secondaryText: '#94a3b8', success: '#22c55e', text: '#f8fafc', tint: '#3b82f6',
  }),
}));
vi.mock('@/hooks/use-filled-button-colors', () => ({ useFilledButtonColors: () => ({ backgroundColor: '#3b82f6', textColor: undefined }) }));
vi.mock('./settings.hooks', () => ({
  useSettingsLocalization: () => {
    const t = getTranslator(harness.language);
    return { t, tr: (key: string, values?: Record<string, string>) => resolveI18nText(t, key, { values }), language: harness.language };
  },
  useSettingsScrollContent: () => ({}),
}));
vi.mock('./settings.shell', async () => {
  const { Text: RNText } = await import('react-native');
  return { SettingsTopBar: ({ title }: { title?: string }) => <RNText>{title}</RNText> };
});

import { AboutSettingsScreen } from './about-settings-screen';
import { maybeRequestStoreReviewAfterPositiveMoment } from '@/lib/store-review-prompt';
import { sendMobileAnalyticsOptOut, sendMobileDailyHeartbeat } from '@/lib/analytics-heartbeat';

type Scenario = {
  name: string;
  language?: 'en' | 'zh';
  foss?: boolean;
  releaseVersion?: string;
  feedbackEndpointUrl?: string;
  referrer?: { value?: string; error?: string };
  storage?: Record<string, string>;
  play?: ({ value: unknown } | { error: string })[];
  github?: { status: number; body?: unknown }[];
  feedbackStatus?: number;
  /** What the user does after the screen opens, in order. */
  steps?: (
    | { tap: string; last?: true }
    | { pressAlert: string }
    | { type: { field: 'message' | 'email'; text: string } }
    | { diagnostics: boolean }
  )[];
};

const playInfo = (updateAvailable: boolean) => ({
  value: {
    availability: updateAvailable ? 'available' : 'not-available', availabilityCode: updateAvailable ? 2 : 1,
    installStatus: 'unknown', installStatusCode: 0, updateAvailable, availableVersionCode: updateAvailable ? 160 : null,
    clientVersionStalenessDays: null, updatePriority: 0, immediateUpdateAllowed: false, flexibleUpdateAllowed: updateAvailable,
  },
});
const release = (tag: string, body?: string) => ({
  status: 200,
  body: { tag_name: tag, html_url: `https://github.com/dongdongbh/Mindwtr/releases/tag/${tag}`, ...(body === undefined ? {} : { body }) },
});
const longChangelog = Array.from({ length: 60 }, (_, index) => `- change ${index}`).join('\n');
const STALE = { 'mindwtr-update-last-check': String(NOW - 25 * 60 * 60 * 1000) };

const SCENARIOS: Scenario[] = [
  { name: 'play: screen opens, silent check finds a Play update', referrer: { value: 'utm_source=google-play&utm_medium=organic' }, play: [playInfo(true)] },
  { name: 'play: silent check within a day reads the stored dot', referrer: { value: 'utm_source=google-play' },
    storage: { 'mindwtr-update-last-check': String(NOW - 60_000), 'mindwtr-update-available': 'true' } },
  { name: 'play: manual check, Play update, Open', referrer: { value: 'utm_source=google-play' }, storage: STALE,
    play: [playInfo(false), playInfo(true)], steps: [{ tap: 'settings.checkForUpdates' }, { pressAlert: 'attachments.open' }] },
  { name: 'play: manual check, Play up to date', referrer: { value: 'utm_source=google-play' }, storage: STALE,
    play: [playInfo(false), playInfo(false)], steps: [{ tap: 'settings.checkForUpdates' }] },
  { name: 'play: Play API fails, GitHub newer, Later', referrer: { value: 'utm_source=google-play' }, storage: STALE,
    play: [{ error: 'boom' }, { error: 'boom' }], github: [release('v1.3.5'), release('v1.3.5')],
    steps: [{ tap: 'settings.checkForUpdates' }, { pressAlert: 'settings.later' }] },
  { name: 'play: Play API fails, GitHub same', referrer: { value: 'utm_source=google-play' }, storage: STALE,
    play: [{ error: 'boom' }, { error: 'boom' }], github: [release('v1.3.4'), release('v1.3.4')], steps: [{ tap: 'settings.checkForUpdates' }] },
  { name: 'play: Play API fails, GitHub fails', referrer: { value: 'utm_source=google-play' }, storage: STALE,
    play: [{ error: 'boom' }, { error: 'boom' }], github: [{ status: 503 }, { status: 503 }], steps: [{ tap: 'settings.checkForUpdates' }] },
  { name: 'sideload: GitHub newer with changelog, Download', referrer: { value: '' }, storage: STALE,
    github: [release('v1.4.0', longChangelog), release('v1.4.0', longChangelog)],
    steps: [{ tap: 'settings.checkForUpdates' }, { pressAlert: 'attachments.download' }] },
  { name: 'sideload: GitHub newer without changelog', referrer: { value: '' }, storage: STALE, releaseVersion: '1.3.4-rc.2',
    github: [release('1.3.5'), release('1.3.5')], steps: [{ tap: 'settings.checkForUpdates' }] },
  { name: 'sideload: GitHub same version', referrer: { value: '' }, storage: STALE,
    github: [release('v1.3.4'), release('v1.3.4')], steps: [{ tap: 'settings.checkForUpdates' }] },
  { name: 'sideload: GitHub fails', referrer: { value: '' }, storage: { ...STALE, 'mindwtr-update-available': 'true', 'mindwtr-update-latest': '1.3.9' },
    github: [{ status: 500 }, { status: 500 }], steps: [{ tap: 'settings.checkForUpdates' }] },
  { name: 'referrer fails: Play path', referrer: { error: 'no referrer' }, storage: STALE, play: [playInfo(false), playInfo(false)],
    steps: [{ tap: 'settings.checkForUpdates' }] },
  { name: 'foss build: no check row, rate row or silent check', foss: true, steps: [] },
  { name: 'zh: play screen', language: 'zh', referrer: { value: 'utm_source=google-play' }, storage: { 'mindwtr-update-last-check': String(NOW) } },
  { name: 'zh: sideload GitHub newer', language: 'zh', referrer: { value: '' }, storage: STALE,
    github: [release('v1.4.0', 'Notes'), release('v1.4.0', 'Notes')], steps: [{ tap: 'settings.checkForUpdates' }] },
  { name: 'links: rate, website, tutorials, privacy, terms, sponsor', referrer: { value: 'utm_source=google-play' },
    storage: { 'mindwtr-update-last-check': String(NOW) },
    steps: [{ tap: 'settings.aboutMobile.rateOurApp' }, { tap: 'settings.officialWebsite' }, { tap: 'settings.videoTutorials' },
      { tap: 'settings.privacy' }, { tap: 'settings.terms' }, { tap: 'settings.sponsorProject' }] },
  { name: 'feedback: not configured', referrer: { value: '' }, storage: { 'mindwtr-update-last-check': String(NOW) },
    steps: [{ tap: 'settings.feedback' }, { type: { field: 'message', text: 'Hello' } }, { tap: 'settings.feedbackSubmit', last: true }] },
  { name: 'feedback: bug with location, email and diagnostics', feedbackEndpointUrl: FEEDBACK_URL,
    referrer: { value: 'utm_source=google-play' }, storage: { 'mindwtr-update-last-check': String(NOW) },
    steps: [{ tap: 'settings.feedback' }, { tap: 'settings.feedbackWhereSync' }, { type: { field: 'message', text: '  Sync stopped  ' } },
      { type: { field: 'email', text: ' me@example.com ' } }, { diagnostics: true }, { tap: 'settings.feedbackSubmit', last: true }, { tap: 'common.close' }] },
  { name: 'feedback: location chip toggles off', feedbackEndpointUrl: FEEDBACK_URL, referrer: { value: '' }, storage: { 'mindwtr-update-last-check': String(NOW) },
    steps: [{ tap: 'settings.feedback' }, { tap: 'settings.feedbackWhereInbox' }, { tap: 'settings.feedbackWhereInbox' },
      { type: { field: 'message', text: 'No place' } }, { tap: 'settings.feedbackSubmit', last: true }] },
  { name: 'feedback: feature drops diagnostics, opens GitHub', feedbackEndpointUrl: FEEDBACK_URL, referrer: { value: '' },
    storage: { 'mindwtr-update-last-check': String(NOW) },
    steps: [{ tap: 'settings.feedback' }, { diagnostics: true }, { tap: 'settings.feedbackCategoryFeature' },
      { tap: 'settings.feedbackOpenGitHubIssue' }, { type: { field: 'message', text: 'Add tags' } }, { tap: 'settings.feedbackSubmit', last: true }] },
  { name: 'feedback: other opens discussions', feedbackEndpointUrl: FEEDBACK_URL, foss: true,
    steps: [{ tap: 'settings.feedback' }, { tap: 'settings.feedbackCategoryOther' }, { tap: 'settings.feedbackOpenGitHubDiscussion' },
      { type: { field: 'message', text: 'Thanks' } }, { tap: 'settings.feedbackSubmit', last: true }] },
  { name: 'feedback: invalid email', feedbackEndpointUrl: FEEDBACK_URL, referrer: { value: '' }, storage: { 'mindwtr-update-last-check': String(NOW) },
    steps: [{ tap: 'settings.feedback' }, { type: { field: 'message', text: 'Hi' } }, { type: { field: 'email', text: 'nope@' } }, { tap: 'settings.feedbackSubmit', last: true }] },
  { name: 'feedback: endpoint refuses', feedbackEndpointUrl: FEEDBACK_URL, feedbackStatus: 500, referrer: { value: '' },
    storage: { 'mindwtr-update-last-check': String(NOW) },
    steps: [{ tap: 'settings.feedback' }, { type: { field: 'message', text: 'Broken' } }, { tap: 'settings.feedbackSubmit', last: true }] },
];

/** A node's strings in drawing order, nested texts (a link inside a sentence) included. */
const textOf = (node: ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''));

const insideText = (node: ReactTestInstance): boolean => {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === Text) return true;
  return false;
};

/** What a user sees: every outermost text, in order. */
const visibleTexts = (tree: ReactTestRenderer): string[] => tree.root.findAllByType(Text)
  .filter((node) => !insideText(node)).map(textOf).filter(Boolean);

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
};

async function run(scenario: Scenario) {
  harness.language = scenario.language ?? 'en';
  harness.foss = scenario.foss ?? false;
  harness.releaseVersion = scenario.releaseVersion ?? '';
  harness.feedbackEndpointUrl = scenario.feedbackEndpointUrl ?? '';
  harness.referrer = scenario.referrer ?? { value: '' };
  harness.play = [...(scenario.play ?? [])];
  harness.github = [...(scenario.github ?? [])];
  harness.feedbackStatus = scenario.feedbackStatus ?? 200;
  harness.storage = new Map(Object.entries(scenario.storage ?? {}));
  harness.events = [];
  harness.openAlert = null;
  const t = getTranslator(harness.language);
  const label = (key: string) => resolveI18nText(t, key, {});
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<AboutSettingsScreen onUpdateBadgeChange={(next) => record('badge', next)} />);
  });
  await flush();
  const screens: string[][] = [visibleTexts(tree)];
  for (const step of scenario.steps ?? []) {
    if ('tap' in step) {
      const wanted = label(step.tap);
      const target = tree.root.findAll((node) => (node.type === TouchableOpacity || (node.type === Text && typeof node.props.onPress === 'function'))
        && (node.type === Text ? textOf(node) === wanted : node.findAllByType(Text).some((text) => textOf(text) === wanted)))
        .at(step.last ? -1 : 0);
      if (!target) throw new Error(`${scenario.name}: nothing to tap for ${step.tap} in ${JSON.stringify(visibleTexts(tree))} ${JSON.stringify(harness.events.slice(-4))}`);
      record('tap', step.tap, target.props.disabled === true ? 'disabled' : 'enabled');
      if (target.props.disabled !== true) await act(async () => { target.props.onPress(); });
    } else if ('pressAlert' in step) {
      // The alert's own buttons, opened by the step before (TypeScript narrowed the field to null at the reset above).
      const opened = harness.openAlert as { buttons: { text?: string; onPress?: () => void }[] } | null;
      const button = opened?.buttons.find((entry) => entry.text === label(step.pressAlert));
      if (!button) throw new Error(`${scenario.name}: no alert button ${step.pressAlert}`);
      harness.openAlert = null;
      await act(async () => { button.onPress?.(); });
    } else if ('type' in step) {
      const inputs = tree.root.findAllByType(TextInput);
      const input = step.type.field === 'message' ? inputs.find((node) => node.props.multiline) : inputs.find((node) => !node.props.multiline);
      await act(async () => { input!.props.onChangeText(step.type.text); });
    } else {
      await act(async () => { tree.root.findByType(Switch).props.onValueChange(step.diagnostics); });
    }
    await flush();
    screens.push(visibleTexts(tree));
  }
  act(() => tree.unmount());
  return { name: scenario.name, screens, events: harness.events, storage: Object.fromEntries([...harness.storage.entries()].sort()) };
}

/** The heartbeat and its opt-out as RN sends them, with core's request on the stubbed fetch. */
async function heartbeats() {
  const out: unknown[] = [];
  const config = { analyticsHeartbeatUrl: HEARTBEAT_URL, appVersion: '1.3.4-rc.2', analyticsHeartbeatChannel: '', isExpoGo: false, isFossBuild: false };
  const cases: { name: string; storage?: Record<string, string>; config?: Partial<typeof config>; settings: Record<string, unknown>; optOut?: boolean; dev?: boolean; status?: number }[] = [
    { name: 'first heartbeat makes the distinct id', settings: {} },
    { name: 'stored id and profile id', storage: { 'mindwtr-analytics-distinct-id': ' stored-id ' }, settings: { analyticsProfileId: 'profile-1' } },
    { name: 'already sent today', storage: { 'mindwtr-analytics-last-heartbeat-day': '2026-10-07' }, settings: {} },
    { name: 'sent yesterday', storage: { 'mindwtr-analytics-last-heartbeat-day': '2026-10-06', 'mindwtr-analytics-distinct-id': 'id-2' }, settings: {} },
    { name: 'heartbeat off', settings: { analytics: { heartbeatEnabled: false } } },
    { name: 'baked channel', config: { analyticsHeartbeatChannel: 'android-direct' }, storage: { 'mindwtr-analytics-distinct-id': 'id-3' }, settings: {} },
    { name: 'foss fallback channel', config: { isFossBuild: true }, storage: { 'mindwtr-analytics-distinct-id': 'id-4' }, settings: {} },
    { name: 'no url', config: { analyticsHeartbeatUrl: ' ' }, settings: {} },
    { name: 'dev build', dev: true, settings: {} },
    { name: 'server refuses', status: 500, storage: { 'mindwtr-analytics-distinct-id': 'id-5' }, settings: {} },
    { name: 'opt-out', optOut: true, storage: { 'mindwtr-analytics-distinct-id': 'id-6' }, settings: {} },
    { name: 'opt-out already sent', optOut: true, storage: { 'mindwtr-analytics-opt-out-sent': '2026-10-01T00:00:00.000Z' }, settings: {} },
  ];
  for (const entry of cases) {
    harness.storage = new Map(Object.entries(entry.storage ?? {}));
    harness.events = [];
    (globalThis as { __DEV__?: boolean }).__DEV__ = entry.dev === true;
    harness.feedbackStatus = entry.status ?? 200;
    const merged = { ...config, ...entry.config };
    const sent = entry.optOut ? await sendMobileAnalyticsOptOut(merged) : await sendMobileDailyHeartbeat(merged, entry.settings as never);
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const storage = Object.fromEntries([...harness.storage.entries()].sort());
    // A made distinct id is random: the fixture keeps whether one was made.
    const madeId = !entry.storage?.['mindwtr-analytics-distinct-id'] && storage['mindwtr-analytics-distinct-id'];
    if (madeId) storage['mindwtr-analytics-distinct-id'] = '<uuid>';
    const events = JSON.parse(JSON.stringify(harness.events).split(String(madeId || '\u0000')).join('<uuid>'));
    out.push({ name: entry.name, sent, storage, events });
  }
  return out;
}

/** The store review prompt after a Weekly Review, for prompt states around each gate. */
async function storeReviews() {
  const day = 24 * 60 * 60 * 1000;
  const days = (count: number) => Array.from({ length: count }, (_, index) => new Date(NOW - index * day).toISOString().slice(0, 10));
  const state = (extra: Record<string, unknown> = {}) => JSON.stringify({ firstSeenAt: new Date(NOW - 20 * day).toISOString(), activeDayKeys: days(8), ...extra });
  const cases: { name: string; stored?: string; foss?: boolean; hasAction?: boolean }[] = [
    { name: 'eligible', stored: state() },
    { name: 'no state yet' },
    { name: 'unreadable state', stored: '{' },
    { name: 'too new', stored: state({ firstSeenAt: new Date(NOW - 3 * day).toISOString() }) },
    { name: 'too few active days', stored: state({ activeDayKeys: days(3) }) },
    { name: 'recent attempt', stored: state({ storeReview: { lastAttemptAt: new Date(NOW - 30 * day).toISOString(), attemptCount: 1 } }) },
    { name: 'old attempt', stored: state({ storeReview: { lastAttemptAt: new Date(NOW - 100 * day).toISOString(), attemptCount: 1 } }) },
    { name: 'recent other prompt', stored: state({ lastInterruptivePromptAt: new Date(NOW - 2 * day).toISOString() }) },
    { name: 'no review action', stored: state(), hasAction: false },
    { name: 'foss build', stored: state(), foss: true },
  ];
  const out: unknown[] = [];
  for (const entry of cases) {
    harness.storage = new Map(entry.stored === undefined ? [] : [['mindwtr:local-user-prompts:v1', entry.stored]]);
    harness.events = [];
    harness.foss = entry.foss ?? false;
    harness.hasReviewAction = entry.hasAction ?? true;
    harness.reviewRequests = 0;
    const requested = await maybeRequestStoreReviewAfterPositiveMoment(NOW);
    out.push({ name: entry.name, requested, reviewRequests: harness.reviewRequests, storage: Object.fromEntries(harness.storage.entries()) });
  }
  harness.foss = false;
  harness.hasReviewAction = true;
  return out;
}

const captureProvenance = () => {
  const root = new URL('../../../../', import.meta.url).pathname;
  const changed = execFileSync('git', ['status', '--porcelain', '--', 'apps'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((line) => !line.endsWith('about-settings-screen.parity.test.tsx'));
  if (changed.length > 0) throw new Error(`Capture needs apps/ at HEAD; changed: ${changed.join(', ')}`);
  return { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
};

describe('Settings › About, the heartbeat and the store review prompt parity with the frozen fixture', () => {
  const originalFetch = globalThis.fetch;
  const originalAlert = Alert.alert;
  beforeAll(async () => {
    await loadTranslations('zh');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    Alert.alert = ((title: string, message?: string, buttons?: { text?: string; style?: string; onPress?: () => void }[]) => {
      record('alert', { title, message, buttons: (buttons ?? []).map((button) => ({ text: button.text, style: button.style })) });
      harness.openAlert = { buttons: buttons ?? [] };
    }) as typeof Alert.alert;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (body && typeof body.submittedAt === 'string') body.submittedAt = '<now>';
      record('fetch', { url, method: init?.method ?? 'GET', headers: init?.headers ?? null, body: body ?? null });
      if (url.startsWith('https://api.github.com/')) {
        const next = harness.github.shift();
        if (!next) throw new Error('No GitHub answer queued');
        return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
      }
      return { ok: harness.feedbackStatus < 300, status: harness.feedbackStatus, json: async () => ({}) };
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    Alert.alert = originalAlert;
    vi.useRealTimers();
  });

  it('replays every scenario as frozen', async () => {
    expect(Platform.OS).toBe('android');
    const observed = { locale: Intl.DateTimeFormat().resolvedOptions().locale, about: [] as unknown[], heartbeats: [] as unknown[], storeReviews: [] as unknown[] };
    for (const scenario of SCENARIOS) observed.about.push(await run(scenario));
    observed.heartbeats = await heartbeats();
    observed.storeReviews = await storeReviews();
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), now: new Date(NOW).toISOString(), scenarios: SCENARIOS, observations: observed }, null, 1)}\n`);
    }
    const frozen = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozen.scenarios).toEqual(JSON.parse(JSON.stringify(SCENARIOS)));
    expect(JSON.parse(JSON.stringify(observed))).toEqual(frozen.observations);
  });
});
