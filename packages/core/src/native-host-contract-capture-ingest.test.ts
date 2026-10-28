import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import type { PendingCaptureAudioPort, PendingCaptureQueuePort, PendingCaptureRecordPort } from './pending-captures';
import { acquireWorkspaceTransitionLock } from './sandbox';
import { openScreenHost, requestId, restartScreenHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { Task } from './types';

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

/** The queue directory as the native file bridge would show it. `failDelete` files throw on their next delete, as a kill before the delete. */
function fakeQueue(files: Record<string, unknown>) {
    const stored = new Map(Object.entries(files).map(([name, body]) => [name, JSON.stringify(body)]));
    const failDelete = new Set<string>();
    const port: PendingCaptureQueuePort = {
        list: vi.fn(async () => [...stored.keys()]),
        read: vi.fn(async (name: string) => stored.get(name) ?? Promise.reject(new Error('missing file'))),
        delete: vi.fn(async (name: string) => {
            if (failDelete.delete(name)) throw new Error('killed before the delete');
            stored.delete(name);
        }),
    };
    return { port, stored, failDelete };
}

// The device's record of applied commands (RN's RKStorage value); it survives a restart.
let deviceRecord: string | null = null;
const record = (): PendingCaptureRecordPort => ({ read: async () => deviceRecord, write: async (value) => { deviceRecord = value; } });

const queueItems = {
    [`${CAPTURE_ID}.json`]: { id: CAPTURE_ID, title: 'From the dialog', source: 'android-quick-capture' },
    [`${INTENT_ID}.json`]: { kind: 'text', id: INTENT_ID, title: 'Dictated', source: 'android-capture-intent' },
    'c.json': { kind: 'complete', id: 'c1', taskId: 'open', source: 'android-widget' },
    'd.json': { kind: 'defer', id: 'd1', taskId: 'later', startDate: '2026-09-20', source: 'apple-watch' },
    [`${AUDIO_ID}.json`]: {
        kind: 'audio', id: AUDIO_ID, source: 'android-quick-capture',
        audioPath: `file:///data/files/quick-capture-audio/${AUDIO_ID}.wav`,
    },
    'timer.json': { kind: 'pomodoro', id: 'p1', action: 'start', source: 'apple-watch' },
};

const storeData = () => {
    const state = useTaskStore.getState();
    return [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
};

/** Replays a request on a new host, as after a restart, and says whether the store changed. */
async function replayAfterRestart<T>(replay: (host: ReturnType<typeof createNativeHostContract>) => Promise<NativeHostResult<T>> | NativeHostResult<T>) {
    const host = await restartScreenHost();
    const before = storeData();
    const result = await replay(host);
    return { result, wrote: storeData().some((entry, index) => entry !== before[index]) };
}

/** As after process death: memory is gone and the store loads what was saved. */
async function reloadStore() {
    await flushPendingSave();
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {}, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ silent: true });
}

afterEach(async () => {
    deviceRecord = null;
    vi.useRealTimers();
    await flushPendingSave();
    resetForTests();
});

describe('ingestPendingCaptures', () => {
    it('answers NOT_READY before the validated load and refuses a call without a request UUID or a queue', async () => {
        const queue = fakeQueue(queueItems);
        const cold = createNativeHostContract();
        expect(await cold.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: record() })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(queue.port.list).not.toHaveBeenCalled();

        const host = await openScreenHost({ data: {}, record: {}, log: [] });
        expect(await host.ingestPendingCaptures({ requestId: 'nope', queue: queue.port, lastApplied: record() })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.ingestPendingCaptures({ requestId: requestId(), queue: { list: queue.port.list } as never, lastApplied: record() }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(queue.port.list).not.toHaveBeenCalled();
    });

    it('stores captures, check-offs and defers once and leaves audio and Pomodoro items untouched', async () => {
        const host = await openScreenHost({ data: { tasks: [task('open'), task('later')] }, record: {}, log: [] });
        const queue = fakeQueue(queueItems);

        expect(value(await host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: record() }))).toEqual({ ingested: 4 });

        const tasks = useTaskStore.getState()._allTasks;
        expect(tasks.map((entry) => [entry.id, entry.status])).toEqual([
            ['open', 'done'], ['later', 'next'], [CAPTURE_ID, 'inbox'], [INTENT_ID, 'inbox'],
        ]);
        expect(tasks.find((entry) => entry.id === 'later')?.startTime).toBe('2026-09-20');
        expect([...queue.stored.keys()].sort()).toEqual([`${AUDIO_ID}.json`, 'timer.json']);
        expect(vi.mocked(queue.port.delete).mock.calls.map(([name]) => name)).not.toContain(`${AUDIO_ID}.json`);
        expect(vi.mocked(queue.port.delete).mock.calls.map(([name]) => name)).not.toContain('timer.json');
    });

    it('replayed after a restart that followed a kill between the save and the deletes, stores nothing twice', async () => {
        const host = await openScreenHost({ data: { tasks: [task('open'), task('later')] }, record: {}, log: [] });
        const queue = fakeQueue(queueItems);
        for (const name of Object.keys(queueItems)) queue.failDelete.add(name);
        const request = requestId();

        // Stored, but every file stays: owed (the journal keeps the request), not a success.
        expect(await host.ingestPendingCaptures({ requestId: request, queue: queue.port, lastApplied: record() }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(queue.stored.size).toBe(6);

        await reloadStore();
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.ingestPendingCaptures({ requestId: request, queue: queue.port, lastApplied: record() }));

        expect(value(result)).toEqual({ ingested: 4 });
        expect(wrote).toBe(false);
        expect(useTaskStore.getState()._allTasks.map((entry) => entry.id)).toEqual(['open', 'later', CAPTURE_ID, INTENT_ID]);
        expect([...queue.stored.keys()].sort()).toEqual([`${AUDIO_ID}.json`, 'timer.json']);
    });

    it('keeps each file while its save fails, and a later run recovers the save before deleting it', async () => {
        let failSaves = false;
        const host = await openScreenHost({
            data: { tasks: [task('open')] },
            record: {},
            log: [],
            saveData: async () => { if (failSaves) throw new Error('disk unavailable'); },
        });
        vi.useFakeTimers();
        failSaves = true;
        const queue = fakeQueue({ [`${CAPTURE_ID}.json`]: queueItems[`${CAPTURE_ID}.json`], 'c.json': queueItems['c.json'] });

        const first = host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: record() });
        await vi.advanceTimersByTimeAsync(30_000);
        // Stored but not saved: owed (the journal keeps the request), never a success.
        expect(await first).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(queue.port.delete).not.toHaveBeenCalled();
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull();

        failSaves = false;
        const second = host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: record() });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(value(await second)).toEqual({ ingested: 2 });
        expect(queue.stored.size).toBe(0);
        expect(useTaskStore.getState().persistenceFailure).toBeNull();
        expect(useTaskStore.getState()._allTasks.filter((entry) => entry.id === CAPTURE_ID)).toHaveLength(1);
    }, 15_000);

    it('owes a check-off whose applied-command record did not reach the disk, removes its file, so a reopen stays open', async () => {
        const host = await openScreenHost({ data: { tasks: [task('open')] }, record: {}, log: [] });
        // Tapped a minute ago: an older completion would be archived by the reload's auto-archive.
        const checkOff = { kind: 'complete', id: 'c9', taskId: 'open', createdAt: new Date(Date.now() - 60_000).toISOString(), source: 'android-widget' };
        const queue = fakeQueue({ 'c.json': checkOff });
        let failRecord = true;
        const flaky: PendingCaptureRecordPort = {
            read: async () => deviceRecord,
            write: async (next) => { if (failRecord) throw new Error('disk full'); deviceRecord = next; },
        };
        const request = requestId();

        // The check-off is stored and saved, but its record is not on disk: a retryable failure, never a success. Its file goes
        // anyway, so nothing can apply it again.
        expect(await host.ingestPendingCaptures({ requestId: request, queue: queue.port, lastApplied: flaky }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(queue.stored.has('c.json')).toBe(false);
        expect(deviceRecord).toBeNull();

        // The journal kept the request: its replay after a restart finds nothing left.
        failRecord = false;
        await reloadStore();
        const restarted = await restartScreenHost();
        expect(value(await restarted.ingestPendingCaptures({ requestId: request, queue: queue.port, lastApplied: flaky }))).toEqual({ ingested: 0 });

        // Reopened after the recovery, the task stays open through the next restart's drain.
        await useTaskStore.getState().updateTask('open', { status: 'next' });
        await reloadStore();
        const again = await restartScreenHost();
        expect(value(await again.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: flaky }))).toEqual({ ingested: 0 });
        expect(useTaskStore.getState()._allTasks.find((entry) => entry.id === 'open')?.status).toBe('next');
    });

    it('answers a retryable failure while a queued item stays after a failed read or a refused write', async () => {
        const host = await openScreenHost({ data: { tasks: [task('open')] }, record: {}, log: [] });
        const unreadable: PendingCaptureRecordPort = { read: async () => { throw new Error('locked'); }, write: async () => undefined };
        const queue = fakeQueue({ 'c.json': queueItems['c.json'] });
        expect(await host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: unreadable }))
            .toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(useTaskStore.getState()._allTasks.find((entry) => entry.id === 'open')?.status).toBe('next');

        const unlisted = fakeQueue({});
        vi.mocked(unlisted.port.list).mockRejectedValueOnce(new Error('io'));
        expect(await host.ingestPendingCaptures({ requestId: requestId(), queue: unlisted.port, lastApplied: record() }))
            .toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });

        const refused = fakeQueue({ 'c.json': queueItems['c.json'] });
        const updateTask = vi.spyOn(useTaskStore.getState(), 'updateTask');
        useTaskStore.setState({ updateTask: async () => ({ success: false, error: 'refused' }) } as never);
        expect(await host.ingestPendingCaptures({ requestId: requestId(), queue: refused.port, lastApplied: record() }))
            .toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        useTaskStore.setState({ updateTask: updateTask.getMockImplementation() ?? updateTask } as never);
        expect(refused.stored.has('c.json')).toBe(true);

        expect(value(await host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: record() }))).toEqual({ ingested: 1 });
        expect(queue.stored.size).toBe(0);
    });

    it('never lets a later item\'s throw hide an earlier item that landed unfinished', async () => {
        const host = await openScreenHost({ data: { tasks: [task('open')] }, record: {}, log: [] });
        // A: a check-off that lands, but its record write fails. B: a capture whose store write throws.
        const checkOff = { kind: 'complete', id: 'a1', taskId: 'open', createdAt: new Date(Date.now() - 60_000).toISOString(), source: 'android-widget' };
        const queue = fakeQueue({ 'a.json': checkOff, [`b-${CAPTURE_ID}.json`]: { kind: 'text', id: CAPTURE_ID, title: 'B', source: 'android-capture-intent' } });
        let failRecord = true;
        const flaky: PendingCaptureRecordPort = {
            read: async () => deviceRecord,
            write: async (next) => { if (failRecord) throw new Error('disk full'); deviceRecord = next; },
        };
        const { addTask } = useTaskStore.getState();
        useTaskStore.setState({ addTask: async () => { throw new Error('store write failed'); } } as never);
        try {
            expect(await host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: flaky }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        } finally {
            useTaskStore.setState({ addTask });
        }
        expect(useTaskStore.getState()._allTasks.find((entry) => entry.id === 'open')?.status).toBe('done');

        // The user reopens A (after the owed retry, on the native host); a fresh drain keeps it open and stores B.
        failRecord = false;
        await useTaskStore.getState().updateTask('open', { status: 'next' });
        expect(value(await host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: flaky }))).toEqual({ ingested: 1 });
        expect(useTaskStore.getState()._allTasks.find((entry) => entry.id === 'open')?.status).toBe('next');
        expect(useTaskStore.getState()._allTasks.filter((entry) => entry.id === CAPTURE_ID)).toHaveLength(1);
        expect(queue.stored.size).toBe(0);
    });

    it('reads nothing during a workspace switch', async () => {
        const host = await openScreenHost({ data: {}, record: {}, log: [] });
        const queue = fakeQueue(queueItems);
        const release = acquireWorkspaceTransitionLock()!;
        try {
            expect(value(await host.ingestPendingCaptures({ requestId: requestId(), queue: queue.port, lastApplied: record() }))).toEqual({ ingested: 0 });
        } finally {
            release();
        }
        expect(queue.port.list).not.toHaveBeenCalled();
    });
});

/** The widget's WAVs as Kotlin's files would show them; `transcript` is what the host's speech provider answers (null: none set up). */
function fakeAudio(transcript: () => string | null) {
    const wavs = new Set([`file:///data/files/quick-capture-audio/${AUDIO_ID}.wav`]);
    const port: PendingCaptureAudioPort = {
        resolvePath: (capture) => (capture.audioPath === `file:///data/files/quick-capture-audio/${capture.id}.wav` ? capture.audioPath : null),
        transcribe: vi.fn(async () => transcript()),
        delete: vi.fn(async (path: string) => { wavs.delete(path); }),
    };
    return { port, wavs };
}

describe('ingestPendingAudio', () => {
    it('turns a queued widget recording into one task under its capture id, removes its file and WAV, and leaves every other item', async () => {
        const host = await openScreenHost({ data: { tasks: [task('open'), task('later')] }, record: {}, log: [] });
        const queue = fakeQueue(queueItems);
        const audio = fakeAudio(() => 'Buy milk');

        expect(value(await host.ingestPendingAudio({ queue: queue.port, lastApplied: record(), audio: audio.port }))).toEqual({ ingested: 1 });

        const created = useTaskStore.getState()._allTasks.filter((entry) => entry.id === AUDIO_ID);
        expect(created.map((entry) => [entry.title, entry.status])).toEqual([['Buy milk', 'inbox']]);
        expect(queue.stored.has(`${AUDIO_ID}.json`)).toBe(false);
        expect(audio.wavs.size).toBe(0);
        // Text captures, check-offs, defers and Pomodoro commands stay for the journaled ingest.
        expect([...queue.stored.keys()].sort()).toEqual([`${CAPTURE_ID}.json`, `${INTENT_ID}.json`, 'c.json', 'd.json', 'timer.json']);
        expect(useTaskStore.getState()._allTasks.find((entry) => entry.id === 'open')?.status).toBe('next');

        // Again (the file already gone): nothing twice.
        expect(value(await host.ingestPendingAudio({ queue: queue.port, lastApplied: record(), audio: audio.port }))).toEqual({ ingested: 0 });
        expect(useTaskStore.getState()._allTasks.filter((entry) => entry.id === AUDIO_ID)).toHaveLength(1);
    });

    it('a kill before the deletes replays without a second task', async () => {
        const host = await openScreenHost({ data: { tasks: [] }, record: {}, log: [] });
        const queue = fakeQueue({ [`${AUDIO_ID}.json`]: queueItems[`${AUDIO_ID}.json`] });
        queue.failDelete.add(`${AUDIO_ID}.json`);
        const audio = fakeAudio(() => 'Call the bank');

        expect(value(await host.ingestPendingAudio({ queue: queue.port, lastApplied: record(), audio: audio.port }))).toEqual({ ingested: 0 });
        expect(queue.stored.has(`${AUDIO_ID}.json`)).toBe(true);

        await reloadStore();
        const restarted = await restartScreenHost();
        expect(value(await restarted.ingestPendingAudio({ queue: queue.port, lastApplied: record(), audio: audio.port }))).toEqual({ ingested: 1 });
        expect(useTaskStore.getState()._allTasks.filter((entry) => entry.id === AUDIO_ID).map((entry) => entry.title)).toEqual(['Call the bank']);
        expect(queue.stored.size).toBe(0);
        expect(audio.wavs.size).toBe(0);
    });

    it('with no speech provider set up keeps the item and its WAV, and after a restart with one set up makes it once', async () => {
        const host = await openScreenHost({ data: { tasks: [] }, record: {}, log: [] });
        const queue = fakeQueue({ [`${AUDIO_ID}.json`]: queueItems[`${AUDIO_ID}.json`] });
        let transcript: string | null = null;
        const audio = fakeAudio(() => transcript);

        expect(value(await host.ingestPendingAudio({ queue: queue.port, lastApplied: record(), audio: audio.port }))).toEqual({ ingested: 0 });
        expect(queue.stored.has(`${AUDIO_ID}.json`)).toBe(true);
        expect(audio.wavs.size).toBe(1);
        expect(useTaskStore.getState()._allTasks).toEqual([]);

        await reloadStore();
        const restarted = await restartScreenHost();
        transcript = 'Pick up the parcel';
        expect(value(await restarted.ingestPendingAudio({ queue: queue.port, lastApplied: record(), audio: audio.port }))).toEqual({ ingested: 1 });
        expect(value(await restarted.ingestPendingAudio({ queue: queue.port, lastApplied: record(), audio: audio.port }))).toEqual({ ingested: 0 });
        expect(useTaskStore.getState()._allTasks.map((entry) => [entry.id, entry.title])).toEqual([[AUDIO_ID, 'Pick up the parcel']]);
    });

    it('answers NOT_READY before the validated load and refuses a call without an audio port', async () => {
        const queue = fakeQueue({});
        expect(await createNativeHostContract().ingestPendingAudio({ queue: queue.port, lastApplied: record(), audio: fakeAudio(() => null).port }))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        const host = await openScreenHost({ data: { tasks: [] }, record: {}, log: [] });
        expect(await host.ingestPendingAudio({ queue: queue.port, lastApplied: record() } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});

describe('runContextAutomation', () => {
    const tasks = [
        task('a', { title: 'Water plants', contexts: ['@home'] }),
        task('b', { title: 'Fix sink', contexts: ['@home/kitchen'] }),
        task('c', { title: 'Email', contexts: ['@work'] }),
    ];

    it('answers the notification for an activation, and nothing for a deactivation, a repeat or unreadable data', async () => {
        const host = await openScreenHost({ data: { tasks }, record: {}, log: [] });

        expect(value(host.runContextAutomation({ url: 'mindwtr://contexts?token=%40home&contextAction=activate' }))).toEqual({
            notification: { title: '2 @home next actions', message: '- Fix sink\n- Water plants', data: { kind: 'context-automation', context: '@home' } },
        });
        expect(value(host.runContextAutomation({ action: 'ON', context: '@home' }))).toEqual({ notification: null });
        expect(value(host.runContextAutomation({ action: 'off', context: '@work' }))).toEqual({ notification: null });
        expect(value(host.runContextAutomation({ action: 'toggle', context: '@work' }))).toEqual({ notification: null });
        expect(host.runContextAutomation({ url: 42 } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(createNativeHostContract().runContextAutomation({ action: 'on', context: '@work' })).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    });

    it('replayed after a restart, writes nothing and answers the same notification', async () => {
        const host = await openScreenHost({ data: { tasks }, record: {}, log: [] });
        const input = { action: 'activate', context: 'work' };
        const first = value(host.runContextAutomation(input));
        expect(first.notification).toMatchObject({ title: '@work next action', message: 'Email' });

        const { result, wrote } = await replayAfterRestart((restarted) => restarted.runContextAutomation(input));
        expect(value(result)).toEqual(first);
        expect(wrote).toBe(false);
    });
});
