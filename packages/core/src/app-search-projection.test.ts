// Moved with the projection from React Native's lib/app-search-projection.test.ts (pass O2c); React Native keeps its copy, which now runs
// against core through its re-export.
import { describe, expect, it } from 'vitest';
import type { Area, Project, Task } from './types';

import {
    buildAppSearchDelta,
    buildAreaDoc,
    buildFullAppSearchIndex,
    buildProjectDoc,
    buildTaskDoc,
    isAreaIndexable,
    isProjectIndexable,
    isTaskIndexable,
} from './app-search-projection';

const now = '2026-08-10T00:00:00.000Z';

const task = (overrides: Partial<Task> = {}): Task => ({
    id: 't1',
    title: 'Buy milk',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const project = (overrides: Partial<Project> = {}): Project => ({
    id: 'p1',
    title: 'Kitchen remodel',
    status: 'active',
    color: '#000',
    order: 0,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const area = (overrides: Partial<Area> = {}): Area => ({
    id: 'a1',
    name: 'Home',
    order: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

describe('app-search-projection', () => {
    describe('indexable predicates', () => {
        it('includes an active task with only the allowed fields', () => {
            const doc = buildTaskDoc(task({ dueDate: '2026-08-12', projectId: 'p1' }));
            expect(doc).toEqual({
                id: 'task:t1',
                kind: 'task',
                title: 'Buy milk',
                status: 'next',
                dueDate: '2026-08-12',
                parentId: 'p1',
                deepLink: 'mindwtr://open?task=t1',
            });
        });

        it('excludes done, archived, and deleted tasks', () => {
            expect(isTaskIndexable(task({ status: 'done' }))).toBe(false);
            expect(isTaskIndexable(task({ status: 'archived' }))).toBe(false);
            expect(isTaskIndexable(task({ deletedAt: now }))).toBe(false);
            expect(buildTaskDoc(task({ status: 'done' }))).toBeNull();
        });

        it('never carries description, notes, tags, or contexts', () => {
            const doc = buildTaskDoc(task({
                description: 'secret notes',
                tags: ['#private'],
                contexts: ['@home'],
            }));
            expect(doc).not.toHaveProperty('description');
            expect(doc).not.toHaveProperty('tags');
            expect(doc).not.toHaveProperty('contexts');
        });

        it('excludes archived and deleted projects', () => {
            expect(isProjectIndexable(project({ status: 'archived' }))).toBe(false);
            expect(isProjectIndexable(project({ deletedAt: now }))).toBe(false);
            expect(buildProjectDoc(project({ status: 'archived' }))).toBeNull();
        });

        it('maps a project to its area as parentId', () => {
            expect(buildProjectDoc(project({ areaId: 'a1' }))).toMatchObject({ parentId: 'a1' });
        });

        it('excludes deleted areas', () => {
            expect(isAreaIndexable(area({ deletedAt: now }))).toBe(false);
            expect(buildAreaDoc(area({ deletedAt: now }))).toBeNull();
        });
    });

    describe('buildFullAppSearchIndex', () => {
        it('combines indexable tasks, projects, and areas', () => {
            const docs = buildFullAppSearchIndex({
                tasks: [task(), task({ id: 't2', status: 'done' })],
                projects: [project()],
                areas: [area()],
            });
            expect(docs.map((d) => d.id)).toEqual(['task:t1', 'project:p1', 'area:a1']);
        });
    });

    describe('buildAppSearchDelta', () => {
        it('emits no work when nothing changed (same references)', () => {
            const tasks = [task()];
            const projects = [project()];
            const areas = [area()];
            const delta = buildAppSearchDelta({
                prevTasks: tasks, nextTasks: tasks,
                prevProjects: projects, nextProjects: projects,
                prevAreas: areas, nextAreas: areas,
            });
            expect(delta).toEqual({ upserts: [], removeIds: [] });
        });

        it('upserts a changed task and leaves untouched entities alone', () => {
            const untouchedProject = project();
            const t1 = task();
            const t1Updated = task({ title: 'Buy oat milk' });
            const delta = buildAppSearchDelta({
                prevTasks: [t1], nextTasks: [t1Updated],
                prevProjects: [untouchedProject], nextProjects: [untouchedProject],
                prevAreas: [], nextAreas: [],
            });
            expect(delta.upserts).toEqual([expect.objectContaining({ id: 'task:t1', title: 'Buy oat milk' })]);
            expect(delta.removeIds).toEqual([]);
        });

        it('removes a task that disappeared from the visible collection (deleted)', () => {
            const t1 = task();
            const delta = buildAppSearchDelta({
                prevTasks: [t1], nextTasks: [],
                prevProjects: [], nextProjects: [],
                prevAreas: [], nextAreas: [],
            });
            expect(delta.removeIds).toEqual(['task:t1']);
        });

        it('removes a task that transitioned to done', () => {
            const t1 = task({ status: 'next' });
            const t1Done = task({ status: 'done' });
            const delta = buildAppSearchDelta({
                prevTasks: [t1], nextTasks: [t1Done],
                prevProjects: [], nextProjects: [],
                prevAreas: [], nextAreas: [],
            });
            expect(delta.upserts).toEqual([]);
            expect(delta.removeIds).toEqual(['task:t1']);
        });

        it('removes a project that transitioned to archived', () => {
            const p1 = project({ status: 'active' });
            const p1Archived = project({ status: 'archived' });
            const delta = buildAppSearchDelta({
                prevTasks: [], nextTasks: [],
                prevProjects: [p1], nextProjects: [p1Archived],
                prevAreas: [], nextAreas: [],
            });
            expect(delta.removeIds).toEqual(['project:p1']);
        });

        it('removes a deleted area', () => {
            const a1 = area();
            const delta = buildAppSearchDelta({
                prevTasks: [], nextTasks: [],
                prevProjects: [], nextProjects: [],
                prevAreas: [a1], nextAreas: [],
            });
            expect(delta.removeIds).toEqual(['area:a1']);
        });
    });
});

// Byte-identical to React Native's projection before the move (frozen from RN's lib/app-search-projection.ts, pass O2c).
describe('AppSearch projection parity with React Native', () => {
    it('builds the same documents and delta React Native built', async () => {
        const frozen = (await import('./app-search-parity.fixtures.json')).default;
        const { tasks, projects, areas } = frozen.input as unknown as { tasks: Task[]; projects: Project[]; areas: Area[] };
        expect(buildFullAppSearchIndex({ tasks, projects, areas })).toEqual(frozen.full);
        // The delta compares by reference: rebuild "next" the way the freeze did (t5 and p1 unchanged objects).
        const next = frozen.input as unknown as { nextTasks: Task[]; nextProjects: Project[]; nextAreas: Area[] };
        const nextTasks = [next.nextTasks[0], tasks[4], next.nextTasks[2], next.nextTasks[3]];
        const nextProjects = [projects[0], next.nextProjects[1]];
        expect(buildAppSearchDelta({ prevTasks: tasks, nextTasks, prevProjects: projects, nextProjects, prevAreas: areas,
            nextAreas: next.nextAreas })).toEqual(frozen.delta);
    });

    it('opens results in the build\'s own scheme when one is given', () => {
        const at = '2026-10-21T12:00:00.000Z';
        const docs = buildFullAppSearchIndex({ tasks: [{ id: 't 1', title: 'T', status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at } as Task],
            projects: [], areas: [], scheme: 'mindwtr-native-dev' });
        expect(docs[0].deepLink).toBe('mindwtr-native-dev://open?task=t%201');
    });
});
