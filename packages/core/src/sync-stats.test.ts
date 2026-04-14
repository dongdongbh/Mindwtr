import { describe, it, expect } from 'vitest';
import { appendSyncHistory, filterDeleted, mergeAppDataWithStats } from './sync';
import { createMockProject, createMockSection, createMockTask, mockAppData } from './sync-test-utils';
import { AppData, Project, Section, Task } from './types';

describe('Sync Logic', () => {
    describe('mergeAppDataWithStats', () => {
        it('should report conflicts and resolution counts', () => {
            const local = mockAppData([
                {
                    ...createMockTask('1', '2023-01-02'),
                    title: 'Local title',
                },
                createMockTask('2', '2023-01-01'),
            ]);
            const incoming = mockAppData([
                {
                    ...createMockTask('1', '2023-01-01'),
                    title: 'Incoming title',
                },
                createMockTask('3', '2023-01-01'),
            ]);

            const result = mergeAppDataWithStats(local, incoming);

            expect(result.data.tasks).toHaveLength(3);
            expect(result.stats.tasks.localOnly).toBe(1);
            expect(result.stats.tasks.incomingOnly).toBe(1);
            expect(result.stats.tasks.conflicts).toBe(1);
            expect(result.stats.tasks.resolvedUsingLocal).toBeGreaterThan(0);
        });

        it('captures conflict diagnostics for content and revision drift', () => {
            const now = '2026-03-16T00:00:00.000Z';
            const local = mockAppData([
                {
                    ...createMockTask('content-conflict', now),
                    title: 'Local title',
                },
                {
                    ...createMockTask('revision-conflict', now),
                    rev: 2,
                    revBy: 'device-local',
                    title: 'Local title',
                },
            ]);
            const incoming = mockAppData([
                {
                    ...createMockTask('content-conflict', now),
                    title: 'Incoming title',
                },
                {
                    ...createMockTask('revision-conflict', now),
                    rev: 1,
                    revBy: 'device-remote',
                    title: 'Incoming title',
                },
            ]);

            const result = mergeAppDataWithStats(local, incoming);
            const contentSample = result.stats.tasks.conflictSamples?.find((sample) => sample.id === 'content-conflict');
            const revisionSample = result.stats.tasks.conflictSamples?.find((sample) => sample.id === 'revision-conflict');

            expect(result.stats.tasks.conflictReasonCounts).toEqual({
                content: 1,
                revision: 1,
            });
            expect(contentSample).toMatchObject({
                reasons: ['content'],
                winner: 'local',
                diffKeys: ['title'],
            });
            expect(revisionSample).toMatchObject({
                reasons: ['revision'],
                winner: 'local',
                diffKeys: [],
            });
            expect(revisionSample?.localComparableHash).not.toBe(revisionSample?.incomingComparableHash);
        });

        it('does not count conflict when only timestamp differs for legacy items', () => {
            const local = mockAppData([createMockTask('1', '2026-02-22T22:30:40.000Z')]);
            const incoming = mockAppData([createMockTask('1', '2026-02-22T22:30:11.000Z')]);

            const result = mergeAppDataWithStats(local, incoming);

            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.tasks.maxClockSkewMs).toBe(29000);
            expect(result.data.tasks[0].updatedAt).toBe('2026-02-22T22:30:40.000Z');
        });

        it('does not count conflicts for legacy order-field shape differences', () => {
            const now = '2026-02-22T22:30:40.000Z';
            const localTask = {
                ...createMockTask('task-1', now),
                order: 7,
                orderNum: 7,
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('task-1', now),
            } satisfies Task;
            const localProject = {
                ...createMockProject('project-1', now),
                order: 0,
            } satisfies Project;
            const incomingProject = {
                ...createMockProject('project-1', now),
            } as unknown as Project;
            const localSection = {
                ...createMockSection('section-1', 'project-1', now),
                order: 0,
            } satisfies Section;
            const incomingSection = {
                ...createMockSection('section-1', 'project-1', now),
            } as unknown as Section;
            delete (incomingProject as Record<string, unknown>).order;
            delete (incomingSection as Record<string, unknown>).order;

            const result = mergeAppDataWithStats(
                mockAppData([localTask], [localProject], [localSection]),
                mockAppData([incomingTask], [incomingProject], [incomingSection])
            );

            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.projects.conflicts).toBe(0);
            expect(result.stats.sections.conflicts).toBe(0);
        });

        it('does not count conflicts for omitted legacy default fields', () => {
            const now = '2026-03-07T00:00:00.000Z';
            const localTask = {
                ...createMockTask('task-legacy', now),
                isFocusedToday: false,
                pushCount: 0,
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('task-legacy', now),
            } as unknown as Task;
            delete (incomingTask as Record<string, unknown>).status;
            delete (incomingTask as Record<string, unknown>).tags;
            delete (incomingTask as Record<string, unknown>).contexts;

            const localProject = {
                ...createMockProject('project-legacy', now),
                color: '#6B7280',
                isSequential: false,
                isFocused: false,
            } satisfies Project;
            const incomingProject = {
                ...createMockProject('project-legacy', now),
            } as unknown as Project;
            delete (incomingProject as Record<string, unknown>).status;
            delete (incomingProject as Record<string, unknown>).color;
            delete (incomingProject as Record<string, unknown>).tagIds;
            delete (incomingProject as Record<string, unknown>).isSequential;
            delete (incomingProject as Record<string, unknown>).isFocused;

            const localSection = {
                ...createMockSection('section-legacy', 'project-legacy', now),
                isCollapsed: false,
            } satisfies Section;
            const incomingSection = {
                ...createMockSection('section-legacy', 'project-legacy', now),
            } as unknown as Section;
            delete (incomingSection as Record<string, unknown>).isCollapsed;

            const result = mergeAppDataWithStats(
                mockAppData([localTask], [localProject], [localSection]),
                mockAppData([incomingTask], [incomingProject], [incomingSection])
            );

            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.projects.conflicts).toBe(0);
            expect(result.stats.sections.conflicts).toBe(0);
        });

        it('does not count conflicts when remote payload omits default task and project fields', () => {
            const now = '2026-03-13T00:00:00.000Z';
            const localTask = {
                ...createMockTask('task-1', now),
                isFocusedToday: false,
            } satisfies Task;
            const incomingTask = {
                id: 'task-1',
                title: 'Task task-1',
                status: 'inbox',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: now,
            } as unknown as Task;

            const localProject = {
                ...createMockProject('project-1', now),
                isSequential: false,
                isFocused: false,
            } satisfies Project;
            const incomingProject = {
                id: 'project-1',
                title: 'Project project-1',
                status: 'active',
                color: '#000000',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: now,
            } as unknown as Project;

            const result = mergeAppDataWithStats(
                mockAppData([localTask], [localProject]),
                mockAppData([incomingTask], [incomingProject])
            );

            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.projects.conflicts).toBe(0);
            expect(result.data.tasks[0]).toMatchObject({
                id: 'task-1',
                tags: [],
                contexts: [],
                isFocusedToday: false,
            });
            expect(result.data.projects[0]).toMatchObject({
                id: 'project-1',
                tagIds: [],
                isSequential: false,
                isFocused: false,
            });
        });
    });

    describe('appendSyncHistory', () => {
        it('drops invalid entries and respects limits', () => {
            const entry = {
                at: '2024-01-01T00:00:00.000Z',
                status: 'success',
                conflicts: 0,
                conflictIds: [],
                maxClockSkewMs: 0,
                timestampAdjustments: 0,
            } as const;
            const settings: AppData['settings'] = {
                lastSyncHistory: [
                    entry,
                    { invalid: true } as any,
                ],
            };

            const next = appendSyncHistory(settings, {
                ...entry,
                at: '2024-01-02T00:00:00.000Z',
            }, 2);

            expect(next).toHaveLength(2);
            expect(next[0].at).toBe('2024-01-02T00:00:00.000Z');
            expect(next[1].at).toBe('2024-01-01T00:00:00.000Z');
        });
    });

    describe('filterDeleted', () => {
        it('should filter out items with deletedAt set', () => {
            const tasks = [
                createMockTask('1', '2023-01-01'),
                createMockTask('2', '2023-01-01', '2023-01-01'),
            ];

            const filtered = filterDeleted(tasks);

            expect(filtered).toHaveLength(1);
            expect(filtered[0].id).toBe('1');
        });
    });
});
