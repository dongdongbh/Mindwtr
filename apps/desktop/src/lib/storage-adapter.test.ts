import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';
import { setNativeInvokeTransport } from './tauri-invoke';

const invokeMock = vi.fn();
// tauriStorage reaches Rust through invokeNative. Replacing the transport keeps
// the call synchronous (these tests drive save ordering with fake timers) and
// the runtime stub gets past invokeNative's off-Tauri guard.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
setNativeInvokeTransport(((command: string, args?: Record<string, unknown>) => (
    args === undefined ? invokeMock(command) : invokeMock(command, args)
)) as never);

vi.mock('./local-data-watcher', () => ({
    markLocalWrite: vi.fn(),
    markLocalSqliteWrite: vi.fn(),
}));

const reportErrorMock = vi.fn();
vi.mock('./report-error', () => ({
    reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

import { getDesktopSaveStatus, tauriStorage } from './storage-adapter';

const entityIds = (tasks: string[] = []) => ({
    tasks,
    projects: [],
    sections: [],
    areas: [],
    people: [],
});

const emptyData = () => ({
    tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
});

const originalFetchData = useTaskStore.getState().fetchData;
const setStoreSnapshot = (data: any, fetchData = originalFetchData) => {
    useTaskStore.setState({
        _allTasks: data.tasks ?? [],
        _allProjects: data.projects ?? [],
        _allSections: data.sections ?? [],
        _allAreas: data.areas ?? [],
        _allPeople: data.people ?? [],
        settings: data.settings ?? {},
        fetchData,
    });
};

const resetStoreSnapshot = () => {
    setStoreSnapshot({
        tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
    });
    useTaskStore.setState({ editLockCount: 0 });
};

// #913: save_data can hang without ever rejecting, so the normal catch block
// never runs. tauriStorage.saveData must surface that through the store's
// error channel (observation only) without changing save/retry semantics.
describe('tauriStorage.saveData stuck-save warning (#913)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        useTaskStore.setState({ error: null });
    });

    afterEach(() => {
        vi.useRealTimers();
        resetStoreSnapshot();
        useTaskStore.setState({ error: null });
        vi.clearAllMocks();
    });

    it('does not warn when save_data resolves before the threshold', async () => {
        invokeMock.mockImplementation(async (_command, args) => args?.data);

        await tauriStorage.saveData(emptyData());

        expect(useTaskStore.getState().error).toBeNull();
    });

    it('surfaces a store error once save_data has not resolved after the threshold, and clears it once it resolves', async () => {
        let resolveInvoke!: (value: unknown) => void;
        let canonical: unknown;
        invokeMock.mockImplementation((_command, args) => new Promise<unknown>((resolve) => {
            canonical = args?.data;
            resolveInvoke = resolve;
        }));

        const savePromise = tauriStorage.saveData(emptyData());

        expect(getDesktopSaveStatus().pending).toBe(1);

        await vi.advanceTimersByTimeAsync(14_999);
        expect(useTaskStore.getState().error).toBeNull();

        await vi.advanceTimersByTimeAsync(1);
        expect(useTaskStore.getState().error).toMatch(/has not completed/);

        resolveInvoke(canonical);
        await savePromise;

        expect(getDesktopSaveStatus()).toMatchObject({ pending: 0, failed: false });

        expect(useTaskStore.getState().error).toBeNull();
    });

    it('leaves an unrelated error in place if one was set while the save was stuck', async () => {
        let resolveInvoke!: (value: unknown) => void;
        let canonical: unknown;
        invokeMock.mockImplementation((_command, args) => new Promise<unknown>((resolve) => {
            canonical = args?.data;
            resolveInvoke = resolve;
        }));

        const savePromise = tauriStorage.saveData(emptyData());
        await vi.advanceTimersByTimeAsync(15_000);
        expect(useTaskStore.getState().error).toMatch(/has not completed/);

        useTaskStore.getState().setError('Some unrelated error');
        resolveInvoke(canonical);
        await savePromise;

        expect(useTaskStore.getState().error).toBe('Some unrelated error');
    });

    it('keeps a queued save tied to the snapshot observed when it was enqueued', async () => {
        const observedTask = { id: 'observed', title: 'Observed' };
        const externalTask = { id: 'external', title: 'External' };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [] };
        const concurrent = { ...observed, tasks: [observedTask, externalTask] };
        let readCount = 0;
        let saveCount = 0;
        let releaseFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') {
                return Promise.resolve(readCount++ === 0 ? observed : concurrent);
            }
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((resolve) => {
                    releaseFirstSave = () => resolve(observed);
                });
            }
            return Promise.resolve(target);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(observed);
        await Promise.resolve();
        await Promise.resolve();
        const queuedSave = tauriStorage.saveData(target);
        await tauriStorage.getData();
        releaseFirstSave();
        await Promise.all([firstSave, queuedSave]);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]).toEqual([
            'save_data',
            {
                data: target,
                baselineEntities: {
                    tasks: [observedTask],
                    observedEntityIds: entityIds(['observed']),
                },
            },
        ]);
    });

    it('rebases a retry after failure on the last persisted snapshot', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const targetTask = { ...observedTask, title: 'Local edit', rev: 2 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [targetTask] };
        let saveCount = 0;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data' && saveCount++ === 0) {
                return Promise.reject(new Error('disk full'));
            }
            return Promise.resolve(target);
        });

        await tauriStorage.getData();
        await expect(tauriStorage.saveData(target)).rejects.toThrow('Failed to save data: disk full');
        expect(getDesktopSaveStatus()).toMatchObject({ pending: 0, failed: true });
        await tauriStorage.saveData(target);
        expect(getDesktopSaveStatus()).toMatchObject({ pending: 0, failed: false });

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]).toEqual([
            'save_data',
            {
                data: target,
                baselineEntities: {
                    tasks: [observedTask],
                    observedEntityIds: entityIds(['task-1']),
                },
            },
        ]);
    });

    it('rebases an already-queued follower after its predecessor fails', async () => {
        const deletedTask = { id: 'delete-me', title: 'Delete me', rev: 1 };
        const persistedTask = { id: 'persisted', title: 'Persisted', rev: 1 };
        const changedTask = { ...persistedTask, title: 'Changed after delete', rev: 2 };
        const externalTask = { id: 'external', title: 'External', rev: 1 };
        const observed = {
            tasks: [deletedTask, persistedTask],
            projects: [], sections: [], areas: [], people: [], settings: { theme: 'light' },
        } as any;
        const firstTarget = { ...observed, tasks: [persistedTask], settings: { theme: 'dark' } };
        const followerTarget = { ...firstTarget, tasks: [changedTask] };
        const concurrentRead = { ...observed, tasks: [deletedTask, persistedTask, externalTask] };
        const followerCanonical = { ...followerTarget, tasks: [changedTask, externalTask] };
        let readCount = 0;
        let saveCount = 0;
        let rejectFirstSave!: (error: Error) => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') {
                return Promise.resolve(readCount++ === 0 ? observed : concurrentRead);
            }
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((_resolve, reject) => {
                    rejectFirstSave = reject;
                });
            }
            return Promise.resolve(followerCanonical);
        });

        await tauriStorage.getData();
        const failedSave = tauriStorage.saveData(firstTarget);
        await Promise.resolve();
        await Promise.resolve();
        const failedResult = failedSave.catch((error) => error);
        const followerSave = tauriStorage.saveData(followerTarget);
        await tauriStorage.getData();
        rejectFirstSave(new Error('disk full'));
        expect(await failedResult).toBeInstanceOf(Error);
        await followerSave;

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]).toEqual([
            'save_data',
            {
                data: followerTarget,
                baselineEntities: {
                    tasks: [deletedTask, persistedTask],
                    settings: observed.settings,
                    observedEntityIds: entityIds(['delete-me', 'persisted']),
                },
            },
        ]);
    });

    it('rebases accepted entity provenance without widening omissions or overwriting a settings conflict', async () => {
        const persistedTask = { id: 'persisted', title: 'Persisted', rev: 1 };
        const changedTask = { ...persistedTask, title: 'Follower change', rev: 2 };
        const externalTask = { id: 'external', title: 'External', rev: 1 };
        const observed = {
            tasks: [persistedTask], projects: [], sections: [], areas: [], people: [], settings: { theme: 'light' },
        } as any;
        const firstTarget = { ...observed, settings: { theme: 'dark' } };
        const followerTarget = { ...firstTarget, tasks: [changedTask] };
        const firstCanonical = {
            ...observed,
            tasks: [persistedTask, externalTask],
            settings: { theme: 'blue' },
        };
        const followerCanonical = {
            ...firstCanonical,
            tasks: [changedTask, externalTask],
            settings: followerTarget.settings,
        };
        let saveCount = 0;
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(firstCanonical);
                });
            }
            return Promise.resolve(followerCanonical);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(firstTarget);
        await Promise.resolve();
        await Promise.resolve();
        const followerSave = tauriStorage.saveData(followerTarget);
        resolveFirstSave();
        await Promise.all([firstSave, followerSave]);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]).toEqual([
            'save_data',
            {
                data: { ...followerTarget, settings: firstCanonical.settings },
                baselineEntities: {
                    tasks: [persistedTask],
                    observedEntityIds: entityIds(['persisted']),
                },
            },
        ]);
    });

    it('keeps the original CAS row when predecessor canonical rejects a stale omission', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const externalTask = { ...observedTask, title: 'External edit', rev: 2 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const omitted = { ...observed, tasks: [] };
        const firstCanonical = { ...observed, tasks: [externalTask] };
        let saveCount = 0;
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(firstCanonical);
                });
            }
            return Promise.resolve(firstCanonical);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(omitted);
        await Promise.resolve();
        await Promise.resolve();
        const followerSave = tauriStorage.saveData(omitted);
        resolveFirstSave();
        await Promise.all([firstSave, followerSave]);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]).toEqual([
            'save_data',
            {
                data: omitted,
                baselineEntities: {
                    tasks: [observedTask],
                    observedEntityIds: entityIds(['task-1']),
                },
            },
        ]);
    });

    it('does not promote a conflicting same-revision canonical row into follower authority', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local edit' };
        const externalTask = { ...observedTask, title: 'External edit' };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const firstTarget = { ...observed, tasks: [localTask] };
        const followerTarget = { ...observed, tasks: [] };
        const firstCanonical = { ...observed, tasks: [externalTask] };
        let saveCount = 0;
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(firstCanonical);
                });
            }
            return Promise.resolve(firstCanonical);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(firstTarget);
        await Promise.resolve();
        await Promise.resolve();
        const followerSave = tauriStorage.saveData(followerTarget);
        resolveFirstSave();
        await Promise.all([firstSave, followerSave]);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]?.[1]).toEqual({
            data: followerTarget,
            baselineEntities: {
                tasks: [observedTask],
                observedEntityIds: entityIds(['task-1']),
            },
        });
    });

    it('makes a successful queued create observed even when SQLite materializes false defaults', async () => {
        const createdTask = { id: 'task-1', title: 'Created', rev: 1 };
        const canonicalTask = {
            ...createdTask,
            showFutureRecurrence: false,
            isFocusedToday: false,
            suppressMindwtrReminders: false,
        };
        const observed = {
            tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const created = { ...observed, tasks: [createdTask] };
        const firstCanonical = { ...observed, tasks: [canonicalTask] };
        const restoredCanonical = { ...observed, tasks: [] };
        let saveCount = 0;
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(firstCanonical);
                });
            }
            return Promise.resolve(restoredCanonical);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(created);
        await Promise.resolve();
        await Promise.resolve();
        const followerSave = tauriStorage.saveData(created);
        resolveFirstSave();
        await Promise.all([firstSave, followerSave]);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]?.[1]).toEqual({
            data: created,
            baselineEntities: {
                tasks: [canonicalTask],
                observedEntityIds: entityIds(['task-1']),
            },
        });
    });

    it('allows a queued undo after its predecessor intentionally removed the row', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const removed = { ...observed, tasks: [] };
        let saveCount = 0;
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(removed);
                });
            }
            return Promise.resolve(observed);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(removed);
        await Promise.resolve();
        await Promise.resolve();
        const undoSave = tauriStorage.saveData(observed);
        resolveFirstSave();
        await Promise.all([firstSave, undoSave]);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]?.[1]).toEqual({
            data: observed,
            baselineEntities: {
                observedEntityIds: entityIds(),
            },
        });
    });

    it('keeps a retained row observed when canonical absence came from an exact restore', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: { theme: 'light' },
        } as any;
        const firstTarget = { ...observed, settings: { theme: 'dark' } };
        const restoredCanonical = { ...observed, tasks: [], settings: firstTarget.settings };
        let saveCount = 0;
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(restoredCanonical);
                });
            }
            return Promise.resolve(restoredCanonical);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(firstTarget);
        await Promise.resolve();
        await Promise.resolve();
        const followerSave = tauriStorage.saveData(firstTarget);
        resolveFirstSave();
        await Promise.all([firstSave, followerSave]);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]?.[1]).toEqual({
            data: firstTarget,
            baselineEntities: {
                observedEntityIds: entityIds(['task-1']),
            },
        });
    });

    it('replays only non-conflicting queued settings changes onto canonical settings', async () => {
        const savedA = { id: 'saved-a', name: 'A' };
        const savedB = { id: 'saved-b', name: 'B' };
        const savedC = { id: 'saved-c', name: 'C' };
        const calendarA = { id: 'calendar-a', name: 'A' };
        const calendarB = { id: 'calendar-b', name: 'B' };
        const calendarC = { id: 'calendar-c', name: 'C' };
        const rootSettings = {
            theme: 'light',
            fontSize: 'small',
            ai: { model: 'root', thinkingBudget: 1 },
            savedFilters: [savedA],
            externalCalendars: [calendarA],
        };
        const observed = {
            tasks: [], projects: [], sections: [], areas: [], people: [], settings: rootSettings,
        } as any;
        const canonicalSettings = {
            ...rootSettings,
            theme: 'system',
            ai: { model: 'canonical', thinkingBudget: 1 },
            savedFilters: [savedA, savedC],
            externalCalendars: [calendarA, calendarC],
        };
        const firstCanonical = { ...observed, settings: canonicalSettings };
        const followerTarget = {
            ...observed,
            settings: {
                ...rootSettings,
                theme: 'dark',
                fontSize: 'large',
                ai: { model: 'root', thinkingBudget: 2 },
                savedFilters: [savedA, savedB],
                externalCalendars: [calendarA, calendarB],
            },
        };
        const rebasedSettings = {
            ...canonicalSettings,
            fontSize: 'large',
            ai: { model: 'canonical', thinkingBudget: 2 },
            savedFilters: [savedA, savedC, savedB],
            externalCalendars: [calendarA, calendarC, calendarB],
        };
        const followerCanonical = { ...observed, settings: rebasedSettings };
        let saveCount = 0;
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data' && saveCount++ === 0) {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(firstCanonical);
                });
            }
            return Promise.resolve(followerCanonical);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(observed);
        await Promise.resolve();
        await Promise.resolve();
        const followerSave = tauriStorage.saveData(followerTarget);
        resolveFirstSave();
        await Promise.all([firstSave, followerSave]);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]?.[1]).toEqual({
            data: { ...followerTarget, settings: rebasedSettings },
            baselineEntities: {
                settings: canonicalSettings,
                observedEntityIds: entityIds(),
            },
        });
    });

    it('replays a non-conflicting settings delta once after an initial whole-document CAS miss', async () => {
        const observed = {
            tasks: [], projects: [], sections: [], areas: [], people: [],
            settings: { theme: 'light', fontSize: 'small' },
        } as any;
        const target = { ...observed, settings: { theme: 'light', fontSize: 'large' } };
        const firstCanonical = { ...observed, settings: { theme: 'system', fontSize: 'small' } };
        const finalCanonical = { ...observed, settings: { theme: 'system', fontSize: 'large' } };
        let saveCount = 0;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            return Promise.resolve(saveCount++ === 0 ? firstCanonical : finalCanonical);
        });

        await tauriStorage.getData();
        await tauriStorage.saveData(target);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls).toHaveLength(2);
        expect(saveCalls[1]).toEqual([
            'save_data',
            {
                data: finalCanonical,
                baselineEntities: {
                    settings: firstCanonical.settings,
                    observedEntityIds: entityIds(),
                },
            },
        ]);
    });

    it('preserves canonical settings on a same-leaf conflict without retrying', async () => {
        const observed = {
            tasks: [], projects: [], sections: [], areas: [], people: [],
            settings: { theme: 'light' },
        } as any;
        const target = { ...observed, settings: { theme: 'dark' } };
        const canonical = { ...observed, settings: { theme: 'system' } };
        invokeMock.mockImplementation((command: string) => (
            Promise.resolve(command === 'get_data' ? observed : canonical)
        ));

        await tauriStorage.getData();
        await tauriStorage.saveData(target);

        expect(invokeMock.mock.calls.filter(([command]) => command === 'save_data')).toHaveLength(1);
    });

    it('bounds settings replay to one retry when canonical changes again', async () => {
        const observed = {
            tasks: [], projects: [], sections: [], areas: [], people: [],
            settings: { theme: 'light', fontSize: 'small' },
        } as any;
        const target = { ...observed, settings: { theme: 'light', fontSize: 'large' } };
        const firstCanonical = { ...observed, settings: { theme: 'system', fontSize: 'small' } };
        const churnCanonical = { ...observed, settings: { theme: 'nord', fontSize: 'small' } };
        let saveCount = 0;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            return Promise.resolve(saveCount++ === 0 ? firstCanonical : churnCanonical);
        });

        await tauriStorage.getData();
        await tauriStorage.saveData(target);

        expect(invokeMock.mock.calls.filter(([command]) => command === 'save_data')).toHaveLength(2);
    });

    it('keeps the first durable canonical baseline when the settings replay fails', async () => {
        const createdTask = { id: 'task-1', title: 'Created', rev: 1 };
        const observed = {
            tasks: [], projects: [], sections: [], areas: [], people: [],
            settings: { theme: 'light', fontSize: 'small' },
        } as any;
        const target = {
            ...observed,
            tasks: [createdTask],
            settings: { theme: 'light', fontSize: 'large' },
        };
        const firstCanonical = {
            ...observed,
            tasks: [createdTask],
            settings: { theme: 'system', fontSize: 'small' },
        };
        const restoredCanonical = { ...firstCanonical, tasks: [] };
        let saveCount = 0;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (saveCount++ === 0) return Promise.resolve(firstCanonical);
            if (saveCount === 2) return Promise.reject(new Error('disk full'));
            return Promise.resolve(restoredCanonical);
        });

        await tauriStorage.getData();
        await expect(tauriStorage.saveData(target)).rejects.toThrow('Failed to save data: disk full');
        await tauriStorage.saveData(firstCanonical);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls).toHaveLength(3);
        expect(saveCalls[2]).toEqual([
            'save_data',
            {
                data: firstCanonical,
                baselineEntities: {
                    observedEntityIds: entityIds(['task-1']),
                },
            },
        ]);
    });

    it('rebases a retry on the canonical snapshot returned after a CAS miss', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local edit', rev: 2 };
        const concurrentTask = { ...observedTask, title: 'Concurrent edit', rev: 3 };
        const retryTask = { ...concurrentTask, title: 'Retried edit', rev: 4 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const local = { ...observed, tasks: [localTask] };
        const canonical = { ...observed, tasks: [concurrentTask] };
        const retry = { ...observed, tasks: [retryTask] };
        let saveCount = 0;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data') {
                return Promise.resolve(saveCount++ === 0 ? canonical : retry);
            }
            return Promise.resolve(undefined);
        });

        await tauriStorage.getData();
        await tauriStorage.saveData(local);
        await tauriStorage.saveData(retry);

        const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_data');
        expect(saveCalls[1]).toEqual([
            'save_data',
            {
                data: retry,
                baselineEntities: {
                    tasks: [concurrentTask],
                    observedEntityIds: entityIds(['task-1']),
                },
            },
        ]);
    });

    it('marks unchanged observed rows without marking a true new row', async () => {
        const observedTask = { id: 'observed', title: 'Observed', rev: 1 };
        const newTask = { id: 'new', title: 'New', rev: 1 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: { theme: 'light' },
        } as any;
        const target = {
            ...observed,
            tasks: [observedTask, newTask],
            settings: { theme: 'dark' },
        };
        invokeMock.mockImplementation((command: string) => (
            Promise.resolve(command === 'get_data' ? observed : target)
        ));

        await tauriStorage.getData();
        await tauriStorage.saveData(target);

        expect(invokeMock).toHaveBeenCalledWith('save_data', {
            data: target,
            baselineEntities: {
                settings: observed.settings,
                observedEntityIds: entityIds(['observed']),
            },
        });
    });

    it('defers reconciliation to a differing canonical result while the optimistic store is unchanged', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local', rev: 2 };
        const canonicalTask = { ...observedTask, title: 'Canonical', rev: 3 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [localTask] };
        const canonical = { ...observed, tasks: [canonicalTask] };
        const fetchData = vi.fn().mockResolvedValue(undefined);
        invokeMock.mockImplementation((command: string) => (
            Promise.resolve(command === 'get_data' ? observed : canonical)
        ));

        await tauriStorage.getData();
        setStoreSnapshot(target, fetchData);
        await tauriStorage.saveData(target);

        expect(fetchData).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchData).toHaveBeenCalledWith({ silent: true, preloadedData: canonical });
    });

    it('does not reconcile a stale canonical result after a newer optimistic edit', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local', rev: 2 };
        const newerTask = { ...localTask, title: 'Newer local', rev: 3 };
        const canonicalTask = { ...observedTask, title: 'Canonical', rev: 3 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [localTask] };
        const canonical = { ...observed, tasks: [canonicalTask] };
        const fetchData = vi.fn().mockResolvedValue(undefined);
        invokeMock.mockImplementation((command: string) => (
            Promise.resolve(command === 'get_data' ? observed : canonical)
        ));

        await tauriStorage.getData();
        setStoreSnapshot(target, fetchData);
        await tauriStorage.saveData(target);
        setStoreSnapshot({ ...target, tasks: [newerTask] }, fetchData);

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchData).not.toHaveBeenCalled();
    });

    it('defers canonical reconciliation until the active edit lock clears', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local', rev: 2 };
        const canonicalTask = { ...observedTask, title: 'Canonical', rev: 3 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [localTask] };
        const canonical = { ...observed, tasks: [canonicalTask] };
        const fetchData = vi.fn().mockResolvedValue(undefined);
        invokeMock.mockImplementation((command: string) => (
            Promise.resolve(command === 'get_data' ? observed : canonical)
        ));

        await tauriStorage.getData();
        setStoreSnapshot(target, fetchData);
        useTaskStore.setState({ editLockCount: 1 });
        await tauriStorage.saveData(target);

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchData).not.toHaveBeenCalled();

        useTaskStore.setState({ editLockCount: 0 });
        await Promise.resolve();
        expect(fetchData).toHaveBeenCalledWith({ silent: true, preloadedData: canonical });
    });

    it('cancels a lock-deferred reconciliation after a newer optimistic edit', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local', rev: 2 };
        const newerTask = { ...localTask, title: 'Newer local', rev: 3 };
        const canonicalTask = { ...observedTask, title: 'Canonical', rev: 3 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [localTask] };
        const canonical = { ...observed, tasks: [canonicalTask] };
        const fetchData = vi.fn().mockResolvedValue(undefined);
        invokeMock.mockImplementation((command: string) => (
            Promise.resolve(command === 'get_data' ? observed : canonical)
        ));

        await tauriStorage.getData();
        setStoreSnapshot(target, fetchData);
        useTaskStore.setState({ editLockCount: 1 });
        await tauriStorage.saveData(target);
        await vi.advanceTimersByTimeAsync(0);

        setStoreSnapshot({ ...target, tasks: [newerTask] }, fetchData);
        useTaskStore.setState({ editLockCount: 0 });
        await Promise.resolve();

        expect(fetchData).not.toHaveBeenCalled();
    });

    it('cancels a lock-deferred reconciliation after a newer save generation', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local', rev: 2 };
        const canonicalTask = { ...observedTask, title: 'Canonical', rev: 3 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [localTask] };
        const canonical = { ...observed, tasks: [canonicalTask] };
        const fetchData = vi.fn().mockResolvedValue(undefined);
        let saveCount = 0;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            return Promise.resolve(saveCount++ === 0 ? canonical : target);
        });

        await tauriStorage.getData();
        setStoreSnapshot(target, fetchData);
        useTaskStore.setState({ editLockCount: 1 });
        await tauriStorage.saveData(target);
        await vi.advanceTimersByTimeAsync(0);

        await tauriStorage.saveData(target);
        useTaskStore.setState({ editLockCount: 0 });
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchData).not.toHaveBeenCalled();
    });

    it('does not reject the invoke early or add a retry when save_data eventually fails', async () => {
        invokeMock.mockRejectedValue(new Error('disk full'));

        await expect(tauriStorage.saveData({} as any)).rejects.toThrow('Failed to save data: disk full');

        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(reportErrorMock).toHaveBeenCalledWith(
            'saveData failure',
            expect.any(Error),
            expect.objectContaining({ category: 'storage' }),
        );
    });
});

// saveTask is the incremental persistence path for updateTask/completeTask —
// same hang-without-rejecting shape as saveData, sharing the same warning helper.
describe('tauriStorage.saveTask stuck-save warning (#913)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        useTaskStore.setState({ error: null });
    });

    afterEach(() => {
        vi.useRealTimers();
        resetStoreSnapshot();
        useTaskStore.setState({ error: null });
        vi.clearAllMocks();
    });

    it('does not warn when save_task resolves before the threshold', async () => {
        invokeMock.mockResolvedValue(undefined);

        await tauriStorage.saveTask!({} as any);

        expect(useTaskStore.getState().error).toBeNull();
    });

    it('surfaces a store error once save_task has not resolved after the threshold, and clears it once it resolves', async () => {
        let resolveInvoke!: () => void;
        invokeMock.mockImplementation(() => new Promise<void>((resolve) => {
            resolveInvoke = resolve;
        }));

        const savePromise = tauriStorage.saveTask!({} as any);

        await vi.advanceTimersByTimeAsync(14_999);
        expect(useTaskStore.getState().error).toBeNull();

        await vi.advanceTimersByTimeAsync(1);
        expect(useTaskStore.getState().error).toMatch(/has not completed/);

        resolveInvoke();
        await savePromise;

        expect(useTaskStore.getState().error).toBeNull();
    });

    it('leaves an unrelated error in place if one was set while the save was stuck', async () => {
        let resolveInvoke!: () => void;
        invokeMock.mockImplementation(() => new Promise<void>((resolve) => {
            resolveInvoke = resolve;
        }));

        const savePromise = tauriStorage.saveTask!({} as any);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(useTaskStore.getState().error).toMatch(/has not completed/);

        useTaskStore.getState().setError('Some unrelated error');
        resolveInvoke();
        await savePromise;

        expect(useTaskStore.getState().error).toBe('Some unrelated error');
    });

    it('passes the observed task as baseline so an exact removal cannot be resurrected', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local edit', rev: 2 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const canonical = { ...observed, tasks: [] };
        invokeMock.mockImplementation((command: string) => (
            Promise.resolve(command === 'get_data' ? observed : canonical)
        ));

        await tauriStorage.getData();
        await tauriStorage.saveTask!(localTask as any);

        expect(invokeMock).toHaveBeenCalledWith('save_task', {
            task: localTask,
            baselineTask: observedTask,
        });
    });

    it('keeps the original task baseline when predecessor canonical conflicts', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const concurrentTask = { ...observedTask, title: 'Concurrent', rev: 3 };
        const localTask = { ...concurrentTask, title: 'Local edit', rev: 4 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: { theme: 'light' },
        } as any;
        const firstTarget = { ...observed, settings: { theme: 'dark' } };
        const firstCanonical = { ...firstTarget, tasks: [concurrentTask] };
        const taskCanonical = { ...firstCanonical, tasks: [localTask] };
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data') {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(firstCanonical);
                });
            }
            return Promise.resolve(taskCanonical);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(firstTarget);
        await Promise.resolve();
        await Promise.resolve();
        const taskSave = tauriStorage.saveTask!(localTask as any);
        resolveFirstSave();
        await Promise.all([firstSave, taskSave]);

        expect(invokeMock).toHaveBeenCalledWith('save_task', {
            task: localTask,
            baselineTask: observedTask,
        });
    });

    it('uses a successful predecessor-created task as a queued task baseline', async () => {
        const createdTask = { id: 'task-1', title: 'Created', rev: 1 };
        const updatedTask = { ...createdTask, title: 'Updated', rev: 2 };
        const observed = {
            tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const created = { ...observed, tasks: [createdTask] };
        const updated = { ...observed, tasks: [updatedTask] };
        let resolveFirstSave!: () => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data') {
                return new Promise((resolve) => {
                    resolveFirstSave = () => resolve(created);
                });
            }
            return Promise.resolve(updated);
        });

        await tauriStorage.getData();
        const firstSave = tauriStorage.saveData(created);
        await Promise.resolve();
        await Promise.resolve();
        const taskSave = tauriStorage.saveTask!(updatedTask as any);
        resolveFirstSave();
        await Promise.all([firstSave, taskSave]);

        expect(invokeMock).toHaveBeenCalledWith('save_task', {
            task: updatedTask,
            baselineTask: createdTask,
        });
    });

    it('keeps a failed predecessor creation insertable for a queued task save', async () => {
        const createdTask = { id: 'task-1', title: 'Created', rev: 1 };
        const updatedTask = { ...createdTask, title: 'Updated', rev: 2 };
        const observed = {
            tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const firstTarget = { ...observed, tasks: [createdTask] };
        const taskCanonical = { ...observed, tasks: [updatedTask] };
        let rejectFirstSave!: (error: Error) => void;
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_data') {
                return new Promise((_resolve, reject) => {
                    rejectFirstSave = reject;
                });
            }
            return Promise.resolve(taskCanonical);
        });

        await tauriStorage.getData();
        const failedSave = tauriStorage.saveData(firstTarget);
        await Promise.resolve();
        await Promise.resolve();
        const failedResult = failedSave.catch((error) => error);
        const taskSave = tauriStorage.saveTask!(updatedTask as any);
        rejectFirstSave(new Error('disk full'));
        expect(await failedResult).toBeInstanceOf(Error);
        await taskSave;

        expect(invokeMock).toHaveBeenCalledWith('save_task', { task: updatedTask });
    });

    it('uses the canonical save_task result as the next save baseline', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local edit', rev: 2 };
        const concurrentTask = { ...observedTask, title: 'Concurrent edit', rev: 3 };
        const retryTask = { ...concurrentTask, title: 'Retried edit', rev: 4 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const canonical = { ...observed, tasks: [concurrentTask] };
        const retry = { ...observed, tasks: [retryTask] };
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            if (command === 'save_task') return Promise.resolve(canonical);
            if (command === 'save_data') return Promise.resolve(retry);
            return Promise.resolve(undefined);
        });

        await tauriStorage.getData();
        await tauriStorage.saveTask!(localTask as any);
        await tauriStorage.saveData(retry);

        expect(invokeMock).toHaveBeenCalledWith('save_data', {
            data: retry,
            baselineEntities: {
                tasks: [concurrentTask],
                observedEntityIds: entityIds(['task-1']),
            },
        });
    });

    it('defers saveTask reconciliation when canonical differs and no newer edit exists', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Local', rev: 2 };
        const canonicalTask = { ...observedTask, title: 'Canonical', rev: 3 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [localTask] };
        const canonical = { ...observed, tasks: [canonicalTask] };
        const fetchData = vi.fn().mockResolvedValue(undefined);
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            return Promise.resolve(canonical);
        });

        await tauriStorage.getData();
        setStoreSnapshot(target, fetchData);
        await tauriStorage.saveTask!(localTask as any);

        expect(fetchData).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchData).toHaveBeenCalledWith({ silent: true, preloadedData: canonical });
    });

    it('resolves and reloads when save_task committed but its canonical read failed', async () => {
        const observedTask = { id: 'task-1', title: 'Observed', rev: 1 };
        const localTask = { ...observedTask, title: 'Committed', rev: 2 };
        const observed = {
            tasks: [observedTask], projects: [], sections: [], areas: [], people: [], settings: {},
        } as any;
        const target = { ...observed, tasks: [localTask] };
        const fetchData = vi.fn().mockResolvedValue(undefined);
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_data') return Promise.resolve(observed);
            return Promise.resolve({
                committed: true,
                canonical: null,
                canonicalReloadRequired: true,
            });
        });

        await tauriStorage.getData();
        setStoreSnapshot(target, fetchData);
        await expect(tauriStorage.saveTask!(localTask as any)).resolves.toBeUndefined();

        expect(fetchData).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchData).toHaveBeenCalledWith({ silent: true });
        expect(reportErrorMock).not.toHaveBeenCalledWith(
            'saveTask failure',
            expect.anything(),
            expect.anything(),
        );
    });

    it('does not reject the invoke early or add a retry when save_task eventually fails', async () => {
        invokeMock.mockRejectedValue(new Error('disk full'));

        await expect(tauriStorage.saveTask!({} as any)).rejects.toThrow('Failed to save task: disk full');

        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(reportErrorMock).toHaveBeenCalledWith(
            'saveTask failure',
            expect.any(Error),
            expect.objectContaining({ category: 'storage' }),
        );
    });
});
