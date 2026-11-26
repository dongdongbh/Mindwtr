import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectBulkTaskTokens } from './bulk-task-tokens';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract } from './native-host-contract';
import * as logger from './logger';
import type { NativeBulkAction } from './native-host-contract-bulk-actions';
import { createBulkOrganizeArea, createBulkOrganizeProject } from './bulk-organize-create';
import { paramsKey } from './native-host-contract-menu-views';
import { revisionOf, taskRevisionOf, taskRevisionsOf, setNativeReplayTokens } from './native-request-receipts';
import { openSqliteHost, replayAfterRestart } from './screen-parity.replay';
import { updateRangeSelection } from './range-selection';
import type { Task } from './types';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import {
    BULK_ORGANIZE_KEEP,
    BULK_ORGANIZE_NONE,
    buildBulkOrganizeDialogModel,
    buildBulkOrganizeInput,
    buildTaskListBulkBarModel,
    EMPTY_BULK_ORGANIZE_DRAFT,
    getBulkMoveStatusOptions,
    getBulkOrganizeAreaOptions,
    getBulkOrganizeProjectOptions,
    getTaskListBulkToast,
    planBulkOrganize,
    planBulkTagEdit,
    runTaskListBulkWrite,
    type BulkOrganizeDraft,
    type TaskListBulkWrite,
} from './task-list-bulk-actions';
import {
    loadBulkActionsFixture,
    normalize,
    openBulkActionsHost,
    requestId,
    seedBulkActionsStore,
    value,
} from './task-list-bulk-actions.replay';

const fixture = loadBulkActionsFixture();
const ORGANIZE: Partial<BulkOrganizeDraft> = {
    status: 'waiting', delegateWho: 'Alice', projectChoice: 'p-launch', startDate: '2026-09-27', contexts: '@desk', tags: 'q4',
};

describe('Task182 readonly Done selection', () => {
    afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });
    it('uses shared range selection across pages, skips read-only parents and prunes filters/folds without adding incoming rows', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T13:00:00.000Z'));
        const at = '2026-10-02T12:00:00.000Z';
        const tasks: Task[] = Array.from({ length: 140 }, (_, index) => ({ id: `done-${String(index).padStart(3, '0')}`,
            title: `Done ${String(index).padStart(3, '0')}`, status: 'done', completedAt: at, createdAt: at, updatedAt: at,
            tags: [index < 70 ? 'first' : 'second'], contexts: [], rev: 1,
            ...(index === 20 ? { projectId: 'archived-parent' } : index === 30 ? { projectId: 'deleted-parent' } : {}) }));
        const projects = ['archived-parent', 'deleted-parent'].map((id) => ({ id, title: 'Parent', status: id === 'archived-parent' ? 'archived' as const : 'active' as const,
            color: '#94a3b8', order: 0, tagIds: [], createdAt: at, updatedAt: at, rev: 1 }));
        const sqlite = await openSqliteHost({ tasks, projects, settings: { deviceId: 'selection-device', autoArchiveDays: 0 } });
        try {
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [at, 'deleted-parent']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const host = sqlite.host;
            const baseline = await sqlite.sql('SELECT rowid, * FROM tasks ORDER BY rowid');
            const params = { sortBy: 'title' };
            const firstPage = value(host.getDoneView({ ...params, sortBy: 'title', offset: 0, limit: 100 }));
            const secondPage = value(host.getDoneView({ ...params, sortBy: 'title', offset: 100, limit: 100, revision: firstPage.revision }));
            expect(secondPage.items.some((item) => item.type === 'task' && item.row.id === 'done-130')).toBe(true);
            const visibleIds = [...firstPage.items, ...secondPage.items].flatMap((item) => item.type === 'task' && !item.row.readOnly ? [item.row.id] : []);
            const first = value(host.getBulkActions({ list: 'done', params, selectionEdit: { taskId: 'done-005' } }));
            const range = value(host.getBulkActions({ list: 'done', params, taskIds: first.selectedIds, anchorId: first.anchorId,
                selectionEdit: { taskId: 'done-130', range: true } }));
            const expected = updateRangeSelection({ anchorId: first.anchorId, range: true, selectedIds: new Set(first.selectedIds), targetId: 'done-130', visibleIds });
            expect(range.selectedIds).toEqual([...expected.selectedIds]); expect(range.anchorId).toBe(expected.anchorId);
            expect(range.selectedIds).not.toContain('done-020'); expect(range.selectedIds).not.toContain('done-030');
            expect(range.taskRevisions).toEqual(Object.fromEntries(range.selectedIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])));
            expect([...firstPage.items, ...secondPage.items].some((item) => item.type === 'task' && item.row.id === 'done-020')).toBe(false);
            expect(host.getBulkActions({ list: 'done', params, selectionEdit: { taskId: 'done-020' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect([...firstPage.items, ...secondPage.items].find((item) => item.type === 'task' && item.row.id === 'done-030'))
                .toMatchObject({ type: 'task', row: { readOnly: true } });
            expect(value(host.getBulkActions({ list: 'done', params, selectionEdit: { taskId: 'done-030' } })))
                .toMatchObject({ selectedIds: [], anchorId: null });
            expect(value(host.getBulkActions({ list: 'done', params, taskIds: ['done-020', 'done-030'] })).selectedIds).toEqual([]);
            const filtered = value(host.getBulkActions({ list: 'done', params: { ...params, filters: { searchQuery: 'Done 13' } }, taskIds: range.selectedIds }));
            expect(filtered.selectedIds).toEqual(['done-130']);
            const folded = value(host.getBulkActions({ list: 'done', params: { ...params, groupBy: 'tag', collapsedGroupIds: ['tag:first'] }, taskIds: range.selectedIds }));
            expect(folded.selectedIds).toEqual(range.selectedIds.filter((id) => Number(id.slice(-3)) >= 70));
            const incoming = { ...tasks[0], id: 'done-new', title: 'Done new' };
            await useTaskStore.getState().addTask(incoming.title, 'done'); await flushPendingSave();
            const unchanged = value(host.getBulkActions({ list: 'done', params, taskIds: folded.selectedIds }));
            expect(unchanged.selectedIds).toEqual(folded.selectedIds); expect(unchanged.selectedCount).toBe(folded.selectedIds.length);
            expect(await sqlite.receiptIds()).toEqual([]);


            expect((await sqlite.sql<{ id: string }>('SELECT rowid, * FROM tasks ORDER BY rowid')).filter((row) => tasks.some((task) => task.id === row.id))).toEqual(baseline);
        } finally { await sqlite.close(); }
    });
});

describe('native host contract: selection mode', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        const english = await loadTranslations('en');
        t = (key) => english[key] ?? key;
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
    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
    };
    const open = async (saveData?: (data: unknown) => Promise<void>) => {
        const log: unknown[] = [];
        await seedBulkActionsStore(fixture, log, saveData);
        const host = await openBulkActionsHost();
        log.length = 0;
        return { host, log };
    };

    const tasksNow = () => normalize(useTaskStore.getState()._allTasks.map(({ revBy: _revBy, ...task }) => task));
    type Host = Awaited<ReturnType<typeof open>>['host'];

    const withRevisions = (host: Host, list: 'inbox' | 'waiting' | 'someday' | 'reference' | 'done', action: NativeBulkAction): NativeBulkAction => (
        action.taskIds === undefined || action.type === 'restoreTasks' ? action
            : { ...action, taskRevisions: value(host.getBulkActions({ list, params: list === 'reference' ? { includeArchivedProjects: true } : {}, taskIds: action.taskIds })).taskRevisions }
    );

    const undoOf = (taskIds: string[]) => ({ type: 'restoreTasks', taskIds, taskRevisions: taskRevisionsOf(taskIds) });

    it('organizes only the revision-matched Contexts selection under No estimate', async () => {
        freezeClock();
        const tasks: Task[] = ['one', 'two', 'three', 'estimated', 'different-context'].map((id) => ({
            id, title: id, status: id === 'two' ? 'waiting' : 'next', createdAt: fixture.now, updatedAt: fixture.now,
            contexts: [id === 'different-context' ? '@other' : '@work'], tags: [],
            ...(id === 'estimated' ? { timeEstimate: '15min' } : {}),
        }));
        const sqlite = await openSqliteHost({ tasks, settings: { features: { timeEstimates: true } } });
        try {
            const { host } = sqlite;
            const log = vi.spyOn(logger, 'logInfo');
            const params = { tokens: ['@work'], matchMode: 'all', filters: { timeEstimates: ['none'] } };
            const draft: BulkOrganizeDraft = { ...EMPTY_BULK_ORGANIZE_DRAFT, estimateChoice: '30min' };
            const bulk = value(host.getBulkActions({ list: 'contexts', params, taskIds: ['one', 'two', 'estimated', 'different-context'], organize: { draft } }));
            expect(bulk).toMatchObject({ selectedIds: ['one', 'two'], selectableCount: 3, organize: { canApply: true } });
            const action = { type: 'organize', draft, taskIds: bulk.selectedIds, taskRevisions: bulk.taskRevisions } satisfies NativeBulkAction;
            expect(await host.runBulkAction({ requestId: requestId(), list: 'contexts', params, action: {
                ...action, taskIds: ['one', 'estimated'], taskRevisions: taskRevisionsOf(['one', 'estimated']),
            } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await host.runBulkAction({ requestId: requestId(), list: 'contexts', params, action: {
                ...action, taskRevisions: { ...bulk.taskRevisions, two: 'stale' },
            } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const request = { requestId: requestId(), list: 'contexts', params, action } satisfies Parameters<typeof host.runBulkAction>[0];
            expect(value(await host.runBulkAction(request)).changed).toBe(true);
            expect(value(await host.runBulkAction(request)).changed).toBe(true);
            expect(value(host.getBulkActions({ list: 'contexts', params, taskIds: ['one', 'two', 'three'] })).selectedIds).toEqual(['three']);
            expect(await sqlite.sql('SELECT id, status, timeEstimate FROM tasks ORDER BY id')).toEqual([
                { id: 'different-context', status: 'next', timeEstimate: null },
                { id: 'estimated', status: 'next', timeEstimate: '15min' },
                { id: 'one', status: 'next', timeEstimate: '30min' },
                { id: 'three', status: 'next', timeEstimate: null },
                { id: 'two', status: 'waiting', timeEstimate: '30min' },
            ]);
            expect(log.mock.calls.filter(([message]) => message === 'Native Android Contexts bulk Organize confirmed')).toEqual([
                ['Native Android Contexts bulk Organize confirmed', expect.objectContaining({ context: {
                    releaseCheck: 'v1.3.10/contexts-bulk-organize', count: 2, outcome: 'organized',
                } })],
            ]);
            const picker = value(host.getBulkActions({ list: 'contexts', params, taskIds: ['three'], organize: { draft },
                picker: { kind: 'project', query: 'Garden' } }));
            const createId = requestId();
            const created = value(await host.createBulkOrganizeDestination({ requestId: createId, list: 'contexts', params,
                kind: 'project', name: picker.picker?.create?.name ?? '', draft: picker.organize?.draft }));
            expect(created).toMatchObject({ id: createId, changed: true, draft: { projectChoice: createId, estimateChoice: '30min' } });
        } finally { await sqlite.close(); }
    });

    it('keeps read-only references visible and excludes them from Contexts Organize', async () => {
        freezeClock();
        const tasks: Task[] = [
            { id: 'editable', title: 'Editable', status: 'reference', createdAt: fixture.now, updatedAt: fixture.now, contexts: ['@work'], tags: [] },
            { id: 'read-only', title: 'Retained reference', status: 'reference', projectId: 'p-old',
                createdAt: fixture.now, updatedAt: fixture.now, contexts: ['@work'], tags: [] },
        ];
        const projects = fixture.projects.filter((project) => project.id === 'p-old').map((project) => ({ ...project, status: 'active' as const }));
        const sqlite = await openSqliteHost({ tasks, projects, areas: fixture.areas });
        try {
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [fixture.now, 'p-old']);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const { host } = sqlite;
            const params = { tokens: ['@work'], matchMode: 'all' as const, filters: { timeEstimates: ['none' as const] } };
            const read = (selectedIds: string[]) => value(host.getContextsView({ ...params, selectedIds, offset: 0, limit: 50 }));
            const ordinary = read(['read-only']);
            expect(ordinary.rows.find((row) => row.id === 'read-only')).toMatchObject({ readOnly: true });
            expect(ordinary.selectedIds).toEqual(['read-only']);
            expect(ordinary.bulk?.organizeEnabled).toBe(false);
            expect(read(['editable', 'read-only']).bulk?.organizeEnabled).toBe(true);
            const draft = { ...EMPTY_BULK_ORGANIZE_DRAFT, estimateChoice: '30min' };
            const bulk = value(host.getBulkActions({ list: 'contexts', params, taskIds: ['editable', 'read-only'], organize: { draft } }));
            expect(bulk).toMatchObject({ selectedIds: ['editable'], selectedCount: 1, organize: { canApply: true } });
            const action = { type: 'organize' as const, taskIds: ['editable', 'read-only'], taskRevisions: taskRevisionsOf(['editable', 'read-only']), draft };
            expect(await host.runBulkAction({ requestId: requestId(), list: 'contexts', params, action }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.sql('SELECT id, timeEstimate FROM tasks ORDER BY id')).toEqual([
                { id: 'editable', timeEstimate: null }, { id: 'read-only', timeEstimate: null },
            ]);
        } finally { await sqlite.close(); }
    });

    describe('equals core called directly', () => {
        const cases: { name: string; action: NativeBulkAction; list: 'inbox' | 'done'; write: () => TaskListBulkWrite | null }[] = [
            { name: 'move', list: 'inbox', action: { type: 'moveTasks', taskIds: ['i-call', 'i-milk'], status: 'next' } as NativeBulkAction, write: () => ({ kind: 'move', taskIds: ['i-call', 'i-milk'], status: 'next' }) },
            {
                name: 'add a tag', list: 'inbox',
                action: { type: 'editTaskTokens', taskIds: ['i-call', 'i-milk'], field: 'tags', mode: 'add', values: ['urgent'] },
                write: () => planBulkTagEdit(['i-call', 'i-milk'], useTaskStore.getState()._tasksById, 'add', 'urgent'),
            },
            {
                name: 'remove a tag', list: 'done',
                action: { type: 'editTaskTokens', taskIds: ['d-rent'], field: 'tags', mode: 'remove', values: ['#money'] },
                write: () => planBulkTagEdit(['d-rent'], useTaskStore.getState()._tasksById, 'remove', ['#money']),
            },
            {
                name: 'organize', list: 'inbox',
                action: { type: 'organize', taskIds: ['i-call', 'i-read'], draft: ORGANIZE },
                write: () => planBulkOrganize(['i-call', 'i-read'], useTaskStore.getState()._tasksById, buildBulkOrganizeInput({ ...EMPTY_BULK_ORGANIZE_DRAFT, ...ORGANIZE })),
            },
            { name: 'delete', list: 'inbox', action: { type: 'trashTasks', taskIds: ['i-milk', 'i-party'] }, write: () => ({ kind: 'trash', taskIds: ['i-milk', 'i-party'] }) },
        ];
        for (const entry of cases) {
            it(entry.name, async () => {
                freezeClock();
                const core = await open();
                const write = entry.write()!;
                await runTaskListBulkWrite(useTaskStore.getState(), write);
                const toast = getTaskListBulkToast(write, t);
                const expected = { tasks: tasksNow(), log: [...core.log] };
                await flushPendingSave();

                const contract = await open();
                const action = withRevisions(contract.host, entry.list, entry.action);
                const result = value(await contract.host.runBulkAction({ requestId: requestId(), list: entry.list, action }));
                expect({ tasks: tasksNow(), log: contract.log }).toEqual(expected);
                expect(result).toEqual({
                    changed: true,
                    toast: toast && {
                        tone: toast.tone, title: toast.title, message: toast.message,
                        undo: toast.undo ? { label: toast.undo.label, action: undoOf(toast.undo.taskIds) } : null,
                    },
                });
            });
        }

        it('the bar, the remove-tag tokens and the organize dialog', async () => {
            freezeClock();
            const { host } = await open();
            const view = value(host.getBulkActions({
                list: 'inbox', taskIds: ['i-milk', 'i-read'], organize: { draft: ORGANIZE }, picker: { kind: 'removeTag' },
            }));
            const state = useTaskStore.getState();
            expect(view.bar).toEqual(buildTaskListBulkBarModel({
                selectedCount: 2, hasSelection: true, busy: false, rangeSelectMode: false, statuses: getBulkMoveStatusOptions('inbox'),
                moveToSection: false, organize: true, removeTag: { canRemove: true }, t,
            }));
            expect(view.picker?.items.map((item) => item.value)).toEqual(collectBulkTaskTokens(['i-milk', 'i-read'], state._tasksById, 'tags'));
            const dialog = buildBulkOrganizeDialogModel({
                draft: { ...EMPTY_BULK_ORGANIZE_DRAFT, ...ORGANIZE },
                projects: getBulkOrganizeProjectOptions(state.projects),
                areas: getBulkOrganizeAreaOptions(state.areas),
                selectedCount: 2,
                timeEstimatesEnabled: true,
                t,
            });
            const { draft, statuses, dates, person, contexts, tags, ...rest } = view.organize!;
            const { statuses: _statuses, dates: _dates, person: corePerson, contexts: _contexts, tags: _tags, ...dialogRest } = dialog;
            expect(draft).toEqual({ ...EMPTY_BULK_ORGANIZE_DRAFT, ...ORGANIZE });
            expect(rest).toEqual(dialogRest);
            expect(statuses.map(({ edit: _edit, ...status }) => status)).toEqual(dialog.statuses);
            expect(dates.map((date) => [date.field, date.label])).toEqual(dialog.dates.map((date) => [date.field, date.label]));
            expect(person).toEqual(corePerson);
            expect([contexts, tags]).toEqual([{ ...dialog.contexts, value: '@desk' }, { ...dialog.tags, value: 'q4' }]);

            expect(dates[0]).toMatchObject({
                value: '2026-09-27', displayValue: '09/27/2026', pickerStart: '2026-09-27',
                quickDates: [
                    { preset: 'today', selected: false, value: '2026-09-26', edit: { type: 'setText', field: 'startDate', value: '2026-09-26' } },
                    { preset: 'tomorrow', selected: true, value: '', edit: { type: 'setText', field: 'startDate', value: '' } },
                ],
            });
            expect(dates[1]).toMatchObject({ value: '', displayValue: '', pickerStart: '2026-09-26' });
        });

        it('offers keep by default and validates custom estimates before applying', async () => {
            freezeClock();
            const { host } = await open();
            const read = (organize: Record<string, unknown> = {}) => value(host.getBulkActions({ list: 'inbox', taskIds: ['i-milk'], organize })).organize!;
            const initial = read();
            expect(initial.canApply).toBe(true);
            expect(initial.estimate?.options.find(({ selected }) => selected)?.value).toBe(BULK_ORGANIZE_KEEP);
            const custom = initial.estimate?.options.find(({ value }) => value === '__CUSTOM__');
            expect(custom).toBeDefined();
            const selected = read({ draft: initial.draft, edit: custom?.edit });
            expect(selected.canApply).toBe(false);
            const invalid = read({ draft: selected.draft, edit: { type: 'setText', field: 'estimateText', value: 'invalid estimate' } });
            expect(invalid.canApply).toBe(false);
            const valid = read({ draft: invalid.draft, edit: { type: 'setText', field: 'estimateText', value: '1h 15m' } });
            expect(valid.canApply).toBe(true);
            expect(valid.estimate?.timeEstimate).toBe('custom:75');
            useTaskStore.setState(({ settings }) => ({ settings: { ...settings, features: { ...settings.features, timeEstimates: false } } }));
            expect(read({ draft: valid.draft }).estimate).toBeNull();
        });

        it('offers priority and person edits independently of the selected tasks\' status', async () => {
            freezeClock();
            const { host } = await open();
            const taskIds = ['i-milk', 'i-read'];
            const read = (organize: { draft?: Partial<BulkOrganizeDraft>; edit?: unknown } = {}) => value(host.getBulkActions({
                list: 'inbox', taskIds, organize,
            })).organize!;
            const initial = read();
            expect(initial.priority?.options.find((option) => option.selected)?.value).toBe(BULK_ORGANIZE_KEEP);
            expect(initial.person.options.find((option) => option.selected)?.value).toBe(BULK_ORGANIZE_KEEP);
            const partial = read({ draft: initial.draft, edit: { type: 'setText', field: 'delegateWho', value: 'Ali' } });
            const alice = partial.person.suggestions.find(({ name }) => name === 'Alice');
            expect(alice).toBeDefined();
            const person = read({ draft: partial.draft, edit: alice?.edit });
            const priority = read({ draft: person.draft, edit: { type: 'setPriority', value: 'high' } });
            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox',
                action: withRevisions(host, 'inbox', { type: 'organize', taskIds, draft: priority.draft }) })).changed).toBe(true);
            const selected = () => taskIds.map((id) => {
                const task = useTaskStore.getState()._tasksById.get(id);
                return [task?.status, task?.priority, task?.assignedTo];
            });
            expect(selected()).toEqual([['inbox', 'high', 'Alice'], ['inbox', 'high', 'Alice']]);

            const noPerson = read({ draft: priority.draft, edit: { type: 'setPerson', value: BULK_ORGANIZE_NONE } });
            const clear = read({ draft: noPerson.draft, edit: { type: 'setPriority', value: BULK_ORGANIZE_NONE } });
            useTaskStore.setState(({ settings }) => ({ settings: { ...settings, features: { ...settings.features, priorities: false } } }));
            expect(read({ draft: clear.draft }).priority).toBeNull();
            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox',
                action: withRevisions(host, 'inbox', { type: 'organize', taskIds, draft: clear.draft }) })).changed).toBe(true);
            expect(selected()).toEqual([['inbox', 'high', undefined], ['inbox', 'high', undefined]]);
        });

        it('keeps a date the user is still typing in the organize dialog and only blocks Apply', async () => {
            freezeClock();
            const { host } = await open();
            const read = (organize: Record<string, unknown>) => value(host.getBulkActions({ list: 'inbox', taskIds: ['i-milk', 'i-read'], organize })).organize!;
            for (const [typed, canApply] of [['09/27/2026', false], ['2026-09-2', false], ['2026-09-28', true], ['', true]] as const) {
                const edited = read({ draft: ORGANIZE, edit: { type: 'setText', field: 'startDate', value: typed } });
                expect([edited.draft.startDate, edited.canApply]).toEqual([typed, canApply]);
                expect(read({ draft: edited.draft }).draft.startDate).toBe(typed);
            }
            const partial = { ...EMPTY_BULK_ORGANIZE_DRAFT, ...ORGANIZE, startDate: '2026-09-2' };
            expect(await host.runBulkAction({ requestId: requestId(), list: 'inbox',
                action: withRevisions(host, 'inbox', { type: 'organize', taskIds: ['i-read'], draft: partial }) }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        });
    });

    describe('retries exactly after a failed save', () => {
        const retry = async (list: 'inbox' | 'done', action: NativeBulkAction, expectedLog: unknown[]) => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            const { host, log } = await open(saveData);
            const input = { requestId: requestId(), list, action: withRevisions(host, list, action) };
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await host.runBulkAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
            expect(log).toEqual(expectedLog);
            const landed = tasksNow();
            saveData.mockResolvedValue(undefined);
            const retried = await host.runBulkAction(input);
            expect(retried).toMatchObject({ ok: true, value: { changed: true } });

            expect(log).toEqual(expectedLog);
            expect(tasksNow()).toEqual(landed);

            const plain = (tasks: unknown[]) => JSON.parse(JSON.stringify(tasks.map((task) => ({ ...(task as object), revBy: undefined }))));
            expect(plain((saveData.mock.lastCall?.[0] as { tasks: unknown[] }).tasks)).toEqual(plain(useTaskStore.getState()._allTasks));

            const saves = saveData.mock.calls.length;
            expect(await host.runBulkAction(input)).toEqual(retried);
            expect(saveData).toHaveBeenCalledTimes(saves);
            expect(await host.runBulkAction({ ...input, action: { ...input.action, taskIds: ['w-bob'] } as NativeBulkAction }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            return { host, retried };
        };

        it('a move', async () => {
            await retry('inbox', { type: 'moveTasks', taskIds: ['i-call', 'i-milk'], status: 'someday' }, [
                ['batchMoveTasks', ['i-call', 'i-milk'], 'someday'],
                ['batchUpdateTasks', [{ id: 'i-call', updates: { status: 'someday' } }, { id: 'i-milk', updates: { status: 'someday' } }]],
            ]);
        }, 20_000);

        it('adding a tag', async () => {
            await retry('inbox', { type: 'editTaskTokens', taskIds: ['i-call'], field: 'tags', mode: 'add', values: ['urgent'] }, [
                ['batchUpdateTasks', [{ id: 'i-call', updates: { tags: ['#health', '#urgent'] } }]],
            ]);
        }, 20_000);

        it('removing a tag', async () => {
            await retry('done', { type: 'editTaskTokens', taskIds: ['d-rent'], field: 'tags', mode: 'remove', values: ['#money'] }, [
                ['batchUpdateTasks', [{ id: 'd-rent', updates: { tags: [] } }]],
            ]);
        }, 20_000);

        it('Bulk organize', async () => {
            await retry('inbox', { type: 'organize', taskIds: ['i-read'], draft: { status: 'someday', tags: 'later' } }, [
                ['batchUpdateTasks', [{ id: 'i-read', updates: { status: 'someday', tags: ['#later'] } }]],
            ]);
        }, 20_000);

        it('a delete, then its Undo', async () => {
            const { host, retried } = await retry('inbox', { type: 'trashTasks', taskIds: ['i-milk', 'i-party'] }, [['batchDeleteTasks', ['i-milk', 'i-party']]]);
            expect(retried).toEqual({ ok: true, value: { changed: true, toast: {
                tone: 'success', title: 'Done', message: '2 tasks',
                undo: { label: 'Undo', action: undoOf(['i-milk', 'i-party']) },
            } } });
            const undo = (retried as { value: { toast: { undo: { action: NativeBulkAction } } } }).value.toast.undo.action;
            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: undo }))).toEqual({ changed: true, toast: null });
            expect(useTaskStore.getState()._tasksById.get('i-milk')?.deletedAt).toBeUndefined();
        }, 20_000);

        it('an Undo', async () => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            const { host, log } = await open(saveData);
            const trashed = value(await host.runBulkAction({ requestId: requestId(), list: 'waiting', action: withRevisions(host, 'waiting', { type: 'trashTasks', taskIds: ['w-landlord'] }) }));
            log.length = 0;
            const undo = { requestId: requestId(), list: 'waiting' as const, action: trashed.toast!.undo!.action };
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await host.runBulkAction(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            saveData.mockResolvedValue(undefined);
            expect(await host.runBulkAction(undo)).toEqual({ ok: true, value: { changed: true, toast: null } });
            expect(log).toEqual([['restoreTask', 'w-landlord']]);
            expect(useTaskStore.getState()._tasksById.get('w-landlord')?.deletedAt).toBeUndefined();
        }, 20_000);
    });

    describe('Select all', () => {
        it('acts on every selectable row on screen, less the rows deselected since', async () => {
            freezeClock();
            const { host, log } = await open();
            const params = { includeArchivedProjects: true };
            const view = value(host.getBulkActions({ list: 'reference', params, selectAll: { except: ['r-wifi'] } }));

            expect(view).toMatchObject({ selectableCount: 2, selectedCount: 1, selectedIds: [], selectAll: { params, except: ['r-wifi'] } });
            const result = value(await host.runBulkAction({ requestId: requestId(), list: 'reference', action: { type: 'moveTasks', status: 'next', selectAll: view.selectAll! } }));
            expect(result).toMatchObject({ changed: true, toast: { message: '1 task' } });
            expect(log[0]).toEqual(['batchMoveTasks', ['r-manual'], 'next']);
        });

        it('refuses with STALE_REVISION once the rows on screen changed', async () => {
            freezeClock();
            const { host, log } = await open();
            const view = value(host.getBulkActions({ list: 'inbox', selectAll: {} }));
            expect(view.selectedCount).toBe(4);

            await useTaskStore.getState().updateTask('i-read', { status: 'next' });
            log.length = 0;
            const stale = await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: { type: 'trashTasks', selectAll: view.selectAll! } });
            expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(log).toEqual([]);

            const fresh = value(host.getBulkActions({ list: 'inbox', selectAll: {} }));
            vi.setSystemTime(new Date(Date.parse(fixture.now) + 120_000));
            const done = value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: { type: 'trashTasks', selectAll: fresh.selectAll! } }));
            expect(done).toMatchObject({ changed: true, toast: { message: '3 tasks', undo: { action: { type: 'restoreTasks', taskIds: ['i-party', 'i-call', 'i-milk'] } } } });
        });

        it('refuses with STALE_REVISION once a selected row changed, even one still on screen', async () => {
            freezeClock();
            const { host, log } = await open();
            const view = value(host.getBulkActions({ list: 'inbox', selectAll: {} }));

            await useTaskStore.getState().updateTask('i-call', { title: 'Call the dentist' });
            log.length = 0;
            expect(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: { type: 'moveTasks', status: 'next', selectAll: view.selectAll! } }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(log).toEqual([]);
        });

        it('refuses with STALE_REVISION once a row synced to a revision the old 32-bit token could not tell apart', async () => {
            freezeClock();
            const { host, log } = await open();

            const first = { rev: 3, revBy: 'd', updatedAt: '2026-09-24T00:03:47.549Z' };
            const second = { rev: 3, revBy: 'd', updatedAt: '2026-09-24T00:08:28.592Z' };
            expect(paramsKey([`r-wifi@${revisionOf(first)}`])).toBe(paramsKey([`r-wifi@${revisionOf(second)}`]));
            const sync = (revision: typeof first) => useTaskStore.setState({
                _allTasks: useTaskStore.getState()._allTasks.map((task) => (task.id === 'r-wifi' ? { ...task, ...revision } : task)),
            });
            sync(first);
            const view = value(host.getBulkActions({ list: 'reference', params: { filters: { searchQuery: 'wifi' } }, selectAll: {} }));
            expect(view.selectedCount).toBe(1);

            sync(second);
            expect(await host.runBulkAction({ requestId: requestId(), list: 'reference', action: { type: 'trashTasks', selectAll: view.selectAll! } }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(log).toEqual([]);
            expect(useTaskStore.getState()._tasksById.get('r-wifi')?.deletedAt).toBeUndefined();
        });

        it('holds across a restart: a new host takes the Select all an old one showed', async () => {
            freezeClock();
            const { host, log } = await open();
            const view = value(host.getBulkActions({ list: 'inbox', selectAll: {} }));
            const input = { requestId: requestId(), list: 'inbox' as const, action: { type: 'editTaskTokens', field: 'tags', mode: 'add', values: ['urgent'], selectAll: view.selectAll! } as NativeBulkAction };
            const { result } = await replayAfterRestart((restarted) => restarted.runBulkAction(input));
            expect(result).toMatchObject({ ok: true, value: { changed: true } });
            expect(log).toEqual([['batchUpdateTasks', expect.any(Array)]]);
        });
    });

    describe('selection', () => {
        it('taps and Range keep the tap order; a read-only row does not select; hidden rows leave', async () => {
            freezeClock();
            const { host } = await open();
            const params = { includeArchivedProjects: true };
            const tap = (taskIds: string[], anchorId: string | null, taskId: string, range = false) => value(host.getBulkActions({
                list: 'reference', params, taskIds, anchorId, selectionEdit: { taskId, range },
            }));
            expect(tap([], null, 'r-old')).toMatchObject({ selectedIds: [], anchorId: null, selectedCount: 0 });
            const first = tap([], null, 'r-wifi');
            expect(first).toMatchObject({ selectedIds: ['r-wifi'], anchorId: 'r-wifi' });
            expect(tap(first.selectedIds, first.anchorId, 'r-manual', true)).toMatchObject({ selectedIds: ['r-wifi', 'r-manual'], anchorId: 'r-manual' });

            expect(host.getBulkActions({ list: 'reference', selectionEdit: { taskId: 'r-old' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

            const filtered = value(host.getBulkActions({ list: 'reference', params: { filters: { searchQuery: 'wifi' } }, taskIds: ['r-manual', 'r-wifi'] }));
            expect(filtered).toMatchObject({ selectedIds: ['r-wifi'], selectedCount: 1 });
        });

        it('shows the revision of each selected row, for the action to send', async () => {
            freezeClock();
            const { host, log } = await open();

            setNativeReplayTokens('required');
            const tasks = useTaskStore.getState()._tasksById;
            const revisions = { 's-novel': taskRevisionOf(tasks.get('s-novel')!), 's-piano': taskRevisionOf(tasks.get('s-piano')!) };
            const view = value(host.getBulkActions({ list: 'someday', taskIds: ['s-novel', 's-piano'] }));
            expect(view.taskRevisions).toEqual(revisions);
            expect(view.moveToSection).toEqual({ taskIds: ['s-novel', 's-piano'], taskRevisions: revisions });

            expect(value(host.getBulkActions({ list: 'someday', selectAll: {} })).taskRevisions).toEqual({});

            const refused = { ok: false, error: { code: 'INVALID_INPUT' } };
            expect(await host.runBulkAction({ requestId: requestId(), list: 'someday', action: { type: 'trashTasks', taskIds: ['s-novel'] } })).toMatchObject(refused);
            expect(await host.runBulkAction({ requestId: requestId(), list: 'someday', action: { type: 'trashTasks', taskIds: ['s-novel'], taskRevisions: revisions } }))
                .toMatchObject(refused);
            expect(await host.runBulkAction({ requestId: requestId(), list: 'someday', action: { type: 'restoreTasks', taskIds: ['s-novel'] } as never })).toMatchObject(refused);
            expect(log).toEqual([]);
        });

        it('the project picker lists projects in the Projects view order: area order, then project order (#1467)', async () => {
            freezeClock();
            const { host } = await open();
            const ids = (query?: string) => value(host.getBulkActions({
                list: 'inbox', taskIds: ['i-call'], organize: {}, picker: { kind: 'project', ...(query === undefined ? {} : { query }) },
            })).picker!.items.map((item) => item.value).filter((id) => id === 'p-launch' || id === 'p-home');

            expect(ids()).toEqual(['p-launch', 'p-home']);
            await useTaskStore.getState().updateArea('a-home', { order: -1 });
            expect(ids()).toEqual(['p-home', 'p-launch']);

            await useTaskStore.getState().updateProject('p-launch', { areaId: 'a-home', order: -10 });
            expect(ids()).toEqual(['p-launch', 'p-home']);
            expect(ids('h')).toEqual(['p-launch', 'p-home']);
        });

        it('the organize pickers lead with Keep and None, and search the rest', async () => {
            freezeClock();
            const { host } = await open();
            const view = value(host.getBulkActions({ list: 'inbox', taskIds: ['i-call'], organize: { draft: { projectChoice: 'p-home' } }, picker: { kind: 'project', query: 'LA' } }));
            expect(view.picker).toEqual({
                kind: 'project',
                total: 3,
                items: [
                    { value: BULK_ORGANIZE_KEEP, label: 'Keep project', selected: false, edit: { type: 'setProject', value: BULK_ORGANIZE_KEEP } },
                    { value: '__NONE__', label: t('taskEdit.noProjectOption'), selected: false, edit: { type: 'setProject', value: '__NONE__' } },
                    { value: 'p-launch', label: 'Launch', selected: false, edit: { type: 'setProject', value: 'p-launch' } },
                ],

                create: { name: 'LA', label: '+ Create "LA"', accessibilityLabel: 'Create: LA' },
                submit: { create: 'LA' },
            });
            const areaInput = { list: 'inbox' as const, taskIds: ['i-call'], organize: {}, picker: { kind: 'area' as const, limit: 1 } };
            expect(host.getBulkActions({ ...areaInput, picker: { ...areaInput.picker, offset: 2, revision: view.revision } }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const firstAreaPage = value(host.getBulkActions(areaInput));
            const areas = value(host.getBulkActions({ ...areaInput, picker: { ...areaInput.picker, offset: 2, revision: firstAreaPage.revision } }));
            expect(areas.picker).toMatchObject({ total: 4, items: [{ value: 'a-work', label: 'Work' }] });

            const chosen = value(host.getBulkActions({
                list: 'inbox', taskIds: ['i-call'], organize: { draft: { areaChoice: 'a-home' }, edit: { type: 'setProject', value: 'p-launch' } },
            }));
            expect(chosen.organize).toMatchObject({ draft: { projectChoice: 'p-launch', areaChoice: BULK_ORGANIZE_KEEP }, area: { disabled: true } });
        });
    });

    describe('target state', () => {
        it('a replay under a new request writes nothing', async () => {
            freezeClock();
            const { host, log } = await open();
            const actions: NativeBulkAction[] = [
                { type: 'moveTasks', taskIds: ['i-call'], status: 'next' },
                { type: 'editTaskTokens', taskIds: ['i-milk'], field: 'tags', mode: 'add', values: ['urgent'] },
                { type: 'organize', taskIds: ['i-read'], draft: { projectChoice: 'p-home', dueDate: '2026-10-20' } },
                { type: 'trashTasks', taskIds: ['i-party'] },
            ];
            let undo: NativeBulkAction | null = null;
            for (const [index, action] of [...actions].entries()) {
                actions[index] = withRevisions(host, 'inbox', action);
                const result = value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: actions[index] }));
                expect(result).toMatchObject({ changed: true });
                undo = result.toast?.undo?.action ?? undo;
            }
            actions.push(undo!);
            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: undo! }))).toMatchObject({ changed: true });
            log.length = 0;


            const moved = { tone: 'success', title: 'Done', message: '1 task', undo: null };
            for (const [index, action] of actions.slice(0, 3).entries()) {
                expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action }))).toEqual({ changed: false, toast: index === 0 ? moved : null });
            }
            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: actions[4] }))).toEqual({ changed: false, toast: null });
            expect(log).toEqual([]);
        });

        it('a Select all delete replayed after it landed (a new request after a restart) writes nothing', async () => {
            freezeClock();
            const { host, log } = await open();
            const view = value(host.getBulkActions({ list: 'inbox', selectAll: {} }));
            const action: NativeBulkAction = { type: 'trashTasks', selectAll: view.selectAll! };
            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action }))).toMatchObject({ changed: true });
            log.length = 0;

            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action }))).toEqual({ changed: false, toast: null });
            expect(log).toEqual([]);
        });

        it('a delete replayed after it landed writes nothing', async () => {
            freezeClock();
            const { host, log } = await open();
            const action = withRevisions(host, 'inbox', { type: 'trashTasks', taskIds: ['i-party', 'i-milk'] });
            value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action }));
            log.length = 0;
            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action }))).toEqual({ changed: false, toast: null });
            expect(log).toEqual([]);
        });
    });

    describe('a replay after a restart (a new host, no receipts) never undoes a later change', () => {
        const stale = { ok: false, error: { code: 'STALE_REVISION' } };
        const task = (id: string) => useTaskStore.getState()._tasksById.get(id)!;

        it.each([
            ['moveTasks', { type: 'moveTasks', taskIds: ['i-call', 'i-milk'], status: 'next' },
                () => useTaskStore.getState().updateTask('i-call', { status: 'inbox' }), () => expect(task('i-call').status).toBe('inbox')],
            ['editTaskTokens', { type: 'editTaskTokens', taskIds: ['i-call'], field: 'tags', mode: 'add', values: ['urgent'] },
                () => useTaskStore.getState().updateTask('i-call', { tags: ['#health'] }), () => expect(task('i-call').tags).toEqual(['#health'])],
            ['organize', { type: 'organize', taskIds: ['i-read'], draft: { status: 'someday', tags: 'later' } },
                () => useTaskStore.getState().updateTask('i-read', { status: 'inbox', tags: [] }), () => expect(task('i-read')).toMatchObject({ status: 'inbox', tags: [] })],
            ['trashTasks', { type: 'trashTasks', taskIds: ['i-milk', 'i-party'] },
                async () => { await useTaskStore.getState().restoreTask('i-milk'); await useTaskStore.getState().restoreTask('i-party'); },
                () => expect([task('i-milk').deletedAt, task('i-party').deletedAt]).toEqual([undefined, undefined])],
        ] as const)('%s: STALE once a task it writes changed since', async (_name, sent, change, kept) => {
            freezeClock();
            const { host } = await open();
            const input = { requestId: requestId(), list: 'inbox' as const, action: withRevisions(host, 'inbox', sent as NativeBulkAction) };
            expect(value(await host.runBulkAction(input))).toMatchObject({ changed: true });

            await change();
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.runBulkAction(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            kept();
        });

        it('restoreTasks (a delete\'s Undo): STALE once a task it restores changed since', async () => {
            freezeClock();
            const { host } = await open();
            const trashed = value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: withRevisions(host, 'inbox', { type: 'trashTasks', taskIds: ['i-milk'] }) }));
            const undo = { requestId: requestId(), list: 'inbox' as const, action: trashed.toast!.undo!.action };
            expect(value(await host.runBulkAction(undo))).toEqual({ changed: true, toast: null });

            await useTaskStore.getState().deleteTask('i-milk');
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.runBulkAction(undo));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(task('i-milk').deletedAt).toBeTruthy();
        });

        it('Select all: STALE once a row it selects changed since, even one still on screen', async () => {
            freezeClock();
            const { host } = await open();
            const view = value(host.getBulkActions({ list: 'inbox', selectAll: {} }));
            const input = { requestId: requestId(), list: 'inbox' as const, action: { type: 'editTaskTokens', field: 'tags', mode: 'add', values: ['urgent'], selectAll: view.selectAll! } as NativeBulkAction };
            expect(value(await host.runBulkAction(input))).toMatchObject({ changed: true });
            await useTaskStore.getState().updateTask('i-call', { tags: ['#health'] });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.runBulkAction(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(task('i-call').tags).toEqual(['#health']);
        });

        const selectAll = (host: Host) => value(host.getBulkActions({ list: 'inbox', selectAll: {} })).selectAll!;
        it.each([
            ['moveTasks', (host: Host): NativeBulkAction => withRevisions(host, 'inbox', { type: 'moveTasks', taskIds: ['i-call', 'i-milk'], status: 'next' })],
            ['moveTasks under Select all', (host: Host): NativeBulkAction => ({ type: 'moveTasks', status: 'next', selectAll: selectAll(host) })],
            ['editTaskTokens (a tag add) under Select all', (host: Host): NativeBulkAction => ({ type: 'editTaskTokens', field: 'tags', mode: 'add', values: ['urgent'], selectAll: selectAll(host) })],
            ['organize under Select all', (host: Host): NativeBulkAction => ({ type: 'organize', draft: { tags: 'later' }, selectAll: selectAll(host) })],
            ['trashTasks under Select all', (host: Host): NativeBulkAction => ({ type: 'trashTasks', selectAll: selectAll(host) })],
        ] as const)('%s: a replay of a request that landed answers changed: false and writes nothing', async (name, build) => {
            freezeClock();
            const { host, log } = await open();
            const input = { requestId: requestId(), list: 'inbox' as const, action: build(host) };
            expect(value(await host.runBulkAction(input))).toMatchObject({ changed: true });
            log.length = 0;
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.runBulkAction(input));

            const toast = name === 'moveTasks' ? { tone: 'success', title: 'Done', message: '2 tasks', undo: null } : null;
            expect(result).toEqual({ ok: true, value: { changed: false, toast } });
            expect(wrote).toBe(false);
            expect(log).toEqual([]);
        });

        it('moveTasks: every selected row there already writes nothing and answers mobile\'s toast for the move', async () => {
            freezeClock();
            const { host, log } = await open();
            const action = withRevisions(host, 'inbox', { type: 'moveTasks', taskIds: ['i-call', 'i-milk'], status: 'next' });
            await useTaskStore.getState().batchMoveTasks(['i-call', 'i-milk'], 'next');
            log.length = 0;
            expect(value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action })))
                .toEqual({ changed: false, toast: { tone: 'success', title: 'Done', message: '2 tasks', undo: null } });
            expect(log).toEqual([]);
        });

        it('moveTasks: a row another device moved there already is no conflict; the rest move', async () => {
            freezeClock();
            const { host, log } = await open();
            const input = { requestId: requestId(), list: 'inbox' as const, action: withRevisions(host, 'inbox', { type: 'moveTasks', taskIds: ['i-call', 'i-milk'], status: 'next' }) };

            await useTaskStore.getState().updateTask('i-call', { status: 'next' });
            log.length = 0;
            const { result } = await replayAfterRestart((restarted) => restarted.runBulkAction(input));
            expect(result).toMatchObject({ ok: true, value: { changed: true } });
            expect([task('i-call').status, task('i-milk').status]).toEqual(['next', 'next']);
        });
    });

    describe('creating a project or area from the organize pickers', () => {
        const picker = (host: Awaited<ReturnType<typeof open>>['host'], kind: 'project' | 'area' | 'removeTag', query?: string, extra: Record<string, unknown> = {}) => value(host.getBulkActions({
            list: 'inbox', taskIds: ['i-call'], organize: {}, picker: { kind, ...(query === undefined ? {} : { query }) }, ...extra,
        })).picker!;

        const destinationsNow = () => normalize({
            projects: useTaskStore.getState()._allProjects.map(({ id: _id, revBy: _revBy, ...project }) => project),
            areas: useTaskStore.getState()._allAreas.map(({ id: _id, revBy: _revBy, ...area }) => area),
        });

        it('offers Create for a name no option carries, and Done chooses an exact match, as the mobile pickers do', async () => {
            freezeClock();
            const { host } = await open();
            expect(picker(host, 'project', ' Garden ')).toMatchObject({
                create: { name: 'Garden', label: '+ Create "Garden"', accessibilityLabel: 'Create: Garden' },
                submit: { create: 'Garden' },
            });

            expect(picker(host, 'project', ' LAUNCH ')).toMatchObject({ create: null, submit: { edit: { type: 'setProject', value: 'p-launch' } } });
            expect(picker(host, 'project', 'Old stuff')).toMatchObject({ create: { name: 'Old stuff' }, submit: { create: 'Old stuff' } });
            expect(picker(host, 'area', 'home')).toMatchObject({ create: null, submit: { edit: { type: 'setArea', value: 'a-home' } } });
            expect(picker(host, 'area', 'Errands')).toMatchObject({
                create: { name: 'Errands', label: '+ Create "Errands"', accessibilityLabel: 'Create: Errands' },
                submit: { create: 'Errands' },
            });

            expect(picker(host, 'project')).toMatchObject({ create: null, submit: null });
            expect(picker(host, 'project', '  ')).toMatchObject({ create: null, submit: null });
            expect(picker(host, 'project', 'Garden', { busy: true })).toMatchObject({ create: null, submit: null });
            expect(value(host.getBulkActions({ list: 'inbox', taskIds: ['i-milk'], picker: { kind: 'removeTag', query: 'x' } })).picker)
                .toMatchObject({ create: null, submit: null });
        });

        it.each([
            ['project', 'Garden', { areaChoice: 'a-home' }, () => createBulkOrganizeProject(' Garden ', 'a-home')],
            ['project', 'Garden', { projectChoice: 'p-launch' }, () => createBulkOrganizeProject(' Garden ')],
            ['area', 'Errands', { projectChoice: BULK_ORGANIZE_NONE }, () => createBulkOrganizeArea(' Errands ')],
        ] as const)('creates the %s %s as core\'s createBulkOrganize* does for mobile, and chooses it', async (kind, name, draft, core) => {
            freezeClock();
            const direct = await open();
            const created = await core();
            const expected = destinationsNow();
            expect(direct.log).toEqual([]);

            const contract = await open();
            const tasks = tasksNow();
            const result = value(await contract.host.createBulkOrganizeDestination({ requestId: requestId(), list: 'inbox', kind, name: ` ${name} `, draft }));
            expect(destinationsNow()).toEqual(expected);
            expect(result.changed).toBe(true);
            expect(result.id).toBe((kind === 'project' ? useTaskStore.getState().projects : useTaskStore.getState().areas).find((entry) => (
                'title' in entry ? entry.title : entry.name) === name)!.id);
            expect(created).not.toBeNull();

            expect(result.draft).toEqual(kind === 'project'
                ? { ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft, projectChoice: result.id, areaChoice: BULK_ORGANIZE_KEEP }
                : { ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft, areaChoice: result.id });

            expect(contract.log).toEqual([]);
            expect(tasksNow()).toEqual(tasks);
        });

        it('refuses a name an option already carries: the picker\'s submit edit chooses it, and nothing is written', async () => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            const { host } = await open(saveData);
            const refused = { ok: false, error: { code: 'INVALID_INPUT' } };
            expect(await host.createBulkOrganizeDestination({ requestId: requestId(), list: 'inbox', kind: 'project', name: 'launch' })).toMatchObject(refused);
            expect(picker(host, 'project', 'launch')).toMatchObject({ create: null, submit: { edit: { type: 'setProject', value: 'p-launch' } } });
            const first = value(await host.createBulkOrganizeDestination({ requestId: requestId(), list: 'inbox', kind: 'area', name: 'Errands' }));
            expect(first.changed).toBe(true);
            const stored = destinationsNow();
            saveData.mockClear();
            expect(await host.createBulkOrganizeDestination({ requestId: requestId(), list: 'inbox', kind: 'area', name: ' errands ' })).toMatchObject(refused);
            expect(destinationsNow()).toEqual(stored);
            expect(saveData).not.toHaveBeenCalled();
        });

        it.each([

            ['project', 'Garden', { areaChoice: 'a-work' }, () => useTaskStore.getState().deleteArea('a-work')],

            ['area', 'Errands', { projectChoice: 'p-home' }, () => useTaskStore.getState().updateProject('p-home', { status: 'archived' })],
        ] as const)('retries a new %s exactly after a failed save, even when its draft\'s choice left the dialog since', async (kind, name, draft, change) => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            const { host } = await open(saveData);
            const input = { requestId: requestId(), list: 'inbox' as const, kind, name, draft };
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await host.createBulkOrganizeDestination(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
            const entries = () => (kind === 'project' ? useTaskStore.getState()._allProjects : useTaskStore.getState()._allAreas)
                .filter((entry) => ('title' in entry ? entry.title : entry.name) === name);
            expect(entries()).toHaveLength(1);
            await change();
            const landed = destinationsNow();
            saveData.mockResolvedValue(undefined);
            const retried = value(await host.createBulkOrganizeDestination(input));
            expect(retried).toEqual({
                id: entries()[0].id,
                changed: true,
                draft: kind === 'project'
                    ? { ...EMPTY_BULK_ORGANIZE_DRAFT, projectChoice: entries()[0].id, areaChoice: BULK_ORGANIZE_KEEP }
                    : { ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft, areaChoice: entries()[0].id },
            });

            expect(destinationsNow()).toEqual(landed);
            const saved = saveData.mock.lastCall?.[0] as { projects: { id: string }[]; areas: { id: string }[] };
            expect((kind === 'project' ? saved.projects : saved.areas).filter((entry) => entry.id === retried.id)).toHaveLength(1);
            expect(useTaskStore.getState().persistenceFailure).toBeNull();

            const saves = saveData.mock.calls.length;
            expect(await host.createBulkOrganizeDestination(input)).toEqual({ ok: true, value: retried });
            expect(saveData).toHaveBeenCalledTimes(saves);
            expect(await host.createBulkOrganizeDestination({ ...input, name: 'Orchard' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }, 20_000);

        it('a replay after a restart resolves the row it made, even renamed, archived or deleted, and adds nothing', async () => {
            freezeClock();
            const { host } = await open();
            const area = { requestId: requestId(), list: 'inbox' as const, kind: 'area' as const, name: 'Errands' };
            const deleted = { requestId: requestId(), list: 'inbox' as const, kind: 'project' as const, name: 'Garden', draft: { areaChoice: 'a-home' } };
            const archived = { requestId: requestId(), list: 'inbox' as const, kind: 'project' as const, name: 'Orchard' };
            const first = await Promise.all([area, deleted, archived].map(async (input) => value(await host.createBulkOrganizeDestination(input))));
            expect(first.every((result) => result.changed)).toBe(true);

            expect(first.map((result) => result.id)).toEqual([area.requestId, deleted.requestId, archived.requestId]);
            await useTaskStore.getState().updateArea(first[0].id, { name: 'Chores' });
            await useTaskStore.getState().deleteProject(first[1].id);
            await useTaskStore.getState().updateProject(first[2].id, { status: 'archived' });
            await flushPendingSave();
            const stored = destinationsNow();

            const restarted = await openBulkActionsHost();
            expect(value(await restarted.createBulkOrganizeDestination(area)))
                .toEqual({ id: first[0].id, changed: false, draft: { ...EMPTY_BULK_ORGANIZE_DRAFT, areaChoice: first[0].id } });

            expect(value(await restarted.createBulkOrganizeDestination(deleted)))
                .toEqual({ id: first[1].id, changed: false, draft: { ...EMPTY_BULK_ORGANIZE_DRAFT, areaChoice: 'a-home' } });
            expect(value(await restarted.createBulkOrganizeDestination(archived)))
                .toEqual({ id: first[2].id, changed: false, draft: EMPTY_BULK_ORGANIZE_DRAFT });
            expect(destinationsNow()).toEqual(stored);
            expect(useTaskStore.getState()._allAreas.filter((entry) => entry.name === 'Errands')).toEqual([]);
            expect(useTaskStore.getState()._projectsById.get(first[1].id)?.deletedAt).toBeTruthy();
        }, 20_000);

        it('a new area named like a deleted one restores that area under its own ID, and saves', async () => {
            freezeClock();
            const { host } = await open();
            await useTaskStore.getState().deleteArea('a-home');
            await flushPendingSave();
            const input = { requestId: requestId(), list: 'inbox' as const, kind: 'area' as const, name: 'Home' };

            expect(value(await host.createBulkOrganizeDestination(input))).toMatchObject({ id: 'a-home', changed: true });
            expect(useTaskStore.getState()._allAreas.filter((area) => area.name === 'Home').map((area) => [area.id, area.deletedAt]))
                .toEqual([['a-home', undefined]]);
            expect(useTaskStore.getState().persistenceFailure).toBeNull();

            const replayed = await replayAfterRestart((restarted) => restarted.createBulkOrganizeDestination(input));
            expect(replayed).toMatchObject({ result: { ok: false, error: { code: 'INVALID_INPUT' } }, wrote: false });
        });

        it('refuses invalid input without writing', async () => {
            freezeClock();
            const { host } = await open();
            const stored = destinationsNow();
            const refused = async (input: Record<string, unknown>) => expect(await host.createBulkOrganizeDestination({
                requestId: requestId(), list: 'inbox', kind: 'project', name: 'Garden', ...input,
            } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            await refused({ list: 'waiting' });
            await refused({ list: 'contexts' });
            await refused({ kind: 'tag' });
            await refused({ name: '   ' });
            await refused({ name: 7 });
            await refused({ name: 'x'.repeat(501) });
            await refused({ draft: { areaChoice: 'a-gone' } });
            await refused({ draft: { color: 'red' } });
            await refused({ requestId: 'not-a-uuid' });
            expect(destinationsNow()).toEqual(stored);
        });
    });

    it('is NOT_READY before native storage is activated', async () => {
        freezeClock();
        const log: unknown[] = [];
        await seedBulkActionsStore(fixture, log);
        const host = createNativeHostContract();
        expect(host.getBulkActions({ list: 'inbox' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: { type: 'trashTasks', taskIds: ['i-call'] } }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(await host.createBulkOrganizeDestination({ requestId: requestId(), list: 'inbox', kind: 'area', name: 'Errands' }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(log).toEqual([]);
        expect(useTaskStore.getState().areas.some((area) => area.name === 'Errands')).toBe(false);
    });

    it('refuses invalid input without writing', async () => {
        freezeClock();
        const { host, log } = await open();

        const refused = async (list: string, action: unknown) => {
            const sent = action as { taskIds?: unknown };
            const revisions = Array.isArray(sent.taskIds) ? { taskRevisions: Object.fromEntries(sent.taskIds.map((id: string) => [id, 'r'])) } : {};
            expect(await host.runBulkAction({ requestId: requestId(), list: list as 'inbox', action: { ...sent, ...revisions } as NativeBulkAction }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        };
        await refused('trash', { type: 'trashTasks', taskIds: ['i-call'] });
        await refused('inbox', { type: 'moveTasks', taskIds: ['i-call'], status: 'inbox' });
        await refused('waiting', { type: 'moveTasks', taskIds: ['w-bob'], status: 'archived' });
        await refused('waiting', { type: 'organize', taskIds: ['w-bob'], draft: { status: 'next' } });
        await refused('waiting', { type: 'editTaskTokens', taskIds: ['w-bob'], field: 'tags', mode: 'remove', values: ['#x'] });
        await refused('inbox', { type: 'editTaskTokens', taskIds: ['i-call'], field: 'contexts', mode: 'add', values: ['@x'] });
        await refused('inbox', { type: 'editTaskTokens', taskIds: ['i-call'], field: 'tags', mode: 'add', values: ['  '] });
        await refused('inbox', { type: 'moveTasks', status: 'next', taskIds: ['i-call'], selectAll: { params: {}, revision: 'x' } });
        await refused('inbox', { type: 'moveTasks', status: 'next', taskIds: ['missing'] });
        await refused('inbox', { type: 'moveTasks', status: 'next', taskIds: ['i-deleted'] });
        await refused('reference', { type: 'moveTasks', status: 'next', taskIds: ['r-old'] });
        await refused('inbox', { type: 'organize', taskIds: ['i-call'], draft: { status: 'waiting' } });
        await refused('inbox', { type: 'organize', taskIds: ['i-call'], draft: { dueDate: '10/20/2026' } });
        await refused('inbox', { type: 'organize', taskIds: ['i-call'], draft: { startDate: '2026-02-30' } });
        await refused('inbox', { type: 'organize', taskIds: ['i-call'], draft: { startDate: '2026-09-27T09:00' } });
        await refused('inbox', { type: 'organize', taskIds: ['i-call'], draft: { projectChoice: 'p-old' } });
        await refused('inbox', { type: 'organize', taskIds: ['i-call'], draft: { areaChoice: 'a-gone' } });
        await refused('inbox', { type: 'organize', taskIds: ['i-call'], draft: { color: 'red' } });
        await refused('inbox', { type: 'moveTasks', status: 'next', selectAll: { params: { filterEdit: { type: 'clear' } }, revision: 'x' } });
        await refused('inbox', { type: 'restoreTasks', taskIds: ['missing'] });
        expect(await host.runBulkAction({ requestId: 'not-a-uuid', list: 'inbox', action: { type: 'trashTasks', taskIds: ['i-call'] } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const view = (input: unknown) => expect(host.getBulkActions(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        view({ list: 'project' });
        view({ list: 'inbox', taskIds: ['i-call'], selectAll: {} });
        view({ list: 'waiting', organize: {} });
        view({ list: 'waiting', picker: { kind: 'removeTag' } });
        view({ list: 'inbox', params: { offset: 3 } });
        view({ list: 'inbox', organize: { draft: {}, edit: { type: 'setText', field: 'dueDate', value: '2026-10-20 9' } } });
        view({ list: 'inbox', organize: { edit: { type: 'rename' } } });
        view({ list: 'inbox', selectAll: {}, selectionEdit: { taskId: 'i-call' } });
        expect(host.getBulkActions({ list: 'inbox', picker: { kind: 'project', offset: 1 } } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(log).toEqual([]);
    });
});
