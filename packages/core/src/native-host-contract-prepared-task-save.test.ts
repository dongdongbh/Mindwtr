import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import type { NativePreparedTaskDraftSave, NativeTaskDraftSaveRequest } from './native-host-contract-task-save';
import * as logger from './logger';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';

const NOW = '2026-09-27T12:00:00.000Z';
const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const task = (extra: Partial<Task> = {}): Task => ({ id: 'edit', title: 'Original', status: 'next', contexts: ['@office', '@office'], tags: ['#work'],
    description: 'Notes', priority: 'urgent', energyLevel: 'high', timeEstimate: '30min',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', rev: 7, ...extra });
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, title: id, status: 'active', color: '#94a3b8', order: 0,
    createdAt: NOW, updatedAt: NOW, ...extra });

describe('prepared native task draft save', () => {
    const originalTZ = process.env.TZ;
    let durable: AppData;
    let saveData: ReturnType<typeof vi.fn>;
    let host: ReturnType<typeof createNativeHostContract>;
    const stored = () => useTaskStore.getState()._tasksById.get('edit')!;
    const saved = () => json(durable.tasks.find(({ id }) => id === 'edit')!);
    const persist = async (data: AppData) => { durable = structuredClone(data); };
    const open = async (zone = 'America/New_York') => {
        process.env.TZ = zone;
        resetForTests();
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
        host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true, recoveryLoad: true })).toMatchObject({ ok: true });
        await flushPendingSave();
        saveData.mockClear();
    };
    const seed = async (extra: Partial<Task> = {}, projects: Project[] = []) => {
        durable = { tasks: [task(extra)], projects, sections: [], areas: [], people: [], settings: { deviceId: 'prepared-edit-test' } };
        await open();
    };
    const model = () => {
        const result = host.getTaskEditorModel({ id: 'edit' });
        if (!result.ok) throw new Error(result.error.message);
        return json(result.value);
    };
    const request = (patch: NativeTaskDraftSaveRequest['patch']): NativeTaskDraftSaveRequest => {
        const opening = model();
        return { id: 'edit', base: Object.fromEntries(Object.keys(patch).map((field) => [field, opening.draft[field as keyof typeof opening.draft] ?? null])),
            patch, scheduleBase: opening.scheduleBase };
    };
    const prepare = (patch: NativeTaskDraftSaveRequest['patch']) => {
        const result = host.prepareTaskDraftSave(request(patch));
        if (!result.ok) throw new Error(result.error.message);
        return json(result.value);
    };
    const commit = (prepared: NativePreparedTaskDraftSave) => host.commitPreparedTaskDraftSave({ request: prepared.request, prepared });
    const expectUnchanged = (before: Task, durableBefore: Task) => {
        expect(stored()).toBe(before);
        expect(saved()).toEqual(durableBefore);
        expect(saveData).not.toHaveBeenCalled();
    };

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        saveData = vi.fn(persist);
        setStorageAdapter({ getData: async () => structuredClone(durable), saveData });
        await seed();
    });
    afterEach(async () => {
        saveData.mockImplementation(persist);
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    });

    it('prepares a title-only v2 save from the durable row and replays its exact receipt', async () => {
        const input = request({ title: 'Changed' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { version: 2 } } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        const prepared = json(plan.value.prepared);
        expect(host.validatePreparedTaskDraftSave({ request: input, prepared })).toMatchObject({
            ok: true, value: { version: 2, result: { id: 'edit' } },
        });
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared })).toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ title: 'Changed', rev: 8, updatedAt: NOW });
        await open();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared })).toMatchObject({ ok: true });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('saves task reminder policy and advance reminders through v2 and keeps the sealed v1 grammar', async () => {
        await seed({ reminderPolicy: 'inherit', startTime: '2026-09-28T13:00:00.000Z', dueDate: '2026-09-28T14:00:00.000Z' });
        const patch = { reminderPolicy: 'skip', dueReminderLeadMinutes: 1440, startReminderLeadMinutes: 15 } as const;
        expect(host.prepareTaskDraftSave(request(patch))).toMatchObject({ ok: false });
        const input = request(patch);
        expect(input.base).toEqual({ reminderPolicy: 'inherit', dueReminderLeadMinutes: null, startReminderLeadMinutes: null });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        const prepared = json(plan.value.prepared);
        expect(host.validatePreparedTaskDraftSave({ request: input, prepared })).toMatchObject({ ok: true });
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared })).toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ reminderPolicy: 'skip', suppressMindwtrReminders: true,
            dueReminderLeadMinutes: 1440, startReminderLeadMinutes: 15, rev: 8 });
        await open();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared })).toMatchObject({ ok: true });
        expect(saveData).not.toHaveBeenCalled();

        const off = request({ dueReminderLeadMinutes: 0, startReminderLeadMinutes: 0 });
        const offPlan = await host.prepareTaskDraftSaveV2(off);
        expect(offPlan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!offPlan.ok || offPlan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: off, prepared: offPlan.value.prepared })).toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ dueReminderLeadMinutes: 0, startReminderLeadMinutes: 0 });
        for (const bad of [{ dueReminderLeadMinutes: 10_081 }, { startReminderLeadMinutes: 13 }, { reminderPolicy: 'never' }]) {
            expect(await host.prepareTaskDraftSaveV2(request(bad as NativeTaskDraftSaveRequest['patch']))).toMatchObject({ ok: false });
        }
    });

    it('uses shared Location trimming for set, clear, and whitespace-only no-op', async () => {
        const set = request({ location: '  Clinic A  ' });
        const setPlan = await host.prepareTaskDraftSaveV2(set);
        expect(setPlan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!setPlan.ok || setPlan.value.kind !== 'prepared') return;
        expect(setPlan.value.prepared.effect.task.after.location).toBe('Clinic A');
        expect(await host.commitPreparedTaskDraftSave({ request: set, prepared: setPlan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ location: 'Clinic A', rev: 8 });
        await open();
        expect(await host.commitPreparedTaskDraftSave({ request: set, prepared: setPlan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saveData).not.toHaveBeenCalled();

        const clear = request({ location: '' });
        const clearPlan = await host.prepareTaskDraftSaveV2(clear);
        expect(clearPlan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!clearPlan.ok || clearPlan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: clear, prepared: clearPlan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved().location).toBeUndefined();
        const before = saved();
        saveData.mockClear();
        expect(await host.prepareTaskDraftSaveV2(request({ location: '   ' })))
            .toMatchObject({ ok: true, value: { kind: 'noop', result: { id: 'edit' } } });
        expect(saved()).toEqual(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('uses shared Assigned To trimming, clearing, and unchanged no-op without a second writer', async () => {
        const set = request({ assignedTo: '  Alex Rivera  ' });
        const plan = await host.prepareTaskDraftSaveV2(set);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(plan.value.prepared.effect.task.after.assignedTo).toBe('Alex Rivera');
        expect(await host.commitPreparedTaskDraftSave({ request: set, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ assignedTo: 'Alex Rivera', rev: 8 });
        const unchanged = saved();
        saveData.mockClear();
        expect(await host.prepareTaskDraftSaveV2(request({ assignedTo: '  Alex Rivera  ' })))
            .toMatchObject({ ok: true, value: { kind: 'noop', result: { id: 'edit' } } });
        expect(saved()).toEqual(unchanged);
        expect(saveData).not.toHaveBeenCalled();

        const clear = request({ assignedTo: '' });
        const clearPlan = await host.prepareTaskDraftSaveV2(clear);
        expect(clearPlan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!clearPlan.ok || clearPlan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: clear, prepared: clearPlan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved().assignedTo).toBeUndefined();
        saveData.mockClear();
        expect(await host.prepareTaskDraftSaveV2(request({ assignedTo: '   ' })))
            .toMatchObject({ ok: true, value: { kind: 'noop', result: { id: 'edit' } } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('saves numeric Time Spent through v2, clears it with null, and treats zero as unset', async () => {
        const input = request({ timeSpentMinutes: 17 });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ timeSpentMinutes: 17, rev: 8 });
        const before = saved();
        saveData.mockClear();
        expect(await host.prepareTaskDraftSaveV2(request({ timeSpentMinutes: 17 })))
            .toMatchObject({ ok: true, value: { kind: 'noop' } });
        expect(saved()).toEqual(before);
        expect(saveData).not.toHaveBeenCalled();

        const clear = request({ timeSpentMinutes: null });
        const clearPlan = await host.prepareTaskDraftSaveV2(clear);
        expect(clearPlan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!clearPlan.ok || clearPlan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: clear, prepared: clearPlan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved().timeSpentMinutes).toBeUndefined();
        saveData.mockClear();
        expect(await host.prepareTaskDraftSaveV2(request({ timeSpentMinutes: 0 })))
            .toMatchObject({ ok: true, value: { kind: 'noop' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('keeps Time Spent out of legacy saves and refuses malformed numeric/null transport', async () => {
        const mixed = request({ dueDate: '2036-10-05', timeSpentMinutes: 17 });
        expect(host.prepareTaskDraftSave(mixed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const old = host.prepareTaskDraftSave(request({ dueDate: '2036-10-05' }));
        if (!old.ok) throw new Error(JSON.stringify(old));
        const forged = json(old.value);
        forged.request = mixed;
        expect(host.validatePreparedTaskDraftSave({ request: mixed, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const value of [true, '17', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const malformed = request({ timeSpentMinutes: value as never });
            expect(await host.prepareTaskDraftSaveV2(malformed))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const unmatched = request({ timeSpentMinutes: 17 });
        unmatched.base = {};
        expect(await host.prepareTaskDraftSaveV2(unmatched))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('preserves a long Unicode free-text assignment without widening the suggestions transport', async () => {
        const longName = `  ${'😀'.repeat(1001)}  `;
        expect(longName.length).toBe(2006);
        expect(host.getTaskEditorSuggestions({ id: 'edit', field: 'assignedTo', query: longName, limit: 4 }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const input = request({ assignedTo: longName });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved().assignedTo).toBe(longName.trim());
    });

    it('allows Assigned To on Reference in v2 while sealing mixed v1 and plain payloads', async () => {
        await seed({ status: 'reference' });
        const input = request({ assignedTo: '  Casey  ' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ status: 'reference', assignedTo: 'Casey' });

        await seed();
        const mixed = request({ assignedTo: 'Taylor', dueDate: '2036-10-05' });
        expect(host.prepareTaskDraftSave(mixed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const v2 = await host.prepareTaskDraftSaveV2(mixed);
        expect(v2).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const old = host.prepareTaskDraftSave(request({ dueDate: '2036-10-05' }));
        if (!old.ok) throw new Error(JSON.stringify(old));
        const forged = json(old.value);
        forged.request = mixed;
        expect(host.validatePreparedTaskDraftSave({ request: mixed, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('accepts a fresh sibling before Assigned To prepare but rejects a forged after value', async () => {
        const input = request({ assignedTo: 'Casey' });
        durable.tasks[0].description = 'Independent note';
        durable.tasks[0].rev = 8;
        durable.tasks[0].updatedAt = '2026-09-27T11:00:00.000Z';
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(plan.value.prepared.effect.task.before.description).toBe('Independent note');
        const forged = json(plan.value.prepared);
        forged.effect.task.after.assignedTo = 'Injected';
        expect(host.validatePreparedTaskDraftSave({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ description: 'Independent note', assignedTo: 'Casey', rev: 9 });
    });

    it('refuses an independent same-Task edit after Assigned To was frozen', async () => {
        const input = request({ assignedTo: 'Casey' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        durable.tasks[0].description = 'Other writer';
        durable.tasks[0].rev = 8;
        durable.tasks[0].updatedAt = '2026-09-27T11:00:00.000Z';
        const intervening = saved();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saved()).toEqual(intervening);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('allows shared Reference Location while retaining the exact legacy v1 prepared roster', async () => {
        await seed({ status: 'reference' });
        const input = request({ location: '  Archive shelf  ' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ status: 'reference', location: 'Archive shelf' });

        await seed();
        const mixed = request({ location: 'Clinic', dueDate: '2036-10-05' });
        expect(host.prepareTaskDraftSave(mixed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const v2 = await host.prepareTaskDraftSaveV2(mixed);
        expect(v2).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!v2.ok || v2.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: mixed, prepared: v2.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ location: 'Clinic', dueDate: '2036-10-05' });

        await seed();
        const old = host.prepareTaskDraftSave(request({ dueDate: '2036-10-05' }));
        if (!old.ok) throw new Error(JSON.stringify(old));
        const forged = json(old.value);
        forged.request = mixed;
        expect(host.validatePreparedTaskDraftSave({ request: mixed, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('incorporates a fresh sibling before Location preparation but rejects a forged frozen Location', async () => {
        const input = request({ location: 'Clinic' });
        durable.tasks[0].description = 'Independent note';
        durable.tasks[0].rev = 8;
        durable.tasks[0].updatedAt = '2026-09-27T11:00:00.000Z';
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(plan.value.prepared.effect.task.before.description).toBe('Independent note');
        const forged = json(plan.value.prepared);
        forged.effect.task.after.location = 'Injected';
        expect(host.validatePreparedTaskDraftSave({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ description: 'Independent note', location: 'Clinic', rev: 9 });
    });

    it('replays an exact Task receipt after an independent device ID change when the edit did not initialize it', async () => {
        const input = request({ title: 'Changed' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.deviceIdToInitialize).toBeNull();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        durable.settings.deviceId = 'independent-device';
        await open();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('refuses a cold exact Task receipt if this edit initialized a device ID that another writer replaced', async () => {
        delete durable.settings.deviceId;
        await open();
        const input = request({ title: 'Changed' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        expect(plan.value.prepared.deviceIdToInitialize).toEqual(expect.any(String));
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        durable.settings.deviceId = 'independent-device';
        await open();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('freezes a date edit in v2 without a second timezone projection on cold replay', async () => {
        const input = request({ dueDate: '2026-10-05T15:00:00.000Z' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { version: 2 } } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        const prepared = json(plan.value.prepared);
        await open('UTC');
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared })).toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ dueDate: '2026-10-05T15:00:00.000Z' });
    });

    it('accepts a projected legacy recurrence baseline while preserving the raw saved rule on a date save', async () => {
        await seed({ recurrence: 'daily', showFutureRecurrence: false });
        const opening = model();
        const patch = { recurrence: opening.draft.recurrence, recurrenceStrategy: opening.draft.recurrenceStrategy,
            recurrenceRRule: opening.draft.recurrenceRRule,
            showFutureRecurrence: opening.draft.showFutureRecurrence, dueDate: '2036-10-05' };
        const input = { id: 'edit', patch, base: { ...patch, dueDate: opening.draft.dueDate },
            scheduleBase: opening.scheduleBase, recurrenceBase: opening.recurrenceBase };
        const plan = await host.prepareTaskDraftSaveV2(input);
        if (!plan.ok) throw new Error(JSON.stringify({ plan, openingRecurrence: opening.recurrenceBase,
            raw: saved().recurrence, patch }));
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved().recurrence).toBe('daily');
        expect(saved().showFutureRecurrence).toBe(false);
        expect(saved().dueDate).toBe('2036-10-05');
    });

    it('clears show-future when removing recurrence even if its draft flag was unchanged', async () => {
        await seed({ recurrence: 'daily', showFutureRecurrence: true });
        const opening = model();
        const base = { recurrence: opening.draft.recurrence, recurrenceStrategy: opening.draft.recurrenceStrategy,
            recurrenceRRule: opening.draft.recurrenceRRule,
            showFutureRecurrence: opening.draft.showFutureRecurrence };
        const input = { id: 'edit', base, patch: { ...base, recurrence: '' },
            scheduleBase: opening.scheduleBase, recurrenceBase: opening.recurrenceBase };
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved().recurrence).toBeUndefined();
        expect(saved().showFutureRecurrence).toBeUndefined();
    });

    it.each([{ areaId: 'missing-area' }, { sectionId: 'missing-section', projectId: 'missing-project' }])('keeps a stale untouched container while editing title in v2: %j', async (legacy) => {
        await seed(legacy);
        const input = request({ title: 'Revised' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared })).toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ title: 'Revised', ...legacy });
    });

    it('lets a Reference task edit visible metadata and clear hidden values but refuses hidden writes', async () => {
        await seed({ status: 'reference', description: 'Old note' });
        const input = request({ title: 'Reference title', description: 'New note', priority: '',
            energyLevel: 'high', timeEstimate: '' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared })).toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ status: 'reference', title: 'Reference title', description: 'New note',
            energyLevel: 'high' });
        expect(saved().priority).toBeUndefined();
        expect(saved().timeEstimate).toBeUndefined();
        expect(await host.prepareTaskDraftSaveV2(request({ priority: 'urgent' })))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.prepareTaskDraftSaveV2(request({ timeEstimate: '45min' })))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.prepareTaskDraftSaveV2(request({ dueDate: '2026-10-05' })))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('refuses a forged title-only v2 plan that clears unrelated Focus metadata', async () => {
        await seed({ isFocusedToday: true, focusOrder: 9 });
        const input = request({ title: 'Changed' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = json(plan.value.prepared);
        prepared.effect.task.after.isFocusedToday = false;
        delete prepared.effect.task.after.focusOrder;
        expect(host.validatePreparedTaskDraftSave({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('refuses a forged project reservation in v2 before reading saved data', async () => {
        await seed({}, [project('project-a')]);
        const input = request({ projectId: 'project-a', areaId: '', sectionId: '' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = json(plan.value.prepared);
        prepared.effect.task.after.order = 999;
        prepared.effect.task.after.orderNum = 999;
        expect(host.validatePreparedTaskDraftSave({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('returns a true v2 no-op without any Task stamp or save', async () => {
        const before = saved();
        const input = request({ title: 'Original' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'noop', result: { id: 'edit' } } });
        expect(saved()).toEqual(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('clears priority and energy together through the shared scalar edit policy', async () => {
        await seed({ priority: 'urgent', energyLevel: 'high' });
        const input = request({ priority: '', energyLevel: '' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(saved().priority).toBeUndefined();
        expect(saved().energyLevel).toBeUndefined();
    });

    it('rejects malformed frozen v2 Task, stamp, and unrelated after fields before any save', async () => {
        const input = request({ title: 'Changed' });
        const plan = await host.prepareTaskDraftSaveV2(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = json(plan.value.prepared);
        const cases = [
            (item: typeof prepared) => { item.effect.task.after.rev = 500; },
            (item: typeof prepared) => { item.effect.task.after.updatedAt = '2025-01-01T00:00:00.000Z'; },
            (item: typeof prepared) => { item.effect.task.after.description = 'Injected'; },
            (item: typeof prepared) => { item.effect.task.before.tags = [7 as never]; },
            (item: typeof prepared) => { item.scope.nextProjectOrder = 9; },
        ];
        for (const mutate of cases) {
            const forged = json(prepared);
            mutate(forged);
            expect(host.validatePreparedTaskDraftSave({ request: input, prepared: forged }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: forged }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(saveData).not.toHaveBeenCalled();
    });

    it.each(['2026-10-05', '2026-10-05T08:00', '2026-10-05T15:00:00.000Z'])('prepares without writes and preserves the raw representation %s through restart and replay', async (dueDate) => {
        const before = stored();
        const durableBefore = saved();
        const input = request({ dueDate });
        const result = host.prepareTaskDraftSave(input);
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        const prepared = json(result.value);
        expect(prepared.request).toEqual(input);
        expect(prepared.changes.dueDate).toBe(dueDate);
        expectUnchanged(before, durableBefore);
        await open('America/Los_Angeles');
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expect(stored()).toMatchObject({ dueDate, rev: 8 });
        const committed = saved();
        expect(saveData).toHaveBeenCalledTimes(1);
        await open('UTC');
        const after = stored();
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expectUnchanged(after, committed);
    });

    it('keeps the legacy v1 date journal rule that clears an inconsistent Area under a Project', async () => {
        await seed({ projectId: 'project-a', areaId: 'legacy-area' }, [project('project-a')]);
        const input = request({ dueDate: '2026-10-05' });
        const plan = host.prepareTaskDraftSave(input);
        expect(plan).toMatchObject({ ok: true });
        if (!plan.ok) return;
        expect(plan.value.changes).toHaveProperty('areaId', null);
        await open();
        expect(await host.commitPreparedTaskDraftSave({ request: input, prepared: plan.value }))
            .toMatchObject({ ok: true });
        expect(saved().areaId).toBeUndefined();
    });

    it('returns a detached raw schedule baseline and preserves a no-op without writing', async () => {
        await seed({ dueDate: '2026-10-05T15:00:00.000Z', reviewAt: '2026-10-06', relativeStartOffset: { amount: -1, unit: 'day' }, startTime: '2026-10-04T15:00:00.000Z' });
        const opening = model();
        expect(opening.draft.dueDate).toBe('2026-10-05T11:00');
        expect(opening.scheduleBase).toEqual({ dueDate: '2026-10-05T15:00:00.000Z', startTime: '2026-10-04T15:00:00.000Z', reviewAt: '2026-10-06', relativeStartOffset: { amount: -1, unit: 'day' } });
        opening.scheduleBase.relativeStartOffset!.amount = -2;
        expect(stored().relativeStartOffset?.amount).toBe(-1);
        const before = stored();
        const durableBefore = saved();
        const prepared = prepare({ reviewAt: '2026-10-06' });
        expect(prepared.changes).toEqual({});
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expectUnchanged(before, durableBefore);
    });

    it.each(['day', 'week'] as const)('freezes a relative %s across New York DST before UTC commit', async (unit) => {
        const offset = { amount: -1, unit };
        await seed({ dueDate: '2026-10-31T14:00:00.000Z', startTime: unit === 'day' ? '2026-10-30T14:00:00.000Z' : '2026-10-24T14:00:00.000Z', relativeStartOffset: offset });
        const prepared = prepare({ dueDate: '2026-11-01T15:00:00.000Z' });
        const startTime = unit === 'day' ? '2026-10-31T14:00:00.000Z' : '2026-10-25T14:00:00.000Z';
        expect(prepared.changes.startTime).toBe(startTime);
        await open('UTC');
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expect(stored()).toMatchObject({ dueDate: '2026-11-01T15:00:00.000Z', startTime, relativeStartOffset: offset, rev: 8 });
        const committed = saved();
        await open('America/Los_Angeles');
        const before = stored();
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expectUnchanged(before, committed);
    });

    it('retains newer independent fields before application and after a lost acknowledgement', async () => {
        const prepared = prepare({ dueDate: '2026-10-05' });
        expect((await useTaskStore.getState().updateTask('edit', { title: 'Other title', description: 'Other notes', contexts: ['@new', '@new'], tags: ['#new'], priority: 'low' })).success).toBe(true);
        await flushPendingSave();
        expect(stored().rev).toBe(8);
        saveData.mockClear();
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expect(stored()).toMatchObject({ dueDate: '2026-10-05', title: 'Other title', description: 'Other notes', contexts: ['@new', '@new'], tags: ['#new'], priority: 'low', rev: 9 });
        expect(saveData).toHaveBeenCalledTimes(1);
        expect((await useTaskStore.getState().updateTask('edit', { description: 'Later notes' })).success).toBe(true);
        await flushPendingSave();
        const committed = saved();
        await open('UTC');
        const before = stored();
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expectUnchanged(before, committed);
    });

    it('finishes an uncertain save with a newer independent edit and emits a marker only after durability', async () => {
        const info = vi.spyOn(logger, 'logInfo');
        const prepared = prepare({ dueDate: '2026-10-05' });
        saveData.mockRejectedValue(new Error('synthetic disk failure'));
        expect(await commit(prepared)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(saved().rev).toBe(7);
        await useTaskStore.getState().updateTask('edit', { description: 'Notes during recovery' });
        await expect(flushPendingSave()).rejects.toThrow('synthetic disk failure');
        const applied = json(stored());
        expect(applied).toMatchObject({ dueDate: '2026-10-05', description: 'Notes during recovery', rev: 9 });
        expect(info).not.toHaveBeenCalledWith('Native prepared date save result', expect.anything());
        saveData.mockImplementation(persist);
        saveData.mockClear();
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expect(saved()).toEqual(applied);
        expect(json(stored())).toEqual(applied);
        expect(saveData).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledWith('Native prepared date save result', { scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.3/native-prepared-date-save', outcome: 'replayed' } });
    }, 15_000);

    it('refuses the original baseline after a concurrent schedule change and refuses a mixed before/after tuple at commit', async () => {
        await seed({ dueDate: '2026-10-10', startTime: '2026-10-09', relativeStartOffset: { amount: -1, unit: 'day' } });
        const input = request({ dueDate: '2026-10-12' });
        const prepared = prepare(input.patch);
        durable.tasks[0] = { ...durable.tasks[0], dueDate: '2026-10-12', rev: 8 };
        await open();
        const before = stored();
        const durableBefore = saved();
        expect(host.prepareTaskDraftSave(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await commit(prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expectUnchanged(before, durableBefore);
    });

    it('uses the opening base title for a blank title request during a date edit', async () => {
        const input = request({ dueDate: '2026-10-05', title: '   ' });
        await useTaskStore.getState().updateTask('edit', { title: 'Concurrent title' });
        await flushPendingSave();
        saveData.mockClear();
        const before = stored();
        const durableBefore = saved();
        expect(host.prepareTaskDraftSave(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expectUnchanged(before, durableBefore);
    });

    it('captures promotion and focus/order effects without replaying them', async () => {
        await seed({ status: 'inbox', isFocusedToday: true, focusOrder: 3, boardOrder: 4 });
        const prepared = prepare({ startTime: '2026-10-05' });
        expect(prepared.changes).toMatchObject({ status: 'next', startTime: '2026-10-05', focusOrder: null, boardOrder: null });
        expect(await commit(prepared)).toMatchObject({ ok: true });
        const committed = saved();
        await open('UTC');
        const before = stored();
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expectUnchanged(before, committed);
    });

    it('round-trips explicit clears and rejects a dropped dependent clear', async () => {
        await seed({ dueDate: '2026-10-05', startTime: '2026-10-04', relativeStartOffset: { amount: -1, unit: 'day' } });
        const prepared = prepare({ dueDate: '' });
        expect(prepared.changes).toMatchObject({ dueDate: null, relativeStartOffset: null });
        const broken = json(prepared);
        delete broken.changes.relativeStartOffset;
        const before = stored();
        const durableBefore = saved();
        expect(await commit(broken)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expectUnchanged(before, durableBefore);
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expect(stored().dueDate).toBeUndefined();
        expect(stored().relativeStartOffset).toBeUndefined();
        expect(stored().startTime).toBe('2026-10-04');
    });

    it('rejects a due-only journal that drops the derived start and clears the retained relative link', async () => {
        await seed({ dueDate: '2026-10-10', startTime: '2026-10-09', relativeStartOffset: { amount: -1, unit: 'day' } });
        const prepared = prepare({ dueDate: '2026-10-12' });
        expect(prepared.changes.startTime).toBe('2026-10-11');
        const broken = json(prepared);
        delete broken.changes.startTime;
        broken.changes.relativeStartOffset = null;
        const before = stored();
        const durableBefore = saved();
        expect(await commit(broken)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expectUnchanged(before, durableBefore);
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ dueDate: '2026-10-12', startTime: '2026-10-11', relativeStartOffset: { amount: -1, unit: 'day' }, rev: 8 });
    });

    it.each([
        ['version', (p: any) => { p.version = 2; }],
        ['extra envelope property', (p: any) => { p.after = p.before; }],
        ['caller guard mask', (p: any) => { p.guards = []; }],
        ['identity', (p: any) => { p.before.id = 'other'; }],
        ['missing identity guard', (p: any) => { delete p.before.createdAt; }],
        ['revision output', (p: any) => { p.changes.rev = 900; }],
        ['creation output', (p: any) => { p.changes.createdAt = NOW; }],
        ['unknown output', (p: any) => { p.changes.extra = true; }],
        ['unrequested notes', (p: any) => { p.changes.description = 'Smuggled'; }],
        ['different date output', (p: any) => { p.changes.dueDate = '2026-10-09'; }],
        ['dropped date output', (p: any) => { delete p.changes.dueDate; }],
        ['invalid metadata output', (p: any) => { p.changes.priority = 'extreme'; }],
        ['missing schedule baseline', (p: any) => { delete p.request.scheduleBase.startTime; }],
        ['undefined clear', (p: any) => { p.changes.dueDate = undefined; }],
        ['non-finite output', (p: any) => { p.changes.pushCount = Infinity; }],
    ])('refuses malformed prepared %s before writing', async (_name, mutate) => {
        const prepared = prepare({ dueDate: '2026-10-05', priority: 'low' });
        mutate(prepared);
        const before = stored();
        const durableBefore = saved();
        expect(await commit(prepared)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expectUnchanged(before, durableBefore);
    });

    it('binds the full request and rejects unsupported draft fields and incomplete associations', async () => {
        const prepared = prepare({ dueDate: '2026-10-05' });
        const other = { ...prepared.request, patch: { dueDate: '2026-10-06' } };
        expect(await host.commitPreparedTaskDraftSave({ request: other, prepared })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const patch of [{ dueDate: '2026-10-05', status: 'done' }, { dueDate: '2026-10-05', projectId: '' }, { title: 'Only title' }]) {
            expect(host.prepareTaskDraftSave(request(patch as never))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(saveData).not.toHaveBeenCalled();
    });

    it('keeps lifecycle fields exclusive to checklist saves in legacy and v2 draft routes', async () => {
        for (const patch of [
            { focusedToday: true },
            { completedAt: '2026-09-27T11:00:00.000Z' },
            { dueDate: '2026-10-05', focusedToday: true },
            { dueDate: '2026-10-05', completedAt: '' },
        ]) {
            const input = request(patch);
            expect(host.prepareTaskDraftSave(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await host.prepareTaskDraftSaveV2(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(saveData).not.toHaveBeenCalled();
    });

    it('guards changed independent fields, omitted dependencies, and new stored fields by default', async () => {
        await seed({ recurrence: { rule: 'weekly', strategy: 'strict' } });
        const prepared = prepare({ dueDate: '2026-10-05', title: 'Mine' });
        const omitted = json(prepared);
        delete omitted.before.recurrence;
        const before = stored();
        const durableBefore = saved();
        expect(await commit(omitted)).toMatchObject({ ok: false });
        expectUnchanged(before, durableBefore);
        await useTaskStore.getState().updateTask('edit', { title: 'Other title' });
        await flushPendingSave();
        saveData.mockClear();
        const concurrent = stored();
        const concurrentSaved = saved();
        expect(await commit(prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expectUnchanged(concurrent, concurrentSaved);
        const next = prepare({ dueDate: '2026-10-05' });
        durable.tasks[0] = { ...durable.tasks[0], futureSchedulePolicy: true } as Task;
        await open();
        const future = stored();
        const futureSaved = saved();
        expect(await commit(next)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expectUnchanged(future, futureSaved);
    });

    it('preserves untouched legacy fields and compares their persisted JSON representation', async () => {
        await seed({ priority: 'legacy-priority', legacyMetadata: { retained: 'value', absent: undefined },
            recurrence: { rule: 'weekly', strategy: 'strict', byDay: undefined } } as unknown as Partial<Task>);
        const prepared = prepare({ dueDate: '2026-10-05' });
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expect(saved()).toMatchObject({ priority: 'legacy-priority', legacyMetadata: { retained: 'value' },
            recurrence: { rule: 'weekly', strategy: 'strict' }, dueDate: '2026-10-05' });
    });

    it.each(['archived', 'deleted'] as const)('refuses an %s parent before fresh application but acknowledges its already-applied result', async (condition) => {
        await seed({ projectId: 'p' }, [project('p')]);
        const prepared = prepare({ dueDate: '2026-10-05' });
        const unavailable = project('p', condition === 'archived' ? { status: 'archived' } : { deletedAt: NOW });
        useTaskStore.setState({ _allProjects: [unavailable] });
        const before = stored();
        const durableBefore = saved();
        expect(host.prepareTaskDraftSave(prepared.request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await commit(prepared)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expectUnchanged(before, durableBefore);
        useTaskStore.setState({ _allProjects: [project('p')] });
        expect(await commit(prepared)).toMatchObject({ ok: true });
        const committed = saved();
        useTaskStore.setState({ _allProjects: [unavailable] });
        saveData.mockClear();
        const applied = stored();
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expectUnchanged(applied, committed);
    });

    it('guards a selected destination becoming unavailable and validates the complete assignment', async () => {
        await seed({}, [project('p')]);
        const prepared = prepare({ dueDate: '2026-10-05', projectId: 'p', areaId: '', sectionId: '' });
        useTaskStore.setState({ _allProjects: [project('p', { status: 'archived' })] });
        const before = stored();
        const durableBefore = saved();
        expect(await commit(prepared)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expectUnchanged(before, durableBefore);
    });

    it.each([{ status: 'reference' as const }, { deletedAt: NOW }, { purgedAt: NOW }])('refuses an unavailable task %j before preparing', async (extra) => {
        await seed(extra);
        const before = stored();
        const durableBefore = saved();
        expect(host.prepareTaskDraftSave({ id: 'edit', base: { dueDate: '' }, patch: { dueDate: '2026-10-05' },
            scheduleBase: { startTime: null, dueDate: null, relativeStartOffset: null, reviewAt: null } })).toMatchObject({ ok: false });
        expectUnchanged(before, durableBefore);
    });

    it('does not depend on a bounded process receipt after more than fifty other preparations', async () => {
        const prepared = prepare({ dueDate: '2026-10-05' });
        expect(await commit(prepared)).toMatchObject({ ok: true });
        const committed = saved();
        for (let index = 0; index < 60; index++) prepare({ reviewAt: `2026-11-${String(index % 28 + 1).padStart(2, '0')}` });
        await open('UTC');
        const before = stored();
        expect(await commit(prepared)).toMatchObject({ ok: true });
        expectUnchanged(before, committed);
    });
});
