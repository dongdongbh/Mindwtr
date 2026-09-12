import { describe, expect, it } from 'vitest';
import { createReferenceSearchPredicate, isReferenceInVisibleProject } from './reference';
import type { Project, Task } from './types';

const task: Task = {
    id: 'reference', title: 'key1 key2 key3', description: '中文资料 café', status: 'reference',
    contexts: [], tags: [], projectId: 'project', createdAt: '', updatedAt: '',
};
const project: Project = {
    id: 'project', title: 'Project', status: 'active', color: '#123456', tagIds: [], createdAt: '', updatedAt: '',
};

describe('Reference search', () => {
    it.each(['', '  ', 'key1 key2', 'ke 1 2', 'KEY2\nkey1', 'key1 资料', '中文 料', 'cafe\u0301', 'ＫＥＹ１'])('matches literal all-term query %j', (query) => {
        expect(createReferenceSearchPredicate(query)(task)).toBe(true);
    });

    it.each(['key1 missing', '中文 不存在', 'key4', 'status:reference'])('requires every substring for %j', (query) => {
        expect(createReferenceSearchPredicate(query)(task)).toBe(false);
    });

    it('does not treat operators or punctuation as syntax', () => {
        expect(createReferenceSearchPredicate('OR -draft #tag')({ title: 'OR #tag', description: '-draft' })).toBe(true);
        expect(createReferenceSearchPredicate('key1 OR missing')(task)).toBe(false);
        expect(createReferenceSearchPredicate('status:reference')({ title: 'Literal status:reference' })).toBe(true);
    });

    it('handles a large reference collection without mutation or per-query state', () => {
        const references = Array.from({ length: 5000 }, (_, index) => ({ ...task, id: String(index), title: `Reference ${index}` }));
        const match = createReferenceSearchPredicate('reference 4999 资料');
        expect(references.filter(match).map((item) => item.id)).toEqual(['4999']);
        expect(references[4999].description).toBe(task.description);
    });
});

describe('Reference project visibility', () => {
    it.each(['map', 'record'])('handles active, parked and historical projects using a %s', (kind) => {
        const visible = (updates: Partial<Project>, includeArchived = false) => isReferenceInVisibleProject(
            task,
            kind === 'map' ? new Map([[project.id, { ...project, ...updates }]]) : { [project.id]: { ...project, ...updates } },
            includeArchived,
        );
        expect(visible({})).toBe(true);
        expect(visible({ status: 'someday' })).toBe(false);
        expect(visible({ status: 'waiting' }, true)).toBe(false);
        expect(visible({ status: 'waiting', isFocused: true })).toBe(true);
        expect(visible({ status: 'archived' })).toBe(false);
        expect(visible({ status: 'archived', isFocused: true })).toBe(false);
        expect(visible({ status: 'archived' }, true)).toBe(true);
        expect(visible({ status: 'archived', cancelledAt: '2026-09-01T00:00:00Z' }, true)).toBe(true);
        expect(visible({ status: 'archived', deletedAt: '2026-09-01T00:00:00Z' }, true)).toBe(false);
        expect(visible({ purgedAt: '2026-09-01T00:00:00Z' }, true)).toBe(false);
    });

    it('keeps unassigned/orphaned references but never includes deleted references or other statuses', () => {
        const projects = new Map([[project.id, project]]);
        expect(isReferenceInVisibleProject({ ...task, projectId: undefined }, projects)).toBe(true);
        expect(isReferenceInVisibleProject(task, new Map())).toBe(true);
        for (const status of ['inbox', 'next', 'waiting', 'someday', 'done', 'archived'] as const) {
            expect(isReferenceInVisibleProject({ ...task, status }, projects, true)).toBe(false);
        }
        expect(isReferenceInVisibleProject({ ...task, deletedAt: '2026-09-01T00:00:00Z' }, projects, true)).toBe(false);
        expect(isReferenceInVisibleProject({ ...task, purgedAt: '2026-09-01T00:00:00Z' }, projects, true)).toBe(false);
    });
});
