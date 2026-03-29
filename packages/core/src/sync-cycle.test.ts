import { describe, expect, it } from 'vitest';

import { performSyncCycle } from './sync';
import { createMockArea, createMockProject, createMockSection, createMockTask, mockAppData } from './sync-test-utils';
import type { AppData, Project, Section, Task } from './types';

describe('performSyncCycle', () => {
    it('returns conflict status when merge finds conflicts', async () => {
        const local = mockAppData([{
            ...createMockTask('1', '2023-01-02'),
            title: 'Local title',
        }]);
        const incoming = mockAppData([{
            ...createMockTask('1', '2023-01-01'),
            title: 'Incoming title',
        }]);

        const result = await performSyncCycle({
            readLocal: async () => local,
            readRemote: async () => incoming,
            writeLocal: async () => undefined,
            writeRemote: async () => undefined,
        });

        expect(result.status).toBe('conflict');
        expect(result.stats.tasks.conflicts).toBe(1);
    });

    it('returns success when only order-field shape differs', async () => {
        const now = '2026-03-01T00:00:00.000Z';
        const localTask = {
            ...createMockTask('task-1', now),
            order: 13,
            orderNum: 13,
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
        delete (incomingProject as Record<string, unknown>).order;

        const localSection = {
            ...createMockSection('section-1', 'project-1', now),
            order: 0,
        } satisfies Section;
        const incomingSection = {
            ...createMockSection('section-1', 'project-1', now),
        } as unknown as Section;
        delete (incomingSection as Record<string, unknown>).order;

        const result = await performSyncCycle({
            readLocal: async () => mockAppData([localTask], [localProject], [localSection]),
            readRemote: async () => mockAppData([incomingTask], [incomingProject], [incomingSection]),
            writeLocal: async () => undefined,
            writeRemote: async () => undefined,
        });

        expect(result.status).toBe('success');
        expect(result.stats.tasks.conflicts).toBe(0);
        expect(result.stats.projects.conflicts).toBe(0);
        expect(result.stats.sections.conflicts).toBe(0);
    });

    it('returns success when only revision number differs', async () => {
        const now = '2026-03-28T00:00:00.000Z';
        const result = await performSyncCycle({
            readLocal: async () => mockAppData([{
                ...createMockTask('task-1', now),
                rev: 9,
                revBy: 'device-local',
            }]),
            readRemote: async () => mockAppData([{
                ...createMockTask('task-1', now),
                rev: 4,
                revBy: 'device-remote',
            }]),
            writeLocal: async () => undefined,
            writeRemote: async () => undefined,
        });

        expect(result.status).toBe('success');
        expect(result.data.tasks).toHaveLength(1);
        expect(result.data.tasks[0].rev).toBe(9);
        expect(result.data.tasks[0].revBy).toBe('device-local');
        expect(result.stats.tasks.conflicts).toBe(0);
    });

    it('returns success when local defaults differ from omitted legacy fields', async () => {
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

        const result = await performSyncCycle({
            readLocal: async () => mockAppData([localTask], [localProject], [localSection]),
            readRemote: async () => mockAppData([incomingTask], [incomingProject], [incomingSection]),
            writeLocal: async () => undefined,
            writeRemote: async () => undefined,
        });

        expect(result.status).toBe('success');
        expect(result.stats.tasks.conflicts).toBe(0);
        expect(result.stats.projects.conflicts).toBe(0);
        expect(result.stats.sections.conflicts).toBe(0);
    });

    it('fails before writes when merged data is invalid', async () => {
        let wroteLocal = false;
        let wroteRemote = false;
        const invalidIncoming: AppData = {
            tasks: [],
            projects: [
                {
                    // Missing id on purpose to simulate corrupted remote payload.
                    title: 'Broken',
                    status: 'active',
                    color: '#000000',
                    order: 0,
                    tagIds: [],
                    createdAt: '2024-01-01T00:00:00.000Z',
                    updatedAt: '2024-01-01T00:00:00.000Z',
                } as unknown as Project,
            ],
            sections: [],
            areas: [],
            settings: {},
        };

        await expect(performSyncCycle({
            readLocal: async () => mockAppData(),
            readRemote: async () => invalidIncoming,
            writeLocal: async () => {
                wroteLocal = true;
            },
            writeRemote: async () => {
                wroteRemote = true;
            },
        })).rejects.toThrow('Sync validation failed');
        expect(wroteLocal).toBe(false);
        expect(wroteRemote).toBe(false);
    });

    it('fails before merge when remote payload shape is invalid', async () => {
        let wroteLocal = false;
        let wroteRemote = false;

        await expect(performSyncCycle({
            readLocal: async () => mockAppData(),
            readRemote: async () => ({
                tasks: 'not-an-array',
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            } as unknown as AppData),
            writeLocal: async () => {
                wroteLocal = true;
            },
            writeRemote: async () => {
                wroteRemote = true;
            },
        })).rejects.toThrow('Invalid remote sync payload');
        expect(wroteLocal).toBe(false);
        expect(wroteRemote).toBe(false);
    });

    it('drops empty task revBy values from incoming payloads', async () => {
        let saved: AppData | null = null;
        const incoming = mockAppData([
            {
                ...createMockTask('legacy-task', '2024-01-01T00:00:00.000Z'),
                rev: 2,
                revBy: '',
            },
        ]);

        await performSyncCycle({
            readLocal: async () => mockAppData(),
            readRemote: async () => incoming,
            writeLocal: async (data) => {
                saved = data;
            },
            writeRemote: async () => undefined,
        });

        expect(saved).not.toBeNull();
        expect(saved!.tasks).toHaveLength(1);
        expect(saved!.tasks[0].rev).toBe(2);
        expect(saved!.tasks[0].revBy).toBeUndefined();
    });

    it('drops invalid revBy values from projects, sections, and areas', async () => {
        let saved: AppData | null = null;
        const localData: AppData = {
            tasks: [],
            projects: [
                {
                    ...createMockProject('project-local', '2024-01-01T00:00:00.000Z'),
                    revBy: '',
                },
            ],
            sections: [
                {
                    ...createMockSection('section-local', 'project-local', '2024-01-01T00:00:00.000Z'),
                    revBy: '   ',
                },
            ],
            areas: [
                {
                    ...createMockArea('area-local', '2024-01-01T00:00:00.000Z'),
                    revBy: '',
                },
            ],
            settings: {},
        };
        const incomingData: AppData = {
            tasks: [],
            projects: [
                {
                    ...createMockProject('project-incoming', '2024-01-01T00:00:00.000Z'),
                    revBy: '   ',
                },
            ],
            sections: [
                {
                    ...createMockSection('section-incoming', 'project-incoming', '2024-01-01T00:00:00.000Z'),
                    revBy: '',
                },
            ],
            areas: [
                {
                    ...createMockArea('area-incoming', '2024-01-01T00:00:00.000Z'),
                    revBy: '',
                },
            ],
            settings: {},
        };

        await performSyncCycle({
            readLocal: async () => localData,
            readRemote: async () => incomingData,
            writeLocal: async (data) => {
                saved = data;
            },
            writeRemote: async () => undefined,
        });

        expect(saved).not.toBeNull();
        expect(saved!.projects.every((project) => project.revBy === undefined)).toBe(true);
        expect(saved!.sections.every((section) => section.revBy === undefined)).toBe(true);
        expect(saved!.areas.every((area) => area.revBy === undefined)).toBe(true);
    });

    it('purges expired task tombstones and deleted attachment tombstones by default', async () => {
        let saved: AppData | null = null;
        const oldPurgedTask = {
            ...createMockTask('old-purged', '2025-06-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z'),
            purgedAt: '2025-06-01T00:00:00.000Z',
        } as Task;
        const oldDeletedTask = createMockTask('old-deleted', '2025-06-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z');
        const taskWithDeletedAttachment = {
            ...createMockTask('with-deleted-attachment', '2025-12-20T00:00:00.000Z'),
            attachments: [{
                id: 'att-old-deleted',
                kind: 'file',
                title: 'old.txt',
                uri: '/tmp/old.txt',
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
                deletedAt: '2025-01-01T00:00:00.000Z',
            }],
        } as Task;

        const base = mockAppData([oldPurgedTask, oldDeletedTask, taskWithDeletedAttachment]);
        base.settings = {
            attachments: {
                pendingRemoteDeletes: [
                    {
                        cloudKey: 'attachments/stale.bin',
                        attempts: 5,
                        lastErrorAt: '2025-01-01T00:00:00.000Z',
                    },
                    {
                        cloudKey: 'attachments/recent.bin',
                        attempts: 1,
                        lastErrorAt: '2025-12-20T00:00:00.000Z',
                    },
                ],
            },
        };

        await performSyncCycle({
            readLocal: async () => base,
            readRemote: async () => null,
            writeLocal: async (data) => {
                saved = data;
            },
            writeRemote: async () => undefined,
            now: () => '2026-01-01T00:00:00.000Z',
        });

        expect(saved).not.toBeNull();
        expect(saved!.tasks.some((task) => task.id === 'old-purged')).toBe(false);
        expect(saved!.tasks.some((task) => task.id === 'old-deleted')).toBe(true);
        const keptTask = saved!.tasks.find((task) => task.id === 'with-deleted-attachment');
        expect(keptTask).toBeTruthy();
        expect(keptTask!.attachments).toBeUndefined();
        expect(saved!.settings.attachments?.pendingRemoteDeletes?.map((entry) => entry.cloudKey)).toEqual([
            'attachments/recent.bin',
        ]);
    });

    it('drops expired remote tombstones before merge so live tasks are preserved', async () => {
        let saved: AppData | null = null;
        const localLiveTask = createMockTask('task-1', '2025-10-01T00:00:00.000Z');
        const remoteExpiredTombstone = {
            ...createMockTask('task-1', '2025-11-01T00:00:00.000Z', '2025-11-01T00:00:00.000Z'),
            purgedAt: '2025-11-01T00:00:00.000Z',
        } as Task;

        await performSyncCycle({
            readLocal: async () => mockAppData([localLiveTask]),
            readRemote: async () => mockAppData([remoteExpiredTombstone]),
            writeLocal: async (data) => {
                saved = data;
            },
            writeRemote: async () => undefined,
            now: () => '2026-03-15T00:00:00.000Z',
        });

        expect(saved).not.toBeNull();
        expect(saved!.tasks).toHaveLength(1);
        expect(saved!.tasks[0].id).toBe('task-1');
        expect(saved!.tasks[0].deletedAt).toBeUndefined();
    });

    it('respects custom tombstone retention window', async () => {
        let saved: AppData | null = null;
        const oldPurgedTask = {
            ...createMockTask('old-purged', '2025-06-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z'),
            purgedAt: '2025-06-01T00:00:00.000Z',
        } as Task;

        await performSyncCycle({
            readLocal: async () => mockAppData([oldPurgedTask]),
            readRemote: async () => null,
            writeLocal: async (data) => {
                saved = data;
            },
            writeRemote: async () => undefined,
            now: () => '2026-01-01T00:00:00.000Z',
            tombstoneRetentionDays: 220,
        });

        expect(saved).not.toBeNull();
        expect(saved!.tasks.some((task) => task.id === 'old-purged')).toBe(true);
    });

    it('keeps freshly purged tombstones so deletion can sync', async () => {
        let saved: AppData | null = null;
        const freshPurgedTask = {
            ...createMockTask('fresh-purged', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            purgedAt: '2026-01-01T00:00:00.000Z',
        } as Task;

        await performSyncCycle({
            readLocal: async () => mockAppData([freshPurgedTask]),
            readRemote: async () => null,
            writeLocal: async (data) => {
                saved = data;
            },
            writeRemote: async () => undefined,
            now: () => '2026-01-02T00:00:00.000Z',
        });

        expect(saved).not.toBeNull();
        expect(saved!.tasks.some((task) => task.id === 'fresh-purged')).toBe(true);
    });

    it('writes local before remote and surfaces remote failures', async () => {
        let wroteLocal = false;
        let wroteRemote = false;

        await expect(performSyncCycle({
            readLocal: async () => mockAppData([createMockTask('1', '2024-01-01T00:00:00.000Z')]),
            readRemote: async () => mockAppData(),
            writeLocal: async () => {
                wroteLocal = true;
            },
            writeRemote: async () => {
                wroteRemote = true;
                throw new Error('remote write failed');
            },
        })).rejects.toThrow('remote write failed');

        expect(wroteRemote).toBe(true);
        expect(wroteLocal).toBe(true);
    });

    it('does not write remote when local write fails', async () => {
        let wroteRemote = false;
        await expect(performSyncCycle({
            readLocal: async () => mockAppData([createMockTask('1', '2024-01-01T00:00:00.000Z')]),
            readRemote: async () => mockAppData(),
            writeLocal: async () => {
                throw new Error('local write failed');
            },
            writeRemote: async () => {
                wroteRemote = true;
            },
        })).rejects.toThrow('local write failed');
        expect(wroteRemote).toBe(false);
    });

    it('persists pending remote write state until remote write succeeds', async () => {
        const localWrites: AppData[] = [];
        let remoteWriteData: AppData | null = null;

        const result = await performSyncCycle({
            readLocal: async () => mockAppData([createMockTask('1', '2024-01-01T00:00:00.000Z')]),
            readRemote: async () => mockAppData(),
            writeLocal: async (data) => {
                localWrites.push(data);
            },
            writeRemote: async (data) => {
                remoteWriteData = data;
            },
            now: () => '2026-01-01T00:00:00.000Z',
        });

        expect(localWrites).toHaveLength(2);
        expect(localWrites[0].settings.pendingRemoteWriteAt).toBe('2026-01-01T00:00:00.000Z');
        expect(remoteWriteData?.settings.pendingRemoteWriteAt).toBeUndefined();
        expect(localWrites[1].settings.pendingRemoteWriteAt).toBeUndefined();
        expect(result.data.settings.pendingRemoteWriteAt).toBeUndefined();
    });

    it('retries pending remote write before reading remote data', async () => {
        const sequence: string[] = [];
        const localWithPending = mockAppData([createMockTask('1', '2024-01-01T00:00:00.000Z')]);
        localWithPending.settings.pendingRemoteWriteAt = '2025-12-31T23:59:59.000Z';

        await performSyncCycle({
            readLocal: async () => {
                sequence.push('read-local');
                return localWithPending;
            },
            readRemote: async () => {
                sequence.push('read-remote');
                return mockAppData();
            },
            writeLocal: async (data) => {
                sequence.push(`write-local:${data.settings.pendingRemoteWriteAt ? 'pending' : 'clear'}`);
            },
            writeRemote: async (data) => {
                sequence.push(`write-remote:${data.settings.pendingRemoteWriteAt ? 'pending' : 'clear'}`);
            },
            now: () => '2026-01-01T00:00:00.000Z',
        });

        const retryWriteIndex = sequence.indexOf('write-remote:clear');
        const clearMarkerIndex = sequence.indexOf('write-local:clear');
        const readRemoteIndex = sequence.indexOf('read-remote');
        expect(retryWriteIndex).toBeGreaterThan(-1);
        expect(clearMarkerIndex).toBeGreaterThan(retryWriteIndex);
        expect(readRemoteIndex).toBeGreaterThan(clearMarkerIndex);
    });

    it('reports orchestration steps in order', async () => {
        const steps: string[] = [];
        await performSyncCycle({
            readLocal: async () => mockAppData([createMockTask('1', '2024-01-01T00:00:00.000Z')]),
            readRemote: async () => mockAppData(),
            writeLocal: async () => undefined,
            writeRemote: async () => undefined,
            onStep: (step) => {
                steps.push(step);
            },
        });
        expect(steps).toEqual([
            'read-local',
            'read-remote',
            'merge',
            'write-local',
            'write-remote',
        ]);
    });
});
