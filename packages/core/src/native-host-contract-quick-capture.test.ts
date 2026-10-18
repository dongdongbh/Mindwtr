import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureDateFormatting } from './date';
import { createNativeHostContract } from './native-host-contract';
import type { NativeQuickCaptureView } from './native-host-contract-quick-capture';
import { requestRowId } from './native-request-receipts';
import type { QuickCaptureOptions } from './quick-capture-model';
import { loadQuickCaptureFixture, seedQuickCaptureStore, type QuickCaptureFixture } from './quick-capture-model.replay';
import { replayAfterRestart } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { generateUUID } from './uuid';

const fixture = loadQuickCaptureFixture();

describe('native host contract: the capture popup', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = fixture.timeZone;
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        configureDateFormatting();
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    const openHost = async (settings = 'base', saveData?: (data: unknown) => Promise<void>, data: QuickCaptureFixture = fixture) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const recorder = await seedQuickCaptureStore(data, { settings }, { saveData });
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: null })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        recorder.log.length = 0;
        return { host, recorder };
    };
    const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.value;
    };
    const writes = (log: unknown[]) => log.map((entry) => (entry as unknown[])[0]);
    const chip = (view: NativeQuickCaptureView, kind: string) => view.preview.find((entry) => entry.kind === kind)?.value;

    it('opens with the default area and carries the edit on every control', async () => {
        const { host } = await openHost('fixedArea');
        const view = value(host.openQuickCapture());
        expect(view.options).toEqual({
            note: '', dueDate: null, dueDateHasTime: false, startTime: null, contexts: [],
            projectId: null, areaId: 'a-home', priority: null, focus: false, addAnother: false,
        });
        expect(view.canSave).toBe(false);
        expect(view.area).toEqual({ label: 'Home', accessibilityLabel: 'Area: Home', reset: { type: 'selectArea', areaId: null } });
        expect(view.priority).toEqual({ label: 'Priority', accessibilityLabel: 'Priority: Priority', value: null, reset: { type: 'setPriority', priority: null } });
        expect(view.due.quickDates.map((entry) => [entry.label, entry.edit])).toEqual([
            ['Today', { type: 'setDueDay', day: '2026-09-23' }],
            ['Tomorrow', { type: 'setDueDay', day: '2026-09-24' }],
            ['Next week', { type: 'setDueDay', day: '2026-09-28' }],
        ]);
        expect(view.addAnother.edit).toEqual({ type: 'setAddAnother', value: true });

        const picked = value(host.editQuickCapture({ text: 'Plan', options: view.options, edit: view.due.quickDates[1].edit }));
        expect(picked.notice).toBeNull();
        expect(picked.view.due.quickDates[1]).toMatchObject({ selected: true, edit: { type: 'clearDueDate' } });
        expect(picked.view.due.time?.clear).toEqual({ type: 'clearDueTime' });

        const partial = value(host.getQuickCaptureView({ text: 'Plan', options: picked.view.options, picker: { kind: 'project', query: 'home' } }));
        expect(partial.picker).toMatchObject({ kind: 'project', total: 1, create: { label: 'Create "home"', accessibilityLabel: 'Create: home' } });
        const projects = value(host.getQuickCaptureView({ text: 'Plan', options: picked.view.options, picker: { kind: 'project', query: 'home repairs' } }));
        expect(projects.picker).toMatchObject({
            kind: 'project', query: 'home repairs', total: 1, create: null,
            items: [{ id: 'p-home', label: 'Home Repairs', edit: { type: 'selectProject', projectId: 'p-home' } }],
        });
        const contexts = value(host.getQuickCaptureView({ text: 'Plan', options: picked.view.options, picker: { kind: 'context', query: 'home off' } }));
        expect(contexts.picker).toMatchObject({
            kind: 'context',
            add: { label: 'home off', edit: { type: 'addContexts', query: 'home off' } },
            items: [{ label: '@home office', selected: false, edit: { type: 'toggleContext', value: '@home office' } }],
        });
    });

    it('keeps archived contexts out of blank capture choices but finds them when typed', async () => {
        const { host } = await openHost();
        const state = useTaskStore.getState();
        const base = state._allTasks[0]!;
        useTaskStore.setState({ _allTasks: [
            ...state._allTasks,
            { ...base, id: 'archived-only', status: 'archived', contexts: ['@archived-only'] },
            { ...base, id: 'deleted-only', deletedAt: '2026-09-27T00:00:00.000Z', contexts: ['@deleted-only'] },
        ] });
        const options = value(host.openQuickCapture()).options;
        const picker = (query: string) => value(host.getQuickCaptureView({ text: 'Plan', options, picker: { kind: 'context', query } })).picker;
        expect(picker('')?.items.some((item) => item.label === '@archived-only')).toBe(false);
        expect(picker('arch')?.items).toMatchObject([{ label: '@archived-only' }]);
        expect(picker('@home office, arch')?.items).toMatchObject([{ label: '@archived-only' }]);
        expect(picker('dele')?.items).toEqual([]);
    });

    it('formats dates with the user\'s settings, never the global configuration', async () => {
        const { host } = await openHost('base');
        await useTaskStore.getState().updateSettings({ dateFormat: 'ymd' });
        configureDateFormatting({ language: 'de' });
        const view = value(host.openQuickCapture());
        const edited = value(host.editQuickCapture({ text: 'Pay rent /start:friday', options: view.options, edit: { type: 'setDueDay', day: '2026-10-01' } }));
        expect(edited.view.due.label).toBe('2026-10-01');
        expect(chip(edited.view, 'due')).toBe('2026-10-01');
        expect(chip(edited.view, 'start')).toBe('2026-09-25');
    });

    it('refuses bad input and explains a refused edit', async () => {
        const { host } = await openHost('focusFull');
        const view = value(host.openQuickCapture());
        const { addAnother: _addAnother, ...partial } = view.options;
        expect(host.getQuickCaptureView({ text: 'x', options: partial as QuickCaptureOptions })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.editQuickCapture({ text: 'x', options: view.options, edit: { type: 'setDueDay', day: '2026-02-30' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.editQuickCapture({ text: 'x', options: view.options, edit: { type: 'selectProject', projectId: 'p-old' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const focus = value(host.editQuickCapture({ text: 'x', options: view.options, edit: view.focus.edit }));
        expect(focus.notice).toEqual({ tone: 'warning', title: 'Focus', message: 'Max 1 focus item(s)' });
        expect(focus.view.options.focus).toBe(false);
        expect(await host.submitQuickCapture({ text: '   ', options: view.options, captureId: generateUUID() }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        // With Priorities off the control is hidden: no priority edit, no picker, and a sent priority reads as none.
        const off = (await openHost('noPriorities')).host;
        const offView = value(off.openQuickCapture());
        expect(offView.priority).toBeNull();
        expect(off.editQuickCapture({ text: 'x', options: offView.options, edit: { type: 'setPriority', priority: 'high' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(off.getQuickCaptureView({ text: 'x', options: offView.options, picker: { kind: 'priority' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(value(off.getQuickCaptureView({ text: 'x', options: { ...offView.options, priority: 'high' } })).options.priority).toBeNull();
    });

    it('keeps one parse-options bag between rebuilds: preview and save agree, the next capture knows the last one', async () => {
        const { host } = await openHost('base');
        let options = value(host.editQuickCapture({ text: '', options: value(host.openQuickCapture()).options, edit: { type: 'setAddAnother', value: true } })).view.options;
        // Another writer adds a multi-word context while the draft is open: unknown until the next rebuild.
        await useTaskStore.getState().addTask('Synced', { contexts: ['@focus time'] });
        const draft = value(host.getQuickCaptureView({ text: 'x @focus time', options }));
        expect(draft.preview.filter((entry) => entry.kind === 'context').map((entry) => entry.value)).toEqual(['@focus']);
        const saved = value(await host.submitQuickCapture({ text: 'x @focus time', options, captureId: generateUUID() }));
        expect(saved).toMatchObject({ kind: 'saved', next: 'addAnother', reset: { text: '', options: { addAnother: true } } });
        expect(useTaskStore.getState().tasks.find((task) => task.title === 'x time')?.contexts).toEqual(['@focus']);
        options = saved.kind === 'saved' ? saved.reset!.options : options;
        const next = value(host.getQuickCaptureView({ text: 'y @focus time', options }));
        expect(next.preview.filter((entry) => entry.kind === 'context').map((entry) => entry.value)).toEqual(['@focus time']);
    });

    it('accepts an inherited skip snapshot in the prepared capture transport and retry', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host } = await openHost('base', saveData);
        await useTaskStore.getState().updateSettings({ taskReminderDefault: 'skip' });
        await flushPendingSave();
        const options = value(host.openQuickCapture()).options;
        const captureId = generateUUID();
        saveData.mockRejectedValue(new Error('disk unavailable'));
        const input = { text: 'Inherited reminders', options, captureId };
        expect(await host.submitQuickCapture(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(value(await host.submitQuickCapture(input))).toMatchObject({ kind: 'saved', taskId: captureId.toLowerCase() });
        const saved = useTaskStore.getState().tasks.find((task) => task.id === captureId.toLowerCase());
        expect(saved).toMatchObject({ reminderPolicy: 'inherit', suppressMindwtrReminders: true });
    });

    it('retries a failed capture exactly: one task, and a lost reply writes nothing again', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost('base', saveData);
        const options = value(host.openQuickCapture()).options;
        const input = { text: 'Call @phone +Garden plan', options, captureId: generateUUID() };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.submitQuickCapture(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        const firstWrites = writes(recorder.log);
        expect(firstWrites).toEqual(['addProject', 'addTask', 'addTasks']);

        saveData.mockResolvedValue(undefined);
        const retried = value(await host.submitQuickCapture(input));
        expect(retried).toMatchObject({ kind: 'saved', taskId: input.captureId.toLowerCase(), next: 'close', reset: null });
        expect(writes(recorder.log)).toEqual(firstWrites);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; title: string }[]; projects: { title: string }[] };
        expect(saved.tasks.filter((task) => task.title === 'Call')).toHaveLength(1);
        expect(saved.projects.filter((project) => project.title === 'Garden plan')).toHaveLength(1);

        const saves = saveData.mock.calls.length;
        expect(value(await host.submitQuickCapture(input))).toEqual(retried);
        expect(saveData).toHaveBeenCalledTimes(saves);
        expect(await host.submitQuickCapture({ ...input, text: 'Something else' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        // After a restart the receipt is gone; the task the capture ID made answers the retry.
        const restarted = createNativeHostContract();
        expect(await restarted.setLanguage({ storedLanguage: 'en', systemLocale: null })).toMatchObject({ ok: true });
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        recorder.log.length = 0;
        // The stored task does not match another draft: refused, never acknowledged.
        expect(await restarted.submitQuickCapture({ ...input, text: 'Call @phone' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await restarted.submitQuickCapture({ ...input, options: { ...options, focus: true } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(value(await restarted.submitQuickCapture(input))).toMatchObject({ kind: 'saved', taskId: input.captureId.toLowerCase() });
        expect(recorder.log).toEqual([]);
    });

    it('never reports SAVE_FAILED for a result that wrote nothing, and a refused capture ID stays free', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host } = await openHost('base', saveData);
        const options = value(host.openQuickCapture()).options;
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.submitQuickCapture({ text: 'First', options, captureId: generateUUID() }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBeTruthy();

        // An earlier save still fails, but these calls write nothing of their own.
        const captureId = generateUUID();
        expect(value(await host.submitQuickCapture({ text: 'Pay rent /due:whenever', options, captureId })))
            .toMatchObject({ kind: 'refused' });
        expect(value(await host.submitQuickCaptureLines({ text: 'one\ntwo /due:whenever', options, captureIds: [generateUUID(), generateUUID()], snapshotFileName: null })))
            .toMatchObject({ kind: 'refused' });
        expect(value(await host.submitQuickCapturePickerQuery({ picker: 'project', query: 'launch', text: 'x', options, requestId: generateUUID() })))
            .toEqual({ options: { ...options, projectId: 'p-launch', areaId: null }, created: false });

        saveData.mockResolvedValue(undefined);
        expect(value(await host.submitQuickCapture({ text: 'Pay rent /due:tomorrow', options, captureId })))
            .toMatchObject({ kind: 'saved', taskId: captureId.toLowerCase() });
    });

    it('reads a date-only option as a local day and refuses a non-canonical instant', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host } = await openHost('base', saveData);
        const options = value(host.openQuickCapture()).options;
        const view = value(host.getQuickCaptureView({ text: 'Plan', options: { ...options, dueDate: '2026-09-23' } }));
        expect(view.options.dueDate).toBe(new Date(2026, 8, 23).toISOString());
        expect(view.due.label).toBe('09/23/2026');
        const captureId = generateUUID();
        expect(value(await host.submitQuickCapture({ text: 'Plan', options: { ...options, dueDate: '2026-09-23' }, captureId })))
            .toMatchObject({ kind: 'saved' });
        expect(useTaskStore.getState().tasks.find((task) => task.id === captureId.toLowerCase())?.dueDate).toBe('2026-09-23');
        for (const dueDate of ['2026-09-23T10:00', '2026-09-23T14:00:00Z', '2026-02-30']) {
            expect(host.getQuickCaptureView({ text: 'Plan', options: { ...options, dueDate } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(host.getQuickCaptureView({ text: 'Plan', options: { ...options, dueDate: '2026-09-23', dueDateHasTime: true } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('refuses a date command it cannot read and writes nothing', async () => {
        const { host, recorder } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        expect(value(await host.submitQuickCapture({ text: 'Pay rent /due:whenever', options, captureId: generateUUID() }))).toEqual({
            kind: 'refused',
            notice: { tone: 'warning', title: 'Notice', message: 'Invalid date command: /due:whenever', durationMs: 4200 },
        });
        expect(recorder.log).toEqual([]);
    });

    it('asks before several lines, then creates them once with one capture ID per line', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost('base', saveData);
        const options = value(host.openQuickCapture()).options;
        const text = 'Buy eggs @errands\nCall plumber';
        expect(value(await host.submitQuickCapture({ text, options, captureId: generateUUID() }))).toEqual({
            kind: 'confirmLines',
            confirm: { title: 'Create 2 tasks?', message: 'Buy eggs @errands\nCall plumber', confirmLabel: 'Create tasks', cancelLabel: 'Cancel' },
            lineCount: 2,
        });
        expect(recorder.log).toEqual([]);
        const captureIds = [generateUUID(), generateUUID()];
        // Mobile saves a recovery snapshot first; the host writes the file the contract serializes.
        expect(await host.submitQuickCaptureLines({ text, options, captureIds, snapshotFileName: null }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const snapshot = value(await host.createQuickCaptureSnapshot())!;
        expect(snapshot.fileName).toMatch(/^data\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}\.snapshot\.json$/u);
        expect((JSON.parse(snapshot.contents) as { tasks: unknown[] }).tasks.length).toBe(fixture.tasks.length);
        const snapshotFileName = snapshot.fileName;
        expect(await host.submitQuickCaptureLines({ text, options, captureIds: [captureIds[0]], snapshotFileName }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.submitQuickCaptureLines({ text, options, captureIds, snapshotFileName })).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        expect(value(await host.submitQuickCaptureLines({ text, options, captureIds, snapshotFileName })))
            .toEqual({ kind: 'saved', taskIds: captureIds.map((id) => id.toLowerCase()) });
        expect(writes(recorder.log)).toEqual(['addTasks']);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; title: string; contexts: string[] }[] };
        expect(saved.tasks.filter((task) => captureIds.map((id) => id.toLowerCase()).includes(task.id)).map((task) => [task.title, task.contexts]))
            .toEqual([['Buy eggs', ['@errands']], ['Call plumber', []]]);
    });

    it('accepts the clash name the host wrote for the snapshot, and nothing else', async () => {
        const { host } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        const snapshot = value(await host.createQuickCaptureSnapshot())!;
        const clash = snapshot.fileName.replace(/\.snapshot\.json$/u, '.1.snapshot.json');
        for (const other of ['data.other.snapshot.json', snapshot.fileName.replace(/\.snapshot\.json$/u, '.x.snapshot.json'), `${snapshot.fileName}.1`]) {
            expect(await host.submitQuickCaptureLines({ text: 'a\nb', options, captureIds: [generateUUID(), generateUUID()], snapshotFileName: other }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(value(await host.submitQuickCaptureLines({ text: 'a\nb', options, captureIds: [generateUUID(), generateUUID()], snapshotFileName: clash })))
            .toMatchObject({ kind: 'saved' });
    });

    it('refuses a batch whose snapshot is older than the data', async () => {
        const { host } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        const snapshot = value(await host.createQuickCaptureSnapshot())!;
        await useTaskStore.getState().addTask('Synced meanwhile');
        expect(await host.submitQuickCaptureLines({ text: 'a\nb', options, captureIds: [generateUUID(), generateUUID()], snapshotFileName: snapshot.fileName }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('answers a batch retried after a restart from its tasks, preparing only missing lines', async () => {
        const { host, recorder } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        const text = 'Plan beds +Garden plan\nCall Bob';
        const captureIds = [generateUUID(), generateUUID()];
        const snapshotFileName = value(await host.createQuickCaptureSnapshot())!.fileName;
        const saved = value(await host.submitQuickCaptureLines({ text, options, captureIds, snapshotFileName }));
        await flushPendingSave();

        const restarted = createNativeHostContract();
        expect(await restarted.setLanguage({ storedLanguage: 'en', systemLocale: null })).toMatchObject({ ok: true });
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        recorder.log.length = 0;
        // A completed batch needs no snapshot and prepares nothing.
        expect(value(await restarted.submitQuickCaptureLines({ text, options, captureIds, snapshotFileName: null }))).toEqual(saved);
        expect(await restarted.submitQuickCaptureLines({ text: 'Plan beds\nCall Bob', options, captureIds, snapshotFileName: null }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // Archiving Garden plan, the project this batch made: the retry is refused (the batch's own
        // project is gone, as after a delete), and no second Garden plan is created.
        const garden = useTaskStore.getState().projects.find((project) => project.title === 'Garden plan')!;
        await useTaskStore.getState().updateProject(garden.id, { status: 'archived' });
        await flushPendingSave();
        const again = createNativeHostContract();
        expect(await again.setLanguage({ storedLanguage: 'en', systemLocale: null })).toMatchObject({ ok: true });
        expect(await again.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        expect(await again.submitQuickCaptureLines({ text, options, captureIds, snapshotFileName: null }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(recorder.log).toEqual([]);
        expect(useTaskStore.getState()._allProjects.filter((project) => project.title === 'Garden plan')).toHaveLength(1);

        // One line landed before the restart: only the other is prepared and written.
        const partial = [generateUUID(), generateUUID()];
        await useTaskStore.getState().addTask('Water', { status: 'inbox', areaId: undefined }, { captureId: partial[0] });
        recorder.log.length = 0;
        const snapshot = value(await restarted.createQuickCaptureSnapshot())!.fileName;
        expect(value(await restarted.submitQuickCaptureLines({ text: 'Water\nFeed cat', options, captureIds: partial, snapshotFileName: snapshot })))
            .toEqual({ kind: 'saved', taskIds: partial.map((id) => id.toLowerCase()) });
        expect(recorder.log.filter((entry) => (entry as unknown[])[0] === 'addTasks').map((entry) => ((entry as unknown[])[1] as { title: string }[]).map((item) => item.title)))
            .toEqual([['Feed cat']]);
    });

    it('creates a project from the picker search once, and chooses an existing one by its exact name', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost('base', saveData);
        const opened = value(host.openQuickCapture());
        const options = value(host.editQuickCapture({ text: 'Draft', options: opened.options, edit: { type: 'selectArea', areaId: 'a-work' } })).view.options;
        const input = { picker: 'project' as const, query: ' Kitchen remodel ', text: 'Draft', options, requestId: generateUUID() };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.submitQuickCapturePickerQuery(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        const created = value(await host.submitQuickCapturePickerQuery(input));
        expect(writes(recorder.log)).toEqual(['addProject']);
        const project = useTaskStore.getState().projects.find((entry) => entry.title === 'Kitchen remodel')!;
        expect(project.areaId).toBe('a-work');
        expect(created).toEqual({ options: { ...options, projectId: project.id, areaId: null }, created: true });
        expect(value(host.getQuickCaptureView({ text: 'Draft', options: created.options })).project.label).toBe('Kitchen remodel');
        expect(value(await host.submitQuickCapturePickerQuery(input))).toEqual(created);

        const existing = value(await host.submitQuickCapturePickerQuery({ ...input, query: 'launch', requestId: generateUUID() }));
        expect(existing).toEqual({ options: { ...options, projectId: 'p-launch', areaId: null }, created: false });
        const area = value(await host.submitQuickCapturePickerQuery({ picker: 'area', query: 'Garden', text: 'Draft', options, requestId: generateUUID() }));
        expect(value(host.getQuickCaptureView({ text: 'Draft', options: area.options })).area.label).toBe('Garden');
        expect(writes(recorder.log)).toEqual(['addProject', 'addArea']);
    });

    it('names a picker\'s new project or area by its request UUID: a replay after a restart chooses it, renamed since, and writes nothing', async () => {
        const { host } = await openHost('base');
        const opened = value(host.openQuickCapture());
        const options = value(host.editQuickCapture({ text: 'Draft', options: opened.options, edit: { type: 'selectArea', areaId: 'a-work' } })).view.options;
        const project = { picker: 'project' as const, query: 'Kitchen remodel', text: 'Draft', options, requestId: generateUUID() };
        const area = { picker: 'area' as const, query: 'Garden', text: 'Draft', options, requestId: generateUUID() };
        const projectId = project.requestId.toLowerCase();
        const areaId = area.requestId.toLowerCase();
        expect(value(await host.submitQuickCapturePickerQuery(project))).toEqual({ options: { ...options, projectId, areaId: null }, created: true });
        expect(value(await host.submitQuickCapturePickerQuery(area))).toEqual({ options: { ...options, areaId }, created: true });
        // Renamed since: the search no longer names them, and the replay still finds them.
        await useTaskStore.getState().updateProject(projectId, { title: 'Kitchen' });
        await useTaskStore.getState().updateArea(areaId, { name: 'Yard' });
        const projectReplay = await replayAfterRestart((restarted) => restarted.submitQuickCapturePickerQuery(project));
        expect(projectReplay).toEqual({ result: { ok: true, value: { options: { ...options, projectId, areaId: null }, created: false } }, wrote: false });
        const areaReplay = await replayAfterRestart((restarted) => restarted.submitQuickCapturePickerQuery(area));
        expect(areaReplay).toEqual({ result: { ok: true, value: { options: { ...options, areaId }, created: false } }, wrote: false });
        expect(useTaskStore.getState()._allProjects.filter((entry) => entry.title === 'Kitchen remodel')).toEqual([]);
        expect(useTaskStore.getState()._allAreas.filter((entry) => entry.name === 'Garden')).toEqual([]);
        // One deleted since cannot be chosen: refused, and nothing is written.
        await useTaskStore.getState().deleteArea(areaId);
        const gone = await replayAfterRestart((restarted) => restarted.submitQuickCapturePickerQuery(area));
        expect(gone.result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(gone.wrote).toBe(false);
        // The store restores a deleted area of that name under its own id; the request UUID never renames it.
        const restored = value(await host.submitQuickCapturePickerQuery({ ...area, query: 'Gone', requestId: generateUUID() }));
        expect(restored.options.areaId).toBe('a-gone');
        expect(useTaskStore.getState()._allAreas.find((entry) => entry.id === 'a-gone')?.deletedAt).toBeUndefined();
    });

    it('refuses a capture or a batch replayed after a restart once its task was edited since, and writes nothing', async () => {
        const { host } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        const capture = { text: 'Call @phone', options, captureId: generateUUID() };
        expect(value(await host.submitQuickCapture(capture))).toMatchObject({ kind: 'saved', taskId: capture.captureId.toLowerCase() });
        const snapshotFileName = value(await host.createQuickCaptureSnapshot())!.fileName;
        const lines = { text: 'Buy eggs\nCall plumber', options, captureIds: [generateUUID(), generateUUID()], snapshotFileName };
        expect(value(await host.submitQuickCaptureLines(lines))).toMatchObject({ kind: 'saved' });
        // A replay of a request that landed answers from its task.
        expect(await replayAfterRestart((restarted) => restarted.submitQuickCapture(capture)))
            .toMatchObject({ result: { ok: true, value: { kind: 'saved', taskId: capture.captureId.toLowerCase() } }, wrote: false });
        await useTaskStore.getState().updateTask(capture.captureId.toLowerCase(), { title: 'Call Bob' });
        await useTaskStore.getState().updateTask(lines.captureIds[1].toLowerCase(), { title: 'Call the plumber' });
        const single = await replayAfterRestart((restarted) => restarted.submitQuickCapture(capture));
        const batch = await replayAfterRestart((restarted) => restarted.submitQuickCaptureLines(lines));
        for (const { result, wrote } of [single, batch]) {
            expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(wrote).toBe(false);
        }
        expect([capture.captureId, lines.captureIds[1]].map((id) => useTaskStore.getState()._tasksById.get(id.toLowerCase())?.title))
            .toEqual(['Call Bob', 'Call the plumber']);
    });

    // A capture's new project lands, then its task write fails: the request did not land, so it runs again.
    const failTaskWrites = async (name: 'addTask' | 'addTasks', write: () => Promise<unknown>) => {
        const real = useTaskStore.getState()[name];
        useTaskStore.setState({ [name]: async () => ({ success: false, error: 'Task store refused' }) });
        try {
            expect(await write()).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        } finally {
            useTaskStore.setState({ [name]: real });
        }
    };
    const madeProjects = () => useTaskStore.getState()._allProjects
        .filter((project) => !fixture.projects.some((seeded) => seeded.id === project.id))
        .map((project) => [project.id, project.title, Boolean(project.deletedAt)]);
    const renameProject = async (title: string, to: string) => {
        const project = useTaskStore.getState()._allProjects.find((entry) => entry.title === title)!;
        await useTaskStore.getState().updateProject(project.id, { title: to });
    };
    const deleteProject = (title: string) => useTaskStore.getState()
        .deleteProject(useTaskStore.getState()._allProjects.find((entry) => entry.title === title)!.id);

    it('gives a capture\'s new project an id from the capture ID: a replay after its task failed uses it, renamed since, and never makes another', async () => {
        const { host } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        const capture = { text: 'Plan beds +Garden plan', options, captureId: generateUUID() };
        const taskId = capture.captureId.toLowerCase();
        const projectId = requestRowId(capture.captureId, 'project:garden plan');
        await failTaskWrites('addTask', () => host.submitQuickCapture(capture));
        await renameProject('Garden plan', 'Beds');

        const replay = await replayAfterRestart((restarted) => restarted.submitQuickCapture(capture));
        expect(replay.result).toMatchObject({ ok: true, value: { kind: 'saved', taskId, projectId } });
        expect(madeProjects()).toEqual([[projectId, 'Beds', false]]);
        expect(useTaskStore.getState()._tasksById.get(taskId)).toMatchObject({ title: 'Plan beds', projectId });
        // Landed now: a later replay answers from the task in the renamed project.
        expect(await replayAfterRestart((restarted) => restarted.submitQuickCapture(capture)))
            .toMatchObject({ result: { ok: true, value: { kind: 'saved', taskId, projectId } }, wrote: false });

        // A project deleted since is not made again: refused, and nothing is written.
        const other = { text: 'Sort boxes +Attic', options, captureId: generateUUID() };
        const atticId = requestRowId(other.captureId, 'project:attic');
        await failTaskWrites('addTask', () => host.submitQuickCapture(other));
        await deleteProject('Attic');
        const gone = await replayAfterRestart((restarted) => restarted.submitQuickCapture(other));
        expect(gone).toMatchObject({ result: { ok: false, error: { code: 'STALE_REVISION' } }, wrote: false });
        expect(madeProjects()).toEqual([[projectId, 'Beds', false], [atticId, 'Attic', true]]);
        expect(useTaskStore.getState()._tasksById.has(other.captureId.toLowerCase())).toBe(false);
    });

    it('gives a batch\'s new projects ids from its first capture ID and their names: a replay after its task write failed uses them, renamed since', async () => {
        const { host } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        const snapshotFileName = value(await host.createQuickCaptureSnapshot())!.fileName;
        const lines = { text: 'Plan beds +Garden plan\nFile receipts +Taxes\nWater +Garden plan', options, captureIds: [generateUUID(), generateUUID(), generateUUID()], snapshotFileName };
        const gardenId = requestRowId(lines.captureIds[0], 'project:garden plan');
        const taxesId = requestRowId(lines.captureIds[0], 'project:taxes');
        await failTaskWrites('addTasks', () => host.submitQuickCaptureLines(lines));
        await renameProject('Garden plan', 'Beds');
        await renameProject('Taxes', 'Paperwork');

        // A batch after a restart takes a new snapshot first.
        const replay = await replayAfterRestart(async (restarted) => restarted.submitQuickCaptureLines({
            ...lines, snapshotFileName: value(await restarted.createQuickCaptureSnapshot())!.fileName,
        }));
        expect(replay.result).toEqual({ ok: true, value: { kind: 'saved', taskIds: lines.captureIds.map((id) => id.toLowerCase()) } });
        expect(madeProjects()).toEqual([[gardenId, 'Beds', false], [taxesId, 'Paperwork', false]]);
        expect(lines.captureIds.map((id) => useTaskStore.getState()._tasksById.get(id.toLowerCase())?.projectId)).toEqual([gardenId, taxesId, gardenId]);

        // A project deleted since is not made again: refused, and nothing is written.
        const other = { ...lines, text: 'Sort boxes +Attic\nSweep', captureIds: [generateUUID(), generateUUID()], snapshotFileName: value(await host.createQuickCaptureSnapshot())!.fileName };
        const atticId = requestRowId(other.captureIds[0], 'project:attic');
        await failTaskWrites('addTasks', () => host.submitQuickCaptureLines(other));
        await deleteProject('Attic');
        const gone = await replayAfterRestart(async (restarted) => restarted.submitQuickCaptureLines({
            ...other, snapshotFileName: value(await restarted.createQuickCaptureSnapshot())!.fileName,
        }));
        expect(gone).toMatchObject({ result: { ok: false, error: { code: 'STALE_REVISION' } }, wrote: false });
        expect(madeProjects()).toEqual([[gardenId, 'Beds', false], [taxesId, 'Paperwork', false], [atticId, 'Attic', true]]);
    });

    it('a replay takes the capture\'s own project, renamed since, over a project given its old name since', async () => {
        const { host } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        const capture = { text: 'Plan beds +Garden plan', options, captureId: generateUUID() };
        const taskId = capture.captureId.toLowerCase();
        const projectId = requestRowId(capture.captureId, 'project:garden plan');
        await failTaskWrites('addTask', () => host.submitQuickCapture(capture));
        await renameProject('Garden plan', 'Beds');
        const newer = (await useTaskStore.getState().addProject('Garden plan', '#94a3b8'))!;
        const replay = await replayAfterRestart((restarted) => restarted.submitQuickCapture(capture));
        expect(replay.result).toMatchObject({ ok: true, value: { kind: 'saved', taskId, projectId } });
        expect(useTaskStore.getState()._tasksById.get(taskId)?.projectId).toBe(projectId);
        expect(madeProjects()).toEqual([[projectId, 'Beds', false], [newer.id, 'Garden plan', false]]);
        // Landed now: a later replay still answers from the task in the capture's own project.
        expect(await replayAfterRestart((restarted) => restarted.submitQuickCapture(capture)))
            .toMatchObject({ result: { ok: true, value: { kind: 'saved', taskId, projectId } }, wrote: false });
    });

    it('a batch replay takes its own projects, renamed since, over projects given their old names since', async () => {
        const { host } = await openHost('base');
        const options = value(host.openQuickCapture()).options;
        const snapshotFileName = value(await host.createQuickCaptureSnapshot())!.fileName;
        const lines = { text: 'Plan beds +Garden plan\nFile receipts +Taxes', options, captureIds: [generateUUID(), generateUUID()], snapshotFileName };
        const gardenId = requestRowId(lines.captureIds[0], 'project:garden plan');
        await failTaskWrites('addTasks', () => host.submitQuickCaptureLines(lines));
        await renameProject('Garden plan', 'Beds');
        const newer = (await useTaskStore.getState().addProject('Garden plan', '#94a3b8'))!;
        const replay = await replayAfterRestart(async (restarted) => restarted.submitQuickCaptureLines({
            ...lines, snapshotFileName: value(await restarted.createQuickCaptureSnapshot())!.fileName,
        }));
        expect(replay.result).toMatchObject({ ok: true, value: { kind: 'saved' } });
        expect(useTaskStore.getState()._tasksById.get(lines.captureIds[0].toLowerCase())?.projectId).toBe(gardenId);
        expect(useTaskStore.getState()._allProjects.filter((project) => project.id === newer.id || project.id === gardenId).map((project) => project.title))
            .toEqual(['Beds', 'Garden plan']);
    });

    it('windows a long picker list and counts every match', async () => {
        const many = {
            ...fixture,
            projects: [
                ...fixture.projects,
                ...Array.from({ length: 105 }, (_, index) => ({ ...fixture.projects[0], id: `p-extra-${index}`, title: `Extra ${index}`, order: 10 + index })),
            ],
        };
        const { host } = await openHost('base', undefined, many);
        const options = value(host.openQuickCapture()).options;
        const view = value(host.getQuickCaptureView({ text: '', options, picker: { kind: 'project' } }));
        expect(view.picker?.kind === 'project' && [view.picker.items.length, view.picker.total]).toEqual([100, 108]);
    });
});
