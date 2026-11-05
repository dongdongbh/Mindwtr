import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';

const item = (id: string, title: string, isCompleted = false) => ({ id, title, isCompleted });
const task = (patch: Partial<Task> = {}): Task => ({
    id: 'resume', title: 'Opening', status: 'next', taskMode: 'list',
    createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
    contexts: ['home'], tags: [], checklist: [item('duplicate', 'One'), item('duplicate', 'Two')],
    ...patch,
});
const scheduleBase = { startTime: null, dueDate: null, relativeStartOffset: null, reviewAt: null };
const lifecycleBase = { status: 'next', focusedToday: true, completedAt: '' };

async function open(initial = task(), projects: Project[] = []) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [initial], projects, sections: [], areas: [], people: [],
        settings: { deviceId: 'device-a' } };
    let writes = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        data = JSON.parse(JSON.stringify(next)) as AppData;
        writes++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    return { host, saved: () => data, writes: () => writes,
        external: (next: Partial<Task>) => { data = { ...data, tasks: [{ ...data.tasks[0], ...next }] }; } };
}

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
});

describe('native editor resume opening-base check', () => {
    it('checks raw-only token, estimate, assignee and Time Spent bases without a canonical patch', async () => {
        const env = await open(task({ timeSpentMinutes: 5 }));
        const before = JSON.stringify(env.saved());
        const writes = env.writes();
        for (const touchedBase of [
            { contexts: 'home' }, { timeEstimate: '' }, { assignedTo: '' }, { timeSpentMinutes: 5 },
        ]) {
            expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase })).toMatchObject({
                ok: true, value: { kind: 'ready' },
            });
        }
        expect(env.writes()).toBe(writes);
        expect(JSON.stringify(env.saved())).toBe(before);
        env.external({ contexts: ['office'], timeEstimate: '10m', assignedTo: 'Alex', timeSpentMinutes: 17 });
        for (const touchedBase of [
            { contexts: 'home' }, { timeEstimate: '' }, { assignedTo: '' }, { timeSpentMinutes: 5 },
        ]) {

            expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase })).toMatchObject({
                ok: false, error: { code: 'STALE_REVISION' },
            });
        }
        expect(env.writes()).toBe(writes);
    });

    it('checks reminder policy and absent or set advance reminder bases', async () => {
        const env = await open(task({ reminderPolicy: 'inherit', dueReminderLeadMinutes: 60 }));
        const touchedBase = { reminderPolicy: 'inherit', dueReminderLeadMinutes: 60, startReminderLeadMinutes: null };
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase })).toMatchObject({ ok: true, value: { kind: 'ready' } });
        env.external({ dueReminderLeadMinutes: 30 });
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: { startReminderLeadMinutes: 13 } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('preserves complete schedule and checklist witnesses, including duplicate legacy IDs and order', async () => {
        const env = await open();
        const originalChecklist = env.saved().tasks[0].checklist!;
        expect(await env.host.checkTaskEditorResume({ id: 'resume',
            touchedBase: { startTime: '', dueDate: '', relativeStartOffset: null, reviewAt: '' },
            scheduleBase, checklistBase: originalChecklist })).toMatchObject({ ok: true, value: { kind: 'ready' } });
        env.external({ reviewAt: '2026-10-01T10:00:00.000Z', checklist: [originalChecklist[1], originalChecklist[0]] });
        expect(await env.host.checkTaskEditorResume({ id: 'resume',
            touchedBase: { startTime: '', dueDate: '', relativeStartOffset: null, reviewAt: '' },
            scheduleBase })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: {}, checklistBase: originalChecklist }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('rejects a schedule draft that contradicts its matching raw opening witness', async () => {
        const env = await open();
        const before = JSON.stringify(env.saved());
        const writes = env.writes();
        expect(await env.host.checkTaskEditorResume({ id: 'resume',
            scheduleBase, touchedBase: { startTime: '2026-10-02', dueDate: '', relativeStartOffset: null, reviewAt: '' },
        })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.writes()).toBe(writes);
        expect(JSON.stringify(env.saved())).toBe(before);
    });

    it('rejects a recurrence draft that contradicts its matching normalized opening witness', async () => {
        const env = await open();
        const opened = env.host.getTaskEditorModel({ id: 'resume' });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const before = JSON.stringify(env.saved());
        const writes = env.writes();
        expect(await env.host.checkTaskEditorResume({ id: 'resume', recurrenceBase: opened.value.recurrenceBase,
            touchedBase: { recurrence: '', recurrenceStrategy: 'fluid', recurrenceRRule: '', showFutureRecurrence: false },
        })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.writes()).toBe(writes);
        expect(JSON.stringify(env.saved())).toBe(before);
    });

    it('accepts unrelated changes and returns fresh witnesses only for unowned fields and groups', async () => {
        const env = await open(task({ description: 'Original note' }));
        env.external({ description: 'External note', dueDate: '2026-10-01T10:00:00.000Z',
            checklist: [item('duplicate', 'New'), item('duplicate', 'Two')] });
        const result = await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: { title: 'Opening' } });
        expect(result).toMatchObject({ ok: true, value: { kind: 'ready',
            freshDraft: { title: 'Opening', description: 'External note' },
            freshScheduleBase: { dueDate: '2026-10-01T10:00:00.000Z' },
            freshChecklistBase: [item('duplicate', 'New'), item('duplicate', 'Two')],
        } });
    });

    it('compares normalized legacy Time Spent and complete recurrence/association groups', async () => {
        const originalRecurrence = { rule: 'daily' as const, strategy: 'strict' as const, rrule: 'FREQ=DAILY' };
        const env = await open(task({ timeSpentMinutes: 17.6, recurrence: originalRecurrence }));
        const opened = env.host.getTaskEditorModel({ id: 'resume' });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: { timeSpentMinutes: 18 } }))
            .toMatchObject({ ok: true, value: { kind: 'ready', freshDraft: { timeSpentMinutes: 18 } } });
        const recurrenceBase = opened.value.recurrenceBase;
        const recurrenceTouched = Object.fromEntries(['recurrence', 'recurrenceStrategy', 'recurrenceRRule',
            'showFutureRecurrence'].map((field) => [field, opened.value.draft[field as keyof typeof opened.value.draft]]));
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: recurrenceTouched, recurrenceBase }))
            .toMatchObject({ ok: true, value: { kind: 'ready' } });
        env.external({ timeSpentMinutes: 18, recurrence: { ...originalRecurrence, rule: 'weekly', rrule: 'FREQ=WEEKLY' },
            areaId: 'elsewhere' });
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: { timeSpentMinutes: 18 } }))
            .toMatchObject({ ok: true, value: { kind: 'ready' } });
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: recurrenceTouched, recurrenceBase }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: {
            projectId: '', areaId: '', sectionId: '',
        } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('rejects complete lifecycle target equality and incomplete owned groups', async () => {
        const env = await open(task({ isFocusedToday: true }));
        env.external({ isFocusedToday: false });
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: lifecycleBase }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        for (const input of [
            { touchedBase: { focusedToday: true } },
            { touchedBase: { projectId: '' } },
            { touchedBase: { recurrence: '' } },
            { touchedBase: { dueDate: '' }, scheduleBase },
            { touchedBase: {}, scheduleBase },
        ]) {
            expect(await env.host.checkTaskEditorResume({ id: 'resume', ...input }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('rejects malformed values, missing tasks and read-only targets without writing', async () => {
        const env = await open();
        const writes = env.writes();
        for (const touchedBase of [
            { focusedToday: false, status: 'next', completedAt: null },
            { timeSpentMinutes: true },
            JSON.parse('{"__proto__":"polluted"}'),
        ]) {
            expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(await env.host.checkTaskEditorResume({ id: 'other', touchedBase: { title: 'Opening' } }))
            .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        const archived: Project = { id: 'project-archived', title: 'Old', status: 'archived', color: '#94a3b8',
            order: 0, tagIds: [], createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' };
        const locked = await open(task({ projectId: archived.id }), [archived]);
        expect(await locked.host.checkTaskEditorResume({ id: 'resume', touchedBase: { title: 'Opening' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.writes()).toBe(writes);
    });

    it('returns retryable failure while persistence is queued, without flushing it', async () => {
        const env = await open();
        expect((await useTaskStore.getState().updateTask('resume', { description: 'Queued' })).success).toBe(true);
        expect(getPersistenceStatus().queued).toBeGreaterThan(0);
        const writes = env.writes();
        expect(await env.host.checkTaskEditorResume({ id: 'resume', touchedBase: { title: 'Opening' } }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.writes()).toBe(writes);
    });
});
