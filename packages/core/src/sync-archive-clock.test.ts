import { afterEach, describe, expect, it } from 'vitest';

import { setLogger, type LogPayload } from './logger';
import { mergeAppDataWithStats } from './sync';
import { createMockProject, createMockTask, mockAppData } from './sync-test-utils';
import type { AppData, Task } from './types';

const AT = '2026-10-07T21:17:33.244Z';
const NOW = '2026-10-24T12:00:00.000Z';
const task: Task = { ...createMockTask('synthetic-task', AT), status: 'archived', completedAt: AT,
    archivedAt: AT, rev: 3, revBy: 'same-device' };
const merge = (a: AppData, b: AppData) => mergeAppDataWithStats(a, b, { nowIso: NOW });

describe('archive clock omitted from the same saved operation (#1446)', () => {
    afterEach(() => setLogger(() => {}));

    it.each(['archived', 'done', 'next'] as const)('joins a %s task without a conflict in either direction or on replay', (status) => {
        const current = mockAppData([{ ...task, status }]);
        const oldPeer = structuredClone(current);
        delete oldPeer.tasks[0].archivedAt;
        for (const [a, b] of [[current, oldPeer], [oldPeer, current]]) {
            const first = merge(a, b);
            expect(first.stats.tasks.conflicts).toBe(0);
            expect(first.data.tasks[0].archivedAt).toBe(AT);
            expect(first.data.tasks[0].rev).toBe(3);
            for (const peer of [current, oldPeer]) {
                for (const next of [merge(first.data, peer), merge(peer, first.data)]) {
                    expect(next.stats.tasks.conflicts).toBe(0);
                    expect(next.data).toEqual(first.data);
                }
            }
        }
    });

    it('joins the same project operation and logs only aggregate confirmation', () => {
        const logs: LogPayload[] = [];
        setLogger((entry) => { logs.push(entry); });
        const project = { ...createMockProject('synthetic-project', AT), status: 'archived' as const,
            archivedAt: AT, rev: 3, revBy: 'same-device' };
        const current = mockAppData([], [project]);
        const oldPeer = structuredClone(current);
        delete oldPeer.projects[0].archivedAt;
        for (const [a, b] of [[current, oldPeer], [oldPeer, current]]) {
            const first = merge(a, b);
            expect(first.stats.projects.conflicts).toBe(0);
            expect(first.data.projects[0].archivedAt).toBe(AT);
            expect(merge(first.data, oldPeer).stats.projects.conflicts).toBe(0);
        }
        expect(logs.find((entry) => entry.context?.releaseCheck === 'v1.3.8/archive-clock-converge')?.context)
            .toEqual({ releaseCheck: 'v1.3.8/archive-clock-converge', entityType: 'project', count: 1 });
    });

    it.each([
        { title: 'A concurrent edit' },
        { revBy: 'other-device' },
        { updatedAt: '2026-10-08T21:17:33.244Z' },
        { status: 'next' as const, completedAt: undefined },
    ])('retains a genuine conflict when another operation field differs: %j', (updates) => {
        const peer = { ...task, ...updates, archivedAt: undefined };
        for (const [a, b] of [[task, peer], [peer, task]]) {
            expect(merge(mockAppData([a]), mockAppData([b])).stats.tasks.conflicts).toBe(1);
        }
    });

    it('lets a newer operation without a clock win without inheriting an old retention date', () => {
        const newer = { ...task, archivedAt: undefined, rev: 4, updatedAt: '2026-10-08T21:17:33.244Z' };
        for (const [a, b] of [[task, newer], [newer, task]]) {
            const result = merge(mockAppData([a]), mockAppData([b]));
            expect(result.data.tasks[0].rev).toBe(4);
            expect(result.data.tasks[0].archivedAt).toBeUndefined();
        }
    });
});
