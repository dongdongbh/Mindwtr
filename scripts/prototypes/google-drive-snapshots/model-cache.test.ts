import { describe, expect, test } from 'bun:test';
import { setLogger } from '../../../packages/core/src/logger';
import type { AppData, Task } from '../../../packages/core/src/types';
import {
    createCachedSnapshotResolver,
    resolveSnapshots,
    type Snapshot,
} from './model';

const NAMESPACE = 'cached-resolver-test';
const NOW = '2026-09-17T16:00:00.000Z';
setLogger(() => {});

const task = (
    id: string,
    title: string,
    rev: number,
    revBy: string,
    updatedAt = '2026-09-10T12:00:00.000Z',
    extra: Partial<Task> = {},
): Task => ({
    id,
    title,
    status: 'inbox',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt,
    tags: [],
    contexts: [],
    rev,
    revBy,
    ...extra,
});

const data = (tasks: Task[] = []): AppData => ({
    tasks,
    projects: [],
    sections: [],
    areas: [],
    settings: {},
});

const snapshot = (
    id: string,
    parents: string[],
    snapshotData: AppData,
    namespace = NAMESPACE,
): Snapshot => ({
    format: 'mindwtr-drive-snapshot-prototype',
    version: 1,
    id,
    namespace,
    parents,
    data: snapshotData,
});

const expectOracleParity = (
    resolver: ReturnType<typeof createCachedSnapshotResolver>,
    snapshots: Snapshot[],
    nowIso = NOW,
): void => {
    expect(resolver.resolve(snapshots, nowIso)).toEqual(
        resolveSnapshots(snapshots, NAMESPACE, nowIso),
    );
};

describe('cached Google Drive snapshot resolver', () => {
    test('matches the oracle for roots, forks, joins, tombstones, and an appended child', () => {
        const resolver = createCachedSnapshotResolver(NAMESPACE);
        const root = snapshot('root', [], data([task('shared', 'Original', 1, 'root')]));
        expectOracleParity(resolver, [root]);

        const deletedAt = '2026-09-12T12:00:00.000Z';
        const left = snapshot('left', ['root'], data([
            task('shared', 'Original', 2, 'left', deletedAt, { deletedAt }),
            task('left-only', 'Left', 1, 'left'),
        ]));
        const right = snapshot('right', ['root'], data([
            task('shared', 'Original', 1, 'root'),
            task('right-only', 'Right', 1, 'right'),
        ]));
        const fork = [right, root, left];
        expectOracleParity(resolver, fork);

        const forkData = resolveSnapshots(fork, NAMESPACE, NOW).data!;
        const join = snapshot('join', ['left', 'right'], forkData);
        expectOracleParity(resolver, [...fork, join]);

        const child = snapshot('child', ['join'], data([
            ...forkData.tasks.map((item) => structuredClone(item)),
            task('new-child', 'New child', 1, 'child'),
        ]));
        expectOracleParity(resolver, [...fork, join, child]);
    });

    test('fails closed when bytes under a previously cached snapshot ID change', () => {
        const resolver = createCachedSnapshotResolver(NAMESPACE);
        const root = snapshot('root', [], data([task('a', 'Original', 1, 'root')]));
        resolver.resolve([root], NOW);

        root.data.tasks[0]!.title = 'Mutated in place';

        expect(() => resolver.resolve([root], NOW)).toThrow(/snapshot id root.*changed.*cach/i);

        root.data.tasks[0]!.title = 'Original';
        expect(resolver.resolve([root], NOW)).toEqual(
            resolveSnapshots([root], NAMESPACE, NOW),
        );
    });

    test('caller mutation of inputs or returned results cannot poison later results', () => {
        const resolver = createCachedSnapshotResolver(NAMESPACE);
        const root = snapshot('root', [], data([task('a', 'Original', 1, 'root')]));
        const first = resolver.resolve([root], NOW);
        first.heads.push('forged');
        first.data!.tasks[0]!.title = 'Mutated result';

        const second = resolver.resolve([structuredClone(root)], NOW);

        expect(second).toEqual(resolveSnapshots([root], NAMESPACE, NOW));
        expect(second.data?.tasks[0]?.title).toBe('Original');
    });

    test('matches the oracle as clocks advance across future timestamps', () => {
        const resolver = createCachedSnapshotResolver(NAMESPACE);
        const first = snapshot('first', [], data([
            task('shared', 'First future edit', 1, 'same', '2026-09-19T12:00:00.000Z'),
        ]));
        const second = snapshot('second', [], data([
            task('shared', 'Second future edit', 1, 'same', '2026-09-20T12:00:00.000Z'),
        ]));
        const graph = [second, first];

        expectOracleParity(resolver, graph, '2026-09-17T12:00:00.000Z');
        expectOracleParity(resolver, graph, '2026-09-19T18:00:00.000Z');
        expectOracleParity(resolver, graph, '2026-09-21T12:00:00.000Z');
        expect(resolver.getStats().fullValidationFallbacks).toBeGreaterThan(0);
    });

    test('reuses proofs despite numeric text and future scheduling-only dates', () => {
        const resolver = createCachedSnapshotResolver(NAMESPACE);
        const root = snapshot('snapshot-4999', [], data([
            task('synthetic-4999', 'Synthetic task 4999', 1, 'device-4999', undefined, {
                dueDate: '2099-06-01T12:00:00.000Z',
                reviewAt: '2099-05-01T12:00:00.000Z',
                startTime: '2099-04-01T12:00:00.000Z',
                isFocusedToday: false,
            }),
        ]));
        const child = snapshot('snapshot-5000', ['snapshot-4999'], data([
            task('synthetic-4999', 'Synthetic task 4999', 1, 'device-4999', undefined, {
                dueDate: '2099-06-01T12:00:00.000Z',
                reviewAt: '2099-05-01T12:00:00.000Z',
                startTime: '2099-04-01T12:00:00.000Z',
                isFocusedToday: false,
            }),
            task('synthetic-5000', 'Synthetic task 5000', 1, 'device-5000'),
        ]));
        const graph = [root, child];

        expectOracleParity(resolver, graph, NOW);
        const beforeWarm = resolver.getStats();
        expectOracleParity(resolver, graph, '2026-09-17T16:00:01.000Z');
        const afterWarm = resolver.getStats();

        expect(afterWarm.normalizedSnapshotReuses).toBeGreaterThan(
            beforeWarm.normalizedSnapshotReuses,
        );
        expect(afterWarm.coverageProofReuses).toBeGreaterThan(beforeWarm.coverageProofReuses);
        expect(afterWarm.fullValidationFallbacks).toBe(beforeWarm.fullValidationFallbacks);
    });

    test('falls back for a focused future start, then reuses after its start day arrives', () => {
        const previousTimeZone = process.env.TZ;
        process.env.TZ = 'UTC';
        try {
            const resolver = createCachedSnapshotResolver(NAMESPACE);
            const root = snapshot('future-focus', [], data([
                task('focused', 'Focused', 1, 'device', undefined, {
                    startTime: '2026-09-20T12:00:00.000Z',
                    isFocusedToday: true,
                }),
            ]));

            expectOracleParity(resolver, [root], '2026-09-17T12:00:00.000Z');
            const afterFuture = resolver.getStats();
            expect(afterFuture.fullValidationFallbacks).toBe(1);

            expectOracleParity(resolver, [root], '2026-09-20T08:00:00.000Z');
            const afterStartDay = resolver.getStats();
            expect(afterStartDay.fullValidationFallbacks).toBe(afterFuture.fullValidationFallbacks);

            expectOracleParity(resolver, [root], '2026-09-20T09:00:00.000Z');
            expect(resolver.getStats().normalizedSnapshotReuses).toBeGreaterThan(
                afterStartDay.normalizedSnapshotReuses,
            );
        } finally {
            if (previousTimeZone === undefined) delete process.env.TZ;
            else process.env.TZ = previousTimeZone;
        }
    });

    test('invalidates reusable proofs when the local timezone context changes', () => {
        const previousTimeZone = process.env.TZ;
        try {
            process.env.TZ = 'UTC';
            const resolver = createCachedSnapshotResolver(NAMESPACE);
            const root = snapshot('timezone-root', [], data([
                task('stable', 'Stable', 1, 'device'),
            ]));
            const omitted = snapshot('timezone-omitted', [], data([
                task('omitted', 'Omitted', 1, 'device'),
            ]));
            resolver.resolve([root, omitted], NOW);
            const beforeChange = resolver.getStats();

            process.env.TZ = 'America/New_York';
            expectOracleParity(resolver, [root], '2026-09-17T16:00:01.000Z');

            expect(resolver.getStats().fullValidationFallbacks).toBe(
                beforeChange.fullValidationFallbacks + 1,
            );

            const beforeReintroduced = resolver.getStats();
            expectOracleParity(resolver, [omitted], '2026-09-17T16:00:02.000Z');
            expect(resolver.getStats().normalizedSnapshotReuses).toBe(
                beforeReintroduced.normalizedSnapshotReuses,
            );
        } finally {
            if (previousTimeZone === undefined) delete process.env.TZ;
            else process.env.TZ = previousTimeZone;
        }
    });

    test('invalidates timezone proofs for omitted IDs before a failed-save replay', () => {
        const previousTimeZone = process.env.TZ;
        try {
            process.env.TZ = 'UTC';
            const resolver = createCachedSnapshotResolver(NAMESPACE);
            const clock = '2026-09-17T01:00:00.000Z';
            const root = snapshot('timezone-parent', [], data());
            const child = snapshot('timezone-child', [root.id], data([
                task('focused', 'Focused', 1, 'device', undefined,
                    { isFocusedToday: true, startTime: '2026-09-17' }),
            ]));
            expectOracleParity(resolver, [root, child], clock);
            process.env.TZ = 'America/New_York';
            // Retry begins with the durable parent-only checkpoint, temporarily
            // omitting the child cached before a failed checkpoint commit.
            expectOracleParity(resolver, [root], clock);
            const before = resolver.getStats();
            expectOracleParity(resolver, [root, child], clock);
            expect(resolver.getStats().coverageProofReuses).toBe(before.coverageProofReuses);
        } finally {
            if (previousTimeZone === undefined) delete process.env.TZ;
            else process.env.TZ = previousTimeZone;
        }
    });

    test('falls back to current-time normalization after a clock rollback', () => {
        const resolver = createCachedSnapshotResolver(NAMESPACE);
        const duplicateAreas = data();
        duplicateAreas.areas = [
            {
                id: 'area-a',
                name: 'Work',
                order: 0,
                createdAt: '2026-09-10T12:00:00.000Z',
                updatedAt: '2026-09-10T12:00:00.000Z',
                rev: 1,
                revBy: 'area-a',
            },
            {
                id: 'area-b',
                name: 'Work',
                order: 1,
                createdAt: '2026-09-10T12:00:00.000Z',
                updatedAt: '2026-09-10T12:00:00.000Z',
                rev: 1,
                revBy: 'area-b',
            },
        ];
        const timeDependent = snapshot('root', [], duplicateAreas);

        expectOracleParity(resolver, [timeDependent], '2026-09-20T12:00:00.000Z');
        const rolledBack = resolver.resolve([timeDependent], '2026-09-15T12:00:00.000Z');
        const oracle = resolveSnapshots(
            [timeDependent],
            NAMESPACE,
            '2026-09-15T12:00:00.000Z',
        );

        expect(rolledBack).toEqual(oracle);
        expect(rolledBack.data?.areas.find((area) => area.deletedAt)?.deletedAt).toBe(
            '2026-09-15T12:00:00.000Z',
        );
        expect(resolver.getStats().fullValidationFallbacks).toBeGreaterThan(0);
    });

    test('retains malformed-data, missing-parent, and namespace validation', () => {
        const resolver = createCachedSnapshotResolver(NAMESPACE);
        const malformed = snapshot('malformed', [], data());
        malformed.data.tasks = [{ id: 'broken' }] as Task[];
        expect(() => resolver.resolve([malformed], NOW)).toThrow(/tasks\[0\]/i);

        expect(() => resolver.resolve([
            snapshot('child', ['missing'], data()),
        ], NOW)).toThrow(/missing parent missing/i);

        expect(() => resolver.resolve([
            snapshot('foreign', [], data(), 'another-namespace'),
        ], NOW)).toThrow(/wrong namespace/i);

        const tooManyParents = snapshot(
            'wide',
            Array.from({ length: 129 }, (_, index) => `parent-${index}`),
            data(),
        );
        expect(() => resolver.resolve([tooManyParents], NOW)).toThrow(/exceeds 128 parents/i);
    });

    test('a fresh resolver has cold-process parity with the oracle', () => {
        const root = snapshot('root', [], data([task('a', 'A', 1, 'root')]));
        const child = snapshot('child', ['root'], data([
            task('a', 'A', 1, 'root'),
            task('b', 'B', 1, 'child'),
        ]));

        const firstProcess = createCachedSnapshotResolver(NAMESPACE).resolve([root, child], NOW);
        const restartedProcess = createCachedSnapshotResolver(NAMESPACE).resolve(
            structuredClone([root, child]),
            NOW,
        );

        expect(restartedProcess).toEqual(firstProcess);
        expect(restartedProcess).toEqual(resolveSnapshots([root, child], NAMESPACE, NOW));
    });

    test('bounds lifetime cache entries without forgetting immutable IDs', () => {
        const resolver = createCachedSnapshotResolver(NAMESPACE);
        const graph = (prefix: string): Snapshot[] => Array.from(
            { length: 128 },
            (_, index) => snapshot(`${prefix}-${index}`, [], data()),
        );
        const first = graph('first');

        resolver.resolve(first, NOW);
        expect(() => resolver.resolve([
            snapshot('overflow', [], data()),
        ], '2026-09-17T16:00:01.000Z')).toThrow(/cache exceeds 128 files/i);

        expect(resolver.getStats().cacheEntries).toBeLessThanOrEqual(128);
        expect(resolver.getStats().cacheLimitRejections).toBe(1);

        first[0]!.data.tasks.push(task('changed', 'Changed', 1, 'mutation'));
        expect(() => resolver.resolve(
            [first[0]!],
            '2026-09-17T16:00:02.000Z',
        )).toThrow(/snapshot id first-0.*changed.*cach/i);
    });
});
