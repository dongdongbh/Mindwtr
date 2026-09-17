import { describe, expect, test } from 'bun:test';
import type { AppData, Task } from '../../../packages/core/src/types';
import { prepareSnapshot, resolveSnapshots, type Snapshot } from './model';

const NOW = '2026-09-17T16:00:00.000Z';
const NAMESPACE = 'namespace-test';

const task = (
    id: string,
    title: string,
    rev: number,
    revBy: string,
    updatedAt = `2026-09-${String(Math.min(rev, 16)).padStart(2, '0')}T12:00:00.000Z`,
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

const titleById = (appData: AppData | null, id: string): string | undefined => (
    appData?.tasks.find((item) => item.id === id)?.title
);

describe('Google Drive immutable snapshot model', () => {
    test('creates an immutable root for an empty graph', () => {
        const local = data([task('a', 'Local', 1, 'device-a')]);
        const before = structuredClone(local);

        const prepared = prepareSnapshot('root', NAMESPACE, local, [], NOW);

        expect(prepared?.parents).toEqual([]);
        expect(prepared?.data.tasks.map((item) => item.id)).toEqual(['a']);
        expect(local).toEqual(before);
        expect(prepared?.data).not.toBe(local);
    });

    test('merges forked disjoint edits and joins every frontier head', () => {
        const root = snapshot('root', [], data());
        const left = snapshot('left', ['root'], data([task('left-task', 'Left', 1, 'left')]));
        const right = snapshot('right', ['root'], data([task('right-task', 'Right', 1, 'right')]));
        const graph = [right, root, left];

        const resolved = resolveSnapshots(graph, NAMESPACE, NOW);
        const joined = prepareSnapshot('join', NAMESPACE, resolved.data!, graph, NOW);

        expect(resolved.heads).toEqual(['left', 'right']);
        expect(resolved.data?.tasks.map((item) => item.id).sort()).toEqual(['left-task', 'right-task']);
        expect(joined?.parents).toEqual(['left', 'right']);
    });

    test('uses core revision conflict semantics for the same entity', () => {
        const root = snapshot('root', [], data([task('shared', 'Base', 1, 'base')]));
        const left = snapshot('left', ['root'], data([
            task('shared', 'Left winner candidate', 2, 'device-a', '2026-09-02T12:00:00.000Z'),
        ]));
        const right = snapshot('right', ['root'], data([
            task('shared', 'Right deterministic winner', 2, 'device-z', '2026-09-02T12:00:00.000Z'),
        ]));

        const resolved = resolveSnapshots([root, right, left], NAMESPACE, NOW);

        expect(titleById(resolved.data, 'shared')).toBe('Right deterministic winner');
    });

    test('is independent of Drive listing order and handles two roots', () => {
        const first = snapshot('a-root', [], data([task('z', 'Zed', 1, 'z')]));
        const second = snapshot('Z-root', [], data([task('A', 'Alpha', 1, 'a')]));

        const forward = resolveSnapshots([first, second], NAMESPACE, NOW);
        const reversed = resolveSnapshots([second, first], NAMESPACE, NOW);

        expect(forward.heads).toEqual(['Z-root', 'a-root']);
        expect(reversed).toEqual(forward);
        expect(forward.data?.tasks.map((item) => item.id).sort()).toEqual(['A', 'z']);
    });

    test('accepts duplicate identical listings but rejects duplicate ID mismatch', () => {
        const root = snapshot('root', [], data([task('a', 'Original', 1, 'a')]));
        expect(resolveSnapshots([root, structuredClone(root)], NAMESPACE, NOW).heads).toEqual(['root']);

        const mismatch = snapshot('root', [], data([task('a', 'Changed', 2, 'b')]));
        expect(() => resolveSnapshots([root, mismatch], NAMESPACE, NOW)).toThrow(/duplicate snapshot id root.*mismatched/i);
    });

    test('fails closed for missing parents, cycles, and wrong namespaces', () => {
        const empty = data();
        expect(() => resolveSnapshots([
            snapshot('child', ['missing'], empty),
        ], NAMESPACE, NOW)).toThrow(/missing parent missing/i);

        expect(() => resolveSnapshots([
            snapshot('a', ['b'], empty),
            snapshot('b', ['a'], empty),
        ], NAMESPACE, NOW)).toThrow(/cycle/i);

        expect(() => resolveSnapshots([
            snapshot('root', [], empty, 'another-namespace'),
        ], NAMESPACE, NOW)).toThrow(/wrong namespace/i);
    });

    test('fails closed when a child claims but does not cover its parent', () => {
        const root = snapshot('root', [], data([task('kept', 'Must survive', 2, 'root')]));
        const droppingChild = snapshot('child', ['root'], data());

        expect(() => resolveSnapshots([root, droppingChild], NAMESPACE, NOW)).toThrow(
            /snapshot child does not cover parent root/i,
        );
    });

    test('keeps a deletion against a stale offline branch', () => {
        const original = task('shared', 'Original', 1, 'base', '2026-09-01T12:00:00.000Z');
        const root = snapshot('root', [], data([original]));
        const deletedAt = '2026-09-04T12:00:00.000Z';
        const deleted = snapshot('deleted', ['root'], data([
            task('shared', 'Original', 2, 'delete-device', deletedAt, { deletedAt }),
        ]));
        const stale = snapshot('stale', ['root'], data([
            original,
            task('offline-new', 'Offline addition', 1, 'offline', '2026-09-05T12:00:00.000Z'),
        ]));

        const resolved = resolveSnapshots([root, stale, deleted], NAMESPACE, NOW);

        expect(resolved.data?.tasks.find((item) => item.id === 'shared')?.deletedAt).toBe(deletedAt);
        expect(titleById(resolved.data, 'offline-new')).toBe('Offline addition');
    });

    test('allows a newer revision to restore a deleted entity', () => {
        const original = task('shared', 'Original', 1, 'base', '2026-09-01T12:00:00.000Z');
        const root = snapshot('root', [], data([original]));
        const deletedAt = '2026-09-03T12:00:00.000Z';
        const deleted = snapshot('deleted', ['root'], data([
            task('shared', 'Original', 2, 'delete-device', deletedAt, { deletedAt }),
        ]));
        const restored = snapshot('restored', ['deleted'], data([
            task('shared', 'Restored', 3, 'restore-device', '2026-09-06T12:00:00.000Z'),
        ]));

        const resolved = resolveSnapshots([root, deleted, restored], NAMESPACE, NOW);

        expect(titleById(resolved.data, 'shared')).toBe('Restored');
        expect(resolved.data?.tasks[0]?.deletedAt).toBeUndefined();
    });

    test('reaches a one-head no-upload steady state with a revision-aware signature', () => {
        const remoteTask = task('shared', 'Same content', 1, 'device-a', '2026-09-02T12:00:00.000Z');
        const root = snapshot('root', [], data([remoteTask]));

        expect(prepareSnapshot('unused', NAMESPACE, data([structuredClone(remoteTask)]), [root], NOW)).toBeNull();

        const revisionOnlyChange = data([
            task('shared', 'Same content', 2, 'device-b', '2026-09-02T12:00:00.000Z'),
        ]);
        const prepared = prepareSnapshot('revision-child', NAMESPACE, revisionOnlyChange, [root], NOW);
        expect(prepared?.data.tasks[0]?.rev).toBe(2);
    });

    test('logically compacts multiple identical heads by publishing a child', () => {
        const shared = data([task('shared', 'Same snapshot', 1, 'device')]);
        const first = snapshot('first', [], structuredClone(shared));
        const second = snapshot('second', [], structuredClone(shared));

        const prepared = prepareSnapshot('join', NAMESPACE, structuredClone(shared), [second, first], NOW);

        expect(prepared).not.toBeNull();
        expect(prepared?.parents).toEqual(['first', 'second']);
        expect(prepareSnapshot('unused', NAMESPACE, prepared!.data, [first, second, prepared!], NOW)).toBeNull();
    });

    test('cold recomputation of a published join reaches the same state', () => {
        const left = snapshot('left', [], data([task('a', 'A', 1, 'a')]));
        const right = snapshot('right', [], data([task('b', 'B', 1, 'b')]));
        const initialGraph = [right, left];
        const firstResolution = resolveSnapshots(initialGraph, NAMESPACE, NOW);
        const join = prepareSnapshot('join', NAMESPACE, firstResolution.data!, initialGraph, NOW)!;

        const coldGraph = structuredClone([...initialGraph, join]);
        const coldResolution = resolveSnapshots(coldGraph, NAMESPACE, NOW);

        expect(coldResolution.heads).toEqual(['join']);
        expect(coldResolution.data).toEqual(firstResolution.data);
        expect(prepareSnapshot('unused', NAMESPACE, coldResolution.data!, coldGraph, NOW)).toBeNull();
    });

    test('rejects malformed data, duplicate entities, and attachments', () => {
        const malformed = data() as unknown as Record<string, unknown>;
        malformed.tasks = [{ id: 'broken' }];
        expect(() => resolveSnapshots([
            snapshot('bad', [], malformed as unknown as AppData),
        ], NAMESPACE, NOW)).toThrow(/tasks\[0\].*(updatedAt|title)/i);

        const duplicate = data([
            task('same', 'First', 1, 'a'),
            task('same', 'Second', 2, 'b'),
        ]);
        expect(() => prepareSnapshot('root', NAMESPACE, duplicate, [], NOW)).toThrow(/duplicate id same/i);

        const withAttachment = data([
            { ...task('a', 'Attached', 1, 'a'), attachments: [] },
        ]);
        expect(() => prepareSnapshot('root', NAMESPACE, withAttachment, [], NOW)).toThrow(/attachments are not supported/i);
    });

    test('enforces parent and immutable history bounds', () => {
        const tooManyParents = snapshot(
            'wide',
            Array.from({ length: 129 }, (_, index) => `parent-${index}`),
            data(),
        );
        expect(() => resolveSnapshots([tooManyParents], NAMESPACE, NOW)).toThrow(/exceeds 128 parents/i);

        const history: Snapshot[] = [];
        for (let index = 0; index < 128; index += 1) {
            const id = `snapshot-${String(index).padStart(3, '0')}`;
            history.push(snapshot(id, index === 0 ? [] : [history[index - 1]!.id], data()));
        }
        expect(resolveSnapshots(history, NAMESPACE, NOW).heads).toEqual(['snapshot-127']);
        expect(() => prepareSnapshot(
            'snapshot-128',
            NAMESPACE,
            data([task('new', 'Changed', 1, 'device')]),
            history,
            NOW,
        )).toThrow(/publishing would exceed 128 snapshot files/i);

        expect(() => resolveSnapshots([
            ...history,
            snapshot('snapshot-128', ['snapshot-127'], data()),
        ], NAMESPACE, NOW)).toThrow(/history exceeds 128 files/i);
    });

    test('does not mutate snapshots while resolving', () => {
        const root = snapshot('root', [], data([task('a', 'A', 1, 'a')]));
        const before = structuredClone(root);

        resolveSnapshots([root], NAMESPACE, NOW);

        expect(root).toEqual(before);
    });
});
