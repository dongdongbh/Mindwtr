import { describe, expect, it } from 'vitest';
import type { AppData, Area, Project, Section, Task } from './types';
import { isEntityTombstoneExpired, purgeExpiredTombstones } from './sync-tombstones';

const nowIso = '2026-04-08T00:00:00.000Z';

describe('isEntityTombstoneExpired', () => {
    const cutoffMs = Date.parse('2026-01-01T00:00:00.000Z');

    it('matches cleanup cutoff and malformed timestamp semantics for every entity kind', () => {
        expect(isEntityTombstoneExpired('task', { deletedAt: '2026-01-01T00:00:00.000Z' }, cutoffMs)).toBe(true);
        expect(isEntityTombstoneExpired('project', { deletedAt: '2025-01-01T00:00:00.000Z' }, cutoffMs)).toBe(true);
        expect(isEntityTombstoneExpired('section', { deletedAt: '2026-01-01T00:00:00.000Z' }, cutoffMs)).toBe(true);
        expect(isEntityTombstoneExpired('area', { deletedAt: '2026-01-01T00:00:00.000Z' }, cutoffMs)).toBe(true);
        expect(isEntityTombstoneExpired('person', { deletedAt: '2026-01-01T00:00:00.000Z' }, cutoffMs)).toBe(true);
        expect(isEntityTombstoneExpired('task', { purgedAt: '2025-01-01T00:00:00.000Z' }, cutoffMs)).toBe(false);
        expect(isEntityTombstoneExpired('task', { deletedAt: 'not-a-date' }, cutoffMs)).toBe(false);
    });

    it('prefers valid task and project purgedAt but falls back to deletedAt when it is invalid', () => {
        const oldDeleted = '2025-01-01T00:00:00.000Z';
        const recentPurge = '2026-02-01T00:00:00.000Z';
        expect(isEntityTombstoneExpired('task', { deletedAt: oldDeleted, purgedAt: recentPurge }, cutoffMs)).toBe(false);
        expect(isEntityTombstoneExpired('project', { deletedAt: oldDeleted, purgedAt: recentPurge }, cutoffMs)).toBe(false);
        expect(isEntityTombstoneExpired('task', { deletedAt: oldDeleted, purgedAt: 'not-a-date' }, cutoffMs)).toBe(true);
        expect(isEntityTombstoneExpired('project', { deletedAt: oldDeleted, purgedAt: '' }, cutoffMs)).toBe(true);
    });
});

describe('purgeExpiredTombstones', () => {
    it('retains sections and notes of completed and cancelled projects after ordinary deletion expiry', () => {
        const archivedAt = '2026-01-01T00:00:00.000Z';
        const projects: Project[] = [
            {
                id: 'completed', title: 'Completed project', status: 'archived', color: '#94a3b8',
                order: 0, tagIds: [], createdAt: archivedAt, updatedAt: archivedAt,
            },
            {
                id: 'cancelled', title: 'Cancelled project', status: 'archived', cancelledAt: archivedAt,
                color: '#94a3b8', order: 1, tagIds: [], createdAt: archivedAt, updatedAt: archivedAt,
            },
        ];
        const sections: Section[] = [
            {
                id: 'completed-section', projectId: 'completed', title: 'Completed plan',
                description: 'Notes to keep', order: 3, createdAt: archivedAt, updatedAt: archivedAt,
                deletedAt: archivedAt, projectArchivedAt: archivedAt,
            },
            {
                id: 'cancelled-section', projectId: 'cancelled', title: 'Cancelled plan',
                description: 'Preparation to keep', order: 5, createdAt: archivedAt, updatedAt: archivedAt,
                deletedAt: archivedAt, projectArchivedAt: archivedAt,
                deletedAtBeforeProjectArchive: null,
            },
        ];
        const data: AppData = { tasks: [], projects, sections, areas: [], settings: {} };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.removedSectionTombstones).toBe(0);
        expect(result.data.sections).toEqual(sections);
    });

    it('keeps archived sections while their deleted project is still restorable in Trash', () => {
        const archivedAt = '2026-01-01T00:00:00.000Z';
        const deletedAt = '2026-03-20T00:00:00.000Z';
        const project: Project = {
            id: 'project', title: 'Project', status: 'archived', color: '#94a3b8',
            order: 0, tagIds: [], createdAt: archivedAt, updatedAt: deletedAt, deletedAt,
        };
        const section: Section = {
            id: 'section', projectId: project.id, title: 'Plan', description: 'Notes',
            order: 2, createdAt: archivedAt, updatedAt: archivedAt,
            deletedAt: archivedAt, projectArchivedAt: archivedAt,
        };
        const data: AppData = { tasks: [], projects: [project], sections: [section], areas: [], settings: {} };

        const first = purgeExpiredTombstones(data, nowIso);
        const second = purgeExpiredTombstones(first.data, nowIso);

        expect(first.data.sections).toEqual([section]);
        expect(second.data.sections).toEqual([section]);
        expect(second.data.projects).toEqual([project]);
        expect(second.removedSectionTombstones).toBe(0);
        expect(second.removedProjectTombstones).toBe(0);
    });

    it.each([
        ['missing owner', [] as Project[], undefined],
        ['expired deleted owner', undefined, { deletedAt: '2026-01-01T00:00:00.000Z' }],
        ['purged owner', undefined, { deletedAt: '2026-03-20T00:00:00.000Z', purgedAt: '2026-03-20T00:00:00.000Z' }],
        ['active owner', undefined, { status: 'active' as const }],
    ])('expires an archived section with a %s', (_reason, projectOverride, fields) => {
        const archivedAt = '2026-01-01T00:00:00.000Z';
        const project: Project = {
            id: 'project', title: 'Project', status: 'archived', color: '#94a3b8',
            order: 0, tagIds: [], createdAt: archivedAt, updatedAt: archivedAt,
            ...fields,
        };
        const section: Section = {
            id: 'section', projectId: project.id, title: 'Plan', order: 0,
            createdAt: archivedAt, updatedAt: archivedAt,
            deletedAt: archivedAt, projectArchivedAt: archivedAt,
        };
        const data: AppData = {
            tasks: [], projects: projectOverride ?? [project], sections: [section], areas: [], settings: {},
        };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.data.sections).toEqual([]);
        expect(result.removedSectionTombstones).toBe(1);
    });

    it.each([
        ['independently deleted', { deletedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }],
        ['edited after archive', { updatedAt: '2026-01-02T00:00:00.000Z' }],
        ['deleted before archive', { deletedAtBeforeProjectArchive: '2025-12-31T00:00:00.000Z' }],
        ['mismatched project', { projectId: 'other-project' }],
        ['missing archive marker', { projectArchivedAt: undefined }],
    ])('expires a section %s even if an archived project survives', (_reason, fields) => {
        const archivedAt = '2026-01-01T00:00:00.000Z';
        const project: Project = {
            id: 'project', title: 'Project', status: 'archived', color: '#94a3b8',
            order: 0, tagIds: [], createdAt: archivedAt, updatedAt: archivedAt,
        };
        const section: Section = {
            id: 'section', projectId: project.id, title: 'Plan', order: 0,
            createdAt: archivedAt, updatedAt: archivedAt,
            deletedAt: archivedAt, projectArchivedAt: archivedAt,
            ...fields,
        };
        const data: AppData = { tasks: [], projects: [project], sections: [section], areas: [], settings: {} };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.data.sections).toEqual([]);
        expect(result.removedSectionTombstones).toBe(1);
    });

    it('purges expired task tombstones even when purgedAt is missing', () => {
        const data: AppData = {
            tasks: [
                {
                    id: 'task-old',
                    title: 'Old task tombstone',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    deletedAt: '2025-01-01T00:00:00.000Z',
                },
                {
                    id: 'task-recent',
                    title: 'Recent task tombstone',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                    deletedAt: '2026-03-20T00:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.removedTaskTombstones).toBe(1);
        expect(result.data.tasks.map((task) => task.id)).toEqual(['task-recent']);
    });

    it('purges expired project, section, and area tombstones', () => {
        const data: AppData = {
            tasks: [],
            projects: [
                {
                    id: 'project-old',
                    title: 'Old project tombstone',
                    status: 'active',
                    color: '#94a3b8',
                    order: 0,
                    tagIds: [],
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    deletedAt: '2025-01-01T00:00:00.000Z',
                },
                {
                    id: 'project-recent',
                    title: 'Recent project tombstone',
                    status: 'active',
                    color: '#94a3b8',
                    order: 1,
                    tagIds: [],
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                    deletedAt: '2026-03-20T00:00:00.000Z',
                },
            ],
            sections: [
                {
                    id: 'section-old',
                    projectId: 'project-old',
                    title: 'Old section tombstone',
                    order: 0,
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    deletedAt: '2025-01-01T00:00:00.000Z',
                },
                {
                    id: 'section-recent',
                    projectId: 'project-recent',
                    title: 'Recent section tombstone',
                    order: 1,
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                    deletedAt: '2026-03-20T00:00:00.000Z',
                },
            ],
            areas: [
                {
                    id: 'area-old',
                    name: 'Old area tombstone',
                    order: 0,
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    deletedAt: '2025-01-01T00:00:00.000Z',
                },
                {
                    id: 'area-recent',
                    name: 'Recent area tombstone',
                    order: 1,
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                    deletedAt: '2026-03-20T00:00:00.000Z',
                },
            ],
            settings: {},
        };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.removedProjectTombstones).toBe(1);
        expect(result.removedSectionTombstones).toBe(1);
        expect(result.removedAreaTombstones).toBe(1);
        expect(result.data.projects.map((project) => project.id)).toEqual(['project-recent']);
        expect(result.data.sections.map((section) => section.id)).toEqual(['section-recent']);
        expect(result.data.areas.map((area) => area.id)).toEqual(['area-recent']);
    });

    it('uses project purgedAt as the project tombstone retention timestamp', () => {
        const data: AppData = {
            tasks: [],
            projects: [
                {
                    id: 'project-purged-old',
                    title: 'Old purged project tombstone',
                    status: 'active',
                    color: '#6B7280',
                    order: 0,
                    tagIds: [],
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                    deletedAt: '2026-03-20T00:00:00.000Z',
                    purgedAt: '2025-01-01T00:00:00.000Z',
                },
                {
                    id: 'project-purged-recent',
                    title: 'Recent purged project tombstone',
                    status: 'active',
                    color: '#6B7280',
                    order: 1,
                    tagIds: [],
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                    deletedAt: '2025-01-01T00:00:00.000Z',
                    purgedAt: '2026-06-20T00:00:00.000Z',
                },
            ],
            sections: [],
            areas: [],
            settings: {},
        };

        const result = purgeExpiredTombstones(data, '2026-06-29T00:00:00.000Z');

        expect(result.removedProjectTombstones).toBe(1);
        expect(result.data.projects.map((project) => project.id)).toEqual(['project-purged-recent']);
    });

    it('purges expired person tombstones while keeping recent and active people', () => {
        const data: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [
                {
                    id: 'person-old',
                    name: 'Old person tombstone',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    deletedAt: '2025-01-01T00:00:00.000Z',
                },
                {
                    id: 'person-recent',
                    name: 'Recent person tombstone',
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                    deletedAt: '2026-03-20T00:00:00.000Z',
                },
                {
                    id: 'person-active',
                    name: 'Active person',
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                },
            ],
            settings: {},
        };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.removedPersonTombstones).toBe(1);
        expect(result.data.people?.map((person) => person.id)).toEqual(['person-recent', 'person-active']);
    });

    it('prunes expired pending remote attachment deletes while keeping recent failures', () => {
        const data: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                attachments: {
                    pendingRemoteDeletes: [
                        {
                            cloudKey: 'attachments/private/expired.jpg',
                            lastErrorAt: '2025-01-01T00:00:00.000Z',
                        },
                        {
                            cloudKey: 'attachments/private/recent.jpg',
                            lastErrorAt: '2026-04-01T00:00:00.000Z',
                        },
                    ],
                },
            },
        };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.removedPendingRemoteDeletes).toBe(1);
        expect(result.data.settings.attachments?.pendingRemoteDeletes).toEqual([
            {
                cloudKey: 'attachments/private/recent.jpg',
                lastErrorAt: '2026-04-01T00:00:00.000Z',
            },
        ]);
    });

    it('purges expired saved filter tombstones from settings', () => {
        const data: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                savedFilters: [
                    {
                        id: 'filter-old',
                        name: 'Old filter tombstone',
                        view: 'focus',
                        criteria: { tags: ['#old'] },
                        createdAt: '2025-01-01T00:00:00.000Z',
                        updatedAt: '2025-01-01T00:00:00.000Z',
                        deletedAt: '2025-01-01T00:00:00.000Z',
                    },
                    {
                        id: 'filter-recent',
                        name: 'Recent filter tombstone',
                        view: 'focus',
                        criteria: { tags: ['#recent'] },
                        createdAt: '2026-03-20T00:00:00.000Z',
                        updatedAt: '2026-03-20T00:00:00.000Z',
                        deletedAt: '2026-03-20T00:00:00.000Z',
                    },
                    {
                        id: 'filter-active',
                        name: 'Active filter',
                        view: 'focus',
                        criteria: { tags: ['#active'] },
                        createdAt: '2026-03-20T00:00:00.000Z',
                        updatedAt: '2026-03-20T00:00:00.000Z',
                    },
                ],
            },
        };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.removedSavedFilterTombstones).toBe(1);
        expect(result.data.settings.savedFilters?.map((filter) => filter.id)).toEqual(['filter-recent', 'filter-active']);
    });
});

describe('purgeExpiredTombstones keeps referenced parents', () => {
    const expired = '2025-01-01T00:00:00.000Z';
    const fresh = '2026-04-01T00:00:00.000Z';
    const area = (id: string, fields: Partial<Area> = {}): Area => ({
        id, name: id, order: 0, createdAt: expired, updatedAt: expired, ...fields,
    });
    const project = (id: string, fields: Partial<Project> = {}): Project => ({
        id, title: id, status: 'active', color: '#94a3b8', order: 0, tagIds: [],
        createdAt: expired, updatedAt: expired, ...fields,
    });
    const section = (id: string, projectId: string, fields: Partial<Section> = {}): Section => ({
        id, projectId, title: id, order: 0, createdAt: expired, updatedAt: expired, ...fields,
    });
    const task = (id: string, fields: Partial<Task> = {}): Task => ({
        id, title: id, status: 'next', tags: [], contexts: [], createdAt: expired, updatedAt: expired, ...fields,
    });
    const doc = (fields: Partial<AppData>): AppData => ({
        tasks: [], projects: [], sections: [], areas: [], people: [], settings: {}, ...fields,
    });

    it.each([
        ['project <- live task', doc({ projects: [project('p', { deletedAt: expired })], tasks: [task('t', { projectId: 'p' })] })],
        ['project <- fresh section tombstone', doc({
            projects: [project('p', { deletedAt: expired })], sections: [section('s', 'p', { deletedAt: fresh })],
        })],
        ['section <- fresh task tombstone', doc({
            projects: [project('p')], sections: [section('s', 'p', { deletedAt: expired })],
            tasks: [task('t', { projectId: 'p', sectionId: 's', deletedAt: fresh })],
        })],
        ['area <- live task', doc({ areas: [area('a', { deletedAt: expired })], tasks: [task('t', { areaId: 'a' })] })],
        ['area <- live project', doc({ areas: [area('a', { deletedAt: expired })], projects: [project('p', { areaId: 'a' })] })],
    ])('keeps an expired parent while a remaining entity references it: %s', (_label, data) => {
        const first = purgeExpiredTombstones(data, nowIso);
        const second = purgeExpiredTombstones(first.data, nowIso);

        expect(first.data).toEqual(data);
        expect(second.data).toEqual(first.data);
        expect([first.removedProjectTombstones, first.removedSectionTombstones, first.removedAreaTombstones])
            .toEqual([0, 0, 0]);
    });

    it('drops a parent chain in the pass where its last child expires', () => {

        const data = doc({
            areas: [area('a', { deletedAt: expired })],
            projects: [project('p', { areaId: 'a', deletedAt: expired })],
            sections: [section('s', 'p', { deletedAt: expired })],
            tasks: [task('t', { projectId: 'p', sectionId: 's', deletedAt: fresh })],
        });

        const beforeChildExpires = purgeExpiredTombstones(data, nowIso);
        expect(beforeChildExpires.data).toEqual(data);

        const afterChildExpires = purgeExpiredTombstones(beforeChildExpires.data, '2026-12-31T00:00:00.000Z');
        expect(afterChildExpires.data).toMatchObject({ tasks: [], sections: [], projects: [], areas: [] });
        expect([
            afterChildExpires.removedTaskTombstones,
            afterChildExpires.removedSectionTombstones,
            afterChildExpires.removedProjectTombstones,
            afterChildExpires.removedAreaTombstones,
        ]).toEqual([1, 1, 1, 1]);
    });
});
