import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusControlsWrites, loadFocusControlsFixture, seedFocusControlsStore } from './focus-controls.replay';
import { createNativeHostContract } from './native-host-contract';
import type { NativeSomedaySectionTaskEnvelope, NativeSomedaySectionTaskRequest } from './native-host-contract-someday-section-task';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { TASK_SQLITE_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import { generateUUID } from './uuid';

const fixture = loadFocusControlsFixture();
const base = fixture.scenarios.find((entry) => entry.settings === 'base' && !entry.taskIds)!;
type Host = ReturnType<typeof createNativeHostContract>;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const open = async (saveData?: (data: unknown) => Promise<void>): Promise<Host> => {
    await seedFocusControlsStore(fixture, base, { saveData });
    useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: generateUUID() } }));
    const host = createNativeHostContract();
    expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    focusControlsWrites().length = 0;
    return host;
};
const request = (title: string, sectionId: string | null = null): NativeSomedaySectionTaskRequest =>
    ({ requestId: generateUUID(), title, sectionId });
const prepare = (host: Host, input: NativeSomedaySectionTaskRequest): NativeSomedaySectionTaskEnvelope => ({
    request: input, prepared: value(host.prepareSomedaySectionTask(input)).prepared,
});
const sections = (raw: unknown) => useTaskStore.setState((state) => ({ settings: { ...state.settings,
    gtd: { ...state.settings.gtd, viewSections: { ...state.settings.gtd?.viewSections, someday: raw } } } } as typeof state));
const area = (id: string | null) => useTaskStore.setState((state) => ({ settings: { ...state.settings,
    gtd: { ...state.settings.gtd, defaultAreaMode: id ? 'fixed' : 'none', defaultAreaId: id } } }));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('checked native Someday section task creation', () => {
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    it('creates a literal trimmed Someday task with the configured default Area and No section', async () => {
        const host = await open();
        const areaId = useTaskStore.getState()._allAreas[0].id;
        area(areaId);
        sections([{ id: 'no-section', title: 'Imported named section', order: 0 }]);
        const options = value(host.getSomedaySectionTaskOptions({ sectionId: null }));
        expect(options.groupTitle).toBe('No section');
        expect(options.text.title).toContain('No section');
        const input = request('  Read +Garden tomorrow 🌱  ');
        const envelope = prepare(host, input);
        expect(envelope.prepared.task).toMatchObject({ id: input.requestId, title: 'Read +Garden tomorrow 🌱',
            status: 'someday', areaId, isFocusedToday: false, rev: 1 });
        expect(envelope.prepared.task.viewSectionIds).toBeUndefined();
        const before = useTaskStore.getState();
        expect(value(host.validatePreparedSomedaySectionTask(envelope))).toEqual({ id: input.requestId });
        expect(value(await host.commitPreparedSomedaySectionTask(envelope))).toEqual({ id: input.requestId });
        const after = useTaskStore.getState();
        expect(after._allTasks).toHaveLength(before._allTasks.length + 1);
        expect(after._allTasks.find((task) => task.id === input.requestId)).toEqual(envelope.prepared.task);
        expect(after._allProjects).toEqual(before._allProjects);
        expect(after._allAreas).toEqual(before._allAreas);
        expect(after.settings.gtd?.viewSections).toEqual(before.settings.gtd?.viewSections);
        expect(value(host.probeSomedaySectionTaskOutcome(envelope))).toEqual({ id: input.requestId });
    });

    it('uses a uniquely visible named section and preserves hidden raw section rows', async () => {
        const host = await open();
        const raw = [{ id: 'ideas', title: 'Ideas', order: 2, future: { retained: true } },
            { id: 'hidden', future: 'unknown' }, { id: 'none', title: 'Named None', order: 3 }];
        sections(raw);
        const options = value(host.getSomedaySectionTaskOptions({ sectionId: 'none' }));
        expect(options.groupTitle).toBe('Named None');
        expect(value(host.getSomedaySectionTaskOptions({ sectionId: null })).groupTitle).toBe('No section');
        const namedNone = prepare(host, request('Named', 'none'));
        expect(namedNone.prepared.task.viewSectionIds).toEqual({ someday: 'none' });
        expect(value(await host.commitPreparedSomedaySectionTask(namedNone))).toEqual({ id: namedNone.request.requestId });
        const input = request('  Idea  ', 'ideas');
        const envelope = prepare(host, input);
        expect(envelope.prepared.task.viewSectionIds).toEqual({ someday: 'ideas' });
        expect(envelope.prepared.sectionWitness).toEqual(raw[0]);
        expect(value(await host.commitPreparedSomedaySectionTask(envelope))).toEqual({ id: input.requestId });
        expect(useTaskStore.getState().settings.gtd?.viewSections?.someday).toEqual(raw);
        expect(focusControlsWrites()).toEqual([]);
    });

    it('rejects malformed requests, ambiguous section IDs, and unavailable sections without writing', async () => {
        const host = await open();
        sections([{ id: 'same', title: 'Ideas', order: 1 }, { id: 'same', title: 'Other', order: 2 }]);
        expect(host.getSomedaySectionTaskOptions({ sectionId: 'same' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.prepareSomedaySectionTask(request('Idea', 'same'))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const input of [
            { ...request('Good'), requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
            request('   '), request('bad\0title'), request('bad\ud800title'),
            request('x'.repeat(10_001)), request('Idea', 'missing'),
            { ...request('Idea'), extra: true },
        ]) expect(host.prepareSomedaySectionTask(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(focusControlsWrites()).toEqual([]);
    });

    it('keeps a landed task after SAVE_FAILED and retries the exact frozen row once', async () => {
        let failSave = false;
        const host = await open(async () => { if (failSave) throw new Error('disk unavailable'); });
        const envelope = prepare(host, request('Ideas'));
        failSave = true;
        const first = await host.commitPreparedSomedaySectionTask(envelope);
        expect(first).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState()._allTasks.filter((task) => task.id === envelope.request.requestId)).toHaveLength(1);
        failSave = false;
        expect(value(await host.commitPreparedSomedaySectionTask(envelope))).toEqual({ id: envelope.request.requestId });
        expect(useTaskStore.getState()._allTasks.filter((task) => task.id === envelope.request.requestId)).toHaveLength(1);
    });

    it('recognizes the full target row after SQLite hydration on a cold host', async () => {
        const host = await open();
        const envelope = prepare(host, request('Persisted idea'));
        expect(value(await host.commitPreparedSomedaySectionTask(envelope))).toEqual({ id: envelope.request.requestId });
        const row = taskToSqliteRow(envelope.prepared.task);
        const hydrated = taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, row[index]])));
        expect(hydrated.recurrence).toBeNull();
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((task) =>
            task.id === envelope.request.requestId ? hydrated : task) }));
        expect(value(host.probeSomedaySectionTaskOutcome(envelope))).toEqual({ id: envelope.request.requestId });
        const restarted = createNativeHostContract();
        await restarted.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' });
        await restarted.activate({ writeSafetyReady: true });
        expect(useTaskStore.getState()._allTasks.filter((task) => task.id === envelope.request.requestId)).toHaveLength(1);
        expect(value(restarted.probeSomedaySectionTaskOutcome(envelope))).toEqual({ id: envelope.request.requestId });
        expect(value(await restarted.commitPreparedSomedaySectionTask(envelope))).toEqual({ id: envelope.request.requestId });
        expect(useTaskStore.getState()._allTasks.filter((task) => task.id === envelope.request.requestId)).toHaveLength(1);
    });

    it('replays after host recreation and unrelated settings/default Area change', async () => {
        const host = await open();
        const areaId = useTaskStore.getState()._allAreas[0].id;
        area(areaId);
        sections([{ id: 'ideas', title: 'Ideas', order: 0 }, { hidden: 'future' }]);
        const envelope = prepare(host, request('  An idea  ', 'ideas'));
        const original = clone(envelope.prepared.task);
        area(null);
        await useTaskStore.getState().updateSettings({ gtd: { ...useTaskStore.getState().settings.gtd,
            focusGroupBy: 'context' } });
        await flushPendingSave();
        const restarted = createNativeHostContract();
        await restarted.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' });
        await restarted.activate({ writeSafetyReady: true });
        expect(useTaskStore.getState().settings.gtd?.viewSections?.someday).toEqual([
            { id: 'ideas', title: 'Ideas', order: 0 }, { hidden: 'future' },
        ]);
        expect(value(restarted.getSomedaySectionTaskOptions({ sectionId: 'ideas' })).groupTitle).toBe('Ideas');
        expect(value(await restarted.commitPreparedSomedaySectionTask(envelope))).toEqual({ id: envelope.request.requestId });
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === envelope.request.requestId)).toEqual(original);
        expect(useTaskStore.getState().settings.gtd?.defaultAreaMode).toBe('none');
        expect(value(restarted.probeSomedaySectionTaskOutcome(envelope))).toEqual({ id: envelope.request.requestId });
    });

    it('refuses same-ID edits/deletes and section rename/delete before first apply', async () => {
        const host = await open();
        sections([{ id: 'ideas', title: 'Ideas', order: 0 }]);
        const envelope = prepare(host, request('Idea', 'ideas'));
        const before = useTaskStore.getState()._allTasks;
        sections([{ id: 'ideas', title: 'Renamed', order: 0 }]);
        expect(await host.commitPreparedSomedaySectionTask(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        sections([]);
        expect(await host.commitPreparedSomedaySectionTask(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allTasks).toBe(before);
        sections([{ id: 'ideas', title: 'Ideas', order: 0 }]);
        useTaskStore.setState((state) => ({ _allTasks: [...state._allTasks,
            { ...envelope.prepared.task, title: 'Different', rev: 2 }] }));
        expect(await host.commitPreparedSomedaySectionTask(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((task) => task.id === envelope.request.requestId
            ? { ...task, deletedAt: '2026-09-29T00:00:00.000Z' } : task) }));
        expect(host.probeSomedaySectionTaskOutcome(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('refuses a removed default Area before first apply without following newer defaults', async () => {
        const host = await open();
        const areaId = useTaskStore.getState()._allAreas[0].id;
        area(areaId);
        const envelope = prepare(host, request('Idea'));
        area(null);
        useTaskStore.setState((state) => ({ _allAreas: state._allAreas.map((row) => row.id === areaId
            ? { ...row, deletedAt: '2026-09-29T00:00:00.000Z' } : row) }));
        expect(await host.commitPreparedSomedaySectionTask(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allTasks.some((task) => task.id === envelope.request.requestId)).toBe(false);
    });

    it('does not acknowledge a saved receipt after the created task is edited or deleted', async () => {
        const host = await open();
        const envelope = prepare(host, request('Idea'));
        expect(value(await host.commitPreparedSomedaySectionTask(envelope))).toEqual({ id: envelope.request.requestId });
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((task) => task.id === envelope.request.requestId
            ? { ...task, title: 'Changed', rev: (task.rev ?? 0) + 1 } : task) }));
        expect(await host.commitPreparedSomedaySectionTask(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const restarted = createNativeHostContract();
        await restarted.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' });
        await restarted.activate({ writeSafetyReady: true });
        // Recreate the later edit after activation reloads the saved snapshot.
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((task) => task.id === envelope.request.requestId
            ? { ...task, deletedAt: '2026-09-29T00:00:00.000Z', rev: (task.rev ?? 0) + 1 } : task) }));
        expect(restarted.probeSomedaySectionTaskOutcome(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await restarted.commitPreparedSomedaySectionTask(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('rejects forged and malformed cold envelopes before any write', async () => {
        const host = await open();
        sections([{ id: 'ideas', title: 'Ideas', order: 0 }]);
        const envelope = prepare(host, request('Idea', 'ideas'));
        const variants: unknown[] = [
            { ...envelope, extra: true },
            { ...envelope, prepared: { ...envelope.prepared, extra: true } },
            { ...envelope, prepared: { ...envelope.prepared, request: { ...envelope.request, title: 'Different' } } },
            { ...envelope, prepared: { ...envelope.prepared, task: { ...envelope.prepared.task, title: 'Different' } } },
            { ...envelope, prepared: { ...envelope.prepared, task: { ...envelope.prepared.task, areaId: 'other' } } },
            { ...envelope, prepared: { ...envelope.prepared, result: { id: generateUUID() } } },
            { ...envelope, prepared: { ...envelope.prepared, sectionWitness: { id: 'other', title: 'Ideas', order: 0 } } },
            { ...envelope, prepared: { ...envelope.prepared, preparedAt: 'yesterday' } },
        ];
        for (const variant of variants) {
            expect(host.validatePreparedSomedaySectionTask(variant)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await host.commitPreparedSomedaySectionTask(variant as NativeSomedaySectionTaskEnvelope))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(useTaskStore.getState()._allTasks.some((task) => task.id === envelope.request.requestId)).toBe(false);
    });
    it('creates the row under Skip as RN addTask does, and keeps an earlier Send journal valid', async () => {
        const host = await open();
        useTaskStore.setState((state) => ({ settings: { ...state.settings, taskReminderDefault: 'skip' } }));
        const skipped = prepare(host, request('Someday under Skip'));
        expect(skipped.prepared.task.suppressMindwtrReminders).toBe(true);
        const ordinary = await useTaskStore.getState().addTask('Reference', { status: 'someday' });
        expect(useTaskStore.getState()._tasksById.get(ordinary.id!)?.suppressMindwtrReminders).toBe(true);
        useTaskStore.setState((state) => ({ settings: { ...state.settings, taskReminderDefault: undefined } }));
        const sent = prepare(host, request('Someday under Send'));
        expect(sent.prepared.task.suppressMindwtrReminders).toBe(false);
        expect(skipped.prepared.version).toBe(1); expect(skipped.prepared).not.toHaveProperty('taskReminderDefault');
        useTaskStore.setState((state) => ({ settings: { ...state.settings, taskReminderDefault: 'skip' } }));
        expect(value(host.validatePreparedSomedaySectionTask(sent))).toEqual({ id: sent.request.requestId });
        useTaskStore.setState((state) => ({ settings: { ...state.settings, taskReminderDefault: undefined } }));
        expect(value(await host.commitPreparedSomedaySectionTask(skipped))).toEqual({ id: skipped.request.requestId });
        expect(useTaskStore.getState()._tasksById.get(skipped.request.requestId)?.suppressMindwtrReminders).toBe(true);
    });
});
