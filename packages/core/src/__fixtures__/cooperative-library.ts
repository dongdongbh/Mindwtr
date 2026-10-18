import type { AppData, Task } from '../types';

// The cooperative passes' fixture library (cooperative.test.ts). Its golden values there were computed on origin/main
// (04696d554), before the passes existed: change the fixture and they must be computed again the same way.

const AT = '2026-07-01T00:00:00.000Z';
const LATER = '2026-07-02T00:00:00.000Z';
const task = (i: number, extra: Partial<Task> = {}): Task => ({
    id: `t-${String(i).padStart(4, '0')}`, title: `Task ${i} ✓`, status: (['inbox', 'next', 'waiting', 'someday', 'done'] as const)[i % 5],
    tags: [`#t${i % 7}`], contexts: [`@c${i % 4}`], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'local',
    ...(i % 9 === 0 ? { checklist: [{ id: `c-${i}`, title: 'step', isCompleted: i % 2 === 0 }] } : {}),
    ...(i % 11 === 0 ? { attachments: [{ id: `a-${i}`, kind: 'link', title: 'x', uri: 'https://example.com', createdAt: AT, updatedAt: AT }] } : {}),
    ...(i % 13 === 0 ? { projectId: 'p-1' } : {}),
    ...extra,
} as Task);
const library = (tasks: Task[]): AppData => ({
    tasks,
    projects: [{ id: 'p-1', title: 'Project', status: 'active', color: '#94a3b8', createdAt: AT, updatedAt: AT, rev: 1, revBy: 'local' }],
    sections: [], areas: [{ id: 'a-1', name: 'Area', order: 0, createdAt: AT, updatedAt: AT, rev: 1, revBy: 'local' }], people: [],
    settings: { language: 'en' },
} as unknown as AppData);
export const local = library(Array.from({ length: 400 }, (_, i) => task(i)));
// The other device: a third edited, some deleted, some only there; the first ones missing there.
export const incoming = library([
    ...Array.from({ length: 380 }, (_, j) => {
        const i = j + 20;
        if (i % 3 === 0) return task(i, { title: `Task ${i} (remote)`, rev: 2, revBy: 'remote', updatedAt: LATER });
        if (i % 17 === 0) return task(i, { deletedAt: LATER, rev: 2, revBy: 'remote', updatedAt: LATER });
        return task(i);
    }),
    ...Array.from({ length: 30 }, (_, j) => task(1000 + j, { revBy: 'remote' })),
]);

export const MERGE_AT = { nowIso: '2026-07-03T00:00:00.000Z' };
/** A merged document with broken rows on slice boundaries (every 64th task), where a pass that skips one would miss them. */
export const brokenMerge = (merged: AppData): AppData => ({
    ...merged,
    tasks: merged.tasks.map((row, i) => (i % 64 === 63 ? { ...row, projectId: 'missing', updatedAt: 'x' } : row)),
});
