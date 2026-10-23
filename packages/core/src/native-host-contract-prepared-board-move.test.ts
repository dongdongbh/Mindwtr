import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoardRecorder, loadBoardViewsFixture, seedBoardStore } from './board-view-model.replay';
import { createNativeHostContract } from './native-host-contract';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { boardMoveEffect, boardMoveScope, planTaskUpdateEffects, prepareTaskUpdatesForStore } from './store-tasks';
import type { NativeBoardWriteRequest, NativePreparedBoardAction } from './native-host-contract-board';

const fixture = loadBoardViewsFixture().board;
const requestId = '97bb2a90-d834-44b0-aed3-c2f7d0e48e5a';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
async function open(saveData?: (data: unknown) => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(fixture.now));
    const recorder = createBoardRecorder();
    await seedBoardStore(fixture, { name: 'move', settings: 'base', actions: [] }, recorder, { saveData });
    const host = createNativeHostContract(); value(await host.activate({ writeSafetyReady: true }));
    recorder.log.length = 0; return { host, recorder };
}
function request(host: ReturnType<typeof createNativeHostContract>, status: 'inbox' | 'next' | 'waiting' | 'someday', filters?: object): NativeBoardWriteRequest {
    const row = useTaskStore.getState()._tasksById.get('n-draft')!;
    return { requestId, action: { type: 'moveCard', taskId: row.id, status, taskRevision: taskRevisionOf(row),
        filters: filters ?? value(host.getBoardView({ limit: 100 })).filters } } as NativeBoardWriteRequest;
}
function prepare(host: ReturnType<typeof createNativeHostContract>, target: 'inbox' | 'next' | 'waiting' | 'someday' = 'waiting') {
    const result = value(host.prepareBoardAction(request(host, target)));
    if (result.kind !== 'prepared') throw new Error('Expected prepared move');
    return clone(result.prepared);
}
const commit = (host: ReturnType<typeof createNativeHostContract>, prepared: NativePreparedBoardAction) =>
    host.commitPreparedBoardAction({ request: prepared.request, prepared });
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('native prepared Board nonterminal moves', () => {
    it('prepares without writes and matches RN settings retention while preserving peers', async () => {
        await open();
        const initialSettings = clone(useTaskStore.getState().settings);
        await useTaskStore.getState().updateTask('n-draft', { status: 'waiting' });
        await flushPendingSave();
        const rnSettings = clone(useTaskStore.getState().settings);
        const { host, recorder } = await open();
        // Reuse the same freshly initialized device and analytics identities for both writers.
        useTaskStore.setState({ settings: initialSettings });
        const tasks = clone(useTaskStore.getState()._allTasks); const settings = clone(useTaskStore.getState().settings);
        const prepared = prepare(host); expect(recorder.log).toEqual([]);
        expect(useTaskStore.getState().settings).toEqual(settings);
        expect(useTaskStore.getState()._allTasks).toEqual(tasks); expect(prepared.after.status).toBe('waiting');
        expect(prepared.after.boardOrder).toBeUndefined(); expect(prepared.deviceIdToInitialize).toBeNull();
        expect(value(await commit(host, prepared))).toEqual({ changed: true, open: null });
        expect(useTaskStore.getState()._tasksById.get('n-draft')).toEqual(prepared.after);
        expect(useTaskStore.getState()._allTasks.filter(row => row.id !== 'n-draft')).toEqual(tasks.filter(row => row.id !== 'n-draft'));
        expect(useTaskStore.getState().settings).toEqual(rnSettings);
    });
    it('returns admitted same-status no-op and refuses a card not shown under the request filters', async () => {
        const { host, recorder } = await open();
        expect(value(host.prepareBoardAction(request(host, 'next')))).toEqual({ kind: 'noop', result: { changed: false, open: null } });
        const hidden = request(host, 'waiting', { searchQuery: 'cannot-match-this-synthetic-title' });
        expect(host.prepareBoardAction(hidden)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(recorder.log).toEqual([]);
    });
    it('refuses a legacy Section-only source whose inferred archived parent would require multirow reactivation', async () => {
        const { host, recorder } = await open(); const admitted = prepare(host); const state = useTaskStore.getState(); const source = state._tasksById.get('n-draft')!;
        const projectId = source.projectId!; const sectionId = 'move-legacy-section';
        useTaskStore.setState({ _allTasks: state._allTasks.map(row => row.id === source.id ? { ...row, projectId: undefined, sectionId } : row),
            _allProjects: state._allProjects.map(row => row.id === projectId ? { ...row, status: 'archived' as const } : row),
            _allSections: [...state._allSections, { id: sectionId, projectId, title: 'Synthetic legacy section', order: 0,
                createdAt: fixture.now, updatedAt: fixture.now }] });
        const before = clone(useTaskStore.getState()._allTasks); const projects = clone(useTaskStore.getState()._allProjects);
        const legacy = useTaskStore.getState()._tasksById.get('n-draft')!;
        const move = { ...admitted.move!, scope: boardMoveScope(useTaskStore.getState(), legacy) };
        expect(() => boardMoveEffect(legacy, 'waiting', move, fixture.now)).toThrow(/multirow/i);
        expect(value(host.getBoardView({ limit: 100 })).columns.flatMap(column => column.cards).find(card => card.row.id === legacy.id)?.moveAllowed).toBe(false);
        expect(host.prepareBoardAction(request(host, 'waiting'))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/multirow|lifecycle|one task/i) } });
        expect(useTaskStore.getState()._allTasks).toEqual(before); expect(useTaskStore.getState()._allProjects).toEqual(projects);
        expect(recorder.log).toEqual([]);
    });
    it('retries a failed save with the exact after row, accepts cold lost acknowledgement, and refuses a later edit', async () => {
        let fail = false; const save = vi.fn(async () => { if (fail) throw new Error('synthetic move save failure'); });
        const { host } = await open(save); const prepared = prepare(host); fail = true;
        expect(await commit(host, prepared)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const landed = clone(useTaskStore.getState()._allTasks); fail = false;
        expect(value(await commit(host, prepared))).toEqual(prepared.result); expect(useTaskStore.getState()._allTasks).toEqual(landed);
        const cold = createNativeHostContract(); value(await cold.activate({ writeSafetyReady: true, recoveryLoad: true }));
        expect(value(await commit(cold, prepared))).toEqual(prepared.result);
        await useTaskStore.getState().updateTask('n-draft', { title: 'Synthetic later external edit' }); await flushPendingSave();
        const later = clone(useTaskStore.getState()._allTasks); const newer = createNativeHostContract(); value(await newer.activate({ writeSafetyReady: true, recoveryLoad: true }));
        expect(await commit(newer, prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allTasks).toEqual(later);
    });
    const statuses = ['inbox', 'next', 'waiting', 'someday'] as const;
    it.each(statuses.flatMap(source => statuses.map(target => [source, target] as const)))('matches the full RN planner for %s → %s', async (sourceStatus, target) => {
        const { host } = await open(); const state = useTaskStore.getState();
        useTaskStore.setState({ _allTasks: state._allTasks.map(row => row.id === 'n-draft' ? { ...row, status: sourceStatus } : row) });
        const before = clone(useTaskStore.getState()._tasksById.get('n-draft')!); const current = useTaskStore.getState();
        const result = value(host.prepareBoardAction(request(host, target)));
        if (sourceStatus === target) { expect(result).toEqual({ kind: 'noop', result: { changed: false, open: null } }); return; }
        expect(result.kind).toBe('prepared'); if (result.kind !== 'prepared') throw new Error('Move not prepared');
        const normalized = prepareTaskUpdatesForStore({ task: before, updates: { status: target }, allProjects: current._allProjects,
            allSections: current._allSections, allAreas: current._allAreas, settings: current.settings });
        if (!normalized.ok) throw new Error(normalized.error);
        const rn = planTaskUpdateEffects({ task: before, preparedUpdates: normalized.updates, allTasks: current._allTasks,
            allProjects: current._allProjects, allSections: current._allSections, now: fixture.now, deviceId: current.settings.deviceId! });
        expect(result.prepared.after).toEqual(clone(rn.updatedTask));
        expect(value(await commit(host, result.prepared))).toEqual(result.prepared.result);
    });
    it('matches actual RN updateTask for a live Section-only parent inference and preserves its exact order semantics', async () => {
        const { host } = await open(); const state = useTaskStore.getState(); const source = state._tasksById.get('n-draft')!;
        const sectionId = 'move-live-section';
        useTaskStore.setState({ _allTasks: state._allTasks.map(row => row.id === source.id ? { ...row, projectId: undefined, sectionId } : row),
            _allSections: [...state._allSections, { id: sectionId, projectId: source.projectId!, title: 'Synthetic live section', order: 0,
                createdAt: fixture.now, updatedAt: fixture.now }] });
        const initial = clone(useTaskStore.getState()._allTasks); const prepared = prepare(host);
        expect((await useTaskStore.getState().updateTask(source.id, { status: 'waiting' })).success).toBe(true); await flushPendingSave();
        const rn = clone(useTaskStore.getState()._tasksById.get(source.id)); expect(prepared.after).toEqual(rn);
        expect(prepared.after.projectId).toBe(source.projectId); expect(prepared.after.sectionId).toBe(sectionId);
        useTaskStore.setState({ _allTasks: initial }); expect(value(await commit(host, prepared))).toEqual(prepared.result);
        expect(useTaskStore.getState()._tasksById.get(source.id)).toEqual(rn);
    });
    it('clears Inbox focus/order through RN rules and preserves frozen effect across clock changes', async () => {
        const { host } = await open(); const state = useTaskStore.getState();
        useTaskStore.setState({ _allTasks: state._allTasks.map(row => row.id === 'n-draft' ? { ...row, isFocusedToday: true, focusOrder: 7 } : row) });
        const prepared = prepare(host, 'inbox'); expect(prepared.after.isFocusedToday).toBe(false); expect(prepared.after.focusOrder).toBeUndefined();
        vi.setSystemTime(new Date('2036-10-13T22:00:00.000Z'));
        expect(value(await commit(host, prepared))).toEqual(prepared.result); expect(useTaskStore.getState()._tasksById.get('n-draft')).toEqual(prepared.after);
    });
    it('validates frozen Move authority without mutable reads and rejects forged effects/context/extra keys', async () => {
        const { host } = await open(); const prepared = prepare(host); const cold = createNativeHostContract();
        const read = vi.spyOn(useTaskStore, 'getState').mockImplementation(() => { throw new Error('immutable Move reader accessed state'); });
        try {
            expect(value(cold.validatePreparedBoardAction({ request: prepared.request, prepared }))).toEqual(prepared.result);
            const changes: ((row: NativePreparedBoardAction) => void)[] = [
                row => { row.after.title = 'Forged unrelated title'; }, row => { row.after.boardOrder = 77; },
                row => { row.deviceIdToInitialize = '97bb2a90-d834-44b0-aed3-c2f7d0e48e5b'; },
                row => { row.move!.clock.futureBoundary = '2036-10-13T23:59:59.999Z'; },
                row => { row.move!.scope.projects = []; }, row => { Object.assign(row.move!, { extra: true }); },
                row => { Object.assign(row.request.action, { afterId: null }); },
            ];
            for (const change of changes) {
                const forged = clone(prepared); change(forged);
                expect(cold.validatePreparedBoardAction({ request: forged.request, prepared: forged })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
        } finally { read.mockRestore(); }
    });
    it.each(['device', 'container', 'focus', 'visibility'] as const)('refuses a changed %s dependency before mutation but exact durable replay wins', async dependency => {
        const { host } = await open(); const prepared = prepare(host); const state = useTaskStore.getState();
        const change = () => {
            if (dependency === 'device') useTaskStore.setState({ settings: { ...state.settings, deviceId: 'different-stable-device' } });
            if (dependency === 'container') useTaskStore.setState({ _allProjects: state._allProjects.map(row => row.id === prepared.before.projectId ? { ...row, status: 'archived' as const } : row) });
            if (dependency === 'focus') useTaskStore.setState({ settings: { ...state.settings, gtd: { ...state.settings.gtd, focusTaskLimit: 2 } } });
            if (dependency === 'visibility') useTaskStore.setState({ _allTasks: state._allTasks.map(row => row.id === 'n-draft' ? { ...row, tags: ['@scope-changed'] } : row) });
        };
        change(); const before = clone(useTaskStore.getState()._allTasks);
        expect(await commit(host, prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(useTaskStore.getState()._allTasks).toEqual(before);
        // Restore only test state; execute the exact request once, then change dependencies again.
        useTaskStore.setState({ settings: state.settings, _allProjects: state._allProjects, _allTasks: state._allTasks });
        expect(value(await commit(host, prepared))).toEqual(prepared.result); change();
        await useTaskStore.getState().persistSnapshot(); await flushPendingSave();
        const cold = createNativeHostContract(); value(await cold.activate({ writeSafetyReady: true, recoveryLoad: true }));
        // A changed target itself is a later edit, not a replay. Other dependencies cannot revoke the exact row receipt.
        if (dependency !== 'visibility') expect(value(await commit(cold, prepared))).toEqual(prepared.result);
        else expect(await commit(cold, prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
    it('rejects missing device identity, terminal destinations and stale/missing-filter requests before any write', async () => {
        const { host, recorder } = await open(); const good = request(host, 'waiting');
        for (const action of [{ ...good.action, status: 'done' }, { ...good.action, status: { toString: null } },
            { type: { toString: null }, taskId: 'n-draft' }, { ...good.action, afterId: null },
            { ...good.action, taskRevision: 'stale-revision' }, { type: 'moveCard', taskId: 'n-draft', status: 'waiting', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('n-draft')!) }]) {
            expect(host.prepareBoardAction({ requestId, action } as never).ok).toBe(false);
        }
        useTaskStore.setState(state => ({ settings: { ...state.settings, deviceId: undefined } }));
        expect(host.prepareBoardAction(good)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(recorder.log).toEqual([]);
    });

});
