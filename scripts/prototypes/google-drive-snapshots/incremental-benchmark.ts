/** Synthetic Bun CPU experiment; not a native desktop/mobile benchmark. */
import { performance } from 'node:perf_hooks';
import { setLogger } from '../../../packages/core/src/logger';
import type { AppData, Task } from '../../../packages/core/src/types';
import {
    createCachedSnapshotResolver,
    prepareSnapshot,
    resolveSnapshots,
    type Snapshot,
} from './model';

const BASE_NOW_MS = Date.parse('2026-09-17T12:00:00.000Z');
const SAMPLE_COUNT = 3;
setLogger(() => {});

const nowAt = (offsetMs: number): string => new Date(BASE_NOW_MS + offsetMs).toISOString();

const empty = (tasks: Task[]): AppData => ({
    tasks,
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {},
});

const fixture = (count: number): AppData => empty(Array.from({ length: count }, (_, index) => ({
    id: `synthetic-${index}`,
    title: `Synthetic task ${index}`,
    status: 'inbox',
    contexts: [],
    tags: [],
    rev: 1,
    revBy: 'synthetic-device',
    createdAt: nowAt(0),
    updatedAt: nowAt(0),
})));

const historyFixture = (count: number, namespace: string): Snapshot[] => {
    const snapshots: Snapshot[] = [
        prepareSnapshot('snapshot-0', namespace, fixture(count), [], nowAt(0))!,
    ];
    for (let index = 1; index < 10; index += 1) {
        const parent = snapshots.at(-1)!;
        const prior = parent.data;
        const changed: AppData = {
            ...prior,
            tasks: prior.tasks.map((item, taskIndex) => taskIndex === index
                ? {
                    ...item,
                    title: `Synthetic edit ${index}`,
                    rev: (item.rev ?? 0) + 1,
                }
                : item),
        };
        snapshots.push({
            format: 'mindwtr-drive-snapshot-prototype',
            version: 1,
            id: `snapshot-${index}`,
            namespace,
            parents: [parent.id],
            data: changed,
        });
    }
    resolveSnapshots(snapshots, namespace, nowAt(0));
    return snapshots;
};

const appendedFixture = (
    snapshots: Snapshot[],
    namespace: string,
): Snapshot => {
    const current = snapshots.at(-1)!.data;
    const changed: AppData = {
        ...current,
        tasks: current.tasks.map((item, index) => index === 0
            ? {
                ...item,
                title: 'Synthetic incremental edit',
                rev: (item.rev ?? 0) + 1,
            }
            : item),
    };
    return {
        format: 'mindwtr-drive-snapshot-prototype',
        version: 1,
        id: 'snapshot-10',
        namespace,
        parents: [snapshots.at(-1)!.id],
        data: changed,
    };
};

const median = (samples: number[]): number => {
    const sorted = [...samples].sort((left, right) => left - right);
    return Math.round(sorted[Math.floor(sorted.length / 2)]! * 100) / 100;
};

const measure = (operation: () => unknown): number => {
    const start = performance.now();
    operation();
    return performance.now() - start;
};

const results = [];
for (const count of [1_000, 5_000]) {
    const namespace = `synthetic-incremental-${count}`;
    const snapshots = historyFixture(count, namespace);
    const appended = appendedFixture(snapshots, namespace);

    const uncachedSamples: number[] = [];
    for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
        uncachedSamples.push(measure(() => resolveSnapshots(
            snapshots,
            namespace,
            nowAt(sample * 1_000),
        )));
    }

    const warmResolver = createCachedSnapshotResolver(namespace);
    warmResolver.resolve(snapshots, nowAt(0));
    const cachedWarmSamples: number[] = [];
    for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
        cachedWarmSamples.push(measure(() => warmResolver.resolve(
            snapshots,
            nowAt(sample * 1_000),
        )));
    }

    const oneNewSnapshotSamples: number[] = [];
    const oneNewSnapshotCounters = {
        fullValidationFallbacks: 0,
        normalizedSnapshotReuses: 0,
        coverageProofReuses: 0,
    };
    for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
        const incrementalResolver = createCachedSnapshotResolver(namespace);
        incrementalResolver.resolve(snapshots, nowAt(sample * 2_000));
        oneNewSnapshotSamples.push(measure(() => incrementalResolver.resolve(
            [...snapshots, appended],
            nowAt(sample * 2_000 + 1_000),
        )));
        const sampleStats = incrementalResolver.getStats();
        oneNewSnapshotCounters.fullValidationFallbacks += sampleStats.fullValidationFallbacks;
        oneNewSnapshotCounters.normalizedSnapshotReuses += sampleStats.normalizedSnapshotReuses;
        oneNewSnapshotCounters.coverageProofReuses += sampleStats.coverageProofReuses;
    }

    results.push({
        tasks: count,
        historyFiles: snapshots.length,
        documentBytes: Buffer.byteLength(JSON.stringify(snapshots.at(-1)!.data)),
        historyBytes: Buffer.byteLength(JSON.stringify(snapshots)),
        samplesPerCase: SAMPLE_COUNT,
        uncachedResolveAdvancingClockMedianMs: median(uncachedSamples),
        cachedWarmResolveAdvancingClockMedianMs: median(cachedWarmSamples),
        cachedResolveWithOneNewSnapshotMedianMs: median(oneNewSnapshotSamples),
        cachedWarmCounters: warmResolver.getStats(),
        cachedOneNewSnapshotCounters: oneNewSnapshotCounters,
    });
}

console.log(JSON.stringify({
    environment: 'synthetic-bun-cpu-only',
    clock: 'advances between every measured cached resolve',
    results,
}, null, 2));
