import { describe, expect, it, vi } from 'vitest';

import {
    buildTaskContainerMovePatch,
    buildTaskMovePatch,
    resolveTaskContainerAssignment,
    resolveTaskContainerHierarchy,
    type TaskMoveDestination,
} from './task-container-rules';
import type { Area, Project, Section, Task } from './types';

const now = '2026-07-08T00:00:00.000Z';

const makeProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Project 1',
    status: 'active',
    color: '#2563eb',
    order: 0,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const makeSection = (overrides: Partial<Section> = {}): Section => ({
    id: 'section-1',
    projectId: 'project-1',
    title: 'Section 1',
    order: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const makeArea = (overrides: Partial<Area> = {}): Area => ({
    id: 'area-1',
    name: 'Area 1',
    order: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task 1',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

describe('resolveTaskContainerHierarchy', () => {
    it('infers the project from a valid section and clears area scope', () => {
        expect(resolveTaskContainerHierarchy({
            sectionId: 'section-1',
            areaId: 'area-1',
            sectionProjectId: 'project-1',
        })).toEqual({
            projectId: 'project-1',
            sectionId: 'section-1',
            areaId: undefined,
        });
    });

    it('drops sections that do not belong to the selected project', () => {
        expect(resolveTaskContainerHierarchy({
            projectId: 'project-1',
            sectionId: 'section-2',
            areaId: 'area-1',
            sectionProjectId: 'project-2',
        })).toEqual({
            projectId: 'project-1',
            sectionId: undefined,
            areaId: undefined,
        });
    });
});

describe('buildTaskMovePatch', () => {
    it('keeps a section the destination project owns', () => {
        expect(buildTaskMovePatch(
            { kind: 'project', id: 'project-1' },
            { projectId: 'project-1', sectionId: 'section-1' },
        )).toEqual({
            projectId: 'project-1',
            sectionId: 'section-1',
            areaId: undefined,
        });
    });

    it('drops a section another project owns', () => {
        expect(buildTaskMovePatch(
            { kind: 'project', id: 'project-2' },
            { projectId: 'project-1', sectionId: 'section-1' },
        )).toEqual({
            projectId: 'project-2',
            sectionId: undefined,
            areaId: undefined,
        });
    });

    it('clears the project and its section when moving to an area', () => {
        expect(buildTaskMovePatch(
            { kind: 'area', id: 'area-1' },
            { projectId: 'project-1', sectionId: 'section-1' },
        )).toEqual({
            projectId: undefined,
            sectionId: undefined,
            areaId: 'area-1',
        });
    });

    it('clears every container field for no destination', () => {
        expect(buildTaskMovePatch(
            { kind: 'none' },
            { projectId: 'project-1', sectionId: 'section-1' },
        )).toEqual({
            projectId: undefined,
            sectionId: undefined,
            areaId: undefined,
        });
    });


    it('always carries all three container keys', () => {
        for (const destination of [
            { kind: 'none' },
            { kind: 'project', id: 'project-1' },
            { kind: 'area', id: 'area-1' },
        ] satisfies TaskMoveDestination[]) {
            expect(Object.keys(buildTaskMovePatch(destination)).sort())
                .toEqual(['areaId', 'projectId', 'sectionId']);
        }
    });

    it('produces container fields the hierarchy rule leaves untouched', () => {
        for (const destination of [
            { kind: 'none' },
            { kind: 'project', id: 'project-1' },
            { kind: 'area', id: 'area-1' },
        ] satisfies TaskMoveDestination[]) {
            const patch = buildTaskMovePatch(destination, { projectId: 'project-1', sectionId: 'section-1' });
            expect(resolveTaskContainerHierarchy({ ...patch, sectionProjectId: patch.projectId })).toEqual(patch);
        }
    });
});

describe('resolveTaskContainerAssignment', () => {
    it('rejects a section that belongs to a different explicit project', () => {
        expect(resolveTaskContainerAssignment({
            projectId: 'project-2',
            sectionId: 'section-1',
            areaId: undefined,
            allProjects: [makeProject(), makeProject({ id: 'project-2', title: 'Project 2' })],
            allSections: [makeSection()],
            allAreas: [],
        })).toEqual({ ok: false, error: 'Section does not belong to project' });
    });

    it('rejects deleted container references', () => {
        expect(resolveTaskContainerAssignment({
            projectId: 'project-1',
            sectionId: undefined,
            areaId: undefined,
            allProjects: [makeProject({ deletedAt: now })],
            allSections: [],
            allAreas: [],
        })).toEqual({ ok: false, error: 'Project not found' });

        expect(resolveTaskContainerAssignment({
            projectId: undefined,
            sectionId: undefined,
            areaId: 'area-1',
            allProjects: [],
            allSections: [],
            allAreas: [makeArea({ deletedAt: now })],
        })).toEqual({ ok: false, error: 'Area not found' });
    });

    it('keeps archived sections unavailable to ordinary container assignment', () => {
        expect(resolveTaskContainerAssignment({
            projectId: 'project-1', sectionId: 'section-1', areaId: undefined,
            allProjects: [makeProject({ status: 'archived' })],
            allSections: [makeSection({ deletedAt: now, projectArchivedAt: now, updatedAt: now })],
            allAreas: [],
        })).toEqual({ ok: false, error: 'Section not found' });
    });

    it('asks section-reactivation permission only for a deleted matching candidate', () => {
        const permission = vi.fn(() => true);
        const result = resolveTaskContainerAssignment({
            projectId: 'project-1', sectionId: 'section-1', areaId: undefined,
            allProjects: [makeProject({ status: 'archived' })],
            allSections: [
                makeSection({ id: 'unrelated', deletedAt: now }),
                makeSection({ id: 'section-1', deletedAt: now }),
            ],
            allAreas: [], isReactivatingProjectSection: permission,
        });
        expect(result).toEqual({ ok: true, projectId: 'project-1', sectionId: 'section-1', areaId: undefined });
        expect(permission).toHaveBeenCalledTimes(1);
        expect(permission).toHaveBeenCalledWith(expect.objectContaining({ id: 'section-1' }));
    });
});

describe('buildTaskContainerMovePatch', () => {
    it('moves a task into a project, clears area scope, and reserves project order', () => {
        const result = buildTaskContainerMovePatch({
            task: makeTask({ areaId: 'area-1' }),
            updates: { projectId: 'project-1' },
            allProjects: [makeProject()],
            allSections: [],
            allAreas: [makeArea()],
            projectOrderReserver: () => 42,
        });

        expect(result).toEqual({
            ok: true,
            updates: {
                projectId: 'project-1',
                sectionId: undefined,
                areaId: undefined,
                order: 42,
                orderNum: 42,
            },
        });
    });

    it('infers the project when moving a task into a section', () => {
        const result = buildTaskContainerMovePatch({
            task: makeTask({ areaId: 'area-1' }),
            updates: { sectionId: 'section-1' },
            allProjects: [makeProject()],
            allSections: [makeSection()],
            allAreas: [makeArea()],
            projectOrderReserver: () => 12,
        });

        expect(result).toEqual({
            ok: true,
            updates: {
                projectId: 'project-1',
                sectionId: 'section-1',
                areaId: undefined,
                order: 12,
                orderNum: 12,
            },
        });
    });

    it('clears section and project order when moving a task out of a project', () => {
        const result = buildTaskContainerMovePatch({
            task: makeTask({ projectId: 'project-1', sectionId: 'section-1', order: 7, orderNum: 7 }),
            updates: { projectId: undefined },
            allProjects: [makeProject()],
            allSections: [makeSection()],
            allAreas: [makeArea()],
        });

        expect(result).toEqual({
            ok: true,
            updates: {
                projectId: undefined,
                sectionId: undefined,
                areaId: undefined,
                order: undefined,
                orderNum: undefined,
            },
        });
    });
});
