import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Section } from './types';

const at = '2026-10-01T12:00:00.000Z';
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: id === 'p' ? 'Kitchen' : id, status: 'active', color: '#123456', order: 0, tagIds: ['#home'], createdAt: at, updatedAt: at, ...extra,
});
const section = (id: string, order: number): Section => ({ id, projectId: 'p', title: id, order, createdAt: at, updatedAt: at });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function open(initial: Partial<AppData> = {}, fail?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [project('p'), project('archived', { status: 'archived' })], sections: [],
        areas: [{ id: 'a', name: 'Home', order: 0, color: '#10b981', createdAt: at, updatedAt: at }], people: [], settings: { deviceId: 'device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves += 1;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return { host, data: () => data, saves: () => saves, stored: () => data.projects.find((item) => item.id === 'p')! };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); });

// Project details' journaled edit (the user's intent, written first): options, preparation and commit run inside it, so a
// boot replay or a retry redoes the whole edit, and a replayed edit already applied writes nothing more.
describe('runProjectEdit', () => {
    it('applies a typed title once, and a replay of the same edit writes nothing', async () => {
        const { host, stored, saves } = await open();
        const edit = { requestId: uuid(1), projectId: 'p', kind: 'title', title: '  Kitchen plan  ' } as const;
        expect(await host.runProjectEdit(edit)).toEqual({ ok: true, value: { id: 'p', kind: 'title', outcome: 'saved' } });
        expect(stored().title).toBe('Kitchen plan');
        const count = saves();
        expect(await host.runProjectEdit(edit)).toEqual({ ok: true, value: { id: 'p', kind: 'title', outcome: 'unchanged' } });
        expect(saves()).toBe(count);
    });

    it('prepares again when a sync changes the project between its options and its preparation', async () => {
        const { host, stored } = await open();
        const options = host.getProjectNotesEditOptions.bind(host);
        let synced = false;
        const spy = vi.spyOn(host, 'getProjectNotesEditOptions').mockImplementation((input) => {
            const answer = options(input);
            if (!synced) {
                synced = true;
                void useTaskStore.getState().updateProject('p', { tagIds: ['#home', '#synced'] });
            }
            return answer;
        });
        expect(await host.runProjectEdit({ requestId: uuid(2), projectId: 'p', kind: 'notes', text: 'Typed notes' }))
            .toEqual({ ok: true, value: { id: 'p', kind: 'notes', outcome: 'saved' } });
        expect(stored()).toMatchObject({ supportNotes: 'Typed notes', tagIds: ['#home', '#synced'] });
        // The first preparation met the sync (STALE_REVISION); the edit was read and prepared again.
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('writes each field as a target state: status, type, scope, area, a tag, a date', async () => {
        const { host, stored } = await open();
        const run = (n: number, edit: Record<string, unknown>) => host.runProjectEdit({ requestId: uuid(n), projectId: 'p', ...edit } as never);
        expect(await run(3, { kind: 'status', status: 'waiting' })).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await run(4, { kind: 'type', sequential: true })).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await run(4, { kind: 'type', sequential: true })).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(await run(5, { kind: 'scope', scope: 'section' })).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await run(6, { kind: 'area', areaId: 'a' })).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await run(7, { kind: 'tag', tag: 'work', present: true })).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await run(7, { kind: 'tag', tag: 'work', present: true })).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(await run(8, { kind: 'tag', tag: '#home', present: false })).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await run(8, { kind: 'tag', tag: '#home', present: false })).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(await run(9, { kind: 'date', field: 'dueDate', value: '2026-10-20', opened: null })).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        // A review day picked on Android: core makes the instant, at the hour and minute the picker opened on.
        expect(await run(16, { kind: 'date', field: 'reviewAt', value: '2026-11-20', opened: '2026-10-04T21:23:37.456Z' }))
            .toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(stored().reviewAt).toMatch(/^2026-11-20T\d{2}:23:00\.000Z$/);
        expect(stored()).toMatchObject({ status: 'waiting', isSequential: true, sequentialScope: 'section', areaId: 'a',
            tagIds: ['#work'], dueDate: '2026-10-20' });
    });

    it('creates a section under its request UUID once, and moves a section only from the order it was shown in', async () => {
        const { host, data } = await open({ sections: [section('s1', 0), section('s2', 1)] });
        const create = { requestId: uuid(10), projectId: 'p', kind: 'sectionCreate', title: 'Build' } as const;
        expect(await host.runProjectEdit(create)).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await host.runProjectEdit(create)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(data().sections.filter((row) => row.title === 'Build').map((row) => row.id)).toEqual([uuid(10)]);
        const move = { requestId: uuid(11), projectId: 'p', kind: 'sectionMove', sectionId: 's1', direction: 'down', order: ['s1', 's2', uuid(10)] } as const;
        expect(await host.runProjectEdit(move)).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(await host.runProjectEdit(move)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(await host.runProjectEdit({ ...move, requestId: uuid(12), order: ['s1', uuid(10), 's2'] }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('writes nothing to an archived project, and refuses a malformed edit', async () => {
        const { host, saves } = await open();
        const count = saves();
        expect(await host.runProjectEdit({ requestId: uuid(13), projectId: 'archived', kind: 'title', title: 'New' }))
            .toEqual({ ok: true, value: { id: 'archived', kind: 'title', outcome: 'blocked' } });
        expect(await host.runProjectEdit({ requestId: 'nope', projectId: 'p', kind: 'title', title: 'New' } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.runProjectEdit({ requestId: uuid(14), projectId: 'p', kind: 'colour', value: 1 } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(count);
    });

    it('owes a failed save, and its retry saves the edit', async () => {
        let failing = false;
        const { host, data } = await open({}, () => failing);
        failing = true;
        const edit = { requestId: uuid(15), projectId: 'p', kind: 'notes', text: 'Kept' } as const;
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: true });
        expect(data().projects.find((item) => item.id === 'p')?.supportNotes).toBe('Kept');
    });
});

// The project header's actions sheet (RN ProjectDetailModal's "..."): core's prepared lifecycle, duplicate and delete run inside
// the same journaled edit, each a target state on replay; Delete answers RN's toast words and its Undo restores the task links.
describe('runProjectEdit project actions', () => {
    const task = (id: string) => ({ id, title: id, status: 'next', projectId: 'p', tags: [], contexts: [], createdAt: at, updatedAt: at });

    it('completes, reactivates and cancels the project, and a replay writes nothing', async () => {
        const { host, stored, saves } = await open();
        const run = (n: number, action: string) => host.runProjectEdit({ requestId: uuid(n), projectId: 'p', kind: 'lifecycle', action } as never);
        expect(await run(20, 'complete')).toEqual({ ok: true, value: { id: 'p', kind: 'lifecycle', outcome: 'saved' } });
        expect(stored()).toMatchObject({ status: 'archived' });
        expect(stored().cancelledAt).toBeUndefined();
        const count = saves();
        expect(await run(20, 'complete')).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(saves()).toBe(count);
        expect(await run(21, 'reactivate')).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(stored()).toMatchObject({ status: 'active' });
        expect(await run(22, 'cancel')).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(stored()).toMatchObject({ status: 'archived' });
        expect(stored().cancelledAt).toEqual(expect.any(String));
        expect(await run(22, 'cancel')).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    });

    it('duplicates the project and answers the copy and RN\'s toast words', async () => {
        const { host, data } = await open();
        const reply = await host.runProjectEdit({ requestId: uuid(23), projectId: 'p', kind: 'duplicate' } as never);
        expect(reply).toMatchObject({ ok: true, value: { id: 'p', kind: 'duplicate', outcome: 'saved', reply: { id: expect.any(String), message: 'Project duplicated' } } });
        const copy = (reply as { value: { reply: { id: string } } }).value.reply.id;
        expect(copy).not.toBe('p');
        expect(data().projects.find((item) => item.id === copy)).toMatchObject({ title: expect.stringContaining('Kitchen') });
    });

    it('moves the project to Trash with RN\'s Undo, and the Undo restores it and its tasks\' links', async () => {
        const { host, stored, data } = await open({ tasks: [task('t1'), task('t2')] as never });
        const deleted = await host.runProjectEdit({ requestId: uuid(24), projectId: 'p', kind: 'delete' } as never);
        expect(deleted).toMatchObject({ ok: true, value: { kind: 'delete', outcome: 'saved',
            reply: { deletion: { message: expect.any(String), undoLabel: 'Undo' } } } });
        expect(stored().deletedAt).toEqual(expect.any(String));
        expect(data().tasks.filter((row) => row.projectId === 'p')).toHaveLength(0);
        expect(await host.runProjectEdit({ requestId: uuid(24), projectId: 'p', kind: 'delete' } as never))
            .toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        const undo = { requestId: uuid(25), projectId: 'p', kind: 'deleteUndo', deleteRequestId: uuid(24) } as never;
        expect(await host.runProjectEdit(undo)).toMatchObject({ ok: true, value: { kind: 'deleteUndo', outcome: 'saved' } });
        expect(stored().deletedAt).toBeUndefined();
        expect(data().tasks.filter((row) => row.projectId === 'p').map((row) => row.id).sort()).toEqual(['t1', 't2']);
        expect(await host.runProjectEdit(undo)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    });
});

// RN's Convert to section… (ProjectToSectionModal): core's eligibility for the sheet row, the destinations and the preview words,
// then the conversion inside the journaled edit (the request UUID names the new section, so a replay finds it) and its Undo.
describe('project to section', () => {
    const task = { id: 't1', title: 'Wash', status: 'next', projectId: 'p', tags: [], contexts: [], createdAt: at, updatedAt: at };
    const projects = [project('p', { tagIds: [] }), project('d', { tagIds: [], title: 'Home' }), project('archived', { status: 'archived' })];

    it('answers the sheet row, the destinations and the preview in the app language', async () => {
        const { host } = await open({ projects, tasks: [task] as never });
        const none = host.getProjectToSectionOptions({ projectId: 'p', destinationId: null, title: 'Kitchen' });
        expect(none).toMatchObject({ ok: true, value: { row: { label: 'Convert to section…', eligible: true, blocked: null },
            destinations: [{ id: 'd', title: 'Home' }], preview: null, blocked: null } });
        const picked = host.getProjectToSectionOptions({ projectId: 'p', destinationId: 'd', title: ' Kitchen ' });
        expect(picked).toMatchObject({ ok: true, value: { blocked: null, preview: { named: 'New section: Kitchen',
            lines: expect.arrayContaining(['Move 1 tasks (0 done, 0 archived) from Kitchen into Home.', 'The source project moves to Trash. Already-deleted tasks stay in Trash.']) } } });
        const { host: tagged } = await open({ projects: [project('p'), project('d')] });
        expect(tagged.getProjectToSectionOptions({ projectId: 'p', destinationId: null, title: 'Kitchen' }))
            .toMatchObject({ ok: true, value: { row: { eligible: false, blocked: 'Remove this project’s tags first.' }, destinations: [] } });
    });

    it('converts once, with RN\'s Undo toast, and the Undo puts the project and its task back', async () => {
        const { host, data } = await open({ projects, tasks: [task] as never });
        const shown = host.getProjectToSectionOptions({ projectId: 'p', destinationId: 'd', title: ' Kitchen ' }) as { value: { preview: { token: string } } };
        const convert = { requestId: uuid(30), projectId: 'p', kind: 'toSection', destinationProjectId: 'd', title: ' Kitchen ', expected: shown.value.preview.token } as never;
        expect(await host.runProjectEdit(convert)).toMatchObject({ ok: true, value: { kind: 'toSection', outcome: 'saved',
            reply: { destinationProjectId: 'd', message: 'Project converted to section.', undoLabel: 'Undo' } } });
        expect(data().projects.find((row) => row.id === 'p')?.deletedAt).toEqual(expect.any(String));
        expect(data().sections.find((row) => row.id === uuid(30))).toMatchObject({ projectId: 'd', title: 'Kitchen' });
        expect(data().tasks.find((row) => row.id === 't1')).toMatchObject({ projectId: 'd', sectionId: uuid(30) });
        expect(await host.runProjectEdit(convert)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        const undo = { requestId: uuid(31), projectId: 'p', kind: 'toSectionUndo', convertRequestId: uuid(30) } as never;
        expect(await host.runProjectEdit(undo)).toMatchObject({ ok: true, value: { kind: 'toSectionUndo', outcome: 'saved' } });
        expect(data().projects.find((row) => row.id === 'p')?.deletedAt).toBeUndefined();
        expect(data().tasks.find((row) => row.id === 't1')?.projectId).toBe('p');
        expect(await host.runProjectEdit(undo)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    });
});

// Review of b1+b2: retries and replays end as RN's first try did, and an Undo that cannot apply refuses and writes nothing.
describe('project actions: retries, replays and refused Undos', () => {
    const task = (id: string) => ({ id, title: id, status: 'next', projectId: 'p', tags: [], contexts: [], createdAt: at, updatedAt: at });
    const restart = async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        return host;
    };
    const copies = (data: AppData) => data.projects.filter((row) => row.title === 'Kitchen (Copy)');

    it('a Duplicate retried after its save failed answers its copy and toast once; a replay after a restart writes no second copy', async () => {
        let failing = false;
        const { host, data } = await open({}, () => failing);
        const edit = { requestId: uuid(40), projectId: 'p', kind: 'duplicate' } as never;
        failing = true;
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        const retried = await host.runProjectEdit(edit);
        expect(retried).toMatchObject({ ok: true, value: { reply: { id: expect.any(String), message: 'Project duplicated' } } });
        expect(copies(data())).toHaveLength(1);
        const replayed = await (await restart()).runProjectEdit(edit);
        expect(replayed).toMatchObject({ ok: true, value: { outcome: 'unchanged', reply: { id: (retried as { value: { reply: { id: string } } }).value.reply.id } } });
        await flushPendingSave();
        expect(copies(data())).toHaveLength(1);
    });

    it('a Delete retried after its save failed answers RN\'s toast again, and its Undo still restores it', async () => {
        let failing = false;
        const { host, stored } = await open({ tasks: [task('t1')] as never }, () => failing);
        const edit = { requestId: uuid(41), projectId: 'p', kind: 'delete' } as never;
        failing = true;
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: true, value: { reply: { deletion: { undoLabel: 'Undo' } } } });
        expect(await host.runProjectEdit({ requestId: uuid(42), projectId: 'p', kind: 'deleteUndo', deleteRequestId: uuid(41) } as never))
            .toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(stored().deletedAt).toBeUndefined();
    });

    it('refuses an Undo after a restart (its Delete is gone) and writes nothing', async () => {
        const { host, saves } = await open({ tasks: [task('t1')] as never });
        expect(await host.runProjectEdit({ requestId: uuid(43), projectId: 'p', kind: 'delete' } as never)).toMatchObject({ ok: true });
        const restarted = await restart();
        const count = saves();
        expect(await restarted.runProjectEdit({ requestId: uuid(44), projectId: 'p', kind: 'deleteUndo', deleteRequestId: uuid(43) } as never))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('refuses an Undo after a sync changed the deleted project, and writes nothing', async () => {
        const { host, saves, stored } = await open({ tasks: [task('t1')] as never });
        expect(await host.runProjectEdit({ requestId: uuid(45), projectId: 'p', kind: 'delete' } as never)).toMatchObject({ ok: true });
        // A sync lands a newer row for the deleted project.
        const synced = { ...useTaskStore.getState()._projectsById.get('p')!, title: 'Synced', rev: 99, updatedAt: '2026-10-02T00:00:00.000Z' };
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'p' ? synced : row),
            _projectsById: new Map(state._projectsById).set('p', synced) }) as never);
        const count = saves();
        expect(await host.runProjectEdit({ requestId: uuid(46), projectId: 'p', kind: 'deleteUndo', deleteRequestId: uuid(45) } as never))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
        expect(useTaskStore.getState()._projectsById.get('p')?.deletedAt).toEqual(expect.any(String));
        expect(stored()).toBeDefined();
    });

    it('converts only what the preview showed: a task added since refuses with RN\'s message and writes nothing', async () => {
        const projects = [project('p', { tagIds: [] }), project('d', { tagIds: [], title: 'Home' })];
        const { host, saves } = await open({ projects, tasks: [task('t1')] as never });
        const shown = host.getProjectToSectionOptions({ projectId: 'p', destinationId: 'd', title: 'Kitchen' });
        const expected = (shown as { value: { preview: { token: string } } }).value.preview.token;
        expect(expected).toEqual(expect.any(String));
        await useTaskStore.getState().addTask('Synced task', { projectId: 'p', status: 'next' });
        const count = saves();
        expect(await host.runProjectEdit({ requestId: uuid(47), projectId: 'p', kind: 'toSection', destinationProjectId: 'd', title: 'Kitchen', expected } as never))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION', message: expect.stringContaining('The project changed. Review the conversion again.') } });
        expect(saves()).toBe(count);
    });
});

// RN's view options Sort (ProjectDetailModal's sort modal): the project's task sort, core's choices, saved as a target state.
describe('runProjectEdit sort', () => {
    it('stores the chosen sort once, a replay writes nothing, and a filed project refuses it', async () => {
        const { host, stored, saves } = await open();
        const options = host.getProjectTaskSortOptions({ projectId: 'p' });
        expect(options).toMatchObject({ ok: true, value: { canEdit: true, choices: expect.arrayContaining([expect.objectContaining({ id: 'default', selected: true })]) } });
        const edit = { requestId: uuid(60), projectId: 'p', kind: 'sort', sortBy: 'title' } as never;
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: true, value: { kind: 'sort', outcome: 'saved' } });
        expect(stored().taskSortBy).toBe('title');
        const count = saves();
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(saves()).toBe(count);
        expect(await host.runProjectEdit({ requestId: uuid(61), projectId: 'archived', kind: 'sort', sortBy: 'title' } as never))
            .toMatchObject({ ok: true, value: { outcome: 'blocked' } });
        expect(await host.runProjectEdit({ requestId: uuid(62), projectId: 'p', kind: 'sort', sortBy: 'nonsense' } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});

// RN's view options Reorder (ProjectTaskList's reorder mode): one task moved after another row (or to the top) on the order the
// reorder view showed; a replay of a move already in place answers unchanged, and any other change since refuses.
describe('runProjectEdit task order', () => {
    const task = (id: string, order: number) => ({ id, title: id, status: 'next', projectId: 'p', order, orderNum: order, tags: [], contexts: [], createdAt: at, updatedAt: at });

    it('moves a task to the top once, a replay writes nothing, and a stale order refuses', async () => {
        const { host, data, saves } = await open({ tasks: [task('t1', 0), task('t2', 1), task('t3', 2)] as never });
        const view = host.getProjectTaskOrderView({ projectId: 'p', offset: 0, limit: 50, showCompleted: false, filters: {} });
        expect(view).toMatchObject({ ok: true, value: { canReorder: true, orderToken: expect.any(String) } });
        const expectedOrder = (view as { value: { orderToken: string } }).value.orderToken;
        const move = { requestId: uuid(70), projectId: 'p', kind: 'taskOrder', taskId: 't3', after: null, showCompleted: false, filters: {}, expectedOrder } as never;
        expect(await host.runProjectEdit(move)).toMatchObject({ ok: true, value: { kind: 'taskOrder', outcome: 'saved' } });
        const order = () => data().tasks.filter((row) => row.projectId === 'p').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((row) => row.id);
        expect(order()).toEqual(['t3', 't1', 't2']);
        const count = saves();
        expect(await host.runProjectEdit(move)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(saves()).toBe(count);
        const stale = { requestId: uuid(71), projectId: 'p', kind: 'taskOrder', taskId: 't1', after: { type: 'task', id: 't2' }, showCompleted: false, filters: {}, expectedOrder } as never;
        expect(await host.runProjectEdit(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(order()).toEqual(['t3', 't1', 't2']);
    });

    it('moves a task in a project whose order token passes 100,000 characters, as the view offers reorder up to its byte cap', async () => {
        const archived = Array.from({ length: 1_600 }, (_, i) => ({ ...task(`archived-${i}`, 10 + i), status: 'archived' }));
        const { host, data } = await open({ tasks: [task('t1', 0), task('t2', 1), task('t3', 2), ...archived] as never });
        const view = host.getProjectTaskOrderView({ projectId: 'p', offset: 0, limit: 50, showCompleted: false, filters: {} });
        expect(view).toMatchObject({ ok: true, value: { canReorder: true } });
        const expectedOrder = (view as { value: { orderToken: string } }).value.orderToken;
        expect(expectedOrder.length).toBeGreaterThan(100_000);
        const move = { requestId: uuid(72), projectId: 'p', kind: 'taskOrder', taskId: 't3', after: null, showCompleted: false, filters: {}, expectedOrder } as never;
        expect(await host.runProjectEdit(move)).toMatchObject({ ok: true, value: { kind: 'taskOrder', outcome: 'saved' } });
        const live = data().tasks.filter((row) => row.projectId === 'p' && row.status === 'next').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        expect(live.map((row) => row.id)).toEqual(['t3', 't1', 't2']);
    });
});

// RN's Flow Mode picker (#1429, d25316cf9): Parallel, Sequential or Per section, each a target state; and the section manager's
// Parallel/Sequential button while the project is Per section. Native's old two-way toggle turned Per section into Sequential.
describe('runProjectEdit flow mode (#1429)', () => {
    const perSection = { isSequential: false, perSectionFlow: true };
    const flowRead = (host: Awaited<ReturnType<typeof open>>['host']) =>
        (host.getProjectFlowOptions({ projectId: 'p', flowMode: true } as never) as { value: { flowMode: string } }).value.flowMode;

    it('reads a Per section project as Per section for Android\'s Flow Mode', async () => {
        const { host } = await open({ projects: [project('p', perSection)] });
        expect(flowRead(host)).toBe('perSection');
    });

    // RN's planProjectFlowModeChange through runProjectEdit: entering Per section stores a choice for each section without one.
    it('gives undecided sections their current flow on entering Per section and keeps a stored choice (review N5)', async () => {
        const choice = (id: string, order: number, isSequential: boolean) => ({ ...section(id, order), isSequential });
        const fromParallel = await open({ sections: [section('s1', 0), choice('kept', 1, true)] });
        expect(await fromParallel.host.runProjectEdit({ requestId: uuid(76), projectId: 'p', kind: 'flowMode', mode: 'perSection' } as never))
            .toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(fromParallel.data().sections.map((row) => [row.id, row.isSequential])).toEqual([['s1', false], ['kept', true]]);
        const fromWithin = await open({ projects: [project('p', { isSequential: true, sequentialScope: 'section' })], sections: [section('s1', 0), choice('kept', 1, false)] });
        expect(await fromWithin.host.runProjectEdit({ requestId: uuid(77), projectId: 'p', kind: 'flowMode', mode: 'perSection' } as never))
            .toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(fromWithin.data().sections.map((row) => [row.id, row.isSequential])).toEqual([['s1', true], ['kept', false]]);
    });

    it('stores exactly the mode picked, each once, and a replay writes nothing', async () => {
        const { host, stored, saves } = await open({ projects: [project('p', perSection)], sections: [section('s1', 0)] });
        const run = (n: number, mode: string) => host.runProjectEdit({ requestId: uuid(n), projectId: 'p', kind: 'flowMode', mode } as never);
        expect(await run(80, 'perSection')).toEqual({ ok: true, value: { id: 'p', kind: 'flowMode', outcome: 'unchanged' } });
        expect(await run(81, 'sequential')).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(stored()).toMatchObject({ isSequential: true, perSectionFlow: false });
        expect(flowRead(host)).toBe('sequential');
        expect(await run(82, 'parallel')).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(stored()).toMatchObject({ isSequential: false, perSectionFlow: false });
        expect(flowRead(host)).toBe('parallel');
        expect(await run(83, 'perSection')).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(stored()).toMatchObject(perSection);
        expect(flowRead(host)).toBe('perSection');
        const count = saves();
        expect(await run(83, 'perSection')).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(saves()).toBe(count);
    });

    it('refuses a mode for an archived project', async () => {
        const { host } = await open();
        expect(await host.runProjectEdit({ requestId: uuid(84), projectId: 'archived', kind: 'flowMode', mode: 'perSection' } as never))
            .toEqual({ ok: true, value: { id: 'archived', kind: 'flowMode', outcome: 'blocked' } });
    });

    it('refuses a section\'s flow in an archived Per section project and writes nothing (review N5)', async () => {
        const { host, data, saves } = await open({ projects: [project('p', { ...perSection, status: 'archived' })], sections: [section('s1', 0)] });
        const count = saves();
        const reply = await host.runProjectEdit({ requestId: uuid(89), projectId: 'p', kind: 'sectionFlow', sectionId: 's1', sequential: true } as never);
        expect(reply).toMatchObject({ ok: true, value: { outcome: 'blocked' } });
        expect(data().sections[0].isSequential).toBeUndefined();
        expect(saves()).toBe(count);
    });

    it('stores a section\'s Parallel or Sequential choice in a Per section project, and shows it on the manager rows', async () => {
        const { host, data } = await open({ projects: [project('p', perSection)], sections: [section('s1', 0), section('s2', 1)] });
        const rows = () => (host.getProjectSectionOrderOptions({ projectId: 'p', sectionFlow: true } as never) as { value: { sections: Array<{ id: string; sequential: boolean | null }> } })
            .value.sections.map(({ id, sequential }) => ({ id, sequential }));
        expect(rows()).toEqual([{ id: 's1', sequential: false }, { id: 's2', sequential: false }]);
        const edit = { requestId: uuid(86), projectId: 'p', kind: 'sectionFlow', sectionId: 's1', sequential: true } as never;
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: true, value: { kind: 'sectionFlow', outcome: 'saved' } });
        expect(data().sections.find((row) => row.id === 's1')?.isSequential).toBe(true);
        expect(data().sections.find((row) => row.id === 's2')?.isSequential).toBeUndefined();
        expect(rows()).toEqual([{ id: 's1', sequential: true }, { id: 's2', sequential: false }]);
        expect(await host.runProjectEdit(edit)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(await host.runProjectEdit({ requestId: uuid(87), projectId: 'p', kind: 'sectionFlow', sectionId: 's1', sequential: false } as never))
            .toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(data().sections.find((row) => row.id === 's1')?.isSequential).toBe(false);
    });

    it('offers no section choice and writes none while the project is not Per section', async () => {
        const { host, data } = await open({ sections: [section('s1', 0)] });
        expect((host.getProjectSectionOrderOptions({ projectId: 'p', sectionFlow: true } as never) as { value: { sections: Array<{ sequential: unknown }> } }).value.sections[0].sequential).toBeNull();
        expect(await host.runProjectEdit({ requestId: uuid(88), projectId: 'p', kind: 'sectionFlow', sectionId: 's1', sequential: true } as never))
            .toMatchObject({ ok: true, value: { outcome: 'blocked' } });
        expect(data().sections[0].isSequential).toBeUndefined();
    });
});

// iOS reads these two options with exact key counts (CoreModel.swift: Project flow options, section order rows). Android's extra
// fields ride only on the flag its Menu reads pass (host-entry MENU_READS); the iOS-read shapes stay byte-identical.
describe('iOS-read shapes stay exact (review B1, B2)', () => {
    it('keeps getProjectFlowOptions at revision, project and canChange unless Android asks for flowMode', async () => {
        const { host } = await open({ projects: [project('p', { isSequential: false, perSectionFlow: true })], sections: [section('s1', 0)] });
        const ios = host.getProjectFlowOptions({ projectId: 'p' }) as { ok: true; value: Record<string, unknown> };
        expect(Object.keys(ios.value).sort()).toEqual(['canChange', 'project', 'revision']);
        expect(Object.keys(ios.value.project as object).sort()).toEqual(['id', 'isSequential', 'rev', 'revBy', 'sequentialScope', 'status', 'title', 'updatedAt']);
        const android = host.getProjectFlowOptions({ projectId: 'p', flowMode: true } as never) as { ok: true; value: Record<string, unknown> };
        expect(android.value).toEqual({ ...ios.value, flowMode: 'perSection' });
    });

    it('keeps each section order row at id, title, canMoveUp and canMoveDown unless Android asks for the section flow', async () => {
        const { host } = await open({ projects: [project('p', { isSequential: false, perSectionFlow: true })], sections: [section('s1', 0), section('s2', 1)] });
        const ios = host.getProjectSectionOrderOptions({ projectId: 'p' }) as { ok: true; value: Record<string, unknown> & { sections: object[] } };
        expect(Object.keys(ios.value).sort()).toEqual(['canReorder', 'project', 'revision', 'sections', 'token']);
        for (const row of ios.value.sections) expect(Object.keys(row).sort()).toEqual(['canMoveDown', 'canMoveUp', 'id', 'title']);
        const android = host.getProjectSectionOrderOptions({ projectId: 'p', sectionFlow: true } as never) as typeof ios;
        expect(android.value.sections.map((row) => (row as { sequential: unknown }).sequential)).toEqual([false, false]);
    });
});
