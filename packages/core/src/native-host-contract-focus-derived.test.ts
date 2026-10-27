import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';

// The native first screen's Focus read: the store's derived project summaries (a pass over every task, 50 ms of the first read's
// 101 ms at 5,000 tasks on the S23's QuickJS) only serve the review projects' rows, so a Focus with none never builds them.
const stamp = '2026-09-01T12:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next', tags: [], contexts: [],
    createdAt: stamp, updatedAt: stamp, ...extra });
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, title: id, status: 'active', order: 0, color: '#123456',
    tagIds: [], createdAt: stamp, updatedAt: stamp, ...extra });

async function open(data: Partial<AppData>) {
    resetForTests();
    let stored: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' }, ...data };
    setStorageAdapter({ getData: async () => structuredClone(stored), saveData: async (next) => { stored = structuredClone(next); } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], tasks: [], projects: [], lastDataChangeAt: 0 } as never);
    const host = createNativeHostContract();
    const activated = await host.activate({ writeSafetyReady: true });
    if (!activated.ok) throw new Error(JSON.stringify(activated.error));
    const original = useTaskStore.getState().getDerivedState;
    let derived = 0;
    useTaskStore.setState({ getDerivedState: () => { derived += 1; return original(); } } as never);
    return { host, derived: () => derived };
}

describe('native getFocus and the derived project summaries', () => {
    afterEach(() => resetForTests());

    it('builds no derived state when no project is due for review', async () => {
        const { host, derived } = await open({ tasks: [task('a', { projectId: 'p' }), task('b')], projects: [project('p')] });
        const focus = host.getFocus({ limit: 50 });
        expect(focus).toMatchObject({ ok: true, value: { reviewProjects: [] } });
        expect(derived()).toBe(0);
    });

    it('still gives a review project its summary row', async () => {
        const { host, derived } = await open({ tasks: [task('a', { projectId: 'p' })],
            projects: [project('p', { reviewAt: '2020-01-01T00:00:00.000Z' })] });
        const focus = host.getFocus({ limit: 50 });
        if (!focus.ok) throw new Error(focus.error.code);
        expect(focus.value.reviewProjects).toHaveLength(1);
        expect(focus.value.reviewProjects[0]).toMatchObject({ id: 'p' });
        expect(derived()).toBeGreaterThan(0);
    });
});
