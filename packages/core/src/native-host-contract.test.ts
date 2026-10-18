import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createNativeHostContract,
    NATIVE_HOST_EDITOR_FIELDS,
    NATIVE_HOST_MAX_WINDOW,
    type NativeEditableFields,
    type NativeTaskDraftEdit,
    type NativeTaskDraftRecurrenceEdit,
    type NativeTaskEditorModel,
} from './native-host-contract';
import { computeGlobalSearchResults } from './global-search-filter';
import { clearGlobalSearchActiveChip, DEFAULT_GLOBAL_SEARCH_FILTERS, getGlobalSearchFilterOptions } from './global-search-model';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage, type StorageAdapter } from './storage';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, areaFilterSelectionToFilters, areaFilterSelectionToValue, cycleAreaFilterSelection, isAreaFilterSelectionActive, isTaskVisibleInArea, isTaskVisibleInInbox, resolveAreaFilterSelection, taskMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import * as projectGrouping from './project-grouping';
import * as focusDerivation from './focus-sections';
import * as projectTaskListModel from './project-task-list-model';
import * as logger from './logger';
import { formatLocalDate } from './import-source-reader';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { configureDateFormatting, getDateFormattingConfig, safeFormatDate, safeParseDate } from './date';
import { getFocusStarBlockedText } from './focus-star';
import { createMarkdownLinkLookup, resolveMarkdownBlocks } from './markdown-blocks';
import { normalizeFocusTaskLimit } from './focus-utils';
import { buildTaskRowMeta, resolveTaskRowFeatures, resolveTaskRowLookup } from './task-row-meta';
import { isTaskActionable } from './task-status';
import { splitTodayTasksByStartTime } from './task-utils';
import { createTaskDraft, setTaskDraftField, type TaskDraft } from './task-draft';
import { DEFAULT_TASK_EDITOR_HIDDEN } from './task-editor-layout';
import { buildTaskEditorModel, buildTaskEditUpdatePatch, createTaskEditDraft, getTaskEditorSuggestions } from './task-editor-model';
import { getEnglishI18nValue, getTranslator, tFallback } from './i18n';
import { getTranslationsSync } from './i18n/i18n-loader';
import { resolveLanguageFromLocale } from './i18n/i18n-storage';
import { zhHans } from './i18n/locales/zh-Hans';
import type { Language } from './i18n/i18n-types';
import type { AppSettings, Area, ChecklistItem, Project, Section, Task } from './types';
import { revisionOf, taskRevisionOf } from './native-request-receipts';
import { openScreenHost, replayAfterRestart, requestId as newRequestId, value as unwrap } from './screen-parity.replay';

const CAPTURE_ID = '123e4567-e89b-12d3-a456-426614174000';
const projectParity = JSON.parse(
    readFileSync(new URL('./project-task-list-parity.fixtures.json', import.meta.url), 'utf8'),
) as {
    projects: Project[];
    sections: Section[];
    tasks: Task[];
    mobileSnapshot: Record<string, Array<Record<string, unknown>>>;
};
const followupParity = (JSON.parse(
    readFileSync(new URL('./task-row-meta-parity.fixtures.json', import.meta.url), 'utf8'),
) as { followupSnapshot: { upcoming: Array<{
    language: Language; systemLocale: string; revealDate: string; revealLabel: string; focusBlockedLabel: string;
}>; project: Array<{
    status: Project['status']; cancelledAt: string | null; cancelled: boolean; statusLabel: string;
}> } }).followupSnapshot;

const task = (id: string, createdAt: string, extra: Partial<Task> = {}): Task => ({
    id,
    title: id,
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt,
    updatedAt: createdAt,
    ...extra,
});

const project = (id: string, status: Project['status'] = 'active', order = 0, extra: Partial<Project> = {}): Project => ({
    id,
    title: id,
    status,
    color: '#123456',
    order,
    tagIds: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
});

const area = (id: string, name: string, order: number, extra: Partial<Area> = {}): Area => ({
    id, name, order, color: '#abcdef', icon: 'home',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
});

describe('native host contract', () => {
    let saveData: ReturnType<typeof vi.fn>;
    let getData: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        saveData = vi.fn().mockResolvedValue(undefined);
        getData = vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} });
        setStorageAdapter({
            getData,
            saveData,
        } satisfies StorageAdapter);
        useTaskStore.setState({
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
        });
    });

    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    // Inbox and project pages carry a minute in their revision; paging tests keep one minute.
    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 10, 0));
    };

    const activateWith = async (tasks: Task[], projects: Project[] = []) => {
        getData.mockResolvedValue({ tasks, projects, sections: [], areas: [], people: [], settings: {} });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        return host;
    };

    it('returns the core search order, options and row meta with changing task and settings revisions', async () => {
        freezeClock();
        const tasks = [
            task('launch-next', '2026-09-01T00:00:00.000Z', { title: 'Launch plan', status: 'next', tags: ['#client'] }),
            task('launch-done', '2026-09-01T00:00:00.000Z', { title: 'Launch report', status: 'done' }),
            task('home', '2026-09-01T00:00:00.000Z', { title: 'Home errand' }),
        ];
        const projects = [project('launch-project', 'active', 0, { title: 'Launch project' })];
        getData.mockResolvedValue({ tasks, projects, sections: [], areas: [], people: [], settings: { deviceId: 'device-search' } });
        const searchAll = vi.fn(async () => ({ tasks: [tasks[2], tasks[0]], projects: [] }));
        setStorageAdapter({ getData, saveData, searchAll } satisfies StorageAdapter);
        const host = createNativeHostContract();
        expect(await host.searchTasks({ query: 'Launch', filters: DEFAULT_GLOBAL_SEARCH_FILTERS, limit: 10 }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const first = await host.searchTasks({ query: 'Launch', filters: DEFAULT_GLOBAL_SEARCH_FILTERS, limit: 10 });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const state = useTaskStore.getState();
        const direct = computeGlobalSearchResults({
            query: 'Launch', tasks: state._allTasks, projects: state.projects, areas: state.areas,
            ...DEFAULT_GLOBAL_SEARCH_FILTERS, ftsResults: { tasks: [tasks[2], tasks[0]], projects: [] }, ftsQuery: 'Launch', limit: 10,
        });
        expect(first.value.tasks.map(({ id }) => id)).toEqual(direct.results.filter((result) => result.type === 'task').map(({ item }) => item.id));
        expect(first.value.projects.map(({ id }) => id)).toEqual(direct.results.filter((result) => result.type === 'project').map(({ item }) => item.id));
        expect(Object.keys(first.value.projects[0]).sort()).toEqual(['areaId', 'cancelledAt', 'id', 'status', 'title', 'titleSegments']);
        expect(first.value.totalTasks).toBe(direct.totalTasks);
        expect(first.value.filterOptions).toEqual(getGlobalSearchFilterOptions(state._allTasks, state.areas, getTranslator('en')));
        expect(first.value.tasks[0].meta).toEqual(expect.objectContaining({ parts: expect.any(Array) }));
        expect(first.value).toMatchObject({ query: 'Launch', hiddenCompletedCount: 1, hasActiveFilters: false,
            isTruncated: false, totalResultsLabel: '3', activeChips: [] });
        expect(first.value.tasks[0]).toMatchObject({ inStore: true, canComplete: true, tap: { kind: 'editor', id: 'home' } });
        expect(first.value.tasks[1].titleSegments).toEqual(expect.arrayContaining([{ text: 'Launch', highlighted: true }]));
        expect(searchAll).toHaveBeenCalledWith('Launch');
        expect((await useTaskStore.getState().updateTask('launch-next', { title: 'Launch revised' })).success).toBe(true);
        const afterTask = await host.searchTasks({ query: 'Launch', filters: DEFAULT_GLOBAL_SEARCH_FILTERS, limit: 10 });
        expect(afterTask.ok).toBe(true);
        if (!afterTask.ok) return;
        expect(afterTask.value.revision).not.toBe(first.value.revision);
        await useTaskStore.getState().updateSettings({ weekStart: 'monday' });
        const afterSettings = await host.searchTasks({ query: 'Launch', filters: DEFAULT_GLOBAL_SEARCH_FILTERS, limit: 10 });
        expect(afterSettings.ok).toBe(true);
        if (afterSettings.ok) expect(afterSettings.value.revision).not.toBe(afterTask.value.revision);
        expect(await host.searchTasks({ query: '', filters: DEFAULT_GLOBAL_SEARCH_FILTERS, limit: 10 }))
            .toMatchObject({ ok: true, value: { tasks: [], projects: [], totalTasks: 0 } });
        expect(await host.searchTasks({ query: 'Launch', filters: DEFAULT_GLOBAL_SEARCH_FILTERS, limit: 0 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.searchTasks({ query: 'Launch', filters: { ...DEFAULT_GLOBAL_SEARCH_FILTERS, tasks: [] }, limit: 10 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.searchTasks({ query: 'Launch', filters: { ...DEFAULT_GLOBAL_SEARCH_FILTERS, tasks: null }, limit: 10 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.searchTasks({ query: 'Launch', filters: { ...DEFAULT_GLOBAL_SEARCH_FILTERS, selectedTokens: Array(501).fill('#tag') }, limit: 10 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.searchTasks({ query: 'Launch', filters: { ...DEFAULT_GLOBAL_SEARCH_FILTERS, locationQuery: 'x'.repeat(2001) }, limit: 10 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const cut = await host.searchTasks({ query: 'Launch', filters: DEFAULT_GLOBAL_SEARCH_FILTERS, limit: 1 });
        expect(cut).toMatchObject({ ok: true, value: { tasks: [], projects: [{ id: 'launch-project' }],
            totalTasks: 2, isTruncated: true, totalResultsLabel: '3' } });
    });

    it('supplies defaults, idempotent chip clears, and cancellation from the live RN task lookup', async () => {
        freezeClock();
        const host = await activateWith([
            task('cancelled', '2026-09-01T00:00:00.000Z', { status: 'archived', cancelledAt: '2026-09-02T12:00:00.000Z' }),
            task('done', '2026-09-01T00:00:00.000Z', { status: 'done' }),
            task('active', '2026-09-01T00:00:00.000Z'),
        ]);
        const all = await host.searchTasks({ query: '', filters: { ...DEFAULT_GLOBAL_SEARCH_FILTERS, includeCompleted: true }, limit: 10 });
        expect(all.ok).toBe(true);
        if (!all.ok) return;
        expect(all.value.defaultFilters).toEqual(DEFAULT_GLOBAL_SEARCH_FILTERS);
        expect(Object.fromEntries(all.value.tasks.map((row) => [row.id, row.cancelled])))
            .toEqual({ cancelled: true, done: false, active: false });
        const filters = { ...DEFAULT_GLOBAL_SEARCH_FILTERS, selectedStatuses: ['done' as const], selectedArea: 'none',
            selectedTokens: ['#client', '@office'], locationQuery: 'Office', duePreset: 'today' as const,
            scope: 'tasks' as const, includeCompleted: true, includeReference: false, hideFutureTasks: true };
        const filtered = await host.searchTasks({ query: '', filters, limit: 10 });
        expect(filtered.ok).toBe(true);
        if (!filtered.ok) return;
        expect(filtered.value.activeChips).toHaveLength(10);
        for (const chip of filtered.value.activeChips) {
            expect(chip.clearedFilters).toEqual(clearGlobalSearchActiveChip(filters, chip.key));
            expect(clearGlobalSearchActiveChip(chip.clearedFilters, chip.key)).toEqual(chip.clearedFilters);
        }
        // A direct JS consumer cannot change defaults for subsequent queries.
        all.value.defaultFilters.selectedTokens.push('#mutated');
        expect(DEFAULT_GLOBAL_SEARCH_FILTERS.selectedTokens).toEqual([]);
    });

    it('uses the RN in-memory search fallback when the adapter has no searchAll', async () => {
        freezeClock();
        const host = await activateWith([
            task('match', '2026-09-01T00:00:00.000Z', { title: 'Launch plan' }),
            task('other', '2026-09-01T00:00:00.000Z', { title: 'Home errand' }),
        ]);
        const result = await host.searchTasks({ query: 'Launch', filters: DEFAULT_GLOBAL_SEARCH_FILTERS, limit: 10 });
        expect(result).toMatchObject({ ok: true, value: { tasks: [{ id: 'match' }], totalTasks: 1, projects: [] } });
    });

    it('keeps adapter hits absent from the live store without inventing a completion date', async () => {
        freezeClock();
        const searchAll = vi.fn(async () => ({
            tasks: [{ id: 'unloaded', title: 'Launch archive', status: 'done' as const }],
            projects: [{ id: 'unloaded-project', title: 'Launch project', status: 'active' as const }],
        }));
        setStorageAdapter({ getData, saveData, searchAll } satisfies StorageAdapter);
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const result = await host.searchTasks({
            query: 'Launch', filters: { ...DEFAULT_GLOBAL_SEARCH_FILTERS, includeCompleted: true }, limit: 10,
        });
        expect(result).toMatchObject({ ok: true, value: {
            projects: [{ id: 'unloaded-project' }], tasks: [{ id: 'unloaded' }], totalTasks: 1,
        } });
        if (result.ok) expect(result.value.tasks[0]).toMatchObject({ inStore: false, cancelled: false, meta: null,
            date: null, canComplete: false, tap: { kind: 'list', route: '/done', id: 'unloaded' } });
    });

    it('saves one search per request, reuses an existing query, and retries a failed save', async () => {
        freezeClock();
        getData.mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device-search' } });
        const host = createNativeHostContract();
        const request = { query: ' Launch ', name: '  Launch shortcut  ', requestId: CAPTURE_ID };
        expect(await host.saveSearch(request)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        saveData.mockRejectedValue(new Error('disk full'));
        const failed = await host.saveSearch(request);
        expect(failed).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState().settings.savedSearches).toHaveLength(1);
        saveData.mockResolvedValue(undefined);
        const retry = await host.saveSearch(request);
        // The request UUID names the new search.
        expect(retry).toEqual({ ok: true, value: { id: CAPTURE_ID, existing: false } });
        if (!retry.ok) return;
        expect(useTaskStore.getState().settings.savedSearches).toHaveLength(1);
        expect(useTaskStore.getState().settings.savedSearches?.[0]).toEqual({ id: retry.value.id, name: 'Launch shortcut', query: 'Launch' });
        expect(await host.saveSearch(request)).toEqual(retry);
        const calls = saveData.mock.calls.length;
        expect(await host.saveSearch({ query: 'Launch', requestId: '123e4567-e89b-12d3-a456-426614174001' }))
            .toEqual({ ok: true, value: { id: retry.value.id, existing: true } });
        expect(saveData).toHaveBeenCalledTimes(calls);
        const retryPersistence = useTaskStore.getState().retryPersistence;
        const retryFailure = vi.fn().mockRejectedValue(new Error('disk full again'));
        useTaskStore.setState({ persistenceFailure: { message: 'disk full again', failedAt: '2026-09-23T12:00:00.000Z', retrying: false },
            retryPersistence: retryFailure });
        expect(await host.saveSearch({ query: 'Launch', requestId: '123e4567-e89b-12d3-a456-426614174002' }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(retryFailure).toHaveBeenCalledOnce();
        useTaskStore.setState({ retryPersistence });
        expect(await host.saveSearch({ query: 'Launch', requestId: '123e4567-e89b-12d3-a456-426614174002' }))
            .toEqual({ ok: true, value: { id: retry.value.id, existing: true } });
        expect(await host.saveSearch({ query: ' New ', name: '   ', requestId: '123e4567-e89b-12d3-a456-426614174003' }))
            .toMatchObject({ ok: true, value: { existing: false } });
        expect(useTaskStore.getState().settings.savedSearches?.[1].name).toBe('New');
        expect(await host.saveSearch({ query: 'Launch', name: 'Changed', requestId: CAPTURE_ID }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.saveSearch({ query: 'Another', requestId: CAPTURE_ID }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('resolves stored and system languages like mobile and loads strings before returning', async () => {
        const host = createNativeHostContract();
        expect(host.getStrings({ keys: ['common.save'] })).toEqual({
            ok: true, value: { language: 'en', strings: { 'common.save': 'Save' }, missing: [] },
        });
        for (const [storedLanguage, systemLocale, expected] of [
            ['zh', 'ja-JP', 'zh'],
            ['unsupported', 'ja-JP', 'ja'],
            [null, 'ja-JP', 'ja'],
            [null, 'zh-TW', 'zh-Hant'],
            [null, 'fr-FR', 'en'],
            [null, null, 'en'],
        ] as const) {
            expect(await host.setLanguage({ storedLanguage, systemLocale }))
                .toEqual({ ok: true, value: { language: expected } });
            if (expected === 'zh') {
                expect(host.getStrings({ keys: ['common.save'] })).toEqual({
                    ok: true, value: { language: 'zh', strings: { 'common.save': '保存' }, missing: [] },
                });
            }
            if (systemLocale === 'fr-FR') expect(expected).toBe(resolveLanguageFromLocale(systemLocale));
        }
    });

    it('falls back to English, reports missing keys, and validates string requests', async () => {
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: null })).toMatchObject({ ok: true });
        const fallbackKey = 'common.save';
        const zh = getTranslationsSync('zh');
        const saved = zh[fallbackKey];
        delete zh[fallbackKey];
        try {
            expect(host.getStrings({ keys: [fallbackKey, 'not.a.real.key'] })).toEqual({
                ok: true,
                value: {
                    language: 'zh',
                    strings: { [fallbackKey]: getEnglishI18nValue(fallbackKey) },
                    missing: ['not.a.real.key'],
                },
            });
        } finally {
            zh[fallbackKey] = saved;
        }
        for (const input of [null, {}, { keys: 'common.save' }, { keys: [1] }, { keys: Array(501).fill('common.save') }]) {
            expect(host.getStrings(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        for (const input of [null, {}, { storedLanguage: 1, systemLocale: null }, { storedLanguage: null, systemLocale: 1 }]) {
            expect(await host.setLanguage(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('pages deterministic visible Inbox rows and rejects a stale revision after order or membership changes', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        freezeClock();
        useTaskStore.setState({ _allTasks: [
            task('later', '2026-09-03T00:00:00.000Z'),
            task('first', '2026-09-01T00:00:00.000Z'),
            task('middle', '2026-09-02T00:00:00.000Z'),
            task('other-status', '2026-09-01T00:00:00.000Z', { status: 'next' }),
        ] });
        const first = host.getInboxWindow({ offset: 0, limit: 2 });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.value.total).toBe(3);
        expect(first.value.rows.map(({ id }) => id)).toEqual(['first', 'middle']);
        expect(first.value.rows[0]).toEqual({
            id: 'first', title: 'first', status: 'inbox', priority: null, dueDate: null,
            startTime: null, isFocusedToday: false, projectTitle: null, hasNotes: false, revealDate: null, revealLabel: null, laterToday: false,
            taskRevision: '0::2026-09-01T00:00:00.000Z',
            meta: expect.objectContaining({ parts: [], statusLabel: 'Inbox' }),
        });
        expect(host.getInboxWindow({ offset: 2, limit: 2, revision: first.value.revision }))
            .toMatchObject({ ok: true, value: { rows: [{ id: 'later' }], total: 3 } });

        expect((await useTaskStore.getState().updateTask('later', { dueDate: '2026-09-01' })).success).toBe(true);
        await flushPendingSave();
        expect(host.getInboxWindow({ offset: 2, limit: 2, revision: first.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const reordered = host.getInboxWindow({ offset: 0, limit: 2 });
        expect(reordered).toMatchObject({ ok: true, value: { rows: [{ id: 'later' }, { id: 'first' }] } });
        if (!reordered.ok) return;

        expect((await useTaskStore.getState().updateTask('first', { status: 'next' })).success).toBe(true);
        await flushPendingSave();
        expect(host.getInboxWindow({ offset: 2, limit: 2, revision: reordered.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getInboxWindow({ offset: 0, limit: 2 })).toMatchObject({ ok: true, value: { total: 2 } });
        expect(host.getInboxWindow({ offset: 1, limit: 2 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getInboxWindow({ offset: 0, limit: NATIVE_HOST_MAX_WINDOW + 1 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.createInboxTask({ title: 'New', captureId: 'bad' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        const beforeSort = host.getInboxWindow({ offset: 0, limit: 1 });
        if (!beforeSort.ok) return;
        useTaskStore.setState({ settings: { taskSortBy: 'created-desc' } });
        expect(host.getInboxWindow({ offset: 1, limit: 1, revision: beforeSort.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getInboxWindow({ offset: 0, limit: 2 }))
            .toMatchObject({ ok: true, value: { rows: [{ id: 'later' }, { id: 'middle' }] } });
    });

    it('invalidates Inbox paging when a project becomes inactive', async () => {
        const project: Project = {
            id: 'project', title: 'Project', status: 'active', color: '#123456', order: 0,
            tagIds: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        };
        getData.mockResolvedValue({
            tasks: [task('in-project', '2026-09-01T00:00:00.000Z', { projectId: project.id })],
            projects: [project], sections: [], areas: [], people: [], settings: {},
        });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        const first = host.getInboxWindow({ offset: 0, limit: 1 });
        expect(first).toMatchObject({ ok: true, value: { total: 1, rows: [{ projectTitle: 'Project' }] } });
        if (!first.ok) return;
        useTaskStore.setState({ _allProjects: [{ ...project, status: 'archived' }] });
        expect(host.getInboxWindow({ offset: 1, limit: 1, revision: first.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getInboxWindow({ offset: 0, limit: 1 }))
            .toMatchObject({ ok: true, value: { total: 0, rows: [] } });
    });

    it('matches mobile Projects grouping and core summaries, caching until an area or task changes', async () => {
        const areas = [
            area('later', 'Later', 2), area('zeta', 'Zeta', 1), area('alpha', 'Alpha', 1),
            area('deleted-area', 'Deleted', 0, { deletedAt: '2026-09-02T00:00:00.000Z' }),
        ];
        const projects = [
            project('alpha-regular', 'active', 0, { areaId: 'alpha' }),
            project('alpha-focused', 'active', 9, { areaId: 'alpha', isFocused: true }),
            project('zeta-active', 'active', 0, { areaId: 'zeta' }),
            project('later-active', 'active', 0, { areaId: 'later' }),
            project('orphan', 'active', 0, { areaId: 'deleted-area', isFocused: true }),
            project('waiting', 'waiting', 0, { areaId: 'zeta' }),
            project('someday', 'someday', 0, { areaId: 'later' }),
            project('archived', 'archived', 0, { areaId: 'alpha' }),
            project('deleted-project', 'active', 0, { areaId: 'alpha', deletedAt: '2026-09-02T00:00:00.000Z' }),
        ];
        getData.mockResolvedValue({
            tasks: [
                task('focused-waiting', '2026-09-01T00:00:00.000Z', { projectId: 'alpha-focused', status: 'waiting' }),
                task('regular-next', '2026-09-01T00:00:00.000Z', { projectId: 'alpha-regular', status: 'next', title: 'Next step' }),
                task('regular-done', '2026-09-01T00:00:00.000Z', { projectId: 'alpha-regular', status: 'done' }),
            ],
            projects, sections: [], areas, people: [], settings: {},
        });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        const state = useTaskStore.getState();
        const independentlyOrderedAreas = [...state.areas]
            .filter((item) => !item.deletedAt)
            .sort((a, b) => a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name));
        const mobileGroups = projectGrouping.buildProjectGroups({
            projects: state.projects,
            orderedAreas: independentlyOrderedAreas,
            areaFilter: resolveAreaFilterSelection(undefined, independentlyOrderedAreas),
            tagFilter: { kind: 'all' },
            pinFocused: true,
        });
        const groupCalls = vi.spyOn(projectGrouping, 'buildProjectGroups');
        const first = host.getProjects();
        if (!first.ok) throw new Error('Projects query failed');
        const shape = (groups: { areaId: string | null; projects: { id: string }[] }[]) =>
            groups.map(({ areaId, projects: rows }) => ({ areaId, ids: rows.map(({ id }) => id) }));
        for (const key of ['active', 'deferred', 'archived'] as const) {
            expect(shape(first.value[key])).toEqual(shape(mobileGroups[key].map((group) => ({
                areaId: group.areaId ?? null, projects: group.projects,
            }))));
        }
        expect(shape(first.value.active)).toEqual([
            { areaId: 'alpha', ids: ['alpha-focused', 'alpha-regular'] },
            { areaId: 'zeta', ids: ['zeta-active'] },
            { areaId: 'later', ids: ['later-active'] },
            { areaId: null, ids: ['orphan'] },
        ]);
        expect(first.value.active[0]).toMatchObject({ areaName: 'Alpha', areaColor: '#abcdef', areaIcon: 'home' });
        expect(first.value.active[3]).toMatchObject({ areaName: null, areaColor: null, areaIcon: null });
        const summaryById = state.getDerivedState().projectTaskSummaryById;
        for (const row of [...first.value.active, ...first.value.deferred, ...first.value.archived].flatMap((group) => group.projects)) {
            const summary = summaryById.get(row.id);
            expect(row).toMatchObject({
                activeTaskCount: summary?.activeTaskCount ?? 0,
                nextActionId: summary?.nextAction?.id ?? null,
                nextActionTitle: summary?.nextAction?.title ?? null,
                focusedWithoutNextAction: row.id === 'orphan',
                color: '#123456',
            });
        }
        expect(first.value.active[0].projects[0]).toMatchObject({
            id: 'alpha-focused', isFocused: true, activeTaskCount: 1,
            nextActionId: null, nextActionTitle: null, focusedWithoutNextAction: false,
        });
        expect(first.value.active[0].projects[1]).toMatchObject({
            id: 'alpha-regular', nextActionId: 'regular-next', nextActionTitle: 'Next step',
        });
        const unchanged = host.getProjects();
        expect(unchanged).toMatchObject({ ok: true, value: { revision: first.value.revision } });
        if (!unchanged.ok) throw new Error('Projects query failed');
        expect(unchanged.value).toBe(first.value);
        expect(groupCalls).toHaveBeenCalledTimes(1);

        expect((await useTaskStore.getState().updateArea('alpha', { name: 'Renamed' })).success).toBe(true);
        const renamed = host.getProjects();
        if (!renamed.ok) throw new Error('Projects query failed after area rename');
        expect(renamed.value.revision).not.toBe(first.value.revision);
        expect(renamed.value.active[0].areaName).toBe('Renamed');
        expect(groupCalls).toHaveBeenCalledTimes(2);
        expect((await useTaskStore.getState().updateTask('regular-next', { title: 'Edited step' })).success).toBe(true);
        const edited = host.getProjects();
        if (!edited.ok) throw new Error('Projects query failed after task edit');
        expect(edited.value.revision).not.toBe(renamed.value.revision);
        expect(edited.value.active[0].projects[1].nextActionTitle).toBe('Edited step');
        expect(groupCalls).toHaveBeenCalledTimes(3);
    });

    it('exposes the captured React Native project status lines and cancelled flag', async () => {
        const projects = followupParity.project.map((expected, index) => project(`status-${index}`, expected.status, index, {
            cancelledAt: expected.cancelledAt ?? undefined,
        }));
        const host = await activateWith([], projects);
        const result = host.getProjects();
        if (!result.ok) throw new Error('Projects query failed');
        const rows = [...result.value.active, ...result.value.deferred, ...result.value.archived]
            .flatMap((group) => group.projects);
        for (const [index, expected] of followupParity.project.entries()) {
            expect(rows.find(({ id }) => id === `status-${index}`)).toMatchObject({
                cancelled: expected.cancelled,
                statusLabel: expected.statusLabel,
            });
        }
        expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: 'zh-CN' })).toMatchObject({ ok: true });
        const chinese = host.getProjects();
        if (!chinese.ok) throw new Error('Chinese Projects query failed');
        expect(chinese.value.revision).not.toBe(result.value.revision);
        expect(chinese.value.archived.flatMap(({ projects: items }) => items).find(({ id }) => id === 'status-4')?.statusLabel)
            .toBe(getTranslator('zh')('projects.cancelled'));
    });

    describe('project detail', () => {
        // The store state mobile's snapshot rendered from; a real load would run
        // migrations (for example auto-archiving old Done tasks) first.
        const activateParity = async () => {
            const host = createNativeHostContract();
            expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
            useTaskStore.setState({
                _allTasks: projectParity.tasks, _allProjects: projectParity.projects, _allSections: projectParity.sections,
            });
            freezeClock();
            return host;
        };
        const detail = (host: ReturnType<typeof createNativeHostContract>, projectId: string, limit = NATIVE_HOST_MAX_WINDOW) => {
            const result = host.getProjectDetail({ projectId, offset: 0, limit });
            if (!result.ok) throw new Error(`Project detail failed: ${result.error.code}`);
            return result.value;
        };

        const expectMobileParity = (value: ReturnType<typeof detail>, scenario: string) => {
            // #1401 corrects the Reference pile's title order without rewriting
            // the historical mobile capture used by the other parity scenarios.
            const mobile = projectParity.mobileSnapshot[scenario].map((item) => {
                if (scenario !== 'live-sorted-title') return item;
                if (item.id === 'live-ref') return { ...item, id: 'loose-ref-tag' };
                if (item.id === 'loose-ref-tag') return { ...item, id: 'live-ref' };
                return item;
            });
            expect(value.total).toBe(mobile.length);
            expect(value.items.map((item) => (item.type === 'section'
                ? { type: 'section', id: item.id, count: item.count, muted: item.muted }
                : { type: 'task', id: item.row.id, sectionId: item.sectionId, sequenceCue: item.sequenceCue })))
                .toEqual(mobile.map((item) => (item.type === 'section'
                    ? { type: 'section', id: item.id, count: item.count, muted: item.muted === true }
                    : {
                        type: 'task', id: item.id,
                        sectionId: item.reorderSectionId === 'undefined' ? null : item.reorderSectionId,
                        sequenceCue: item.sequenceCue,
                    })));
        };
        const setProjectSort = (sorts: Record<string, Project['taskSortBy']>) => useTaskStore.setState({
            _allProjects: projectParity.projects.map((item) => (item.id in sorts ? { ...item, taskSortBy: sorts[item.id] } : item)),
        });

        it('pages the mobile project list as it opens, with section markers and sequence cues', async () => {
            const host = await activateParity();
            for (const [projectId, scenario] of [
                ['p-live', 'live-default'], ['p-archived', 'archived-default'], ['p-seq', 'sequential-default'],
            ] as const) {
                expectMobileParity(detail(host, projectId), scenario);
            }
            const live = detail(host, 'p-live');
            expect(live).toMatchObject({ version: 1, projectId: 'p-live', readOnly: false });
            expect(live.items.filter((item) => item.type === 'section').map((item) => item.title))
                .toEqual(['Design', 'Build', 'No Section', 'Reference']);
            expect(live.items[1]).toEqual({
                type: 'task',
                row: {
                    id: 'live-a1', title: 'Sketch', status: 'next', priority: null, dueDate: null, startTime: null,
                    isFocusedToday: false, projectTitle: 'Launch', hasNotes: false, revealDate: null, revealLabel: null, laterToday: false,
                    taskRevision: '0::2026-09-01T00:00:00.000Z',
                    meta: expect.objectContaining({ statusLabel: 'Next', accessibilityLabel: 'Sketch. Status: Next' }),
                },
                sectionId: 'sec-a',
                sequenceCue: null,
            });
            expect(detail(host, 'p-archived').readOnly).toBe(true);
            expect(detail(host, 'p-seq').items.map((item) => (item.type === 'task' ? item.sequenceCue : item.id)))
                .toEqual(['available', 'later', null, 'later']);
        });

        it('returns RN Details metadata on every page without writes, and invalidates changed display inputs', async () => {
            const host = await activateParity();
            useTaskStore.setState({
                _allProjects: projectParity.projects.map((item) => item.id === 'p-live'
                    ? { ...item, areaId: 'work', tagIds: ['#one', '#two'], isSequential: true,
                        sequentialScope: 'section' as const, startDate: 'invalid-date', dueDate: '2026-09-15' }
                    : item),
                _allAreas: [area('work', 'Work', 0)],
            });
            const state = useTaskStore.getState();
            const dataBefore = JSON.stringify([state._allTasks, state._allProjects, state._allSections, state._allAreas]);
            saveData.mockClear();
            const first = detail(host, 'p-live', 1);
            expect(first.metadata).toMatchObject({
                summary: 'Active · Sequential · Work · 3 Sections',
                statusLabel: 'Active', typeLabel: 'Sequential', sequentialScopeLabel: 'Within sections',
                areaLabel: 'Work', tagsLabel: '#one, #two', startDateLabel: 'invalid-date',
                hasReviewDate: false,
                sections: [{ id: 'sec-a', title: 'Design' }, { id: 'sec-empty', title: 'Empty' },
                    { id: 'sec-b', title: 'Build' }],
            });
            expect(first.metadata.dueDateLabel).toBe(new Date(2026, 8, 15).toLocaleDateString());
            const later = host.getProjectDetail({ projectId: 'p-live', offset: 1, limit: 1, revision: first.revision });
            expect(later).toMatchObject({ ok: true, value: { metadata: first.metadata } });
            expect(detail(host, 'p-archived').metadata.sections).toEqual([{ id: 'arch-kept', title: 'Kept history' }]);
            expect(JSON.stringify([state._allTasks, state._allProjects, state._allSections, state._allAreas])).toBe(dataBefore);
            expect(saveData).not.toHaveBeenCalled();

            useTaskStore.setState({ _allAreas: [area('work', 'Renamed Area', 0)] });
            expect(host.getProjectDetail({ projectId: 'p-live', offset: 1, limit: 1, revision: first.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const changed = detail(host, 'p-live', 1);
            expect(changed.metadata.areaLabel).toBe('Renamed Area');
            useTaskStore.setState({ _allAreas: [area('work', 'Deleted Area', 0, {
                deletedAt: '2026-09-16T00:00:00.000Z',
            })] });
            const withoutArea = detail(host, 'p-live', 1);
            expect(withoutArea.metadata.areaLabel).toBe('No area');
            useTaskStore.setState({ _allSections: state._allSections.map((section) =>
                section.id === 'sec-a' ? { ...section, title: 'Design changed' } : section) });
            expect(host.getProjectDetail({ projectId: 'p-live', offset: 1, limit: 1, revision: withoutArea.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const changedSection = detail(host, 'p-live', 1);
            expect(changedSection.metadata.sections[0].title).toBe('Design changed');
            useTaskStore.setState({ _allProjects: state._allProjects.map((item) =>
                item.id === 'p-live' ? { ...item, tagIds: ['#changed'], reviewAt: 'invalid-review' } : item) });
            expect(host.getProjectDetail({ projectId: 'p-live', offset: 1, limit: 1, revision: changedSection.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(detail(host, 'p-live', 1).metadata).toMatchObject({
                tagsLabel: '#changed', reviewDateLabel: 'invalid-review', hasReviewDate: true,
            });
            expect(saveData).not.toHaveBeenCalled();
        });

        it('binds Project flow options to the displayed mutation revision without expiring edits on clock changes', async () => {
            const host = await activateParity();
            const read = () => {
                const options = host.getProjectFlowOptions({ projectId: 'p-live' });
                if (!options.ok) throw new Error(`Project flow options failed: ${options.error.code}`);
                const notes = host.getProjectNotesEditOptions({ projectId: 'p-live' });
                if (!notes.ok) throw new Error(`Project Notes options failed: ${notes.error.code}`);
                const projectDetail = detail(host, 'p-live', 1);
                expect(notes.value.revision).toBe(projectDetail.mutationRevision);
                return { options: options.value, detail: projectDetail };
            };
            const first = read();
            expect(first.options.revision).toBe(first.detail.mutationRevision);

            vi.setSystemTime(new Date(2026, 8, 23, 10, 1));
            const nextMinute = read();
            expect(nextMinute.options.revision).toBe(nextMinute.detail.mutationRevision);
            expect(nextMinute.options.revision).toBe(first.options.revision);
            expect(nextMinute.detail.revision).not.toBe(first.detail.revision);

            useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((project) =>
                project.id === 'p-live' ? { ...project, rev: (project.rev ?? 0) + 1 } : project) }));
            const changedProject = read();
            expect(changedProject.options.revision).toBe(changedProject.detail.mutationRevision);
            expect(changedProject.options.revision).not.toBe(nextMinute.options.revision);

            useTaskStore.setState({ settings: { dateFormat: 'ymd' } });
            const changedSettings = read();
            expect(changedSettings.options.revision).toBe(changedSettings.detail.mutationRevision);
            expect(changedSettings.options.revision).not.toBe(changedProject.options.revision);

            expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: 'zh-CN' }))
                .toMatchObject({ ok: true });
            const changedLanguage = read();
            expect(changedLanguage.options.revision).toBe(changedLanguage.detail.mutationRevision);
            expect(changedLanguage.options.revision).not.toBe(changedSettings.options.revision);
        });

        it('follows the saved project sort like mobile, dropping sequence cues off the default sort', async () => {
            const host = await activateParity();
            setProjectSort({ 'p-live': 'title', 'p-seq': 'title' });
            expectMobileParity(detail(host, 'p-live'), 'live-sorted-title');
            const sequentialByTitle = detail(host, 'p-seq');
            expect(sequentialByTitle.items.map((item) => (item.type === 'task' ? item.row.id : item.id)))
                .toEqual(['seq-1', 'seq-2', 'seq-5', 'seq-3']);
            expect(sequentialByTitle.items.every((item) => item.type === 'task' && item.sequenceCue === null)).toBe(true);

            // A time-estimate sort (a valid, feature-gated project sort) falls back to project
            // order while Time estimates is off.
            setProjectSort({ 'p-seq': 'timeEstimate' });
            useTaskStore.setState({ settings: { features: { timeEstimates: false } } });
            const estimatesOff = detail(host, 'p-seq');
            expectMobileParity(estimatesOff, 'sequential-default');
            useTaskStore.setState({ settings: { features: { timeEstimates: true } } });
            expect(host.getProjectDetail({ projectId: 'p-seq', offset: 1, limit: 1, revision: estimatesOff.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(detail(host, 'p-seq').items.every((item) => item.type === 'task' && item.sequenceCue === null)).toBe(true);
        });

        it('windows items, rejects stale pages, and reports a missing or deleted project', async () => {
            const host = await activateParity();
            const full = detail(host, 'p-live');
            const first = host.getProjectDetail({ projectId: 'p-live', offset: 0, limit: 4 });
            if (!first.ok) throw new Error('First page failed');
            expect(first.value.total).toBe(full.total);
            const pages = [...first.value.items];
            for (let offset = 4; offset < full.total; offset += 4) {
                const page = host.getProjectDetail({ projectId: 'p-live', offset, limit: 4, revision: first.value.revision });
                if (!page.ok) throw new Error(`Page ${offset} failed`);
                expect(page.value.revision).toBe(first.value.revision);
                pages.push(...page.value.items);
            }
            expect(pages).toEqual(full.items);
            expect(host.getProjectDetail({ projectId: 'p-live', offset: full.total, limit: 4, revision: first.value.revision }))
                .toMatchObject({ ok: true, value: { items: [], total: full.total } });

            expect((await useTaskStore.getState().updateTask('live-u1', { title: 'Renamed' })).success).toBe(true);
            await flushPendingSave();
            expect(host.getProjectDetail({ projectId: 'p-live', offset: 4, limit: 4, revision: first.value.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });

            expect(host.getProjectDetail({ projectId: 'missing', offset: 0, limit: 4 }))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            expect((await useTaskStore.getState().deleteProject('p-other')).success).toBe(true);
            await flushPendingSave();
            expect(host.getProjectDetail({ projectId: 'p-other', offset: 0, limit: 4 }))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });

            for (const input of [
                null, {}, { projectId: '', offset: 0, limit: 1 }, { projectId: 'p-live', offset: -1, limit: 1 },
                { projectId: 'p-live', offset: 0, limit: 0 }, { projectId: 'p-live', offset: 0, limit: NATIVE_HOST_MAX_WINDOW + 1 },
                { projectId: 'p-live', offset: 1, limit: 1 }, { projectId: 'p-live', offset: 0, limit: 1, revision: 1 },
            ]) {
                expect(host.getProjectDetail(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
        });

        it('translates section titles and invalidates the English revision after a language change', async () => {
            const host = await activateParity();
            const english = detail(host, 'p-live');
            expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: null }))
                .toEqual({ ok: true, value: { language: 'zh' } });
            const chinese = detail(host, 'p-live');
            expect(chinese.revision).not.toBe(english.revision);
            expect(chinese.items.filter((item) => item.type === 'section').map((item) => item.title))
                .toEqual(['Design', 'Build', zhHans['projects.noSection'], zhHans['status.reference']]);
            expect(chinese.metadata.statusLabel).toBe(zhHans['status.active']);
            expect(host.getProjectDetail({ projectId: 'p-live', offset: 1, limit: 1, revision: english.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        });

        it('builds each project list once per revision', async () => {
            const host = await activateParity();
            const build = vi.spyOn(projectTaskListModel, 'buildProjectTaskListModel');
            const first = detail(host, 'p-live');
            expect(detail(host, 'p-live')).toEqual(first);
            expect(host.getProjectDetail({ projectId: 'p-live', offset: 2, limit: 2, revision: first.revision }).ok).toBe(true);
            expect(build).toHaveBeenCalledTimes(1);
            detail(host, 'p-seq');
            expect(build).toHaveBeenCalledTimes(2);
        });
    });

    describe('project notes', () => {
        const read = (host: ReturnType<typeof createNativeHostContract>, projectId: string,
            offset = 0, limit = NATIVE_HOST_MAX_WINDOW, revision?: string) => {
            const result = host.getProjectNotes({ projectId, offset, limit, revision });
            if (!result.ok) throw new Error(`Project notes failed: ${result.error.code}`);
            return result.value;
        };

        it('pages the shared Markdown resolver without changing raw notes or saving', async () => {
            const raw = '\n# Intro\n\nSee [[task:live|Live task]], [[task:gone|Gone task]], '
                + '[[project:linked|Linked project]], [[project:deleted|Gone project]], '
                + '[Web](https://example.org), and [Unsafe](javascript:alert(1)).\n'
                + '- [x] Finished\n- [ ] Open\n```\nconst x = 1;\n```\n';
            const projects = [project('notes', 'active', 0, { title: 'Notes', supportNotes: raw }),
                project('linked'), project('deleted', 'active', 0, { deletedAt: '2026-09-02T00:00:00.000Z' })];
            const tasks = [task('live', '2026-09-01T00:00:00.000Z', { projectId: 'notes' }),
                task('gone', '2026-09-01T00:00:00.000Z', { deletedAt: '2026-09-02T00:00:00.000Z' })];
            const host = await activateWith(tasks, projects);
            saveData.mockClear();
            const expected = resolveMarkdownBlocks(raw, createMarkdownLinkLookup(tasks, projects));
            const first = read(host, 'notes', 0, 2);
            expect(first).toMatchObject({ version: 1, projectId: 'notes', readOnly: false, direction: 'ltr',
                total: expected.length, blocks: expected.slice(0, 2) });
            expect(first.blocks[0].type).toBe('blank');
            const pages = [...first.blocks];
            for (let offset = 2; offset < first.total; offset += 2) {
                const page = read(host, 'notes', offset, 2, first.revision);
                expect(page).toMatchObject({ revision: first.revision, projectId: 'notes', readOnly: false,
                    direction: 'ltr', total: first.total, markdownLabels: first.markdownLabels });
                pages.push(...page.blocks);
            }
            expect(pages).toEqual(expected);
            expect(read(host, 'notes', first.total, 2, first.revision).blocks).toEqual([]);
            expect(JSON.stringify(pages)).toContain('"deletedReference"');
            expect(JSON.stringify(pages)).toContain('"entityType":"project"');
            expect(JSON.stringify(pages)).toContain('"checked":true');
            expect(JSON.stringify(pages)).not.toContain('"href":"javascript:');
            expect(first.markdownLabels).toEqual({ deletedTask: 'deleted task', deletedProject: 'deleted project',
                copyCode: 'Copy code' });
            expect(useTaskStore.getState()._allProjects.find((entry) => entry.id === 'notes')?.supportNotes).toBe(raw);
            expect(saveData).not.toHaveBeenCalled();
        });

        it('keeps empty notes empty, resolves title-plus-notes direction, and reads archived/cancelled projects', async () => {
            const host = await activateWith([], [project('blank', 'active', 0, { title: 'مرحبا', supportNotes: '  \n  ' }),
                project('archived', 'archived', 0, { title: 'Archive', supportNotes: '  note  ' }),
                project('cancelled', 'archived', 0, { title: 'Cancel', supportNotes: 'left',
                    cancelledAt: '2026-09-02T00:00:00.000Z' }),
                project('rtl-body', 'active', 0, { title: 'English', supportNotes: 'سلام' })]);
            expect(read(host, 'blank')).toMatchObject({ direction: 'rtl', readOnly: false, total: 0, blocks: [] });
            expect(read(host, 'archived')).toMatchObject({ direction: 'ltr', readOnly: true,
                blocks: resolveMarkdownBlocks('  note  ', createMarkdownLinkLookup([], useTaskStore.getState()._allProjects)) });
            expect(read(host, 'cancelled')).toMatchObject({ direction: 'ltr', readOnly: true, total: 1 });
            expect(read(host, 'rtl-body')).toMatchObject({ direction: 'rtl', readOnly: false, total: 1 });
            expect(host.getProjectNotes({ projectId: 'missing', offset: 0, limit: 1 }))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((entry) => entry.id === 'cancelled'
                ? { ...entry, deletedAt: '2026-09-03T00:00:00.000Z' } : entry) }));
            expect(host.getProjectNotes({ projectId: 'cancelled', offset: 0, limit: 1 }))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            useTaskStore.setState((state) => ({ _allProjects: [...state._allProjects,
                project('purged', 'active', 0, { purgedAt: '2026-09-03T00:00:00.000Z' })] }));
            expect(useTaskStore.getState()._allProjects.find((entry) => entry.id === 'purged')?.purgedAt).toBeDefined();
            expect(host.getProjectNotes({ projectId: 'purged', offset: 0, limit: 1 }))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        });

        it('projects direction from the current raw Notes draft without saving or changing stored Notes', async () => {
            const host = await activateWith([], [
                project('english', 'active', 0, { title: 'English', supportNotes: 'Stored English' }),
                project('arabic-saved', 'active', 1, { title: 'English', supportNotes: 'سلام محفوظ' }),
                project('arabic-title', 'active', 2, { title: 'مرحبا', supportNotes: 'Stored English' }),
                project('deleted', 'active', 3, { deletedAt: '2026-09-03T00:00:00.000Z' }),
                project('purged', 'active', 4, { purgedAt: '2026-09-03T00:00:00.000Z' }),
            ]);
            await flushPendingSave();
            saveData.mockClear();
            const before = structuredClone(useTaskStore.getState()._allProjects);
            const direction = (projectId: string, text: string) =>
                host.getProjectNotesDraftDirection({ projectId, text });
            expect(direction('english', '  سلام جديد  ')).toEqual({ ok: true, value: { direction: 'rtl' } });
            expect(direction('arabic-saved', 'English replacement')).toEqual({ ok: true, value: { direction: 'ltr' } });
            expect(direction('arabic-title', 'English replacement')).toEqual({ ok: true, value: { direction: 'rtl' } });
            expect(direction('english', '')).toEqual({ ok: true, value: { direction: 'ltr' } });
            for (const locale of ['ar', 'fa'] as const) {
                expect(await host.setLanguage({ storedLanguage: locale, systemLocale: 'en-US' }))
                    .toMatchObject({ ok: true, value: { language: locale } });
                expect(direction('english', 'English replacement')).toEqual({ ok: true, value: { direction: 'rtl' } });
            }
            expect(direction('missing', 'draft')).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(direction('deleted', 'draft')).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(direction('purged', 'draft')).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            for (const malformed of [null, { projectId: '', text: 'draft' },
                { projectId: 'x'.repeat(501), text: 'draft' }, { projectId: 'english' },
                { projectId: 'english', text: null }, { projectId: 'english', text: 'draft', extra: true },
                { projectId: 'english', text: '漢'.repeat(700_000) }]) {
                expect(host.getProjectNotesDraftDirection(malformed as never))
                    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(useTaskStore.getState()._allProjects).toEqual(before);
            expect(saveData).not.toHaveBeenCalled();
        });

        it('rejects stale pages after note, reference, settings, or language changes but not a clock tick', async () => {
            const host = await activateWith([task('linked', '2026-09-01T00:00:00.000Z')],
                [project('notes', 'active', 0, { supportNotes: '[[task:linked|Link]]\n\nTail' })]);
            freezeClock();
            const first = read(host, 'notes', 0, 1);
            expect(read(host, 'notes', 1, 1, first.revision).revision).toBe(first.revision);
            vi.setSystemTime(new Date(2026, 8, 24, 0, 0));
            expect(read(host, 'notes', 1, 1, first.revision).revision).toBe(first.revision);
            useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((entry) => entry.id === 'linked'
                ? { ...entry, deletedAt: '2026-09-24T00:00:00.000Z' } : entry) }));
            expect(host.getProjectNotes({ projectId: 'notes', offset: 1, limit: 1, revision: first.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const withoutReference = read(host, 'notes', 0, 1);
            expect(JSON.stringify(withoutReference.blocks)).toContain('deletedReference');
            useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((entry) => entry.id === 'notes'
                ? { ...entry, supportNotes: 'Changed\n\nTail' } : entry) }));
            expect(host.getProjectNotes({ projectId: 'notes', offset: 1, limit: 1, revision: withoutReference.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const changedNotes = read(host, 'notes', 0, 1);
            useTaskStore.setState({ settings: { dateFormat: 'ymd' } });
            expect(host.getProjectNotes({ projectId: 'notes', offset: 1, limit: 1, revision: changedNotes.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const changedSettings = read(host, 'notes', 0, 1);
            expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: 'zh-CN' })).toMatchObject({ ok: true });
            expect(host.getProjectNotes({ projectId: 'notes', offset: 1, limit: 1, revision: changedSettings.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        });

        it('rejects malformed windows and oversized raw or resolved pages without truncating source', async () => {
            const host = await activateWith([], [project('notes', 'active', 0, { supportNotes: 'One\n\nTwo' })]);
            saveData.mockClear();
            for (const input of [null, {}, { projectId: '', offset: 0, limit: 1 },
                { projectId: 'notes', offset: -1, limit: 1 }, { projectId: 'notes', offset: 0, limit: 0 },
                { projectId: 'notes', offset: 0, limit: NATIVE_HOST_MAX_WINDOW + 1 },
                { projectId: 'notes', offset: 1, limit: 1 },
                { projectId: 'notes', offset: 0, limit: 1, revision: 2 }]) {
                expect(host.getProjectNotes(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            const raw = '😀'.repeat(600_000);
            useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((entry) => entry.id === 'notes'
                ? { ...entry, supportNotes: raw } : entry) }));
            expect(host.getProjectDetail({ projectId: 'notes', offset: 0, limit: 1 }).ok).toBe(true);
            expect(host.getProjectNotes({ projectId: 'notes', offset: 0, limit: 1 }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(useTaskStore.getState()._allProjects[0].supportNotes).toBe(raw);
            const expanded = '- [ ] item\n'.repeat(80_000);
            useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((entry) => entry.id === 'notes'
                ? { ...entry, supportNotes: expanded } : entry) }));
            expect(host.getProjectNotes({ projectId: 'notes', offset: 0, limit: 1 }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(useTaskStore.getState()._allProjects[0].supportNotes).toBe(expanded);
            expect(saveData).not.toHaveBeenCalled();
        });
    });

    it('acknowledges create and complete only when their store snapshots are durable', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        saveData.mockClear();
        let releaseSave!: () => void;
        saveData.mockImplementation(() => new Promise<void>((resolve) => { releaseSave = resolve; }));

        let createdSettled = false;
        const creating = host.createInboxTask({ title: '  Captured thought  ', captureId: CAPTURE_ID }).then((result) => {
            createdSettled = true;
            return result;
        });
        await vi.waitFor(() => expect(saveData).toHaveBeenCalledTimes(1));
        expect(createdSettled).toBe(false);
        releaseSave();
        const created = await creating;
        expect(created).toMatchObject({ ok: true, value: { id: expect.any(String) } });
        if (!created.ok) return;
        expect(host.getTask({ id: created.value.id })).toMatchObject({
            ok: true, value: { title: 'Captured thought', status: 'inbox' },
        });

        let completedSettled = false;
        const completing = host.completeTask({ id: created.value.id, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(created.value.id)!) }).then((result) => {
            completedSettled = true;
            return result;
        });
        await vi.waitFor(() => expect(saveData).toHaveBeenCalledTimes(2));
        expect(completedSettled).toBe(false);
        releaseSave();
        expect(await completing).toEqual({ ok: true, value: { id: created.value.id } });
        expect(host.getTask({ id: created.value.id })).toMatchObject({
            ok: true, value: { status: 'done', completedAt: expect.any(String) },
        });
    });

    it('reports a failed save without a successful task ID', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        saveData.mockClear();
        saveData.mockRejectedValue(new Error('disk unavailable'));
        const input = { title: 'Unsaved thought', captureId: CAPTURE_ID };
        const result = await host.createInboxTask(input);
        expect(result).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(result).not.toHaveProperty('value.id');
        saveData.mockResolvedValue(undefined);
        expect(await host.createInboxTask(input)).toEqual({ ok: true, value: { id: CAPTURE_ID } });
        expect(useTaskStore.getState()._allTasks).toHaveLength(1);
    });

    it('reports failed completion persistence and retries the optimistic completion without repeating it', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        saveData.mockClear();
        useTaskStore.setState({ _allTasks: [task('to-complete', '2026-09-01T00:00:00.000Z')] });
        const input = { id: 'to-complete', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('to-complete')!) };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.completeTask(input))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        const completedAt = useTaskStore.getState()._tasksById.get('to-complete')?.completedAt;
        expect(completedAt).toEqual(expect.any(String));
        saveData.mockResolvedValue(undefined);
        // The exact retry: the completion landed, so its target holds and only the save runs.
        expect(await host.completeTask(input)).toEqual({ ok: true, value: { id: 'to-complete' } });
        expect(useTaskStore.getState()._tasksById.get('to-complete')?.completedAt).toBe(completedAt);
    });

    it.each([
        { status: 'reference', parent: 'archived' },
        { status: 'reference', parent: 'deleted' },
        { status: 'next', parent: 'archived' },
        { status: 'next', parent: 'deleted' },
    ] as const)('refuses completing $status under a $parent project without writing', async ({ status, parent }) => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        useTaskStore.setState({
            _allTasks: [task('read-only', '2026-09-01T00:00:00.000Z', { status, projectId: 'parent', rev: 7 })],
            _allProjects: [project('parent', parent === 'archived' ? 'archived' : 'active', 0,
                parent === 'deleted' ? { deletedAt: '2026-09-02T00:00:00.000Z' } : {})],
        });
        saveData.mockClear();
        const before = useTaskStore.getState();
        const warn = vi.spyOn(logger, 'logWarn');

        expect(await host.completeTask({ id: 'read-only' })).toEqual({
            ok: false, error: { code: 'INVALID_INPUT', message: 'Task is read-only while its project is archived or deleted' },
        });
        expect(useTaskStore.getState()).toBe(before);
        expect(useTaskStore.getState()._tasksById.get('read-only')?.rev).toBe(7);
        expect(saveData).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('Native completion refused for a read-only project', {
            scope: 'native-host', category: 'validation',
            context: { releaseCheck: 'v1.3.3/native-readonly-completion' },
        });
    });

    it.each([
        { parent: 'archived', failedSave: true },
        { parent: 'deleted', failedSave: true },
        { parent: 'archived', failedSave: false },
        { parent: 'deleted', failedSave: false },
    ] as const)('keeps completion replay after the parent becomes $parent (failed save: $failedSave)', async ({ parent, failedSave }) => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        useTaskStore.setState({
            _allTasks: [task('reference', '2026-09-01T00:00:00.000Z', { status: 'reference', projectId: 'parent', rev: 7 })],
            _allProjects: [project('parent')],
        });
        saveData.mockClear();
        if (failedSave) saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.completeTask({ id: 'reference' })).toMatchObject(failedSave
            ? { ok: false, error: { code: 'SAVE_FAILED' } }
            : { ok: true, value: { id: 'reference' } });
        const completed = useTaskStore.getState()._tasksById.get('reference');
        expect(completed).toMatchObject({ status: 'done', completedAt: expect.any(String), rev: 8 });
        useTaskStore.setState({
            _allProjects: [project('parent', parent === 'archived' ? 'archived' : 'active', 0,
                parent === 'deleted' ? { deletedAt: '2026-09-02T00:00:00.000Z' } : {})],
        });
        saveData.mockResolvedValue(undefined);
        saveData.mockClear();

        expect(await host.completeTask({ id: 'reference' })).toEqual({ ok: true, value: { id: 'reference' } });
        expect(useTaskStore.getState()._tasksById.get('reference')).toBe(completed);
        expect(saveData).toHaveBeenCalledTimes(failedSave ? 1 : 0);
    });

    it.each(['missing', 'deleted'] as const)('keeps TASK_NOT_FOUND for completing a %s task', async (state) => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        useTaskStore.setState({ _allTasks: state === 'deleted'
            ? [task('missing', '2026-09-01T00:00:00.000Z', { deletedAt: '2026-09-02T00:00:00.000Z' })]
            : [] });
        saveData.mockClear();
        const before = useTaskStore.getState();
        expect(await host.completeTask({ id: 'missing' })).toEqual({ ok: false, error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
        expect(useTaskStore.getState()).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('rejects every entry point until a real adapter, load, and write-safety gate succeed', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        expect(host.getInboxWindow({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getFocus({ limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getProjects()).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getAreaFilter()).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getProjectDetail({ projectId: 'x', offset: 0, limit: 1 }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: 'x' }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getTask({ id: 'x' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getTaskEditor({ id: 'x' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.createInboxTask({ title: 'x', captureId: CAPTURE_ID }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.createProject({ title: 'x', areaId: null, requestId: CAPTURE_ID }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.setTaskFocus({ id: 'x', focused: true, taskRevision: 'r' }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.setProjectFocus({ id: 'x', focused: true, projectRevision: 'r' }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.setAreaFilter({ included: [], excluded: [] }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.completeTask({ id: 'x', taskRevision: 'r' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.updateTask({ id: 'x', base: { title: 'x' }, patch: { title: 'y' }, requestId: newRequestId() }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(saveData).not.toHaveBeenCalled();
        setStorageAdapter({ getData, saveData });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        setStorageAdapter(noopStorage);
        expect(host.getInboxWindow({ offset: 0, limit: 1 }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });

    it('keeps the contract closed when the initial store load fails', async () => {
        getData.mockRejectedValue(new Error('database unreadable'));
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: false })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(getData).not.toHaveBeenCalled();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(useTaskStore.getState().error).toContain('database unreadable');
        expect(host.getInboxWindow({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.createInboxTask({ title: 'Must not save', captureId: CAPTURE_ID }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('acknowledges a lost completion reply without completing twice, after flushing pending work', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        saveData.mockClear();
        useTaskStore.setState({ _allTasks: [task('replay', '2026-09-01T00:00:00.000Z')] });
        const input = { id: 'replay', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('replay')!) };
        expect(await host.completeTask(input)).toEqual({ ok: true, value: { id: 'replay' } });
        const completedAt = useTaskStore.getState()._tasksById.get('replay')?.completedAt;
        expect(saveData).toHaveBeenCalledTimes(1);

        let releaseSave!: () => void;
        saveData.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSave = resolve; }));
        expect((await useTaskStore.getState().updateTask('replay', { description: 'Pending edit' })).success).toBe(true);
        let replaySettled = false;
        const replay = host.completeTask(input).then((result) => {
            replaySettled = true;
            return result;
        });
        await vi.waitFor(() => expect(saveData).toHaveBeenCalledTimes(2));
        expect(replaySettled).toBe(false);
        releaseSave();
        expect(await replay).toEqual({ ok: true, value: { id: 'replay' } });
        expect(useTaskStore.getState()._tasksById.get('replay')?.completedAt).toBe(completedAt);
    });

    it('closes an activated contract after a later store load error', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        saveData.mockClear();
        getData.mockRejectedValue(new Error('database unreadable'));
        await expect(useTaskStore.getState().fetchData({ throwOnError: true })).rejects.toThrow('database unreadable');
        expect(host.getInboxWindow({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        useTaskStore.getState().setError(null);
        expect(await host.createInboxTask({ title: 'Must not save', captureId: CAPTURE_ID }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('fails closed when a task changes during the initial storage read', async () => {
        let releaseRead!: (data: unknown) => void;
        getData.mockImplementation(() => new Promise((resolve) => { releaseRead = resolve; }));
        const host = createNativeHostContract();
        const activating = host.activate({ writeSafetyReady: true });
        await vi.waitFor(() => expect(getData).toHaveBeenCalledTimes(1));
        expect((await useTaskStore.getState().addTask('Concurrent capture')).success).toBe(true);
        releaseRead({
            tasks: [task('stored', '2026-09-01T00:00:00.000Z')],
            projects: [], sections: [], areas: [], people: [], settings: {},
        });
        expect(await activating).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getInboxWindow({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });

    it('returns raw task editor fields, archived read-only state, and store-ordered selectable projects', async () => {
        const currentArchivedProject = project('current-archived', 'archived', 2);
        const host = createNativeHostContract();
        expect(host.getTaskEditor({ id: 'raw' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        getData.mockResolvedValue({
            tasks: [
                task('raw', '2026-09-01T00:00:00.000Z', {
                    title: '  stored title  ', description: 'stored notes', status: 'archived', priority: 'high',
                    projectId: currentArchivedProject.id, startTime: '2026-09-23T09:15:00-04:00', dueDate: '2026-09-30',
                }),
                task('missing-fields', '2026-09-01T00:00:00.000Z'),
                task('deleted-task', '2026-09-01T00:00:00.000Z', { deletedAt: '2026-09-02T00:00:00.000Z' }),
            ],
            projects: [
                currentArchivedProject,
                project('active-later', 'active', 1),
                project('active-first', 'active', 0),
                project('other-archived', 'archived', 3),
                project('deleted-project', 'active', -1, { deletedAt: '2026-09-02T00:00:00.000Z' }),
                project('completed-project', 'completed', 4),
            ],
            sections: [], areas: [], people: [], settings: {},
        });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });

        const rawEditor = host.getTaskEditor({ id: 'raw' });
        expect(rawEditor).toEqual({
            ok: true,
            value: {
                version: 1,
                id: 'raw',
                fields: {
                    title: '  stored title  ', description: 'stored notes', status: 'archived', priority: 'high',
                    projectId: currentArchivedProject.id, startTime: '2026-09-23T09:15:00-04:00', dueDate: '2026-09-30',
                },
                projects: [
                    { id: 'current-archived', title: 'current-archived' },
                    { id: 'active-later', title: 'active-later' },
                    { id: 'active-first', title: 'active-first' },
                ],
                readOnly: true,
                statuses: ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'],
                priorities: ['low', 'medium', 'high', 'urgent'],
            },
        });
        if (rawEditor.ok) expect(Object.keys(rawEditor.value.fields)).toEqual(NATIVE_HOST_EDITOR_FIELDS);
        expect(host.getTaskEditor({ id: 'missing-fields' })).toMatchObject({
            ok: true,
            value: { fields: {
                title: 'missing-fields', description: null, status: 'inbox', priority: null,
                projectId: null, startTime: null, dueDate: null,
            }, readOnly: false },
        });
        expect(host.getTaskEditor({ id: 'deleted-task' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(host.getTaskEditor({ id: '' })).toEqual({
            ok: false, error: { code: 'INVALID_INPUT', message: 'Task ID is required' },
        });
        expect(await host.updateTask({ id: '', base: {}, patch: {}, requestId: newRequestId() })).toEqual({
            ok: false, error: { code: 'INVALID_INPUT', message: 'Task ID is required' },
        });
    });

    const editorFieldEdits: Array<{ field: keyof NativeEditableFields; value: unknown }> = [
        { field: 'title', value: '  Updated title  ' },
        { field: 'description', value: 'Updated notes' },
        { field: 'status', value: 'next' },
        { field: 'priority', value: 'urgent' },
        { field: 'projectId', value: 'assigned-project' },
        { field: 'startTime', value: '2026-10-02T09:15:00.000Z' },
        { field: 'dueDate', value: '2026-10-04' },
    ];

    it.each(editorFieldEdits)('persists $field only after its save is durable', async ({ field, value }) => {
        // Keep the saved schedule in the future; crossing its date must not
        // turn this durability check into an Inbox activation test.
        freezeClock();
        const host = await activateWith(
            [task('edit', '2026-09-01T00:00:00.000Z', { description: 'Old notes', priority: 'low' })],
            [project('assigned-project')],
        );
        const editor = host.getTaskEditor({ id: 'edit' });
        if (!editor.ok) throw new Error('Task editor did not load');
        const base = { [field]: editor.value.fields[field] } as Partial<NativeEditableFields>;
        const patch = { [field]: value } as Partial<NativeEditableFields>;
        let savedSnapshot: unknown;
        let releaseSave!: () => void;
        saveData.mockClear();
        saveData.mockImplementationOnce((data: unknown) => {
            savedSnapshot = data;
            return new Promise<void>((resolve) => { releaseSave = resolve; });
        });

        let settled = false;
        const saving = host.updateTask({ id: 'edit', base, patch, requestId: newRequestId() }).then((result) => {
            settled = true;
            return result;
        });
        await vi.waitFor(() => expect(saveData).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        releaseSave();
        expect(await saving).toEqual({ ok: true, value: { id: 'edit', changed: true } });

        const persistedTask = (savedSnapshot as { tasks: Task[] }).tasks.find(({ id }) => id === 'edit');
        expect(persistedTask?.[field as keyof Task]).toBe(value);
        if (field === 'dueDate') {
            getData.mockResolvedValue(savedSnapshot as never);
            await expect(useTaskStore.getState().fetchData({ throwOnError: true })).resolves.toBeUndefined();
            expect(host.getTaskEditor({ id: 'edit' })).toMatchObject({ ok: true, value: { fields: { dueDate: '2026-10-04' } } });
        }
    });

    it('clears descriptions the same way as the mobile task draft', async () => {
        const host = await activateWith([task('edit', '2026-09-01T00:00:00.000Z', { description: 'Old notes' })]);
        saveData.mockClear();
        expect(await host.updateTask({ id: 'edit', base: { description: 'Old notes' }, patch: { description: '' }, requestId: newRequestId() }))
            .toEqual({ ok: true, value: { id: 'edit', changed: true } });
        const savedData = saveData.mock.calls.at(-1)?.[0] as { tasks: Task[] };
        expect(savedData.tasks.find(({ id }) => id === 'edit')?.description).toBeUndefined();
        expect(host.getTaskEditor({ id: 'edit' })).toMatchObject({ ok: true, value: { fields: { description: null } } });
        expect(await host.updateTask({ id: 'edit', base: { description: 'Old notes' }, patch: { description: null }, requestId: newRequestId() }))
            .toEqual({ ok: true, value: { id: 'edit', changed: false } });
    });

    const invalidEditorPatches: Array<{
        name: string;
        base: Record<string, unknown>;
        patch: Record<string, unknown>;
        messageFields: string[];
    }> = [
        { name: 'unknown key', base: { unknown: 'before' }, patch: { unknown: 'after' }, messageFields: ['title'] },
        { name: 'base and patch key mismatch', base: { title: 'edit' }, patch: { description: 'changed' }, messageFields: ['title', 'description'] },
        { name: 'blank title', base: { title: 'edit' }, patch: { title: '  ' }, messageFields: ['title'] },
        { name: 'bad status', base: { status: 'inbox' }, patch: { status: 'invalid' }, messageFields: ['status'] },
        { name: 'archived status', base: { status: 'inbox' }, patch: { status: 'archived' }, messageFields: ['status'] },
        { name: 'bad priority', base: { priority: null }, patch: { priority: 'critical' }, messageFields: ['priority'] },
        { name: 'deleted project', base: { projectId: 'current' }, patch: { projectId: 'deleted' }, messageFields: ['projectId'] },
        { name: 'another archived project', base: { projectId: 'current' }, patch: { projectId: 'archived' }, messageFields: ['projectId'] },
        { name: 'malformed date', base: { dueDate: null }, patch: { dueDate: '2026-02-30' }, messageFields: ['dueDate'] },
        { name: 'datetime with invalid time fields', base: { dueDate: null }, patch: { dueDate: '2026-09-23T25:99' }, messageFields: ['dueDate'] },
        { name: 'datetime with a space separator', base: { dueDate: null }, patch: { dueDate: '2026-09-23 10:00' }, messageFields: ['dueDate'] },
        { name: 'natural-language date', base: { dueDate: null }, patch: { dueDate: 'tomorrow' }, messageFields: ['dueDate'] },
        { name: 'date without zero padding', base: { dueDate: null }, patch: { dueDate: '2026-9-3' }, messageFields: ['dueDate'] },
    ];

    it.each(invalidEditorPatches)('rejects $name without writing', async ({ name, base, patch, messageFields }) => {
        const initial = task('edit', '2026-09-01T00:00:00.000Z', { projectId: 'current', rev: 7 });
        const host = await activateWith([initial], [
            project('current'),
            project('deleted', 'active', 1, { deletedAt: '2026-09-02T00:00:00.000Z' }),
            project('archived', 'archived', 2),
        ]);
        saveData.mockClear();

        const result = await host.updateTask({ id: 'edit', base, patch, requestId: newRequestId() } as never);
        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        if (!result.ok) {
            if (name === 'base and patch key mismatch') {
                expect(result.error.message).toBe('base and patch fields must match: title, description');
            }
            for (const field of messageFields) expect(result.error.message).toContain(field);
            for (const [key, value] of Object.entries(patch)) {
                if (!NATIVE_HOST_EDITOR_FIELDS.includes(key as typeof NATIVE_HOST_EDITOR_FIELDS[number])) {
                    expect(result.error.message).not.toContain(key);
                }
                if (typeof value === 'string' && value.trim()) expect(result.error.message).not.toContain(value);
            }
        }
        expect(saveData).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._tasksById.get('edit')?.rev).toBe(7);
    });

    it('rejects an empty patch without writing', async () => {
        const host = await activateWith([task('edit', '2026-09-01T00:00:00.000Z', { rev: 2 })]);
        saveData.mockClear();
        expect(await host.updateTask({ id: 'edit', base: {}, patch: {}, requestId: newRequestId() })).toMatchObject({
            ok: false, error: { code: 'INVALID_INPUT' },
        });
        expect(saveData).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._tasksById.get('edit')?.rev).toBe(2);
    });

    const referenceTaskFieldEdits: Array<{
        name: string;
        taskStatus: Task['status'];
        base: Partial<NativeEditableFields>;
        patch: Partial<NativeEditableFields>;
        field: 'priority' | 'startTime' | 'dueDate';
    }> = [
        {
            name: 'status reference with priority', taskStatus: 'next',
            base: { status: 'next', priority: null }, patch: { status: 'reference', priority: 'high' }, field: 'priority',
        },
        {
            name: 'status reference with due date', taskStatus: 'next',
            base: { status: 'next', dueDate: null }, patch: { status: 'reference', dueDate: '2026-09-30' }, field: 'dueDate',
        },
        {
            name: 'priority on an existing reference task', taskStatus: 'reference',
            base: { priority: null }, patch: { priority: 'high' }, field: 'priority',
        },
    ];

    it.each(referenceTaskFieldEdits)('rejects $name before the store can clear the field', async ({ taskStatus, base, patch, field }) => {
        const host = await activateWith([task('reference-edit', '2026-09-01T00:00:00.000Z', { status: taskStatus, rev: 11 })]);
        saveData.mockClear();

        const result = await host.updateTask({ id: 'reference-edit', base, patch, requestId: newRequestId() });
        expect(result).toEqual({
            ok: false, error: { code: 'INVALID_INPUT', message: `${field} cannot be set while status is reference` },
        });
        expect(saveData).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._tasksById.get('reference-edit')?.rev).toBe(11);
    });

    it('rejects updates to tasks in archived projects without writing', async () => {
        const host = await activateWith(
            [task('archived-project-task', '2026-09-01T00:00:00.000Z', { projectId: 'archived', rev: 12 })],
            [project('archived', 'archived')],
        );
        const revBefore = useTaskStore.getState()._tasksById.get('archived-project-task')?.rev;
        saveData.mockClear();

        expect(await host.updateTask({
            requestId: newRequestId(),
            id: 'archived-project-task', base: { title: 'archived-project-task' }, patch: { title: 'Changed' },
        })).toEqual({
            ok: false,
            error: { code: 'INVALID_INPUT', message: 'Task is read-only while its project is archived' },
        });
        expect(saveData).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._tasksById.get('archived-project-task')?.rev).toBe(revBefore);
    });

    it('accepts timezone datetimes and stores them unchanged', async () => {
        const value = '2026-09-23T10:00:00+05:30';
        const host = await activateWith([task('edit', '2026-09-01T00:00:00.000Z')]);

        expect(await host.updateTask({ id: 'edit', base: { dueDate: null }, patch: { dueDate: value }, requestId: newRequestId() }))
            .toEqual({ ok: true, value: { id: 'edit', changed: true } });
        const savedData = saveData.mock.calls.at(-1)?.[0] as { tasks: Task[] };
        expect(savedData.tasks.find(({ id }) => id === 'edit')?.dueDate).toBe(value);
    });

    it('rejects a conflict on a patched field without overwriting it', async () => {
        const host = await activateWith([task('edit', '2026-09-01T00:00:00.000Z', { title: 'Original' })]);
        expect((await useTaskStore.getState().updateTask('edit', { title: 'Other writer' })).success).toBe(true);
        await flushPendingSave();
        const revAfterOtherWrite = useTaskStore.getState()._tasksById.get('edit')?.rev;
        saveData.mockClear();

        expect(await host.updateTask({ id: 'edit', base: { title: 'Original' }, patch: { title: 'My edit' }, requestId: newRequestId() }))
            .toEqual({ ok: false, error: { code: 'STALE_REVISION', message: 'Task changed while editing: title' } });
        expect(useTaskStore.getState()._tasksById.get('edit')).toMatchObject({ title: 'Other writer', rev: revAfterOtherWrite });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('keeps an unrelated writer change while applying the requested field', async () => {
        const host = await activateWith([task('edit', '2026-09-01T00:00:00.000Z', { title: 'Original', description: 'Old notes' })]);
        expect((await useTaskStore.getState().updateTask('edit', { description: 'Other notes' })).success).toBe(true);
        await flushPendingSave();

        expect(await host.updateTask({ id: 'edit', base: { title: 'Original' }, patch: { title: 'My edit' }, requestId: newRequestId() }))
            .toEqual({ ok: true, value: { id: 'edit', changed: true } });
        expect(useTaskStore.getState()._tasksById.get('edit')).toMatchObject({ title: 'My edit', description: 'Other notes' });
    });

    it('answers a repeated request with its first reply, without a second store write', async () => {
        const host = await activateWith([task('edit', '2026-09-01T00:00:00.000Z', { title: 'Original' })]);
        const input = { id: 'edit', base: { title: 'Original' }, patch: { title: 'My edit' }, requestId: newRequestId() };
        saveData.mockClear();
        expect(await host.updateTask(input)).toEqual({ ok: true, value: { id: 'edit', changed: true } });
        const revAfterFirstWrite = useTaskStore.getState()._tasksById.get('edit')?.rev;
        expect(await host.updateTask(input)).toEqual({ ok: true, value: { id: 'edit', changed: true } });
        expect(useTaskStore.getState()._tasksById.get('edit')?.rev).toBe(revAfterFirstWrite);
        expect(saveData).toHaveBeenCalledTimes(1);
    });

    it('creates one recurring follow-up through core and does not duplicate it on retry', async () => {
        const host = await activateWith([task('recurring', '2026-09-01T00:00:00.000Z', {
            status: 'next', recurrence: { rule: 'daily', strategy: 'fluid' }, dueDate: '2026-09-20',
        })]);
        const input = { id: 'recurring', base: { status: 'next' }, patch: { status: 'done' }, requestId: newRequestId() };
        expect(await host.updateTask(input)).toEqual({ ok: true, value: { id: 'recurring', changed: true } });
        const afterFirst = useTaskStore.getState()._allTasks;
        const followUps = afterFirst.filter((item) => item.id !== 'recurring' && item.status !== 'done' && item.status !== 'archived');
        expect(afterFirst.find(({ id }) => id === 'recurring')?.completedAt).toEqual(expect.any(String));
        expect(followUps).toHaveLength(1);
        const completedRev = afterFirst.find(({ id }) => id === 'recurring')?.rev;

        expect(await host.updateTask(input)).toEqual({ ok: true, value: { id: 'recurring', changed: true } });
        expect(useTaskStore.getState()._allTasks).toHaveLength(2);
        expect(useTaskStore.getState()._allTasks.find(({ id }) => id === 'recurring')?.rev).toBe(completedRev);
    });

    it('reports a failed recurring save and retries it without another update or follow-up', async () => {
        const host = await activateWith([task('recurring', '2026-09-01T00:00:00.000Z', {
            status: 'next', recurrence: { rule: 'daily', strategy: 'fluid' }, dueDate: '2026-09-20',
        })]);
        const input = { id: 'recurring', base: { status: 'next' }, patch: { status: 'done' }, requestId: newRequestId() };
        saveData.mockClear();
        saveData.mockRejectedValue(new Error('disk unavailable'));

        expect(await host.updateTask(input)).toMatchObject({
            ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' },
        });
        const completed = useTaskStore.getState()._tasksById.get('recurring');
        const revAfterFailure = completed?.rev;
        expect(useTaskStore.getState()._allTasks).toHaveLength(2);
        expect(useTaskStore.getState()._allTasks.filter((item) => item.id !== 'recurring' && item.status !== 'done' && item.status !== 'archived')).toHaveLength(1);

        saveData.mockResolvedValue(undefined);
        expect(await host.updateTask(input)).toEqual({ ok: true, value: { id: 'recurring', changed: true } });
        const savedData = saveData.mock.calls.at(-1)?.[0] as { tasks: Task[] };
        expect(savedData.tasks.find(({ id }) => id === 'recurring')?.status).toBe('done');
        expect(savedData.tasks.filter((item) => item.id !== 'recurring' && item.status !== 'done' && item.status !== 'archived'))
            .toHaveLength(1);
        expect(useTaskStore.getState()._allTasks).toHaveLength(2);
        expect(useTaskStore.getState()._tasksById.get('recurring')?.rev).toBe(revAfterFailure);
    });

    describe('task editor model', () => {
        const section = (id: string, projectId: string, title: string, order: number, extra: Partial<Section> = {}): Section => ({
            id, projectId, title, order, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra,
        });
        const editorData = (tasks: Task[], settings: AppSettings = {}) => ({
            tasks,
            projects: [
                project('p-work', 'active', 0, { areaId: 'a-work' }),
                project('p-home', 'active', 1, { areaId: 'a-home' }),
                project('p-old', 'archived', 2),
            ],
            sections: [
                section('s-plan', 'p-work', 'Plan', 1),
                section('s-ship', 'p-work', 'Ship', 0),
                section('s-gone', 'p-work', 'Gone', 2, { deletedAt: '2026-09-02T00:00:00.000Z' }),
            ],
            areas: [area('a-work', 'Work', 0), area('a-home', 'Home', 1)],
            people: [{ id: 'person-1', name: 'Alex', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
            settings,
        });
        const activateEditor = async (tasks: Task[], settings: AppSettings = {}) => {
            getData.mockResolvedValue(editorData(tasks, settings));
            const host = createNativeHostContract();
            expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
            return host;
        };
        const editTask = (extra: Partial<Task> = {}) => task('edit', '2026-09-01T00:00:00.000Z', {
            title: 'Original', status: 'next', ...extra,
        });
        const storedTask = (id = 'edit') => useTaskStore.getState()._tasksById.get(id);
        const restartEditorFromLastSave = async () => {
            const persisted = structuredClone(saveData.mock.lastCall?.[0]);
            expect(persisted).toBeDefined();
            resetForTests();
            useTaskStore.setState({
                _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
                settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
            });
            getData.mockResolvedValue(persisted);
            const restarted = createNativeHostContract();
            expect(await restarted.activate({ writeSafetyReady: true, recoveryLoad: true })).toEqual({ ok: true, value: null });
            saveData.mockClear();
            return restarted;
        };

        it('serves the core model for the stored task, draft and settings', async () => {
            freezeClock();
            const host = createNativeHostContract();
            expect(host.getTaskEditorModel({ id: 'edit' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            getData.mockResolvedValue(editorData([
                editTask({
                    projectId: 'p-work', sectionId: 's-plan', dueDate: '2026-09-25', contexts: ['@office'], tags: ['#launch'],
                    recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY;INTERVAL=2' },
                }),
                task('waiting', '2026-09-01T00:00:00.000Z', { status: 'waiting', assignedTo: 'Sam', areaId: 'a-home' }),
                task('archived-project', '2026-09-01T00:00:00.000Z', { projectId: 'p-old' }),
                task('deleted', '2026-09-01T00:00:00.000Z', { deletedAt: '2026-09-02T00:00:00.000Z' }),
                task('someday', '2026-09-01T00:00:00.000Z', { status: 'someday', viewSectionIds: { someday: 'vs-books' } }),
            ], {
                gtd: {
                    taskEditor: { hidden: [...DEFAULT_TASK_EDITOR_HIDDEN, 'tags'], sectionOpen: { organization: true } },
                    viewSections: { someday: [{ id: 'vs-later', title: 'Later', order: 1 }, { id: 'vs-books', title: 'Books', order: 0 }] },
                },
            }));
            expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });

            const result = host.getTaskEditorModel({ id: 'edit' });
            if (!result.ok) throw new Error('Task editor model did not load');
            const state = useTaskStore.getState();
            const stored = state._tasksById.get('edit')!;
            const draft = createTaskDraft(stored);
            const { allContexts, allTags } = state.getDerivedState();
            expect(result.value).toEqual({
                version: 1,
                revision: expect.any(String),
                id: 'edit',
                taskRevision: taskRevisionOf(stored),
                readOnly: false,
                canCancel: true,
                canSkipOccurrence: true,
                canPreserveChecklistOnRepeat: true,
                cancelLabel: 'Cancel recurring series',
                draft,
                backdatedCompletionStart: { initialValue: null, initialTimeSpentMinutes: null },
                focusStar: expect.objectContaining({ isFocused: false, canToggle: false, queued: false, blockedReason: 'deferred' }),
                scheduleBase: { startTime: null, dueDate: '2026-09-25', relativeStartOffset: null, reviewAt: null },
                recurrenceBase: { recurrence: stored.recurrence ?? null, showFutureRecurrence: stored.showFutureRecurrence ?? null },
                ...buildTaskEditorModel({
                    task: stored, draft, settings: state.settings, projects: state.projects, sections: state.sections,
                    areas: state.areas, tasks: state.tasks, people: state.people, contexts: allContexts, tags: allTags,
                    t: getTranslator('en'), now: new Date(),
                }),
            });
            // Concrete values, so the test does not only compare core with itself.
            const { layout, options } = result.value;
            expect(layout.sections.map(({ id, fields }) => [id, fields])).toEqual([
                ['basic', ['status', 'project', 'area', 'contexts', 'dueDate', 'section']],
                ['scheduling', ['startTime', 'reviewAt', 'recurrence']],
                ['organization', ['tags']],
                ['details', ['description', 'attachments', 'checklist']],
            ]);
            expect(layout.sections.map(({ titleKey, open, filledCount }) => [titleKey, open, filledCount])).toEqual([
                [null, true, 1], ['taskEdit.scheduling', true, 1], ['taskEdit.organization', true, 1], ['taskEdit.details', false, 0],
            ]);
            expect(layout.recurrence).toEqual({ dailyInterval: 2, monthlyPattern: 'date' });
            expect(options.projects).toEqual([
                { id: 'p-work', title: 'p-work', areaId: 'a-work' },
                { id: 'p-home', title: 'p-home', areaId: 'a-home' },
            ]);
            expect(options.sections).toEqual([{ id: 's-ship', title: 'Ship' }, { id: 's-plan', title: 'Plan' }]);
            expect(options.areas.map(({ id }) => id)).toEqual(['a-work', 'a-home']);
            expect(options.people).toEqual(['Alex', 'Sam']);
            expect(options.contexts).toContain('@office');
            expect(options.statuses).toEqual(['inbox', 'next', 'waiting', 'someday', 'done', 'reference']);
            expect(options.timeEstimates[0]).toEqual({ value: '', label: 'None' });
            expect(layout.showSomedaySection).toBe(false);
            const someday = host.getTaskEditorModel({ id: 'someday' });
            expect(someday.ok && someday.value.layout.showSomedaySection).toBe(true);
            expect(someday.ok && someday.value.options.somedaySections).toEqual([
                { id: '', title: 'No section', selected: false, viewSectionIds: {} },
                { id: 'vs-books', title: 'Books', selected: true, viewSectionIds: { someday: 'vs-books' } },
                { id: 'vs-later', title: 'Later', selected: false, viewSectionIds: { someday: 'vs-later' } },
            ]);
            // Plain JSON for the native client.
            expect(JSON.parse(JSON.stringify({ layout, options }))).toEqual({ layout, options });

            // The area filters the project list, as in the mobile picker.
            const waiting = host.getTaskEditorModel({ id: 'waiting' });
            expect(waiting.ok && waiting.value.options.projects.map(({ id }) => id)).toEqual(['p-home']);
            expect(waiting.ok && waiting.value.layout.sections[2].fields).toContain('assignedTo');
            expect(host.getTaskEditorModel({ id: 'archived-project' })).toMatchObject({ ok: true, value: { readOnly: true } });
            expect(host.getTaskEditorModel({ id: 'deleted' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            expect(host.getTaskEditorModel({ id: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        });

        it('uses edited start dates for queued Focus', async () => {
            const host = await activateEditor([
                editTask(),
                task('other', '2026-09-01T00:00:00.000Z', { status: 'next', isFocusedToday: true }),
            ], { gtd: { focusTaskLimit: 1 } });
            const opened = host.getTaskEditorModel({ id: 'edit' });
            if (!opened.ok) throw new Error('Editor did not open');
            expect(opened.value.focusStar).toMatchObject({ canToggle: false, blockedReason: 'limit' });
            const future = host.editTaskDraft({
                id: 'edit', draft: opened.value.draft,
                edit: { type: 'fields', patch: { startTime: '2099-01-01' } },
            });
            if (!future.ok) throw new Error('Draft edit failed');
            expect(future.value.focusStar).toMatchObject({ canToggle: true, queued: true });
            expect(await host.saveTaskDraft({
                requestId: newRequestId(),
                id: 'edit', base: { startTime: '', focusedToday: false },
                patch: { startTime: '2099-01-01', focusedToday: true },
            })).toMatchObject({ ok: true, value: { draft: { focusedToday: true } } });
            expect(storedTask()).toMatchObject({ isFocusedToday: true, startTime: '2099-01-01' });

        });

        it('rejects a Focus star when the last slot fills before Save', async () => {
            const host = await activateEditor([
                editTask(),
                task('other', '2026-09-01T00:00:00.000Z', { status: 'next' }),
            ], { gtd: { focusTaskLimit: 1 } });
            expect((await useTaskStore.getState().updateTask('other', { isFocusedToday: true })).success).toBe(true);
            expect(await host.saveTaskDraft({
                requestId: newRequestId(),
                id: 'edit', base: { focusedToday: false }, patch: { focusedToday: true },
            })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            expect(storedTask()?.isFocusedToday).toBeFalsy();
        });

        it('rejects moving an already-queued star into a full current Focus', async () => {
            const host = await activateEditor([
                editTask({ startTime: '2099-01-01', isFocusedToday: true }),
                task('other', '2026-09-01T00:00:00.000Z', { status: 'next', isFocusedToday: true }),
            ], { gtd: { focusTaskLimit: 1 } });
            expect(await host.saveTaskDraft({
                requestId: newRequestId(),
                id: 'edit', base: { startTime: '2099-01-01' }, patch: { startTime: '' },
            })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            expect(storedTask()).toMatchObject({ startTime: '2099-01-01', isFocusedToday: true });
        });

        it('does not offer Focus for Done and clears a draft star on Done transition', async () => {
            const host = await activateEditor([
                editTask({ isFocusedToday: true }),
                task('done-task', '2026-09-01T00:00:00.000Z', { status: 'done' }),
            ]);
            expect(host.getTaskEditorModel({ id: 'done-task' }))
                .toMatchObject({ ok: true, value: { focusStar: { canToggle: false } } });
            const opened = host.getTaskEditorModel({ id: 'edit' });
            if (!opened.ok) throw new Error('Editor did not open');
            const changed = host.editTaskDraft({
                id: 'edit', draft: opened.value.draft,
                edit: { type: 'fields', patch: { status: 'done' } },
            });
            expect(changed).toMatchObject({ ok: true, value: { draft: { status: 'done', focusedToday: false } } });
            expect(await host.saveTaskDraft({
                requestId: newRequestId(),
                id: 'edit', base: { status: 'next' }, patch: { status: 'done' },
            })).toMatchObject({ ok: true, value: { draft: { focusedToday: false } } });
        });

        it('changes the revision on a task edit, a people change, a layout change and a language change', async () => {
            freezeClock();
            const host = await activateEditor([editTask()]);
            const model = () => {
                const result = host.getTaskEditorModel({ id: 'edit' });
                if (!result.ok) throw new Error('Task editor model did not load');
                return result.value;
            };
            const first = model();
            expect(model().revision).toBe(first.revision);

            expect((await useTaskStore.getState().updateTask('edit', { title: 'Changed' })).success).toBe(true);
            const edited = model();
            expect(edited.revision).not.toBe(first.revision);
            expect(edited.draft.title).toBe('Changed');

            await useTaskStore.getState().addPerson('Robin');
            const withPerson = model();
            expect(withPerson.revision).not.toBe(edited.revision);
            expect(withPerson.options.people).toContain('Robin');

            useTaskStore.setState({ settings: { gtd: { taskEditor: { hidden: ['contexts'] } } } });
            const relaid = model();
            expect(relaid.revision).not.toBe(withPerson.revision);
            expect(relaid.layout.sections[0].fields).not.toContain('contexts');

            expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: null })).toMatchObject({ ok: true });
            const chinese = model();
            expect(chinese.revision).not.toBe(relaid.revision);
            expect(chinese.options.timeEstimates[0].label).toBe(getTranslator('zh')('common.none'));
            expect(chinese.options.timeEstimates[0].label).not.toBe('None');
        });

        it('saves draft fields over an unrelated change and returns the saved draft', async () => {
            const host = await activateEditor([editTask({ description: 'Old notes', projectId: 'p-work', sectionId: 's-plan' })]);
            expect((await useTaskStore.getState().updateTask('edit', { description: 'Other notes' })).success).toBe(true);
            await flushPendingSave();
            saveData.mockClear();

            const result = await host.saveTaskDraft({
                requestId: newRequestId(),
                id: 'edit',
                base: { title: 'Original', dueDate: '', projectId: 'p-work', relativeStartOffset: null as never },
                patch: { title: '  Mine  ', dueDate: '2026-10-01', projectId: 'p-home', relativeStartOffset: null as never },
            });
            const saved = storedTask()!;
            expect(result).toEqual({ ok: true, value: { id: 'edit', draft: createTaskDraft(saved) } });
            // Date-only stays date-only; moving projects drops the old project's section.
            expect(saved).toMatchObject({ title: 'Mine', dueDate: '2026-10-01', projectId: 'p-home', description: 'Other notes' });
            expect(saved.sectionId).toBeUndefined();
            expect(saveData).toHaveBeenCalledTimes(1);
            expect((saveData.mock.lastCall?.[0] as { tasks: Task[] }).tasks.find(({ id }) => id === 'edit')?.title).toBe('Mine');
        });

        it('refuses a field another writer changed, naming only the field', async () => {
            const host = await activateEditor([editTask({ description: 'Old notes' })]);
            expect((await useTaskStore.getState().updateTask('edit', { title: 'Other writer' })).success).toBe(true);
            await flushPendingSave();
            const revBefore = storedTask()?.rev;
            saveData.mockClear();

            expect(await host.saveTaskDraft({
                requestId: newRequestId(),
                id: 'edit', base: { title: 'Original', description: 'Old notes' }, patch: { title: 'Mine', description: 'New notes' },
            })).toEqual({ ok: false, error: { code: 'STALE_REVISION', message: 'Task changed while editing: title' } });
            expect(storedTask()).toMatchObject({ title: 'Other writer', description: 'Old notes', rev: revBefore });
            expect(saveData).not.toHaveBeenCalled();
        });

        it('runs core cascades, status first', async () => {
            const host = await activateEditor([
                editTask({ isFocusedToday: true }),
                task('complete', '2026-09-01T00:00:00.000Z', { status: 'next' }),
            ]);
            expect(await host.saveTaskDraft({ id: 'edit', base: { status: 'next' }, patch: { status: 'inbox' }, requestId: newRequestId() }))
                .toMatchObject({ ok: true, value: { draft: { status: 'inbox', focusedToday: false } } });
            expect(storedTask()).toMatchObject({ status: 'inbox', isFocusedToday: false });

            // Status goes first, so the chosen completion time survives its cascade.
            const completedAt = '2026-09-20T10:00:00.000Z';
            expect(await host.saveTaskDraft({
                requestId: newRequestId(),
                id: 'complete', base: { completedAt: '', status: 'next' }, patch: { completedAt, status: 'done' },
            })).toMatchObject({ ok: true, value: { draft: { status: 'done', completedAt } } });
            expect(storedTask('complete')).toMatchObject({ status: 'done', completedAt });
        });

        it.each([
            { status: 'reference', field: 'priority', value: 'urgent' },
            { status: 'reference', field: 'timeEstimate', value: '30min' },
            { status: 'next', field: 'priority', value: 'urgent' },
            { status: 'next', field: 'timeEstimate', value: '30min' },
        ] as const)('rejects $field when a $status task would remain or become Reference before writing', async ({ status, field, value }) => {
            const host = await activateEditor([editTask({ status })]);
            await flushPendingSave();
            saveData.mockClear();
            const before = storedTask();
            const base: Partial<TaskDraft> = { [field]: '' };
            const patch: Partial<TaskDraft> = { [field]: value };
            if (status !== 'reference') {
                base.status = status;
                patch.status = 'reference';
            }

            expect(await host.saveTaskDraft({ id: 'edit', base, patch })).toEqual({
                ok: false, error: { code: 'INVALID_INPUT', message: `${field} cannot be set while status is reference` },
            });
            expect(storedTask()).toBe(before);
            expect(storedTask()?.rev).toBe(before?.rev);
            expect(saveData).not.toHaveBeenCalled();
        });

        it.each(['reference', 'next'] as const)('saves Reference text, energy and empty metadata clears from %s and replays after restart', async (status) => {
            const host = await activateEditor([editTask({
                status, energyLevel: 'low', ...(status === 'next' ? { priority: 'urgent', timeEstimate: '30min' } : {}),
            })]);
            const before = createTaskDraft(storedTask()!);
            const input = {
                id: 'edit',
                base: { status, title: 'Original', description: '', energyLevel: 'low', priority: before.priority, timeEstimate: before.timeEstimate },
                patch: { status: 'reference', title: '  Reference note  ', description: 'Notes', energyLevel: 'high', priority: '', timeEstimate: '' },
            } as const;
            const first = await host.saveTaskDraft(input);
            expect(first).toMatchObject({ ok: true, value: { draft: {
                status: 'reference', title: 'Reference note', description: 'Notes', energyLevel: 'high', priority: '', timeEstimate: '',
            } } });
            const saved = storedTask();
            const restarted = await restartEditorFromLastSave();
            expect(await restarted.saveTaskDraft(input)).toEqual(first);
            expect(storedTask()).toEqual(saved);
            expect(saveData).not.toHaveBeenCalled();
        });

        it.each(['next', 'reference'] as const)('saves eligible metadata from %s when the resulting status is Next', async (status) => {
            const host = await activateEditor([editTask({ status })]);
            expect(await host.saveTaskDraft({
                id: 'edit',
                base: { status, priority: '', timeEstimate: '' },
                patch: { status: 'next', priority: 'urgent', timeEstimate: '30min' },
            })).toMatchObject({ ok: true, value: { draft: { status: 'next', priority: 'urgent', timeEstimate: '30min' } } });
            expect(storedTask()).toMatchObject({ status: 'next', priority: 'urgent', timeEstimate: '30min' });
        });

        it('retries a failed save exactly, without a second write', async () => {
            const host = await activateEditor([editTask()]);
            const input = { id: 'edit', base: { title: 'Original' }, patch: { title: 'Mine' }, requestId: newRequestId() };
            saveData.mockClear();
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await host.saveTaskDraft(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
            const revAfterFailure = storedTask()?.rev;
            expect(storedTask()?.title).toBe('Mine');

            saveData.mockResolvedValue(undefined);
            expect(await host.saveTaskDraft(input)).toMatchObject({ ok: true, value: { draft: { title: 'Mine' } } });
            expect(storedTask()?.rev).toBe(revAfterFailure);
            expect((saveData.mock.lastCall?.[0] as { tasks: Task[] }).tasks.find(({ id }) => id === 'edit')?.title).toBe('Mine');
            // A lost reply repeats the request once more: still no write.
            const saves = saveData.mock.calls.length;
            expect(await host.saveTaskDraft(input)).toMatchObject({ ok: true });
            expect(storedTask()?.rev).toBe(revAfterFailure);
            expect(saveData).toHaveBeenCalledTimes(saves);
        });

        it.each([
            { title: '  Renamed  ', description: '  New notes\n ', savedTitle: 'Renamed' },
            { title: '  Renamed  ', description: '', savedTitle: 'Renamed' },
            { title: '   ', description: '  New notes\n ', savedTitle: 'Original' },
            { title: '   ', description: '', savedTitle: 'Original' },
        ])('replays serialized editor title $title and note after restart without another update', async ({ title, description, savedTitle }) => {
            const host = await activateEditor([editTask({
                description: 'Old notes', dueDate: '2026-10-01', startTime: '2026-09-30T14:30:00.000Z',
            })]);
            await flushPendingSave();
            saveData.mockClear();
            const input = {
                id: 'edit', base: { title: 'Original', description: 'Old notes' }, patch: { title, description },
            };
            const first = await host.saveTaskDraft(input);
            expect(first).toMatchObject({ ok: true, value: { draft: { title: savedTitle, description } } });
            expect(saveData).toHaveBeenCalledTimes(1);
            const saved = storedTask();
            expect(saved).toMatchObject({
                title: savedTitle, description: description || undefined,
                dueDate: '2026-10-01', startTime: '2026-09-30T14:30:00.000Z',
            });

            // The save landed but its reply was lost; no process-local receipt survives.
            const restarted = await restartEditorFromLastSave();
            const updateTask = vi.spyOn(useTaskStore.getState(), 'updateTask');
            expect(await restarted.saveTaskDraft(input)).toEqual(first);
            expect(storedTask()).toEqual(saved);
            expect(updateTask).not.toHaveBeenCalled();
            expect(saveData).not.toHaveBeenCalled();
        });

        it.each([
            { title: '  Renamed  ', otherPatch: { title: 'Other writer' }, field: 'title' },
            { title: '   ', otherPatch: { title: 'Other writer' }, field: 'title' },
            { title: '  Renamed  ', otherPatch: { description: 'Other notes' }, field: 'description' },
        ])('keeps exact editor $field conflicts after restart with title $title', async ({ title, otherPatch, field }) => {
            const host = await activateEditor([editTask({ description: 'Old notes' })]);
            const input = {
                id: 'edit', base: { title: 'Original', description: 'Old notes' },
                patch: { title, description: '  New notes  ' },
            };
            expect(await host.saveTaskDraft(input)).toMatchObject({ ok: true });
            expect((await useTaskStore.getState().updateTask('edit', otherPatch)).success).toBe(true);
            await flushPendingSave();
            const saved = storedTask();
            const restarted = await restartEditorFromLastSave();
            const updateTask = vi.spyOn(useTaskStore.getState(), 'updateTask');
            expect(await restarted.saveTaskDraft(input)).toEqual({
                ok: false, error: { code: 'STALE_REVISION', message: `Task changed while editing: ${field}` },
            });
            expect(storedTask()).toEqual(saved);
            expect(updateTask).not.toHaveBeenCalled();
            expect(saveData).not.toHaveBeenCalled();
        });

        it.each(['  Original  ', '  Renamed  '])('does not trim the current or original-base title for conflict checks: %s', async (title) => {
            const host = await activateEditor([editTask({ title, description: 'Old notes' })]);
            await flushPendingSave();
            saveData.mockClear();
            const before = storedTask();
            expect(await host.saveTaskDraft({
                id: 'edit', base: { title: 'Original', description: 'Old notes' },
                patch: { title: '  Renamed  ', description: 'New notes' },
            })).toEqual({ ok: false, error: { code: 'STALE_REVISION', message: 'Task changed while editing: title' } });
            expect(storedTask()).toBe(before);
            expect(saveData).not.toHaveBeenCalled();
        });

        // The store stamps recurrence and queues a future-start star, so the
        // saved draft can differ from the request.
        it.each([
            {
                name: 'a recurrence series stamp',
                input: { id: 'edit', base: { recurrence: '', recurrenceRRule: '' }, patch: { recurrence: 'weekly', recurrenceRRule: 'FREQ=WEEKLY;BYDAY=MO' }, requestId: newRequestId() },
                saved: { recurrence: { rule: 'weekly', byDay: ['MO'] } },
            },
            {
                name: 'a star queued for a future start',
                input: { id: 'edit', base: { focusedToday: false, startTime: '' }, patch: { focusedToday: true, startTime: '2027-01-04' }, requestId: newRequestId() },
                saved: { startTime: '2027-01-04', isFocusedToday: true },
            },
        ] as const)('retries exactly after $name', async ({ input, saved }) => {
            const host = await activateEditor([editTask()]);
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await host.saveTaskDraft(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const afterFailure = storedTask();
            expect(afterFailure).toMatchObject(saved);

            saveData.mockResolvedValue(undefined);
            expect(await host.saveTaskDraft(input)).toMatchObject({ ok: true });
            expect(storedTask()).toBe(afterFailure);
            expect((saveData.mock.lastCall?.[0] as { tasks: Task[] }).tasks.find(({ id }) => id === 'edit')).toMatchObject(saved);
        });

        it('keeps retry state per task: A, then B, then the exact retry of A', async () => {
            const host = await activateEditor([editTask(), task('b', '2026-09-01T00:00:00.000Z'), task('other', '2026-09-01T00:00:00.000Z')]);
            // The store keeps the star queued for its future start.
            const inputA = { id: 'edit', base: { focusedToday: false, startTime: '' }, patch: { focusedToday: true, startTime: '2027-01-04' }, requestId: newRequestId() };
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await host.saveTaskDraft(inputA)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const savedA = storedTask();
            expect(savedA).toMatchObject({ startTime: '2027-01-04', isFocusedToday: true });

            saveData.mockResolvedValue(undefined);
            expect(await host.saveTaskDraft({ id: 'b', base: { title: 'b' }, patch: { title: 'B' }, requestId: newRequestId() })).toMatchObject({ ok: true });
            // An unrelated write, through another path, between the failure and the retry.
            expect((await useTaskStore.getState().updateTask('other', { title: 'Other' })).success).toBe(true);
            expect(await host.saveTaskDraft(inputA)).toMatchObject({ ok: true, value: { draft: { focusedToday: true } } });
            expect(storedTask()).toBe(savedA);
        }, 15_000);

        it('answers a retry after another path wrote the task with the first reply, writing nothing', async () => {
            const host = await activateEditor([editTask({ description: 'Old notes' })]);
            const input = { id: 'edit', base: { title: 'Original' }, patch: { title: 'Mine' }, requestId: newRequestId() };
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await host.saveTaskDraft(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            saveData.mockResolvedValue(undefined);
            expect((await useTaskStore.getState().updateTask('edit', { description: 'Other notes' })).success).toBe(true);
            const afterOtherWrite = storedTask();
            // The request's receipt answers: its first reply, and nothing is written.
            expect(await host.saveTaskDraft(input)).toMatchObject({ ok: true, value: { draft: { title: 'Mine', description: 'Old notes' } } });
            expect(storedTask()).toBe(afterOtherWrite);
        }, 15_000);

        it('refuses a named section outside the resulting project, and keeps the cleanup for other edits', async () => {
            const host = await activateEditor([editTask({ projectId: 'p-work', sectionId: 's-plan' })]);
            const before = storedTask();
            saveData.mockClear();
            for (const patch of [
                { sectionId: 'missing' },
                { sectionId: 's-gone' },
                { projectId: 'p-home', sectionId: 's-plan' },
            ]) {
                const base = Object.fromEntries(Object.keys(patch).map((field) => [field, field === 'projectId' ? 'p-work' : 's-plan']));
                expect(await host.saveTaskDraft({ id: 'edit', base, patch, requestId: newRequestId() })).toEqual({
                    ok: false, error: { code: 'INVALID_INPUT', message: 'sectionId is not a valid value' },
                });
            }
            expect(saveData).not.toHaveBeenCalled();
            expect(storedTask()).toBe(before);

            expect(await host.saveTaskDraft({ id: 'edit', base: { sectionId: 's-plan' }, patch: { sectionId: 's-ship' }, requestId: newRequestId() }))
                .toMatchObject({ ok: true, value: { draft: { sectionId: 's-ship' } } });
            // Moving projects without naming a section still drops the old one, as in the mobile editor.
            expect(await host.saveTaskDraft({ id: 'edit', base: { projectId: 'p-work' }, patch: { projectId: 'p-home' }, requestId: newRequestId() }))
                .toMatchObject({ ok: true, value: { draft: { projectId: 'p-home', sectionId: '' } } });
        });

        it('saves an Inbox start date with the same store patch and result as the mobile editor', async () => {
            const host = await activateEditor([
                task('via-host', '2026-09-01T00:00:00.000Z', { status: 'inbox' }),
                task('via-adapter', '2026-09-01T00:00:00.000Z', { status: 'inbox' }),
            ]);
            const updateTask = vi.spyOn(useTaskStore.getState(), 'updateTask');
            expect(await host.saveTaskDraft({
                requestId: newRequestId(),
                id: 'via-host', base: { status: 'inbox', startTime: '' }, patch: { status: 'inbox', startTime: '2026-10-01' },
            })).toMatchObject({ ok: true });
            // The mobile editor: the same draft edit through its save composition, then the store.
            const adapterTask = storedTask('via-adapter')!;
            const state = createTaskEditDraft(adapterTask);
            const adapterPatch = buildTaskEditUpdatePatch({ ...state, draft: setTaskDraftField(state.draft, 'startTime', '2026-10-01') }, adapterTask);
            expect((await useTaskStore.getState().updateTask('via-adapter', adapterPatch!)).success).toBe(true);

            expect(updateTask.mock.calls.map(([, patch]) => patch)).toEqual([adapterPatch, adapterPatch]);
            const outcome = (id: string) => {
                const saved = storedTask(id)!;
                return { status: saved.status, startTime: saved.startTime, isFocusedToday: saved.isFocusedToday };
            };
            // Both promote the task to Next: a start date is a clarify decision in the store.
            expect(outcome('via-host')).toEqual(outcome('via-adapter'));
            expect(outcome('via-host')).toMatchObject({ status: 'next', startTime: '2026-10-01' });
        });

        it('suggests tokens and people like the mobile fields', async () => {
            const host = createNativeHostContract();
            expect(host.getTaskEditorSuggestions({ id: 'edit', field: 'contexts', query: '@o', limit: 4 }))
                .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            getData.mockResolvedValue(editorData([
                editTask({ contexts: ['@office'] }),
                task('home', '2026-09-01T00:00:00.000Z', { contexts: ['@home'], tags: ['#launch'], assignedTo: 'Sam' }),
                task('archived', '2026-09-01T00:00:00.000Z', { status: 'archived', contexts: ['@offsite'] }),
                task('bare', '2026-09-01T00:00:00.000Z', { status: 'archived', contexts: ['Seasonal Planning'] }),
                task('deleted', '2026-09-01T00:00:00.000Z', { deletedAt: '2026-09-02T00:00:00.000Z', contexts: ['@offer'] }),
            ]));
            expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });

            const state = useTaskStore.getState();
            const derived = state.getDerivedState();
            const contexts = host.getTaskEditorSuggestions({ id: 'edit', field: 'contexts', query: '@o', limit: 4 });
            expect(contexts).toEqual({ ok: true, value: getTaskEditorSuggestions({
                field: 'contexts', text: '@o', limit: 4, knownTokens: ['@home', '@office', '@offsite', '@Seasonal Planning'], usage: derived.contextTokenUsage,
                people: state.people, tasks: state.tasks,
            }) });
            // Typed matches include retained history, ranked before substring matches.
            expect(contexts.ok && contexts.value.matches).toEqual([
                { value: '@office', text: '@office, ' },
                { value: '@offsite', text: '@offsite, ' },
                { value: '@home', text: '@home, ' },
                { value: '@Seasonal Planning', text: '@Seasonal Planning, ' },
            ]);
            expect(contexts.ok && contexts.value.quick.map((item) => item.value)).not.toContain('@offsite');
            expect(host.getTaskEditorSuggestions({ id: 'edit', field: 'contexts', query: '@offer', limit: 4 }))
                .toMatchObject({ ok: true, value: { matches: [] } });
            expect(host.getTaskEditorSuggestions({ id: 'edit', field: 'contexts', query: 'Seas', limit: 4 }))
                .toMatchObject({ ok: true, value: { matches: [{ value: '@Seasonal Planning', text: '@Seasonal Planning, ' }] } });
            expect(contexts.ok && contexts.value.draftValue).toBe('@o');
            expect(host.getTaskEditorSuggestions({ id: 'edit', field: 'tags', query: '', limit: 4 }))
                .toMatchObject({ ok: true, value: { matches: [], quick: [{ value: '#launch', selected: false, text: '#launch' }] } });
            // Loading made Sam a person just now, so the more recent Sam comes first.
            expect(host.getTaskEditorSuggestions({ id: 'edit', field: 'assignedTo', query: 'a', limit: 4 }))
                .toMatchObject({ ok: true, value: { draftValue: 'a', matches: [{ value: 'Sam', text: 'Sam' }, { value: 'Alex', text: 'Alex' }], quick: [] } });
            expect(host.getTaskEditorSuggestions({ id: 'missing', field: 'tags', query: '', limit: 4 }))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            for (const input of [
                { id: 'edit', field: 'title', query: '', limit: 4 },
                { id: 'edit', field: 'tags', query: '', limit: 0 },
                { id: 'edit', field: 'tags', query: 'x'.repeat(2001), limit: 4 },
            ]) {
                expect(host.getTaskEditorSuggestions(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
        });

        it('rejects read-only tasks and invalid drafts without writing', async () => {
            const host = createNativeHostContract();
            expect(await host.saveTaskDraft({ id: 'edit', base: { title: 'Original' }, patch: { title: 'Mine' }, requestId: newRequestId() }))
                .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            getData.mockResolvedValue(editorData([
                editTask(),
                task('archived-project', '2026-09-01T00:00:00.000Z', { projectId: 'p-old' }),
            ]));
            expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
            const before = { edit: storedTask(), archived: storedTask('archived-project') };
            saveData.mockClear();

            expect(await host.saveTaskDraft({ id: 'archived-project', base: { title: 'archived-project' }, patch: { title: 'Mine' }, requestId: newRequestId() }))
                .toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'Task is read-only while its project is archived' } });
            expect(await host.saveTaskDraft({ id: 'missing', base: { title: 'x' }, patch: { title: 'y' }, requestId: newRequestId() }))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            const invalid: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
                [{}, {}, 'patch must include a draft field'],
                [{ secret: 'a' }, { secret: 'b' }, 'patch fields must be task draft fields'],
                [{ title: 'Original' }, { description: 'Private words' }, 'base and patch fields must match: title, description'],
                [{ status: 'next' }, { status: 'archived' }, 'status is not a valid value'],
                [{ dueDate: '' }, { dueDate: '2026-02-30' }, 'dueDate is not a valid value'],
                [{ dueDate: '' }, { dueDate: 'tomorrow' }, 'dueDate is not a valid value'],
                [{ projectId: '' }, { projectId: 'p-old' }, 'projectId is not a valid value'],
                [{ areaId: '' }, { areaId: 'a-missing' }, 'areaId is not a valid value'],
                [{ title: 'Original' }, { title: null }, 'title is not a valid value'],
                [{ recurrenceRRule: '' }, { recurrenceRRule: 'Private words' }, 'recurrenceRRule is not a valid value'],
                [{ timeEstimate: '' }, { timeEstimate: '90min' }, 'timeEstimate is not a valid value'],
                [{ relativeStartOffset: null }, { relativeStartOffset: { amount: 1.5, unit: 'day' } }, 'relativeStartOffset is not a valid value'],
            ];
            for (const [base, patch, message] of invalid) {
                expect(await host.saveTaskDraft({ id: 'edit', base, patch, requestId: newRequestId() } as never)).toEqual({
                    ok: false, error: { code: 'INVALID_INPUT', message },
                });
            }
            expect(saveData).not.toHaveBeenCalled();
            expect({ edit: storedTask(), archived: storedTask('archived-project') }).toEqual(before);
        });
        describe('draft edits (editTaskDraft)', () => {
            type Host = ReturnType<typeof createNativeHostContract>;
            // A host keeps the draft as JSON: unset fields drop out.
            const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
            const openDraft = (host: Host, id = 'edit') => {
                const result = host.getTaskEditorModel({ id });
                if (!result.ok) throw new Error(result.error.message);
                return json(result.value.draft);
            };
            const edited = (host: Host, draft: TaskDraft, edit?: NativeTaskDraftEdit, id = 'edit') => {
                const result = host.editTaskDraft({ id, draft, edit });
                if (!result.ok) throw new Error(result.error.message);
                return result.value;
            };
            // saveTaskDraft's base and patch: the fields the edit changed.
            const changes = (before: TaskDraft, after: TaskDraft) => {
                const fields = (Object.keys({ ...before, ...after }) as Array<keyof TaskDraft>)
                    .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
                return {
                    base: Object.fromEntries(fields.map((field) => [field, before[field] ?? null])),
                    patch: Object.fromEntries(fields.map((field) => [field, after[field] ?? null])),
                } as { base: Partial<TaskDraft>; patch: Partial<TaskDraft> };
            };

            it('keeps inherited policy through native Send then Use default and legacy Skip then Use default', async () => {
                const host = await activateEditor([editTask({ reminderPolicy: 'inherit', suppressMindwtrReminders: true })], { taskReminderDefault: 'skip' });
                const original = openDraft(host);
                const sent = edited(host, original, { type: 'fields', patch: { reminderPolicy: 'send' } }).draft;
                const inherited = edited(host, sent, { type: 'fields', patch: { reminderPolicy: 'inherit' } }).draft;
                expect(inherited.suppressMindwtrReminders).toBe(true);
                expect(changes(original, inherited).patch).toEqual({});
                const renamed = edited(host, inherited, { type: 'fields', patch: { title: 'Renamed' } }).draft;
                expect(await host.saveTaskDraft({ id: 'edit', ...changes(original, renamed), requestId: newRequestId() }))
                    .toMatchObject({ ok: true, value: { draft: { reminderPolicy: 'inherit' } } });
                expect(storedTask().reminderPolicy).toBe('inherit');

                const legacyHost = await activateEditor([editTask({ suppressMindwtrReminders: true })], { taskReminderDefault: 'skip' });
                const legacy = openDraft(legacyHost);
                const usingDefault = edited(legacyHost, legacy, { type: 'fields', patch: { reminderPolicy: 'inherit' } }).draft;
                const diff = changes(legacy, usingDefault);
                expect(diff.patch).toEqual({ reminderPolicy: 'inherit' });
                expect(await legacyHost.saveTaskDraft({ id: 'edit', ...diff, requestId: newRequestId() }))
                    .toMatchObject({ ok: true, value: { draft: { reminderPolicy: 'inherit', suppressMindwtrReminders: true } } });
                expect(storedTask().reminderPolicy).toBe('inherit');
            });

            it('serves the model for an unsaved draft, as the editor shows it while editing', async () => {
                freezeClock();
                const host = await activateEditor([editTask({ projectId: 'p-work', dueDate: '2026-09-25' })], {
                    gtd: { viewSections: { someday: [{ id: 'vs-books', title: 'Books', order: 0 }] } },
                });
                const draft = openDraft(host);
                const same = edited(host, draft);
                const model = host.getTaskEditorModel({ id: 'edit' });
                expect(model.ok && json(same)).toEqual(model.ok && json(model.value));

                const all = (value: NativeTaskEditorModel) => value.layout.sections.flatMap(({ fields }) => fields);
                const reference = edited(host, draft, { type: 'fields', patch: { status: 'reference' } });
                expect(all(reference)).not.toContain('dueDate');
                expect(reference.layout.showStatusField).toBe(false);
                const described = edited(host, draft, { type: 'fields', patch: { location: 'Desk' } });
                expect(all(described)).toContain('location');
                const someday = edited(host, draft, { type: 'fields', patch: { status: 'someday' } });
                expect(someday.layout.showSomedaySection).toBe(true);
                expect(someday.options.somedaySections.map(({ id }) => id)).toEqual(['', 'vs-books']);
                const moved = edited(host, draft, { type: 'fields', patch: { projectId: 'p-home', sectionId: '' } });
                expect(moved.options.sections).toEqual([]);
                expect(edited(host, draft).options.sections.map(({ id }) => id)).toEqual(['s-ship', 's-plan']);
                // Nothing is written.
                expect(storedTask()?.status).toBe('next');
            });

            it('applies one backdated draft edit while leaving storage and omitted minutes alone', async () => {
                freezeClock();
                const host = await activateEditor([editTask({ timeSpentMinutes: 35 })]);
                saveData.mockClear();
                const draft = openDraft(host);
                const instant = '2026-09-20T10:15:30.123Z';
                const opening = host.getTaskEditorModel({ id: 'edit' });
                if (!opening.ok) throw new Error(opening.error.message);
                expect(opening.value.backdatedCompletionStart).toEqual({
                    initialValue: null, initialTimeSpentMinutes: 35,
                });
                const withoutMinutes = edited(host, draft, { type: 'backdatedCompletion', completedAt: instant });
                expect(withoutMinutes.draft).toMatchObject({ status: 'done', completedAt: instant, timeSpentMinutes: 35 });
                expect(withoutMinutes.backdatedCompletionStart.initialValue).toBe(instant);
                const cleared = edited(host, draft, { type: 'backdatedCompletion', completedAt: instant, timeSpentText: '' });
                expect(cleared.draft.status).toBe('done');
                expect(cleared.draft.timeSpentMinutes).toBeUndefined();
                const capped = edited(host, draft, { type: 'backdatedCompletion', completedAt: instant, timeSpentText: '100001' });
                expect(capped.draft.timeSpentMinutes).toBe(100_000);
                for (const edit of [
                    { type: 'backdatedCompletion', completedAt: '2026-09-20' },
                    { type: 'backdatedCompletion', completedAt: '2026-02-30T10:15:30.123Z' },
                    { type: 'backdatedCompletion', completedAt: instant, timeSpentText: '1'.repeat(201) },
                ]) {
                    expect(host.editTaskDraft({ id: 'edit', draft, edit: edit as NativeTaskDraftEdit }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                }
                expect(storedTask('edit')).toMatchObject({ status: 'next', timeSpentMinutes: 35 });
                expect(saveData).not.toHaveBeenCalled();
            });

            it('round-trips date input baselines through JSON without weakening prepared raw date intent', async () => {
                const originalTz = process.env.TZ;
                try {
                    process.env.TZ = 'America/New_York';
                    freezeClock();
                    const host = await activateEditor([editTask({ dueDate: '2026-10-05T15:00:00.000Z', startTime: '2026-10-04T14:00:00.000Z' })]);
                    const opening = host.getTaskEditorModel({ id: 'edit' });
                    if (!opening.ok) throw new Error(opening.error.message);
                    const draft = json(opening.value.draft);
                    expect(draft.dateInputBaseline).toMatchObject({ taskId: 'edit', dueDate: { raw: '2026-10-05T15:00:00.000Z', input: '2026-10-05T11:00' } });
                    process.env.TZ = 'America/Los_Angeles';
                    saveData.mockClear();
                    const titleEdit = edited(host, draft, { type: 'fields', patch: { title: 'After' } });
                    expect(titleEdit.draft.dateInputBaseline).toEqual(draft.dateInputBaseline);
                    expect(titleEdit.scheduleBase).toEqual(opening.value.scheduleBase);
                    const recoveredView = host.getTaskView({ id: 'edit', draft });
                    const savedView = host.getTaskView({ id: 'edit' });
                    if (!recoveredView.ok || !savedView.ok) throw new Error('Task view did not load');
                    expect(recoveredView.value.rows).toEqual(savedView.value.rows);
                    const { dateInputBaseline: _baseline, ...legacyDraft } = draft;
                    expect(host.editTaskDraft({ id: 'edit', draft: legacyDraft })).toMatchObject({ ok: true });
                    const { reminderPolicy: _policy, ...preUpgradeDraft } = legacyDraft;
                    expect(host.editTaskDraft({ id: 'edit', draft: preUpgradeDraft as TaskDraft }))
                        .toMatchObject({ ok: true, value: { draft: { reminderPolicy: 'send' } } });
                    expect(host.editTaskDraft({ id: 'edit', draft: { ...preUpgradeDraft, suppressMindwtrReminders: true } as TaskDraft }))
                        .toMatchObject({ ok: true, value: { draft: { reminderPolicy: 'skip' } } });
                    expect(host.editTaskDraft({ id: 'edit', draft: { ...draft, reminderPolicy: 'invalid' } as unknown as TaskDraft }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                    expect(host.editTaskDraft({ id: 'edit', draft: { ...draft, dateInputBaseline: { taskId: 'edit' } } as TaskDraft }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                    expect(host.editTaskDraft({ id: 'edit', draft, edit: { type: 'fields', patch: { dateInputBaseline: draft.dateInputBaseline } } }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                    expect(await host.saveTaskDraft({ id: 'edit', base: { dateInputBaseline: draft.dateInputBaseline }, patch: { dateInputBaseline: draft.dateInputBaseline } }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                    expect(saveData).not.toHaveBeenCalled();

                    // Explicit native date intent remains raw even when it equals
                    // the opening projection that RN now protects from drift.
                    const prepared = host.prepareTaskDraftSave({ id: 'edit', base: { dueDate: draft.dueDate }, patch: { dueDate: draft.dueDate }, scheduleBase: opening.value.scheduleBase });
                    if (!prepared.ok) throw new Error(prepared.error.message);
                    const recovered = json(prepared.value);
                    expect(await host.commitPreparedTaskDraftSave({ request: recovered.request, prepared: recovered })).toMatchObject({ ok: true });
                    expect(storedTask()).toMatchObject({ dueDate: '2026-10-05T11:00', startTime: '2026-10-04T14:00:00.000Z' });
                } finally {
                    if (originalTz === undefined) delete process.env.TZ;
                    else process.env.TZ = originalTz;
                }
            });

            it('moves a relative start with its due date and keeps the link through the save', async () => {
                freezeClock();
                const host = await activateEditor([editTask({
                    dueDate: '2026-09-28', startTime: '2026-09-26', relativeStartOffset: { amount: -2, unit: 'day' },
                })]);
                const draft = openDraft(host);
                const moved = edited(host, draft, { type: 'pickDate', field: 'dueDate', date: '2026-10-05' });
                expect(moved.draft).toMatchObject({ dueDate: '2026-10-05', startTime: '2026-10-03', relativeStartOffset: { amount: -2, unit: 'day' } });
                expect(moved.fields.relativeStart).toMatchObject({ active: true, amount: 2, unit: 'day' });

                const { base, patch } = changes(draft, json(moved.draft));
                expect(await host.saveTaskDraft({ id: 'edit', base, patch, requestId: newRequestId() })).toMatchObject({ ok: true });
                expect(storedTask()).toMatchObject({
                    dueDate: '2026-10-05', startTime: '2026-10-03', relativeStartOffset: { amount: -2, unit: 'day' },
                });

                // A hand-set start ends the link; clearing the due ends it too.
                const next = openDraft(host);
                expect(edited(host, next, { type: 'pickDate', field: 'startTime', date: '2026-10-01' }).draft.relativeStartOffset).toBeUndefined();
                expect(edited(host, next, { type: 'date', field: 'dueDate', value: '' }).draft).toMatchObject({
                    dueDate: '', startTime: '2026-10-03',
                });
                expect(edited(host, next, { type: 'date', field: 'dueDate', value: '' }).draft.relativeStartOffset).toBeUndefined();
                const weekly = edited(host, next, { type: 'relativeStart', amount: '1', unit: 'week' });
                expect(weekly.draft).toMatchObject({ startTime: '2026-09-28', relativeStartOffset: { amount: -1, unit: 'week' } });
                expect(edited(host, next, { type: 'relativeStart', amount: 'x', unit: 'week' }).draft).toEqual(next);
            });

            it('keeps an existing time on a new day, keeps date-only values date-only, and sets a time', async () => {
                freezeClock();
                const host = await activateEditor([
                    editTask({ dueDate: '2026-09-25T17:00', reviewAt: '2026-09-27T09:15' }),
                    task('plain', '2026-09-01T00:00:00.000Z', { status: 'next', dueDate: '2026-09-25' }),
                ], { gtd: { defaultScheduleTime: '9:05' }, dateFormat: 'ymd', timeFormat: '24h' });
                const draft = openDraft(host);
                const due = edited(host, draft, { type: 'pickDate', field: 'dueDate', date: '2026-10-01' });
                expect(due.draft.dueDate).toBe(new Date(2026, 9, 1, 17, 0).toISOString());
                expect(due.fields.dueDate).toMatchObject({ label: '2026-10-01 17:00', hasTime: true, time: '17:00', dateOnly: '2026-10-01' });
                expect(edited(host, draft, { type: 'pickDate', field: 'reviewAt', date: '2026-10-02' }).draft.reviewAt).toBe('2026-10-02T09:15');
                // No time yet: the default schedule time is added.
                expect(edited(host, draft, { type: 'pickDate', field: 'startTime', date: '2026-10-01' }).draft.startTime).toBe('2026-10-01T09:05');
                const timed = edited(host, draft, { type: 'pickTime', field: 'dueDate', time: '08:30' });
                expect(timed.draft.dueDate).toBe(new Date(2026, 8, 25, 8, 30).toISOString());
                expect(timed.fields.dueDate.picker).toEqual({ date: '2026-09-25', time: '08:30' });

                const plain = openDraft(host, 'plain');
                const moved = edited(host, plain, { type: 'pickDate', field: 'dueDate', date: '2026-10-01' }, 'plain');
                expect(moved.draft.dueDate).toBe('2026-10-01T09:05');
                const chip = edited(host, plain, undefined, 'plain').fields.dueDate.quickDates.find(({ preset }) => preset === 'tomorrow')!;
                expect(chip).toMatchObject({ label: 'Tomorrow', selected: false, value: '2026-09-24T09:05' });
                // Labels follow the user's date settings through the host's formatter, not the global one.
                expect(edited(host, plain, undefined, 'plain').fields.dueDate.label).toBe('2026-09-25');
                expect(getDateFormattingConfig().dateFormat).not.toBe('ymd');
            });

            it('sets a picked time on the field\'s own day, across DST changes and late in the evening', async () => {
                const originalTz = process.env.TZ;
                process.env.TZ = 'America/New_York';
                try {
                    vi.useFakeTimers({ toFake: ['Date'] });
                    // Today is the spring DST change: 02:00-03:00 does not exist today.
                    vi.setSystemTime(new Date('2027-03-14T10:00:00'));
                    const host = await activateEditor([
                        editTask({ dueDate: '2027-03-20', startTime: '2027-03-14', reviewAt: '2027-03-20' }),
                        task('fall', '2026-09-01T00:00:00.000Z', { status: 'next', dueDate: '2027-11-07' }),
                    ]);
                    const draft = openDraft(host);
                    const local = (value: string | undefined) => {
                        const parsed = safeParseDate(value);
                        return parsed && [parsed.getMonth() + 1, parsed.getDate(), parsed.getHours(), parsed.getMinutes()];
                    };
                    const pickTime = (field: 'startTime' | 'dueDate', time: string, from = draft, id = 'edit') => (
                        edited(host, from, { type: 'pickTime', field, time }, id).draft[field]
                    );
                    expect(local(pickTime('dueDate', '02:30'))).toEqual([3, 20, 2, 30]);
                    // On the change day itself the skipped 02:30 moves forward, as the mobile editor stores it.
                    expect(local(pickTime('startTime', '02:30'))).toEqual([3, 14, 3, 30]);
                    expect(local(pickTime('dueDate', '23:30'))).toEqual([3, 20, 23, 30]);
                    const moved = edited(host, draft, { type: 'pickDate', field: 'dueDate', date: '2027-03-14' });
                    expect(local(pickTime('dueDate', '23:30', moved.draft))).toEqual([3, 14, 23, 30]);
                    // The repeated 01:30 on the autumn change takes its first occurrence (EDT).
                    vi.setSystemTime(new Date('2027-11-07T10:00:00'));
                    expect(pickTime('dueDate', '01:30', openDraft(host, 'fall'), 'fall')).toBe('2027-11-07T05:30:00.000Z');
                    // Review has no time in the mobile editor.
                    expect(host.editTaskDraft({ id: 'edit', draft, edit: { type: 'pickTime', field: 'reviewAt' as never, time: '14:30' } }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                } finally {
                    if (originalTz === undefined) delete process.env.TZ;
                    else process.env.TZ = originalTz;
                }
            });

            it('refuses a relative start the store would not keep', async () => {
                freezeClock();
                const host = await activateEditor([editTask({ dueDate: '2026-09-28' })]);
                const draft = openDraft(host);
                expect(edited(host, draft, { type: 'relativeStart', amount: '10000', unit: 'day' }).draft.relativeStartOffset)
                    .toEqual({ amount: -10000, unit: 'day' });
                for (const amount of ['10001', 99999, '1e9']) {
                    expect(host.editTaskDraft({ id: 'edit', draft, edit: { type: 'relativeStart', amount, unit: 'day' } }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                }
                // Negative input starts on the due date, as the mobile input does.
                expect(edited(host, draft, { type: 'relativeStart', amount: '-4', unit: 'day' }).draft)
                    .toMatchObject({ startTime: '2026-09-28', relativeStartOffset: { amount: 0, unit: 'day' } });
            });

            it('edits recurrence details through the rule, keeping its end', async () => {
                freezeClock();
                const host = await activateEditor([editTask({
                    dueDate: '2026-09-28', recurrence: { rule: 'weekly', strategy: 'strict', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5' },
                })]);
                const draft = openDraft(host);
                const recurrence = (value: NativeTaskDraftRecurrenceEdit, from = draft) => (
                    edited(host, from, { type: 'recurrence', edit: value })
                );
                const model = edited(host, draft);
                expect(model.fields.recurrence).toMatchObject({ interval: 1, ends: 'count', count: 5 });
                expect(model.fields.recurrence.weekdays.filter(({ selected }) => selected).map(({ day }) => day)).toEqual(['MO']);
                expect(recurrence({ kind: 'rule', rule: 'daily' }).draft.recurrenceRRule).toBe('FREQ=DAILY;COUNT=5');
                expect(recurrence({ kind: 'weekday', day: 'WE' }).draft.recurrenceRRule).toBe('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5');
                expect(recurrence({ kind: 'weekday', day: 'MO' }).draft.recurrenceRRule).toBe('FREQ=WEEKLY;COUNT=5');
                expect(recurrence({ kind: 'interval', text: '3' }).draft.recurrenceRRule).toBe('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO;COUNT=5');
                expect(recurrence({ kind: 'count', text: '8' }).draft.recurrenceRRule).toBe('FREQ=WEEKLY;BYDAY=MO;COUNT=8');
                const until = recurrence({ kind: 'ends', ends: 'until' });
                expect(until.fields.recurrence).toMatchObject({ ends: 'until', until: '2026-09-28' });
                expect(recurrence({ kind: 'until', date: '2026-12-31' }, until.draft).draft.recurrenceRRule).toContain('UNTIL=20261231');
                expect(recurrence({ kind: 'strategy' }).draft.recurrenceStrategy).toBe('fluid');
                expect(recurrence({ kind: 'rule', rule: '' }).draft).toMatchObject({ recurrence: '', recurrenceRRule: '' });
                const monthly = recurrence({ kind: 'monthlyCustom', custom: { interval: 2, mode: 'nth', ordinal: '-1', weekday: 'FR', monthDays: [28] } });
                expect(monthly.draft).toMatchObject({ recurrence: 'monthly', recurrenceRRule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=5' });
                expect(monthly.layout.recurrence.monthlyPattern).toBe('custom');
                expect(monthly.fields.recurrence.monthlyCustom).toMatchObject({ mode: 'nth', ordinal: '-1', weekday: 'FR', interval: 2 });
                const lastWeekday = recurrence({ kind: 'monthlyCustom', custom: { interval: 1, mode: 'nth', ordinal: '-1', weekday: 'WEEKDAY', monthDays: [28] } });
                expect(lastWeekday.draft.recurrenceRRule).toBe('FREQ=MONTHLY;BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1;COUNT=5');
                expect(lastWeekday.fields.recurrence.monthlyCustom).toMatchObject({ mode: 'nth', ordinal: '-1', weekday: 'WEEKDAY' });
            });

            it('offers quick dates, the date issue, reminder intervals, and parses estimates and time spent', async () => {
                freezeClock();
                const host = await activateEditor([editTask({
                    startTime: '2026-09-30', dueDate: '2026-09-26T21:00:00.000Z', timeEstimate: '2hr',
                })], { features: { pomodoro: true }, gtd: { pomodoro: { linkTask: true } } });
                const draft = openDraft(host);
                const model = edited(host, draft);
                expect(model.fields.dateIssue).toBe('Starts after due date');
                expect(model.fields.startTime.quickDates.map(({ label }) => label))
                    .toEqual(['Today', 'Tomorrow', '+3 days', 'Next week', 'Next month', 'No date']);
                const today = model.fields.startTime.quickDates[0];
                expect(edited(host, draft, { type: 'date', field: 'startTime', value: today.value }).draft.startTime).toBe('2026-09-23');
                expect(edited(host, draft, { type: 'date', field: 'startTime', value: model.fields.startTime.quickDates[5].value }).draft.startTime).toBe('');
                expect(model.fields.reminders).toMatchObject({ showSkip: true, showRepeat: true, repeatValueLabel: 'Off' });
                expect(model.fields.reminders.repeatOptions.map(({ value }) => value)).toEqual([null, 5, 10, 15, 30, 60]);
                const every15 = edited(host, draft, { type: 'fields', patch: { repeatReminderMinutes: 15 } });
                expect(every15.fields.reminders.repeatValueLabel).toBe('Every 15 min');
                expect(edited(host, draft, { type: 'fields', patch: { suppressMindwtrReminders: true } }).fields.reminders.showRepeat).toBe(false);

                expect(model.fields.timeEstimate).toMatchObject({ customSelected: false, customValue: 'custom:120', customText: '' });
                const custom = edited(host, draft, { type: 'timeEstimate', text: '2h30' });
                expect(custom.draft.timeEstimate).toBe('custom:150');
                expect(custom.fields.timeEstimate).toMatchObject({ customSelected: true, customText: '2h 30m' });
                expect(edited(host, custom.draft, { type: 'timeEstimate', text: 'abc' }).draft.timeEstimate).toBe('custom:150');
                expect(model.fields.timeSpent).toEqual({ enabled: true });
                expect(edited(host, draft, { type: 'timeSpent', text: '1a2' }).draft.timeSpentMinutes).toBe(12);
                expect(edited(host, draft, { type: 'timeSpent', text: '' }).draft.timeSpentMinutes).toBeUndefined();
                expect(JSON.parse(JSON.stringify(model.fields))).toEqual(model.fields);
            });

            it('refuses an invalid draft or edit, and waits for storage', async () => {
                const host = createNativeHostContract();
                expect(host.editTaskDraft({ id: 'edit', draft: {} as TaskDraft })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
                getData.mockResolvedValue(editorData([editTask()]));
                expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
                const draft = openDraft(host);
                const { title: _title, ...untitled } = draft;
                const invalid: Array<[unknown, unknown]> = [
                    [untitled, undefined],
                    [{ ...draft, secret: 'x' }, undefined],
                    [{ ...draft, dueDate: 'tomorrow' }, undefined],
                    [draft, { type: 'unknown' }],
                    [draft, { type: 'fields', patch: { status: 'archived' } }],
                    [draft, { type: 'date', field: 'completedAt', value: '' }],
                    [draft, { type: 'pickDate', field: 'dueDate', date: '2026-02-30' }],
                    [draft, { type: 'pickTime', field: 'reviewAt', time: '10:00' }],
                    [draft, { type: 'pickTime', field: 'dueDate', time: '24:00' }],
                    [draft, { type: 'relativeStart', amount: 1, unit: 'month' }],
                    [draft, { type: 'recurrence', edit: { kind: 'rule', rule: 'hourly' } }],
                    [draft, { type: 'recurrence', edit: { kind: 'monthlyCustom', custom: { interval: 0, mode: 'date', ordinal: '1', weekday: 'MO', monthDays: [1] } } }],
                    [draft, { type: 'timeEstimate', text: 5 }],
                ];
                for (const [value, edit] of invalid) {
                    expect(host.editTaskDraft({ id: 'edit', draft: value as TaskDraft, edit: edit as NativeTaskDraftEdit }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                }
                expect(host.editTaskDraft({ id: 'missing', draft })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
                for (const checklist of [
                    'items',
                    [{ id: 'c-1', title: 'Pack', isCompleted: false, secret: 'x' }],
                    [{ id: 'c-1', title: 'Pack', isCompleted: 'no' }],
                    Array.from({ length: 1001 }, (_, index) => ({ id: `c-${index}`, title: '', isCompleted: false })),
                ]) {
                    expect(host.editTaskDraft({ id: 'edit', draft, checklist: checklist as never }))
                        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                }
            });

            it('lays out the editor for the host\'s edited checklist, as React Native does before a save', async () => {
                freezeClock();
                const saved = [{ id: 'c-saved', title: 'Saved', isCompleted: false }];
                const host = await activateEditor([
                    editTask(),
                    task('listed', '2026-09-01T00:00:00.000Z', { status: 'next', checklist: saved }),
                    task('reference', '2026-09-01T00:00:00.000Z', { status: 'reference' }),
                ], { gtd: { taskEditor: { hidden: ['checklist'] } } });
                const details = (value: NativeTaskEditorModel) => value.layout.sections.find(({ id }) => id === 'details');
                const layout = (id: string, checklist?: ChecklistItem[]) => {
                    const result = host.editTaskDraft({ id, draft: openDraft(host, id), checklist });
                    if (!result.ok) throw new Error(result.error.message);
                    return details(result.value);
                };
                const unsaved = [{ id: 'c-new', title: '', isCompleted: false }];

                // The field is hidden and the task has no items: no Checklist field.
                expect(layout('edit')?.fields).not.toContain('checklist');
                // An item added in the editor shows it, counts it and opens its section.
                expect(layout('edit', unsaved)).toMatchObject({ fields: expect.arrayContaining(['checklist']), filledCount: 1, open: true });
                // Items removed in the editor hide it again, though the task still has some saved.
                expect(layout('listed')?.fields).toContain('checklist');
                expect(layout('listed', [])?.fields).not.toContain('checklist');
                // A reference shows its checklist only while it has items.
                expect(layout('reference')?.fields ?? []).not.toContain('checklist');
                expect(layout('reference', unsaved)?.fields).toContain('checklist');
                // Nothing is written.
                expect(storedTask()?.checklist).toBeUndefined();
                expect(storedTask('listed')?.checklist).toEqual(saved);
            });
        });
    });

    it('matches the mobile Focus core pipeline and carries Upcoming reveal dates', async () => {
        const now = new Date(2026, 8, 23, 10, 0);
        const tomorrow = formatLocalDate(new Date(2026, 8, 24));
        const tasks = [
            task('starred', '2026-09-01T00:00:00.000Z', { status: 'next', isFocusedToday: true }),
            task('due-today', '2026-09-02T00:00:00.000Z', { status: 'next', dueDate: formatLocalDate(now) }),
            task('later-today', '2026-09-03T00:00:00.000Z', { status: 'next', startTime: new Date(2026, 8, 23, 17).toISOString() }),
            task('review-due', '2026-09-04T00:00:00.000Z', { status: 'waiting', reviewAt: new Date(2026, 8, 22).toISOString() }),
            task('seq-first', '2026-09-05T00:00:00.000Z', { status: 'next', projectId: 'seq', order: 0 }),
            task('seq-second', '2026-09-06T00:00:00.000Z', { status: 'next', projectId: 'seq', order: 1 }),
            task('upcoming', '2026-09-07T00:00:00.000Z', { status: 'next', startTime: tomorrow, description: 'Notes' }),
            task('parked-someday', '2026-09-07T00:00:00.000Z', { status: 'next', projectId: 'someday' }),
            task('parked-archived', '2026-09-07T00:00:00.000Z', { status: 'next', projectId: 'archived' }),
            task('starred-parked', '2026-09-07T00:00:00.000Z', { status: 'next', projectId: 'someday', isFocusedToday: true }),
            task('done', '2026-09-08T00:00:00.000Z', { status: 'done' }),
            task('deleted', '2026-09-09T00:00:00.000Z', { status: 'next', deletedAt: '2026-09-10T00:00:00.000Z' }),
        ];
        const host = await activateWith(tasks, [
            project('seq', 'active', 0, { isSequential: true }),
            project('someday', 'someday'),
            project('archived', 'archived'),
        ]);
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const result = host.getFocus({ limit: 20 });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const state = useTaskStore.getState();
        const actionable = state.tasks.filter(isTaskActionable);
        const projectById = new Map(state.projects.map((item) => [item.id, item]));
        const resolvedAreaFilter = resolveAreaFilterSelection(undefined, state.areas);
        const visibleTasks = actionable.filter((item) => isTaskVisibleInArea(item, { projectById, resolvedAreaFilter }));
        const pools = focusDerivation.buildFocusPools({
            tasks: actionable, visibleTasks, projects: state.projects, criteria: undefined, now,
        });
        const lists = focusDerivation.deriveFocusTaskLists(pools, {
            now, projects: state.projects, sections: state.sections,
            sortBy: focusDerivation.DEFAULT_FOCUS_SORT_BY,
            prioritiesEnabled: resolveFeatureFlags(state.settings).priorities,
            sortOrder: undefined,
        });
        const direct = focusDerivation.buildFocusTaskSections(lists, getTranslator('en'));
        const scheduleByStartTime = splitTodayTasksByStartTime(lists.schedule, now);
        expect(result.value.sections.map(({ key, title, total, rows }) => ({ key, title, total, ids: rows.map(({ id }) => id) })))
            .toEqual(direct.map(({ key, title, items }) => ({
                key, title, total: items.length,
                ids: (key === 'schedule' ? [...scheduleByStartTime.ready, ...scheduleByStartTime.laterToday] : items).map(({ id }) => id),
            })));
        expect(result.value.sections.map(({ key, title }) => ({ key, title }))).toEqual([
            { key: 'focus', title: "Today's Focus" },
            { key: 'schedule', title: 'Today' },
            { key: 'next', title: 'Next Actions' },
            { key: 'reviewDue', title: 'Review Due' },
            { key: 'upcoming', title: 'Upcoming' },
        ]);
        const visibleIds = result.value.sections.flatMap(({ rows }) => rows.map(({ id }) => id));
        for (const id of ['seq-second', 'parked-someday', 'parked-archived', 'done', 'deleted']) expect(visibleIds).not.toContain(id);
        expect(result.value.sections.find(({ key }) => key === 'focus')?.rows.map(({ id }) => id)).toContain('starred-parked');
        expect(result.value.sections.find(({ key }) => key === 'next')?.rows.map(({ id }) => id)).toContain('seq-first');
        expect(result.value.sections.find(({ key }) => key === 'schedule')?.rows.map(({ id, laterToday }) => ({ id, laterToday })))
            .toEqual([{ id: 'due-today', laterToday: false }, { id: 'later-today', laterToday: true }]);
        expect(result.value.sections.find(({ key }) => key === 'schedule')?.rows.map(({ laterTodayLabel }) => laterTodayLabel))
            .toEqual([null, safeFormatDate(tasks.find(({ id }) => id === 'later-today')!.startTime, 'p')]);
        const reveal = pools.upcoming.find(({ task: item }) => item.id === 'upcoming')?.appearsAt;
        expect(reveal).toBeInstanceOf(Date);
        expect(reveal && formatLocalDate(reveal)).toBe('2026-09-24');
        expect(result.value.sections.find(({ key }) => key === 'upcoming')?.rows[0])
            .toMatchObject({ id: 'upcoming', revealDate: '2026-09-24', hasNotes: true, laterToday: false });
        expect(result.value.sections.filter(({ key }) => key !== 'schedule').flatMap(({ rows }) => rows.every(({ laterToday }) => !laterToday)))
            .toEqual([true, true, true, true]);
        expect(result.value.sections.filter(({ key }) => key !== 'upcoming').flatMap(({ rows }) => rows.map(({ revealDate }) => revealDate)))
            .toEqual(Array(visibleIds.length - 1).fill(null));
    });

    it('translates Focus titles and invalidates the English revision after a language change', async () => {
        const now = new Date(2026, 8, 23, 10);
        const host = await activateWith([
            task('starred', '2026-09-01T00:00:00.000Z', { status: 'next', isFocusedToday: true }),
            task('upcoming', '2026-09-01T00:00:00.000Z', { status: 'next', startTime: formatLocalDate(new Date(2026, 8, 24)) }),
        ]);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now);
        const english = host.getFocus({ limit: 10 });
        if (!english.ok) throw new Error('English Focus query failed');
        expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: null }))
            .toEqual({ ok: true, value: { language: 'zh' } });
        const chinese = host.getFocus({ limit: 10 });
        if (!chinese.ok) throw new Error('Chinese Focus query failed');
        expect(chinese.value.sections.map(({ key, title }) => ({ key, title }))).toEqual([
            { key: 'focus', title: zhHans['agenda.todaysFocus'] },
            { key: 'schedule', title: zhHans['focus.schedule'] },
            { key: 'next', title: zhHans['focus.nextActions'] },
            { key: 'reviewDue', title: zhHans['agenda.reviewDue'] },
            { key: 'upcoming', title: zhHans['agenda.upcoming'] },
        ]);
        expect(chinese.value.revision).not.toBe(english.value.revision);
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: english.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('matches React Native Upcoming reveal text in English and Chinese with explicit date settings', async () => {
        const host = await activateWith([task('upcoming', '2026-09-01T00:00:00.000Z', {
            status: 'next', startTime: '2026-09-24',
        })]);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 10));
        for (const expected of followupParity.upcoming) {
            expect(await host.setLanguage({ storedLanguage: expected.language, systemLocale: expected.systemLocale })).toMatchObject({ ok: true });
            configureDateFormatting({ language: expected.language, systemLocale: expected.systemLocale });
            const rnLabel = safeFormatDate(new Date(2026, 8, 24), 'P');
            expect(rnLabel).toBe(expected.revealLabel);
            const sentinel = { language: 'fa', dateFormat: 'ymd', calendarSystem: 'jalali', systemLocale: 'fa-IR' } as const;
            configureDateFormatting(sentinel);
            const result = host.getFocus({ limit: 10 });
            if (!result.ok) throw new Error('Focus query failed');
            expect(result.value.sections.find(({ key }) => key === 'upcoming')?.rows[0])
                .toMatchObject({ revealDate: expected.revealDate, revealLabel: rnLabel });
            expect(getDateFormattingConfig()).toEqual(sentinel);
        }
        configureDateFormatting();
    });

    it('matches React Native Upcoming blocked star text in English and Chinese', async () => {
        const host = await activateWith([task('upcoming', '2026-09-01T00:00:00.000Z', {
            status: 'next', startTime: '2026-09-24',
        })]);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 10));
        useTaskStore.setState({ settings: { gtd: { focusTaskLimit: 99 } } });
        for (const expected of followupParity.upcoming) {
            expect(await host.setLanguage({ storedLanguage: expected.language, systemLocale: expected.systemLocale })).toMatchObject({ ok: true });
            const result = host.getFocus({ limit: 10 });
            if (!result.ok) throw new Error('Focus query failed');
            const rnLabel = getFocusStarBlockedText(getTranslator(expected.language), { blockedReason: 'deferred' }, normalizeFocusTaskLimit(99));
            expect(rnLabel).toBe(expected.focusBlockedLabel);
            expect(result.value.sections.find(({ key }) => key === 'upcoming')?.focusBlockedLabel).toBe(rnLabel);
            expect(result.value.sections.filter(({ key }) => key !== 'upcoming').every(({ focusBlockedLabel }) => focusBlockedLabel === null)).toBe(true);
        }
    });

    it('follows core ordering with priorities enabled and disabled', async () => {
        const now = new Date(2026, 8, 23, 10);
        const items = [
            task('urgent-later-created', '2026-09-02T00:00:00.000Z', { status: 'next', dueDate: formatLocalDate(now), priority: 'urgent' }),
            task('low-earlier-created', '2026-09-01T00:00:00.000Z', { status: 'next', dueDate: formatLocalDate(now), priority: 'low' }),
        ];
        const host = await activateWith(items);
        vi.useFakeTimers();
        vi.setSystemTime(now);
        for (const priorities of [true, false]) {
            useTaskStore.setState({ settings: { features: { priorities } } });
            const result = host.getFocus({ limit: 10 });
            if (!result.ok) throw new Error('Focus query failed');
            const state = useTaskStore.getState();
            const active = state.tasks.filter(isTaskActionable);
            const pools = focusDerivation.buildFocusPools({ tasks: active, visibleTasks: active, projects: state.projects, criteria: undefined, now });
            const direct = focusDerivation.deriveFocusTaskLists(pools, {
                now, projects: state.projects, sections: state.sections, sortBy: focusDerivation.DEFAULT_FOCUS_SORT_BY,
                prioritiesEnabled: resolveFeatureFlags(state.settings).priorities, sortOrder: undefined,
            });
            expect(result.value.sections.find(({ key }) => key === 'schedule')?.rows.map(({ id }) => id))
                .toEqual(direct.schedule.map(({ id }) => id));
            expect(result.value.sections.find(({ key }) => key === 'schedule')?.rows.map(({ id }) => id))
                .toEqual(priorities ? ['urgent-later-created', 'low-earlier-created'] : ['low-earlier-created', 'urgent-later-created']);
        }
    });

    it('bounds initial Focus rows and pages a section beyond 100 rows', async () => {
        const host = await activateWith(Array.from({ length: 215 }, (_, index) =>
            task(`next-${index}`, '2026-09-01T00:00:00.000Z', { status: 'next' })));
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 10));
        const first = host.getFocus({ limit: 50 });
        if (!first.ok) throw new Error('Focus query failed');
        expect(first.value.sections.find(({ key }) => key === 'next')).toMatchObject({ total: 215, rows: expect.any(Array) });
        expect(first.value.sections.find(({ key }) => key === 'next')?.rows).toHaveLength(50);
        const ids: string[] = [];
        for (const offset of [0, 100, 200]) {
            const page = host.getFocusSectionWindow({ key: 'next', offset, limit: 100, revision: first.value.revision });
            if (!page.ok) throw new Error('Focus page failed');
            expect(page.value).toMatchObject({ version: 1, revision: first.value.revision, key: 'next', total: 215 });
            ids.push(...page.value.rows.map(({ id }) => id));
        }
        expect(ids).toHaveLength(215);
        expect(new Set(ids).size).toBe(215);
        expect(host.getFocus({ limit: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getFocus({ limit: NATIVE_HOST_MAX_WINDOW + 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const input of [
            { key: 'bad', offset: 0, limit: 1 },
            { key: 'focus', offset: 0, limit: 1 },
            { key: 'next', offset: -1, limit: 1 },
            { key: 'next', offset: 0.5, limit: 1 },
            { key: 'next', offset: 0, limit: 0 },
            { key: 'next', offset: 0, limit: NATIVE_HOST_MAX_WINDOW + 1 },
        ]) {
            expect(host.getFocusSectionWindow({ ...input, revision: first.value.revision } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('invalidates Focus pages after store edits, minute ticks, and local midnight', async () => {
        const now = new Date(2026, 8, 23, 23, 59, 0);
        const tomorrow = formatLocalDate(new Date(2026, 8, 24));
        const host = await activateWith([
            task('editable', '2026-09-01T00:00:00.000Z', { status: 'next' }),
            task('reveals-tomorrow', '2026-09-01T00:00:00.000Z', { status: 'next', startTime: tomorrow }),
        ]);
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const first = host.getFocus({ limit: 10 });
        if (!first.ok) throw new Error('Focus query failed');
        expect(first.value.sections.find(({ key }) => key === 'upcoming')?.rows.map(({ id }) => id)).toContain('reveals-tomorrow');
        useTaskStore.setState({ _allTasks: [
            task('editable', '2026-09-01T00:00:00.000Z', { status: 'next', title: 'Edited' }),
            task('reveals-tomorrow', '2026-09-01T00:00:00.000Z', { status: 'next', startTime: tomorrow }),
        ] });
        const edited = host.getFocus({ limit: 10 });
        if (!edited.ok) throw new Error('Focus query failed');
        expect(edited.value.revision).not.toBe(first.value.revision);
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: first.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        vi.setSystemTime(new Date(2026, 8, 24, 0, 0, 0));
        const midnight = host.getFocus({ limit: 10 });
        if (!midnight.ok) throw new Error('Focus query failed');
        expect(midnight.value.revision).not.toBe(edited.value.revision);
        expect(midnight.value.sections.some(({ key }) => key === 'upcoming')).toBe(false);
        expect(midnight.value.sections.find(({ key }) => key === 'schedule')?.rows.map(({ id }) => id)).toContain('reveals-tomorrow');
        vi.setSystemTime(new Date(2026, 8, 24, 0, 1, 0));
        const minute = host.getFocus({ limit: 10 });
        if (!minute.ok) throw new Error('Focus query failed');
        expect(minute.value.revision).not.toBe(midnight.value.revision);
    });

    it('reuses the core Focus derivation for one revision', async () => {
        const host = await activateWith([task('next', '2026-09-01T00:00:00.000Z', { status: 'next' })]);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 10));
        const derive = vi.spyOn(focusDerivation, 'deriveFocusTaskLists');
        const first = host.getFocus({ limit: 1 });
        if (!first.ok) throw new Error('Focus query failed');
        expect(host.getFocus({ limit: 1 })).toEqual(first);
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: first.value.revision }).ok).toBe(true);
        expect(derive).toHaveBeenCalledTimes(1);
    });

    describe('task row meta', () => {
        const NOW = new Date(2026, 8, 23, 10, 0);
        const sections: Section[] = [{
            id: 's-1', projectId: 'p-seq', title: 'Phase 1', order: 0,
            createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        }];
        const activateMeta = async (settings: AppSettings) => {
            getData.mockResolvedValue({
                tasks: [],
                projects: [
                    project('p-seq', 'active', 0, { title: 'Launch', areaId: 'a-work', isSequential: true }),
                    project('p-due', 'active', 6, { title: 'Taxes', areaId: 'a-work', dueDate: '2026-09-20' }),
                    project('p-review', 'active', 1, { title: 'Garden', reviewAt: '2026-09-20T09:00:00' }),
                    project('p-review-early', 'active', 2, { title: 'Budget', reviewAt: '2026-09-10' }),
                    project('p-review-later', 'active', 3, { title: 'Travel', reviewAt: '2026-09-30' }),
                    project('p-review-archived', 'archived', 4, { reviewAt: '2026-09-10' }),
                    project('p-review-deleted', 'active', 5, { reviewAt: '2026-09-10', deletedAt: '2026-09-11T00:00:00.000Z' }),
                ],
                sections,
                areas: [area('a-work', 'Work', 0, { color: '#22c55e' })],
                people: [],
                settings,
            });
            const host = createNativeHostContract();
            expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
            // Set after the load, whose migrations would promote a dated Inbox task.
            useTaskStore.setState({
                _allTasks: [
                    task('inbox-due', '2026-09-02T10:00:00', {
                        dueDate: '2026-09-21', contexts: ['@home', '@phone'], tags: ['#bills'],
                        checklist: [{ id: 'c1', title: 'One', isCompleted: true }, { id: 'c2', title: 'Two', isCompleted: false }],
                    }),
                    task('seq-first', '2026-09-03T10:00:00', {
                        status: 'next', projectId: 'p-seq', sectionId: 's-1', order: 0, startTime: '2026-09-22T09:00',
                    }),
                    task('seq-second', '2026-09-04T10:00:00', { status: 'next', projectId: 'p-seq', order: 1 }),
                    task('boosted', '2026-09-05T10:00:00', { status: 'next', projectId: 'p-due' }),
                ],
            });
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(NOW);
            return host;
        };
        // What the mobile row computes with the date configuration its root layout applies.
        const mobileMeta = (id: string, settings: AppSettings, language: Language, systemLocale: string | null, options = {}) => {
            const state = useTaskStore.getState();
            const rowTask = state._allTasks.find((candidate) => candidate.id === id)!;
            return buildTaskRowMeta({
                ...options,
                task: rowTask,
                lookup: resolveTaskRowLookup(rowTask, state.projects, state.areas, state._sectionsById),
                features: resolveTaskRowFeatures(state.settings),
                language,
                dateFormatting: {
                    language: settings.language || language,
                    dateFormat: settings.dateFormat,
                    calendarSystem: settings.calendarSystem,
                    timeFormat: settings.timeFormat,
                    systemLocale,
                },
                t: getTranslator(language),
                now: NOW,
            });
        };
        afterEach(() => configureDateFormatting());

        it('formats every row with the user date settings and language, with each view like mobile', async () => {
            const settings: AppSettings = {
                language: 'de', dateFormat: 'dmy', timeFormat: '24h',
                appearance: { showTaskAge: true },
            };
            const host = await activateMeta(settings);
            expect(await host.setLanguage({ storedLanguage: 'de', systemLocale: 'de-DE' })).toMatchObject({ ok: true });
            // Rows format with the stored settings, whatever the process-wide configuration is.
            configureDateFormatting({ language: 'fa', dateFormat: 'ymd', calendarSystem: 'jalali', systemLocale: 'fa-IR' });

            const inbox = host.getInboxWindow({ offset: 0, limit: 10 });
            if (!inbox.ok) throw new Error('Inbox query failed');
            const inboxMeta = inbox.value.rows[0].meta;
            expect(inboxMeta).toEqual(mobileMeta('inbox-due', settings, 'de', 'de-DE', { hideChecklistProgress: true }));
            expect(inboxMeta.parts).toEqual([
                { kind: 'context', text: '@home', overflowCount: 1, detail: false },
                { kind: 'tag', text: '#bills', overflowCount: 0, detail: true },
                { kind: 'due', text: '21.09.2026', tone: 'overdue', detail: false },
            ]);
            expect(inboxMeta).toMatchObject({ ageLabel: '3 weeks old', statusLabel: 'Eingang', canFocus: true });

            const detail = host.getProjectDetail({ projectId: 'p-seq', offset: 0, limit: 10 });
            if (!detail.ok) throw new Error('Project detail failed');
            const firstRow = detail.value.items.find((item) => item.type === 'task' && item.row.id === 'seq-first');
            if (firstRow?.type !== 'task') throw new Error('Missing project row');
            expect(firstRow.row.meta).toEqual(mobileMeta('seq-first', settings, 'de', 'de-DE', {
                hideProjectMeta: true, sequenceCue: 'available', sequenceLabel: getTranslator('de')('projects.availableNextAction'),
            }));
            expect(firstRow.row.meta.parts.map(({ kind }) => kind)).toEqual(['start']);
            expect(firstRow.row.meta.parts[0].text).toBe(`${getTranslator('de')('taskEdit.startDateLabel')}: 22.09.2026 09:00`);
            expect(firstRow.row.meta.accessibilityLabel).toContain(getTranslator('de')('projects.availableNextAction'));

            const focus = host.getFocus({ limit: 10 });
            if (!focus.ok) throw new Error('Focus query failed');
            const focusRows = focus.value.sections.flatMap(({ rows }) => rows);
            const deadline = tFallback(getTranslator('de'), 'focus.projectOverdue', 'Project overdue');
            expect(focusRows.find(({ id }) => id === 'boosted')?.meta)
                .toEqual(mobileMeta('boosted', settings, 'de', 'de-DE', { projectDeadlineLabel: deadline }));
            expect(focusRows.find(({ id }) => id === 'boosted')?.meta.parts).toEqual([
                { kind: 'project', text: 'Taxes', projectId: 'p-due', dotColor: '#22c55e', detail: false },
                { kind: 'projectDeadline', text: deadline, detail: false },
            ]);
            expect(focusRows.find(({ id }) => id === 'seq-first')?.meta)
                .toEqual(mobileMeta('seq-first', settings, 'de', 'de-DE'));
            expect(focusRows.find(({ id }) => id === 'seq-first')?.meta.parts[0])
                .toEqual({ kind: 'project', text: 'Launch · Phase 1', projectId: 'p-seq', dotColor: '#22c55e', detail: false });
        });

        it('refreshes Inbox and project pages when settings, language, or the local day change', async () => {
            const host = await activateMeta({});
            const inbox = () => {
                const result = host.getInboxWindow({ offset: 0, limit: 1 });
                if (!result.ok) throw new Error('Inbox query failed');
                return result.value;
            };
            const project = () => {
                const result = host.getProjectDetail({ projectId: 'p-seq', offset: 0, limit: 1 });
                if (!result.ok) throw new Error('Project detail failed');
                return result.value;
            };
            const focus = () => {
                const result = host.getFocus({ limit: 10 });
                if (!result.ok) throw new Error('Focus query failed');
                return result.value;
            };
            const dueText = () => inbox().rows[0].meta.parts.find(({ kind }) => kind === 'due')?.text;
            const first = { inbox: inbox(), project: project(), focus: focus() };
            expect(dueText()).toBe('09/21/2026');
            expect(inbox().revision).toBe(first.inbox.revision);

            useTaskStore.setState({ settings: { dateFormat: 'ymd' } });
            const ymd = { inbox: inbox(), project: project(), focus: focus() };
            expect(dueText()).toBe('2026-09-21');
            expect(ymd.inbox.revision).not.toBe(first.inbox.revision);
            expect(ymd.project.revision).not.toBe(first.project.revision);
            expect(ymd.focus.revision).not.toBe(first.focus.revision);
            expect(host.getInboxWindow({ offset: 1, limit: 1, revision: first.inbox.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });

            expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-GB' })).toMatchObject({ ok: true });
            const british = { inbox: inbox(), project: project() };
            expect(british.inbox.revision).not.toBe(ymd.inbox.revision);
            expect(british.project.revision).not.toBe(ymd.project.revision);

            vi.setSystemTime(new Date(2026, 8, 24, 0, 0, 1));
            const tomorrow = { inbox: inbox(), project: project() };
            expect(tomorrow.inbox.revision).not.toBe(british.inbox.revision);
            expect(tomorrow.project.revision).not.toBe(british.project.revision);
            expect(host.getProjectDetail({ projectId: 'p-seq', offset: 1, limit: 1, revision: british.project.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        });

        it('refreshes Inbox and project pages when a timed due date passes within the day', async () => {
            const host = await activateMeta({});
            useTaskStore.setState({ _allTasks: [
                task('inbox-timed', '2026-09-20T10:00:00', { dueDate: '2026-09-23T10:01' }),
                task('project-timed', '2026-09-20T10:00:00', { status: 'next', projectId: 'p-seq', dueDate: '2026-09-23T10:01' }),
            ] });
            const read = () => {
                const inbox = host.getInboxWindow({ offset: 0, limit: 1 });
                const project = host.getProjectDetail({ projectId: 'p-seq', offset: 0, limit: 10 });
                if (!inbox.ok || !project.ok) throw new Error('Query failed');
                const projectRow = project.value.items.find((item) => item.type === 'task' && item.row.id === 'project-timed');
                return {
                    inbox: inbox.value,
                    project: project.value,
                    tones: [inbox.value.rows[0].meta, projectRow?.type === 'task' ? projectRow.row.meta : null]
                        .map((meta) => meta?.parts.find((part) => part.kind === 'due')),
                };
            };
            const before = read();
            expect(before.tones).toMatchObject([{ tone: 'dueSoon' }, { tone: 'dueSoon' }]);

            vi.setSystemTime(new Date(2026, 8, 23, 10, 2, 0));
            const after = read();
            expect(after.tones).toMatchObject([{ tone: 'overdue' }, { tone: 'overdue' }]);
            expect(after.inbox.revision).not.toBe(before.inbox.revision);
            expect(after.project.revision).not.toBe(before.project.revision);
            expect(host.getInboxWindow({ offset: 1, limit: 1, revision: before.inbox.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(host.getProjectDetail({ projectId: 'p-seq', offset: 1, limit: 1, revision: before.project.revision }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });

            vi.setSystemTime(new Date(2026, 8, 23, 10, 2, 59));
            expect(read().inbox.revision).toBe(after.inbox.revision);
        });

        it('lists Focus review projects like mobile: due, live, not archived, earliest first', async () => {
            const host = await activateMeta({});
            const focus = host.getFocus({ limit: 10 });
            if (!focus.ok) throw new Error('Focus query failed');
            const state = useTaskStore.getState();
            expect(focus.value.reviewProjects.map(({ id }) => id)).toEqual(['p-review-early', 'p-review']);
            expect(focus.value.reviewProjects.map(({ id }) => id))
                .toEqual(focusDerivation.getReviewDueProjects(state.projects, NOW).map(({ id }) => id));
            expect(focus.value.reviewProjects[1]).toEqual({
                id: 'p-review', title: 'Garden', status: 'active', projectRevision: revisionOf(state._projectsById.get('p-review')!),
                cancelled: false, statusLabel: 'Active', isFocused: false, focusDisabled: false, color: '#123456', activeTaskCount: 0, nextActionId: null, nextActionTitle: null, focusedWithoutNextAction: false,
                reviewDateLabel: '09/20/2026',
            });
        });
    });

    it('queries 5,000 tasks and serves the same revision from cache', async () => {
        const host = await activateWith(Array.from({ length: 5_000 }, (_, index) =>
            task(`next-${index}`, '2026-09-01T00:00:00.000Z', { status: 'next' })));
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 10));
        const derive = vi.spyOn(focusDerivation, 'deriveFocusTaskLists');
        const start = performance.now();
        const first = host.getFocus({ limit: 50 });
        const firstMs = performance.now() - start;
        const cachedStart = performance.now();
        const second = host.getFocus({ limit: 50 });
        const cachedMs = performance.now() - cachedStart;
        console.info(`native Focus 5,000 tasks: first ${firstMs.toFixed(1)} ms, cached ${cachedMs.toFixed(1)} ms`);
        expect(first.ok).toBe(true);
        expect(second).toEqual(first);
        expect(derive).toHaveBeenCalledTimes(1);
    });

    it('sets task focus to a target, blocks at the limit in both languages, and retries a failed save', async () => {
        freezeClock();
        const host = await activateWith([
            task('first', '2026-09-01T00:00:00.000Z', { status: 'next' }),
            task('second', '2026-09-01T00:00:00.000Z', { status: 'next' }),
        ]);
        saveData.mockClear();
        // The row's revision, as the view showed it.
        const star = (id: string, focused: boolean) => ({ id, focused, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!) });
        const starFirst = star('first', true);
        expect(await host.setTaskFocus(starFirst)).toEqual({ ok: true, value: { id: 'first', focused: true } });
        expect(saveData).toHaveBeenCalledTimes(1);
        expect(saveData.mock.calls[0][0].tasks.find((item: Task) => item.id === 'first').isFocusedToday).toBe(true);
        const rev = useTaskStore.getState()._tasksById.get('first')?.rev;
        expect(await host.setTaskFocus(starFirst)).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get('first')?.rev).toBe(rev);
        expect(saveData).toHaveBeenCalledTimes(1);
        await useTaskStore.getState().updateSettings({ gtd: { focusTaskLimit: 1 } });
        const blockedAction = useTaskStore.getState().getFocusStarAction(useTaskStore.getState()._tasksById.get('second')!);
        const english = getFocusStarBlockedText(getTranslator('en'), blockedAction, normalizeFocusTaskLimit(1));
        const beforeBlocked = useTaskStore.getState()._tasksById.get('second')?.rev;
        const savesBeforeBlocked = saveData.mock.calls.length;
        expect(await host.setTaskFocus(star('second', true))).toEqual({ ok: true, value: { blocked: english ?? '', blockedTitle: tFallback(getTranslator('en'), 'digest.focus', 'Focus') } });
        expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: 'zh-CN' })).toMatchObject({ ok: true });
        const chinese = getFocusStarBlockedText(getTranslator('zh'), blockedAction, normalizeFocusTaskLimit(1));
        expect(await host.setTaskFocus(star('second', true))).toEqual({ ok: true, value: { blocked: chinese ?? '', blockedTitle: tFallback(getTranslator('zh'), 'digest.focus', 'Focus') } });
        expect(useTaskStore.getState()._tasksById.get('second')?.rev).toBe(beforeBlocked);
        expect(saveData).toHaveBeenCalledTimes(savesBeforeBlocked);
        expect(await host.setTaskFocus(star('first', false))).toEqual({ ok: true, value: { id: 'first', focused: false } });

        const starSecond = star('second', true);
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.setTaskFocus(starSecond))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const failedRev = useTaskStore.getState()._tasksById.get('second')?.rev;
        const savesAfterFailure = saveData.mock.calls.length;
        saveData.mockResolvedValue(undefined);
        // The exact retry: the star landed, so its target holds and only the save runs.
        expect(await host.setTaskFocus(starSecond)).toEqual({ ok: true, value: { id: 'second', focused: true } });
        expect(useTaskStore.getState()._tasksById.get('second')?.rev).toBe(failedRev);
        expect(saveData).toHaveBeenCalledTimes(savesAfterFailure + 1);
        expect(saveData.mock.lastCall?.[0].tasks.find((item: Task) => item.id === 'second').isFocusedToday).toBe(true);
    });

    it('sets project focus once per target and retries its failed save', async () => {
        freezeClock();
        const host = await activateWith([], [project('one'), project('archived', 'archived')]);
        saveData.mockClear();
        // The row's revision, as getProjects showed it (archived projects are grouped too).
        const star = (id: string, focused: boolean) => {
            const view = host.getProjects();
            if (!view.ok) throw new Error(view.error.message);
            const row = [...view.value.active, ...view.value.archived].flatMap((group) => group.projects).find((entry) => entry.id === id)!;
            expect(row.projectRevision).toBe(revisionOf(useTaskStore.getState()._projectsById.get(id)!));
            return { id, focused, projectRevision: row.projectRevision };
        };
        const starOne = star('one', true);
        expect(await host.setProjectFocus(starOne)).toEqual({ ok: true, value: { id: 'one', focused: true } });
        const rev = useTaskStore.getState()._projectsById.get('one')?.rev;
        expect(await host.setProjectFocus(starOne)).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._projectsById.get('one')?.rev).toBe(rev);
        expect(saveData).toHaveBeenCalledTimes(1);
        expect(await host.setProjectFocus(star('archived', true)))
            .toEqual({ ok: true, value: { blocked: '' } });
        useTaskStore.setState({ error: 'stale transient error' });
        expect(await host.setProjectFocus(star('archived', true)))
            .toEqual({ ok: true, value: { blocked: '' } });
        const unstarOne = star('one', false);
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.setProjectFocus(unstarOne))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const failedRev = useTaskStore.getState()._projectsById.get('one')?.rev;
        saveData.mockResolvedValue(undefined);
        expect(await host.setProjectFocus(unstarOne)).toEqual({ ok: true, value: { id: 'one', focused: false } });
        expect(useTaskStore.getState()._projectsById.get('one')?.rev).toBe(failedRev);
        expect(saveData.mock.lastCall?.[0].projects.find((item: Project) => item.id === 'one').isFocused).toBe(false);
    });

    it('disables an unstarred project after five stars across all areas and ignores stale errors', async () => {
        freezeClock();
        const host = await activateWith([]);
        useTaskStore.setState({
            _allAreas: [area('a', 'Alpha', 0), area('z', 'Zeta', 1)],
            _allProjects: [
                ...Array.from({ length: 5 }, (_, index) => project(`star-${index}`, 'active', index, { isFocused: true, areaId: 'a' })),
                project('candidate', 'active', 6, { areaId: 'z' }),
            ],
        });
        expect(await host.setAreaFilter({ included: ['z'], excluded: [] })).toMatchObject({ ok: true });
        expect(useTaskStore.getState().projects.map((item) => [item.id, item.areaId])).toContainEqual(['candidate', 'z']);
        expect(useTaskStore.getState().settings.filters).toMatchObject({ areaIds: ['z'] });
        const view = host.getProjects();
        if (!view.ok) throw new Error('Projects query failed');
        expect(view.value.active.flatMap((group) => group.projects)).toMatchObject([{ id: 'candidate', focusDisabled: true }]);
        saveData.mockClear();
        const projectRevision = (id: string) => revisionOf(useTaskStore.getState()._projectsById.get(id)!);
        expect(await host.setProjectFocus({ id: 'candidate', focused: true, projectRevision: view.value.active[0].projects[0].projectRevision }))
            .toEqual({ ok: true, value: { blocked: '' } });
        expect(saveData).not.toHaveBeenCalled();
        useTaskStore.setState({ error: 'stale transient error' });
        expect(await host.setProjectFocus({ id: 'star-0', focused: false, projectRevision: projectRevision('star-0') }))
            .toEqual({ ok: true, value: { id: 'star-0', focused: false } });
        expect(host.getProjects()).toMatchObject({ ok: true, value: { active: [{ projects: [{ focusDisabled: false }] }] } });
    });

    it('creates one project per request ID with the RN area color and retries a failed save', async () => {
        freezeClock();
        const host = await activateWith([]);
        useTaskStore.setState({ _allAreas: [area('live', 'Live', 0, { color: '#aabbcc' }), area('deleted', 'Deleted', 1, { deletedAt: '2026-09-01' })] });
        saveData.mockClear();
        const input = { title: 'Project', areaId: 'live', requestId: CAPTURE_ID };
        expect(await host.createProject({ ...input, requestId: 'bad' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.createProject({ ...input, title: ' ' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.createProject(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const created = useTaskStore.getState().projects.find((item) => item.title === 'Project')!;
        // The request UUID names the project.
        expect(created).toMatchObject({ id: CAPTURE_ID, areaId: 'live', color: '#aabbcc' });
        await useTaskStore.getState().updateProject(created.id, { title: 'Renamed project' });
        saveData.mockResolvedValue(undefined);
        expect(await host.createProject(input)).toEqual({ ok: true, value: { id: created.id } });
        expect(await host.createProject(input)).toEqual({ ok: true, value: { id: created.id } });
        expect(useTaskStore.getState().projects.filter((item) => item.id === created.id)).toHaveLength(1);
        expect(useTaskStore.getState().projects).toHaveLength(1);
        const noArea = await host.createProject({ title: 'No area', areaId: 'deleted', requestId: '123e4567-e89b-12d3-a456-426614174001' });
        expect(noArea.ok).toBe(true);
        expect(useTaskStore.getState().projects.find((item) => item.title === 'No area'))
            .toMatchObject({ color: DEFAULT_PROJECT_COLOR });
        expect(useTaskStore.getState().projects.find((item) => item.title === 'No area')?.areaId).toBeFalsy();
    });

    it('formats the Focus date through the host configuration without changing the global formatter', async () => {
        freezeClock();
        const host = await activateWith([]);
        const sentinel = { language: 'fa', dateFormat: 'ymd', calendarSystem: 'jalali', systemLocale: 'fa-IR' };
        configureDateFormatting(sentinel);
        const before = getDateFormattingConfig();
        const now = new Date();
        configureDateFormatting({ language: 'en' });
        const english = safeFormatDate(now, 'PPPP');
        configureDateFormatting(sentinel);
        expect(host.getFocus({ limit: 1 })).toMatchObject({ ok: true, value: { dateLabel: english } });
        expect(getDateFormattingConfig()).toEqual(before);
        expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: 'zh-CN' })).toMatchObject({ ok: true });
        configureDateFormatting({ language: 'zh', systemLocale: 'zh-CN' });
        const chinese = safeFormatDate(now, 'PPPP');
        configureDateFormatting(sentinel);
        expect(host.getFocus({ limit: 1 })).toMatchObject({ ok: true, value: { dateLabel: chinese } });
        expect(getDateFormattingConfig()).toEqual(before);
        configureDateFormatting();
    });

    it('matches the RN area switcher and filters Focus and Projects while keeping Inbox global', async () => {
        freezeClock();
        const host = await activateWith([]);
        useTaskStore.setState({
            _allAreas: [
                area('z', 'Zeta', 2, { color: '#111111' }),
                area('a', 'Alpha', 1, { color: '#222222' }),
                area('gone', 'Gone', 0, { deletedAt: '2026-09-01' }),
            ],
            _allProjects: [project('in-a', 'active', 0, { areaId: 'a' }), project('no-area')],
            _allTasks: [
                task('inbox-a', '2026-09-01', { projectId: 'in-a' }),
                task('inbox-none', '2026-09-01', { projectId: 'no-area' }),
                task('next-a', '2026-09-01', { status: 'next', projectId: 'in-a' }),
                task('next-none', '2026-09-01', { status: 'next', projectId: 'no-area' }),
            ],
        });
        const all = host.getAreaFilter();
        if (!all.ok) throw new Error('Area filter query failed');
        expect(all.value).toMatchObject({ label: getTranslator('en')('common.all'), summary: getTranslator('en')('projects.allAreas') });
        expect(all.value.options).toEqual([
            { id: AREA_FILTER_ALL, label: getTranslator('en')('projects.allAreas'), color: null, state: 'included', next: { included: [], excluded: [] } },
            { id: 'a', label: 'Alpha', color: '#222222', state: 'none', next: cycleAreaFilterSelection({ included: [], excluded: [] }, 'a') },
            { id: 'z', label: 'Zeta', color: '#111111', state: 'none', next: cycleAreaFilterSelection({ included: [], excluded: [] }, 'z') },
            { id: AREA_FILTER_NONE, label: getTranslator('en')('projects.noArea'), color: null, state: 'none', next: cycleAreaFilterSelection({ included: [], excluded: [] }, AREA_FILTER_NONE) },
        ]);
        const inbox = host.getInboxWindow({ offset: 0, limit: 10 });
        const focus = host.getFocus({ limit: 10 });
        const projects = host.getProjects();
        if (!inbox.ok || !focus.ok || !projects.ok) throw new Error('Initial query failed');
        expect(await host.setAreaFilter({ included: ['missing'], excluded: [] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.setAreaFilter({ included: ['gone'], excluded: [] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.setAreaFilter({ included: ['a'], excluded: ['a'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.setAreaFilter({ included: ['a'], excluded: [] })).toEqual({ ok: true, value: { included: ['a'], excluded: [] } });
        const state = useTaskStore.getState();
        expect(state.settings.filters).toMatchObject({ areaId: 'a', areaIds: ['a'], excludedAreaIds: [] });
        const selected = host.getAreaFilter();
        if (!selected.ok) throw new Error('Selected area filter query failed');
        expect(selected.value.revision).not.toBe(all.value.revision);
        expect(selected.value).toMatchObject({ label: 'Alpha', summary: 'Alpha' });
        expect(selected.value.options.find((option) => option.id === 'a')).toMatchObject({ state: 'included', next: cycleAreaFilterSelection({ included: ['a'], excluded: [] }, 'a') });
        const sortedAreas = [...state.areas].filter((item) => !item.deletedAt)
            .sort((left, right) => left.order !== right.order ? left.order - right.order : left.name.localeCompare(right.name));
        const selection = resolveAreaFilterSelection(state.settings.filters, sortedAreas);
        const projectById = new Map(state.projects.map((item) => [item.id, item]));
        const areaById = new Map(sortedAreas.map((item) => [item.id, item]));
        const rnInbox = state.tasks.filter((item) => item.status === 'inbox' && isTaskVisibleInInbox(item, { projectById }));
        const rnVisible = state.tasks.filter((item) => isTaskVisibleInArea(item, { projectById, areaById, resolvedAreaFilter: selection }));
        const rnPools = focusDerivation.buildFocusPools({
            tasks: state.tasks.filter(isTaskActionable), visibleTasks: rnVisible.filter(isTaskActionable),
            projects: state.projects, criteria: undefined, now: new Date(),
        });
        const rnLists = focusDerivation.deriveFocusTaskLists(rnPools, {
            now: new Date(), projects: state.projects, sections: state.sections,
            sortBy: focusDerivation.DEFAULT_FOCUS_SORT_BY,
            prioritiesEnabled: resolveFeatureFlags(state.settings).priorities, sortOrder: undefined,
        });
        const rnSections = focusDerivation.buildFocusTaskSections(rnLists, getTranslator('en'));
        const rnGroups = projectGrouping.buildProjectGroups({
            projects: state.projects, orderedAreas: sortedAreas, areaFilter: selection,
            tagFilter: { kind: 'all' }, pinFocused: true,
        });
        const narrowedInbox = host.getInboxWindow({ offset: 0, limit: 10 });
        const narrowedFocus = host.getFocus({ limit: 10 });
        const narrowedProjects = host.getProjects();
        if (!narrowedInbox.ok || !narrowedFocus.ok || !narrowedProjects.ok) throw new Error('Filtered query failed');
        expect(narrowedInbox.value.rows.map(({ id }) => id)).toEqual(rnInbox.map(({ id }) => id));
        expect(narrowedFocus.value.sections.map(({ key, rows }) => ({ key, ids: rows.map(({ id }) => id) })))
            .toEqual(rnSections.map(({ key, items }) => ({ key, ids: items.map(({ id }) => id) })));
        expect(narrowedProjects.value.active.map(({ areaId, projects: rows }) => ({ areaId, ids: rows.map(({ id }) => id) })))
            .toEqual(rnGroups.active.map(({ areaId, projects: rows }) => ({ areaId: areaId ?? null, ids: rows.map(({ id }) => id) })));
        const projectDetail = host.getProjectDetail({ projectId: 'in-a', offset: 0, limit: 10 });
        if (!projectDetail.ok) throw new Error('Project detail query failed');
        expect(projectDetail.value.items.filter((item) => item.type === 'task').map((item) => item.row.id))
            .toEqual(state.tasks.filter((item) => item.projectId === 'in-a'
                && taskMatchesAreaFilterSelection(item, selection, projectById, areaById)).map((item) => item.id));
        expect(narrowedInbox.value.revision).not.toBe(inbox.value.revision);
        expect(narrowedFocus.value.revision).not.toBe(focus.value.revision);
        expect(narrowedProjects.value.revision).not.toBe(projects.value.revision);
        expect(host.getInboxWindow({ offset: 1, limit: 1, revision: inbox.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getFocusSectionWindow({ key: 'next', offset: 0, limit: 1, revision: focus.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getAreaFilter()).toMatchObject({ ok: true, value: { label: 'Alpha' } });
        const currentRevision = narrowedProjects.value.revision;
        expect(await host.setAreaFilter({ included: ['a'], excluded: [] })).toMatchObject({ ok: true });
        expect(host.getProjects()).toMatchObject({ ok: true, value: { revision: currentRevision } });
        expect(await host.setAreaFilter({ included: [AREA_FILTER_NONE], excluded: [] })).toMatchObject({ ok: true });
        expect(host.getAreaFilter()).toMatchObject({ ok: true, value: { label: getTranslator('en')('common.none'), summary: getTranslator('en')('projects.noArea') } });
        expect(host.getAreaFilter()).toMatchObject({ ok: true, value: { options: [
            { id: AREA_FILTER_ALL, state: 'none', next: { included: [], excluded: [] } },
            { id: 'a', state: 'none' }, { id: 'z', state: 'none' },
            { id: AREA_FILTER_NONE, state: 'included', next: cycleAreaFilterSelection({ included: [AREA_FILTER_NONE], excluded: [] }, AREA_FILTER_NONE) },
        ] } });
        expect(host.getProjects()).toMatchObject({ ok: true, value: { active: [{ areaId: null }] } });
        expect(await host.setAreaFilter({ included: ['a', 'z'], excluded: [] })).toMatchObject({ ok: true });
        expect(host.getAreaFilter()).toMatchObject({ ok: true, value: { label: '2', summary: 'Alpha, Zeta' } });
        expect(host.getAreaFilter()).toMatchObject({ ok: true, value: { options: [
            { id: AREA_FILTER_ALL, state: 'none' },
            { id: 'a', state: 'included', next: cycleAreaFilterSelection({ included: ['a', 'z'], excluded: [] }, 'a') },
            { id: 'z', state: 'included', next: cycleAreaFilterSelection({ included: ['a', 'z'], excluded: [] }, 'z') },
            { id: AREA_FILTER_NONE, state: 'none' },
        ] } });
        expect(await host.setAreaFilter({ included: [], excluded: ['z'] })).toMatchObject({ ok: true });
        const excludeOnly = host.getAreaFilter();
        if (!excludeOnly.ok) throw new Error('Exclude-only filter query failed');
        const excludeSelection: AreaFilterSelection = { included: [], excluded: ['z'] };
        const rnLabel = isAreaFilterSelectionActive(excludeSelection) && areaFilterSelectionToValue(excludeSelection) === AREA_FILTER_ALL ? '−1' : '';
        expect(excludeOnly.value).toMatchObject({ label: rnLabel, summary: `${tFallback(getTranslator('en'), 'filters.excluded', 'Excluded')}: Zeta` });
        expect(excludeOnly.value.options.find((option) => option.id === 'z'))
            .toMatchObject({ state: 'excluded', next: cycleAreaFilterSelection(excludeSelection, 'z') });
        expect(state.settings.filters).not.toEqual(areaFilterSelectionToFilters(excludeSelection));
        expect(useTaskStore.getState().settings.filters).toMatchObject(areaFilterSelectionToFilters(excludeSelection));
        const detailBefore = host.getProjectDetail({ projectId: 'in-a', offset: 0, limit: 10 });
        if (!detailBefore.ok) throw new Error('Project detail query failed');
        expect(await host.setAreaFilter({ included: ['z'], excluded: [] })).toMatchObject({ ok: true });
        const detailAfter = host.getProjectDetail({ projectId: 'in-a', offset: 0, limit: 10 });
        if (!detailAfter.ok) throw new Error('Filtered project detail query failed');
        const filteredState = useTaskStore.getState();
        const filteredSelection = resolveAreaFilterSelection(filteredState.settings.filters, filteredState.areas);
        expect(detailAfter.value.items.filter((item) => item.type === 'task').map((item) => item.row.id))
            .toEqual(filteredState.tasks.filter((item) => item.projectId === 'in-a'
                && taskMatchesAreaFilterSelection(item, filteredSelection, filteredState._projectsById, areaById)).map((item) => item.id));
        expect(detailAfter.value.items.filter((item) => item.type === 'task')).toHaveLength(0);
        expect(detailAfter.value.revision).not.toBe(detailBefore.value.revision);
        expect(host.getProjectDetail({ projectId: 'in-a', offset: 1, limit: 1, revision: detailBefore.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
});

// The native app journals each write and replays it after process death. A new host
// holds no receipts, so each replay must write nothing wrong after a later change.
describe('native host contract: replays after a restart', () => {
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
    });

    const store = () => useTaskStore.getState();
    const stored = (id: string) => store()._tasksById.get(id)!;
    const open = () => openScreenHost({
        data: {
            tasks: [task('a', '2026-09-01T00:00:00.000Z', { status: 'next' }), task('b', '2026-09-01T00:00:00.000Z', { status: 'next' })],
            projects: [project('p')],
            areas: [area('area', 'Area', 0)],
        },
        record: {},
        log: [],
    });
    const stale = { ok: false, error: { code: 'STALE_REVISION' } };

    it('refuses a write without the revision the view showed', async () => {
        const host = await open();
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(await host.completeTask({ id: 'a' } as never)).toMatchObject(invalid);
        expect(await host.setTaskFocus({ id: 'a', focused: true, taskRevision: '' })).toMatchObject(invalid);
        expect(await host.setProjectFocus({ id: 'p', focused: true } as never)).toMatchObject(invalid);
        // A revision the task no longer has is refused, and nothing is written.
        const before = stored('a');
        expect(await host.completeTask({ id: 'a', taskRevision: '0::2020-01-01T00:00:00.000Z' })).toMatchObject(stale);
        expect(stored('a')).toBe(before);
    });

    it('setTaskFocus: a replay never stars a task again after the star was taken off', async () => {
        const host = await open();
        const input = { id: 'a', focused: true, taskRevision: taskRevisionOf(stored('a')) };
        expect(unwrap(await host.setTaskFocus(input))).toEqual({ id: 'a', focused: true });
        // The landed request's target holds: nothing to write.
        expect(await replayAfterRestart((restarted) => restarted.setTaskFocus(input))).toEqual({ result: { ok: true, value: { id: 'a', focused: true } }, wrote: false });
        expect((await store().updateTask('a', { isFocusedToday: false })).success).toBe(true);
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.setTaskFocus(input));
        expect(result).toMatchObject(stale);
        expect(wrote).toBe(false);
        expect(stored('a').isFocusedToday).toBe(false);
    });

    it('completeTask: a replay never completes a task reopened since', async () => {
        const host = await open();
        const input = { id: 'a', taskRevision: taskRevisionOf(stored('a')) };
        expect(unwrap(await host.completeTask(input))).toEqual({ id: 'a' });
        expect(await replayAfterRestart((restarted) => restarted.completeTask(input))).toEqual({ result: { ok: true, value: { id: 'a' } }, wrote: false });
        expect((await store().updateTask('a', { status: 'next' })).success).toBe(true);
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.completeTask(input));
        expect(result).toMatchObject(stale);
        expect(wrote).toBe(false);
        expect(stored('a').status).toBe('next');
    });

    it('setProjectFocus: a replay never stars a project again after the star was taken off', async () => {
        const host = await open();
        const view = unwrap(host.getProjects());
        const input = { id: 'p', focused: true, projectRevision: view.active[0].projects[0].projectRevision };
        expect(unwrap(await host.setProjectFocus(input))).toEqual({ id: 'p', focused: true });
        expect(await replayAfterRestart((restarted) => restarted.setProjectFocus(input))).toEqual({ result: { ok: true, value: { id: 'p', focused: true } }, wrote: false });
        await store().updateProject('p', { isFocused: false });
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.setProjectFocus(input));
        expect(result).toMatchObject(stale);
        expect(wrote).toBe(false);
        expect(store()._projectsById.get('p')?.isFocused).toBe(false);
    });

    it('a request UUID belongs to one action across the contract\'s modules: another command under it is refused', async () => {
        const host = await open();
        const requestId = newRequestId();
        // Reuses the live project "p" by title: nothing written, and its request is still spent.
        expect(unwrap(await host.createProject({ title: store()._projectsById.get('p')!.title, areaId: null, requestId }))).toEqual({ id: 'p' });
        expect(await host.setGeneralSetting({ requestId, edit: { type: 'timeFormat', value: '12h' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(store().settings.timeFormat).toBeUndefined();
    });

    it('createProject: a replay finds the project its request UUID named, renamed or deleted since', async () => {
        const host = await open();
        const input = { title: 'Launch', areaId: 'area', requestId: newRequestId() };
        expect(unwrap(await host.createProject(input))).toEqual({ id: input.requestId });
        await store().updateProject(input.requestId, { title: 'Renamed' });
        expect(await replayAfterRestart((restarted) => restarted.createProject(input))).toEqual({ result: { ok: true, value: { id: input.requestId } }, wrote: false });
        await store().deleteProject(input.requestId);
        expect(await replayAfterRestart((restarted) => restarted.createProject(input))).toEqual({ result: { ok: true, value: { id: input.requestId } }, wrote: false });
        expect(store()._allProjects.filter((entry) => entry.id === input.requestId)).toMatchObject([{ title: 'Renamed', deletedAt: expect.any(String) }]);
        expect(store().projects.map((entry) => entry.id)).toEqual(['p']);
    });

    it('saveSearch: a replay finds the search its request UUID named; one changed since is refused', async () => {
        const host = await open();
        const input = { query: ' launch ', name: 'Launch', requestId: newRequestId() };
        expect(unwrap(await host.saveSearch(input))).toEqual({ id: input.requestId, existing: false });
        expect(await replayAfterRestart((restarted) => restarted.saveSearch(input))).toEqual({ result: { ok: true, value: { id: input.requestId, existing: false } }, wrote: false });
        await store().updateSettings({ savedSearches: [{ id: input.requestId, name: 'Renamed', query: 'launch' }] });
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.saveSearch(input));
        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(wrote).toBe(false);
        expect(store().settings.savedSearches).toEqual([{ id: input.requestId, name: 'Renamed', query: 'launch' }]);
    });

    it('updateTask: a replay after a later edit of the same field is stale; after it landed, it writes nothing', async () => {
        const host = await open();
        const input = { id: 'a', base: { title: 'a' }, patch: { title: 'Mine' }, requestId: newRequestId() };
        expect(unwrap(await host.updateTask(input))).toEqual({ id: 'a', changed: true });
        expect(await replayAfterRestart((restarted) => restarted.updateTask(input))).toEqual({ result: { ok: true, value: { id: 'a', changed: false } }, wrote: false });
        expect((await store().updateTask('a', { title: 'Theirs' })).success).toBe(true);
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.updateTask(input));
        expect(result).toMatchObject(stale);
        expect(wrote).toBe(false);
        expect(stored('a').title).toBe('Theirs');
    });

    it('saveTaskDraft: a replay after a later edit of the same field is stale; after it landed, it writes nothing', async () => {
        const host = await open();
        const input = { id: 'a', base: { title: 'a' }, patch: { title: 'Mine' }, requestId: newRequestId() };
        expect(unwrap(await host.saveTaskDraft(input)).draft.title).toBe('Mine');
        const landed = await replayAfterRestart((restarted) => restarted.saveTaskDraft(input));
        expect(landed).toMatchObject({ result: { ok: true, value: { id: 'a', draft: { title: 'Mine' } } }, wrote: false });
        expect((await store().updateTask('a', { title: 'Theirs' })).success).toBe(true);
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.saveTaskDraft(input));
        expect(result).toMatchObject(stale);
        expect(wrote).toBe(false);
        expect(stored('a').title).toBe('Theirs');
    });

    it('createInboxTask: a replay answers the task its capture UUID made, edited since', async () => {
        const host = await open();
        const input = { title: 'Captured', captureId: newRequestId() };
        const { id } = unwrap(await host.createInboxTask(input));
        expect((await store().updateTask(id, { title: 'Edited' })).success).toBe(true);
        expect(await replayAfterRestart((restarted) => restarted.createInboxTask(input))).toEqual({ result: { ok: true, value: { id } }, wrote: false });
        expect(stored(id).title).toBe('Edited');
        expect(store()._allTasks).toHaveLength(3);
    });

    it('setAreaFilter: a replay of the landed selection writes nothing and keeps a later settings change', async () => {
        const host = await open();
        const input = { included: ['area'], excluded: [] };
        expect(unwrap(await host.setAreaFilter(input))).toEqual(input);
        expect(await replayAfterRestart((restarted) => restarted.setAreaFilter(input))).toEqual({ result: { ok: true, value: input }, wrote: false });
        await store().updateSettings({ weekStart: 'monday' });
        expect(await replayAfterRestart((restarted) => restarted.setAreaFilter(input))).toEqual({ result: { ok: true, value: input }, wrote: false });
        expect(store().settings).toMatchObject({ weekStart: 'monday', filters: { areaIds: ['area'] } });
    });
});
