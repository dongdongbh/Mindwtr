


import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations, type AppData, type AppSettings, type Area, type Project, type SavedFilter, type Section, type Task } from '@mindwtr/core';

import { buildShortcutsSnapshot, buildWidgetPayload, type WidgetPayloadBuildOptions, WIDGET_LANGUAGE_KEY } from './widget-data';
import { resetFocusWidgetFilter, setFocusWidgetFilter, type FocusWidgetFilter } from './focus-widget-filter';
import { resolveWidgetListDestination } from './widget-list-destination';
import { resetMobileWidgetRenderCache, updateMobileWidgetFromData } from './widget-service';

const FIXTURE_PATH = new URL('../../../packages/core/src/widget-payload-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_WIDGET_PAYLOAD === '1';
const RECAPTURE_CHANGE = process.env.MINDWTR_RECAPTURE_WIDGET_PAYLOAD;
const NOW = '2026-09-28T15:30:00.000Z';
const LANGUAGES = ['en', 'de', 'zh'] as const;


const DEVICE_LOCALE = 'und';

const harness = vi.hoisted(() => ({
    platform: { OS: 'android' },
    savedLanguage: null as string | null,
    systemColorScheme: undefined as 'light' | 'dark' | undefined,
    listSelections: [] as string[],
    androidPayloads: [] as string[],
    iosItems: [] as [string, string][],
}));

vi.mock('react-native', () => ({ Platform: harness.platform }));
vi.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => (key === 'mindwtr-language' ? harness.savedLanguage : null),
        setItem: async () => undefined,
    },
}));
vi.mock('../modules/android-widget', () => ({
    getWidgetListSelections: () => harness.listSelections,
    isSupported: () => true,
    setPayload: (payload: string) => { harness.androidPayloads.push(payload); },
    updateWidgets: () => undefined,
}));
vi.mock('react-native-widgetkit', () => ({
    reloadTimelines: () => undefined,
    setItem: async (key: string, value: string) => { harness.iosItems.push([key, value]); },
}));
vi.mock('./app-log', () => ({ logError: async () => undefined, logInfo: async () => undefined, logWarn: async () => undefined }));
vi.mock('./system-color-scheme', () => ({ getSystemColorSchemeForWidget: () => harness.systemColorScheme }));


const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id,
    title: id,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...extra,
});
const project = (id: string, order: number, extra: Partial<Project> = {}): Project => ({
    id,
    title: id,
    status: 'active',
    color: '#94A3B8',
    order,
    tagIds: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...extra,
});
const area = (id: string, order: number, extra: Partial<Area> = {}): Area => ({
    id,
    name: id,
    order,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...extra,
});
const savedFilter = (id: string, extra: Partial<SavedFilter> & Pick<SavedFilter, 'view'>): SavedFilter => ({
    id,
    name: id,
    criteria: {},
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...extra,
});

const LONG_DESCRIPTION = `# Notes\n\n${'Keep **every** receipt and _check_ the [portal](https://example.com/portal) twice. '.repeat(10)}`;

const richStore = (): AppData => ({
    tasks: [
        task('star-call', {
            title: 'Call the bank', isFocusedToday: true, projectId: 'p-home', sectionId: 's-home-admin',
            dueDate: '2026-09-28T17:00:00', priority: 'high', contexts: ['@phone'], tags: ['#money'],
            description: '**Ask** about the [fee](https://example.com) and\n\n- the card\n- the loan',
            rev: 4, updatedAt: '2026-09-27T08:00:00.000Z',
        }),
        task('star-overdue', { title: 'Send the tax form', isFocusedToday: true, areaId: 'a-work', dueDate: '2026-09-25', priority: 'urgent' }),
        task('star-queued', { title: 'Plan the trip', isFocusedToday: true, startTime: '2026-10-02' }),
        task('star-started', { title: 'Write the report', isFocusedToday: true, startTime: '2026-09-28T09:00:00', projectId: 'p-work', timeEstimate: '1hr' }),
        task('due-today', { title: 'Pay rent', dueDate: '2026-09-28', contexts: ['@home'] }),
        task('due-today-late', { title: 'Evening check', dueDate: '2026-09-28T21:30:00', priority: 'low' }),
        task('due-tomorrow', { title: 'Book the dentist', dueDate: '2026-09-29', areaId: 'a-home' }),
        task('due-thursday', { title: 'Renew the permit', dueDate: '2026-10-01T10:00:00' }),
        task('due-far', { title: 'File the insurance claim', dueDate: '2026-10-20', priority: 'medium' }),
        task('start-today', { title: 'Stretch', startTime: '2026-09-28T07:00:00' }),
        task('start-later-today', { title: 'Read the paper', startTime: '2026-09-28T20:00:00' }),
        task('start-future', { title: 'Wash the car', startTime: '2026-10-05', dueDate: '2026-10-06' }),
        task('seq-1', { title: 'Draft outline', projectId: 'p-seq', order: 1 }),
        task('seq-2', { title: 'Write chapter', projectId: 'p-seq', order: 2, dueDate: '2026-09-28' }),
        task('seq-3', { title: 'Edit chapter', projectId: 'p-seq', order: 3 }),
        task('review-due', { title: 'Check the budget', reviewAt: '2026-09-20T00:00:00.000Z' }),
        task('tokens', {
            title: 'Many labels',
            contexts: Array.from({ length: 10 }, (_, index) => `@c${index + 1}`),
            tags: Array.from({ length: 10 }, (_, index) => `#t${index + 1}`),
            description: LONG_DESCRIPTION,
            priority: 'medium',
        }),
        task('plain-next', { title: 'Buy stamps', projectId: 'p-home', createdAt: '2026-09-02T10:00:00.000Z' }),
        task('sorted-a', { title: 'Zebra task', projectId: 'p-sorted', createdAt: '2026-09-03T10:00:00.000Z' }),
        task('sorted-b', { title: 'Apple task', projectId: 'p-sorted', createdAt: '2026-09-04T10:00:00.000Z' }),
        task('someday-project-task', { title: 'Paint the fence', projectId: 'p-focused-someday' }),
        task('inactive-project-task', { title: 'Tile the bathroom', projectId: 'p-someday' }),
        task('deleted-project-task', { title: 'Orphan step', projectId: 'p-deleted', isFocusedToday: true }),
        task('hidden-area', { title: 'Hidden area task', areaId: 'a-hidden', isFocusedToday: true, dueDate: '2026-09-28' }),
        task('inbox-1', { status: 'inbox', title: 'Idea about the garden', createdAt: '2026-09-26T10:00:00.000Z' }),
        task('inbox-2', { status: 'inbox', title: 'Receipt photo', dueDate: '2026-09-30', createdAt: '2026-09-27T10:00:00.000Z' }),
        task('waiting-1', { status: 'waiting', title: 'Reply from Sam', dueDate: '2026-10-05' }),
        task('waiting-2', { status: 'waiting', title: 'Parcel', createdAt: '2026-09-10T10:00:00.000Z' }),
        task('waiting-3', { status: 'waiting', title: 'Quote from the plumber', dueDate: '2026-09-30', projectId: 'p-home' }),
        task('someday-1', { status: 'someday', title: 'Learn the cello', createdAt: '2026-08-01T10:00:00.000Z' }),
        task('someday-2', { status: 'someday', title: 'Visit Iceland', createdAt: '2026-09-15T10:00:00.000Z', areaId: 'a-home' }),
        task('reference-1', { status: 'reference', title: 'Wi-Fi password location' }),
        task('done-1', { status: 'done', title: 'Old errand', isFocusedToday: true, completedAt: '2026-09-27T10:00:00.000Z' }),
        task('deleted-1', { title: 'Removed task', isFocusedToday: true, deletedAt: '2026-09-27T00:00:00.000Z' }),
        task('unicode', { title: 'Café ☕ “quotes” & <tags> 日本語', dueDate: '2026-09-28', contexts: ['@café'] }),
    ],
    projects: [
        project('p-home', 1, { title: 'Home', color: '#10B981', areaId: 'a-home' }),
        project('p-work', 2, { title: 'Work', color: '#6366F1', areaId: 'a-work' }),
        project('p-seq', 3, { title: 'Book', isSequential: true }),
        project('p-sorted', 4, { title: 'Sorted', taskSortBy: 'title' }),
        project('p-focused-someday', 5, { title: 'Garden', status: 'someday', isFocused: true }),
        project('p-someday', 6, { title: 'Bathroom', status: 'someday' }),
        project('p-deleted', 7, { title: 'Gone', deletedAt: '2026-09-01T00:00:00.000Z' }),
    ],
    sections: [
        { id: 's-home-admin', projectId: 'p-home', title: 'Admin', order: 0, createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z' } satisfies Section,
    ],
    areas: [
        area('a-home', 1, { name: 'Home life', color: '#F59E0B' }),
        area('a-work', 0, { name: 'Work life', color: '#3B82F6' }),
        area('a-hidden', 2, { name: 'Hidden' }),
        area('a-deleted', 3, { name: 'Deleted area', deletedAt: '2026-09-01T00:00:00.000Z' }),
    ],
    settings: {},
});

const SAVED_FILTERS: SavedFilter[] = [
    savedFilter('sf-next', { name: 'Calls', view: 'next', criteria: { contexts: ['@phone'] } }),
    savedFilter('sf-waiting', { name: 'Waiting by due', view: 'waiting', sortBy: 'due', sortOrder: 'desc' }),
    savedFilter('sf-all-priority', { name: 'Hot', view: 'all', criteria: { priority: ['high', 'urgent'] } }),
    savedFilter('sf-focus', { name: 'Work focus', view: 'focus', criteria: { areas: ['a-work'] }, sortBy: 'title' }),
    savedFilter('sf-deleted', { name: 'Old', view: 'next', deletedAt: '2026-09-02T00:00:00.000Z' }),
];

const smallStore = (): AppData => ({
    tasks: [
        task('small-star', { title: 'Call the bank', isFocusedToday: true, dueDate: '2026-09-28T17:00:00', priority: 'high', projectId: 'p-home' }),
        task('small-overdue', { title: 'Send the tax form', isFocusedToday: true, dueDate: '2026-09-25', areaId: 'a-work' }),
        task('small-thursday', { title: 'Renew the permit', dueDate: '2026-10-01', startTime: '2026-09-28T08:15:00' }),
        task('small-far', { title: 'File the claim', dueDate: '2026-10-20', isFocusedToday: true, startTime: '2026-10-19' }),
        task('small-today', { title: 'Pay rent', dueDate: '2026-09-28' }),
        task('small-inbox', { status: 'inbox', title: 'Idea' }),
        task('small-waiting', { status: 'waiting', title: 'Parcel', dueDate: '2026-09-30' }),
        task('small-someday', { status: 'someday', title: 'Cello' }),
    ],
    projects: [project('p-home', 1, { title: 'Home', color: '#10B981' })],
    sections: [],
    areas: [area('a-work', 0, { name: 'Work life', color: '#3B82F6' })],
    settings: {},
});

const pad = (value: number, width = 3) => String(value).padStart(width, '0');
const longStore = (): AppData => ({
    tasks: [
        ...Array.from({ length: 230 }, (_, index) => task(`bulk-${pad(index)}`, {
            title: `Bulk ${pad(index)}`,
            createdAt: `2026-09-${pad((index % 27) + 1, 2)}T${pad(index % 24, 2)}:00:00.000Z`,
            ...(index % 50 === 0 ? { isFocusedToday: true } : {}),
            ...(index % 40 === 7 ? { dueDate: '2026-09-28' } : {}),
            ...(index % 33 === 5 ? { dueDate: '2026-09-20' } : {}),
        })),
        task('long-inbox', { status: 'inbox', title: 'Long inbox' }),
    ],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
});

const projectsStore = (): AppData => ({
    tasks: [
        ...Array.from({ length: 52 }, (_, index) => task(`pt-${pad(index)}`, {
            title: `Project step ${pad(index)}`,
            projectId: `proj-${pad(index)}`,
            status: index % 3 === 0 ? 'waiting' : 'next',
            ...(index % 4 === 0 ? { dueDate: '2026-10-03', startTime: '2026-09-29' } : {}),
        })),
        task('pt-inbox', { status: 'inbox', title: 'Loose inbox item' }),
        task('pt-star', { title: 'Starred loose item', isFocusedToday: true }),
    ],
    projects: [
        ...Array.from({ length: 52 }, (_, index) => project(`proj-${pad(index)}`, 52 - index, { title: `Project ${pad(index)}` })),
        project('proj-empty', 0, { title: 'Empty project' }),
    ],
    sections: [],
    areas: [],
    settings: {},
});

const STORES = { rich: richStore(), small: smallStore(), long: longStore(), projects: projectsStore() };
type StoreName = keyof typeof STORES;


type Publication = {
    kind: 'publish';
    name: string;
    platform: 'android' | 'ios';
    store: StoreName;
    settings: Partial<AppSettings>;
    savedLanguage: string | null;
    systemColorScheme: 'light' | 'dark' | null;
    focusFilter: FocusWidgetFilter | null;
    listSelections: string[];
    noIntl?: boolean;
};
type DirectBuild = {
    kind: 'build';
    name: string;
    store: StoreName;
    settings: Partial<AppSettings>;
    language: string;
    options: Omit<WidgetPayloadBuildOptions, 'systemColorScheme'> & { systemColorScheme?: 'light' | 'dark' | null };
    noIntl?: boolean;
};
type Destination = {
    kind: 'destination';
    name: string;
    store: StoreName;
    settings: Partial<AppSettings>;
    language: string;
    focusFilter: FocusWidgetFilter | null;
    ids: unknown[];
};
type Snapshot = { kind: 'snapshot'; name: string; store: StoreName; settings: Partial<AppSettings> };
type Scenario = Publication | DirectBuild | Destination | Snapshot;

const ALL_SELECTIONS = [
    'filter:sf-next', 'filter:sf-waiting', 'filter:sf-all-priority', 'filter:sf-focus', 'filter:sf-deleted', 'filter:missing',
    'project:p-home', 'project:p-sorted', 'project:p-focused-someday', 'project:p-someday', 'project:p-deleted', 'project:missing',
];
const publish = (scenario: Omit<Publication, 'kind' | 'savedLanguage' | 'systemColorScheme' | 'focusFilter' | 'listSelections'> & Partial<Publication>): Publication => ({
    kind: 'publish', savedLanguage: null, systemColorScheme: 'light', focusFilter: null, listSelections: [], ...scenario,
});
const THEMES: [string | undefined, 'light' | 'dark' | null][] = [
    [undefined, null], [undefined, 'dark'], ['light', 'dark'], ['dark', 'light'], ['system', 'dark'], ['system', 'light'],
    ['system-oled', 'light'], ['system-oled', 'dark'], ['system-oled', null], ['oled', 'light'], ['eink', 'dark'], ['nord', 'light'],
    ['sepia', 'dark'], ['catppuccin-macchiato', 'light'], ['dracula', 'light'], ['material3-light', 'dark'], ['material3-dark', 'light'],
    ['NORD', 'light'], ['System-OLED', 'dark'], ['bogus', 'dark'],
];

const scenarios: Scenario[] = [
    publish({ name: 'android-default', platform: 'android', store: 'rich', settings: { savedFilters: SAVED_FILTERS }, listSelections: ALL_SELECTIONS }),
    publish({
        name: 'android-dark-dmy-audio-no-priorities', platform: 'android', store: 'rich', systemColorScheme: 'dark',
        settings: { savedFilters: SAVED_FILTERS, theme: 'dark', dateFormat: 'dmy', ai: { speechToText: { enabled: true } }, features: { priorities: false } },
        listSelections: ['filter:sf-next', 'project:p-seq'],
    }),
    publish({
        name: 'android-de-focus-filter', platform: 'android', store: 'rich', systemColorScheme: null, savedLanguage: 'en',
        settings: { savedFilters: SAVED_FILTERS, language: 'de', taskSortBy: 'due' },
        focusFilter: { criteria: { contexts: ['@phone', '@home'], contextMatchMode: 'any' }, sortBy: 'due', sortOrder: 'desc' },
        listSelections: ['filter:sf-all-priority'],
    }),
    publish({
        name: 'android-zh-area-filter-ymd', platform: 'android', store: 'rich', savedLanguage: 'zh',
        settings: { savedFilters: SAVED_FILTERS, filters: { excludedAreaIds: ['a-hidden'] }, taskSortBy: 'title', dateFormat: 'ymd', theme: 'nord' },
        listSelections: ['project:p-home', 'filter:sf-focus'],
    }),
    publish({
        name: 'android-included-area', platform: 'android', store: 'rich',
        settings: { savedFilters: SAVED_FILTERS, filters: { areaIds: ['a-work'] }, dateFormat: 'mdy' },
        focusFilter: { criteria: { priority: ['urgent', 'high'] }, sortBy: 'priority' },
    }),
    publish({
        name: 'android-no-intl', platform: 'android', store: 'rich', systemColorScheme: 'dark', noIntl: true,
        settings: { savedFilters: SAVED_FILTERS, dateFormat: 'system', theme: 'system-oled' }, listSelections: ['filter:sf-waiting'],
    }),
    publish({ name: 'android-long', platform: 'android', store: 'long', settings: {} }),
    publish({ name: 'ios-default', platform: 'ios', store: 'rich', settings: { savedFilters: SAVED_FILTERS } }),
    publish({
        name: 'ios-oled-mdy-created-desc', platform: 'ios', store: 'rich', systemColorScheme: 'dark',
        settings: { savedFilters: SAVED_FILTERS, theme: 'system-oled', dateFormat: 'mdy', taskSortBy: 'created-desc' },
        focusFilter: { criteria: { priority: ['high', 'urgent'] }, sortBy: 'priority' },
    }),
    publish({
        name: 'ios-invalid-sort-language', platform: 'ios', store: 'small', savedLanguage: 'xx', systemColorScheme: null,
        settings: { taskSortBy: 'bogus' as never, language: 'system', dateFormat: 'dmy' },
    }),
    publish({ name: 'ios-no-intl', platform: 'ios', store: 'small', noIntl: true, savedLanguage: 'de', settings: { dateFormat: 'system' } }),
    ...THEMES.map(([theme, scheme]): DirectBuild => ({
        kind: 'build',
        name: `theme-${theme ?? 'unset'}-${scheme ?? 'unknown'}`,
        store: 'small',
        settings: theme === undefined ? {} : { theme: theme as AppSettings['theme'] },
        language: 'en',
        options: { systemColorScheme: scheme },
    })),
    ...[
        ['system', 'en', 'en-US'], ['system', 'en', 'en-GB'], ['system', 'en', 'en-ZA'], ['system', 'de', 'de-DE'],
        ['system', 'zh', 'zh-CN'], ['dmy', 'en', 'en-US'], ['mdy', 'de', 'de-DE'], ['ymd', 'en', 'en-GB'], ['bogus', 'en', 'en-GB'],
    ].map(([dateFormat, language, systemLocale]): DirectBuild => ({
        kind: 'build',
        name: `date-${dateFormat}-${language}-${systemLocale}`,
        store: 'small',
        settings: { dateFormat },
        language,
        options: { systemLocale, maxItems: 10 },
    })),
    {
        kind: 'build', name: 'build-one-item-every-list', store: 'rich', settings: { savedFilters: SAVED_FILTERS }, language: 'en',
        options: { maxItems: 1, listIds: ['inbox', 'next', 'waiting', 'someday', 'focus', 'bogus', 'filter:sf-all-priority', 'project:p-seq', 'project:p-sorted'] },
    },
    {
        kind: 'build', name: 'build-fractional-max-saved-filters', store: 'rich', settings: { savedFilters: SAVED_FILTERS }, language: 'en',
        options: { maxItems: 2.5, includeSavedFilterLists: true, focusFilter: { criteria: { contexts: ['@phone'] }, sortBy: 'created-desc' } },
    },
    { kind: 'build', name: 'build-zero-max', store: 'small', settings: {}, language: 'en', options: { maxItems: 0 } },
    { kind: 'build', name: 'build-default-max', store: 'rich', settings: {}, language: 'en', options: {} },
    { kind: 'build', name: 'build-no-intl', store: 'small', settings: { dateFormat: 'system' }, language: 'de', options: { maxItems: 10 }, noIntl: true },
    {
        kind: 'destination', name: 'destinations', store: 'rich', settings: { savedFilters: SAVED_FILTERS }, language: 'en', focusFilter: null,
        ids: [...ALL_SELECTIONS, 'next', 'project:p-seq', 'inbox', 'focus', 'waiting', '', null, 42, ['next'], 'filter:', 'filter:  ', 'project:a\u0000b', `filter:${'x'.repeat(1030)}`],
    },
    {
        kind: 'destination', name: 'destinations-focus-filter', store: 'rich', settings: { savedFilters: SAVED_FILTERS, taskSortBy: 'title' }, language: 'de',
        focusFilter: { criteria: { contexts: ['@phone'] }, sortBy: 'due' },
        ids: ['next', 'filter:sf-next', 'project:p-home'],
    },
    { kind: 'snapshot', name: 'snapshot-rich-due', store: 'rich', settings: { taskSortBy: 'due' } },
    { kind: 'snapshot', name: 'snapshot-projects', store: 'projects', settings: {} },
];

const storeFor = (scenario: { store: StoreName; settings: Partial<AppSettings> }): AppData => {
    const store = STORES[scenario.store];
    return { ...store, settings: { ...store.settings, ...scenario.settings } as AppSettings };
};

const withoutIntl = async <T,>(enabled: boolean | undefined, run: () => Promise<T> | T): Promise<T> => {
    if (!enabled) return run();
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
        throw new Error('no Intl in this engine');
    }) as unknown as typeof Intl.DateTimeFormat);
    try {
        return await run();
    } finally {
        spy.mockRestore();
    }
};

async function observe(scenario: Scenario): Promise<unknown> {
    const data = storeFor(scenario);
    switch (scenario.kind) {
        case 'publish': {
            harness.platform.OS = scenario.platform;
            harness.savedLanguage = scenario.savedLanguage;
            harness.systemColorScheme = scenario.systemColorScheme ?? undefined;
            harness.listSelections = scenario.listSelections;
            harness.androidPayloads = [];
            harness.iosItems = [];
            resetMobileWidgetRenderCache();
            resetFocusWidgetFilter();
            if (scenario.focusFilter) setFocusWidgetFilter(scenario.focusFilter);
            const published = await withoutIntl(scenario.noIntl, () => updateMobileWidgetFromData(data));
            resetFocusWidgetFilter();
            return scenario.platform === 'android'
                ? { published, android: harness.androidPayloads }
                : { published, ios: harness.iosItems };
        }
        case 'build': {
            const { systemColorScheme, ...options } = scenario.options;
            return withoutIntl(scenario.noIntl, () => JSON.stringify(buildWidgetPayload(
                data,
                scenario.language as Parameters<typeof buildWidgetPayload>[1],
                { ...options, systemColorScheme: systemColorScheme ?? undefined },
            )));
        }
        case 'destination': {
            resetFocusWidgetFilter();
            if (scenario.focusFilter) setFocusWidgetFilter(scenario.focusFilter);
            const lists = scenario.ids.map((id) => {
                const list = resolveWidgetListDestination(data, scenario.language as Parameters<typeof buildWidgetPayload>[1], id);
                return list ? { title: list.title, taskIds: list.tasks.map((item) => item.id) } : null;
            });
            resetFocusWidgetFilter();
            return lists;
        }
        case 'snapshot':
            return JSON.stringify(buildShortcutsSnapshot(data));
    }
}

function captureProvenance() {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
    const head = git('rev-parse', 'HEAD').trim();
    const declared = process.env.MINDWTR_CAPTURE_WIDGET_PAYLOAD_COMMIT;
    if (declared !== head) throw new Error(`Recapture needs MINDWTR_CAPTURE_WIDGET_PAYLOAD_COMMIT=${head} (the current HEAD); got ${declared ?? 'nothing'}`);
    const allowed = new Set([
        'apps/mobile/lib/widget-payload.parity.test.ts',
        'packages/core/src/widget-payload-parity.fixtures.json',
    ]);
    const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
        .map((line) => line.slice(3).replace(/^"|"$/g, '')).filter((path) => !allowed.has(path));
    if (changed.length > 0) throw new Error(`Recapture needs HEAD's code only; changed: ${changed.join(', ')}`);
    return {
        command: 'cd apps/mobile && MINDWTR_CAPTURE_WIDGET_PAYLOAD=1 MINDWTR_CAPTURE_WIDGET_PAYLOAD_COMMIT=$(git rev-parse HEAD) TZ=UTC bunx vitest run lib/widget-payload.parity.test.ts',
        capturedAt: head,
        sourceState: 'Every file under apps/ and packages/ was at HEAD except this harness and its fixture.',
        runtime: `node ${process.version}, ICU ${process.versions.icu ?? 'none'}, TZ=UTC, device locale ${DEVICE_LOCALE}, clock fixed at ${NOW}; translations for ${LANGUAGES.join(', ')} loaded before the first build.`,
        observations: 'publish: the strings the real widget service handed AndroidWidget.setPayload or react-native-widgetkit setItem (key, value); build: JSON.stringify(buildWidgetPayload(...)); destination: resolveWidgetListDestination title and task ids; snapshot: JSON.stringify(buildShortcutsSnapshot(...)). noIntl: Intl.DateTimeFormat throws, as in an engine without Intl.',
    };
}

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function recaptureChangedObservations(change: string, inputs: Record<string, unknown>, captured: Record<string, unknown>): void {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
    const frozen = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const { observations, provenance, ...frozenInputs } = frozen;
    expect(frozenInputs).toEqual(inputs);
    const recaptured = scenarios.map((scenario) => scenario.name)
        .filter((name) => JSON.stringify(captured[name]) !== JSON.stringify(observations[name]));
    for (const name of recaptured) observations[name] = captured[name];
    provenance.recaptured = [...(provenance.recaptured ?? []), {
        base: git('rev-parse', 'HEAD').trim(),
        change,
        changedFiles: git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
            .map((line) => line.slice(3).replace(/^"|"$/g, '')),
        command: 'cd apps/mobile && MINDWTR_RECAPTURE_WIDGET_PAYLOAD=\'<change>\' TZ=UTC bunx vitest run lib/widget-payload.parity.test.ts',
        runtime: `node ${process.version}, ICU ${process.versions.icu ?? 'none'}`,
        observations: recaptured,
    }];
    writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance, ...frozenInputs, observations }, null, 1)}\n`);
}

describe('React Native widget payload parity fixture', () => {
    const originalTz = process.env.TZ;
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const deviceLocale = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    beforeAll(async () => {
        process.env.TZ = 'UTC';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        deviceLocale.mockImplementation(function (this: Intl.DateTimeFormat) {
            return { ...resolvedOptions.call(this), locale: DEVICE_LOCALE };
        });
        for (const language of LANGUAGES) await loadTranslations(language);
    }, 30_000);
    afterEach(() => {
        resetFocusWidgetFilter();
        resetMobileWidgetRenderCache();
    });
    afterAll(() => {
        deviceLocale.mockRestore();
        vi.useRealTimers();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('publishes every scenario exactly as frozen', async () => {
        expect(WIDGET_LANGUAGE_KEY).toBe('mindwtr-language');
        const captured: Record<string, unknown> = {};
        for (const scenario of scenarios) captured[scenario.name] = await observe(scenario);
        const inputs = normalize({ timeZone: 'UTC', now: NOW, languages: LANGUAGES, stores: STORES, scenarios }) as Record<string, unknown>;
        if (CAPTURE) {
            writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs, observations: captured }, null, 1)}\n`);
        }
        if (RECAPTURE_CHANGE) recaptureChangedObservations(RECAPTURE_CHANGE, inputs, captured);
        const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
        expect(frozenInputs).toEqual(inputs);
        for (const scenario of scenarios) {
            expect({ [scenario.name]: captured[scenario.name] }).toEqual({ [scenario.name]: observations[scenario.name] });
        }
    }, 120_000);
});
