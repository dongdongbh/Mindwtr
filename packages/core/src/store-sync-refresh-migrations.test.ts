import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';

const RELEASE_CHECK = 'v1.3.9/sync-refresh-migrations';
const HOUR = 60 * 60 * 1000;

const datedInboxTask = (): Task => {
    const now = Date.now();
    return {
        id: 'dated', title: 'Dated', status: 'inbox', tags: [], contexts: [],
        startTime: new Date(now - HOUR).toISOString(),
        createdAt: new Date(now - 2 * HOUR).toISOString(), updatedAt: new Date(now - 2 * HOUR).toISOString(),
        rev: 1, revBy: 'device-b',
    } as Task;
};

describe('sync refresh load migrations diagnostic', () => {
    let saved: AppData;
    let logs: LogPayload[];

    const boot = async (tasks: Task[]) => {
        await flushPendingSave();
        resetForTests();
        useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
            tasks: [], _allTasks: [], projects: [], _allProjects: [] } as never);
        saved = { tasks, projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device-a' } } as AppData;
        setStorageAdapter({
            getData: async () => JSON.parse(JSON.stringify(saved)),
            saveData: async (next) => { saved = JSON.parse(JSON.stringify(next)); },
        });
        await useTaskStore.getState().fetchData({ throwOnError: true });
        await flushPendingSave();
    };

    beforeEach(() => {
        logs = [];
        setLogger((payload) => logs.push(payload));
    });

    afterEach(() => {
        setLogger(consoleLogger);
    });

    const refreshLines = () => logs.filter((entry) => entry.context?.releaseCheck === RELEASE_CHECK);

    it('names the load migrations a silent sync refresh applied', async () => {
        await boot([]);
        saved = { ...saved, tasks: [datedInboxTask()] };
        await useTaskStore.getState().fetchData({ silent: true });
        const lines = refreshLines();
        expect(lines).toHaveLength(1);
        expect(lines[0].message).toBe('Sync refresh applied load migrations');
        expect(String(lines[0].context?.migrations).split(',')).toContain('promote-scheduled-tasks');
        expect(useTaskStore.getState()._tasksById.get('dated')?.status).toBe('next');
    });

    it('stays quiet when a silent refresh applies nothing', async () => {
        await boot([]);
        await useTaskStore.getState().fetchData({ silent: true });
        expect(refreshLines()).toHaveLength(0);
    });

    it('stays quiet on a startup load that applies migrations', async () => {
        await boot([datedInboxTask()]);
        expect(useTaskStore.getState()._tasksById.get('dated')?.status).toBe('next');
        expect(refreshLines()).toHaveLength(0);
    });
});
