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
