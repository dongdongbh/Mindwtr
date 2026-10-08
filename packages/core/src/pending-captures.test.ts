import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyPendingChecklist,
    parsePendingCapture,
    drainPendingCaptureQueue,
    type PendingCaptureDrainDeps,
    type PendingCaptureQueuePort,
    type PendingCaptureRecordPort,
    type PendingChecklist,
} from './pending-captures';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';

// React Native's own tests (apps/mobile/lib/pending-captures.test.ts) replay every
// branch through the React Native binding. These drive core's drain over fake ports
// and a real store: what the native app's runner will call.

const CAPTURE_ID = '0b6f1c4e-7a3d-4c55-9e21-4f7a8a1d2c01';
const INTENT_ID = '5c2e9d10-3b4a-4f6e-8d7c-1a2b3c4d5e6f';
const AUDIO_ID = '22222222-2222-4abc-8def-222222222222';

const task = (id: string, props: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    ...props,
} as Task);

/** A queue directory in memory. `failDelete` names files whose next delete throws, as a kill before the delete would leave them. */
function fakeQueue(files: Record<string, unknown>) {
    const stored = new Map(Object.entries(files).map(([name, body]) => [name, typeof body === 'string' ? body : JSON.stringify(body)]));
    const failDelete = new Set<string>();
    const port: PendingCaptureQueuePort = {
        list: vi.fn(async () => [...stored.keys()]),
        read: vi.fn(async (name: string) => {
            const body = stored.get(name);
            if (body === undefined) throw new Error('missing file');
            return body;
        }),
        delete: vi.fn(async (name: string) => {
            if (failDelete.delete(name)) throw new Error('killed before the delete');
            stored.delete(name);
        }),
    };
    return { port, stored, failDelete };
}

// Each test's own storage, so a late save from an earlier test cannot land in it.
let saved: () => AppData;
// The device's record of applied commands, kept across a test's drains and restarts.
let lastApplied: PendingCaptureRecordPort;

async function openStore(tasks: Task[]) {
    await flushPendingSave();
    resetForTests();
    let persisted: AppData = { tasks, projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'queue-test' } };
    saved = () => persisted;
    let record: string | null = null;
    lastApplied = { read: async () => record, write: async (value) => { record = value; } };
    setStorageAdapter({
        getData: async () => structuredClone(persisted),
        saveData: async (data) => { persisted = structuredClone(data); },
    });
    useTaskStore.setState({
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    await useTaskStore.getState().fetchData({ silent: true });
}

/** As after process death: the store forgets memory and loads what was saved. */
async function restartStore() {
    await flushPendingSave();
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {} });
    await useTaskStore.getState().fetchData({ silent: true });
}

function storeDeps(queue: PendingCaptureQueuePort, extra: Partial<PendingCaptureDrainDeps> = {}): PendingCaptureDrainDeps {
    const { addTask, updateTask, addProject, projects, areas, tasks, people, settings } = useTaskStore.getState();
    return {
        addTask, updateTask, addProject, projects, areas, tasks, people, settings,
        getTasks: () => useTaskStore.getState()._allTasks,
        flushPendingSave,
        queue,
        lastApplied,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ...extra,
    };
}

const storeData = () => {
    const state = useTaskStore.getState();
    return [state._allTasks, state._allProjects, state._allAreas, state._allPeople, state.settings];
};

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
});

describe('Watch checklist delivery', () => {
    const milk = { id: 'same', title: 'Milk', isCompleted: false };
    const eggs = { id: 'same', title: 'Eggs', isCompleted: false };
    const command = (overrides: Partial<PendingChecklist> = {}): PendingChecklist => ({
        kind: 'checklist', id: CAPTURE_ID, source: 'apple-watch', taskId: 'shopping',
        taskCreatedAt: '2026-09-01T12:00:00.000Z', createdAt: '2026-10-07T12:00:00.000Z',
        itemId: milk.id, itemTitle: milk.title, isCompleted: true, ...overrides,
    });

    it('preserves reordered/phone-added rows, survives restart and does not replay over a phone edit', async () => {
        await openStore([task('shopping', { checklist: [eggs, milk, { id: 'rice', title: 'Rice', isCompleted: false }] })]);
        const queue = fakeQueue({ 'a.json': command() });
        queue.failDelete.add('a.json');
        const settle = vi.fn(async () => {
            expect(saved().tasks[0].checklist?.[1].isCompleted).toBe(true);
        });
        await drainPendingCaptureQueue(storeDeps(queue.port, { settleWatchChecklist: settle }));
        expect(saved().tasks[0].checklist?.map((item) => item.title)).toEqual(['Eggs', 'Milk', 'Rice']);
        await restartStore();
        await useTaskStore.getState().updateTask('shopping', { checklist: [eggs, milk] });
        await flushPendingSave();
        await drainPendingCaptureQueue(storeDeps(queue.port, { settleWatchChecklist: async () => undefined }));
        expect(useTaskStore.getState().tasks[0].checklist?.[1].isCompleted).toBe(false);
        expect(queue.stored.size).toBe(0);
    });

    it('orders rapid check/uncheck per item without discarding another item', async () => {
        await openStore([task('shopping', { checklist: [milk, eggs] })]);
        const settle = vi.fn(async () => undefined);
        const queue = fakeQueue({
            'first.json': command(),
            'later.json': command({ id: INTENT_ID, createdAt: '2026-10-07T12:00:02.000Z', isCompleted: false }),
        });
        await drainPendingCaptureQueue(storeDeps(queue.port, { settleWatchChecklist: settle }));
        queue.stored.set('delayed.json', JSON.stringify(command({ id: AUDIO_ID, itemTitle: 'Eggs', createdAt: '2026-10-07T12:00:01.000Z' })));
        queue.stored.set('old.json', JSON.stringify(command()));
        await drainPendingCaptureQueue(storeDeps(queue.port, { settleWatchChecklist: settle }));
        expect(saved().tasks[0].checklist?.map((item) => item.isCompleted)).toEqual([false, true]);
        expect(settle).toHaveBeenCalledWith(CAPTURE_ID, 'stale');
    });

    it('rejects ambiguous, renamed, removed and terminal items', async () => {
        for (const props of [
            { checklist: [milk, milk] }, { checklist: [eggs] }, { checklist: [] },
            { checklist: [milk], deletedAt: '2026-10-07' },
            { checklist: [milk], status: 'archived' as const },
            { checklist: [milk], createdAt: '2026-09-02T12:00:00.000Z' },
        ]) {
            await openStore([task('shopping', props)]);
            const updateTask = vi.fn(async () => undefined);
            expect(await applyPendingChecklist(command(), { ...storeDeps(fakeQueue({}).port), updateTask })).not.toBe('applied');
            expect(updateTask).not.toHaveBeenCalled();
        }
        expect(parsePendingCapture(JSON.stringify(command({ isCompleted: 'true' as never })))).toBeNull();
    });

    it('follows list completion/reopening while ordinary tasks retain status', async () => {
        for (const taskMode of ['list', 'task'] as const) {
            await openStore([task('shopping', { checklist: [milk], taskMode })]);
            await applyPendingChecklist(command(), storeDeps(fakeQueue({}).port));
            expect(useTaskStore.getState().tasks[0].status).toBe(taskMode === 'list' ? 'done' : 'next');
            await applyPendingChecklist(command({ isCompleted: false }), storeDeps(fakeQueue({}).port));
            expect(useTaskStore.getState().tasks[0].status).toBe('next');
        }
    });

    it('does not acknowledge before save and ordering persistence; retries the same command', async () => {
        await openStore([task('shopping', { checklist: [milk] })]);
        const queue = fakeQueue({ 'a.json': command() });
        const settle = vi.fn(async () => undefined);
        await drainPendingCaptureQueue(storeDeps(queue.port, {
            settleWatchChecklist: settle, flushPendingSave: async () => { throw new Error('disk full'); },
        }));
        expect(settle).not.toHaveBeenCalled();
        expect(queue.stored.size).toBe(1);
        await drainPendingCaptureQueue(storeDeps(queue.port, { settleWatchChecklist: settle }));
        expect(settle).toHaveBeenCalledWith(CAPTURE_ID, 'applied');
        expect(queue.stored.size).toBe(0);
    });

    it('advances a recurring list once and never applies its delayed uncheck to the next occurrence', async () => {
        await openStore([task('shopping', { checklist: [milk], taskMode: 'list', recurrence: { rule: 'daily' }, dueDate: '2026-10-07' })]);
        const deps = storeDeps(fakeQueue({}).port);
        expect(await applyPendingChecklist(command(), deps)).toBe('applied');
        await flushPendingSave();
        const count = useTaskStore.getState()._allTasks.length;
        expect(count).toBe(2);
        expect(await applyPendingChecklist(command(), deps)).toBe('applied');
        expect(await applyPendingChecklist(command({ isCompleted: false }), deps)).toBe('terminal');
        expect(useTaskStore.getState()._allTasks).toHaveLength(count);
        expect(useTaskStore.getState()._allTasks.find((item) => item.id !== 'shopping')?.checklist?.[0].isCompleted).toBe(false);
    });

    it('retains commands on ordering-record failure and stops later commands from overtaking', async () => {
        await openStore([task('shopping', { checklist: [milk, eggs] })]);
        const queue = fakeQueue({ 'a.json': command(), 'b.json': command({ id: INTENT_ID, itemTitle: 'Eggs', createdAt: '2026-10-07T12:00:01.000Z' }) });
        const settle = vi.fn(async () => undefined);
        await drainPendingCaptureQueue(storeDeps(queue.port, {
            settleWatchChecklist: settle,
            lastApplied: { read: lastApplied.read, write: async () => { throw new Error('record unavailable'); } },
        }));
        expect(settle).not.toHaveBeenCalled();
        expect(queue.stored.size).toBe(2);
        expect(saved().tasks[0].checklist?.[1].isCompleted).toBe(false);
        await drainPendingCaptureQueue(storeDeps(queue.port, { settleWatchChecklist: settle }));
        expect(saved().tasks[0].checklist?.every((item) => item.isCompleted)).toBe(true);
        expect(queue.stored.size).toBe(0);
    });
});

describe('drainPendingCaptureQueue', () => {
    const items = {
        [`${CAPTURE_ID}.json`]: { id: CAPTURE_ID, title: 'From the dialog', source: 'android-quick-capture' },
        [`${INTENT_ID}.json`]: { kind: 'text', id: INTENT_ID, title: 'Dictated #errands', source: 'android-capture-intent' },
        'c.json': { kind: 'complete', id: 'c1', taskId: 'open', completedAt: '2026-09-02T08:00:00.000Z', source: 'android-widget' },
        'd.json': { kind: 'defer', id: 'd1', taskId: 'later', startDate: '2026-09-20', source: 'apple-watch' },
    };

    it('stores each capture, text, check-off and defer once, and a replay of the same files writes nothing', async () => {
        await openStore([task('open'), task('later')]);
        const queue = fakeQueue(items);

        expect(await drainPendingCaptureQueue(storeDeps(queue.port))).toBe(4);

        const tasks = useTaskStore.getState()._allTasks;
        expect(tasks.filter((entry) => entry.id === CAPTURE_ID)).toMatchObject([{ title: 'From the dialog', status: 'inbox' }]);
        expect(tasks.filter((entry) => entry.id === INTENT_ID)).toMatchObject([{ title: 'Dictated', tags: ['#errands'], status: 'inbox' }]);
        expect(tasks.find((entry) => entry.id === 'open')).toMatchObject({ status: 'done', completedAt: '2026-09-02T08:00:00.000Z' });
        expect(tasks.find((entry) => entry.id === 'later')?.startTime).toBe('2026-09-20');
        expect(tasks).toHaveLength(4);
        expect(queue.stored.size).toBe(0);
        expect(saved().tasks).toHaveLength(4);

        // The same files again, as when the writer or a restore replays them.
        const replay = fakeQueue(items);
        const before = storeData();
        expect(await drainPendingCaptureQueue(storeDeps(replay.port))).toBe(4);
        expect(storeData()).toEqual(before);
        storeData().forEach((entry, index) => expect(entry).toBe(before[index]));
        expect(replay.stored.size).toBe(0);
    });

    it('does not duplicate a capture or repeat a check-off when the app died between the save and the delete', async () => {
        await openStore([task('open'), task('later')]);
        const queue = fakeQueue(items);
        for (const name of Object.keys(items)) queue.failDelete.add(name);

        expect(await drainPendingCaptureQueue(storeDeps(queue.port))).toBe(0);
        expect(queue.stored.size).toBe(4);
        expect(saved().tasks).toHaveLength(4);

        await restartStore();
        const before = storeData();
        expect(await drainPendingCaptureQueue(storeDeps(queue.port))).toBe(4);

        storeData().forEach((entry, index) => expect(entry).toBe(before[index]));
        const tasks = useTaskStore.getState()._allTasks;
        expect(tasks.filter((entry) => entry.id === CAPTURE_ID)).toHaveLength(1);
        expect(tasks.filter((entry) => entry.id === INTENT_ID)).toHaveLength(1);
        expect(tasks).toHaveLength(4);
        expect(queue.stored.size).toBe(0);
    });

    it('keeps a file whose save did not become durable, and drains it once the save recovers', async () => {
        await openStore([]);
        const queue = fakeQueue({ [`${CAPTURE_ID}.json`]: items[`${CAPTURE_ID}.json`] });
        const failingFlush = vi.fn(async () => { throw new Error('disk full'); });

        expect(await drainPendingCaptureQueue(storeDeps(queue.port, { flushPendingSave: failingFlush }))).toBe(0);
        expect(queue.stored.size).toBe(1);
        expect(queue.port.delete).not.toHaveBeenCalled();

        expect(await drainPendingCaptureQueue(storeDeps(queue.port))).toBe(1);
        expect(useTaskStore.getState()._allTasks.filter((entry) => entry.id === CAPTURE_ID)).toHaveLength(1);
        expect(queue.stored.size).toBe(0);
    });

    describe('a capture that makes a +Project', () => {
        const liveProjects = () => useTaskStore.getState()._allProjects.filter((project) => !project.deletedAt);
        const renameTrip = async () => {
            const trip = liveProjects().find((project) => project.title === 'Trip')!;
            await useTaskStore.getState().updateProject(trip.id, { title: 'Journey' });
        };

        it('replayed after its task was stored, writes nothing, even after the project was renamed', async () => {
            await openStore([]);
            const queue = fakeQueue({ [`${CAPTURE_ID}.json`]: { id: CAPTURE_ID, title: 'Buy milk +Trip', source: 'android-quick-capture' } });
            queue.failDelete.add(`${CAPTURE_ID}.json`);

            expect(await drainPendingCaptureQueue(storeDeps(queue.port))).toBe(0);
            await renameTrip();
            await restartStore();
            const before = storeData();

            expect(await drainPendingCaptureQueue(storeDeps(queue.port))).toBe(1);
            storeData().forEach((entry, index) => expect(entry).toBe(before[index]));
            expect(liveProjects().map((project) => project.title)).toEqual(['Journey']);
            expect(queue.stored.size).toBe(0);
        });

        it('replayed after its task save failed, takes the project it made, renamed since, and makes no second one', async () => {
            await openStore([]);
            const queue = fakeQueue({ [`${CAPTURE_ID}.json`]: { id: CAPTURE_ID, title: 'Buy milk +Trip', source: 'android-quick-capture' } });
            const refuseTask = vi.fn(async () => ({ success: false, error: 'store unavailable' }));

            expect(await drainPendingCaptureQueue(storeDeps(queue.port, { addTask: refuseTask }))).toBe(0);
            expect(liveProjects().map((project) => project.title)).toEqual(['Trip']);
            await renameTrip();

            expect(await drainPendingCaptureQueue(storeDeps(queue.port))).toBe(1);
            const [journey] = liveProjects();
            expect(liveProjects().map((project) => project.title)).toEqual(['Journey']);
            expect(useTaskStore.getState()._allTasks.find((entry) => entry.id === CAPTURE_ID)).toMatchObject({ title: 'Buy milk', projectId: journey.id });
        });

        it('replayed after the project it made was deleted, makes no project and keeps its verbatim title', async () => {
            await openStore([]);
            const queue = fakeQueue({ [`${CAPTURE_ID}.json`]: { id: CAPTURE_ID, title: 'Buy milk +Trip', source: 'android-quick-capture' } });
            const refuseTask = vi.fn(async () => ({ success: false, error: 'store unavailable' }));
            const allProjects = () => useTaskStore.getState()._allProjects;

            expect(await drainPendingCaptureQueue(storeDeps(queue.port, { addTask: refuseTask, getProjects: allProjects }))).toBe(0);
            await useTaskStore.getState().deleteProject(liveProjects()[0].id);

            expect(await drainPendingCaptureQueue(storeDeps(queue.port, { getProjects: allProjects }))).toBe(1);
            expect(liveProjects()).toEqual([]);
            expect(new Set(allProjects().map((project) => project.id)).size).toBe(allProjects().length);
            expect(useTaskStore.getState()._allTasks.find((entry) => entry.id === CAPTURE_ID)).toMatchObject({ title: 'Buy milk +Trip' });
            expect(useTaskStore.getState()._allTasks.find((entry) => entry.id === CAPTURE_ID)?.projectId).toBeUndefined();
        });
    });

    it('leaves audio and Pomodoro items in the queue untouched without their host ports', async () => {
        await openStore([task('open')]);
        const queue = fakeQueue({
            [`${AUDIO_ID}.json`]: {
                kind: 'audio', id: AUDIO_ID, source: 'android-quick-capture',
                audioPath: `file:///data/files/quick-capture-audio/${AUDIO_ID}.wav`,
            },
            // An audio item whose path a host would refuse is kept too: only the host can judge it.
            'bad-audio.json': { kind: 'audio', id: 'not-a-uuid', audioPath: 'file:///etc/passwd', source: 'android-quick-capture' },
            'timer.json': { kind: 'pomodoro', id: 'p1', action: 'start', taskId: 'open', source: 'apple-watch' },
            'z.json': { id: 'shortcut-1', title: 'Still drained' },
        });
        const before = useTaskStore.getState()._allTasks;

        expect(await drainPendingCaptureQueue(storeDeps(queue.port))).toBe(1);

        expect([...queue.stored.keys()].sort()).toEqual([`${AUDIO_ID}.json`, 'bad-audio.json', 'timer.json']);
        expect(queue.port.delete).toHaveBeenCalledTimes(1);
        expect(queue.port.delete).toHaveBeenCalledWith('z.json');
        const added = useTaskStore.getState()._allTasks.filter((entry) => !before.includes(entry));
        expect(added.map((entry) => entry.title)).toEqual(['Still drained']);
    });

    it('reads nothing when the queue directory does not exist, and logs a list failure without throwing', async () => {
        await openStore([]);
        const missing: PendingCaptureQueuePort = { list: vi.fn(async () => null), read: vi.fn(), delete: vi.fn() };
        expect(await drainPendingCaptureQueue(storeDeps(missing))).toBe(0);
        expect(missing.read).not.toHaveBeenCalled();

        const broken: PendingCaptureQueuePort = { list: vi.fn(async () => { throw new Error('io'); }), read: vi.fn(), delete: vi.fn() };
        const deps = storeDeps(broken);
        expect(await drainPendingCaptureQueue(deps)).toBe(0);
        expect(deps.log.error).toHaveBeenCalledWith(expect.any(Error), { scope: 'shortcuts', extra: { message: 'Failed to read pending captures' } });
    });
});
