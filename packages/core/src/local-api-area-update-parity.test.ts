import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/local-api-area-update.json';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area } from './types';
import { normalizeAreaNameKey } from './area-utils';

describe('Local API area update golden parity with the app store', () => {
    it('defines Unicode collisions with the core area normalizer', () => {
        for (const testCase of fixture.normalizationCases) {
            expect(normalizeAreaNameKey(testCase.left) === normalizeAreaNameKey(testCase.right))
                .toBe(testCase.collides);
        }
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
    });

    for (const testCase of fixture.cases) {
        it(testCase.label, async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(fixture.now));
            const before = structuredClone(fixture.before) as AppData;
            setStorageAdapter({ getData: async () => before, saveData: async () => {} });
            useTaskStore.setState({
                tasks: before.tasks, _allTasks: before.tasks,
                projects: before.projects, _allProjects: before.projects,
                areas: before.areas!, _allAreas: before.areas!,
                sections: before.sections ?? [], _allSections: before.sections ?? [], settings: before.settings,
                isLoading: false, error: null,
            });
            const updates = Object.fromEntries(Object.entries(testCase.patch)
                .map(([field, value]) => [field, value === null ? undefined : value])) as Partial<Area>;
            expect((await useTaskStore.getState().updateArea('area-1', updates)).success).toBe(true);
            const state = useTaskStore.getState();

            expect(JSON.parse(JSON.stringify(state._allAreas.find(area => area.id === 'area-1'))))
                .toEqual(testCase.expected.area);
            expect(JSON.parse(JSON.stringify(state._allProjects))).toEqual(testCase.expected.projects);
            expect(state._allTasks).toEqual(before.tasks);
            expect(state._allSections).toEqual(before.sections);
            expect(state._allAreas.filter(area => area.id !== 'area-1'))
                .toEqual(before.areas!.filter(area => area.id !== 'area-1').sort((a, b) => a.order - b.order));
        });
    }
});
