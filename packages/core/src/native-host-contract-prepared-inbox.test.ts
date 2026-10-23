import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { createWriteRecorder, loadProcessInboxFixture, performProcessInboxAction, seedProcessInboxStore,
    type ReplayBackend, type ReplayView } from './process-inbox-model.replay';
import { loadTranslations } from './i18n/i18n-loader';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { generateUUID } from './uuid';
import { prepareNativeInboxWrite } from './native-host-contract-process-inbox';
import { createProcessInboxDraft, createProcessInboxTitleParser, INITIAL_PROCESS_INBOX_ANSWERS } from './process-inbox-model';
import { resolveProcessInboxPlan } from './process-inbox-plan';

const fixture = loadProcessInboxFixture();
const scenario = (name: string) => fixture.scenarios.find((entry) => entry.name.startsWith(name))!;

describe('native prepared Process Inbox writer', () => {
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
    });

    it.each(fixture.scenarios.map((entry) => [entry.name, entry] as const))('prepares and saves each RN fixture decision: %s', async (_name, entry) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const savedSnapshots = vi.fn().mockResolvedValue(undefined);
        await seedProcessInboxStore(fixture, entry, createWriteRecorder(), { saveData: savedSnapshots });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        savedSnapshots.mockClear();
        const started = host.startInboxProcessing();
        if (!started.ok) throw new Error(started.error.message);
        let view = started.value.view;
        const sessionId = started.value.sessionId;
        const success = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        };
        const backend: ReplayBackend = {
            view: () => view as ReplayView | null,
            async edit(edit) {
                view = success(host.getInboxProcessingStep({ sessionId: sessionId!, taskId: view!.taskId,
                    step: view!.step, edit }));
            },
            async choose(choice) {
                const request = { sessionId: sessionId!, taskId: view!.taskId, step: view!.step,
                    decision: { choice }, requestId: generateUUID() };
                const prepared = success(host.inboxCommitPrepare(request));
                if (prepared.kind === 'flow') view = prepared.result.view;
                else {
                    const beforeWrites = savedSnapshots.mock.calls.length;
                    success(await host.inboxPreparedCommit({ request, prepared: prepared.prepared }));
                    if (prepared.prepared.result.decisionKind === 'convert') {
                        expect(savedSnapshots).toHaveBeenCalledTimes(beforeWrites + 1);
                        const written = savedSnapshots.mock.lastCall?.[0] as { tasks: Array<{ id: string }>;
                            projects: Array<{ id: string }> };
                        for (const id of prepared.prepared.result.createdActionIds ?? []) {
                            expect(written.tasks.some((task) => task.id === id)).toBe(true);
                        }
                        if (prepared.prepared.result.createdProjectId) {
                            expect(written.projects.some((project) => project.id === prepared.prepared.result.createdProjectId)).toBe(true);
                        }
                    }
                    view = success(host.inboxAfterCommit({ sessionId: sessionId!, requestId: request.requestId })).view;
                }
            },
            async skip() {
                const request = { sessionId: sessionId!, taskId: view!.taskId, requestId: generateUUID() };
                const prepared = success(host.inboxSkipPrepare(request));
                success(await host.inboxPreparedCommit({ request, prepared: prepared.prepared }));
                view = success(host.inboxAfterCommit({ sessionId: sessionId!, requestId: request.requestId })).view;
            },
            async submitProjectSearch() { await this.choose('submitProjectSearch'); },
            async toggleMode() {
                view = success(host.getInboxProcessingStep({ sessionId: sessionId!, taskId: view!.taskId,
                    step: view!.step, mode: view!.mode === 'quick' ? 'guided' : 'quick' }));
            },
        };
        for (const action of entry.actions) await performProcessInboxAction(backend, action, t);
        const expected = fixture.observations[entry.name].at(-1)?.taskId ?? null;
        if (typeof expected === 'string' && expected.startsWith('<created:')) {
            expect(useTaskStore.getState()._tasksById.get(view!.taskId)?.title).toBe(expected.slice(9, -1));
        } else {
            expect(view?.taskId ?? null).toBe(expected);
        }
    });

    it('counts a converted task and its new actions without losing prior Skip progress', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        await seedProcessInboxStore(fixture, { ...scenario('make it a project'),
            taskIds: ['inbox-c', 'inbox-a', 'inbox-b'] }, createWriteRecorder());
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        };
        const start = value(host.startInboxProcessing({ mode: 'quick' }));
        let view = start.view!;
        expect(view.progress).toMatchObject({ processed: 0, total: 3 });
        const skip = { sessionId: start.sessionId!, taskId: view.taskId, requestId: generateUUID() };
        const prepared = value(host.inboxSkipPrepare(skip));
        value(await host.inboxPreparedCommit({ request: skip, prepared: prepared.prepared }));
        view = value(host.inboxAfterCommit({ sessionId: skip.sessionId, requestId: skip.requestId })).view!;
        expect(view.progress).toMatchObject({ processed: 1, total: 3 });
        const choose = async (choice: string) => {
            const request = { sessionId: start.sessionId!, taskId: view.taskId, step: view.step,
                decision: { choice }, requestId: generateUUID() };
            const result = value(host.inboxCommitPrepare(request));
            if (result.kind === 'flow') view = result.result.view!;
            else {
                value(await host.inboxPreparedCommit({ request, prepared: result.prepared }));
                view = value(host.inboxAfterCommit({ sessionId: start.sessionId!, requestId: request.requestId })).view!;
            }
        };
        await choose('project');
        await choose('project');
        for (const edit of [{ type: 'set', field: 'nextAction', value: 'First project action' },
            { type: 'setExtraActions', value: ['Second project action', 'Third project action'] }]) {
            view = value(host.getInboxProcessingStep({ sessionId: start.sessionId!, taskId: view.taskId, step: view.step, edit }));
        }
        await choose('createProject');
        expect(view.progress).toMatchObject({ processed: 2, total: 5 });
        expect(view.taskId).not.toBe(skip.taskId);
        const reread = value(host.getInboxProcessingStep({ sessionId: start.sessionId!, taskId: view.taskId, step: view.step }));
        expect(reread.progress).toEqual(view.progress);
    });

    it('journals a bounded Trash effect, acknowledges a repeated durable receipt, then advances once', async () => {
        const recorder = createWriteRecorder();
        await seedProcessInboxStore(fixture, scenario('skipping the last item'), recorder);
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const request = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId,
            step: started.value.view.step, decision: { choice: 'trash' }, requestId: generateUUID() };
        const prepared = host.inboxCommitPrepare(request);
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!prepared.ok || prepared.value.kind !== 'prepared') return;
        const envelope = { request, prepared: prepared.value.prepared };
        expect(host.inboxPreparedValidate(envelope)).toMatchObject({ ok: true, value: { kind: 'decision' } });
        const first = await host.inboxPreparedCommit(envelope);
        expect(first).toMatchObject({ ok: true, value: { taskId: request.taskId } });
        const row = useTaskStore.getState()._tasksById.get(request.taskId);
        expect(row?.deletedAt).toEqual(expect.any(String));
        const saves = recorder.log.length;
        expect(await host.inboxPreparedCommit(envelope)).toEqual(first);
        expect(recorder.log).toHaveLength(saves);
        expect(host.getInboxProcessingStep({ sessionId: request.sessionId, taskId: request.taskId, step: request.step }))
            .toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        const next = host.inboxAfterCommit({ sessionId: request.sessionId, requestId: request.requestId });
        expect(next).toMatchObject({ ok: true });
        expect(host.inboxAfterCommit({ sessionId: request.sessionId, requestId: request.requestId })).toEqual(next);
    });

    it('refuses a frozen Inbox decision after its saved processing plan changes', async () => {
        const recorder = createWriteRecorder();
        await seedProcessInboxStore(fixture, scenario('skipping the last item'), recorder);
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const request = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId,
            step: started.value.view.step, decision: { choice: 'trash' }, requestId: generateUUID() };
        const prepared = host.inboxCommitPrepare(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
        const envelope = { request, prepared: prepared.value.prepared };
        expect(host.inboxPreparedValidate(envelope)).toMatchObject({ ok: true });
        const options = await host.getGtdInboxOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const change = { requestId: generateUUID(), edit: options.value.inbox.schedule.edit,
            expected: options.value.expected.inboxSchedule };
        const planned = await host.prepareGtdWorkflow(change);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        expect(await host.commitPreparedGtdWorkflow({ request: change, prepared: planned.value.prepared }))
            .toMatchObject({ ok: true });
        const before = useTaskStore.getState()._tasksById.get(request.taskId);
        expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._tasksById.get(request.taskId)).toEqual(before);
    });

    it('keeps Skip draft edits and rejects a forged after-row before touching the store', async () => {
        const recorder = createWriteRecorder();
        await seedProcessInboxStore(fixture, scenario('start later'), recorder);
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const { sessionId, taskId, step } = started.value.view;
        expect(host.getInboxProcessingStep({ sessionId, taskId, step,
            edit: { type: 'set', field: 'description', value: 'Retained note' } })).toMatchObject({ ok: true });
        const request = { sessionId, taskId, requestId: generateUUID() };
        const prepared = host.inboxSkipPrepare(request);
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!prepared.ok) return;
        const envelope = { request, prepared: prepared.value.prepared };
        const tampered = JSON.parse(JSON.stringify(envelope));
        tampered.prepared.effect.tasks[0].after.description = 'Forged note';
        expect(host.inboxPreparedValidate(tampered)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(recorder.log).toEqual([]);
        expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true, value: { kind: 'skip' } });
        expect(useTaskStore.getState()._tasksById.get(taskId)?.description).toBe('Retained note');
    });

    it('accepts a first application after the journal reorders object keys', async () => {
        const nested = { ...fixture, tasks: fixture.tasks.map((task) => task.id === 'inbox-c'
            ? { ...task,
                checklist: [{ id: 'nested-step', title: 'Nested step', isCompleted: false }],
                attachments: [{ id: 'nested-file', kind: 'file' as const, title: 'Keep file',
                    uri: 'file:///nested.txt', cloudKey: 'nested-cloud', createdAt: fixture.now,
                    updatedAt: fixture.now }] } : task) };
        await seedProcessInboxStore(nested, scenario('skipping the last item'), createWriteRecorder());
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const request = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId,
            requestId: generateUUID() };
        const prepared = host.inboxSkipPrepare(request);
        if (!prepared.ok) throw new Error('Expected prepared Skip');
        const reorder = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(reorder);
            if (value && typeof value === 'object') return Object.fromEntries(
                Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)]));
            return value;
        };
        const envelope = reorder({ request, prepared: prepared.value.prepared }) as
            Parameters<typeof host.inboxPreparedCommit>[0];
        expect(host.inboxPreparedValidate(envelope)).toMatchObject({ ok: true });
        expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true, value: { kind: 'skip' } });
    });

    it('rejects a coherent forged Skip date or push count before publication', async () => {
        const recorder = createWriteRecorder();
        await seedProcessInboxStore(fixture, scenario('skipping the last item'), recorder);
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const request = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId,
            requestId: generateUUID() };
        const prepared = host.inboxSkipPrepare(request);
        if (!prepared.ok) throw new Error('Expected prepared Skip');
        const envelope = { request, prepared: prepared.value.prepared };
        for (const field of ['dueDate', 'pushCount'] as const) {
            const forged = structuredClone(envelope);
            const value = field === 'dueDate' ? '2030-01-01' : 999;
            if (field === 'dueDate') (forged.prepared.witness.preparedDecision!.event as {fields: Record<string, unknown>})
                .fields.dueDate = value;
            forged.prepared.witness.preparedDecision!.taskUpdates = {
                ...forged.prepared.witness.preparedDecision!.taskUpdates, [field]: value,
            };
            forged.prepared.effect.tasks[0].after = { ...forged.prepared.effect.tasks[0].after,
                [field]: value };
            expect(host.inboxPreparedValidate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const linked = structuredClone(envelope);
        const offset = { amount: -1, unit: 'day' as const };
        linked.prepared.witness.preparedDecision!.taskUpdates = {
            ...linked.prepared.witness.preparedDecision!.taskUpdates, relativeStartOffset: offset,
        };
        linked.prepared.effect.tasks[0].after.relativeStartOffset = offset;
        expect(host.inboxPreparedValidate(linked)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(recorder.log).toEqual([]);
    });

    it('binds an untouched timed source date through a Skip journal', async () => {
        const dated = { ...fixture, tasks: fixture.tasks.map((task) => task.id === 'inbox-c'
            ? { ...task, startTime: '2029-12-31T10:00:00.000Z', dueDate: '2030-01-01T10:00:00.000Z',
                relativeStartOffset: { amount: -1, unit: 'day' as const } } : task) };
        await seedProcessInboxStore(dated, scenario('skipping the last item'), createWriteRecorder());
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const request = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId,
            requestId: generateUUID() };
        const prepared = host.inboxSkipPrepare(request);
        if (!prepared.ok) throw new Error('Expected prepared Skip');
        const forged = structuredClone({ request, prepared: prepared.value.prepared });
        (forged.prepared.witness.preparedDecision!.event as {fields: Record<string, unknown>}).fields.dueDate =
            '2030-01-02T10:00:00.000Z';
        forged.prepared.effect.tasks[0].after.dueDate = '2030-01-02T10:00:00.000Z';
        expect(host.inboxPreparedValidate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const offsetForged = structuredClone({ request, prepared: prepared.value.prepared });
        offsetForged.prepared.witness.preparedDecision!.taskUpdates = {
            ...offsetForged.prepared.witness.preparedDecision!.taskUpdates,
            relativeStartOffset: { amount: -2, unit: 'day' },
        };
        offsetForged.prepared.effect.tasks[0].after.relativeStartOffset = { amount: -2, unit: 'day' };
        expect(host.inboxPreparedValidate(offsetForged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.inboxPreparedCommit({ request, prepared: prepared.value.prepared }))
            .toMatchObject({ ok: true, value: { kind: 'skip' } });
        expect(useTaskStore.getState()._tasksById.get(request.taskId)?.dueDate).toBe('2030-01-01T10:00:00.000Z');
        expect(useTaskStore.getState()._tasksById.get(request.taskId)?.relativeStartOffset)
            .toEqual({ amount: -1, unit: 'day' });
    });

    it('freezes every member of an archived project larger than 64 rows', async () => {
        await seedProcessInboxStore(fixture, scenario('skipping the last item'), createWriteRecorder());
        const baseline = useTaskStore.getState();
        const archivedAt = '2026-09-20T12:00:00.000Z';
        const source = { ...baseline._allTasks.find((task) => task.id === 'inbox-c')!,
            projectId: 'p-old', areaId: undefined, projectArchivedAt: archivedAt,
            statusBeforeProjectArchive: 'next' as const };
        const siblings = Array.from({ length: 65 }, (_, index) => ({ ...source,
            id: `archived-sibling-${index}`, title: `Archived sibling ${index}`, status: 'done' as const,
            completedAt: archivedAt, statusBeforeProjectArchive: 'waiting' as const }));
        const tasks = [source, ...siblings];
        const state = { ...baseline, _allTasks: tasks, _tasksById: new Map(tasks.map((task) => [task.id, task])) };
        const parseTitle = createProcessInboxTitleParser({ settings: state.settings,
            tasks, people: [], projects: state._allProjects, areas: state._allAreas });
        const request = { sessionId: 'bounded-archived-session', taskId: source.id, step: 'decisions',
            decision: { choice: 'next' }, requestId: generateUUID() };
        const prepared = prepareNativeInboxWrite({ request, source, mode: 'quick',
            answers: { ...INITIAL_PROCESS_INBOX_ANSWERS, actionability: 'actionable' },
            draft: createProcessInboxDraft(source), plan: resolveProcessInboxPlan(state.settings),
            committed: 'next', decisionKind: 'next', state, parseTitle });
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') return;
        expect(prepared.prepared.witness.lists.tasks).toHaveLength(66);
        expect(prepared.prepared.effect.tasks).toHaveLength(66);
        expect(prepared.prepared.effect.projects).toMatchObject([{ after: { id: 'p-old', status: 'active' } }]);
    });

    it('retries an owed save on the same host, then acknowledges the exact row after session loss', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        await seedProcessInboxStore(fixture, scenario('skipping the last item'), createWriteRecorder(), { saveData });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const request = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId,
            step: started.value.view.step, decision: { choice: 'trash' }, requestId: generateUUID() };
        const prepared = host.inboxCommitPrepare(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('Expected journal');
        const envelope = { request, prepared: prepared.value.prepared };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const after = useTaskStore.getState()._tasksById.get(request.taskId);
        expect(after?.deletedAt).toBeDefined();
        expect(host.endInboxProcessing({ sessionId: request.sessionId })).toMatchObject({ ok: true });
        saveData.mockResolvedValue(undefined);
        expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true, value: { taskId: request.taskId } });
        expect(useTaskStore.getState()._tasksById.get(request.taskId)).toBe(after);
        const cold = createNativeHostContract();
        expect(await cold.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const savedCalls = saveData.mock.calls.length;
        expect(await cold.inboxPreparedCommit(envelope)).toMatchObject({ ok: true, value: { taskId: request.taskId } });
        expect(saveData).toHaveBeenCalledTimes(savedCalls);
        expect(cold.inboxAfterCommit({ sessionId: request.sessionId, requestId: request.requestId }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('does not acknowledge a completed Skip row edited after its receipt', async () => {
        const saveData = vi.fn().mockResolvedValue(undefined);
        await seedProcessInboxStore(fixture, scenario('skipping the last item'), createWriteRecorder(), { saveData });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const request = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId,
            requestId: generateUUID() };
        const prepared = host.inboxSkipPrepare(request);
        if (!prepared.ok) throw new Error('Expected prepared Skip');
        const envelope = structuredClone({ request, prepared: prepared.value.prepared });
        expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true });
        expect((await useTaskStore.getState().updateTask(request.taskId, { description: 'Later independent edit' })).success).toBe(true);
        await flushPendingSave();
        const cold = createNativeHostContract();
        expect(await cold.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const edited = useTaskStore.getState()._tasksById.get(request.taskId);
        const saves = saveData.mock.calls.length;
        expect(await cold.inboxPreparedCommit(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._tasksById.get(request.taskId)).toEqual(edited);
        expect(saveData).toHaveBeenCalledTimes(saves);
    });

    it('refuses a partial recurring after-set without filling its missing source update', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const saveData = vi.fn().mockResolvedValue(undefined);
        const recurring = { ...fixture, tasks: fixture.tasks.map((task) => task.id === 'inbox-a'
            ? { ...task, recurrence: { rule: 'daily' as const }, startTime: '2026-09-25',
                dueDate: '2026-09-26' } : task) };
        await seedProcessInboxStore(recurring, scenario('two-minute done'), createWriteRecorder(), { saveData });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const base = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId };
        const flow = host.inboxCommitPrepare({ ...base, step: started.value.view.step,
            decision: { choice: 'actionable' }, requestId: generateUUID() });
        if (!flow.ok || flow.value.kind !== 'flow' || !flow.value.result.view) throw new Error('Missing done step');
        const request = { ...base, step: flow.value.result.view.step,
            decision: { choice: 'done' }, requestId: generateUUID() };
        const prepared = host.inboxCommitPrepare(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('Missing recurring effect');
        const child = prepared.value.prepared.effect.tasks.find((row) => !row.before)?.after;
        if (!child) throw new Error('Missing follow-up');
        const current = useTaskStore.getState();
        const tasks = [...current._allTasks, child];
        useTaskStore.setState({ _allTasks: tasks, _tasksById: new Map(tasks.map((task) => [task.id, task])) });
        expect(host.endInboxProcessing({ sessionId: request.sessionId })).toMatchObject({ ok: true });
        const saves = saveData.mock.calls.length;
        expect(await host.inboxPreparedCommit({ request, prepared: prepared.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._tasksById.get(request.taskId)?.status).toBe('inbox');
        expect(useTaskStore.getState()._tasksById.get(child.id)).toEqual(child);
        expect(saveData).toHaveBeenCalledTimes(saves);
    });

    it('freezes the complete recurring follow-up and rejects omission of its induced row', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const recurring = { ...fixture, tasks: fixture.tasks.map((task) => task.id === 'inbox-a'
            ? { ...task, recurrence: { rule: 'daily' as const }, startTime: '2026-09-25', dueDate: '2026-09-26',
                checklist: [{ id: 'step-original', title: 'Check', isCompleted: true }] } : task) };
        await seedProcessInboxStore(recurring, scenario('two-minute done'), createWriteRecorder());
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const base = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId };
        const flow = host.inboxCommitPrepare({ ...base, step: started.value.view.step,
            decision: { choice: 'actionable' }, requestId: generateUUID() });
        expect(flow).toMatchObject({ ok: true, value: { kind: 'flow' } });
        if (!flow.ok || flow.value.kind !== 'flow' || !flow.value.result.view) return;
        const request = { ...base, step: flow.value.result.view.step, decision: { choice: 'done' }, requestId: generateUUID() };
        const prepared = host.inboxCommitPrepare(request);
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!prepared.ok || prepared.value.kind !== 'prepared') return;
        const envelope = { request, prepared: prepared.value.prepared };
        expect(envelope.prepared.effect.tasks).toHaveLength(2);
        const followUp = envelope.prepared.effect.tasks.find((row) => !row.before)?.after;
        expect(followUp?.checklist?.[0]).toMatchObject({ title: 'Check', isCompleted: false });
        expect(followUp?.checklist?.[0].id).not.toBe('step-original');
        const omitted = JSON.parse(JSON.stringify(envelope));
        omitted.prepared.effect.tasks = omitted.prepared.effect.tasks.filter((row: { before: unknown }) => row.before);
        expect(host.inboxPreparedValidate(omitted)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get(followUp!.id)).toEqual(followUp);
    });

    it('validates and publishes a frozen Later date after the process timezone changes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        await seedProcessInboxStore(fixture, scenario('start later'), createWriteRecorder());
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const base = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId };
        const flow = host.inboxCommitPrepare({ ...base, step: started.value.view.step,
            decision: { choice: 'later' }, requestId: generateUUID() });
        expect(flow).toMatchObject({ ok: true, value: { kind: 'flow' } });
        expect(host.getInboxProcessingStep({ ...base, step: 'later',
            edit: { type: 'setPickedDate', field: 'startTime', day: '2026-10-05' } })).toMatchObject({ ok: true });
        const request = { ...base, step: 'later', decision: { choice: 'fileIt' }, requestId: generateUUID() };
        const prepared = host.inboxCommitPrepare(request);
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!prepared.ok || prepared.value.kind !== 'prepared') return;
        const envelope = { request, prepared: prepared.value.prepared };
        const expected = envelope.prepared.effect.tasks.find((row) => row.after.id === base.taskId)?.after;
        const previousTz = process.env.TZ;
        process.env.TZ = 'UTC';
        try {
            expect(host.inboxPreparedValidate(envelope)).toMatchObject({ ok: true });
            expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true });
            expect(useTaskStore.getState()._tasksById.get(base.taskId)?.startTime).toBe(expected?.startTime);
        } finally {
            process.env.TZ = previousTz;
        }
    });

    it('rejects a forged time or day for an explicit date-only Later choice', async () => {
        await seedProcessInboxStore(fixture, scenario('start later'), createWriteRecorder());
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const base = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId };
        const flow = host.inboxCommitPrepare({ ...base, step: started.value.view.step,
            decision: { choice: 'later' }, requestId: generateUUID() });
        if (!flow.ok || flow.value.kind !== 'flow') throw new Error('Missing Later step');
        for (const edit of [{ type: 'setPickedDate' as const, field: 'startTime' as const, day: '2026-10-05' },
            { type: 'setDateOnly' as const, field: 'startTime' as const, value: true }]) {
            expect(host.getInboxProcessingStep({ ...base, step: 'later', edit })).toMatchObject({ ok: true });
        }
        const request = { ...base, step: 'later', decision: { choice: 'fileIt' }, requestId: generateUUID() };
        const prepared = host.inboxCommitPrepare(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('Missing date-only effect');
        const envelope = { request, prepared: prepared.value.prepared };
        const row = envelope.prepared.effect.tasks.find((entry) => entry.after.id === request.taskId);
        expect(row?.after.startTime).toBe('2026-10-05');
        for (const value of ['2026-10-05T09:00', '2026-10-06', 'not-a-date']) {
            const forged = structuredClone(envelope);
            (forged.prepared.witness.preparedDecision!.event as {fields: Record<string, unknown>}).fields.startTime = value;
            forged.prepared.effect.tasks.find((entry) => entry.after.id === request.taskId)!.after.startTime = value;
            expect(host.inboxPreparedValidate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('lets an explicitly picked or cleared date override a parsed title date', async () => {
        const setup = scenario('skipping the last item');
        const settings = fixture.settings[setup.settings];
        const enabled = { ...fixture, settings: { ...fixture.settings, [setup.settings]: {
            ...settings, gtd: { ...settings.gtd, inboxProcessing: {
                ...settings.gtd?.inboxProcessing, scheduleEnabled: true,
            } },
        } } };
        await seedProcessInboxStore(enabled, setup, createWriteRecorder());
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const base = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId,
            step: started.value.view.step };
        expect(host.getInboxProcessingStep({ ...base,
            edit: { type: 'set', field: 'title', value: 'Picker wins /due:2030-01-01' } })).toMatchObject({ ok: true });
        for (const day of ['2030-01-02', null]) {
            expect(host.getInboxProcessingStep({ ...base,
                edit: day ? { type: 'setPickedDate', field: 'dueDate', day }
                    : { type: 'setDate', field: 'dueDate', value: null } })).toMatchObject({ ok: true });
            if (day) expect(host.getInboxProcessingStep({ ...base,
                edit: { type: 'setDateOnly', field: 'dueDate', value: true } })).toMatchObject({ ok: true });
            const request = { sessionId: base.sessionId, taskId: base.taskId, requestId: generateUUID() };
            const prepared = host.inboxSkipPrepare(request);
            expect(prepared, JSON.stringify({ day, prepared })).toMatchObject({ ok: true });
            if (!prepared.ok) throw new Error(prepared.error.message);
            const envelope = { request, prepared: prepared.value.prepared };
            expect(host.inboxPreparedValidate(envelope)).toMatchObject({ ok: true });
            const after = envelope.prepared.effect.tasks.find((row) => row.after.id === base.taskId)!.after;
            expect(after.dueDate).toBe(day ?? undefined);
        }
    });

    it('holds an early created project until afterCommit selects it exactly once', async () => {
        await seedProcessInboxStore(fixture, scenario('project search'), createWriteRecorder());
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const started = host.startInboxProcessing();
        if (!started.ok || !started.value.view) throw new Error('Missing Inbox task');
        const base = { sessionId: started.value.sessionId!, taskId: started.value.view.taskId };
        let step = started.value.view.step;
        for (const choice of ['actionable', 'no', 'defer', 'single']) {
            const flow = host.inboxCommitPrepare({ ...base, step, decision: { choice }, requestId: generateUUID() });
            expect(flow).toMatchObject({ ok: true, value: { kind: 'flow' } });
            if (!flow.ok || flow.value.kind !== 'flow' || !flow.value.result.view) return;
            step = flow.value.result.view.step;
        }
        expect(step).toBe('file');
        expect(host.getInboxProcessingStep({ ...base, step,
            edit: { type: 'set', field: 'projectSearch', value: 'Garden Plan' } })).toMatchObject({ ok: true });
        const request = { ...base, step, decision: { choice: 'submitProjectSearch' }, requestId: generateUUID() };
        const prepared = host.inboxCommitPrepare(request);
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        if (!prepared.ok || prepared.value.kind !== 'prepared') return;
        const envelope = { request, prepared: prepared.value.prepared };
        expect(envelope.prepared.result).toMatchObject({ kind: 'projectCreate', taskId: base.taskId,
            createdProjectId: expect.any(String) });
        expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true });
        expect(host.getInboxProcessingStep({ ...base, step,
            edit: { type: 'set', field: 'title', value: 'Blocked' } })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(host.inboxCommitPrepare({ ...base, step, decision: { choice: 'fileIt' }, requestId: generateUUID() }))
            .toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        const advanced = host.inboxAfterCommit({ sessionId: base.sessionId, requestId: request.requestId });
        expect(advanced).toMatchObject({ ok: true, value: { view: { taskId: base.taskId,
            draft: { projectId: envelope.prepared.result.createdProjectId, projectSearch: '' } } } });
        expect(host.inboxAfterCommit({ sessionId: base.sessionId, requestId: request.requestId })).toEqual(advanced);
        expect(host.getInboxProcessingStep({ ...base, step,
            edit: { type: 'set', field: 'title', value: 'Editable now' } })).toMatchObject({ ok: true });
    });
    describe('task reminder default for created project actions', () => {
        const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        };
        /** Converts the first Inbox task to a project with two extra actions; returns the prepared envelope. */
        const prepareConversion = async (taskReminderDefault: 'send' | 'skip' | undefined) => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date(fixture.now));
            await seedProcessInboxStore(fixture, scenario('make it a project'), createWriteRecorder());
            const host = createNativeHostContract();
            expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
            useTaskStore.setState((state) => ({ settings: { ...state.settings, taskReminderDefault } }));
            const start = value(host.startInboxProcessing({ mode: 'quick' }));
            let view = start.view!;
            const prepare = (choice: string) => value(host.inboxCommitPrepare({ sessionId: start.sessionId!, taskId: view.taskId,
                step: view.step, decision: { choice }, requestId: generateUUID() }));
            for (const choice of ['project', 'project']) {
                const flow = prepare(choice);
                if (flow.kind !== 'flow') throw new Error('Expected a flow step');
                view = flow.result.view!;
            }
            for (const edit of [{ type: 'set', field: 'nextAction', value: 'First project action' },
                { type: 'setExtraActions', value: ['Second project action', 'Third project action'] }]) {
                view = value(host.getInboxProcessingStep({ sessionId: start.sessionId!, taskId: view.taskId, step: view.step, edit }));
            }
            const request = { sessionId: start.sessionId!, taskId: view.taskId, step: view.step,
                decision: { choice: 'createProject' }, requestId: generateUUID() };
            const prepared = value(host.inboxCommitPrepare(request));
            if (prepared.kind !== 'prepared') throw new Error('Expected a prepared conversion');
            return { host, envelope: { request, prepared: prepared.prepared } };
        };

        it('creates extra actions with Mindwtr reminders suppressed under Skip, as RN addTask does', async () => {
            const { host, envelope } = await prepareConversion('skip');
            const created = envelope.prepared.result.createdActionIds ?? [];
            expect(created).toHaveLength(2);
            expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true });
            for (const id of created) expect(useTaskStore.getState()._tasksById.get(id)?.suppressMindwtrReminders).toBe(true);
            const ordinary = await useTaskStore.getState().addTask('Reference', { status: 'inbox' });
            expect(useTaskStore.getState()._tasksById.get(ordinary.id!)?.suppressMindwtrReminders).toBe(true);
        });

        it('publishes the frozen rows after the default changes; an earlier Send journal stays valid under Skip', async () => {
            const { host, envelope } = await prepareConversion('skip');
            expect(envelope.prepared.version).toBe(1);
            expect(envelope.prepared.witness.settings).not.toHaveProperty('taskReminderDefault');
            useTaskStore.setState((state) => ({ settings: { ...state.settings, taskReminderDefault: 'send' } }));
            expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true });
            for (const id of envelope.prepared.result.createdActionIds ?? []) {
                expect(useTaskStore.getState()._tasksById.get(id)?.suppressMindwtrReminders).toBe(true);
            }
        });

        it('validates and commits an earlier Send journal unchanged after Skip is chosen', async () => {
            const { host, envelope } = await prepareConversion(undefined);
            const before = JSON.stringify(envelope);
            useTaskStore.setState((state) => ({ settings: { ...state.settings, taskReminderDefault: 'skip' } }));
            expect(host.inboxPreparedValidate(envelope)).toMatchObject({ ok: true });
            expect(await host.inboxPreparedCommit(envelope)).toMatchObject({ ok: true });
            expect(JSON.stringify(envelope)).toBe(before);
            for (const id of envelope.prepared.result.createdActionIds ?? []) {
                expect(useTaskStore.getState()._tasksById.get(id)?.suppressMindwtrReminders).toBe(false);
            }
        });
    });
});
