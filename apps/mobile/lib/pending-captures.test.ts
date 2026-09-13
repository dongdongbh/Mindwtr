import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushPendingSave as flushCorePendingSave,
    resetForTests as resetCoreForTests,
    setStorageAdapter,
    useTaskStore,
} from '@mindwtr/core';
import type { AppData, Person, Project, StorageAdapter, Task } from '@mindwtr/core';

const fileSystemMocks = vi.hoisted(() => ({
    documentDirectory: 'file:///data/Documents/',
    getInfoAsync: vi.fn(),
    readDirectoryAsync: vi.fn(),
    readAsStringAsync: vi.fn(),
    deleteAsync: vi.fn(),
}));

vi.mock('./file-system', () => fileSystemMocks);
const appLogMocks = vi.hoisted(() => ({
    logError: vi.fn(async () => undefined),
    logInfo: vi.fn<typeof import('./app-log').logInfo>(async () => null),
    logWarn: vi.fn(async () => undefined),
}));
vi.mock('./app-log', () => appLogMocks);

// eslint-disable-next-line import/first
import {
    buildPendingCaptureTaskProps,
    ingestPendingCaptures,
    isSafeAndroidQuickCaptureAudioPath,
    isSafeWatchAudioPath,
    parsePendingCapture,
    resolveSafeAndroidQuickCaptureAudioPath,
    resolveSafeWatchAudioPath,
    type PendingCapture,
} from './pending-captures';
import { flushPendingTaskActionSave } from './pending-capture-persistence';

// The capture-shaped tests read capture fields; narrow once here.
const parseCapture = (raw: string) => parsePendingCapture(raw) as PendingCapture | null;
const WATCH_AUDIO_ID = '11111111-1111-4111-8111-111111111111';
const ANDROID_AUDIO_ID = '22222222-2222-4abc-8def-222222222222';

const project = (props: Partial<Project>): Project => ({
    id: 'p1',
    title: 'Errands',
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...props,
} as Project);

describe('parsePendingCapture', () => {
    it('parses a full payload and splits tags', () => {
        expect(parsePendingCapture(JSON.stringify({
            id: 'abc',
            title: 'Take out the trash',
            note: 'Bins to the curb',
            tags: 'home, chores',
            project: 'Errands',
        }))).toEqual({
            id: 'abc',
            title: 'Take out the trash',
            note: 'Bins to the curb',
            tags: ['home', 'chores'],
            project: 'Errands',
        });
    });

    it('parses a widget check-off and rejects one without a task id or with an unknown kind', () => {
        expect(parsePendingCapture(JSON.stringify({ kind: 'complete', id: 'c1', taskId: 't1', completedAt: '2026-09-06T10:00:00.000Z', source: 'android-widget' })))
            .toEqual({ kind: 'complete', id: 'c1', taskId: 't1', completedAt: '2026-09-06T10:00:00.000Z', source: 'android-widget' });
        expect(parsePendingCapture(JSON.stringify({ kind: 'complete', id: 'c1' }))).toBeNull();
        expect(parsePendingCapture(JSON.stringify({ kind: 'archive', id: 'c1', title: 'x' }))).toBeNull();
        expect(parseCapture(JSON.stringify({ kind: 'capture', id: 'c1', title: 'Still a capture' }))?.title).toBe('Still a capture');
    });

    it('keeps legacy text compatible and parses every Watch queue variant', () => {
        expect(parseCapture(JSON.stringify({ kind: 'text', id: 't1', title: 'Watch thought', source: 'apple-watch' })))
            .toMatchObject({ kind: 'text', id: 't1', title: 'Watch thought', tags: [] });
        expect(parsePendingCapture(JSON.stringify({ kind: 'audio', id: 'a1', audioPath: 'file:///data/Documents/watch-audio/a1.wav' })))
            .toMatchObject({ kind: 'audio', id: 'a1' });
        expect(parsePendingCapture(JSON.stringify({ kind: 'defer', id: 'd1', taskId: 'task-1', startDate: '2026-09-07' })))
            .toMatchObject({ kind: 'defer', taskId: 'task-1', startDate: '2026-09-07' });
        expect(parsePendingCapture(JSON.stringify({ kind: 'pomodoro', id: 'p1', action: 'start', taskId: 'task-1' })))
            .toMatchObject({ kind: 'pomodoro', action: 'start', taskId: 'task-1' });
        expect(parsePendingCapture(JSON.stringify({ kind: 'defer', id: 'd1', taskId: 'task-1', startDate: '2026-02-30' }))).toBeNull();
        expect(parsePendingCapture(JSON.stringify({ kind: 'pomodoro', id: 'p1', action: 'toggle' }))).toBeNull();
    });

    it('parses only strict Watch outbox retry markers on text and audio captures', () => {
        expect(parsePendingCapture(JSON.stringify({
            kind: 'text', id: 't1', title: 'Retry text', source: 'apple-watch', outboxRetried: true,
        }))).toMatchObject({ kind: 'text', outboxRetried: true });
        expect(parsePendingCapture(JSON.stringify({
            kind: 'audio', id: 'a1', audioPath: 'file:///data/Documents/watch-audio/a1.wav',
            source: 'apple-watch', outboxRetried: true,
        }))).toMatchObject({ kind: 'audio', outboxRetried: true });

        for (const outboxRetried of ['true', 1, false]) {
            expect(parsePendingCapture(JSON.stringify({
                kind: 'text', id: 't1', title: 'Retry text', source: 'apple-watch', outboxRetried,
            }))).toBeNull();
        }
        expect(parsePendingCapture(JSON.stringify({
            kind: 'complete', id: 'c1', taskId: 'task-1', source: 'apple-watch', outboxRetried: true,
        }))).toBeNull();
    });

    it('trims the optional typed prefix on an audio capture', () => {
        expect(parsePendingCapture(JSON.stringify({
            kind: 'audio',
            id: ANDROID_AUDIO_ID,
            audioPath: `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            source: 'android-quick-capture',
            title: '  Plan launch  ',
        }))).toMatchObject({ kind: 'audio', title: 'Plan launch' });
    });

    it('confines Watch audio deletion to the exact queue id under Documents/watch-audio', () => {
        const id = WATCH_AUDIO_ID;
        expect(resolveSafeWatchAudioPath(
            `file:///old/container/Documents/watch-audio/${id}.wav`,
            id,
        )).toBe(`file:///data/Documents/watch-audio/${id}.wav`);
        expect(resolveSafeWatchAudioPath(
            `FILE:///old/container/Documents/watch-audio/${id}.wav`,
            id,
        )).toBe(`file:///data/Documents/watch-audio/${id}.wav`);
        expect(isSafeWatchAudioPath(`file:///data/Documents/watch-audio/${id}.wav`, id)).toBe(true);
        expect(isSafeWatchAudioPath('file:///data/Documents/watch-audio/other.wav', id)).toBe(false);
        expect(isSafeWatchAudioPath('file:///data/Documents/secret.wav', id)).toBe(false);
        expect(isSafeWatchAudioPath('file:///data/Documents/watch-audio/../secret.wav', id)).toBe(false);
        expect(isSafeWatchAudioPath(`file:///data/Documents/watch-audio/${id}.wav?alternate=1`, id)).toBe(false);
        expect(isSafeWatchAudioPath(`file://host/data/Documents/watch-audio/${id}.wav`, id)).toBe(false);
        expect(isSafeWatchAudioPath('file:///data/Documents/watch-audio/audio-1.wav', 'audio-1')).toBe(false);
    });

    it('accepts Android audio only at the current canonical owned path for the same UUID', () => {
        const expected = `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`;
        expect(resolveSafeAndroidQuickCaptureAudioPath(expected, ANDROID_AUDIO_ID)).toBe(expected);
        expect(resolveSafeAndroidQuickCaptureAudioPath(
            `file:/data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(expected);
        expect(isSafeAndroidQuickCaptureAudioPath(expected, ANDROID_AUDIO_ID)).toBe(true);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///old/container/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///data/Documents/watch-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///data/Documents/quick-capture-audio/${WATCH_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///data/Documents/quick-capture-audio/../${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///data/Documents/quick-capture-audio/sub/../${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///data/Documents/quick-capture-audio/sub/%2e%2e/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `FILE:/data/Documents/staging/../quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `FiLe:/data/Documents/staging/%2e%2e/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(`${expected}?retry=1`, ANDROID_AUDIO_ID)).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(`${expected}#fragment`, ANDROID_AUDIO_ID)).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file://host/data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(expected, 'not-a-uuid')).toBe(false);
        expect(isSafeWatchAudioPath(expected, ANDROID_AUDIO_ID)).toBe(false);
    });

    it('accepts the React Native URL shape with absent credential fields', () => {
        const NativeUrl = URL;
        vi.stubGlobal('URL', class extends NativeUrl {
            constructor(input: string | URL, base?: string | URL) {
                super(input, base);
                Object.defineProperties(this, {
                    username: { value: undefined },
                    password: { value: undefined },
                });
            }
        });
        try {
            const expected = `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`;
            expect(resolveSafeAndroidQuickCaptureAudioPath(expected, ANDROID_AUDIO_ID)).toBe(expected);
            expect(resolveSafeAndroidQuickCaptureAudioPath(
                `file://foreign/data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
                ANDROID_AUDIO_ID,
            )).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('accepts Android audio only at the exact current owned URI for the matching UUID', () => {
        const currentPath = `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`;
        expect(resolveSafeAndroidQuickCaptureAudioPath(currentPath, ANDROID_AUDIO_ID)).toBe(currentPath);
        expect(isSafeAndroidQuickCaptureAudioPath(currentPath, ANDROID_AUDIO_ID)).toBe(true);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///old/container/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///data/Documents/watch-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///data/Documents/quick-capture-audio/${WATCH_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file:///data/Documents/quick-capture-audio/../${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(`${currentPath}?copy=1`, ANDROID_AUDIO_ID)).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(`${currentPath}#fragment`, ANDROID_AUDIO_ID)).toBe(false);
        expect(isSafeAndroidQuickCaptureAudioPath(
            `file://host/data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            ANDROID_AUDIO_ID,
        )).toBe(false);
        expect(isSafeWatchAudioPath(currentPath, ANDROID_AUDIO_ID)).toBe(false);
    });

    it('rejects payloads without id or title', () => {
        expect(parsePendingCapture(JSON.stringify({ title: 'No id' }))).toBeNull();
        expect(parsePendingCapture(JSON.stringify({ id: 'x', title: '   ' }))).toBeNull();
        expect(parsePendingCapture('not json')).toBeNull();
        expect(parsePendingCapture('[]')).toBeNull();
    });

    it('accepts a valid ISO due/start date and collapses it to a date-only string', () => {
        const capture = parseCapture(JSON.stringify({
            id: 'a',
            title: 'Renew passport',
            dueDate: '2026-08-14',
            startDate: '2026-08-01T09:30:00',
        }));
        expect(capture?.dueDate).toBe('2026-08-14');
        // The Shortcut's Date parameter always carries a time; it must collapse
        // to the local calendar day so it never arms a start reminder (#755).
        expect(capture?.startDate).toBe('2026-08-01');
    });

    it('ignores invalid due/start date junk without failing the capture', () => {
        const capture = parseCapture(JSON.stringify({
            id: 'a',
            title: 'Renew passport',
            dueDate: 'not-a-date',
            startDate: '',
        }));
        expect(capture).not.toBeNull();
        expect(capture?.dueDate).toBeUndefined();
        expect(capture?.startDate).toBeUndefined();
    });
});

describe('buildPendingCaptureTaskProps', () => {
    it('lands in inbox with normalized tags', () => {
        const props = buildPendingCaptureTaskProps(
            { id: 'a', title: 'T', note: 'N', tags: ['home', '#home', 'chores'] },
            [],
        );
        expect(props.status).toBe('inbox');
        expect(props.description).toBe('N');
        expect(props.tags).toEqual(['#home', '#chores']);
    });

    it('resolves selectable projects by id or title and drops unknown or archived ones', () => {
        const active = project({ id: 'p1', title: 'Errands' });
        const archived = project({ id: 'p2', title: 'Old', status: 'archived' as Project['status'] });

        expect(buildPendingCaptureTaskProps({ id: 'a', title: 'T', tags: [], project: 'errands' }, [active]).projectId).toBe('p1');
        expect(buildPendingCaptureTaskProps({ id: 'a', title: 'T', tags: [], project: 'p1' }, [active]).projectId).toBe('p1');
        expect(buildPendingCaptureTaskProps({ id: 'a', title: 'T', tags: [], project: 'Old' }, [archived]).projectId).toBeUndefined();
        expect(buildPendingCaptureTaskProps({ id: 'a', title: 'T', tags: [], project: 'Nope' }, [active]).projectId).toBeUndefined();
    });

    it('maps structured dueDate/startDate onto the task, startDate to startTime', () => {
        const props = buildPendingCaptureTaskProps(
            { id: 'a', title: 'T', tags: [], dueDate: '2026-08-14', startDate: '2026-08-01' },
            [],
        );
        expect(props.dueDate).toBe('2026-08-14');
        expect(props.startTime).toBe('2026-08-01');
    });
});

describe('ingestPendingCaptures', () => {
    type AddProject = Parameters<typeof ingestPendingCaptures>[0]['addProject'];
    let addProject = vi.fn<AddProject>();
    const updateTask = vi.fn(async (_id: string, _updates: Partial<Task>) => ({ success: true }));
    const emptySettings = {} as AppData['settings'];

    const oneFile = (name: string, body: Record<string, unknown>) => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue([name]);
        fileSystemMocks.readAsStringAsync.mockResolvedValue(JSON.stringify(body));
    };

    // Typed so `addTask.mock.calls[0]` destructures as [title, props] instead
    // of an empty tuple (vi.fn() with a zero-arg implementation infers no
    // parameters).
    const addTaskMock = () => vi.fn(async (_title: string, _props?: Partial<Task>) => ({ id: 'task-1' }));

    beforeEach(() => {
        vi.clearAllMocks();
        fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: true });
        fileSystemMocks.deleteAsync.mockResolvedValue(undefined);
        addProject = vi.fn<AddProject>(async (title: string) => project({ id: 'created-project', title }));
    });

    it('creates a task per queue file and deletes each file after the write resolves', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['b.json', 'a.json', 'ignore.txt']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify({
            id: uri.includes('a.json') ? 'a' : 'b',
            title: uri.includes('a.json') ? 'First' : 'Second',
            tags: 'home',
        }));
        const addTask = vi.fn(async () => ({ id: 'task-1' }));

        const ingested = await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(2);
        expect(addTask).toHaveBeenNthCalledWith(1, 'First', { status: 'inbox', tags: ['#home'] });
        expect(addTask).toHaveBeenNthCalledWith(2, 'Second', { status: 'inbox', tags: ['#home'] });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(2);
    });

    it('logs the release check once per ingested Android quick-capture item, and never for a Shortcut item', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json', 'b.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.includes('a.json')
                ? { id: 'a', title: 'From the dialog', createdAt: '2026-09-06T10:00:00.000Z', source: 'android-quick-capture' }
                : { id: 'b', title: 'From the Shortcut' },
        ));
        const addTask = addTaskMock();

        expect(await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings })).toBe(2);

        expect(addTask).toHaveBeenNthCalledWith(1, 'From the dialog', { status: 'inbox' });
        expect(appLogMocks.logInfo).toHaveBeenCalledTimes(1);
        expect(appLogMocks.logInfo).toHaveBeenCalledWith('Quick capture dialog item ingested', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/android-quick-capture-dialog' },
        });
    });

    it('logs Android automation capture only after the Inbox task is durably saved', async () => {
        oneFile('automation.json', {
            id: 'automation-1',
            title: 'Dictated task',
            createdAt: '2026-09-07T10:00:00.000Z',
            source: 'android-capture-intent',
        });
        const addTask = addTaskMock();
        const flushPendingSave = vi.fn(async () => undefined);

        expect(await ingestPendingCaptures({
            addTask,
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            flushPendingSave,
        })).toBe(1);

        expect(addTask).toHaveBeenCalledWith('Dictated task', { status: 'inbox' });
        expect(flushPendingSave).toHaveBeenCalledOnce();
        expect(appLogMocks.logInfo).toHaveBeenCalledWith('Android automation capture ingested', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/android-capture-intent' },
        });
        expect(flushPendingSave.mock.invocationCallOrder[0])
            .toBeLessThan(appLogMocks.logInfo.mock.invocationCallOrder[0]);
    });

    it('retains an Android automation capture when the durable Inbox save fails', async () => {
        oneFile('automation.json', {
            id: 'automation-1',
            title: 'Keep this dictation',
            source: 'android-capture-intent',
        });

        expect(await ingestPendingCaptures({
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            flushPendingSave: vi.fn(async () => { throw new Error('disk full'); }),
        })).toBe(0);

        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();
        expect(appLogMocks.logInfo).not.toHaveBeenCalled();
    });

    it('completes a checked-off task through updateTask and treats done or missing tasks as a no-op that still clears the file', async () => {
        const item = (taskId: string) => JSON.stringify({ kind: 'complete', id: `c-${taskId}`, taskId, source: 'android-widget' });
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json', 'b.json', 'c.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => item(uri.includes('a.json') ? 'open' : uri.includes('b.json') ? 'done' : 'gone'));
        const tasks = [
            { id: 'open', title: 'Open', status: 'next' } as Task,
            { id: 'done', title: 'Done', status: 'done' } as Task,
        ];
        const addTask = addTaskMock();

        expect(await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks, people: [], settings: emptySettings })).toBe(3);

        expect(updateTask).toHaveBeenCalledTimes(1);
        expect(updateTask).toHaveBeenCalledWith('open', { status: 'done' });
        expect(addTask).not.toHaveBeenCalled();
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(3);
        const outcomes = (appLogMocks.logInfo.mock.calls as unknown as [string, { extra: { outcome: string } }][]).map(([, context]) => context.extra.outcome);
        expect(outcomes).toEqual(['completed', 'already-done', 'missing']);
    });

    it('persists a recurring completion and its single follow-up before deleting a replayed native command', async () => {
        vi.useFakeTimers();
        const recurring = {
            id: 'recurring-task',
            title: 'Private recurring task',
            status: 'next',
            dueDate: '2026-09-11',
            recurrence: { rule: 'daily' },
            tags: [],
            contexts: [],
            createdAt: '2026-09-11T12:00:00.000Z',
            updatedAt: '2026-09-11T12:00:00.000Z',
        } as Task;
        let persisted: AppData = {
            tasks: [recurring], projects: [], sections: [], areas: [], people: [],
            settings: { deviceId: 'native-command-test' },
        };
        let failSaves = true;
        const storage: StorageAdapter = {
            getData: vi.fn(async () => structuredClone(persisted)),
            saveData: vi.fn(async (data) => {
                if (failSaves) throw new Error('disk unavailable');
                persisted = structuredClone(data);
            }),
        };
        setStorageAdapter(storage);
        useTaskStore.setState({
            settings: persisted.settings,
            persistenceFailure: null,
            _allTasks: [recurring],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
        });
        oneFile('complete.json', {
            kind: 'complete', id: 'complete-recurring', taskId: recurring.id,
            source: 'apple-watch',
        });
        const updateTask = vi.fn(useTaskStore.getState().updateTask);
        const deps = {
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            getTasks: () => useTaskStore.getState()._allTasks,
            people: [],
            settings: persisted.settings,
            flushPendingSave: flushPendingTaskActionSave,
        };

        try {
            const firstIngest = ingestPendingCaptures(deps);
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(firstIngest).resolves.toBe(0);
            expect(storage.saveData).toHaveBeenCalledTimes(5);
            expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();

            const optimistic = structuredClone(useTaskStore.getState()._allTasks);
            expect(optimistic.find(({ id }) => id === recurring.id)?.status).toBe('done');
            expect(optimistic.filter(({ status }) => status === 'next')).toHaveLength(1);

            failSaves = false;
            await expect(ingestPendingCaptures(deps)).resolves.toBe(1);

            expect(updateTask).toHaveBeenCalledOnce();
            expect(persisted.tasks).toEqual(optimistic);
            expect(fileSystemMocks.deleteAsync).toHaveBeenCalledOnce();
            expect(vi.mocked(storage.saveData).mock.invocationCallOrder.at(-1))
                .toBeLessThan(fileSystemMocks.deleteAsync.mock.invocationCallOrder[0]);
            expect(appLogMocks.logInfo).toHaveBeenCalledWith('Native command save recovered', {
                scope: 'capture',
                extra: {
                    releaseCheck: 'v1.3.0/native-command-save-recovery',
                    outcome: 'recovered',
                },
            });
            expect(JSON.stringify(appLogMocks.logInfo.mock.calls)).not.toContain(recurring.title);

            useTaskStore.setState({
                settings: {},
                persistenceFailure: null,
                _allTasks: [],
                _allProjects: [],
                _allSections: [],
                _allAreas: [],
                _allPeople: [],
            });
            await useTaskStore.getState().fetchData({ silent: true });
            const reloaded = useTaskStore.getState()._allTasks;
            expect(reloaded.find(({ id }) => id === recurring.id)?.status).toBe('done');
            expect(reloaded.filter(({ status }) => status === 'next')).toHaveLength(1);
        } finally {
            resetCoreForTests();
            vi.useRealTimers();
        }
    }, 15_000);

    it('persists a deferred start date before deleting a replayed native command', async () => {
        vi.useFakeTimers();
        const pendingTask = {
            id: 'deferred-task',
            title: 'Private deferred task',
            status: 'next',
            startTime: '2026-09-12',
            tags: [],
            contexts: [],
            createdAt: '2026-09-11T12:00:00.000Z',
            updatedAt: '2026-09-11T12:00:00.000Z',
        } as Task;
        let persisted: AppData = {
            tasks: [pendingTask], projects: [], sections: [], areas: [], people: [],
            settings: { deviceId: 'native-defer-test' },
        };
        let failSaves = true;
        const storage: StorageAdapter = {
            getData: vi.fn(async () => structuredClone(persisted)),
            saveData: vi.fn(async (data) => {
                if (failSaves) throw new Error('disk unavailable');
                persisted = structuredClone(data);
            }),
        };
        setStorageAdapter(storage);
        useTaskStore.setState({
            settings: persisted.settings,
            persistenceFailure: null,
            _allTasks: [pendingTask],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
        });
        oneFile('defer.json', {
            kind: 'defer', id: 'defer-command', taskId: pendingTask.id,
            startDate: '2026-09-20', source: 'apple-watch',
        });
        const updateTask = vi.fn(useTaskStore.getState().updateTask);
        const deps = {
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            getTasks: () => useTaskStore.getState()._allTasks,
            people: [],
            settings: persisted.settings,
            flushPendingSave: flushPendingTaskActionSave,
        };

        try {
            const firstIngest = ingestPendingCaptures(deps);
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(firstIngest).resolves.toBe(0);
            expect(storage.saveData).toHaveBeenCalledTimes(5);
            expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();

            const optimistic = structuredClone(useTaskStore.getState()._allTasks);
            expect(optimistic.find(({ id }) => id === pendingTask.id)?.startTime).toBe('2026-09-20');

            failSaves = false;
            await expect(ingestPendingCaptures(deps)).resolves.toBe(1);

            expect(updateTask).toHaveBeenCalledOnce();
            expect(persisted.tasks).toEqual(optimistic);
            expect(fileSystemMocks.deleteAsync).toHaveBeenCalledOnce();
            expect(vi.mocked(storage.saveData).mock.invocationCallOrder.at(-1))
                .toBeLessThan(fileSystemMocks.deleteAsync.mock.invocationCallOrder[0]);

            useTaskStore.setState({
                settings: {},
                persistenceFailure: null,
                _allTasks: [],
                _allProjects: [],
                _allSections: [],
                _allAreas: [],
                _allPeople: [],
            });
            await useTaskStore.getState().fetchData({ silent: true });
            expect(useTaskStore.getState()._allTasks.find(({ id }) => id === pendingTask.id)?.startTime)
                .toBe('2026-09-20');
        } finally {
            resetCoreForTests();
            vi.useRealTimers();
        }
    }, 15_000);

    it('retains a replayed native command when explicit persistence recovery also fails', async () => {
        vi.useFakeTimers();
        const pendingTask = {
            id: 'recovery-failure-task',
            title: 'Private task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-09-11T12:00:00.000Z',
            updatedAt: '2026-09-11T12:00:00.000Z',
        } as Task;
        const persisted: AppData = {
            tasks: [pendingTask], projects: [], sections: [], areas: [], people: [],
            settings: { deviceId: 'native-recovery-failure-test' },
        };
        const storage: StorageAdapter = {
            getData: vi.fn(async () => structuredClone(persisted)),
            saveData: vi.fn(async () => { throw new Error('disk unavailable'); }),
        };
        setStorageAdapter(storage);
        useTaskStore.setState({
            settings: persisted.settings,
            persistenceFailure: null,
            _allTasks: [pendingTask],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
        });
        oneFile('complete.json', {
            kind: 'complete', id: 'failed-recovery-command', taskId: pendingTask.id,
            source: 'apple-watch',
        });
        const updateTask = vi.fn(useTaskStore.getState().updateTask);
        const deps = {
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            getTasks: () => useTaskStore.getState()._allTasks,
            people: [],
            settings: persisted.settings,
            flushPendingSave: flushPendingTaskActionSave,
        };

        try {
            const firstIngest = ingestPendingCaptures(deps);
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(firstIngest).resolves.toBe(0);
            expect(useTaskStore.getState().persistenceFailure).not.toBeNull();

            const failedRecovery = ingestPendingCaptures(deps);
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(failedRecovery).resolves.toBe(0);

            expect(updateTask).toHaveBeenCalledOnce();
            expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();
            expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
            expect(appLogMocks.logInfo).not.toHaveBeenCalledWith(
                'Native command save recovered',
                expect.anything(),
            );
        } finally {
            resetCoreForTests();
            vi.useRealTimers();
        }
    }, 15_000);

    it.each([
        { label: 'archived', props: {} },
        { label: 'cancelled', props: { cancelledAt: '2026-09-07T12:00:00.000Z' } },
        { label: 'archived recurring', props: { recurrence: { rule: 'daily' } } },
    ])('keeps $label history intact when an Android widget completion arrives late', async ({ props }) => {
        oneFile('complete.json', { kind: 'complete', id: 'late-completion', taskId: 'closed', source: 'android-widget' });
        const closedTask = { id: 'closed', title: 'Closed', status: 'archived', ...props } as Task;
        const addTask = addTaskMock();
        const flushPendingSave = vi.fn(async () => undefined);

        expect(await ingestPendingCaptures({
            addTask, updateTask, addProject, projects: [], areas: [], tasks: [closedTask],
            people: [], settings: emptySettings, flushPendingSave,
        })).toBe(1);

        expect(updateTask).not.toHaveBeenCalled();
        expect(addTask).not.toHaveBeenCalled();
        expect(flushPendingSave).toHaveBeenCalledOnce();
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledOnce();
        expect(flushPendingSave.mock.invocationCallOrder[0])
            .toBeLessThan(fileSystemMocks.deleteAsync.mock.invocationCallOrder[0]);
        expect(appLogMocks.logInfo).toHaveBeenCalledWith('Widget check-off ingested', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/widget-terminal-preserved', outcome: 'terminal' },
        });
    });

    it('refreshes task state between Watch commands and treats stale terminal commands as no-ops', async () => {
        const tasks = [
            { id: 'open', title: 'Open', status: 'next' } as Task,
            { id: 'archived', title: 'Archived', status: 'archived' } as Task,
        ];
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json', 'b.json', 'c.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.includes('c.json')
                ? { kind: 'defer', id: 'd1', taskId: 'archived', startDate: '2026-09-07', source: 'apple-watch' }
                : { kind: 'complete', id: uri.includes('a.json') ? 'c1' : 'c2', taskId: 'open', source: 'apple-watch' },
        ));
        const freshUpdateTask = vi.fn(async (id: string, updates: Partial<Task>) => {
            const task = tasks.find((candidate) => candidate.id === id);
            if (task) Object.assign(task, updates);
            return { success: true };
        });

        expect(await ingestPendingCaptures({
            addTask: addTaskMock(),
            updateTask: freshUpdateTask,
            addProject,
            projects: [],
            areas: [],
            tasks,
            getTasks: () => tasks,
            people: [],
            settings: emptySettings,
        })).toBe(3);

        expect(freshUpdateTask).toHaveBeenCalledTimes(1);
        expect(freshUpdateTask).toHaveBeenCalledWith('open', { status: 'done' });
        const outcomeCalls = appLogMocks.logInfo.mock.calls as unknown as [string, { extra: { outcome: string } }][];
        const outcomes = outcomeCalls.map(([, context]) => context.extra.outcome);
        expect(outcomes).toEqual(['completed', 'already-done', 'terminal']);
    });

    it('orders Watch commands by createdAt even when UUID filenames sort differently', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a-start.json', 'z-reset.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.includes('a-start.json')
                ? { kind: 'pomodoro', id: 'start', action: 'start', createdAt: '2026-09-06T10:01:00.000Z', source: 'apple-watch' }
                : { kind: 'pomodoro', id: 'reset', action: 'reset', createdAt: '2026-09-06T10:00:00.000Z', source: 'apple-watch' },
        ));
        const applyPomodoroCommand = vi.fn(async (_command: { action: 'start' | 'pause' | 'reset' }) => 'applied' as const);

        expect(await ingestPendingCaptures({
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            applyPomodoroCommand,
        })).toBe(2);

        expect(applyPomodoroCommand.mock.calls.map(([command]) => command.action)).toEqual(['reset', 'start']);
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(2);
    });

    it('prefixes Android audio with typed text, creates by capture UUID, and cleans JSON before WAV after flush', async () => {
        oneFile(`${ANDROID_AUDIO_ID}.json`, {
            kind: 'audio',
            id: ANDROID_AUDIO_ID,
            audioPath: `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            createdAt: '2026-09-06T10:00:00.000Z',
            source: 'android-quick-capture',
            title: 'Plan launch',
        });
        const addTask = vi.fn(async () => ({ success: true, id: ANDROID_AUDIO_ID }));
        const flushPendingSave = vi.fn(async () => undefined);
        const transcribeAudio = vi.fn(async () => 'Buy milk /due:tomorrow');

        expect(await ingestPendingCaptures({
            addTask,
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            flushPendingSave,
            transcribeAudio,
        })).toBe(1);

        expect(transcribeAudio).toHaveBeenCalledWith(
            `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            emptySettings,
        );
        expect(addTask).toHaveBeenCalledWith(
            'Plan launch Buy milk',
            expect.objectContaining({ status: 'inbox', dueDate: '2026-09-07' }),
            { captureId: ANDROID_AUDIO_ID },
        );
        expect(flushPendingSave).toHaveBeenCalledOnce();
        expect(fileSystemMocks.deleteAsync).toHaveBeenNthCalledWith(
            1,
            `file:///data/Documents/pending-captures/${ANDROID_AUDIO_ID}.json`,
            { idempotent: true },
        );
        expect(fileSystemMocks.deleteAsync).toHaveBeenNthCalledWith(
            2,
            `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            { idempotent: true },
        );
        expect(flushPendingSave.mock.invocationCallOrder[0])
            .toBeLessThan(fileSystemMocks.deleteAsync.mock.invocationCallOrder[0]);
        expect(fileSystemMocks.deleteAsync.mock.invocationCallOrder[0])
            .toBeLessThan(fileSystemMocks.deleteAsync.mock.invocationCallOrder[1]);
        expect(appLogMocks.logInfo).toHaveBeenNthCalledWith(1, 'Android quick capture audio ready for transcription', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/android-quick-capture-audio', kind: 'audio', outcome: 'validated' },
        });
        expect(appLogMocks.logInfo).toHaveBeenNthCalledWith(2, 'Android quick capture audio ingested', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/android-quick-capture-audio', kind: 'audio', outcome: 'created' },
        });
    });

    it('skips Android retranscription when its capture UUID already exists, including as a tombstone', async () => {
        oneFile(`${ANDROID_AUDIO_ID}.json`, {
            kind: 'audio',
            id: ANDROID_AUDIO_ID,
            audioPath: `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            source: 'android-quick-capture',
        });
        const addTask = vi.fn(async () => ({ success: true, id: ANDROID_AUDIO_ID }));
        const transcribeAudio = vi.fn();
        const flushPendingSave = vi.fn(async () => undefined);
        const tombstone = {
            id: ANDROID_AUDIO_ID,
            title: 'Previously captured',
            status: 'inbox',
            deletedAt: '2026-09-06T11:00:00.000Z',
        } as Task;

        expect(await ingestPendingCaptures({
            addTask,
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            getTasks: () => [tombstone],
            people: [],
            settings: emptySettings,
            flushPendingSave,
            transcribeAudio,
        })).toBe(1);

        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(addTask).toHaveBeenCalledWith(
            'Previously captured',
            undefined,
            { captureId: ANDROID_AUDIO_ID },
        );
        expect(flushPendingSave).toHaveBeenCalledOnce();
        expect(fileSystemMocks.deleteAsync).toHaveBeenNthCalledWith(
            1,
            `file:///data/Documents/pending-captures/${ANDROID_AUDIO_ID}.json`,
            { idempotent: true },
        );
        expect(fileSystemMocks.deleteAsync).toHaveBeenNthCalledWith(
            2,
            `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            { idempotent: true },
        );
        expect(appLogMocks.logInfo).toHaveBeenCalledWith('Android quick capture audio ingested', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/android-quick-capture-audio', kind: 'audio', outcome: 'already-created' },
        });
    });

    it('normalizes an Android capture UUID before using it as the task idempotency key', async () => {
        const upperId = ANDROID_AUDIO_ID.toUpperCase();
        oneFile(`${upperId}.json`, {
            kind: 'audio',
            id: upperId,
            audioPath: `file:///data/Documents/quick-capture-audio/${upperId}.wav`,
            source: 'android-quick-capture',
        });
        const addTask = vi.fn(async () => ({ success: true, id: ANDROID_AUDIO_ID }));

        expect(await ingestPendingCaptures({
            addTask,
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            transcribeAudio: vi.fn(async () => 'Captured thought'),
        })).toBe(1);

        expect(addTask).toHaveBeenCalledWith(
            'Captured thought',
            { status: 'inbox' },
            { captureId: ANDROID_AUDIO_ID },
        );
    });

    it('retains Android audio when transcription is unavailable or task creation fails', async () => {
        oneFile(`${ANDROID_AUDIO_ID}.json`, {
            kind: 'audio',
            id: ANDROID_AUDIO_ID,
            audioPath: `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            source: 'android-quick-capture',
        });
        const base = {
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
        };

        expect(await ingestPendingCaptures({
            ...base,
            addTask: addTaskMock(),
            transcribeAudio: vi.fn(async () => null),
        })).toBe(0);
        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();

        expect(await ingestPendingCaptures({
            ...base,
            addTask: vi.fn(async () => { throw new Error('store unavailable'); }),
            transcribeAudio: vi.fn(async () => 'Captured thought'),
        })).toBe(0);
        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();
        expect(appLogMocks.logWarn).toHaveBeenCalledWith('Android quick capture audio retained for retry', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/android-quick-capture-audio', kind: 'audio', outcome: 'task-save-failed' },
        });
    });

    it('retains Android JSON and WAV when the capture task is not durably saved', async () => {
        oneFile(`${ANDROID_AUDIO_ID}.json`, {
            kind: 'audio',
            id: ANDROID_AUDIO_ID,
            audioPath: `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            source: 'android-quick-capture',
        });

        expect(await ingestPendingCaptures({
            addTask: vi.fn(async () => ({ success: true, id: ANDROID_AUDIO_ID })),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            flushPendingSave: vi.fn(async () => { throw new Error('disk full'); }),
            transcribeAudio: vi.fn(async () => 'Captured thought'),
        })).toBe(0);

        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();
    });

    it('retries a failed real-store capture before deleting its native queue and survives reload', async () => {
        vi.useFakeTimers();
        const emptyData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: { deviceId: 'device-capture' },
        };
        let persisted = structuredClone(emptyData);
        let failSaves = true;
        let successfulSaves = 0;
        const storage: StorageAdapter = {
            getData: vi.fn(async () => structuredClone(persisted)),
            saveData: vi.fn(async (data) => {
                if (failSaves) throw new Error('disk unavailable');
                successfulSaves += 1;
                persisted = structuredClone(data);
            }),
        };
        setStorageAdapter(storage);
        useTaskStore.setState({
            settings: emptyData.settings,
            persistenceFailure: null,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
        });
        oneFile(`${ANDROID_AUDIO_ID}.json`, {
            kind: 'audio',
            id: ANDROID_AUDIO_ID,
            audioPath: `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            source: 'android-quick-capture',
        });
        const transcribeAudio = vi.fn(async () => 'Retained recording');
        const deps = {
            addTask: useTaskStore.getState().addTask,
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            getTasks: () => useTaskStore.getState()._allTasks,
            people: [],
            settings: emptyData.settings,
            flushPendingSave: flushCorePendingSave,
            transcribeAudio,
        };

        try {
            const firstIngest = ingestPendingCaptures(deps);
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(firstIngest).resolves.toBe(0);
            expect(storage.saveData).toHaveBeenCalledTimes(5);
            expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();
            expect(useTaskStore.getState().persistenceFailure?.message).toContain('disk unavailable');
            const optimisticTask = structuredClone(useTaskStore.getState()._allTasks[0]);

            failSaves = false;
            const retryIngest = ingestPendingCaptures({
                ...deps,
                addTask: useTaskStore.getState().addTask,
            });
            await vi.runAllTimersAsync();
            await expect(retryIngest).resolves.toBe(1);

            expect(transcribeAudio).toHaveBeenCalledTimes(1);
            expect(successfulSaves).toBe(1);
            expect(persisted.tasks).toEqual([optimisticTask]);
            expect(vi.mocked(storage.saveData).mock.invocationCallOrder.at(-1))
                .toBeLessThan(fileSystemMocks.deleteAsync.mock.invocationCallOrder[0]);
            expect(fileSystemMocks.deleteAsync).toHaveBeenNthCalledWith(
                1,
                `file:///data/Documents/pending-captures/${ANDROID_AUDIO_ID}.json`,
                { idempotent: true },
            );
            expect(fileSystemMocks.deleteAsync).toHaveBeenNthCalledWith(
                2,
                `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
                { idempotent: true },
            );

            useTaskStore.setState({
                settings: {},
                persistenceFailure: null,
                _allTasks: [],
                _allProjects: [],
                _allSections: [],
                _allAreas: [],
                _allPeople: [],
            });
            await useTaskStore.getState().fetchData({ silent: true });
            expect(useTaskStore.getState()._allTasks).toEqual([optimisticTask]);
        } finally {
            resetCoreForTests();
            vi.useRealTimers();
        }
    }, 15_000);

    it('keeps draining text captures after Android audio task creation rejects', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue([`${ANDROID_AUDIO_ID}.json`, 'z-text.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.endsWith(`${ANDROID_AUDIO_ID}.json`)
                ? {
                    kind: 'audio',
                    id: ANDROID_AUDIO_ID,
                    audioPath: `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
                    source: 'android-quick-capture',
                }
                : { id: 'text-1', title: 'Later text capture' },
        ));
        const addTask = vi.fn(async (_title: string, _props?: Partial<Task>, options?: { captureId: string }) => {
            if (options) throw new Error('audio write failed');
            return { success: true, id: 'text-task' };
        });

        expect(await ingestPendingCaptures({
            addTask,
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            transcribeAudio: vi.fn(async () => 'Audio capture'),
        })).toBe(1);

        expect(addTask).toHaveBeenCalledTimes(2);
        expect(addTask).toHaveBeenNthCalledWith(2, 'Later text capture', { status: 'inbox' });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledOnce();
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledWith(
            'file:///data/Documents/pending-captures/z-text.json',
            { idempotent: true },
        );
    });

    it('rejects Android audio whose queue filename does not match its UUID without deleting the WAV', async () => {
        oneFile('mismatched.json', {
            kind: 'audio',
            id: ANDROID_AUDIO_ID,
            audioPath: `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            source: 'android-quick-capture',
        });

        expect(await ingestPendingCaptures({
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            transcribeAudio: vi.fn(async () => 'Should not run'),
        })).toBe(0);

        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledOnce();
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledWith(
            'file:///data/Documents/pending-captures/mismatched.json',
            { idempotent: true },
        );
        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalledWith(
            `file:///data/Documents/quick-capture-audio/${ANDROID_AUDIO_ID}.wav`,
            expect.anything(),
        );
    });

    it('logs a Watch text outbox retry only after its Inbox task is durably saved', async () => {
        oneFile('watch-text.json', {
            kind: 'text',
            id: 'watch-text-retry',
            title: 'Retry this capture',
            createdAt: '2026-09-09T20:00:00.000Z',
            source: 'apple-watch',
            outboxRetried: true,
        });
        const flushPendingSave = vi.fn(async () => undefined);
        const addTask = addTaskMock();

        expect(await ingestPendingCaptures({
            addTask,
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            flushPendingSave,
        })).toBe(1);

        expect(addTask).toHaveBeenCalledWith('Retry this capture', { status: 'inbox' });
        expect(addTask.mock.calls[0]?.[1]).not.toHaveProperty('outboxRetried');
        expect(appLogMocks.logInfo).toHaveBeenCalledWith('Watch outbox retry ingested', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/watch-outbox-retry', kind: 'text', outcome: 'created' },
        });
        const retryLog = appLogMocks.logInfo.mock.calls.findIndex(
            ([, context]) => context?.extra?.releaseCheck === 'v1.3.0/watch-outbox-retry',
        );
        expect(flushPendingSave.mock.invocationCallOrder[0])
            .toBeLessThan(appLogMocks.logInfo.mock.invocationCallOrder[retryLog]);
    });

    it('does not log a Watch outbox retry when the durable text flush fails', async () => {
        oneFile('watch-text.json', {
            kind: 'text', id: 'watch-text-retry', title: 'Keep this capture',
            source: 'apple-watch', outboxRetried: true,
        });

        expect(await ingestPendingCaptures({
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            flushPendingSave: vi.fn(async () => { throw new Error('disk full'); }),
        })).toBe(0);

        expect(appLogMocks.logInfo).not.toHaveBeenCalledWith(
            'Watch outbox retry ingested',
            expect.anything(),
        );
    });

    it('flushes a Watch audio task before deleting its queue file, then deletes its confined WAV', async () => {
        oneFile('audio.json', {
            kind: 'audio',
            id: WATCH_AUDIO_ID,
            audioPath: `file:///old/container/Documents/watch-audio/${WATCH_AUDIO_ID}.wav`,
            createdAt: '2026-09-06T10:00:00.000Z',
            source: 'apple-watch',
            outboxRetried: true,
        });
        const addTask = addTaskMock();
        const flushPendingSave = vi.fn(async () => undefined);
        const transcribeAudio = vi.fn(async () => 'Buy milk /due:tomorrow');

        expect(await ingestPendingCaptures({
            addTask,
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            flushPendingSave,
            transcribeAudio,
        })).toBe(1);

        expect(addTask).toHaveBeenCalledWith('Buy milk', expect.objectContaining({ status: 'inbox', dueDate: '2026-09-07' }));
        expect(addTask.mock.calls[0]?.[1]).not.toHaveProperty('outboxRetried');
        expect(transcribeAudio).toHaveBeenCalledWith(
            `file:///data/Documents/watch-audio/${WATCH_AUDIO_ID}.wav`,
            emptySettings,
        );
        expect(appLogMocks.logInfo).toHaveBeenNthCalledWith(1, 'Watch audio ready for transcription', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/watch-audio-ready', outcome: 'validated' },
        });
        expect(appLogMocks.logInfo.mock.invocationCallOrder[0])
            .toBeLessThan(transcribeAudio.mock.invocationCallOrder[0]);
        expect(flushPendingSave).toHaveBeenCalledOnce();
        expect(fileSystemMocks.deleteAsync).toHaveBeenNthCalledWith(1, 'file:///data/Documents/pending-captures/audio.json', { idempotent: true });
        expect(fileSystemMocks.deleteAsync).toHaveBeenNthCalledWith(2, `file:///data/Documents/watch-audio/${WATCH_AUDIO_ID}.wav`, { idempotent: true });
        expect(appLogMocks.logInfo).toHaveBeenCalledWith('Watch outbox retry ingested', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.0/watch-outbox-retry', kind: 'audio', outcome: 'created' },
        });
        const retryLog = appLogMocks.logInfo.mock.calls.findIndex(
            ([, context]) => context?.extra?.releaseCheck === 'v1.3.0/watch-outbox-retry',
        );
        expect(flushPendingSave.mock.invocationCallOrder[0])
            .toBeLessThan(appLogMocks.logInfo.mock.invocationCallOrder[retryLog]);
    });

    it('retains Watch audio and queue when transcription is unavailable', async () => {
        oneFile('audio.json', {
            kind: 'audio',
            id: WATCH_AUDIO_ID,
            audioPath: `file:///data/Documents/watch-audio/${WATCH_AUDIO_ID}.wav`,
            source: 'apple-watch',
        });

        expect(await ingestPendingCaptures({
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            transcribeAudio: vi.fn(async () => null),
        })).toBe(0);
        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();
    });

    it('retains the queue and WAV when the durable task flush or queue delete fails', async () => {
        oneFile('audio.json', {
            kind: 'audio',
            id: WATCH_AUDIO_ID,
            audioPath: `file:///data/Documents/watch-audio/${WATCH_AUDIO_ID}.wav`,
            source: 'apple-watch',
            outboxRetried: true,
        });
        const common = {
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            transcribeAudio: vi.fn(async () => 'Captured thought'),
        };

        expect(await ingestPendingCaptures({
            ...common,
            flushPendingSave: vi.fn(async () => { throw new Error('disk full'); }),
        })).toBe(0);
        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();

        fileSystemMocks.deleteAsync.mockRejectedValueOnce(new Error('queue busy'));
        expect(await ingestPendingCaptures({
            ...common,
            flushPendingSave: vi.fn(async () => undefined),
        })).toBe(0);
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(1);
        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalledWith(
            `file:///data/Documents/watch-audio/${WATCH_AUDIO_ID}.wav`,
            expect.anything(),
        );
        expect(appLogMocks.logInfo).not.toHaveBeenCalledWith(
            'Watch outbox retry ingested',
            expect.anything(),
        );
    });

    it('applies a Watch timer setter and clears its queue item after controller persistence', async () => {
        oneFile('timer.json', {
            kind: 'pomodoro',
            id: 'timer-1',
            action: 'pause',
            createdAt: '2026-09-06T10:00:00.000Z',
            source: 'apple-watch',
        });
        const applyPomodoroCommand = vi.fn(async () => 'applied' as const);

        expect(await ingestPendingCaptures({
            addTask: addTaskMock(),
            updateTask,
            addProject,
            projects: [],
            areas: [],
            tasks: [],
            people: [],
            settings: emptySettings,
            applyPomodoroCommand,
        })).toBe(1);
        expect(applyPomodoroCommand).toHaveBeenCalledWith(expect.objectContaining({ action: 'pause' }));
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledWith(
            'file:///data/Documents/pending-captures/timer.json',
            { idempotent: true },
        );
        expect(appLogMocks.logInfo).toHaveBeenCalledWith('Watch command ingested', {
            scope: 'capture',
            extra: {
                releaseCheck: 'v1.3.0/watch-command',
                kind: 'pomodoro',
                action: 'pause',
                outcome: 'applied',
            },
        });
    });

    it('keeps the file when the store write reports failure', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json']);
        fileSystemMocks.readAsStringAsync.mockResolvedValue(JSON.stringify({ id: 'a', title: 'Keep me' }));
        const addTask = vi.fn(async () => ({ success: false }));

        const ingested = await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(0);
        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();
    });

    it('discards malformed files without creating tasks', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['bad.json']);
        fileSystemMocks.readAsStringAsync.mockResolvedValue('{broken');
        const addTask = vi.fn();

        const ingested = await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(0);
        expect(addTask).not.toHaveBeenCalled();
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the queue directory does not exist', async () => {
        fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: false });
        const addTask = vi.fn();

        expect(await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings })).toBe(0);
        expect(fileSystemMocks.readDirectoryAsync).not.toHaveBeenCalled();
        expect(addTask).not.toHaveBeenCalled();
    });

    it('parses quick-add syntax and strips it from the title when cleanup is ON', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:2026-07-24 @errands #personal' });
        const addTask = addTaskMock();
        const settings = { quickAddAutoClean: true } as AppData['settings'];

        const ingested = await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings });

        expect(ingested).toBe(1);
        expect(addTask).toHaveBeenCalledTimes(1);
        const [title, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(title).toBe('Buy milk');
        expect(props.dueDate).toBe('2026-07-24');
        expect(props.contexts).toContain('@errands');
        expect(props.tags).toContain('#personal');
    });

    it('still consumes applied syntax with cleanup OFF (default)', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:2026-07-24 @errands #personal' });
        const addTask = addTaskMock();

        const ingested = await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(1);
        const [title, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        // Cleanup off keeps ordinary text as typed; it never keeps a token the
        // parser already turned into a field.
        expect(title).toBe('Buy milk');
        expect(props.dueDate).toBe('2026-07-24');
        expect(props.contexts).toContain('@errands');
        expect(props.tags).toContain('#personal');
    });

    it('matches a multi-word person against the people list, like the in-app capture box', async () => {
        oneFile('a.json', { id: 'a', title: 'Chase invoice %Jim Smith' });
        const addTask = addTaskMock();
        const people = [{ id: 'person-1', name: 'Jim Smith' } as Person];

        await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people, settings: emptySettings });

        const [title, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        // Without the people list the parser takes only the first word, so this
        // capture used to create a second person called "Jim" (see #895).
        expect(props.assignedTo).toBe('Jim Smith');
        expect(title).toBe('Chase invoice');
    });

    it('attaches an existing selectable project matched by a parsed +Project token without creating one', async () => {
        const active = project({ id: 'p-active', title: 'Errands' });
        oneFile('a.json', { id: 'a', title: 'Buy milk +Errands' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [active], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(addProject).not.toHaveBeenCalled();
        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.projectId).toBe('p-active');
    });

    it('creates a project for a parsed +Project token naming an unknown project', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk +NewProject' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(addProject).toHaveBeenCalledTimes(1);
        expect(addProject.mock.calls[0][0]).toBe('NewProject');
        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.projectId).toBe('created-project');
    });

    it('lets the structured project field beat a parsed +Project token, without creating a project', async () => {
        const active = project({ id: 'p-active', title: 'Errands' });
        oneFile('a.json', { id: 'a', title: 'Buy milk +UnknownProject', project: 'Errands' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [active], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(addProject).not.toHaveBeenCalled();
        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.projectId).toBe('p-active');
    });

    it('lets the structured due/start date beat a parsed /due: token', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:2026-07-24', dueDate: '2026-08-14', startDate: '2026-08-01' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.dueDate).toBe('2026-08-14');
        expect(props.startTime).toBe('2026-08-01');
    });

    it('unions structured tags with parsed #tags, deduped', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk #urgent', tags: 'work,urgent' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.tags).toEqual(expect.arrayContaining(['#urgent', '#work']));
        expect(new Set(props.tags).size).toBe(props.tags?.length);
    });

    it('resolves relative dates against the capture time, not the drain time', async () => {
        // Queued on Monday 2026-07-13; "friday" must mean that week's Friday
        // no matter when the app next foregrounds and drains the queue.
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:friday', createdAt: '2026-07-13T12:00:00' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.dueDate).toBe('2026-07-17');
    });

    it('falls back to the verbatim title when the quick-add date command is invalid, and still creates the task', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:2026-04-31' });
        const addTask = addTaskMock();

        const ingested = await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(1);
        expect(addTask).toHaveBeenCalledWith('Buy milk /due:2026-04-31', { status: 'inbox' });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(1);
    });

    it('falls back to the verbatim capture when project creation fails, and keeps draining the queue', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json', 'b.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.includes('a.json')
                ? { id: 'a', title: 'Buy milk +NewProject' }
                : { id: 'b', title: 'Water plants' },
        ));
        addProject.mockRejectedValue(new Error('store unavailable'));
        const addTask = addTaskMock();

        const ingested = await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(2);
        expect(addTask).toHaveBeenNthCalledWith(1, 'Buy milk +NewProject', { status: 'inbox' });
        expect(addTask).toHaveBeenNthCalledWith(2, 'Water plants', { status: 'inbox' });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(2);
    });

    it('falls back to the verbatim capture when assembly throws, and keeps draining the queue', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json', 'b.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.includes('a.json')
                ? { id: 'a', title: 'First' }
                : { id: 'b', title: 'Second' },
        ));
        // Assembly reads settings.gtd while building parse options; a throw
        // there stands in for any unexpected error inside assembly, which must
        // degrade to the verbatim capture instead of aborting the drain.
        const poisonedSettings = Object.defineProperty({}, 'gtd', {
            get() { throw new Error('boom'); },
        }) as AppData['settings'];
        const addTask = addTaskMock();

        const ingested = await ingestPendingCaptures({ addTask, updateTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: poisonedSettings });

        expect(ingested).toBe(2);
        expect(addTask).toHaveBeenNthCalledWith(1, 'First', { status: 'inbox' });
        expect(addTask).toHaveBeenNthCalledWith(2, 'Second', { status: 'inbox' });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(2);
    });
});
