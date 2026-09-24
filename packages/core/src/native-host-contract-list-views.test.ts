import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildArchiveTaskItems, getArchivedTaskRow, selectArchivedTasks, sortArchivedTasks } from './archive-view-model';
import { buildContextsTokenIndex, buildContextsViewModel } from './contexts-view-model';
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
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { buildTaskRowMeta, resolveTaskRowFeatures, resolveTaskRowLookup } from './task-row-meta';
import { buildTrashTimeline } from './task-utils';
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
        const input = { requestId: generateUUID(), action: { type: 'moveTasks' as const, taskIds: ['c-call', 'c-sink'], status: 'someday' as const } };
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
        const input = { requestId: generateUUID(), action: { type: 'setTaskStatus' as const, taskId: 'c-reopen', status: 'next' as const } };
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

    it('counts only Contexts tasks actually changed by a bulk tag removal', async () => {
        const { host, recorder } = await openHost(fixture.contexts, scenario(fixture.contexts, 'chips, counts and chip search'));
        const result = await host.runContextsAction({
            requestId: generateUUID(),
            action: { type: 'editTaskTokens', taskIds: ['c-call', 'c-email'], field: 'tags', mode: 'remove', values: ['#work'] },
        });
        expect(result).toMatchObject({ ok: true, value: { changed: true, toast: { message: '1 task' } } });
        expect(recorder.log).toEqual([['batchUpdateTasks', [{ id: 'c-email', updates: { tags: [] } }]]]);
    });

    it('retries an Archive bulk move to Trash after a failed save, then undoes it', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'), saveData);
        const input = { requestId: generateUUID(), action: { type: 'trashTasks' as const, taskIds: ['ar-milk', 'ar-call'] } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runArchiveAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        const retried = await host.runArchiveAction(input);
        expect(retried).toEqual({ ok: true, value: { changed: true, toast: {
            tone: 'success', title: 'Done', message: '2 tasks',
            undo: { label: 'Undo', action: { type: 'restoreTasks', taskIds: ['ar-milk', 'ar-call'] } },
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
        const input = { requestId: generateUUID(), action: { type: 'setTaskStatus' as const, taskId: 'c-call', status: 'done' as const } };
        const rev = useTaskStore.getState()._tasksById.get('c-call')!.rev ?? 0;
        const [first, second] = await Promise.all([host.runContextsAction(input), host.runContextsAction(input)]);
        expect(first).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(second).toEqual(first);
        expect(recorder.log).toEqual([['updateTask', 'c-call', { status: 'done' }]]);
        expect(useTaskStore.getState()._tasksById.get('c-call')!.rev).toBe(rev + 1);
        const reused = await Promise.all([
            host.runArchiveAction({ requestId: input.requestId, action: { type: 'trashTask', taskId: 'c-sink' } }),
            host.runTrashAction({ requestId: input.requestId, action: { type: 'purgeItem', kind: 'task', id: 'c-trashed' } }),
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
        const run = (action: unknown) => host.runTrashAction({ requestId: generateUUID(), action: action as never });
        expect(await run({ type: 'purgeItem', kind: 'task', id: 'tt-live' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'purgeItem', kind: 'project', id: 'tp-live' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'purgeItem', kind: 'task', id: 'tt-purged' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'purgeItems', taskIds: ['tt-report', 'tt-live'], projectIds: [] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await run({ type: 'restoreItems', taskIds: [], projectIds: [] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await run({ type: 'purgeItems', taskIds: ['tt-report', 'tt-report'], projectIds: [] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.runTrashAction({ requestId: 'not-a-uuid', action: { type: 'purgeItem', kind: 'task', id: 'tt-report' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(recorder.log).toEqual([]);
        expect(await run({ type: 'purgeItem', kind: 'task', id: 'tt-report' })).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log).toEqual([['purgeTask', 'tt-report']]);
        expect(useTaskStore.getState()._tasksById.get('tt-report')).toMatchObject({ purgedAt: expect.any(String) });
    });

    it('checks each Contexts and Archive action before writing', async () => {
        const { host, recorder } = await openHost(fixture.archive, scenario(fixture.archive, 'rows, labels, summary and menus'));
        const archive = (action: unknown) => host.runArchiveAction({ requestId: generateUUID(), action: action as never });
        const contexts = (action: unknown) => host.runContextsAction({ requestId: generateUUID(), action: action as never });
        expect(await archive({ type: 'setCompletedAt', taskId: 'ar-call', completedAt: '2026-09-20T10:00:00.000Z' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await archive({ type: 'setCompletedAt', taskId: 'ar-milk', completedAt: '2026-09-20' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await archive({ type: 'moveToInbox', taskId: 'ar-gone' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await archive({ type: 'trashProject', projectId: 'p-gone' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await archive({ type: 'moveTasks', taskIds: ['ar-milk'], status: 'next' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await contexts({ type: 'moveTasks', taskIds: ['n-next'], status: 'archived' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await contexts({ type: 'restoreTasks', taskIds: ['n-next'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await contexts({ type: 'editTaskTokens', taskIds: ['n-next'], field: 'people', mode: 'add', values: ['x'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(recorder.log).toEqual([]);
        expect(await contexts({ type: 'editTaskTokens', taskIds: ['n-next'], field: 'contexts', mode: 'add', values: ['@office'] }))
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
        // A change that leaves the rows shown as they were does not refuse.
        expect((await useTaskStore.getState().updateTask('ar-nodate', { title: 'Renamed' })).success).toBe(true);
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
        const input = { requestId: generateUUID(), action: { type: 'setCompletedAt' as const, taskId: 'ar-alpha', day: '2026-09-20', time: '14:30' } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runArchiveAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(await host.runArchiveAction(input)).toEqual({ ok: true, value: { changed: true, toast: null } });
        expect(recorder.log).toEqual([['updateTask', 'ar-alpha', { completedAt: '2026-09-20T18:30:00.000Z' }]]);
        const run = (action: unknown) => host.runArchiveAction({ requestId: generateUUID(), action: action as never });
        // Target state: the same time again writes nothing, in either form.
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20', time: '14:30' })).toEqual({ ok: true, value: { changed: false, toast: null } });
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', completedAt: '2026-09-20T18:30:00.000Z' })).toEqual({ ok: true, value: { changed: false, toast: null } });
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-02-30', time: '14:30' })).toMatchObject(invalid);
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20' })).toMatchObject(invalid);
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20', time: '2:30 PM' })).toMatchObject(invalid);
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-alpha', day: '2026-09-20', time: '14:30', completedAt: '2026-09-20T18:30:00.000Z' })).toMatchObject(invalid);
        expect(await run({ type: 'setCompletedAt', taskId: 'ar-call', day: '2026-09-20', time: '14:30' })).toMatchObject(invalid);
        expect(recorder.log).toHaveLength(1);
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const requestId = generateUUID();
        expect(host.getContextsView({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getArchiveView({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getTrashView({ offset: 0, limit: 1 })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getHistoryView({ tab: 'archived' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runContextsAction({ requestId, action: { type: 'trashTask', taskId: 'x' } })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runArchiveAction({ requestId, action: { type: 'trashTask', taskId: 'x' } })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(host.getArchiveFilterTokens({ offset: 0, limit: 1, revision: 'r' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runArchiveAction({ requestId, action: { type: 'moveTasksToInbox', selectAll: { params: {}, revision: 'r' } } }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runArchiveAction({ requestId, action: { type: 'setCompletedAt', taskId: 'x', day: '2026-09-20', time: '10:00' } }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runTrashAction({ requestId, action: { type: 'emptyTrash', revision: 'x' } })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });
});
