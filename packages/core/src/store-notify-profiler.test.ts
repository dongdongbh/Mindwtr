import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { resetForTests, useTaskStore } from './store';
import type { Task } from './types';
import {
    beginNotifyProfile,
    endNotifyProfile,
    instrumentStoreSubscribe,
    nameNotifyListener,
    recordDerivedStateRebuild,
} from './store-notify-profiler';

type TestState = {
    value: number;
};

const createTestStore = () => {
    const store = createStore<TestState>()(
        subscribeWithSelector(() => ({ value: 0 })),
    );
    instrumentStoreSubscribe(store);
    return store;
};

describe('store notify profiler', () => {
    afterEach(() => {
        endNotifyProfile();
        vi.restoreAllMocks();
    });

    it('counts and times hook-form listeners while profiling', () => {
        const store = createTestStore();
        const unsubscribeFirst = store.subscribe(() => undefined);
        const unsubscribeSecond = store.subscribe(() => undefined);
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(10)
            .mockReturnValueOnce(14)
            .mockReturnValueOnce(20)
            .mockReturnValueOnce(28);

        beginNotifyProfile();
        store.setState({ value: 1 });
        const profile = endNotifyProfile();

        expect(profile).toEqual({
            listenerCount: 2,
            timedCalls: 2,
            timedTotalMs: 12,
            maxMs: 8,
            top5Ms: [8, 4],
            top5Names: ['anonymous', 'anonymous'],
            derivedRebuildCount: 0,
            derivedRebuildMs: 0,
        });
        unsubscribeFirst();
        unsubscribeSecond();
    });

    it('decrements the listener count exactly once on double unsubscribe', () => {
        const store = createTestStore();
        const unsubscribe = store.subscribe(() => undefined);

        unsubscribe();
        unsubscribe();
        beginNotifyProfile();

        expect(endNotifyProfile()?.listenerCount).toBe(0);
    });

    it('passes selector-form subscriptions through and times them too', () => {
        const store = createTestStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe((state) => state.value, listener);

        beginNotifyProfile();
        store.setState({ value: 2 });
        const profile = endNotifyProfile();

        expect(listener).toHaveBeenCalledWith(2, 0);
        expect(profile).toMatchObject({ listenerCount: 1, timedCalls: 1 });
        unsubscribe();
    });

    it('reports named listeners at the top of the profile', () => {
        const store = createTestStore();
        const unsubscribe = store.subscribe(
            nameNotifyListener('slow-suspect', () => undefined),
        );

        beginNotifyProfile();
        store.setState({ value: 5 });
        const profile = endNotifyProfile();

        expect(profile?.top5Names).toEqual(['slow-suspect']);
        unsubscribe();
    });

    it('does not time inactive profiling while listeners still fire', () => {
        const store = createTestStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        store.setState({ value: 3 });

        expect(listener).toHaveBeenCalledOnce();
        expect(endNotifyProfile()).toBeNull();
        unsubscribe();
    });
});

describe('fetchData notify profiling log fields', () => {
    const nowIso = '2026-07-21T12:00:00.000Z';
    let logs: LogPayload[];

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(nowIso));
        logs = [];
        setLogger((payload) => logs.push(payload));
        useTaskStore.setState({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
            isLoading: false,
            error: null,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            lastDataChangeAt: 0,
        });
    });

    afterEach(() => {
        setLogger(consoleLogger);
        resetForTests();
        vi.useRealTimers();
    });

    const fetchSlowData = async (loggingEnabled: boolean) => {
        const unsubscribe = useTaskStore.subscribe(() =>
            vi.advanceTimersByTime(1_001),
        );
        try {
            await useTaskStore.getState().fetchData({
                silent: true,
                preloadedData: {
                    tasks: [],
                    projects: [],
                    sections: [],
                    areas: [],
                    people: [],
                    settings: {
                        deviceId: 'device-a',
                        diagnostics: { loggingEnabled },
                        migrations: {
                            version: 9999,
                            lastAutoArchiveAt: nowIso,
                            lastTombstoneCleanupAt: nowIso,
                        },
                        gtd: {
                            taskEditor: { defaultsVersion: 9999 },
                            focusGroupByDefaultsVersion: 1,
                        },
                    },
                },
            });
        } finally {
            unsubscribe();
        }
        return logs.find((entry) => entry.message === 'Slow data load pipeline')
            ?.context;
    };

    it('includes notify profiling fields when diagnostics logging is enabled', async () => {
        const context = await fetchSlowData(true);

        expect(context).toMatchObject({
            notifyListenerCount: '1',
            notifyTimedCalls: '1',
            notifyTimedMs: expect.any(String),
            notifyMaxMs: expect.any(String),
            notifyTop5Ms: expect.any(String),
            notifyTop5Names: expect.any(String),


            notifyDerivedRebuilds: expect.any(String),
            notifyDerivedRebuildMs: expect.any(String),
        });
    });

    it('attributes derived-state rebuilds inside a notify to the profile (#766)', () => {
        beginNotifyProfile();
        recordDerivedStateRebuild(12.4);
        recordDerivedStateRebuild(3.6);
        const profile = endNotifyProfile();

        expect(profile?.derivedRebuildCount).toBe(2);
        expect(profile?.derivedRebuildMs).toBeCloseTo(16, 5);


        recordDerivedStateRebuild(50);
        beginNotifyProfile();
        const empty = endNotifyProfile();
        expect(empty?.derivedRebuildCount).toBe(0);
        expect(empty?.derivedRebuildMs).toBe(0);
    });

    it('omits notify profiling fields when diagnostics logging is disabled', async () => {
        const context = await fetchSlowData(false);

        expect(context).toBeDefined();
        expect(context).not.toHaveProperty('notifyListenerCount');
        expect(context).not.toHaveProperty('notifyTimedCalls');
        expect(context).not.toHaveProperty('notifyTimedMs');
        expect(context).not.toHaveProperty('notifyMaxMs');
        expect(context).not.toHaveProperty('notifyTop5Ms');
    });

    it('attributes a slow task update to producer and subscriber time', async () => {
        const task: Task = {
            id: 'task-1',
            title: 'Private task title',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        useTaskStore.setState({
            tasks: [task],
            _allTasks: [task],
            _tasksById: new Map([[task.id, task]]),
            settings: {
                deviceId: 'device-a',
                diagnostics: { loggingEnabled: true },
            },
        });
        const unsubscribe = useTaskStore.subscribe(() =>
            vi.advanceTimersByTime(1_001),
        );
        try {
            await useTaskStore.getState().updateTask(task.id, { status: 'done' });
        } finally {
            unsubscribe();
        }

        const context = logs.find((entry) => entry.message === 'Slow task update pipeline')
            ?.context;
        expect(context).toMatchObject({
            totalMs: expect.any(Number),
            prepareMs: expect.any(Number),
            setStateMs: expect.any(Number),
            setProducerMs: expect.any(Number),
            setNotifyMs: expect.any(Number),
            persistenceDispatchMs: expect.any(Number),
            taskCount: 1,
            updateFieldCount: expect.any(Number),
            recurringFollowUp: false,
            notifyListenerCount: '1',
            notifyTimedCalls: '1',
            notifyTimedMs: expect.any(String),
            notifyMaxMs: expect.any(String),
            notifyTop5Ms: expect.any(String),
        });
        expect(context).not.toHaveProperty('taskId');
        expect(context).not.toHaveProperty('title');
    });

    it('does not log the slow task update pipeline at all when diagnostics logging is disabled (#766)', async () => {
        const task: Task = {
            id: 'task-2',
            title: 'Private task title',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        useTaskStore.setState({
            tasks: [task],
            _allTasks: [task],
            _tasksById: new Map([[task.id, task]]),
            settings: {
                deviceId: 'device-a',
                diagnostics: { loggingEnabled: false },
            },
        });
        const unsubscribe = useTaskStore.subscribe(() =>
            vi.advanceTimersByTime(1_001),
        );
        try {
            await useTaskStore.getState().updateTask(task.id, { status: 'done' });
        } finally {
            unsubscribe();
        }

        expect(logs.find((entry) => entry.message === 'Slow task update pipeline')).toBeUndefined();
    });
});
