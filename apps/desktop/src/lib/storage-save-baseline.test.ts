import { describe, expect, it, vi } from 'vitest';
import { computeStableValueFingerprint, type AppData } from '@mindwtr/core';
import { logInfo } from './app-log';
import {
    advanceSaveProvenance,
    buildChangedEntityBaseline,
    rebaseQueuedSettings,
} from './storage-save-baseline';

vi.mock('./app-log', () => ({ logInfo: vi.fn().mockResolvedValue(null) }));

const snapshot = (): AppData => ({
    tasks: [
        { id: 'task-changed', title: 'Task', attachments: [{ id: 'old' }] },
        { id: 'task-unchanged', title: 'Same' },
    ],
    projects: [{ id: 'project-removed', title: 'Removed' }],
    sections: [],
    areas: [{ id: 'area-unchanged', title: 'Area' }],
    people: [],
    settings: {},
}) as unknown as AppData;

describe('buildChangedEntityBaseline', () => {
    it('does not serialize deeply equal cloned rows just to compare them', () => {
        const baseline = snapshot();
        const target = structuredClone(baseline);
        const stringify = vi.spyOn(JSON, 'stringify');
        let calls: number;
        try {
            buildChangedEntityBaseline(baseline, target);
            calls = stringify.mock.calls.length;
        } finally {
            stringify.mockRestore();
        }
        expect(calls).toBe(0);
        expect(logInfo).toHaveBeenCalledWith('Storage snapshot comparison skipped fingerprinting', {
            scope: 'storage', extra: { releaseCheck: 'v1.3.0/storage-baseline-equality' },
        });
    });

    it('retains all observed IDs without serializing 10,000 unchanged cloned tasks', () => {
        const baseline = snapshot();
        baseline.tasks = Array.from({ length: 10000 }, (_, index) => ({
            ...baseline.tasks[0], id: `synthetic-${index}`, title: `Synthetic ${index}`,
        }));
        const target = structuredClone(baseline);
        target.tasks.push({ ...target.tasks[0], id: 'synthetic-new' });
        const stringify = vi.spyOn(JSON, 'stringify');
        let calls: number;
        let result: ReturnType<typeof buildChangedEntityBaseline>;
        try {
            result = buildChangedEntityBaseline(baseline, target);
            calls = stringify.mock.calls.length;
        } finally {
            stringify.mockRestore();
        }
        expect(calls).toBe(0);
        expect(result.observedEntityIds.tasks).toEqual(baseline.tasks.map(task => task.id));
        expect(Object.keys(result)).toEqual(['observedEntityIds']);
    });

    it('matches existing fingerprint semantics across nested snapshots', () => {
        const values: unknown[] = [
            {}, { a: undefined }, { a: null }, { a: false }, { a: 0 }, { a: -0 },
            { a: NaN }, { a: Infinity }, { a: '0' },
            { b: { x: 1, y: [null, 2] }, a: 3 }, { a: 3, b: { y: [null, 2], x: 1 } },
            { a: ['one', 'two'] }, { a: ['two', 'one'] },
            { a: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
            { a: [{ text: 'B', id: 'b' }, { text: 'A', id: 'a' }] },
            { a: [{ id: 'same', text: 'A' }, { id: 'same', text: 'B' }] },
            { a: [{ id: 'same', text: 'B' }, { id: 'same', text: 'A' }] },
            { a: [undefined, 1] }, { a: [null, 1] },
        ];
        for (const left of values) for (const right of values) {
            const baseline = { ...snapshot(), settings: left } as AppData;
            const target = { ...baseline, settings: right } as AppData;
            const expectedEqual = computeStableValueFingerprint(left) === computeStableValueFingerprint(right);
            expect(Object.prototype.hasOwnProperty.call(buildChangedEntityBaseline(baseline, target), 'settings'))
                .toBe(!expectedEqual);
        }
    });

    it('includes originals for nested changes and omissions only', () => {
        const baseline = snapshot();
        const target = {
            ...baseline,
            tasks: [
                { ...baseline.tasks[0], attachments: [] },
                baseline.tasks[1],
                { id: 'task-new', title: 'New' },
            ],
            projects: [],
        } as unknown as AppData;

        expect(buildChangedEntityBaseline(baseline, target)).toEqual({
            tasks: [baseline.tasks[0]],
            projects: [baseline.projects[0]],
            observedEntityIds: {
                tasks: ['task-changed', 'task-unchanged'],
                projects: ['project-removed'],
                sections: [],
                areas: ['area-unchanged'],
                people: [],
            },
        });
    });

    it('records observed rows even when they are unchanged', () => {
        const baseline = snapshot();
        expect(buildChangedEntityBaseline(baseline, baseline)).toEqual({
            observedEntityIds: {
                tasks: ['task-changed', 'task-unchanged'],
                projects: ['project-removed'],
                sections: [],
                areas: ['area-unchanged'],
                people: [],
            },
        });
    });

    it('includes the original settings document when settings changed', () => {
        const baseline = snapshot();
        const target = {
            ...baseline,
            settings: { theme: 'dark' },
        } as AppData;

        expect(buildChangedEntityBaseline(baseline, target)).toEqual({
            settings: baseline.settings,
            observedEntityIds: {
                tasks: ['task-changed', 'task-unchanged'],
                projects: ['project-removed'],
                sections: [],
                areas: ['area-unchanged'],
                people: [],
            },
        });
    });
});

describe('advanceSaveProvenance', () => {
    it('promotes only confirmed target rows while retaining conflicting same-revision originals', () => {
        const original = { id: 'task-original', title: 'Original', rev: 1 };
        const local = { ...original, title: 'Local' };
        const conflict = { ...original, title: 'External' };
        const created = { id: 'task-created', title: 'Created', rev: 1 };
        const canonicalCreated = {
            ...created,
            showFutureRecurrence: false,
            isFocusedToday: false,
            suppressMindwtrReminders: false,
        };
        const provenance = {
            tasks: [original], projects: [], sections: [], areas: [], people: [], settings: {},
        } as unknown as AppData;
        const attempted = {
            ...provenance,
            tasks: [local, created],
        } as AppData;
        const canonical = {
            ...provenance,
            tasks: [conflict, canonicalCreated],
        } as AppData;

        expect(advanceSaveProvenance(provenance, attempted, canonical).tasks).toEqual([
            original,
            canonicalCreated,
        ]);
    });
});

describe('rebaseQueuedSettings', () => {
    it('merges stable-id arrays without erasing concurrent additions or edits', () => {
        const rootA = { id: 'a', name: 'A', icon: 'root' };
        const rootDelete = { id: 'delete', name: 'Delete' };
        const rootConflictDelete = { id: 'keep', name: 'Keep' };
        const localA = { ...rootA, name: 'Local A' };
        const localAdd = { id: 'local', name: 'Local add' };
        const canonicalA = { ...rootA, icon: 'canonical' };
        const canonicalKeep = { ...rootConflictDelete, name: 'Concurrent keep' };
        const canonicalAdd = { id: 'canonical', name: 'Canonical add' };

        expect(rebaseQueuedSettings(
            { savedFilters: [rootA, rootDelete, rootConflictDelete] } as any,
            { savedFilters: [localA, localAdd] } as any,
            { savedFilters: [canonicalA, rootDelete, canonicalKeep, canonicalAdd] } as any,
        )).toEqual({
            savedFilters: [
                { ...localA, icon: 'canonical' },
                canonicalKeep,
                canonicalAdd,
                localAdd,
            ],
        });
    });

    it('preserves a same-leaf canonical conflict while applying an independent nested change', () => {
        expect(rebaseQueuedSettings(
            { theme: 'light', ai: { model: 'root', thinkingBudget: 1 } } as any,
            { theme: 'dark', ai: { model: 'root', thinkingBudget: 2 } } as any,
            { theme: 'system', ai: { model: 'canonical', thinkingBudget: 1 } } as any,
        )).toEqual({
            theme: 'system',
            ai: { model: 'canonical', thinkingBudget: 2 },
        });
    });
});
