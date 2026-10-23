import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectBulkTaskTokens } from './bulk-task-tokens';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract } from './native-host-contract';
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
            // Selection reads never wrote the initial rows. The explicit incoming
            // task creation above is checked separately by the store action.
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
    /** Every task as stored, less the device stamp. */
    const tasksNow = () => normalize(useTaskStore.getState()._allTasks.map(({ revBy: _revBy, ...task }) => task));
    type Host = Awaited<ReturnType<typeof open>>['host'];
    /** The action with the revisions the list's selection view shows for its explicit rows. */
    const withRevisions = (host: Host, list: 'inbox' | 'waiting' | 'someday' | 'reference' | 'done', action: NativeBulkAction): NativeBulkAction => (
        action.taskIds === undefined || action.type === 'restoreTasks' ? action
            : { ...action, taskRevisions: value(host.getBulkActions({ list, params: list === 'reference' ? { includeArchivedProjects: true } : {}, taskIds: action.taskIds })).taskRevisions }
    );
    /** The toast's Undo as core builds it: the trashed tasks, at their revisions after the delete. */
    const undoOf = (taskIds: string[]) => ({ type: 'restoreTasks', taskIds, taskRevisions: taskRevisionsOf(taskIds) });

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
                t,
            });
            const { draft, statuses, dates, waitingFor, contexts, tags, ...rest } = view.organize!;
            const { statuses: _statuses, dates: _dates, waitingFor: _waitingFor, contexts: _contexts, tags: _tags, ...dialogRest } = dialog;
            expect(draft).toEqual({ ...EMPTY_BULK_ORGANIZE_DRAFT, ...ORGANIZE });
            expect(rest).toEqual(dialogRest);
            expect(statuses.map(({ edit: _edit, ...status }) => status)).toEqual(dialog.statuses);
            expect(dates.map((date) => [date.field, date.label])).toEqual(dialog.dates.map((date) => [date.field, date.label]));
            expect(waitingFor).toEqual({ ...dialog.waitingFor, value: 'Alice' });
            expect([contexts, tags]).toEqual([{ ...dialog.contexts, value: '@desk' }, { ...dialog.tags, value: 'q4' }]);
            // Start holds tomorrow: its chip is on and clears it; the picker opens there.
            expect(dates[0]).toMatchObject({
                value: '2026-09-27', displayValue: '09/27/2026', pickerStart: '2026-09-27',
                quickDates: [
                    { preset: 'today', selected: false, value: '2026-09-26', edit: { type: 'setText', field: 'startDate', value: '2026-09-26' } },
                    { preset: 'tomorrow', selected: true, value: '', edit: { type: 'setText', field: 'startDate', value: '' } },
                ],
            });
            expect(dates[1]).toMatchObject({ value: '', displayValue: '', pickerStart: '2026-09-26' });
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
            // The retry only saved: no second write, the same tasks.
            expect(log).toEqual(expectedLog);
            expect(tasksNow()).toEqual(landed);
            // The retry's save stored what landed.
            const plain = (tasks: unknown[]) => JSON.parse(JSON.stringify(tasks.map((task) => ({ ...(task as object), revBy: undefined }))));
            expect(plain((saveData.mock.lastCall?.[0] as { tasks: unknown[] }).tasks)).toEqual(plain(useTaskStore.getState()._allTasks));
            // A lost reply repeats the request: no write, no save.
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
            // The archived project's reference opens read-only: Select all skips it.
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
            // Another device files a row away.
            await useTaskStore.getState().updateTask('i-read', { status: 'next' });
            log.length = 0;
            const stale = await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: { type: 'trashTasks', selectAll: view.selectAll! } });
            expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(log).toEqual([]);
            // Minutes passing change nothing on screen: Select all still holds.
            const fresh = value(host.getBulkActions({ list: 'inbox', selectAll: {} }));
            vi.setSystemTime(new Date(Date.parse(fixture.now) + 120_000));
            const done = value(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: { type: 'trashTasks', selectAll: fresh.selectAll! } }));
            expect(done).toMatchObject({ changed: true, toast: { message: '3 tasks', undo: { action: { type: 'restoreTasks', taskIds: ['i-party', 'i-call', 'i-milk'] } } } });
        });

        it('refuses with STALE_REVISION once a selected row changed, even one still on screen', async () => {
            freezeClock();
            const { host, log } = await open();
            const view = value(host.getBulkActions({ list: 'inbox', selectAll: {} }));
            // Another device renames a row: the rows on screen stay the same.
            await useTaskStore.getState().updateTask('i-call', { title: 'Call the dentist' });
            log.length = 0;
            expect(await host.runBulkAction({ requestId: requestId(), list: 'inbox', action: { type: 'moveTasks', status: 'next', selectAll: view.selectAll! } }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(log).toEqual([]);
        });

        it('refuses with STALE_REVISION once a row synced to a revision the old 32-bit token could not tell apart', async () => {
            freezeClock();
            const { host, log } = await open();
            // Two revisions of r-wifi whose old token (the count and a 32-bit FNV hash) was the same.
            const first = { rev: 3, revBy: 'd', updatedAt: '2026-09-24T00:03:47.549Z' };
            const second = { rev: 3, revBy: 'd', updatedAt: '2026-09-24T00:08:28.592Z' };
            expect(paramsKey([`r-wifi@${revisionOf(first)}`])).toBe(paramsKey([`r-wifi@${revisionOf(second)}`]));
            const sync = (revision: typeof first) => useTaskStore.setState({
                _allTasks: useTaskStore.getState()._allTasks.map((task) => (task.id === 'r-wifi' ? { ...task, ...revision } : task)),
            });
            sync(first);
            const view = value(host.getBulkActions({ list: 'reference', params: { filters: { searchQuery: 'wifi' } }, selectAll: {} }));
            expect(view.selectedCount).toBe(1);
            // Another device's version of the row arrives.
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
            // Without archived projects, r-old is not on screen at all.
            expect(host.getBulkActions({ list: 'reference', selectionEdit: { taskId: 'r-old' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            // A row filtered away leaves the selection.
            const filtered = value(host.getBulkActions({ list: 'reference', params: { filters: { searchQuery: 'wifi' } }, taskIds: ['r-manual', 'r-wifi'] }));
            expect(filtered).toMatchObject({ selectedIds: ['r-wifi'], selectedCount: 1 });
        });

        it('shows the revision of each selected row, for the action to send', async () => {
            freezeClock();
            const { host, log } = await open();
            // As the journaling Android host: each write must carry its replay tokens.
            setNativeReplayTokens('required');
            const tasks = useTaskStore.getState()._tasksById;
            const revisions = { 's-novel': taskRevisionOf(tasks.get('s-novel')!), 's-piano': taskRevisionOf(tasks.get('s-piano')!) };
            const view = value(host.getBulkActions({ list: 'someday', taskIds: ['s-novel', 's-piano'] }));
            expect(view.taskRevisions).toEqual(revisions);
            expect(view.moveToSection).toEqual({ taskIds: ['s-novel', 's-piano'], taskRevisions: revisions });
            // Select all's own revision covers its rows.
            expect(value(host.getBulkActions({ list: 'someday', selectAll: {} })).taskRevisions).toEqual({});
            // Explicit rows need exactly their revisions.
            const refused = { ok: false, error: { code: 'INVALID_INPUT' } };
            expect(await host.runBulkAction({ requestId: requestId(), list: 'someday', action: { type: 'trashTasks', taskIds: ['s-novel'] } })).toMatchObject(refused);
            expect(await host.runBulkAction({ requestId: requestId(), list: 'someday', action: { type: 'trashTasks', taskIds: ['s-novel'], taskRevisions: revisions } }))
                .toMatchObject(refused);
            expect(await host.runBulkAction({ requestId: requestId(), list: 'someday', action: { type: 'restoreTasks', taskIds: ['s-novel'] } as never })).toMatchObject(refused);
            expect(log).toEqual([]);
        });

        it('the project picker lists projects in the mobile picker order (by order, not by title)', async () => {
            freezeClock();
            const { host } = await open();
            await useTaskStore.getState().updateProject('p-launch', { order: -10 });
            await useTaskStore.getState().updateProject('p-home', { order: 10 });
            const ids = (query?: string) => value(host.getBulkActions({
                list: 'inbox', taskIds: ['i-call'], organize: {}, picker: { kind: 'project', ...(query === undefined ? {} : { query }) },
            })).picker!.items.map((item) => item.value).filter((id) => id === 'p-launch' || id === 'p-home');
            // Title order would put Home first; mobile's TaskEditProjectPicker sorts by `order`.
            expect(ids()).toEqual(['p-launch', 'p-home']);
            // A search keeps that order ("h" is in both titles).
            expect(ids('h')).toEqual(['p-launch', 'p-home']);
            // Equal custom orders keep the title order passed to the mobile picker.
            await useTaskStore.getState().updateProject('p-launch', { order: 10 });
            expect(ids()).toEqual(['p-home', 'p-launch']);
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
                // "LA" names no project exactly: the search box offers to create it.
                create: { name: 'LA', label: '+ Create "LA"', accessibilityLabel: 'Create: LA' },
                submit: { create: 'LA' },
            });
            const areaInput = { list: 'inbox' as const, taskIds: ['i-call'], organize: {}, picker: { kind: 'area' as const, limit: 1 } };
            expect(host.getBulkActions({ ...areaInput, picker: { ...areaInput.picker, offset: 2, revision: view.revision } }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const firstAreaPage = value(host.getBulkActions(areaInput));
            const areas = value(host.getBulkActions({ ...areaInput, picker: { ...areaInput.picker, offset: 2, revision: firstAreaPage.revision } }));
            expect(areas.picker).toMatchObject({ total: 4, items: [{ value: 'a-work', label: 'Work' }] });
            // Choosing a project resets the area to Keep.
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
            // The Undo's replay finds the task back; the delete's replay would trash it again, so it runs before its Undo.
            // The move answers mobile's toast for it; a tag or organize change with nothing to write shows none.
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
            // The trashed rows left the Inbox: Select all now covers no row to delete, checked before its revision.
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
            // The user takes it back by hand.
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
            // The user deletes it again.
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
            // Explicit rows all moved already: mobile's toast for the move. Select all's rows left the Inbox: none.
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
            // The request never ran; another device files i-call under Next.
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
        /** Projects and areas as stored, less what a new row draws at random (its ID and device stamp). */
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
            // A title match ignores case and spaces; an archived project is no option, so its title can be created.
            expect(picker(host, 'project', ' LAUNCH ')).toMatchObject({ create: null, submit: { edit: { type: 'setProject', value: 'p-launch' } } });
            expect(picker(host, 'project', 'Old stuff')).toMatchObject({ create: { name: 'Old stuff' }, submit: { create: 'Old stuff' } });
            expect(picker(host, 'area', 'home')).toMatchObject({ create: null, submit: { edit: { type: 'setArea', value: 'a-home' } } });
            expect(picker(host, 'area', 'Errands')).toMatchObject({
                create: { name: 'Errands', label: '+ Create "Errands"', accessibilityLabel: 'Create: Errands' },
                submit: { create: 'Errands' },
            });
            // Nothing to create without a search, while Apply runs, or on the remove-tag picker.
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
            // The draft chooses it, as mobile's picker does after a create; a project resets the area to Keep.
            expect(result.draft).toEqual(kind === 'project'
                ? { ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft, projectChoice: result.id, areaChoice: BULK_ORGANIZE_KEEP }
                : { ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft, areaChoice: result.id });
            // Creating writes no task.
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
            // The draft's area leaves the dialog before the retry.
            ['project', 'Garden', { areaChoice: 'a-work' }, () => useTaskStore.getState().deleteArea('a-work')],
            // The draft's project leaves the dialog before the retry.
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
            // The retry only saved: nothing new in memory, and storage holds the new row.
            expect(destinationsNow()).toEqual(landed);
            const saved = saveData.mock.lastCall?.[0] as { projects: { id: string }[]; areas: { id: string }[] };
            expect((kind === 'project' ? saved.projects : saved.areas).filter((entry) => entry.id === retried.id)).toHaveLength(1);
            expect(useTaskStore.getState().persistenceFailure).toBeNull();
            // A lost reply repeats the request: no write, no save.
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
            // The row takes the request UUID as its ID.
            expect(first.map((result) => result.id)).toEqual([area.requestId, deleted.requestId, archived.requestId]);
            await useTaskStore.getState().updateArea(first[0].id, { name: 'Chores' });
            await useTaskStore.getState().deleteProject(first[1].id);
            await useTaskStore.getState().updateProject(first[2].id, { status: 'archived' });
            await flushPendingSave();
            const stored = destinationsNow();
            // A new host has no receipts: the replays find the rows by their request UUIDs.
            const restarted = await openBulkActionsHost();
            expect(value(await restarted.createBulkOrganizeDestination(area)))
                .toEqual({ id: first[0].id, changed: false, draft: { ...EMPTY_BULK_ORGANIZE_DRAFT, areaChoice: first[0].id } });
            // A project that is no option any more is not chosen: the draft stays as sent.
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
            // The store restores the deleted area: the request UUID must not rename it.
            expect(value(await host.createBulkOrganizeDestination(input))).toMatchObject({ id: 'a-home', changed: true });
            expect(useTaskStore.getState()._allAreas.filter((area) => area.name === 'Home').map((area) => [area.id, area.deletedAt]))
                .toEqual([['a-home', undefined]]);
            expect(useTaskStore.getState().persistenceFailure).toBeNull();
            // A replay after a restart finds no row under its UUID and a live Home: refused, nothing written.
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
            await refused({ list: 'project' });
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
        // Explicit rows carry revisions, so each case below is refused for what it names.
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
        view({ list: 'inbox', organize: { draft: {}, edit: { type: 'setText', field: 'dueDate', value: 'tomorrow' } } });
        view({ list: 'inbox', organize: { edit: { type: 'rename' } } });
        view({ list: 'inbox', selectAll: {}, selectionEdit: { taskId: 'i-call' } });
        expect(host.getBulkActions({ list: 'inbox', picker: { kind: 'project', offset: 1 } } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(log).toEqual([]);
    });
});
