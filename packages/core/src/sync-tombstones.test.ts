import { describe, expect, it } from 'vitest';
import type { AppData } from './types';
import { purgeExpiredTombstones } from './sync-tombstones';

const nowIso = '2026-04-08T00:00:00.000Z';

describe('purgeExpiredTombstones', () => {
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

    it('keeps pending remote attachment deletes until a successful remote delete removes them', () => {
        const data: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                attachments: {
                    pendingRemoteDeletes: [
                        {
                            cloudKey: 'attachments/private/photo.jpg',
                            lastErrorAt: '2025-01-01T00:00:00.000Z',
                        },
                    ],
                },
            },
        };

        const result = purgeExpiredTombstones(data, nowIso);

        expect(result.removedPendingRemoteDeletes).toBe(0);
        expect(result.data.settings.attachments?.pendingRemoteDeletes).toEqual(data.settings.attachments?.pendingRemoteDeletes);
    });
});
