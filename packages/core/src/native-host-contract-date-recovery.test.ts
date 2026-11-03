import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeTaskDraftEdit } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { TaskDraft } from './task-draft';
import type { AppData, Task } from './types';
import type { NativePreparedTaskDraftSave, NativeTaskDraftSaveRequest } from './native-host-contract-task-save';

const NOW = '2026-09-27T12:00:00.000Z';
const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const task = (extra: Partial<Task> = {}): Task => ({
    id: 'edit', title: 'Date recovery', status: 'next', contexts: ['@office'], tags: ['#launch'],
    description: 'Keep these notes', priority: 'urgent', energyLevel: 'high', timeEstimate: '30min',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', rev: 7,
    ...extra,
});


describe('native date draft recovery', () => {
    const originalTZ = process.env.TZ;
    let durable: AppData;
    let saveData: ReturnType<typeof vi.fn>;
    const stored = () => useTaskStore.getState()._tasksById.get('edit')!;
    const saved = () => json(durable.tasks.find(({ id }) => id === 'edit')!);
    const persist = async (data: AppData) => { durable = structuredClone(data); };

    const open = async (timezone = 'America/New_York') => {
        process.env.TZ = timezone;
        resetForTests();
        useTaskStore.setState({
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
        });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true, recoveryLoad: true })).toMatchObject({ ok: true });
        await flushPendingSave();
        saveData.mockClear();
        return host;
    };
    const seed = async (extra: Partial<Task>, settings: AppData['settings'] = {}) => {
        durable = { tasks: [task(extra)], projects: [], sections: [], areas: [], people: [],
            settings: { deviceId: 'native-date-recovery-test', ...settings } };
        return open();
    };
    const draft = (host: ReturnType<typeof createNativeHostContract>) => {
        const result = host.getTaskEditorModel({ id: 'edit' });
        if (!result.ok) throw new Error(result.error.message);
        return json(result.value.draft);
    };
    const edit = (host: ReturnType<typeof createNativeHostContract>, value: TaskDraft, action: NativeTaskDraftEdit) => {
        const result = host.editTaskDraft({ id: 'edit', draft: value, edit: action });
        if (!result.ok) throw new Error(result.error.message);
        return json(result.value.draft);
    };
    const prepare = (host: ReturnType<typeof createNativeHostContract>, input: Omit<NativeTaskDraftSaveRequest, 'scheduleBase'>) => {
        const model = host.getTaskEditorModel({ id: 'edit' });
        if (!model.ok) throw new Error(model.error.message);
        const result = host.prepareTaskDraftSave({ ...input, scheduleBase: json(model.value.scheduleBase) });
        if (!result.ok) throw new Error(result.error.message);
        return json(result.value);
    };
    const commit = (host: ReturnType<typeof createNativeHostContract>, prepared: NativePreparedTaskDraftSave) =>
        host.commitPreparedTaskDraftSave({ request: prepared.request, prepared });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        saveData = vi.fn(persist);
        setStorageAdapter({ getData: async () => structuredClone(durable), saveData });
    });
    afterEach(async () => {
        saveData.mockImplementation(persist);
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (originalTZ === undefined) delete process.env.TZ;
        else process.env.TZ = originalTZ;
    });

    it('acknowledges a committed ISO pickTime request after timezone restart without writing again', async () => {
        const host = await seed({ dueDate: '2026-10-05' });
        const base = draft(host);
        const picked = edit(host, base, { type: 'pickTime', field: 'dueDate', time: '11:00' });
        expect(picked.dueDate).toBe('2026-10-05T15:00:00.000Z');
        const input = { id: 'edit', base: { dueDate: base.dueDate }, patch: { dueDate: picked.dueDate } };
        const prepared = prepare(host, input);
        expect(await commit(host, prepared)).toMatchObject({ ok: true });
        const committed = saved();
        expect(committed).toMatchObject({ dueDate: picked.dueDate, rev: 8 });
        expect(saveData).toHaveBeenCalledTimes(1);

        const restarted = await open('America/Los_Angeles');
        const before = stored();
        expect.soft(await commit(restarted, prepared)).toMatchObject({ ok: true });
        expect(stored()).toBe(before);
        expect(json(stored())).toEqual(committed);
        expect(saved()).toEqual(committed);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('replays an uncommitted ISO edit over its unchanged ISO baseline after timezone restart', async () => {
        const host = await seed({ dueDate: '2026-10-05T15:00:00.000Z' });
        const original = saved();
        const base = draft(host);
        expect(base.dueDate).toBe('2026-10-05T11:00');
        const picked = edit(host, base, { type: 'pickTime', field: 'dueDate', time: '12:00' });
        expect(picked.dueDate).toBe('2026-10-05T16:00:00.000Z');
        const input = { id: 'edit', base: { dueDate: base.dueDate }, patch: { dueDate: picked.dueDate } };
        const prepared = prepare(host, input);
        saveData.mockRejectedValue(new Error('synthetic precommit failure'));
        expect(await commit(host, prepared)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const intended = json(stored());
        expect(intended).toMatchObject({ dueDate: picked.dueDate, rev: 8 });
        expect(saved()).toEqual(original);

        saveData.mockImplementation(persist);
        const restarted = await open('America/Los_Angeles');
        expect(json(stored())).toEqual(original);
        expect.soft(await commit(restarted, prepared)).toMatchObject({ ok: true });
        expect.soft(json(stored())).toEqual(intended);
        expect.soft(saved()).toEqual(intended);
        expect.soft(saveData).toHaveBeenCalledTimes(1);
    });

    it('does not acknowledge an uncommitted floating patch merely because it equals the new projection of stored ISO', async () => {
        const host = await seed({ dueDate: '2026-10-05T15:00:00.000Z' }, { gtd: { defaultScheduleTime: '08:00' } });
        const original = saved();
        const base = draft(host);
        const dateOnly = edit(host, base, { type: 'date', field: 'dueDate', value: '2026-10-05' });
        const picked = edit(host, dateOnly, { type: 'pickDate', field: 'dueDate', date: '2026-10-05' });
        expect(picked.dueDate).toBe('2026-10-05T08:00');
        const input = { id: 'edit', base: { dueDate: base.dueDate }, patch: { dueDate: picked.dueDate } };
        const prepared = prepare(host, input);
        saveData.mockRejectedValue(new Error('synthetic precommit failure'));
        expect(await commit(host, prepared)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const intended = json(stored());
        expect(intended).toMatchObject({ dueDate: '2026-10-05T08:00', rev: 8 });
        expect(saved()).toEqual(original);

        saveData.mockImplementation(persist);
        const restarted = await open('America/Los_Angeles');
        expect(draft(restarted).dueDate).toBe(picked.dueDate);
        expect(json(stored())).toEqual(original);
        expect.soft(await commit(restarted, prepared)).toMatchObject({ ok: true });
        expect.soft(json(stored())).toEqual(intended);
        expect.soft(saved()).toEqual(intended);
        expect.soft(saveData).toHaveBeenCalledTimes(1);
    });

    it.each(['dueDate', 'startTime'] as const)('refuses a partial %s edit that would change a concurrently modified relative schedule', async (field) => {
        const host = await seed({ dueDate: '2026-10-10', startTime: '2026-10-09',
            ...(field === 'dueDate' ? { relativeStartOffset: { amount: -1, unit: 'day' } as const } : {}) });
        const base = draft(host);
        const picked = edit(host, base, { type: 'date', field, value: field === 'dueDate' ? '2026-10-12' : '2026-10-08' });
        const input = { id: 'edit', base: { [field]: base[field] }, patch: { [field]: picked[field] } };
        const prepared = prepare(host, input);
        expect((await useTaskStore.getState().updateTask('edit', {
            relativeStartOffset: { amount: field === 'dueDate' ? -3 : -1, unit: 'day' },
        })).success).toBe(true);
        await flushPendingSave();
        const concurrent = saved();
        expect(concurrent).toMatchObject({ rev: 8, relativeStartOffset: { amount: field === 'dueDate' ? -3 : -1, unit: 'day' } });
        const restarted = await open();
        const before = stored();

        expect.soft(await commit(restarted, prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect.soft(stored()).toBe(before);
        expect.soft(json(stored())).toEqual(concurrent);
        expect.soft(saved()).toEqual(concurrent);
        expect.soft(saveData).not.toHaveBeenCalled();
    });

    it('refuses a genuine relative-offset conflict without a write when the full original schedule is supplied', async () => {
        const offset = { amount: -1, unit: 'day' } as const;
        const host = await seed({ dueDate: '2026-10-10', startTime: '2026-10-09', relativeStartOffset: offset });
        const input = { id: 'edit',
            base: { dueDate: '2026-10-10', startTime: '2026-10-09', relativeStartOffset: offset },
            patch: { dueDate: '2026-10-12', startTime: '2026-10-11', relativeStartOffset: offset },
        };
        const prepared = prepare(host, input);
        expect((await useTaskStore.getState().updateTask('edit', { relativeStartOffset: { amount: -3, unit: 'day' } })).success).toBe(true);
        await flushPendingSave();
        const concurrent = saved();
        expect(concurrent).toMatchObject({ dueDate: '2026-10-10', startTime: '2026-10-07', relativeStartOffset: { amount: -3, unit: 'day' }, rev: 8 });
        const restarted = await open();
        const before = stored();

        expect(await commit(restarted, prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(stored()).toBe(before);
        expect(json(stored())).toEqual(concurrent);
        expect(saved()).toEqual(concurrent);
        expect(saveData).not.toHaveBeenCalled();
    });
});
