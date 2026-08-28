import { describe, expect, it } from 'vitest';
import {
    buildCollectionDiffTraceSample,
    buildSyncPayloadDiffTraceExtra,
    buildSyncPayloadTraceExtra,
    collectChangedTracePaths,
    isSyncPayloadTraceEnabled,
    SYNC_TRACE_EVENT_MESSAGES,
} from './sync-payload-trace';
import { buildSyncPayloadSurfaceTraceExtra } from './sync-payload-trace';
import { computeSyncPayloadFingerprint } from './sync-helpers';
import type { AppData, Task } from './types';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Secret plans for ${id}`,
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const appData = (overrides: Partial<AppData> = {}): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {},
    ...overrides,
});

describe('isSyncPayloadTraceEnabled', () => {
    it('follows the diagnostics logging switch', () => {
        expect(isSyncPayloadTraceEnabled({ diagnostics: { loggingEnabled: true } })).toBe(true);
        expect(isSyncPayloadTraceEnabled({ diagnostics: { loggingEnabled: false } })).toBe(false);
        expect(isSyncPayloadTraceEnabled({})).toBe(false);
        expect(isSyncPayloadTraceEnabled(undefined)).toBe(false);
    });
});

describe('buildSyncPayloadTraceExtra', () => {
    it('reports counts, area ids and a fingerprint without leaking content', () => {
        const data = appData({
            tasks: [task('t1'), task('t2')],
            areas: [
                { id: 'area-live', name: 'Work', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                { id: 'area-gone', name: 'Old', order: 1, deletedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
            ],
        });

        const extra = buildSyncPayloadTraceExtra(data, { step: 'read-local' });

        expect(extra.step).toBe('read-local');
        expect(extra.hasData).toBe('true');
        expect(extra.tasks).toBe('2');
        expect(extra.areas).toBe('2');
        expect(extra.deletedAreas).toBe('1');
        expect(extra.areaIdsSample).toBe('area-gone:deleted,area-live');
        expect(extra.areaIdsTruncated).toBe('false');
        expect(extra.fingerprint).toBeTruthy();
        expect(extra.tasksSig).toBeTruthy();
        expect(JSON.stringify(extra)).not.toContain('Secret plans');
    });

    it('truncates the area id sample past 24 areas', () => {
        const areas = Array.from({ length: 30 }, (_, index) => ({
            id: `area-${String(index).padStart(2, '0')}`,
            name: `Area ${index}`,
            order: index,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        }));

        const extra = buildSyncPayloadTraceExtra(appData({ areas }));

        expect(extra.areaIdsTruncated).toBe('true');
        expect(extra.areaIdsSample.split(',')).toHaveLength(24);
    });

    it('marks a missing payload instead of throwing', () => {
        expect(buildSyncPayloadTraceExtra(null, { step: 'read-remote' })).toEqual({ step: 'read-remote', hasData: 'false' });
        expect(buildSyncPayloadTraceExtra(undefined).hasData).toBe('false');
    });
});

describe('collectChangedTracePaths', () => {
    it('returns nothing for equal values and the field path for a difference', () => {
        expect(collectChangedTracePaths({ a: 1 }, { a: 1 })).toEqual([]);
        expect(collectChangedTracePaths({ a: 1, b: 2 }, { a: 9, b: 2 })).toEqual(['a']);
    });

    it('redacts credential-shaped field names', () => {
        expect(collectChangedTracePaths({ webdav: { password: 'old' } }, { webdav: { password: 'new' } }))
            .toEqual(['[sensitive]']);
        expect(collectChangedTracePaths({ cloud: { token: 'a' } }, { cloud: { token: 'b' } }))
            .toEqual(['[sensitive]']);
    });

    it('stops descending at depth 3 and names the branch instead', () => {
        const left = { a: { b: { c: { d: 1 } } } };
        const right = { a: { b: { c: { d: 2 } } } };
        expect(collectChangedTracePaths(left, right)).toEqual(['a.b.c']);
    });
});

describe('buildCollectionDiffTraceSample', () => {
    it('names added, removed and changed records by id and field, never by content', () => {
        const sample = buildCollectionDiffTraceSample(
            [task('t1'), task('t2')],
            [task('t1', { title: 'Renamed secret' }), task('t3')],
        );

        expect(sample).toContain('t1:fields=title');
        expect(sample).toContain('t2:onlyCurrent:');
        expect(sample).toContain('t3:onlySynced:');
        expect(sample).not.toContain('Secret plans');
        expect(sample).not.toContain('Renamed secret');
    });

    it('caps the sample at 12 records', () => {
        const current = Array.from({ length: 20 }, (_, index) => task(`t${String(index).padStart(2, '0')}`));
        const synced = current.map((item) => ({ ...item, status: 'next' as const }));

        const sample = buildCollectionDiffTraceSample(current, synced);

        expect(sample.split(';fields=').length - 1).toBeLessThanOrEqual(12);
        expect(sample.split('current=').length - 1).toBe(12);
    });
});

describe('buildSyncPayloadDiffTraceExtra', () => {
    it('lists only the surfaces that actually differ', () => {
        const current = appData({ tasks: [task('t1')] });
        const synced = appData({ tasks: [task('t1', { status: 'next' })] });

        const extra = buildSyncPayloadDiffTraceExtra(current, synced);

        expect(extra.surfaceDiffs).toBe('tasks');
        expect(extra.tasksChanged).toBe('true');
        expect(extra.projectsChanged).toBe('false');
        expect(extra.tasksSample).toContain('t1:fields=status');
        expect(extra.projectsSample).toBeUndefined();
        expect(extra.currentTasksSig).toBeTruthy();
        expect(extra.syncedTasksSig).toBeTruthy();
    });

    // The diff runs on the sanitized payload, so an opted-out surface reads as
    // unchanged no matter what the local value is.
    it('reports settings differences as field paths, not samples', () => {
        const extra = buildSyncPayloadDiffTraceExtra(
            appData({ settings: { syncPreferences: { appearance: true }, theme: 'dark' } }),
            appData({ settings: { syncPreferences: { appearance: true }, theme: 'light' } }),
        );

        expect(extra.surfaceDiffs).toBe('settings');
        expect(extra.settingsPaths).toBe('theme');
        expect(extra.settingsSample).toBeUndefined();
    });

    it('says none when the payloads agree', () => {
        const data = appData({ tasks: [task('t1')] });
        expect(buildSyncPayloadDiffTraceExtra(data, structuredClone(data)).surfaceDiffs).toBe('none');
    });

    it('ignores a settings surface the user opted out of syncing', () => {
        const extra = buildSyncPayloadDiffTraceExtra(
            appData({ settings: { syncPreferences: { appearance: false }, theme: 'dark' } }),
            appData({ settings: { syncPreferences: { appearance: false }, theme: 'light' } }),
        );

        expect(extra.surfaceDiffs).toBe('none');
    });
});

describe('SYNC_TRACE_EVENT_MESSAGES', () => {
    it('gives every trace event a distinct message', () => {
        const messages = Object.values(SYNC_TRACE_EVENT_MESSAGES);
        expect(new Set(messages).size).toBe(messages.length);
        expect(messages.every((message) => message.startsWith('Sync trace'))).toBe(true);
    });
});

describe('sync payload trace signature memo (#766)', () => {
    it('still reports the document fingerprint sync itself computes', () => {
        const data = appData({ tasks: [task('a'), task('b')] });
        expect(buildSyncPayloadTraceExtra(data).fingerprint).toBe(computeSyncPayloadFingerprint(data));
        expect(buildSyncPayloadTraceExtra(data).tasksSig)
            .toBe(buildSyncPayloadSurfaceTraceExtra(data).tasksSig);
    });

    it('reuses the signatures it already computed for a document', () => {
        // Documents are replaced, never mutated in place, so an in-place edit is
        // only a way to observe that the second trace did not recompute. If this
        // ever fails the memo is dead and every trace pays full price again.
        const data = appData({ tasks: [task('a')] });
        const first = buildSyncPayloadTraceExtra(data);
        data.tasks.push(task('b'));
        expect(buildSyncPayloadTraceExtra(data).tasksSig).toBe(first.tasksSig);
        expect(buildSyncPayloadTraceExtra({ ...data }).tasksSig).not.toBe(first.tasksSig);
    });
});

describe('large-document trace budget (#766)', () => {
    const bigData = (count: number): AppData => appData({
        tasks: Array.from({ length: count }, (_, index) => task(`t-${index}`)),
    });

    it('keeps the whole-document fingerprint for an ordinary library', () => {
        const extra = buildSyncPayloadTraceExtra(bigData(50));
        expect(extra.fingerprint).toBeDefined();
        expect(extra.fingerprintSkipped).toBeUndefined();
        expect(extra.tasksSig).toBeDefined();
    });

    it('drops only that fingerprint past the record threshold, keeping every surface signature', () => {
        const extra = buildSyncPayloadTraceExtra(bigData(2001));
        expect(extra.fingerprint).toBeUndefined();
        expect(extra.fingerprintSkipped).toBe('large-document');
        // The surface signatures are what actually identify the document; the
        // dropped fingerprint hashed ~98% of the same bytes as tasksSig.
        expect(extra.tasksSig).toBeDefined();
        expect(extra.projectsSig).toBeDefined();
        expect(extra.settingsSig).toBeDefined();
        expect(extra.tasks).toBe('2001');
    });
});
