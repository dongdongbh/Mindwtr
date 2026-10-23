import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildArchiveTaskItems, getArchivedTaskRow, selectArchivedTasks, sortArchivedTasks } from './archive-view-model';
import { buildContextsTokenIndex, buildContextsViewModel, getContextsTokenPicker } from './contexts-view-model';
import { createDateFormatter } from './date';
import { getTranslator } from './i18n';
import { loadTranslations } from './i18n/i18n-loader';
import {
    createArchiveContractBackend,
    createContextsContractBackend,
    createTrashContractBackend,
    createWriteRecorder,
    loadListViewsFixture,
    observeHistory,
    replayArchive,
    replayContexts,
    replayTrash,
    seedListViewsStore,
    type ListViewsPart,
    type ListViewsScenario,
} from './list-views-model.replay';
import { EMPTY_LIST_FILTER_STATE } from './list-filter-state';
import { createNativeHostContract, type NativeArchiveAction, type NativeContextsAction, type NativeContextsView, type NativeHostResult, type NativeTrashAction } from './native-host-contract';
import { revisionOf, taskRevisionOf, setNativeReplayTokens } from './native-request-receipts';
import { replayAfterRestart, value } from './screen-parity.replay';
import { matchesPickerQuery, paramsKey } from './native-host-contract-menu-views';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { buildTaskRowMeta, resolveTaskRowFeatures, resolveTaskRowLookup } from './task-row-meta';
import { buildTrashTimeline } from './task-utils';
import { resolveNonDoneTaskSortBy } from './task-list-sort-options';
import { generateUUID } from './uuid';

const fixture = loadListViewsFixture();
const frozen = (observations: Record<string, unknown>[]) => observations.map(({ text: _text, ...rest }) => rest);
const scenario = (part: ListViewsPart, name: string): ListViewsScenario => part.scenarios.find((entry) => entry.name === name)!;
const english = () => {
    const settings = useTaskStore.getState().settings;
    return createDateFormatter({ language: 'en', dateFormat: settings.dateFormat, calendarSystem: settings.calendarSystem, timeFormat: settings.timeFormat, systemLocale: null });
};

describe('native host contract: Contexts, Archive, Trash and History', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.contexts.timeZone;
        const strings = await loadTranslations('en');
        t = (key) => strings[key] ?? key;
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    // Revisions carry the minute; every test runs at the fixture's instant.
    const openHost = async (part: ListViewsPart, entry: ListViewsScenario, saveData?: (data: unknown) => Promise<void>) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(part.now));
        const recorder = createWriteRecorder();
        await seedListViewsStore(part, entry, recorder, { saveData });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        return { host, recorder };
    };

    it.each(fixture.contexts.scenarios.map((entry) => [entry.name, entry] as const))('Contexts: "%s" like mobile', async (name, entry) => {
        const { host, recorder } = await openHost(fixture.contexts, entry);
        expect(await replayContexts(createContextsContractBackend(host, generateUUID), entry, recorder))
            .toEqual(frozen(fixture.contexts.observations[name]));
    });

    it.each(fixture.archive.scenarios.map((entry) => [entry.name, entry] as const))('Archive: "%s" like mobile', async (name, entry) => {
        const { host, recorder } = await openHost(fixture.archive, entry);
        expect(await replayArchive(createArchiveContractBackend(host, generateUUID), entry, recorder, t))
            .toEqual(frozen(fixture.archive.observations[name]));
    });

    it.each(fixture.trash.scenarios.map((entry) => [entry.name, entry] as const))('Trash: "%s" like mobile', async (name, entry) => {
        const { host, recorder } = await openHost(fixture.trash, entry);
        // The mobile capture pinned the device locale.
        expect(await host.setLanguage({ storedLanguage: null, systemLocale: 'en-US' })).toMatchObject({ ok: true, value: { language: 'en' } });
        expect(await replayTrash(createTrashContractBackend(host, generateUUID), entry, recorder))
            .toEqual(frozen(fixture.trash.observations[name]));
    });

    it('History: opens and switches tabs like mobile', async () => {
        const { host } = await openHost(fixture.trash, scenario(fixture.trash, 'an empty trash'));
        const tabs = (tab: string | null) => {
            const result = host.getHistoryView({ tab });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        };
        expect(fixture.history.observations.map(({ tab }) => observeHistory(tab, tabs))).toEqual(fixture.history.observations);
        expect(host.getHistoryView({ tab: 7 as never })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('builds Contexts rows with core\'s list and row functions, paged by the revision', async () => {
        const { host } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const first = host.getContextsView({ tokens: ['#work', '@phone'], matchMode: 'any', offset: 0, limit: 2 });
        if (!first.ok) throw new Error(first.error.message);
        const state = useTaskStore.getState();
        const model = buildContextsViewModel({
            index: buildContextsTokenIndex(state.tasks), settings: state.settings, selectedTokens: ['#work', '@phone'], matchMode: 'any', searchQuery: '',
        });
        const now = new Date();
        const meta = (id: string) => {
            const task = state._tasksById.get(id)!;
            return buildTaskRowMeta({
                task, lookup: resolveTaskRowLookup(task, state.projects, state.areas, state._sectionsById),
                features: resolveTaskRowFeatures(state.settings), language: 'en',
                dateFormatting: { language: 'en', dateFormat: state.settings.dateFormat, calendarSystem: state.settings.calendarSystem, timeFormat: state.settings.timeFormat, systemLocale: null },
                t: getTranslator('en'), now,
            });
        };
        expect(first.value.total).toBe(model.tasks.length);
        expect(first.value.rows.map((row) => [row.id, row.meta])).toEqual(model.tasks.slice(0, 2).map((task) => [task.id, meta(task.id)]));
        const second = host.getContextsView({ tokens: ['#work', '@phone'], matchMode: 'any', offset: 2, limit: 2, revision: first.value.revision });
        expect(second.ok && second.value.rows.map((row) => row.id)).toEqual(model.tasks.slice(2, 4).map((task) => task.id));
        expect(host.getContextsView({ offset: 2, limit: 2 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getContextsView({ offset: 0, limit: 101 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    // RN's Contexts shows the shared list sort beside its search (#1415).
    it('offers Contexts the shared list sort, with Priority while Priorities is on', async () => {
        const { host } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const read = () => {
            const result = host.getContextsView({ offset: 0, limit: 100 });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        };
        const selected = () => read().sort.options.filter((option) => option.selected).map((option) => option.value);
        expect(read().sort.options.map((option) => option.value)).toContain('priority');
        expect(read().sort.options.find((option) => option.value === 'priority')?.label).toBe('Priority');
        expect(selected()).toEqual([resolveNonDoneTaskSortBy(useTaskStore.getState().settings.taskSortBy, useTaskStore.getState().settings)]);

        expect(await host.setTaskListSort({ sortBy: 'priority' })).toMatchObject({ ok: true, value: { sortBy: 'priority' } });
        expect(selected()).toEqual(['priority']);
        expect(read().sort.accessibilityLabel).toBe('Sort: Priority');
        const state = useTaskStore.getState();
        const ranked = buildContextsViewModel({ index: buildContextsTokenIndex(state.tasks), settings: state.settings, selectedTokens: [], matchMode: 'all', searchQuery: '' });
        expect(ranked.sortBy).toBe('priority');
        // The host leaves out parked projects' tasks (mobile's visible tasks); the rest keep core's priority order.
        const rows = read().rows.map((row) => row.id);
        expect(rows).toEqual(ranked.tasks.map((task) => task.id).filter((id) => rows.includes(id)));

        await useTaskStore.getState().updateSettings({ features: { ...useTaskStore.getState().settings.features, priorities: false } });
        expect(read().sort.options.map((option) => option.value)).not.toContain('priority');
        expect(selected()).toEqual(['default']);
    });

    it('builds Archive groups and rows with core\'s functions and the host date formatter', async () => {
        const { host } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const result = host.getArchiveView({ groupBy: 'project', collapsedGroupIds: ['project:p-launch'], offset: 0, limit: 100 });
        if (!result.ok) throw new Error(result.error.message);
        const state = useTaskStore.getState();
        const items = buildArchiveTaskItems({
            groupBy: 'project', tasks: sortArchivedTasks(selectArchivedTasks(state._allTasks), 'default'), areas: state.areas,
            projectById: new Map(state.projects.map((project) => [project.id, project])), t, collapsedGroupIds: new Set(['project:p-launch']),
        });
        expect(result.value.items.map((item) => (item.type === 'task' ? item.row.id : item.id)))
            .toEqual(items.map((item) => (item.type === 'task' ? item.task.id : item.id)));
        const formatDate = english();
        for (const item of result.value.items) {
            if (item.type !== 'task') continue;
            const row = getArchivedTaskRow(state._tasksById.get(item.row.id)!, formatDate, 'Not set');
            expect(item.dateLabel).toBe(`${row.cancelled ? 'Cancelled' : 'Completed'}: ${row.dateLabel}`);
        }
    });

    it('freezes all visible Archive selection across pages, filters and folds without writes', async () => {
        const save = vi.fn().mockResolvedValue(undefined);
        const { host } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'), save);
        save.mockClear();
        for (const params of [
            {},
            { groupBy: 'project' as const, collapsedGroupIds: ['project:p-launch'] },
            { filters: { searchQuery: 'milk' } },
            { filters: { searchQuery: 'no matching archived task' } },
        ]) {
            const first = value(host.getArchiveView({ ...params, offset: 0, limit: 1 }));
            const all = value(host.getArchiveView({ ...params, offset: 0, limit: 100 }));
            const selection = value(host.getArchiveTaskSelection({ params, revision: first.revision }));
            const ids = [...new Set(all.items.flatMap((item) => item.type === 'task' ? [item.row.id] : []))];
            expect(selection.taskIds).toEqual(ids);
            expect(Object.keys(selection.taskRevisions)).toEqual(ids);
            for (const item of all.items) if (item.type === 'task') {
                expect(selection.taskRevisions[item.row.id]).toBe(item.row.taskRevision);
            }
        }
        expect(save).not.toHaveBeenCalled();
    });

    it('refuses stale Archive Select all and keeps explicit selection pruned after a filter change', async () => {
        const { host } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const first = value(host.getArchiveView({ offset: 0, limit: 1 }));
        const selection = value(host.getArchiveTaskSelection({ params: {}, revision: first.revision }));
        expect(selection.taskIds.length).toBeGreaterThan(1);
        expect((await useTaskStore.getState().updateTask('ar-milk', { title: 'Buy oat milk' })).success).toBe(true);
        expect(host.getArchiveTaskSelection({ params: {}, revision: first.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const narrowed = value(host.getArchiveView({ selectedIds: selection.taskIds,
            filters: { searchQuery: 'milk' }, offset: 0, limit: 1 }));
        expect(narrowed.selectedIds).toEqual(['ar-milk']);
        expect(narrowed.selectedCount).toBe(1);
        expect(selection.taskIds.length).toBeGreaterThan(1);
        for (const params of [{ segment: 'projects' }, { filterEdit: { type: 'clear' } }, { unknown: true }]) {
            expect(host.getArchiveTaskSelection({ params: params as never, revision: narrowed.revision }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(host.getArchiveTaskSelection({ params: {}, revision: 'x'.repeat(2_000_001) }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('keeps large and long saved Archive folds readable', async () => {
        const prefix = '🌱'.repeat(260);
        const longA = `tag:${prefix}á`;
        const longB = `tag:${prefix}á`;
        const archive = { ...fixture.archive, tasks: fixture.archive.tasks.map((task) => (
            task.id === 'ar-report' ? { ...task, tags: [longA.slice(4)] }
                : task.id === 'ar-call' ? { ...task, tags: [longB.slice(4)] } : task
        )) };
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(archive, scenario(archive, 'rows, labels, summary and menus'), saveData);
        recorder.log.length = 0;
        saveData.mockClear();
        const collapsedGroupIds = [...Array.from({ length: 1001 }, (_, index) => `saved:${index}`), longA, longB, 'project:p-launch'];
        const input = { groupBy: 'project' as const, collapsedGroupIds, offset: 0, limit: 1 };
        const first = archiveView(host, input);
        expect(first.items[0]).toMatchObject({ type: 'section', id: 'project:p-launch', collapsed: true });
        const next = archiveView(host, { ...input, offset: 1, revision: first.revision });
        expect(next.items).toHaveLength(Math.min(1, first.total - 1));
        expect(host.getArchiveView({ ...input, collapsedGroupIds: [...collapsedGroupIds, null] as never }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getArchiveView({ ...input, limit: 101 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const longView = archiveView(host, { ...input, groupBy: 'tag', collapsedGroupIds: collapsedGroupIds.filter((id) => id !== longB), limit: 100 });
        expect(longView.items.find((item) => item.type === 'section' && item.id === longA)).toMatchObject({ collapsed: true });
        expect(longView.items.find((item) => item.type === 'section' && item.id === longB)).toMatchObject({ collapsed: false });
        expect(recorder.log).toEqual([]);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('names Archive month headings and row dates in the host language', async () => {
        const { host } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        expect(await host.setLanguage({ storedLanguage: 'fr', systemLocale: 'fr-FR' })).toMatchObject({ ok: true });
        const result = host.getArchiveView({ groupBy: 'completedDate', offset: 0, limit: 100 });
        if (!result.ok) throw new Error(result.error.message);
        const settings = useTaskStore.getState().settings;
        const french = createDateFormatter({ language: 'fr', dateFormat: settings.dateFormat, calendarSystem: settings.calendarSystem, timeFormat: settings.timeFormat, systemLocale: 'fr-FR' });
        const month = result.value.items.find((item) => item.type === 'section' && item.id === 'completedDate:2026-09');
        expect(month).toMatchObject({ title: french(new Date(2026, 8, 1), 'LLLL yyyy') });
        expect(month).not.toMatchObject({ title: 'September 2026' });
        const milk = result.value.items.find((item) => item.type === 'task' && item.row.id === 'ar-milk');
        expect(milk).toMatchObject({ dateLabel: `${getTranslator('fr')('list.done')}: ${french(useTaskStore.getState()._tasksById.get('ar-milk')!.completedAt, 'Pp')}` });
    });

    it('builds Trash rows with core\'s timeline, dated by the host formatter', async () => {
        const { host } = await openHost(fixture.trash, scenario(fixture.trash, 'timeline, summary and retention hint'));
        const result = host.getTrashView({ offset: 0, limit: 100 });
        if (!result.ok) throw new Error(result.error.message);
        const state = useTaskStore.getState();
        const timeline = buildTrashTimeline(state._allTasks, state._allProjects);
        expect(result.value.items.map((item) => (item.type === 'task' ? item.row.id : item.id)))
            .toEqual(timeline.map((item) => (item.type === 'task' ? item.task.id : item.project.id)));
        expect(result.value.items[0]).toMatchObject({ type: 'task', deletedLabel: `Deleted: ${english()(state._tasksById.get('tt-report')!.deletedAt, 'P')}` });
    });

    it('uses the area color for a trashed project with no chosen color', async () => {
        const { host } = await openHost(fixture.trash, scenario(fixture.trash, 'timeline, summary and retention hint'));
        const result = host.getTrashView({ offset: 0, limit: 100 });
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value.items.find((item) => item.type === 'project' && item.id === 'tp-home'))
            .toMatchObject({ indicatorColor: '#16a34a' });
    });

    it('changes each view\'s revision on an edit and refuses a stale page', async () => {
        const { host } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const reads = () => [
            host.getContextsView({ offset: 0, limit: 1 }),
            host.getArchiveView({ offset: 0, limit: 1 }),
            host.getTrashView({ offset: 0, limit: 1 }),
        ].map((result) => (result.ok ? result.value.revision : ''));
        const before = reads();
        expect(reads()).toEqual(before);
        expect((await useTaskStore.getState().updateTask('ar-milk', { title: 'Buy oat milk' })).success).toBe(true);
        const after = reads();
        after.forEach((revision, index) => expect(revision).not.toBe(before[index]));
        expect(host.getArchiveView({ offset: 1, limit: 1, revision: before[1] })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getTrashView({ offset: 1, limit: 1, revision: before[2] })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getContextsView({ offset: 1, limit: 1, revision: before[0] })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('retries a Contexts bulk move after a failed save: one write', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'), saveData);
        const { taskRevisions } = value(host.getContextsView({ selectedIds: ['c-call', 'c-sink'], offset: 0, limit: 100 }));
        const input = { requestId: generateUUID(), action: { type: 'moveTasks' as const, taskIds: ['c-call', 'c-sink'], status: 'someday' as const, taskRevisions } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runContextsAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(recorder.log).toEqual([['batchMoveTasks', ['c-call', 'c-sink'], 'someday']]);
        const written = useTaskStore.getState()._tasksById.get('c-call');
        expect(written).toMatchObject({ status: 'someday' });
        saveData.mockResolvedValue(undefined);
        const retried = await host.runContextsAction(input);
        expect(retried).toEqual({ ok: true, value: { changed: true, toast: { tone: 'success', title: 'Done', message: '2 tasks', undo: null } } });
        expect(recorder.log).toHaveLength(1);
        expect(useTaskStore.getState()._tasksById.get('c-call')).toBe(written);
        expect((saveData.mock.lastCall?.[0] as { tasks: { id: string; status: string }[] }).tasks.find(({ id }) => id === 'c-sink')?.status).toBe('someday');
        // A lost reply repeats the request: no write, no save.
        const saves = saveData.mock.calls.length;
        expect(await host.runContextsAction(input)).toEqual(retried);
        expect(saveData).toHaveBeenCalledTimes(saves);
        expect(await host.runContextsAction({ ...input, action: { ...input.action, status: 'next' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(recorder.log).toHaveLength(1);
    });

    it('retries a Contexts status change whose store save failed after it landed: one write', async () => {
        // Reopening a task of an archived project reactivates the project and saves at once.
        const archivedAt = '2026-09-08T09:00:00.000Z';
        const part = {
            ...fixture.contexts,
            tasks: [...fixture.contexts.tasks, {
                id: 'c-reopen', title: 'Reopen me', status: 'done' as const, completedAt: archivedAt, statusBeforeProjectArchive: 'next' as const,
                projectArchivedAt: archivedAt, projectId: 'p-shelved', contexts: ['@home'], tags: [], createdAt: archivedAt, updatedAt: archivedAt, rev: 2,
            }],
            projects: [...fixture.contexts.projects, {
                id: 'p-shelved', title: 'Shelved', status: 'archived' as const, color: '#94a3b8', order: 9, tagIds: [],
                createdAt: archivedAt, updatedAt: archivedAt, rev: 2,
            }],
        };
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(part, scenario(fixture.contexts, 'chips, counts and chip search'), saveData);
        const input = { requestId: generateUUID(), action: { type: 'setTaskStatus' as const, taskId: 'c-reopen', status: 'next' as const, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('c-reopen')!) } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runContextsAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        // The store changed the task and its project in memory before its save failed.
        expect(useTaskStore.getState()._projectsById.get('p-shelved')?.status).toBe('active');
        const reopened = useTaskStore.getState()._tasksById.get('c-reopen');
        saveData.mockResolvedValue(undefined);
        expect(await host.runContextsAction(input)).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log.filter(([name]) => name === 'updateTask')).toEqual([['updateTask', 'c-reopen', { status: 'next' }]]);
        expect(useTaskStore.getState()._tasksById.get('c-reopen')).toBe(reopened);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; status: string }[]; projects: { id: string; status: string }[] };
        expect(saved.tasks.find(({ id }) => id === 'c-reopen')?.status).toBe('next');
        expect(saved.projects.find(({ id }) => id === 'p-shelved')?.status).toBe('active');
    });

    // RN's chip accessibility action is the additive press, labelled Add or Remove filter (#1427).
    it('labels a token chip\'s additive press Add or Remove filter, and gives All and No context none', async () => {
        const { host } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const view = value(host.getContextsView({ tokens: ['@phone'], offset: 0, limit: 100 }));
        const chip = (id: string) => view.chips.find((entry) => entry.id === id)!;
        expect(chip('all').additive).toBeUndefined();
        expect(chip('none').additive).toBeUndefined();
        expect(chip('@phone').additive).toEqual({ label: 'Remove filter', next: { tokens: [], matchMode: 'all' } });
        expect(chip('#work').additive).toEqual({ label: 'Add', next: { tokens: ['@phone', '#work'], matchMode: 'all' } });
        expect(chip('#work').next).toEqual({ tokens: ['#work'], matchMode: 'all' });
    });

    it('forwards saved unused tokens to Contexts Add and keeps Remove selected-only', async () => {
        const { host } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const stamp = '2026-10-20T00:00:00.000Z';
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, taxonomy: {
            contexts: [{ token: '@unused', rev: 1, revBy: 'test', updatedAt: stamp }],
            tags: [{ token: '#unused', rev: 1, revBy: 'test', updatedAt: stamp }],
        } } });
        const view = value(host.getContextsView({ selectedIds: ['c-call'], offset: 0, limit: 100 }));
        for (const [field, token] of [['contexts', '@unused'], ['tags', '#unused']] as const) {
            expect(view.bulk?.tokenActions.find((action) => action.field === field && action.mode === 'add')?.tokens).toContain(token);
            expect(view.bulk?.tokenActions.find((action) => action.field === field && action.mode === 'remove')?.tokens)
                .toEqual(useTaskStore.getState()._tasksById.get('c-call')![field]);
            expect(view.chips.map((chip) => chip.id)).not.toContain(token);
        }
    });

    it('searches the bulk bar\'s token pickers as mobile\'s token picker does, one window at a time under the view\'s revision', async () => {
        const { host } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const selectedIds = ['c-call', 'c-email'];
        const read = (picker: Record<string, unknown>) => {
            const result = host.getContextsView({ selectedIds, picker: picker as never, offset: 0, limit: 1 });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        };
        const state = useTaskStore.getState();
        const model = buildContextsViewModel({ index: buildContextsTokenIndex(state.tasks), settings: state.settings, selectedTokens: [], matchMode: 'all', searchQuery: '' });
        const tasksById = Object.fromEntries(state.tasks.map((task) => [task.id, task]));
        // TokenPickerModal's filter, as mobile's Contexts screen runs it.
        const mobileFilter = (tokens: string[], query: string) => {
            const normalized = query.trim().toLowerCase();
            return normalized ? tokens.filter((token) => token.toLowerCase().includes(normalized)) : tokens;
        };
        for (const [field, mode, query] of [['tags', 'add', ' WOR'], ['tags', 'remove', 'ork '], ['contexts', 'add', 'PHO'], ['contexts', 'remove', ''], ['contexts', 'add', 'zzz']] as const) {
            const { tokens } = getContextsTokenPicker({ field, action: mode, activeTasks: model.activeTasks, selectedIds, tasksById, t });
            const view = read({ field, mode, query });
            expect(view.bulk?.picker).toEqual({ field, mode, total: mobileFilter(tokens, query).length, items: mobileFilter(tokens, query) });
            // The Inbox tokens' rule.
            expect(view.bulk?.picker?.items).toEqual(tokens.filter((token) => matchesPickerQuery(token, query)));
        }
        expect(read({ field: 'tags', mode: 'add', query: ' WOR' }).bulk?.picker?.items).toContain('#work');
        // Without a picker, or without a selection, there is none.
        expect(read({ field: 'tags', mode: 'add' }).bulk?.tokenActions).toHaveLength(4);
        const plain = host.getContextsView({ selectedIds, offset: 0, limit: 1 });
        expect(plain.ok && plain.value.bulk?.picker).toBeNull();
        const unselected = host.getContextsView({ picker: { field: 'tags', mode: 'add' }, offset: 0, limit: 1 });
        expect(unselected.ok && unselected.value.bulk).toBeNull();

        // One window at a time, under the view's revision.
        const all = read({ field: 'contexts', mode: 'add' });
        const total = all.bulk!.picker!.total;
        expect(total).toBeGreaterThan(1);
        const second = read({ field: 'contexts', mode: 'add', offset: 1, limit: 1, revision: all.revision });
        expect(second.bulk?.picker?.items).toEqual([all.bulk!.picker!.items[1]]);
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getContextsView({ selectedIds, picker: { field: 'contexts', mode: 'add', offset: 1 }, offset: 0, limit: 1 })).toMatchObject(invalid);
        expect(host.getContextsView({ selectedIds, picker: { field: 'people', mode: 'add' } as never, offset: 0, limit: 1 })).toMatchObject(invalid);
        expect(host.getContextsView({ selectedIds, picker: { field: 'tags', mode: 'swap' } as never, offset: 0, limit: 1 })).toMatchObject(invalid);
        expect(host.getContextsView({ selectedIds, picker: { field: 'tags', mode: 'add', query: 7 } as never, offset: 0, limit: 1 })).toMatchObject(invalid);
        expect(host.getContextsView({ selectedIds, picker: { field: 'tags', mode: 'add', limit: 101 }, offset: 0, limit: 1 })).toMatchObject(invalid);
        await useTaskStore.getState().updateTask('c-call', { title: 'Call the office' });
        expect(host.getContextsView({ selectedIds, picker: { field: 'contexts', mode: 'add', offset: 1, revision: all.revision }, offset: 0, limit: 1 }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('counts only Contexts tasks actually changed by a bulk tag removal', async () => {
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const { taskRevisions } = value(host.getContextsView({ selectedIds: ['c-call', 'c-email'], offset: 0, limit: 100 }));
        const result = await host.runContextsAction({
            requestId: generateUUID(),
            action: { type: 'editTaskTokens', taskIds: ['c-call', 'c-email'], field: 'tags', mode: 'remove', values: ['#work'], taskRevisions },
        });
        expect(result).toMatchObject({ ok: true, value: { changed: true, toast: { message: '1 task' } } });
        expect(recorder.log).toEqual([['batchUpdateTasks', [{ id: 'c-email', updates: { tags: [] } }]]]);
    });

    it('retries an Archive bulk move to Trash after a failed save, then undoes it', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'), saveData);
        const { taskRevisions } = archiveView(host, { selectedIds: ['ar-milk', 'ar-call'], offset: 0, limit: 100 });
        const input = { requestId: generateUUID(), action: { type: 'trashTasks' as const, taskIds: ['ar-milk', 'ar-call'], taskRevisions } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runArchiveAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        const retried = await host.runArchiveAction(input);
        const trashed = (id: string) => taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!);
        expect(retried).toEqual({ ok: true, value: { changed: true, toast: {
            tone: 'success', title: 'Done', message: '2 tasks',
            undo: { label: 'Undo', action: { type: 'restoreTasks', taskIds: ['ar-milk', 'ar-call'], taskRevisions: { 'ar-milk': trashed('ar-milk'), 'ar-call': trashed('ar-call') } } },
        } } });
        expect(recorder.log).toEqual([['batchDeleteTasks', ['ar-milk', 'ar-call']]]);
        if (!retried.ok || !retried.value.toast?.undo) return;
        expect(await host.runArchiveAction({ requestId: generateUUID(), action: retried.value.toast.undo.action }))
            .toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log.slice(1)).toEqual([['restoreTask', 'ar-milk'], ['restoreTask', 'ar-call']]);
        expect(useTaskStore.getState()._tasksById.get('ar-milk')?.deletedAt).toBeUndefined();
    });

    it('retries Clear Trash after a failed save and keeps each purged item as a tombstone', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(fixture.trash, scenario(fixture.trash, 'clear a trash the area filter narrows'), saveData);
        const view = host.getTrashView({ offset: 0, limit: 100 });
        if (!view.ok || !view.value.emptyTrash) throw new Error('Expected a Clear Trash scope');
        expect(view.value.emptyTrash).toMatchObject({ taskCount: 1, projectCount: 1, confirmation: { title: 'Delete permanently?', message: '1 task · 1 project\nThis action cannot be undone.' } });
        const input = { requestId: generateUUID(), action: { type: 'emptyTrash' as const, revision: view.value.emptyTrash.revision } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runTrashAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(await host.runTrashAction(input)).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log).toEqual([['purgeTasks', ['tt-call']], ['purgeProject', 'tp-home']]);
        const state = useTaskStore.getState();
        expect(state._tasksById.get('tt-call')).toMatchObject({ deletedAt: expect.any(String), purgedAt: expect.any(String) });
        expect(state._allProjects.find((project) => project.id === 'tp-home')).toMatchObject({ purgedAt: expect.any(String) });
        // Items outside the filtered view are untouched.
        expect(state._tasksById.get('tt-report')?.purgedAt).toBeUndefined();
    });

    it('writes once for concurrent exact retries, and refuses a request ID reused on another screen', async () => {
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const input = { requestId: generateUUID(), action: { type: 'setTaskStatus' as const, taskId: 'c-call', status: 'done' as const, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('c-call')!) } };
        const rev = useTaskStore.getState()._tasksById.get('c-call')!.rev ?? 0;
        const [first, second] = await Promise.all([host.runContextsAction(input), host.runContextsAction(input)]);
        expect(first).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(second).toEqual(first);
        expect(recorder.log).toEqual([['updateTask', 'c-call', { status: 'done' }]]);
        expect(useTaskStore.getState()._tasksById.get('c-call')!.rev).toBe(rev + 1);
        const reused = await Promise.all([
            host.runArchiveAction({ requestId: input.requestId, action: { type: 'trashTask', taskId: 'c-sink', taskRevision: 'r' } }),
            host.runTrashAction({ requestId: input.requestId, action: { type: 'purgeItem', kind: 'task', id: 'c-trashed', revision: 'r' } }),
        ]);
        reused.forEach((result) => expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }));
        expect(recorder.log).toHaveLength(1);
    });

    it('refuses Clear Trash once Trash changed after its confirmation, and deletes nothing', async () => {
        const { host, recorder } = await openHost(fixture.trash, scenario(fixture.trash, 'clear the whole trash'));
        const view = host.getTrashView({ offset: 0, limit: 100 });
        if (!view.ok || !view.value.emptyTrash) throw new Error('Expected a Clear Trash scope');
        expect((await useTaskStore.getState().deleteTask('tt-live')).success).toBe(true);
        recorder.log.length = 0;
        expect(await host.runTrashAction({ requestId: generateUUID(), action: { type: 'emptyTrash', revision: view.value.emptyTrash.revision } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(recorder.log).toEqual([]);
        expect(useTaskStore.getState()._tasksById.get('tt-live')?.purgedAt).toBeUndefined();
    });

    it('never deletes forever or restores an item that is not in Trash', async () => {
        const { host, recorder } = await openHost(fixture.trash, scenario(fixture.trash, 'timeline, summary and retention hint'));
        // As the journaling Android host: each write must carry its replay tokens.
        setNativeReplayTokens('required');
        const run = (action: unknown) => host.runTrashAction({ requestId: generateUUID(), action: action as never });
        const revision = (id: string) => taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!);
        expect(await run({ type: 'purgeItem', kind: 'task', id: 'tt-live', revision: revision('tt-live') })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'purgeItem', kind: 'project', id: 'tp-live', revision: 'r' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'purgeItem', kind: 'task', id: 'tt-purged', revision: revision('tt-purged') })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'purgeItems', taskIds: ['tt-report', 'tt-live'], projectIds: [], taskRevisions: { 'tt-report': revision('tt-report'), 'tt-live': revision('tt-live') }, projectRevisions: {} }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await run({ type: 'restoreItems', taskIds: [], projectIds: [], taskRevisions: {}, projectRevisions: {} })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await run({ type: 'purgeItems', taskIds: ['tt-report', 'tt-report'], projectIds: [], taskRevisions: { 'tt-report': revision('tt-report') }, projectRevisions: {} }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // A selection's revisions name exactly its items.
        expect(await run({ type: 'purgeItems', taskIds: ['tt-report'], projectIds: [], taskRevisions: {}, projectRevisions: {} })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await run({ type: 'purgeItem', kind: 'task', id: 'tt-report' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.runTrashAction({ requestId: 'not-a-uuid', action: { type: 'purgeItem', kind: 'task', id: 'tt-report', revision: revision('tt-report') } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(recorder.log).toEqual([]);
        expect(await run({ type: 'purgeItem', kind: 'task', id: 'tt-report', revision: revision('tt-report') })).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log).toEqual([['purgeTask', 'tt-report']]);
        expect(useTaskStore.getState()._tasksById.get('tt-report')).toMatchObject({ purgedAt: expect.any(String) });
    });

    it('checks each Contexts and Archive action before writing', async () => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        // As the journaling Android host: each write must carry its replay tokens.
        setNativeReplayTokens('required');
        const archive = (action: unknown) => host.runArchiveAction({ requestId: generateUUID(), action: action as never });
        const contexts = (action: unknown) => host.runContextsAction({ requestId: generateUUID(), action: action as never });
        const revision = (id: string) => taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!);
        expect(await archive({ type: 'setCompletedAt', taskId: 'ar-call', completedAt: '2026-09-20T10:00:00.000Z', taskRevision: revision('ar-call') }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await archive({ type: 'setCompletedAt', taskId: 'ar-milk', completedAt: '2026-09-20', taskRevision: revision('ar-milk') })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await archive({ type: 'moveToInbox', taskId: 'ar-gone', taskRevision: revision('ar-gone') })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await archive({ type: 'trashProject', projectId: 'p-gone', projectRevision: revisionOf(useTaskStore.getState()._allProjects.find((entry) => entry.id === 'p-gone')!) }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // Every write names the revision the view showed.
        expect(await archive({ type: 'moveToInbox', taskId: 'ar-milk' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await archive({ type: 'moveTasksToInbox', taskIds: ['ar-milk', 'ar-nodate'], taskRevisions: { 'ar-milk': revision('ar-milk') } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await archive({ type: 'reactivateProject', projectId: 'p-report' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await contexts({ type: 'setTaskStatus', taskId: 'n-next', status: 'done' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await contexts({ type: 'trashTask', taskId: 'n-next', taskRevision: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await archive({ type: 'moveTasks', taskIds: ['ar-milk'], status: 'next' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await contexts({ type: 'moveTasks', taskIds: ['n-next'], status: 'archived' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await contexts({ type: 'restoreTasks', taskIds: ['n-next'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await contexts({ type: 'editTaskTokens', taskIds: ['n-next'], field: 'people', mode: 'add', values: ['x'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(recorder.log).toEqual([]);
        expect(await contexts({ type: 'editTaskTokens', taskIds: ['n-next'], field: 'contexts', mode: 'add', values: ['@office'], taskRevisions: { 'n-next': revision('n-next') } }))
            .toEqual({ ok: true, value: { changed: false, toast: null } });
        expect(recorder.log).toEqual([]);
    });

    const archiveView = (host: ReturnType<typeof createNativeHostContract>, input: Parameters<ReturnType<typeof createNativeHostContract>['getArchiveView']>[0]) => {
        const result = host.getArchiveView(input);
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.value;
    };
    const taskIds = (view: { items: { type: string; row?: { id: string } }[] }) => (
        Array.from(new Set(view.items.flatMap((item) => (item.type === 'task' && item.row ? [item.row.id] : []))))
    );

    it('filters Archive with the menu views\' filter sheet: edits, chips that carry their edit, match modes, no project filter', async () => {
        const { host } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const opened = archiveView(host, { filterSheetOpen: true, offset: 0, limit: 100 });
        expect(opened.filters.clearEdit).toEqual({ type: 'clear' });
        const office = opened.filters.tokens.items.find((token) => token.value === '@office');
        expect(office).toEqual({ value: '@office', state: 'none', edit: { type: 'toggleToken', value: '@office' } });
        const one = archiveView(host, { filters: opened.filters.state, filterEdit: office!.edit, filterSheetOpen: true, offset: 0, limit: 100 });
        expect(one.filters.state.tokens).toEqual(['@office']);
        expect(taskIds(one)).toEqual(['ar-report']);
        expect(one.chips).toEqual([{ id: 'token:@office', label: '@office', excluded: false, action: { filterEdit: { type: 'removeToken', value: '@office' } } }]);
        expect(one.filters.chips).toEqual([{ id: 'token:@office', label: '@office', excluded: false }]);
        expect(one.filters).toMatchObject({ buttonLabel: 'Filters · 1', activeCount: 1, hasActive: true, matchModes: [] });

        const two = archiveView(host, { filters: one.filters.state, filterEdit: { type: 'toggleToken', value: '@phone' }, offset: 0, limit: 100 });
        expect(taskIds(two)).toEqual([]);
        expect(two.filters.matchModes).toEqual([{ kind: 'context', label: 'Context match', options: [
            { value: 'any', label: 'Any', selected: false, edit: { type: 'setMatchMode', kind: 'context', value: 'any' } },
            { value: 'all', label: 'All', selected: true, edit: { type: 'setMatchMode', kind: 'context', value: 'all' } },
        ] }]);
        const any = archiveView(host, { filters: two.filters.state, filterEdit: two.filters.matchModes[0].options[0].edit, offset: 0, limit: 100 });
        expect(any.filters.state.contextMatchMode).toBe('any');
        expect(taskIds(any).sort()).toEqual(['ar-call', 'ar-report']);
        const cleared = archiveView(host, { filters: any.filters.state, filterEdit: any.filters.clearEdit, offset: 0, limit: 100 });
        expect(cleared.filters.state).toEqual(EMPTY_LIST_FILTER_STATE);

        // Mobile's Archive sheet has no project filter: a project selection never filters it.
        const project = archiveView(host, { filters: { projects: ['p-launch'] }, offset: 0, limit: 100 });
        expect(project.filters).toMatchObject({ projects: null, activeCount: 0, state: { projects: [] } });
        expect(host.getArchiveView({ filterEdit: { type: 'toggleToken', value: '' } as never, offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getArchiveView({ filters: { color: 'red' } as never, offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('searches the Archive filter picker\'s tokens and pages them under the view revision', async () => {
        const { host } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const view = archiveView(host, { filterSheetOpen: true, offset: 0, limit: 100 });
        const params = { filters: view.filters.state, filterSheetOpen: true };
        const all = view.filters.tokens.items;
        expect(host.getArchiveFilterTokens({ params, query: ' ERR ', offset: 0, limit: 100, revision: view.revision })).toEqual({ ok: true, value: {
            version: 1, revision: view.revision, total: 2, items: all.filter((token) => token.value.toLowerCase().includes('err')),
        } });
        expect(host.getArchiveFilterTokens({ params, offset: 2, limit: 2, revision: view.revision }))
            .toMatchObject({ ok: true, value: { total: all.length, items: all.slice(2, 4) } });
        // A closed sheet offers only the chosen tokens.
        expect(host.getArchiveFilterTokens({ params: { filters: { tokens: ['#home'] } }, offset: 0, limit: 100, revision: view.revision }))
            .toMatchObject({ ok: true, value: { total: 1, items: [{ value: '#home', state: 'included' }] } });
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getArchiveFilterTokens({ params, query: 'x'.repeat(501), offset: 0, limit: 10, revision: view.revision })).toMatchObject(invalid);
        expect(host.getArchiveFilterTokens({ params: { ...params, filterEdit: { type: 'clear' } } as never, offset: 0, limit: 10, revision: view.revision })).toMatchObject(invalid);
        expect(host.getArchiveFilterTokens({ params, offset: 0, limit: 10 } as never)).toMatchObject(invalid);
        expect((await useTaskStore.getState().updateTask('ar-milk', { tags: ['#changed'] })).success).toBe(true);
        expect(host.getArchiveFilterTokens({ params, query: 'err', offset: 0, limit: 10, revision: view.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('selects every Archive row on screen, less the ones deselected, and moves exactly those', async () => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        // A folded heading hides its rows from Select all, as on mobile.
        const base = { groupBy: 'project' as const, collapsedGroupIds: ['project:p-launch'] };
        const view = archiveView(host, { ...base, selectAll: { except: ['ar-milk', 'ar-gone'] }, offset: 0, limit: 100 });
        const shown = taskIds(view);
        expect(shown).not.toContain('ar-report');
        expect(shown).toContain('ar-milk');
        expect(view.selectAll).toEqual({
            params: { groupBy: 'project', filters: EMPTY_LIST_FILTER_STATE, collapsedGroupIds: ['project:p-launch'] },
            revision: expect.any(String),
            except: ['ar-milk'],
        });
        expect(view).toMatchObject({ visibleTaskCount: shown.length, selectedCount: shown.length - 1, selectedIds: [] });
        expect(view.labels.selected).toBe(`${shown.length - 1} selected`);
        for (const item of view.items) if (item.type === 'task') expect(item.selected).toBe(item.row.id !== 'ar-milk');
        expect(archiveView(host, { ...base, selectedIds: ['ar-milk', 'ar-report'], offset: 0, limit: 100 }))
            .toMatchObject({ selectedIds: ['ar-milk'], selectedCount: 1, selectAll: null });
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getArchiveView({ selectedIds: [], selectAll: {}, offset: 0, limit: 1 })).toMatchObject(invalid);

        const run = (action: unknown) => host.runArchiveAction({ requestId: generateUUID(), action: action as never });
        const selectAll = view.selectAll!;
        expect(await run({ type: 'moveTasksToInbox', selectAll, taskIds: ['ar-call'] })).toMatchObject(invalid);
        expect(await run({ type: 'moveTasksToInbox', selectAll: { ...selectAll, except: shown } })).toMatchObject(invalid);
        expect(await run({ type: 'moveTasksToInbox', selectAll: { ...selectAll, params: { ...selectAll.params, filterEdit: { type: 'clear' } } } })).toMatchObject(invalid);
        expect(await run({ type: 'trashTasks', selectAll: { params: selectAll.params } })).toMatchObject(invalid);
        expect(recorder.log).toEqual([]);
        // A change to a row the fold hides leaves the rows shown as they were: it does not refuse.
        expect((await useTaskStore.getState().updateTask('ar-report', { title: 'Renamed' })).success).toBe(true);
        recorder.log.length = 0;
        expect(await run({ type: 'moveTasksToInbox', selectAll })).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log).toEqual([['batchMoveTasks', shown.filter((id) => id !== 'ar-milk'), 'inbox']]);
        expect(useTaskStore.getState()._tasksById.get('ar-milk')?.status).toBe('archived');
        expect(useTaskStore.getState()._tasksById.get('ar-report')?.status).toBe('archived');
    });

    it('refuses an Archive Select all once the rows shown changed, and writes nothing', async () => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const view = archiveView(host, { selectAll: {}, offset: 0, limit: 100 });
        expect((await useTaskStore.getState().updateTask('ar-milk', { status: 'inbox' })).success).toBe(true);
        recorder.log.length = 0;
        expect(await host.runArchiveAction({ requestId: generateUUID(), action: { type: 'trashTasks', selectAll: view.selectAll! } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(recorder.log).toEqual([]);
    });

    it('retries an Archive Select all move after a failed save: one write, never resolved again', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'), saveData);
        const view = archiveView(host, { selectAll: {}, offset: 0, limit: 100 });
        const ids = taskIds(view);
        const input = { requestId: generateUUID(), action: { type: 'moveTasksToInbox' as const, selectAll: view.selectAll! } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runArchiveAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        // The rows shown changed with the landed move; the retry only saves it.
        expect(await host.runArchiveAction(input)).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log).toEqual([['batchMoveTasks', ids, 'inbox']]);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; status: string }[] };
        expect(ids.map((id) => saved.tasks.find((task) => task.id === id)?.status)).toEqual(ids.map(() => 'inbox'));
    });

    it('retries an Archive Select all trash after a failed save; its Undo restores those rows', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'), saveData);
        const view = archiveView(host, { selectAll: { except: ['ar-call'] }, offset: 0, limit: 100 });
        const ids = taskIds(view).filter((id) => id !== 'ar-call');
        const input = { requestId: generateUUID(), action: { type: 'trashTasks' as const, selectAll: view.selectAll! } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runArchiveAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        const retried = await host.runArchiveAction(input);
        expect(retried).toMatchObject({ ok: true, value: { changed: true, toast: { undo: { action: { type: 'restoreTasks', taskIds: ids } } } } });
        expect(recorder.log).toEqual([['batchDeleteTasks', ids]]);
        expect(useTaskStore.getState()._tasksById.get('ar-call')?.deletedAt).toBeUndefined();
    });

    it('stores a picked local day and time as mobile\'s picker does, and retries it exactly after a failed save', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'), saveData);
        const view = archiveView(host, { offset: 0, limit: 100 });
        // ar-alpha completed at 09:00Z: 05:00 on the fixture's New York clock.
        expect(view.items.find((item) => item.type === 'task' && item.row.id === 'ar-alpha')).toMatchObject({ completedAtPicker: { day: '2026-09-23', time: '05:00' } });
        expect(view.items.find((item) => item.type === 'task' && item.row.id === 'ar-call')).toMatchObject({ cancelled: true, completedAtPicker: null });
        const alpha = view.items.find((item) => item.type === 'task' && item.row.id === 'ar-alpha');
        const taskRevision = alpha?.type === 'task' ? alpha.row.taskRevision : '';
        const input = { requestId: generateUUID(), action: { type: 'setCompletedAt' as const, taskId: 'ar-alpha', day: '2026-09-20', time: '14:30', taskRevision } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runArchiveAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(await host.runArchiveAction(input)).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log).toEqual([['updateTask', 'ar-alpha', { completedAt: '2026-09-20T18:30:00.000Z' }]]);
        const run = (action: unknown) => host.runArchiveAction({ requestId: generateUUID(), action: action as never });
        // Target state: the same time again writes nothing, in either form.
        // Target state, checked before the revision: the same time again writes nothing, in either form.
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20', time: '14:30', taskRevision })).toEqual({ ok: true, value: { changed: false, toast: null } });
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', completedAt: '2026-09-20T18:30:00.000Z', taskRevision })).toEqual({ ok: true, value: { changed: false, toast: null } });
        // Another time on the revision the view showed before the write is stale.
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-21', time: '14:30', taskRevision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-02-30', time: '14:30', taskRevision })).toMatchObject(invalid);
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20', taskRevision })).toMatchObject(invalid);
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20', time: '2:30 PM', taskRevision })).toMatchObject(invalid);
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20', time: '14:30', completedAt: '2026-09-20T18:30:00.000Z', taskRevision })).toMatchObject(invalid);
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-call', day: '2026-09-20', time: '14:30', taskRevision })).toMatchObject(invalid);
        expect(recorder.log).toHaveLength(1);
    });

    // The native app journals each write and replays it after process death. A new host
    // holds no receipts, so a replay after a later change must write nothing wrong.
    type Host = ReturnType<typeof createNativeHostContract>;
    const store = () => useTaskStore.getState();
    const stored = (id: string) => store()._tasksById.get(id)!;
    const storedProject = (id: string) => store()._allProjects.find((entry) => entry.id === id)!;
    const stale = { ok: false, error: { code: 'STALE_REVISION' } };
    /** Runs the request, lets `change` touch its rows, then replays it on a new host: nothing may be written. */
    const replayAfterChange = async <T,>(
        host: Host, recorder: { log: unknown[][] }, run: (host: Host) => Promise<NativeHostResult<T>>, change: () => Promise<unknown>,
    ) => {
        expect(await run(host)).toMatchObject({ ok: true, value: { changed: true } });
        await change();
        recorder.log.length = 0;
        const { result, wrote } = await replayAfterRestart(run);
        expect(wrote).toBe(false);
        expect(recorder.log).toEqual([]);
        return result;
    };
    const contextsRow = (view: NativeContextsView, id: string) => view.rows.find((row) => row.id === id)!.taskRevision;

    it.each([
        ['setTaskStatus', (view: NativeContextsView): NativeContextsAction => ({ type: 'setTaskStatus', taskId: 'c-call', status: 'done', taskRevision: contextsRow(view, 'c-call') }),
            () => store().updateTask('c-call', { status: 'next' }), () => expect(stored('c-call').status).toBe('next')],
        ['moveTasks', (view: NativeContextsView): NativeContextsAction => ({ type: 'moveTasks', taskIds: ['c-call', 'c-email'], status: 'someday', taskRevisions: view.taskRevisions }),
            () => store().updateTask('c-call', { status: 'next' }), () => expect(stored('c-call').status).toBe('next')],
        ['editTaskTokens', (view: NativeContextsView): NativeContextsAction => ({
            type: 'editTaskTokens', taskIds: ['c-call', 'c-email'], field: 'tags', mode: 'add', values: ['#urgent'], taskRevisions: view.taskRevisions,
        }), () => store().updateTask('c-call', { tags: [] }), () => expect(stored('c-call').tags).toEqual([])],
        ['trashTask', (view: NativeContextsView): NativeContextsAction => ({ type: 'trashTask', taskId: 'c-call', taskRevision: contextsRow(view, 'c-call') }),
            () => store().restoreTask('c-call'), () => expect(stored('c-call').deletedAt).toBeUndefined()],
        ['trashTasks', (view: NativeContextsView): NativeContextsAction => ({ type: 'trashTasks', taskIds: ['c-call', 'c-email'], taskRevisions: view.taskRevisions }),
            async () => { await store().restoreTask('c-call'); await store().restoreTask('c-email'); }, () => expect(stored('c-call').deletedAt).toBeUndefined()],
    ] as const)('Contexts %s: a replay after a restart never undoes a later change', async (_name, request, change, check) => {
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const view = value(host.getContextsView({ selectedIds: ['c-call', 'c-email'], offset: 0, limit: 100 }));
        expect(view.taskRevisions).toEqual({ 'c-call': taskRevisionOf(stored('c-call')), 'c-email': taskRevisionOf(stored('c-email')) });
        const input = { requestId: generateUUID(), action: request(view) };
        expect(await replayAfterChange(host, recorder, (current) => current.runContextsAction(input), change)).toMatchObject(stale);
        check();
    });

    it('Contexts restoreTasks: a replay of an Undo after a restart never restores a task trashed again', async () => {
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const view = value(host.getContextsView({ selectedIds: ['c-call', 'c-email'], offset: 0, limit: 100 }));
        const trashed = value(await host.runContextsAction({ requestId: generateUUID(), action: { type: 'trashTasks', taskIds: ['c-call', 'c-email'], taskRevisions: view.taskRevisions } }));
        const undo = trashed.toast!.undo!.action;
        // The Undo carries the revisions its write left.
        expect(undo).toEqual({ type: 'restoreTasks', taskIds: ['c-call', 'c-email'], taskRevisions: { 'c-call': taskRevisionOf(stored('c-call')), 'c-email': taskRevisionOf(stored('c-email')) } });
        const input = { requestId: generateUUID(), action: undo };
        const change = () => store().batchDeleteTasks(['c-call', 'c-email']);
        expect(await replayAfterChange(host, recorder, (current) => current.runContextsAction(input), change)).toMatchObject(stale);
        expect(stored('c-call').deletedAt).toEqual(expect.any(String));
    });

    const archiveRow = (host: Host, id: string) => {
        const item = value(host.getArchiveView({ offset: 0, limit: 100 })).items.find((entry) => entry.type === 'task' && entry.row.id === id);
        return item?.type === 'task' ? item.row.taskRevision : '';
    };
    const archiveProject = (host: Host, id: string) => {
        const item = value(host.getArchiveView({ segment: 'projects', offset: 0, limit: 100 })).items.find((entry) => entry.type === 'project' && entry.id === id);
        return item?.type === 'project' ? item.projectRevision : '';
    };
    const archiveSelection = (host: Host) => value(host.getArchiveView({ selectedIds: ['ar-milk', 'ar-nodate'], offset: 0, limit: 100 })).taskRevisions;

    it.each([
        ['moveToInbox', (host: Host): NativeArchiveAction => ({ type: 'moveToInbox', taskId: 'ar-milk', taskRevision: archiveRow(host, 'ar-milk') }),
            () => store().updateTask('ar-milk', { status: 'archived' }), () => expect(stored('ar-milk').status).toBe('archived')],
        ['moveTasksToInbox', (host: Host): NativeArchiveAction => ({ type: 'moveTasksToInbox', taskIds: ['ar-milk', 'ar-nodate'], taskRevisions: archiveSelection(host) }),
            () => store().updateTask('ar-milk', { status: 'archived' }), () => expect(stored('ar-milk').status).toBe('archived')],
        ['setCompletedAt', (host: Host): NativeArchiveAction => ({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20', time: '14:30', taskRevision: archiveRow(host, 'ar-alpha') }),
            () => store().updateTask('ar-alpha', { completedAt: '2026-09-21T10:00:00.000Z' }), () => expect(stored('ar-alpha').completedAt).toBe('2026-09-21T10:00:00.000Z')],
        ['trashTask', (host: Host): NativeArchiveAction => ({ type: 'trashTask', taskId: 'ar-milk', taskRevision: archiveRow(host, 'ar-milk') }),
            () => store().restoreTask('ar-milk'), () => expect(stored('ar-milk').deletedAt).toBeUndefined()],
        ['trashTasks', (host: Host): NativeArchiveAction => ({ type: 'trashTasks', taskIds: ['ar-milk', 'ar-nodate'], taskRevisions: archiveSelection(host) }),
            async () => { await store().restoreTask('ar-milk'); await store().restoreTask('ar-nodate'); }, () => expect(stored('ar-milk').deletedAt).toBeUndefined()],
        ['trashTasks under Select all', (host: Host): NativeArchiveAction => ({ type: 'trashTasks', selectAll: value(host.getArchiveView({ selectAll: {}, offset: 0, limit: 100 })).selectAll! }),
            async () => { for (const id of ['ar-report', 'ar-call', 'ar-milk', 'ar-nodate', 'ar-alpha']) await store().restoreTask(id); },
            () => expect(stored('ar-milk').deletedAt).toBeUndefined()],
        ['reactivateProject', (host: Host): NativeArchiveAction => ({ type: 'reactivateProject', projectId: 'p-report', projectRevision: archiveProject(host, 'p-report') }),
            () => store().updateProject('p-report', { status: 'archived' }), () => expect(storedProject('p-report').status).toBe('archived')],
        ['trashProject', (host: Host): NativeArchiveAction => ({ type: 'trashProject', projectId: 'p-old', projectRevision: archiveProject(host, 'p-old') }),
            () => store().restoreProject('p-old'), () => expect(storedProject('p-old').deletedAt).toBeUndefined()],
    ] as const)('Archive %s: a replay after a restart never undoes a later change', async (_name, request, change, check) => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const input = { requestId: generateUUID(), action: request(host) };
        expect(await replayAfterChange(host, recorder, (current) => current.runArchiveAction(input), change)).toMatchObject(stale);
        check();
    });

    it('Archive restoreTasks: a replay of an Undo after a restart never restores a task trashed again', async () => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const trashed = value(await host.runArchiveAction({ requestId: generateUUID(), action: { type: 'trashTasks', taskIds: ['ar-milk', 'ar-nodate'], taskRevisions: archiveSelection(host) } }));
        const undo = trashed.toast!.undo!.action;
        expect(undo).toEqual({ type: 'restoreTasks', taskIds: ['ar-milk', 'ar-nodate'], taskRevisions: { 'ar-milk': taskRevisionOf(stored('ar-milk')), 'ar-nodate': taskRevisionOf(stored('ar-nodate')) } });
        const input = { requestId: generateUUID(), action: undo };
        const change = () => store().batchDeleteTasks(['ar-milk', 'ar-nodate']);
        expect(await replayAfterChange(host, recorder, (current) => current.runArchiveAction(input), change)).toMatchObject(stale);
        expect(stored('ar-milk').deletedAt).toEqual(expect.any(String));
    });

    it('refuses an Archive Select all once a selected row changed in place, and writes nothing', async () => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const view = value(host.getArchiveView({ selectAll: {}, offset: 0, limit: 100 }));
        expect((await store().updateTask('ar-milk', { title: 'Buy oat milk' })).success).toBe(true);
        recorder.log.length = 0;
        expect(await host.runArchiveAction({ requestId: generateUUID(), action: { type: 'moveTasksToInbox', selectAll: view.selectAll! } })).toMatchObject(stale);
        expect(recorder.log).toEqual([]);
    });

    it('refuses an Archive Select all once a row synced to a revision the old 32-bit token could not tell apart', async () => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        // Two revisions of ar-milk whose old token (the count and a 32-bit FNV hash) was the same.
        const first = { rev: 1, revBy: 'd', updatedAt: '2026-09-24T00:03:26.283Z' };
        const second = { rev: 1, revBy: 'd', updatedAt: '2026-09-24T00:11:45.726Z' };
        expect(paramsKey([`ar-milk@${revisionOf(first)}`])).toBe(paramsKey([`ar-milk@${revisionOf(second)}`]));
        const sync = (revision: typeof first) => useTaskStore.setState({
            _allTasks: store()._allTasks.map((task) => (task.id === 'ar-milk' ? { ...task, ...revision } : task)),
        });
        sync(first);
        const view = value(host.getArchiveView({ filters: { ...EMPTY_LIST_FILTER_STATE, searchQuery: 'milk' }, selectAll: {}, offset: 0, limit: 100 }));
        expect(view.selectedCount).toBe(1);
        // Another device's version of the row arrives.
        sync(second);
        recorder.log.length = 0;
        expect(await host.runArchiveAction({ requestId: generateUUID(), action: { type: 'trashTasks', selectAll: view.selectAll! } })).toMatchObject(stale);
        expect(recorder.log).toEqual([]);
    });

    // A replay of a request that landed finds its target held: changed: false, before any revision compare.
    const landed = { ok: true, value: { changed: false, toast: null } };
    it.each([
        ['setTaskStatus', (view: NativeContextsView): NativeContextsAction => ({ type: 'setTaskStatus', taskId: 'c-call', status: 'done', taskRevision: contextsRow(view, 'c-call') })],
        ['moveTasks', (view: NativeContextsView): NativeContextsAction => ({ type: 'moveTasks', taskIds: ['c-call', 'c-email'], status: 'someday', taskRevisions: view.taskRevisions })],
    ] as const)('Contexts %s: a replay after a restart of a request that landed answers changed: false', async (name, request) => {
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const view = value(host.getContextsView({ selectedIds: ['c-call', 'c-email'], offset: 0, limit: 100 }));
        const input = { requestId: generateUUID(), action: request(view) };
        expect(await host.runContextsAction(input)).toMatchObject({ ok: true, value: { changed: true } });
        recorder.log.length = 0;
        // A bulk move answers mobile's toast for it; one task's status change shows none.
        const toast = name === 'moveTasks' ? { tone: 'success', title: 'Done', message: '2 tasks', undo: null } : null;
        expect(await replayAfterRestart((current) => current.runContextsAction(input))).toEqual({ result: { ok: true, value: { changed: false, toast } }, wrote: false });
        expect(recorder.log).toEqual([]);
    });

    it('Contexts moveTasks: every selected row there already writes nothing and answers mobile\'s Done toast', async () => {
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const view = value(host.getContextsView({ selectedIds: ['c-call', 'c-email'], offset: 0, limit: 100 }));
        await store().batchMoveTasks(['c-call', 'c-email'], 'someday');
        recorder.log.length = 0;
        const action = { type: 'moveTasks' as const, taskIds: ['c-call', 'c-email'], status: 'someday' as const, taskRevisions: view.taskRevisions };
        expect(await host.runContextsAction({ requestId: generateUUID(), action }))
            .toEqual({ ok: true, value: { changed: false, toast: { tone: 'success', title: 'Done', message: '2 tasks', undo: null } } });
        expect(recorder.log).toEqual([]);
    });

    it('Contexts moveTasks: a row another device moved there already is no conflict; the rest move', async () => {
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const view = value(host.getContextsView({ selectedIds: ['c-call', 'c-email'], offset: 0, limit: 100 }));
        const input = { requestId: generateUUID(), action: { type: 'moveTasks' as const, taskIds: ['c-call', 'c-email'], status: 'someday' as const, taskRevisions: view.taskRevisions } };
        // The request never ran; another device files c-call under Someday.
        await store().updateTask('c-call', { status: 'someday' });
        recorder.log.length = 0;
        expect(await replayAfterRestart((current) => current.runContextsAction(input))).toMatchObject({ result: { ok: true, value: { changed: true } } });
        // Mobile's call: every selected row.
        expect(recorder.log).toEqual([['batchMoveTasks', ['c-call', 'c-email'], 'someday']]);
        expect(stored('c-email').status).toBe('someday');
    });

    it.each([
        ['moveToInbox', (host: Host): NativeArchiveAction => ({ type: 'moveToInbox', taskId: 'ar-milk', taskRevision: archiveRow(host, 'ar-milk') })],
        ['moveTasksToInbox', (host: Host): NativeArchiveAction => ({ type: 'moveTasksToInbox', taskIds: ['ar-milk', 'ar-nodate'], taskRevisions: archiveSelection(host) })],
        ['moveTasksToInbox under Select all', (host: Host): NativeArchiveAction => ({ type: 'moveTasksToInbox', selectAll: value(host.getArchiveView({ selectAll: {}, offset: 0, limit: 100 })).selectAll! })],
        ['trashTasks under Select all', (host: Host): NativeArchiveAction => ({ type: 'trashTasks', selectAll: value(host.getArchiveView({ selectAll: {}, offset: 0, limit: 100 })).selectAll! })],
        ['reactivateProject', (host: Host): NativeArchiveAction => ({ type: 'reactivateProject', projectId: 'p-report', projectRevision: archiveProject(host, 'p-report') })],
    ] as const)('Archive %s: a replay after a restart of a request that landed answers changed: false', async (_name, request) => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const input = { requestId: generateUUID(), action: request(host) };
        expect(await host.runArchiveAction(input)).toMatchObject({ ok: true, value: { changed: true } });
        recorder.log.length = 0;
        expect(await replayAfterRestart((current) => current.runArchiveAction(input))).toEqual({ result: landed, wrote: false });
        expect(recorder.log).toEqual([]);
    });

    it('Archive moveTasksToInbox: a row another device restored already is no conflict; the rest move', async () => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const input = { requestId: generateUUID(), action: { type: 'moveTasksToInbox' as const, taskIds: ['ar-milk', 'ar-nodate'], taskRevisions: archiveSelection(host) } };
        await store().updateTask('ar-milk', { status: 'inbox' });
        recorder.log.length = 0;
        expect(await replayAfterRestart((current) => current.runArchiveAction(input))).toMatchObject({ result: { ok: true, value: { changed: true } } });
        expect(recorder.log).toEqual([['batchMoveTasks', ['ar-milk', 'ar-nodate'], 'inbox']]);
        expect(stored('ar-nodate').status).toBe('inbox');
    });

    const trashView = (host: Host, selected?: { taskIds: string[]; projectIds: string[] }) => value(host.getTrashView({ selected, offset: 0, limit: 100 }));
    const trashItemRevision = (host: Host, id: string) => {
        const item = trashView(host).items.find((entry) => (entry.type === 'task' ? entry.row.id : entry.id) === id)!;
        return item.type === 'task' ? item.row.taskRevision : item.projectRevision;
    };

    it.each([
        ['restoreItem (task)', (host: Host): NativeTrashAction => ({ type: 'restoreItem', kind: 'task', id: 'tt-report', revision: trashItemRevision(host, 'tt-report') }),
            () => store().deleteTask('tt-report'), () => expect(stored('tt-report').deletedAt).toEqual(expect.any(String))],
        ['restoreItem (project)', (host: Host): NativeTrashAction => ({ type: 'restoreItem', kind: 'project', id: 'tp-home', revision: trashItemRevision(host, 'tp-home') }),
            () => store().deleteProject('tp-home'), () => expect(storedProject('tp-home').deletedAt).toEqual(expect.any(String))],
        ['restoreItems', (host: Host): NativeTrashAction => {
            const { selected } = trashView(host, { taskIds: ['tt-report'], projectIds: ['tp-home'] });
            return { type: 'restoreItems', taskIds: selected.taskIds, projectIds: selected.projectIds, taskRevisions: selected.taskRevisions, projectRevisions: selected.projectRevisions };
        }, async () => { await store().deleteTask('tt-report'); await store().deleteProject('tp-home'); }, () => expect(stored('tt-report').deletedAt).toEqual(expect.any(String))],
    ] as const)('Trash %s: a replay after a restart never undoes a later change', async (_name, request, change, check) => {
        const { host, recorder } = await openHost(fixture.trash, scenario(fixture.trash, 'timeline, summary and retention hint'));
        // As the journaling Android host: the Trash selection carries the revisions its actions send back.
        setNativeReplayTokens('required');
        const input = { requestId: generateUUID(), action: request(host) };
        expect(await replayAfterChange(host, recorder, (current) => current.runTrashAction(input), change)).toMatchObject(stale);
        check();
    });

    it.each([
        ['purgeItem', (host: Host): NativeTrashAction => ({ type: 'purgeItem', kind: 'task', id: 'tt-report', revision: trashItemRevision(host, 'tt-report') })],
        ['purgeItems', (host: Host): NativeTrashAction => {
            const { selected } = trashView(host, { taskIds: ['tt-report'], projectIds: [] });
            return { type: 'purgeItems', taskIds: selected.taskIds, projectIds: [], taskRevisions: selected.taskRevisions, projectRevisions: selected.projectRevisions };
        }],
    ] as const)('Trash %s: a replay after a restart deletes nothing it did not show', async (_name, request) => {
        const { host, recorder } = await openHost(fixture.trash, scenario(fixture.trash, 'timeline, summary and retention hint'));
        // As the journaling Android host: the Trash selection carries the revisions its actions send back.
        setNativeReplayTokens('required');
        // The request never ran: the item was restored and trashed again after the view showed it.
        const stalled = { requestId: generateUUID(), action: request(host) };
        await store().restoreTask('tt-report');
        await store().deleteTask('tt-report');
        recorder.log.length = 0;
        expect(await replayAfterRestart((current) => current.runTrashAction(stalled))).toMatchObject({ result: stale, wrote: false });
        expect(stored('tt-report').purgedAt).toBeUndefined();
        // A request that landed finds its item gone for good.
        const input = { requestId: generateUUID(), action: request(host) };
        expect(await host.runTrashAction(input)).toEqual({ ok: true, value: { changed: true, toast: null } });
        recorder.log.length = 0;
        const replayed = await replayAfterRestart((current) => current.runTrashAction(input));
        expect(replayed).toMatchObject({ result: { ok: false }, wrote: false });
        expect(recorder.log).toEqual([]);
    });

    it('Trash emptyTrash: a replay after a restart is stale, its confirmation belongs to the old process', async () => {
        const { host, recorder } = await openHost(fixture.trash, scenario(fixture.trash, 'clear the whole trash'));
        const input = { requestId: generateUUID(), action: { type: 'emptyTrash' as const, revision: trashView(host).emptyTrash!.revision } };
        expect(await host.runTrashAction(input)).toEqual({ ok: true, value: { changed: true, toast: null } });
        await store().deleteTask('tt-live');
        recorder.log.length = 0;
        expect(await replayAfterRestart((current) => current.runTrashAction(input))).toMatchObject({ result: stale, wrote: false });
        expect(stored('tt-live').purgedAt).toBeUndefined();
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const requestId = generateUUID();
        expect(host.getContextsView({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getContextsView({ selectedIds: ['x'], picker: { field: 'tags', mode: 'add', query: 'w' }, offset: 0, limit: 1 }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getArchiveView({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getTrashView({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getHistoryView({ tab: 'archived' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runContextsAction({ requestId, action: { type: 'trashTask', taskId: 'x', taskRevision: 'r' } })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runArchiveAction({ requestId, action: { type: 'trashTask', taskId: 'x', taskRevision: 'r' } })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getArchiveFilterTokens({ offset: 0, limit: 1, revision: 'r' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runArchiveAction({ requestId, action: { type: 'moveTasksToInbox', selectAll: { params: {}, revision: 'r' } } }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runArchiveAction({ requestId, action: { type: 'setCompletedAt', taskId: 'x', day: '2026-09-20', time: '10:00', taskRevision: 'r' } }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runTrashAction({ requestId, action: { type: 'emptyTrash', revision: 'x' } })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });
});
