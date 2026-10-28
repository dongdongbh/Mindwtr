import { describe, expect, it, vi } from 'vitest';
import { computeSyncChangeFingerprint } from './sync-helpers';
import { getInMemorySyncChangeFingerprint } from './sync-client-helpers';
import { useTaskStore } from './store';

// The auto-sync triggers ask for the store's change fingerprint on every resume and leave (twice a resume: the app-state
// dedupe and the cycle's start), about 49 ms each at 5,000 tasks on the S23. The store's collections and settings are
// replaced, never changed in place, so the same six references and last data change give the same fingerprint: computed once.
const counted = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./sync-helpers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sync-helpers')>();
    return { ...actual, computeSyncChangeFingerprint: (data: Parameters<typeof actual.computeSyncChangeFingerprint>[0]) => {
        counted.calls += 1;
        return actual.computeSyncChangeFingerprint(data);
    } };
});

const AT = '2026-01-01T00:00:00.000Z';

describe('getInMemorySyncChangeFingerprint', () => {
    it('computes once for the same store collections and settings, again after any of them is replaced', () => {
        useTaskStore.setState({
            _allTasks: [{ id: 't1', title: 'Task', status: 'inbox', tags: [], contexts: [], createdAt: AT, updatedAt: AT }],
            _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: { gtd: { autoArchiveDays: 7 } },
        } as never);
        counted.calls = 0;
        const first = getInMemorySyncChangeFingerprint();
        expect(getInMemorySyncChangeFingerprint()).toBe(first);
        expect(counted.calls).toBe(1);

        const replaced = ['_allTasks', '_allProjects', '_allSections', '_allAreas', '_allPeople', 'settings'] as const;
        for (const key of replaced) {
            useTaskStore.setState((state) => ({ [key]: Array.isArray(state[key]) ? [...(state[key] as unknown[])] : { ...state[key] } }) as never);
            const before = counted.calls;
            // The same content: the same fingerprint as a fresh computation, computed again for the new reference.
            const state = useTaskStore.getState();
            expect(getInMemorySyncChangeFingerprint()).toBe(computeSyncChangeFingerprint({ tasks: state._allTasks, projects: state._allProjects,
                sections: state._allSections, areas: state._allAreas, people: state._allPeople, settings: state.settings }));
            expect(counted.calls, key).toBe(before + 2);
        }
        // A store write that changed a task in place still moves lastDataChangeAt: computed again.
        const before = counted.calls;
        const task = useTaskStore.getState()._allTasks[0]!;
        Object.assign(task, { rev: 3, updatedAt: '2026-01-03T00:00:00.000Z' });
        useTaskStore.setState((state) => ({ lastDataChangeAt: state.lastDataChangeAt + 1 }));
        expect(getInMemorySyncChangeFingerprint()).not.toBe(first);
        expect(counted.calls).toBe(before + 1);
    });
});
