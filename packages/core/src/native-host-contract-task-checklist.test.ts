import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project, Section, Task } from './types';
import { createTaskDraft } from './task-draft';
import { en } from './i18n/locales/en';
import { createNextRecurringTask } from './recurrence';
import { openSqliteHost } from './screen-parity.replay';
import { samePreparedTask } from './store-tasks';

const clock = '2026-09-27T15:00:00.000Z';
const item = (id: string, title: string, isCompleted = false) => ({ id, title, isCompleted });
const source = (overrides: Partial<Task> = {}): Task => ({
    id: 'checklist-task', title: 'Before', status: 'next', taskMode: 'list',
    createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
    rev: 3, revBy: 'device-a', tags: [], contexts: [],
    checklist: [item('one', 'First'), item('two', 'Second')], ...overrides,
});

describe('prepared recurring occurrence Skip', () => {
    const recurring = (overrides: Partial<Task> = {}): Task => source({
        dueDate: '2026-09-27', recurrence: { rule: 'daily', strategy: 'strict' },
        ...overrides,
    });
    const skipRequest = (task: Task, patch: Record<string, unknown> = {}, base: Record<string, unknown> = {}) => ({
        id: task.id, requestId: id, intent: 'skip' as const, base, patch,
        scheduleBase: { startTime: task.startTime ?? null, dueDate: task.dueDate ?? null,
            relativeStartOffset: task.relativeStartOffset ?? null, reviewAt: task.reviewAt ?? null },
        checklist: { base: task.checklist!, value: task.checklist! },
    });
    const preparedSkip = (host: Awaited<ReturnType<typeof open>>['host'], request: ReturnType<typeof skipRequest>) => {
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') throw new Error('Expected prepared Skip');
        return plan.prepared;
    };

    it('archives a clean saved occurrence once and replays its exact child after restart', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const original = recurring();
        const { host, saved } = await open(original);
        expect(unwrap(host.getTaskEditorModel({ id: original.id })).canSkipOccurrence).toBe(true);
        const request = skipRequest(original);
        const prepared = preparedSkip(host, request);
        expect(prepared.result).toEqual({ id: original.id });
        expect(prepared.effect.tasks).toHaveLength(2);
        expect(unwrap(host.validatePreparedTaskChecklistWrite({ request, prepared }))).toEqual({ id: original.id });
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared }))).toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ status: 'archived', cancelledAt: clock, rev: 4 });
        expect(savedTask().completedAt).toBeUndefined();
        const child = saved().tasks.find((task) => task.id !== original.id)!;
        expect(child).toMatchObject({ status: 'next', dueDate: '2026-09-28',
            recurrence: { seriesId: original.id } });
        const persisted = structuredClone(saved());
        const cold = (await open(persisted.tasks[0], { tasks: persisted.tasks.slice(1) })).host;
        vi.setSystemTime(new Date('2028-04-01T10:00:00.000Z'));
        expect(unwrap(cold.validatePreparedTaskChecklistWrite({ request, prepared }))).toEqual({ id: original.id });
        expect(unwrap(await cold.commitPreparedTaskChecklistWrite({ request, prepared }))).toEqual({ id: original.id });
        expect(useTaskStore.getState()._allTasks).toHaveLength(2);
        expect(useTaskStore.getState()._tasksById.get(child.id)).toEqual(child);
    });

    it('saves the draft into the skipped source and bases the next occurrence on that draft', async () => {
        const original = recurring({ checklist: [item('one', 'First', true)], isFocusedToday: true,
            focusOrder: 2 });
        const { host } = await open(original);
        const request = { ...skipRequest(original,
            { title: 'Edited title', dueDate: '2026-10-01' },
            { title: original.title, dueDate: '2026-09-27' }),
            checklist: { base: original.checklist!, value: [item('one', 'First', false)] } };
        const prepared = preparedSkip(host, request);
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared }))).toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ title: 'Edited title', status: 'archived', rev: 5,
            isFocusedToday: false });
        const child = useTaskStore.getState()._allTasks.find((task) => task.id !== original.id)!;
        expect(child).toMatchObject({ title: 'Edited title', dueDate: '2026-10-02', status: 'next' });
        expect(child.checklist?.[0]).toMatchObject({ title: 'First', isCompleted: false });
    });

    it('refuses ineligible saved and dirty tasks without saving, and rejects forged effects', async () => {
        const original = recurring();
        const { host, saves } = await open(original);
        const before = saves();
        for (const patch of [{ status: 'done' }, { status: 'reference' }]) {
            expect(host.prepareTaskChecklistSave(skipRequest(original, patch, { status: original.status }))).toMatchObject({
                ok: false, error: { code: 'INVALID_INPUT', message: en['task.skipOccurrenceSaveFirst'] },
            });
        }
        expect(host.prepareTaskChecklistSave(skipRequest(original, { status: 'archived' },
            { status: original.status }))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const request = skipRequest(original);
        const prepared = preparedSkip(host, request);
        const forged = structuredClone(prepared);
        forged.effect.tasks.find((row) => row.after.id === original.id)!.after.status = 'done';
        expect(host.validatePreparedTaskChecklistWrite({ request, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const forgedProjection = structuredClone(prepared);
        forgedProjection.witness.recurrenceProjection!.candidate.dueDate = '2030-01-01';
        expect(host.validatePreparedTaskChecklistWrite({ request, prepared: forgedProjection }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const coordinated = structuredClone(prepared);
        coordinated.witness.recurrenceProjection!.candidate.dueDate = '2026-10-28';
        coordinated.effect.tasks.find((row) => row.after.id !== original.id)!.after.dueDate = '2026-10-28';
        coordinated.effect.guards.recurringCandidate!.dueDate = '2026-10-28';
        expect(host.validatePreparedTaskChecklistWrite({ request, prepared: coordinated }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const paired = recurring({ startTime: '2026-09-25' });
        const pairedHost = (await open(paired)).host;
        const pairedRequest = skipRequest(paired);
        const pairedPrepared = preparedSkip(pairedHost, pairedRequest);
        const forgedSibling = structuredClone(pairedPrepared);
        forgedSibling.witness.recurrenceProjection!.candidate.startTime = '2026-10-25';
        forgedSibling.effect.tasks.find((row) => row.after.id !== paired.id)!.after.startTime = '2026-10-25';
        forgedSibling.effect.guards.recurringCandidate!.startTime = '2026-10-25';
        expect(pairedHost.validatePreparedTaskChecklistWrite({ request: pairedRequest, prepared: forgedSibling }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);
        for (const task of [recurring({ recurrence: { rule: 'daily', strategy: 'fluid' } }),
            recurring({ dueDate: undefined, startTime: undefined }), recurring({ status: 'done' })]) {
            const blocked = await open(task);
            expect(unwrap(blocked.host.getTaskEditorModel({ id: task.id })).canSkipOccurrence).toBe(false);
            expect(blocked.host.prepareTaskChecklistSave(skipRequest(task)))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('matches shared advanceOne for dated, timed, start-only, paired, and bounded recurrences', async () => {
        const cases: Array<[string, Partial<Task>]> = [
            ['daily due', { dueDate: '2026-09-27', recurrence: { rule: 'daily', strategy: 'strict' } }],
            ['weekly timed due', { dueDate: '2026-09-27T09:30:00',
                recurrence: { rule: 'weekly', strategy: 'strict' } }],
            ['monthly nth start', { startTime: '2026-09-28', dueDate: undefined,
                recurrence: { rule: 'monthly', strategy: 'strict', byDay: ['MO'], bySetPos: -1,
                    rrule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1' } }],
            ['yearly paired', { startTime: '2026-09-25', dueDate: '2026-09-27',
                recurrence: { rule: 'yearly', strategy: 'strict' } }],
            ['count end', { dueDate: '2026-09-27',
                recurrence: { rule: 'daily', strategy: 'strict', count: 1, completedOccurrences: 0,
                    rrule: 'FREQ=DAILY;COUNT=1' } }],
            ['count continues', { dueDate: '2026-09-27',
                recurrence: { rule: 'daily', strategy: 'strict', count: 5, completedOccurrences: 0,
                    rrule: 'FREQ=DAILY;COUNT=5' } }],
        ];
        for (const [label, fields] of cases) {
            const original = recurring(fields);
            const { host } = await open(original);
            const request = skipRequest(original);
            const prepared = preparedSkip(host, request);
            const expected = createNextRecurringTask(original, prepared.witness.preparedAt, original.status,
                { advanceOne: true });
            const child = prepared.effect.tasks.find((row) => row.after.id !== original.id)?.after;
            expect(child?.startTime, label).toBe(expected?.startTime);
            expect(child?.dueDate, label).toBe(expected?.dueDate);
            expect(child?.reviewAt, label).toBe(expected?.reviewAt);
            expect(child?.status, label).toBe(expected?.status);
            expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared })), label)
                .toEqual({ id: original.id });
            expect(useTaskStore.getState()._allTasks, label).toHaveLength(expected ? 2 : 1);
        }
    });

    it('does not duplicate a preexisting follow-up and refuses an intervening source writer', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const original = recurring();
        const existing = createNextRecurringTask(original, clock, original.status,
            { advanceOne: true })!;
        const { host } = await open(original, { tasks: [existing] });
        const request = skipRequest(original);
        const prepared = preparedSkip(host, request);
        expect(prepared.effect.tasks).toHaveLength(1);
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared })))
            .toEqual({ id: original.id });
        expect(useTaskStore.getState()._allTasks).toHaveLength(2);
        const another = await open(original);
        const staleRequest = skipRequest(original);
        const stale = preparedSkip(another.host, staleRequest);
        await useTaskStore.getState().updateTask(original.id, { description: 'Another writer' });
        await flushPendingSave();
        expect(await another.host.commitPreparedTaskChecklistWrite({ request: staleRequest, prepared: stale }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allTasks).toHaveLength(1);
        expect(savedTask().description).toBe('Another writer');
    });

    it('validates the frozen timed projection after process timezone and clock change', async () => {
        const previousZone = process.env.TZ;
        try {
            process.env.TZ = 'America/New_York';
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date(clock));
            const original = recurring({ dueDate: '2026-09-27T09:30:00' });
            const { host } = await open(original);
            const request = skipRequest(original);
            const prepared = preparedSkip(host, request);
            process.env.TZ = 'UTC';
            vi.setSystemTime(new Date('2028-04-01T10:00:00.000Z'));
            const cold = createNativeHostContract();
            unwrap(await cold.activate({ writeSafetyReady: true, recoveryLoad: true }));
            expect(unwrap(cold.validatePreparedTaskChecklistWrite({ request, prepared }))).toEqual({ id: original.id });
            expect(unwrap(await cold.commitPreparedTaskChecklistWrite({ request, prepared }))).toEqual({ id: original.id });
            expect(useTaskStore.getState()._allTasks).toHaveLength(2);
        } finally {
            if (previousZone === undefined) delete process.env.TZ;
            else process.env.TZ = previousZone;
        }
    });

    it('replays a spring-forward wall time and hourly relative start in the preparing zone', async () => {
        const previousZone = process.env.TZ;
        try {
            process.env.TZ = 'America/New_York';
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-03-01T15:00:00.000Z'));
            const original = recurring({ dueDate: '2026-03-01T02:30',
                startTime: '2026-03-01T01:30', relativeStartOffset: { amount: -1, unit: 'hour' },
                recurrence: { rule: 'weekly', strategy: 'strict' } });
            const { host } = await open(original);
            const request = skipRequest(original);
            const prepared = preparedSkip(host, request);
            const child = prepared.effect.tasks.find((row) => row.after.id !== original.id)!.after;
            expect(child.dueDate).toBe('2026-03-08T03:30');
            process.env.TZ = 'UTC';
            expect(unwrap(host.validatePreparedTaskChecklistWrite({ request, prepared })))
                .toEqual({ id: original.id });
        } finally {
            if (previousZone === undefined) delete process.env.TZ;
            else process.env.TZ = previousZone;
        }
    });
});

describe('prepared task cancellation and Undo', () => {
    const cancelId = '00000000-0000-4000-8000-000000000322';
    const undoId = '00000000-0000-4000-8000-000000000323';
    const cancelRequest = (task: Task, patch: Record<string, unknown> = {}, base: Record<string, unknown> = {}) => ({
        id: task.id, requestId: cancelId, intent: 'cancel' as const, base, patch, scheduleBase,
        checklist: { base: task.checklist!, value: task.checklist! },
    });
    const preparedCancel = (host: Awaited<ReturnType<typeof open>>['host'], request: ReturnType<typeof cancelRequest>) => {
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') throw new Error('Expected prepared cancellation');
        return plan.prepared;
    };

    it('cancels a clean recurring task at the frozen clock without completion or another occurrence', async () => {
        const original = source({ recurrence: 'daily', isFocusedToday: true, focusOrder: 2 });
        const { host } = await open(original);
        const editor = unwrap(host.getTaskEditorModel({ id: original.id }));
        expect(editor).toMatchObject({ canCancel: true, cancelLabel: 'Cancel recurring series' });
        const request = cancelRequest(original);
        const prepared = preparedCancel(host, request);
        expect(prepared.result).toEqual({ id: original.id, cancellation: {
            cancelledAt: prepared.witness.preparedAt, undoEnabled: true,
            message: 'Task cancelled. You can restore it from Archive.', undoLabel: 'Undo',
        } });
        expect(unwrap(host.validatePreparedTaskChecklistWrite({ request, prepared }))).toEqual(prepared.result);
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared }))).toEqual(prepared.result);
        expect(savedTask()).toMatchObject({ status: 'archived', cancelledAt: prepared.witness.preparedAt,
            isFocusedToday: false });
        expect(savedTask().completedAt).toBeUndefined();
        expect(useTaskStore.getState()._allTasks).toHaveLength(1);
    });

    it('saves the whole draft before cancellation, then Undo retains a later unrelated edit', async () => {
        const original = source({ isFocusedToday: true, focusOrder: 3, boardOrder: 7 });
        const { host } = await open(original);
        const request = cancelRequest(original, { title: 'Edited in draft' }, { title: original.title });
        const prepared = preparedCancel(host, request);
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared }))).toEqual(prepared.result);
        expect(savedTask()).toMatchObject({ title: 'Edited in draft', status: 'archived' });
        await useTaskStore.getState().updateTask(original.id, { description: 'Later unrelated edit' });
        await flushPendingSave();
        const cancel = { request, prepared };
        const undoRequest = { requestId: undoId, cancelRequestId: cancelId };
        const undo = unwrap(host.prepareTaskCancellationUndo({ request: undoRequest, cancel }));
        expect(undo.kind).toBe('prepared');
        expect(unwrap(host.validatePreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared })))
            .toEqual({ id: original.id });
        expect(unwrap(await host.commitPreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared })))
            .toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ title: 'Edited in draft', description: 'Later unrelated edit',
            status: original.status, isFocusedToday: true, focusOrder: 3, boardOrder: 7 });
        expect(savedTask().cancelledAt).toBeUndefined();
        const cold = createNativeHostContract();
        unwrap(await cold.activate({ writeSafetyReady: true, recoveryLoad: true }));
        expect(unwrap(await cold.commitPreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared })))
            .toEqual({ id: original.id });
    });

    it('rejects forged cancellation clocks and Undo proofs before writes', async () => {
        const original = source();
        const { host, saves } = await open(original);
        const request = cancelRequest(original);
        const prepared = preparedCancel(host, request);
        const forged = structuredClone(prepared);
        forged.effect.tasks.find((row) => row.after.id === original.id)!.after.cancelledAt = '2030-01-01T00:00:00.000Z';
        expect(host.validatePreparedTaskChecklistWrite({ request, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.prepareTaskChecklistSave({ ...request, intent: 'other' } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const before = saves();
        unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared }));
        const undoRequest = { requestId: undoId, cancelRequestId: cancelId };
        const undo = unwrap(host.prepareTaskCancellationUndo({ request: undoRequest, cancel: { request, prepared } }));
        const badUndo = structuredClone(undo.prepared);
        badUndo.cancel.prepared.witness.source.status = 'waiting';
        expect(host.validatePreparedTaskCancellationUndo({ request: undoRequest, prepared: badUndo }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before + 1);
    });

    it('refuses Undo after a newer cancellation or deletion', async () => {
        const original = source();
        const { host } = await open(original);
        const request = cancelRequest(original);
        const prepared = preparedCancel(host, request);
        unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared }));
        const undoRequest = { requestId: undoId, cancelRequestId: cancelId };
        await useTaskStore.getState().updateTask(original.id, { cancelledAt: '2030-01-01T00:00:00.000Z' });
        await flushPendingSave();
        expect(host.prepareTaskCancellationUndo({ request: undoRequest, cancel: { request, prepared } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        await useTaskStore.getState().deleteTask(original.id);
        await flushPendingSave();
        expect(host.prepareTaskCancellationUndo({ request: undoRequest, cancel: { request, prepared } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('retries failed cancellation and Undo persistence with their original prepared envelopes', async () => {
        let failSave = false;
        const original = source({ isFocusedToday: true, focusOrder: 4 });
        const { host, saved } = await open(original, { saveData: async () => {
            if (failSave) throw new Error('disk unavailable');
        } });
        const request = cancelRequest(original, { title: 'Saved draft' }, { title: original.title });
        const prepared = preparedCancel(host, request);
        failSave = true;
        expect(await host.commitPreparedTaskChecklistWrite({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(savedTask()).toMatchObject({ title: 'Saved draft', status: 'archived', rev: 4 });
        expect(saved().tasks[0]).toMatchObject({ title: original.title, status: original.status, rev: 3 });
        failSave = false;
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared }))).toEqual(prepared.result);
        expect(saved().tasks[0]).toMatchObject({ title: 'Saved draft', status: 'archived', rev: 4 });

        const undoRequest = { requestId: undoId, cancelRequestId: cancelId };
        const undo = unwrap(host.prepareTaskCancellationUndo({ request: undoRequest, cancel: { request, prepared } }));
        failSave = true;
        expect(await host.commitPreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(savedTask()).toMatchObject({ title: 'Saved draft', status: original.status, rev: 5 });
        expect(saved().tasks[0]).toMatchObject({ title: 'Saved draft', status: 'archived', rev: 4 });
        failSave = false;
        expect(unwrap(await host.commitPreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared })))
            .toEqual({ id: original.id });
        expect(saved().tasks[0]).toMatchObject({ title: 'Saved draft', status: original.status, rev: 5 });
        const cold = await open(saved().tasks[0]);
        expect(unwrap(cold.host.validatePreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared })))
            .toEqual({ id: original.id });
        expect(unwrap(await cold.host.commitPreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared })))
            .toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ title: 'Saved draft', status: original.status, rev: 5 });
    }, 20_000);

    it('freezes the Undo notification setting and rejects an archived parent', async () => {
        const original = source();
        const { host } = await open(original);
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, undoNotificationsEnabled: false } });
        const request = cancelRequest(original);
        const prepared = preparedCancel(host, request);
        expect(prepared.result).toMatchObject({ cancellation: { undoEnabled: false } });
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, undoNotificationsEnabled: true } });
        expect(unwrap(host.validatePreparedTaskChecklistWrite({ request, prepared }))).toEqual(prepared.result);

        const archived: Project = { id: 'archived-parent', title: 'Old', status: 'archived', color: '#94a3b8',
            order: 0, tagIds: [], createdAt: clock, updatedAt: clock };
        const child = source({ projectId: archived.id });
        const blocked = await open(child, { projects: [archived] });
        expect(unwrap(blocked.host.getTaskEditorModel({ id: child.id })).canCancel).toBe(false);
        expect(blocked.host.prepareTaskChecklistSave(cancelRequest(child)))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('validates and replays cancellation and Undo after translation text changes', async () => {
        const original = source();
        const { host } = await open(original);
        const request = cancelRequest(original);
        const prepared = preparedCancel(host, request);
        const frozen = structuredClone(prepared.result);
        const priorMessage = en['task.cancelledWithRestore'];
        const priorUndo = en['common.undo'];
        try {
            en['task.cancelledWithRestore'] = 'Updated cancellation wording';
            en['common.undo'] = 'Revert';
            const cold = createNativeHostContract();
            unwrap(await cold.activate({ writeSafetyReady: true, recoveryLoad: true }));
            expect(unwrap(cold.validatePreparedTaskChecklistWrite({ request, prepared }))).toEqual(frozen);
            expect(unwrap(await cold.commitPreparedTaskChecklistWrite({ request, prepared }))).toEqual(frozen);
            const undoRequest = { requestId: undoId, cancelRequestId: cancelId };
            const undo = unwrap(cold.prepareTaskCancellationUndo({ request: undoRequest, cancel: { request, prepared } }));
            expect(unwrap(cold.validatePreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared })))
                .toEqual({ id: original.id });
            expect(unwrap(await cold.commitPreparedTaskCancellationUndo({ request: undoRequest, prepared: undo.prepared })))
                .toEqual({ id: original.id });
        } finally {
            en['task.cancelledWithRestore'] = priorMessage;
            en['common.undo'] = priorUndo;
        }
    });
});
const unwrap = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
async function open(task: Task = source(), options: {
    tasks?: Task[]; projects?: Project[]; sections?: Section[]; areas?: Area[];
    saveData?: (next: AppData) => Promise<void>;
} = {}) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [task, ...(options.tasks ?? [])], projects: options.projects ?? [],
        sections: options.sections ?? [], areas: options.areas ?? [], people: [], settings: { deviceId: 'device-a' } };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        await options.saveData?.(next);
        data = JSON.parse(JSON.stringify(next)) as AppData;
        saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    return { host, saved: () => data, saves: () => saves };
}
const savedTask = () => useTaskStore.getState()._tasksById.get('checklist-task')!;
const scheduleBase = { startTime: null, dueDate: null, relativeStartOffset: null, reviewAt: null };
const id = '00000000-0000-4000-8000-000000000321';

afterEach(async () => {
    vi.useRealTimers();
    await flushPendingSave();
    resetForTests();
});

describe('prepared native checklist Save and Reset', () => {
    it('saves Location together with a checklist edit through the existing combined writer', async () => {
        const original = source();
        const { host } = await open(original);
        const request = { id: original.id, requestId: id,
            base: { location: '' }, patch: { location: '  Clinic B  ' }, scheduleBase,
            checklist: { base: original.checklist!, value: [item('one', 'Revised'), item('two', 'Second')] } };
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') return;
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: plan.prepared })))
            .toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ location: 'Clinic B', rev: 4,
            checklist: [item('one', 'Revised'), item('two', 'Second')] });
    });

    it('saves Assigned To with a checklist edit as one prepared effect', async () => {
        const original = source({ assignedTo: 'Old person' });
        const { host } = await open(original);
        const request = { id: original.id, requestId: id,
            base: { assignedTo: 'Old person' }, patch: { assignedTo: '  New person  ' }, scheduleBase,
            checklist: { base: original.checklist!, value: [item('one', 'Revised'), item('two', 'Second')] } };
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') return;
        expect(unwrap(host.validatePreparedTaskChecklistWrite({ request, prepared: plan.prepared })))
            .toEqual({ id: original.id });
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: plan.prepared })))
            .toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ assignedTo: 'New person', rev: 4,
            checklist: [item('one', 'Revised'), item('two', 'Second')] });
    });

    it('clears Time Spent with explicit null alongside a checklist edit', async () => {
        const original = source({ timeSpentMinutes: 17 });
        const { host } = await open(original);
        const request = { id: original.id, requestId: id,
            base: { timeSpentMinutes: 17 }, patch: { timeSpentMinutes: null }, scheduleBase,
            checklist: { base: original.checklist!, value: [item('one', 'Revised'), item('two', 'Second')] } };
        for (const value of [true, '17', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(host.prepareTaskChecklistSave({ ...request, patch: { timeSpentMinutes: value } } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') return;
        expect(unwrap(host.validatePreparedTaskChecklistWrite({ request, prepared: plan.prepared })))
            .toEqual({ id: original.id });
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: plan.prepared })))
            .toEqual({ id: original.id });
        expect(savedTask().timeSpentMinutes).toBeUndefined();
        expect(savedTask().checklist).toEqual([item('one', 'Revised'), item('two', 'Second')]);
    });

    it('projects an unsaved checklist into editor layout without changing the saved edit source', async () => {
        const { host } = await open(source({ checklist: [] }));
        const draft = createTaskDraft(savedTask());
        const saved = unwrap(host.editTaskDraft({ id: savedTask().id, draft }));
        const projected = unwrap(host.editTaskDraft({ id: savedTask().id, draft,
            checklist: [item('new', 'Unsaved item')] }));
        expect(projected.layout.sections.find((section) => section.fields.includes('checklist'))?.filledCount)
            .toBeGreaterThan(saved.layout.sections.find((section) => section.fields.includes('checklist'))?.filledCount ?? 0);
        expect(savedTask().checklist).toEqual([]);
        expect(projected.scheduleBase).toEqual(saved.scheduleBase);
        expect(host.editTaskDraft({ id: savedTask().id, draft,
            checklist: [{ id: 'x', title: 'item', isCompleted: false, leaked: true }] as never }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('saves a status-only final diff after checklist edits cancel out', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const { host } = await open(source({ checklist: [item('one', 'First', true)], status: 'next' }));
        const request = { id: 'checklist-task', requestId: id, base: { status: 'next' }, patch: { status: 'done' },
            scheduleBase, checklist: { base: savedTask().checklist, value: savedTask().checklist } };
        const prepared = unwrap(host.prepareTaskChecklistSave(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        expect(prepared.prepared.effect.tasks.find((row) => row.after.id === request.id)?.after.checklist)
            .toEqual([item('one', 'First', true)]);
        expect(unwrap(host.validatePreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))).toEqual({ id: 'checklist-task' });
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))).toEqual({ id: 'checklist-task' });
        expect(savedTask()).toMatchObject({ status: 'done', checklist: [item('one', 'First', true)], rev: 4 });
        const rev = savedTask().rev;
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))).toEqual({ id: 'checklist-task' });
        expect(savedTask().rev).toBe(rev);
    });

    it('saves a same-final Next draft that lost its Focus star', async () => {
        const original = source({ status: 'next', isFocusedToday: true, focusOrder: 2, timeSpentMinutes: 35 });
        const { host } = await open(original);
        const request = { id: original.id, requestId: id,
            base: { focusedToday: true }, patch: { focusedToday: false }, scheduleBase,
            checklist: { base: original.checklist!, value: original.checklist! } };
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') return;
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: plan.prepared })))
            .toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ status: 'next', isFocusedToday: false, timeSpentMinutes: 35, rev: 4 });
        expect(savedTask().focusOrder).toBeUndefined();
    });

    it('validates Swift-sorted prepared JSON with an unchanged duplicate checklist and attachments', async () => {
        const at = '2026-09-01T10:00:00.000Z';
        const checklist = [item('duplicate', 'First'), item('duplicate', 'Second', true)];
        const attachment = { id: 'file', kind: 'file' as const, title: 'Retained', uri: 'file:///retained.txt',
            createdAt: at, updatedAt: at };
        const original = source({ projectId: 'project', sectionId: 'section', dueDate: '2036-10-02',
            startTime: '2036-10-01T14:30:00.000Z', checklist, attachments: [attachment],
            tags: ['#keep'], contexts: ['@desk'], priority: 'high', energyLevel: 'low',
            timeEstimate: '15min', order: 37, orderNum: 37, isFocusedToday: true, timeSpentMinutes: 17 });
        const { host } = await open(original, { projects: [{ id: 'project', title: 'Project', status: 'active',
            color: '#94a3b8', areaId: 'area', order: 0, createdAt: at, updatedAt: at }],
        sections: [{ id: 'section', projectId: 'project', title: 'Section', order: 0, createdAt: at, updatedAt: at }],
        areas: [{ id: 'area', name: 'Area', order: 0, createdAt: at, updatedAt: at }] });
        const opening = unwrap(host.getTaskEditorModel({ id: original.id }));
        const reference = unwrap(host.editTaskDraft({ id: original.id, draft: opening.draft,
            edit: { type: 'fields', patch: { status: 'reference' } } }));
        const final = unwrap(host.editTaskDraft({ id: original.id, draft: reference.draft,
            edit: { type: 'fields', patch: { status: 'next' } } }));
        expect(final.draft.focusedToday).toBe(false);
        const request = { id: original.id, requestId: id,
            base: { focusedToday: true }, patch: { focusedToday: false }, scheduleBase: opening.scheduleBase,
            checklist: { base: checklist, value: checklist } };
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') return;
        const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
                .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)])) : value;
        const envelope = JSON.parse(JSON.stringify(sorted({ request, prepared: plan.prepared })));
        expect(Object.keys(envelope.prepared.witness.source.checklist[0])).toEqual(['id', 'isCompleted', 'title']);
        expect(unwrap(host.validatePreparedTaskChecklistWrite(envelope))).toEqual({ id: original.id });
        unwrap(await host.commitPreparedTaskChecklistWrite(envelope));
        expect(savedTask()).toMatchObject({ status: 'next', isFocusedToday: false, timeSpentMinutes: 17,
            projectId: 'project', sectionId: 'section', dueDate: '2036-10-02',
            startTime: '2036-10-01T14:30:00.000Z', checklist, attachments: [attachment],
            tags: ['#keep'], contexts: ['@desk'], priority: 'high', energyLevel: 'low', timeEstimate: '15min', rev: 4 });
    });

    it('saves a same-final Done completion correction without a second recurrence', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const original = source({ status: 'done', completedAt: '2026-09-26T10:00:00.000Z',
            timeSpentMinutes: 35, recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY' },
            dueDate: '2026-09-27' });
        const { host } = await open(original);
        const request = { id: original.id, requestId: id,
            base: { completedAt: original.completedAt! }, patch: { completedAt: '' },
            scheduleBase: { ...scheduleBase, dueDate: original.dueDate! },
            checklist: { base: original.checklist!, value: original.checklist! } };
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') return;
        expect(plan.prepared.effect.tasks).toHaveLength(1);
        unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: plan.prepared }));
        expect(savedTask()).toMatchObject({ status: 'done', completedAt: clock, timeSpentMinutes: 35, rev: 4 });
        expect(useTaskStore.getState()._allTasks).toHaveLength(1);
    });

    it('accepts Waiting assignment and rejects malformed lifecycle baselines before writing', async () => {
        const original = source({ isFocusedToday: true, focusOrder: 2 });
        const { host, saves } = await open(original);
        const request = { id: original.id, requestId: id,
            base: { status: 'next', assignedTo: '', focusedToday: true },
            patch: { status: 'waiting', assignedTo: '  Casey  ', focusedToday: false }, scheduleBase,
            checklist: { base: original.checklist!, value: original.checklist! } };
        for (const invalid of [
            { ...request, base: { ...request.base, focusedToday: 'true' } },
            { ...request, patch: { ...request.patch, focusedToday: 'false' } },
            { ...request, base: { ...request.base, completedAt: 'bad date' },
                patch: { ...request.patch, completedAt: '' } },
        ]) {
            expect(host.prepareTaskChecklistSave(invalid as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const before = saves();
        expect(saves()).toBe(before);
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') return;
        unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: plan.prepared }));
        expect(savedTask()).toMatchObject({ status: 'waiting', assignedTo: 'Casey', isFocusedToday: false, rev: 4 });
    });

    it('clears Focus when entering Reference without a separate star patch', async () => {
        const original = source({ isFocusedToday: true, focusOrder: 2, timeSpentMinutes: 35 });
        const { host } = await open(original);
        const request = { id: original.id, requestId: id,
            base: { status: 'next' }, patch: { status: 'reference' }, scheduleBase,
            checklist: { base: original.checklist!, value: original.checklist! } };
        const plan = unwrap(host.prepareTaskChecklistSave(request));
        expect(plan.kind).toBe('prepared');
        if (plan.kind !== 'prepared') return;
        unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: plan.prepared }));
        expect(savedTask()).toMatchObject({ status: 'reference', isFocusedToday: false, timeSpentMinutes: 35, rev: 4 });
        expect(savedTask().focusOrder).toBeUndefined();
    });

    it('writes a nonempty already-open Reset and returns an empty saved-list no-write result', async () => {
        const { host, saves } = await open();
        const request = { id: 'checklist-task', requestId: id, checklistBase: savedTask().checklist };
        const prepared = unwrap(host.prepareTaskChecklistReset(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        const before = saves();
        const result = unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }));
        expect(result).toMatchObject({ id: 'checklist-task', status: 'next', checklistBase: source().checklist });
        expect(savedTask().rev).toBe(4);
        expect(saves()).toBeGreaterThan(before);
        const empty = await open(source({ checklist: [] }));
        expect(unwrap(empty.host.prepareTaskChecklistReset({ id: 'checklist-task', requestId: id, checklistBase: [] }))).toMatchObject({
            kind: 'unchanged', result: { id: 'checklist-task', checklistBase: [] },
        });
    });

    it('saves a title, checklist, date, and list completion with exactly one recurring child', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const original = source({ timeSpentMinutes: 17, recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY' },
            dueDate: '2026-09-27', checklist: [item('one', 'First', true), item('two', 'Second')] });
        const { host } = await open(original);
        const completedAt = '2026-09-20T10:15:30.123Z';
        const request = { id: original.id, requestId: id, base: { title: 'Before', status: 'next',
            completedAt: '', dueDate: '2026-09-27', timeSpentMinutes: 17 },
            patch: { title: 'After', status: 'done', completedAt, dueDate: '2026-09-28', timeSpentMinutes: 25 },
            scheduleBase: { ...scheduleBase, dueDate: '2026-09-27' },
            checklist: { base: original.checklist!, value: original.checklist!.map((entry) => ({ ...entry, isCompleted: true })) } };
        const prepared = unwrap(host.prepareTaskChecklistSave(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        expect(prepared.prepared.effect.tasks).toHaveLength(2);
        const child = prepared.prepared.effect.tasks.find((row) => row.before === null)?.after;
        expect(child?.checklist?.every((entry) => !entry.isCompleted)).toBe(true);
        expect(child?.id).not.toBe(original.id);
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))).toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ title: 'After', status: 'done', completedAt,
            dueDate: '2026-09-28', timeSpentMinutes: 25, rev: 4 });
        expect(useTaskStore.getState()._allTasks.filter((entry) => entry.id === child?.id)).toHaveLength(1);
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))).toEqual({ id: original.id });
        expect(useTaskStore.getState()._allTasks.filter((entry) => entry.id === child?.id)).toHaveLength(1);
    });

    it('acknowledges exact date-only and timed recurring rows after a cold timezone and clock change', async () => {
        const priorZone = process.env.TZ;
        try {
            for (const timed of [false, true]) {
                process.env.TZ = 'America/New_York';
                vi.useFakeTimers({ toFake: ['Date'] });
                vi.setSystemTime(new Date(clock));
                expect(new Date(clock).getTimezoneOffset()).toBe(240);
                const original = source({
                    recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY' },
                    dueDate: timed ? '2026-09-27T18:00:00.000Z' : '2026-09-27',
                    ...(timed ? { startTime: '2026-09-27T17:00:00.000Z',
                        relativeStartOffset: { amount: -1, unit: 'hour' as const } } : {}),
                    checklist: [item('one', 'First', true)],
                });
                const initial = await open(original);
                const request = { id: original.id,
                    requestId: timed ? '00000000-0000-4000-8000-000000000323' : id,
                    base: { status: 'next' }, patch: { status: 'done' },
                    scheduleBase: { startTime: original.startTime ?? null, dueDate: original.dueDate ?? null,
                        relativeStartOffset: original.relativeStartOffset ?? null, reviewAt: null },
                    checklist: { base: original.checklist!, value: original.checklist! } };
                const prepared = unwrap(initial.host.prepareTaskChecklistSave(request));
                expect(prepared.kind).toBe('prepared');
                if (prepared.kind !== 'prepared') continue;
                const plannedRows = structuredClone(prepared.prepared.effect.tasks.map((row) => row.after));
                expect(plannedRows).toHaveLength(2);
                const childId = plannedRows.find((row) => row.id !== original.id)!.id;
                expect(unwrap(await initial.host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared })))
                    .toEqual({ id: original.id });
                const durable = initial.saved();
                const durableRows = structuredClone(durable.tasks.filter((row) => row.id === original.id || row.id === childId));
                expect(durableRows).toEqual(plannedRows);

                process.env.TZ = 'America/Los_Angeles';
                vi.setSystemTime(new Date('2026-09-28T16:00:00.000Z'));
                expect(new Date(clock).getTimezoneOffset()).toBe(420);
                const reloaded = await open(durableRows.find((row) => row.id === original.id)!, {
                    tasks: durableRows.filter((row) => row.id === childId),
                });
                const beforeRetry = structuredClone(useTaskStore.getState()._allTasks);
                const savesBeforeRetry = reloaded.saves();
                expect(unwrap(reloaded.host.validatePreparedTaskChecklistWrite({ request, prepared: prepared.prepared })))
                    .toEqual({ id: original.id });
                expect(unwrap(await reloaded.host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared })))
                    .toEqual({ id: original.id });
                expect(useTaskStore.getState()._allTasks).toEqual(beforeRetry);
                expect(useTaskStore.getState()._allTasks).toEqual(durableRows);
                expect(reloaded.saves()).toBe(savesBeforeRetry);
                expect(useTaskStore.getState()._allTasks.filter((row) => row.id === childId)).toHaveLength(1);
            }
        } finally {
            vi.useRealTimers();
            if (priorZone === undefined) delete process.env.TZ;
            else process.env.TZ = priorZone;
        }
    });

    it('keeps a manual final status override and a Reference list', async () => {
        const { host } = await open(source({ status: 'reference', checklist: [item('one', 'Bullet')] }));
        const request = { id: 'checklist-task', requestId: id, base: {}, patch: {}, scheduleBase,
            checklist: { base: savedTask().checklist!, value: [item('one', 'Edited bullet')] } };
        const prepared = unwrap(host.prepareTaskChecklistSave(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))).toEqual({ id: request.id });
        expect(savedTask()).toMatchObject({ status: 'reference', checklist: [item('one', 'Edited bullet')] });
        expect(host.prepareTaskChecklistSave({ ...request, requestId: '00000000-0000-4000-8000-000000000322',
            base: { priority: '' }, patch: { priority: 'high' },
            checklist: { base: savedTask().checklist!, value: savedTask().checklist! } })).toMatchObject({ ok: false });

        const normal = await open(source({ checklist: [item('one', 'First', true)], status: 'next' }));
        const override = { id: 'checklist-task', requestId: id, base: {}, patch: {}, scheduleBase,
            checklist: { base: savedTask().checklist!, value: [item('one', 'Changed', true)] } };
        const planned = unwrap(normal.host.prepareTaskChecklistSave(override));
        expect(planned.kind).toBe('prepared');
        if (planned.kind !== 'prepared') return;
        unwrap(await normal.host.commitPreparedTaskChecklistWrite({ request: override, prepared: planned.prepared }));
        expect(savedTask().status).toBe('next');
    });

    it('saves a Reference list task with every entry ticked as a reference, never Done (#1416)', async () => {
        const { host } = await open(source({ status: 'reference', taskMode: 'list', checklist: [item('one', 'Alien', true), item('two', 'Brazil')] }));
        const value = [item('one', 'Alien', true), item('two', 'Brazil', true)];
        const request = { id: 'checklist-task', requestId: id, base: {}, patch: {}, scheduleBase,
            checklist: { base: savedTask().checklist!, value } };
        const prepared = unwrap(host.prepareTaskChecklistSave(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))).toEqual({ id: request.id });
        expect(savedTask()).toMatchObject({ status: 'reference', checklist: value });
        expect(savedTask().completedAt).toBeUndefined();
        expect(savedTask().isFocusedToday).toBeFalsy();
    });

    it('refuses a coherently rebound Reference priority even when status is omitted', async () => {
        const original = source({ status: 'reference', checklist: [item('one', 'Bullet')] });
        const { host, saves } = await open(original);
        const request = { id: original.id, requestId: id, base: {}, patch: {}, scheduleBase,
            checklist: { base: original.checklist!, value: [item('one', 'Edited bullet')] } };
        const prepared = unwrap(host.prepareTaskChecklistSave(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        const forged = structuredClone(prepared.prepared);
        const forbidden = { ...request, base: { priority: '' }, patch: { priority: 'high' } };
        forged.request = forbidden;
        forged.witness.direct.priority = 'high';
        const before = saves();
        expect(host.validatePreparedTaskChecklistWrite({ request: forbidden, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.commitPreparedTaskChecklistWrite({ request: forbidden, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);
    });

    it('validates a frozen terminal envelope before any write and refuses a partial child receipt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const original = source({ recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY' },
            dueDate: '2026-09-27' });
        const { host, saves } = await open(original);
        const request = { id: original.id, requestId: id, base: { status: 'next' }, patch: { status: 'done' },
            scheduleBase: { ...scheduleBase, dueDate: '2026-09-27' },
            checklist: { base: original.checklist!, value: original.checklist! } };
        const prepared = unwrap(host.prepareTaskChecklistSave(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        const tampered = structuredClone(prepared.prepared);
        tampered.effect.tasks.find((row) => row.after.id === original.id)!.after.status = 'archived';
        const before = saves();
        expect(host.validatePreparedTaskChecklistWrite({ request, prepared: tampered })).toMatchObject({ ok: false });
        expect(await host.commitPreparedTaskChecklistWrite({ request, prepared: tampered })).toMatchObject({ ok: false });
        expect(saves()).toBe(before);
        unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }));
        const child = prepared.prepared.effect.tasks.find((row) => !row.before)!.after;
        expect(useTaskStore.getState()._allTasks.filter((row) => row.id === child.id)).toHaveLength(1);
        unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }));
        expect(useTaskStore.getState()._allTasks.filter((row) => row.id === child.id)).toHaveLength(1);
        useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.filter((entry) => entry.id !== child.id) });
        expect(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('retries an owed persistence failure with the same frozen UUID and no second task revision', async () => {
        let failSave = false;
        const { host, saved, saves } = await open(source({ isFocusedToday: true, focusOrder: 3 }), { saveData: async () => {
            if (failSave) throw new Error('disk unavailable');
        } });
        const request = { id: 'checklist-task', requestId: id, base: { title: 'Before', focusedToday: true },
            patch: { title: 'After', focusedToday: false }, scheduleBase,
            checklist: { base: savedTask().checklist!, value: [item('one', 'First'), item('two', 'Second', true)] } };
        const prepared = unwrap(host.prepareTaskChecklistSave(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        failSave = true;
        expect(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(savedTask().rev).toBe(4);
        expect(saved().tasks.find((task) => task.id === request.id)?.title).toBe('Before');
        failSave = false;
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared })))
            .toEqual({ id: request.id });
        expect(savedTask()).toMatchObject({ title: 'After', isFocusedToday: false, rev: 4 });
        expect(saved().tasks.find((task) => task.id === request.id)).toMatchObject({ title: 'After', isFocusedToday: false, rev: 4 });
        const count = saves();
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings,
            gtd: { ...useTaskStore.getState().settings.gtd, autoArchiveDays: 7 } } });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2031-01-02T10:00:00.000Z'));
        expect(unwrap(await host.commitPreparedTaskChecklistWrite({ request, prepared: prepared.prepared })))
            .toEqual({ id: request.id });
        expect(savedTask().rev).toBe(4);
        expect(saves()).toBe(count);
    });

    it('refuses forged source, direct checklist/date fields and result before publication', async () => {
        const original = source({ dueDate: '2026-09-29' });
        const { host, saves } = await open(original);
        const request = { id: original.id, requestId: id, base: { dueDate: '2026-09-29' },
            patch: { dueDate: '2026-10-01' }, scheduleBase: { ...scheduleBase, dueDate: '2026-09-29' },
            checklist: { base: original.checklist!, value: [item('one', 'Changed'), item('two', 'Second')] } };
        const prepared = unwrap(host.prepareTaskChecklistSave(request));
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        const variants = [
            (value: typeof prepared.prepared) => { value.witness.source.title = 'Forged'; },
            (value: typeof prepared.prepared) => { value.witness.direct.checklist = [item('forged', 'Forged')]; },
            (value: typeof prepared.prepared) => { value.witness.direct.dueDate = '2031-01-01';
                value.effect.tasks.find((row) => row.after.id === original.id)!.after.dueDate = '2031-01-01'; },
            (value: typeof prepared.prepared) => { value.result.id = 'wrong-task'; },
        ];
        const before = saves();
        for (const mutate of variants) {
            const forged = structuredClone(prepared.prepared);
            mutate(forged);
            expect(host.validatePreparedTaskChecklistWrite({ request, prepared: forged })).toMatchObject({ ok: false });
            expect(await host.commitPreparedTaskChecklistWrite({ request, prepared: forged })).toMatchObject({ ok: false });
            expect(saves()).toBe(before);
        }
        expect(savedTask().rev).toBe(3);
    });

    it('refuses an archived parent before any checklist write', async () => {
        const archived: Project = { id: 'project-archived', title: 'Old', status: 'archived', color: '#94a3b8',
            order: 0, tagIds: [], createdAt: clock, updatedAt: clock };
        const { host, saves } = await open(source({ projectId: archived.id }), { projects: [archived] });
        const request = { id: 'checklist-task', requestId: id, base: {}, patch: {}, scheduleBase,
            checklist: { base: savedTask().checklist!, value: [item('one', 'Edited'), item('two', 'Second')] } };
        const before = saves();
        expect(host.prepareTaskChecklistSave(request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.prepareTaskChecklistReset({ id: request.id, requestId: id, checklistBase: savedTask().checklist! }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);

        const active = { ...archived, status: 'active' as const };
        const fresh = await open(source({ projectId: active.id }), { projects: [active] });
        const resetRequest = { id: request.id, requestId: id, checklistBase: savedTask().checklist! };
        const reset = unwrap(fresh.host.prepareTaskChecklistReset(resetRequest));
        expect(reset.kind).toBe('prepared');
        if (reset.kind !== 'prepared') return;
        const forged = structuredClone(reset.prepared);
        forged.witness.lists.projects[0].status = 'archived';
        expect(fresh.host.validatePreparedTaskChecklistWrite({ request: resetRequest, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('accepts more than 1,000 legitimate items but refuses an oversized whole request without writing', async () => {
        const list = Array.from({ length: 1_001 }, (_, index) => item(`item-${index}`, `Item ${index}`));
        const { host, saves } = await open(source({ checklist: list }));
        const edit = unwrap(host.editTaskChecklist({ id: 'checklist-task', draft: createTaskDraft(savedTask()),
            checklist: list, edit: { kind: 'toggle', index: 1_000 } }));
        expect(edit.checklist[1_000].isCompleted).toBe(true);
        const request = { id: 'checklist-task', requestId: id, base: {}, patch: {}, scheduleBase,
            checklist: { base: list, value: edit.checklist } };
        expect(unwrap(host.prepareTaskChecklistSave(request)).kind).toBe('prepared');
        const before = saves();
        expect(host.prepareTaskChecklistSave({ ...request, checklist: {
            base: list, value: [item('oversized', 'x'.repeat(2 * 1024 * 1024 + 1))] } })).toMatchObject({ ok: false });
        expect(host.prepareTaskChecklistSave({ ...request, checklist: {
            base: list, value: Array.from({ length: 100 }, (_, index) => item(`unicode-${index}`, '漢'.repeat(8_000)))
        } })).toMatchObject({ ok: false });
        const malformed = [item('bad', 'Bad') as Record<string, unknown>];
        malformed[0].unexpected = 1n;
        expect(host.editTaskChecklist({ id: request.id, draft: createTaskDraft(savedTask()),
            checklist: malformed as never, edit: { kind: 'toggle', index: 0 } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);
    });
});

describe('prepared task completion and Undo', () => {
    const completionRequest = (host: Awaited<ReturnType<typeof open>>['host'], requestId =
        '00000000-0000-4000-8000-000000000401') => ({
        id: 'checklist-task', requestId, taskRevision: unwrap(host.getTaskView({ id: 'checklist-task' })).taskRevision,
    });
    it('completes a displayed task once and restores its status with an exact Undo envelope', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const original = source({ isFocusedToday: true, focusOrder: 2 });
        const { host } = await open(original);
        const request = { id: original.id, requestId: '00000000-0000-4000-8000-000000000401',
            taskRevision: unwrap(host.getTaskView({ id: original.id })).taskRevision };
        const completion = unwrap(host.prepareTaskCompletion(request));
        expect(completion.kind).toBe('prepared');
        expect(unwrap(host.validatePreparedTaskCompletion({ request, prepared: completion.prepared })))
            .toMatchObject({ id: original.id, completion: { completedAt: clock, undoEnabled: true } });
        expect(unwrap(await host.commitPreparedTaskCompletion({ request, prepared: completion.prepared })))
            .toEqual(completion.prepared.result);
        expect(savedTask()).toMatchObject({ status: 'done', completedAt: clock, isFocusedToday: false });

        const undoRequest = { requestId: '00000000-0000-4000-8000-000000000402',
            completionRequestId: request.requestId };
        const undo = unwrap(host.prepareTaskCompletionUndo({ request: undoRequest,
            completion: { request, prepared: completion.prepared } }));
        expect(undo.kind).toBe('prepared');
        expect(unwrap(host.validatePreparedTaskCompletionUndo({ request: undoRequest, prepared: undo.prepared })))
            .toEqual({ id: original.id });
        expect(unwrap(await host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo.prepared })))
            .toEqual({ id: original.id });
        expect(savedTask()).toMatchObject({ status: 'next', isFocusedToday: true });
        expect(savedTask().completedAt).toBeUndefined();
    });

    it('freezes a bounded notice for a valid long or multiline title without changing task content', async () => {
        const title = `First\n${'A'.repeat(700)}`;
        const { host } = await open(source({ title }));
        const request = completionRequest(host);
        const prepared = unwrap(host.prepareTaskCompletion(request)).prepared;
        expect(prepared.notice.message).toBe(en['common.done']);
        expect(unwrap(await host.commitPreparedTaskCompletion({ request, prepared }))).toEqual(prepared.result);
        expect(savedTask().title).toBe(title);
        expect(unwrap(host.validatePreparedTaskCompletion({ request, prepared }))).toEqual(prepared.result);
    });

    it('tombstones only the occurrence this completion created and retains a later source note', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const { host } = await open(source({ dueDate: '2026-09-27',
            recurrence: { rule: 'daily', strategy: 'strict' } }));
        const request = completionRequest(host);
        const prepared = unwrap(host.prepareTaskCompletion(request)).prepared;
        const owned = prepared.checklist.effect.tasks.find((row) => row.before === null)?.after;
        expect(owned).toBeDefined();
        unwrap(await host.commitPreparedTaskCompletion({ request, prepared }));
        expect((await useTaskStore.getState().updateTask(request.id, { description: 'Later note' })).success).toBe(true);
        const undoRequest = { requestId: '00000000-0000-4000-8000-000000000402',
            completionRequestId: request.requestId };
        const undo = unwrap(host.prepareTaskCompletionUndo({ request: undoRequest,
            completion: { request, prepared } })).prepared;
        expect(undo.effect.tasks.map((row) => row.after.id)).toEqual([request.id, owned!.id]);
        unwrap(await host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo }));
        expect(savedTask()).toMatchObject({ status: 'next', description: 'Later note' });
        expect(useTaskStore.getState()._tasksById.get(owned!.id)?.deletedAt).toBeTruthy();
    });

    it('refuses an edited owned occurrence and forged completion before writing', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const { host, saves } = await open(source({ dueDate: '2026-09-27',
            recurrence: { rule: 'daily', strategy: 'strict' } }));
        const request = completionRequest(host);
        const prepared = unwrap(host.prepareTaskCompletion(request)).prepared;
        unwrap(await host.commitPreparedTaskCompletion({ request, prepared }));
        const child = prepared.checklist.effect.tasks.find((row) => row.before === null)!.after;
        const forged = structuredClone(prepared);
        forged.checklist.effect.tasks.find((row) => row.before === null)!.after.title = 'Forged child';
        const before = saves();
        expect(host.taskCompletionOutcome({ request, prepared: forged })).toMatchObject({ ok: false });
        expect(host.prepareTaskCompletionUndo({ request: { requestId: '00000000-0000-4000-8000-000000000402',
            completionRequestId: request.requestId }, completion: { request, prepared: forged } }))
            .toMatchObject({ ok: false });
        expect(saves()).toBe(before);
        expect((await useTaskStore.getState().updateTask(child.id, { title: 'Edited child' })).success).toBe(true);
        expect(host.prepareTaskCompletionUndo({ request: { requestId: '00000000-0000-4000-8000-000000000402',
            completionRequestId: request.requestId }, completion: { request, prepared } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('uses the saved UUID receipt after a cold boot and later edit, never target equality', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const sqlite = await openSqliteHost({ tasks: [source({ dueDate: '2026-09-27',
            recurrence: { rule: 'daily', strategy: 'strict' } })], settings: { deviceId: 'device-a' } });
        try {
            const request = completionRequest(sqlite.host);
            const prepared = unwrap(sqlite.host.prepareTaskCompletion(request)).prepared;
            const alternate = unwrap(sqlite.host.prepareTaskCompletion(request)).prepared;
            expect(alternate.checklist.witness.ids).not.toEqual(prepared.checklist.witness.ids);
            expect(unwrap(sqlite.host.validatePreparedTaskCompletion({ request, prepared: alternate }))).toEqual(alternate.result);
            expect(unwrap(await sqlite.host.commitPreparedTaskCompletion({ request, prepared }))).toEqual(prepared.result);
            const otherRequest = { ...request, requestId: '00000000-0000-4000-8000-000000000403' };
            const otherPrepared = structuredClone(prepared);
            otherPrepared.request = otherRequest;
            otherPrepared.checklist.request.requestId = otherRequest.requestId;
            expect(unwrap(sqlite.host.validatePreparedTaskCompletion({ request: otherRequest, prepared: otherPrepared })))
                .toEqual(prepared.result);
            expect(await sqlite.host.commitPreparedTaskCompletion({ request: otherRequest, prepared: otherPrepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(sqlite.host.taskCompletionOutcome({ request, prepared: alternate }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect((await useTaskStore.getState().updateTask(request.id, { description: 'Later edit' })).success).toBe(true);
            await flushPendingSave();
            await sqlite.restart();
            vi.setSystemTime(new Date('2028-02-03T12:00:00.000Z'));
            expect(await sqlite.host.setLanguage({ storedLanguage: 'de', systemLocale: 'de-DE' })).toMatchObject({ ok: true });
            expect(unwrap(sqlite.host.taskCompletionOutcome({ request, prepared }))).toEqual(prepared.result);
            const receiptIds = await sqlite.receiptIds();
            const beforeReplay = structuredClone(useTaskStore.getState()._allTasks);
            expect(unwrap(await sqlite.host.commitPreparedTaskCompletion({ request, prepared }))).toEqual(prepared.result);
            expect(useTaskStore.getState()._allTasks).toEqual(beforeReplay);
            expect(await sqlite.receiptIds()).toEqual(receiptIds);
            expect(useTaskStore.getState()._tasksById.get(request.id)?.description).toBe('Later edit');
            const undoRequest = { requestId: '00000000-0000-4000-8000-000000000402',
                completionRequestId: request.requestId };
            const undo = unwrap(sqlite.host.prepareTaskCompletionUndo({ request: undoRequest,
                completion: { request, prepared } })).prepared;
            expect(unwrap(sqlite.host.taskCompletionUndoOutcome({ request: undoRequest, prepared: undo }))).toBeNull();
            expect(unwrap(await sqlite.host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo })))
                .toEqual({ id: request.id });
            const otherUndoRequest = { ...undoRequest, requestId: '00000000-0000-4000-8000-000000000404' };
            const otherUndo = structuredClone(undo);
            otherUndo.request = otherUndoRequest;
            expect(unwrap(sqlite.host.validatePreparedTaskCompletionUndo({ request: otherUndoRequest, prepared: otherUndo })))
                .toEqual({ id: request.id });
            expect(await sqlite.host.commitPreparedTaskCompletionUndo({ request: otherUndoRequest, prepared: otherUndo }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect((await useTaskStore.getState().updateTask(request.id, { title: 'Even later title' })).success).toBe(true);
            await flushPendingSave();
            vi.setSystemTime(new Date(clock));
            await sqlite.restart();
            vi.setSystemTime(new Date('2028-02-03T12:00:00.000Z'));
            expect(unwrap(sqlite.host.taskCompletionUndoOutcome({ request: undoRequest, prepared: undo })))
                .toEqual({ id: request.id });
            const undoReceiptIds = await sqlite.receiptIds();
            const beforeUndoReplay = structuredClone(useTaskStore.getState()._allTasks);
            expect(unwrap(await sqlite.host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo })))
                .toEqual({ id: request.id });
            expect(useTaskStore.getState()._allTasks).toEqual(beforeUndoReplay);
            expect(await sqlite.receiptIds()).toEqual(undoReceiptIds);
            expect(savedTask().title).toBe('Even later title');
        } finally { await sqlite.close(); }
    });

    it('cold-undoes a legacy SQL-seeded series with show-future projection enabled', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-02T13:00:00.000Z'));
        const taskID = '00000000-0000-4000-8000-000000000405';
        const sqlite = await openSqliteHost({ tasks: [source({ id: taskID })], settings: { deviceId: 'device-a' } });
        try {
            await sqlite.client().run('UPDATE tasks SET status = ?, dueDate = ?, recurrence = ?, showFutureRecurrence = 1 WHERE id = ?',
                ['next', '2026-10-02', JSON.stringify({ rule: 'daily', strategy: 'strict', seriesId: taskID }), taskID]);
            await sqlite.restart();
            const request = { id: taskID, requestId: '00000000-0000-4000-8000-000000000401',
                taskRevision: unwrap(sqlite.host.getTaskView({ id: taskID })).taskRevision };
            const prepared = unwrap(sqlite.host.prepareTaskCompletion(request)).prepared;
            expect(prepared.checklist.effect.tasks.filter((row) => row.before === null)).toHaveLength(1);
            unwrap(await sqlite.host.commitPreparedTaskCompletion({ request, prepared }));
            const child = prepared.checklist.effect.tasks.find((row) => row.before === null)!.after;
            const reordered: Task = { ...child, recurrence: Object.fromEntries(
                Object.entries(child.recurrence as Record<string, unknown>).reverse()) as Task['recurrence'] };
            expect(samePreparedTask(reordered, child)).toBe(true);
            expect(samePreparedTask({ ...reordered, updatedAt: '2026-10-03T13:00:00.000Z' }, child)).toBe(false);
            await sqlite.client().run('UPDATE tasks SET recurrence = ? WHERE id = ?',
                [JSON.stringify(reordered.recurrence), child.id]);
            vi.setSystemTime(new Date('2026-10-04T13:00:00.000Z'));
            await sqlite.restart();
            const live = useTaskStore.getState()._tasksById.get(child.id)!;
            expect(live).toBeDefined();
            const undoRequest = { requestId: '00000000-0000-4000-8000-000000000402',
                completionRequestId: request.requestId };
            const result = sqlite.host.prepareTaskCompletionUndo({ request: undoRequest,
                completion: { request, prepared } });
            expect(result, JSON.stringify({ source: useTaskStore.getState()._tasksById.get(taskID), child: live,
                frozenChild: child })).toMatchObject({ ok: true });
        } finally { await sqlite.close(); }
    });

    it('keeps a large valid completion undoable within the nested journal bounds', async () => {
        const { host } = await open(source({ description: 'x'.repeat(390_000) }));
        const request = completionRequest(host);
        const prepared = unwrap(host.prepareTaskCompletion(request)).prepared;
        const completeBytes = Buffer.byteLength(JSON.stringify({ request, prepared }), 'utf8');
        expect(completeBytes).toBeGreaterThan(1_900_000);
        expect(completeBytes).toBeLessThanOrEqual(2_100_000);
        unwrap(await host.commitPreparedTaskCompletion({ request, prepared }));
        const undoRequest = { requestId: '00000000-0000-4000-8000-000000000402',
            completionRequestId: request.requestId };
        const undo = unwrap(host.prepareTaskCompletionUndo({ request: undoRequest,
            completion: { request, prepared } })).prepared;
        const undoBytes = Buffer.byteLength(JSON.stringify({ request: undoRequest, prepared: undo }), 'utf8');
        expect(undoBytes).toBeLessThanOrEqual(4_500_000);
        expect(unwrap(await host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo })))
            .toEqual({ id: request.id });
        expect(savedTask().description).toHaveLength(390_000);
    });

    it('cold-retries a failed SQLite completion COMMIT from the frozen request', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost({ tasks: [source()], settings: { deviceId: 'device-a' } },
            (client) => ({ ...client, run: async (sql, params) => {
                if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
                return client.run(sql, params);
            } }));
        try {
            const request = completionRequest(sqlite.host);
            const prepared = unwrap(sqlite.host.prepareTaskCompletion(request)).prepared;
            const rawBefore = await sqlite.sql('SELECT * FROM tasks ORDER BY id');
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedTaskCompletion({ request, prepared }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlite.sql('SELECT * FROM tasks ORDER BY id')).toEqual(rawBefore);
            fault.commits = 0;
            resetForTests();
            await sqlite.restart();
            expect(unwrap(await sqlite.host.commitPreparedTaskCompletion({ request, prepared }))).toEqual(prepared.result);
            expect(useTaskStore.getState()._allTasks).toHaveLength(1);
            expect(savedTask().status).toBe('done');
            await sqlite.restart();
            expect(unwrap(sqlite.host.taskCompletionOutcome({ request, prepared }))).toEqual(prepared.result);
        } finally { await sqlite.close(); }
    }, 30_000); // The injected failure exercises real exponential persistence backoff before cold recovery.

    it('cold-retries a failed SQLite completion Undo COMMIT without a partial child tombstone', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost({ tasks: [source({ dueDate: '2026-09-27',
            recurrence: { rule: 'daily', strategy: 'strict' } })], settings: { deviceId: 'device-a' } },
        (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {
            const request = completionRequest(sqlite.host);
            const prepared = unwrap(sqlite.host.prepareTaskCompletion(request)).prepared;
            unwrap(await sqlite.host.commitPreparedTaskCompletion({ request, prepared }));
            const undoRequest = { requestId: '00000000-0000-4000-8000-000000000402',
                completionRequestId: request.requestId };
            const undo = unwrap(sqlite.host.prepareTaskCompletionUndo({ request: undoRequest,
                completion: { request, prepared } })).prepared;
            const rawBefore = await sqlite.sql('SELECT * FROM tasks ORDER BY id');
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlite.sql('SELECT * FROM tasks ORDER BY id')).toEqual(rawBefore);
            fault.commits = 0;
            resetForTests();
            await sqlite.restart();
            expect(unwrap(await sqlite.host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo })))
                .toEqual({ id: request.id });
            expect(savedTask().status).toBe('next');
            const child = prepared.checklist.effect.tasks.find((row) => row.before === null)!.after;
            expect(useTaskStore.getState()._tasksById.get(child.id)?.deletedAt).toBeTruthy();
            await sqlite.restart();
            expect(unwrap(sqlite.host.taskCompletionUndoOutcome({ request: undoRequest, prepared: undo })))
                .toEqual({ id: request.id });
        } finally { await sqlite.close(); }
    });

    it('leaves a preexisting same-series follow-up alone when completion created no child', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(clock));
        const original = source({ dueDate: '2026-09-27', recurrence: { rule: 'daily', strategy: 'strict' } });
        const existing = createNextRecurringTask(original, clock, original.status)!;
        const { host } = await open(original, { tasks: [existing] });
        const request = completionRequest(host);
        const prepared = unwrap(host.prepareTaskCompletion(request)).prepared;
        expect(prepared.checklist.effect.tasks.filter((row) => row.before === null)).toHaveLength(0);
        unwrap(await host.commitPreparedTaskCompletion({ request, prepared }));
        const undoRequest = { requestId: '00000000-0000-4000-8000-000000000402',
            completionRequestId: request.requestId };
        const undo = unwrap(host.prepareTaskCompletionUndo({ request: undoRequest,
            completion: { request, prepared } })).prepared;
        expect(undo.effect.tasks).toHaveLength(1);
        unwrap(await host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo }));
        expect(useTaskStore.getState()._tasksById.get(existing.id)?.deletedAt).toBeUndefined();
    });

    it('restores the prior Today star only while the shared focus cap has room', async () => {
        const original = source({ isFocusedToday: true, focusOrder: 4 });
        const others = [1, 2, 3].map((index) => source({ id: `other-${index}`, title: `Other ${index}`,
            isFocusedToday: index < 3 }));
        const { host } = await open(original, { tasks: others });
        const request = completionRequest(host);
        const prepared = unwrap(host.prepareTaskCompletion(request)).prepared;
        unwrap(await host.commitPreparedTaskCompletion({ request, prepared }));
        expect((await useTaskStore.getState().updateTask('other-3', { isFocusedToday: true })).success).toBe(true);
        const undoRequest = { requestId: '00000000-0000-4000-8000-000000000402',
            completionRequestId: request.requestId };
        const undo = unwrap(host.prepareTaskCompletionUndo({ request: undoRequest,
            completion: { request, prepared } })).prepared;
        expect(undo.effect.guards).toMatchObject({ focusCount: 3, focusLimit: 3 });
        const forged = structuredClone(undo);
        forged.witness.focusCount = 2;
        expect(host.validatePreparedTaskCompletionUndo({ request: undoRequest, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const coordinated = structuredClone(undo);
        coordinated.witness.focusCount = 4;
        coordinated.effect.guards.focusCount = 4;
        expect(unwrap(host.validatePreparedTaskCompletionUndo({ request: undoRequest, prepared: coordinated })))
            .toEqual({ id: request.id });
        expect(await host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: coordinated }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect((await useTaskStore.getState().updateTask('other-3', { isFocusedToday: false })).success).toBe(true);
        expect(await host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const refreshed = unwrap(host.prepareTaskCompletionUndo({ request: undoRequest,
            completion: { request, prepared } })).prepared;
        expect(refreshed.effect.guards).toMatchObject({ focusCount: 2, focusLimit: 3 });
        unwrap(await host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: refreshed }));
        expect(savedTask()).toMatchObject({ status: 'next', isFocusedToday: true });
        expect(savedTask().focusOrder).toBeUndefined();
    });
});
