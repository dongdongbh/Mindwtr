import { describe, expect, it, vi } from 'vitest';
import { createSlicer, runSliced, runToEnd, type CooperativePass } from './cooperative';
import { mergeAppDataWithStats, mergeAppDataWithStatsPass } from './sync';
import { validateMergedSyncData, validateMergedSyncDataPass } from './sync-normalization';
import {
    computeStableValueFingerprint,
    computeSyncChangeFingerprint,
    computeSyncChangeFingerprintPass,
    fingerprintStableSyncJsonPass,
    sanitizeAppDataForRemote,
    sanitizeAppDataForRemotePass,
    toStableSyncJson,
    toStableSyncJsonPass,
} from './sync-helpers';
import { remoteSyncDocumentStableJsonPass, toRemoteSyncDocument } from './sync-document';
import { cloneAppData, cloneAppDataPass } from './sync-runtime-utils';
import type { AppData, Task } from './types';

// D9: every pass a sync cycle runs in slices must return exactly what the same work returns at once. The slicer here yields
// after every step, the most interleaved run there can be.

import { brokenMerge, incoming, local, MERGE_AT } from './__fixtures__/cooperative-library';

const everyStep = () => {
    let yields = 0;
    const slicer = createSlicer(async () => { yields += 1; }, 0);
    return { slicer, yields: () => yields };
};
const sliced = async <T>(pass: CooperativePass<T>) => {
    const { slicer, yields } = everyStep();
    const value = await runSliced('test', pass, slicer);
    return { value, yields: yields() };
};

// The same work computed on origin/main 04696d554, before the passes existed (scratch golden.ts over this fixture). Each pass,
// run at once and in slices, must still give these: a pass that drops an item at a slice boundary changes them.
const GOLDEN = {
    merge: 'stable-v2:129664:cbf134c08e697d71',
    changeFingerprint: 'change-v1:16920:16a930ded3a5d43d',
    remoteDocument: 'stable-v2:85953:3ce35ba1d83ccb85',
    validation: [
            'tasks[63].updatedAt must be a valid ISO timestamp',
            'tasks[127].updatedAt must be a valid ISO timestamp',
            'tasks[191].updatedAt must be a valid ISO timestamp',
            'tasks[255].updatedAt must be a valid ISO timestamp',
            'tasks[319].updatedAt must be a valid ISO timestamp',
            'tasks[383].updatedAt must be a valid ISO timestamp',
            'tasks[63].projectId must reference an existing project',
            'tasks[127].projectId must reference an existing project',
            'tasks[191].projectId must reference an existing project',
            'tasks[255].projectId must reference an existing project',
            'tasks[319].projectId must reference an existing project',
            'tasks[383].projectId must reference an existing project',
    ],
};

describe('cooperative passes give the result of the same work done at once', () => {
    it('merge', async () => {
        const { value, yields } = await sliced(mergeAppDataWithStatsPass(local, incoming, MERGE_AT));
        expect(yields).toBeGreaterThan(10);
        expect(value.data.tasks).toHaveLength(430);
        expect(computeStableValueFingerprint({ data: value.data, stats: value.stats })).toBe(GOLDEN.merge);
        expect(mergeAppDataWithStats(local, incoming, MERGE_AT)).toEqual(value);
    });

    it('validation, a valid and an invalid document', async () => {
        const merged = mergeAppDataWithStats(local, incoming, MERGE_AT).data;
        const broken = brokenMerge(merged);
        expect((await sliced(validateMergedSyncDataPass(merged))).value).toEqual([]);
        const { value, yields } = await sliced(validateMergedSyncDataPass(broken));
        expect(yields).toBeGreaterThan(1);
        expect(value).toEqual(GOLDEN.validation);
        expect(validateMergedSyncData(broken)).toEqual(GOLDEN.validation);
    });

    it('remote document, stable JSON and fingerprints', async () => {
        const doc = toRemoteSyncDocument(local);
        const sanitized = (await sliced(sanitizeAppDataForRemotePass(local))).value;
        expect(computeStableValueFingerprint(sanitized)).toBe(GOLDEN.remoteDocument);
        expect(sanitized).toEqual(sanitizeAppDataForRemote(local));
        expect((await sliced(toStableSyncJsonPass(doc))).value).toBe(toStableSyncJson(doc));
        expect((await sliced(remoteSyncDocumentStableJsonPass(local))).value).toBe(toStableSyncJson(doc));
        const json = toStableSyncJson(doc);
        expect((await sliced(fingerprintStableSyncJsonPass(json))).value).toBe(GOLDEN.remoteDocument);
        expect((await sliced(computeSyncChangeFingerprintPass(local))).value).toBe(GOLDEN.changeFingerprint);
        expect(computeSyncChangeFingerprint(local)).toBe(GOLDEN.changeFingerprint);
    });

    it('a copy of the library', async () => {
        const { value, yields } = await sliced(cloneAppDataPass(local));
        expect(yields).toBeGreaterThan(1);
        expect(value).toEqual(cloneAppData(local));
        expect(value.tasks[0]).not.toBe(local.tasks[0]);
    });
});

describe('slice stats (D9b native-sync-slices diagnostics)', () => {
    function* busy(steps: number, ms: number, clock: { at: number }): CooperativePass<number> {
        for (let index = 0; index < steps; index += 1) {
            clock.at += ms;
            yield;
        }
        return steps;
    }
    const fakeClock = () => {
        const clock = { at: 0 };
        const now = vi.spyOn(performance, 'now').mockImplementation(() => clock.at);
        return { clock, restore: () => now.mockRestore() };
    };

    it('does not time an idle wait between passes, which costs only one early yield', async () => {
        const { clock, restore } = fakeClock();
        try {
            const slicer = createSlicer(async () => undefined, 8);
            clock.at += 5_000; // a network wait: the engine ran nothing
            await runSliced('test', busy(3, 1, clock), slicer);
            expect(slicer.stats().longestMs).toBeLessThan(5_000);
            expect(slicer.stats().longestMs).toBeLessThanOrEqual(3);
            // The wait made the first due() true: the pass gave the engine back once, after its first step.
            expect(slicer.stats().slices).toBe(1);
        } finally { restore(); }
    });

    it('counts the last stretch of a pass, which ends without a yield', async () => {
        const { clock, restore } = fakeClock();
        try {
            const slicer = createSlicer(async () => undefined, 1_000);
            await runSliced('test', busy(1, 400, clock), slicer);
            expect(slicer.stats().longestMs).toBe(400);
        } finally { restore(); }
    });
});
