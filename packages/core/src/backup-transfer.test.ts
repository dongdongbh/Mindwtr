import { describe, expect, it } from 'vitest';

import {
    assertBackupSourceFileSize,
    countActiveRecords,
    createBackupFileName,
    getBackupSourceFileDiagnostic,
    MAX_BACKUP_SOURCE_BYTES,
    prepareRestoredBackupDataForSync,
    serializeBackupData,
    validateBackupJson,
} from './backup-transfer';
import { mergeAppData } from './sync';
import { SYNC_BACKUP_RESTORE_REV_BY } from './sync-revision';
import { purgeExpiredTombstones } from './sync-tombstones';
import type { AppData } from './types';

const buildAppData = (): AppData => {
    const now = '2026-03-30T12:00:00.000Z';
    return {
        tasks: [
            {
                id: 'task-1',
                title: 'Task',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: now,
                updatedAt: now,
            },
        ],
        projects: [
            {
                id: 'project-1',
                title: 'Project',
                status: 'active',
                color: '#94a3b8',
                order: 0,
                tagIds: [],
                createdAt: now,
                updatedAt: now,
            },
        ],
        sections: [],
        areas: [],
        people: [],
        settings: {},
    };
};

describe('backup transfer', () => {
    it('returns exact structured warning codes without removing legacy warning text', () => {
        const result = validateBackupJson(JSON.stringify({
            backupMetadata: { version: '2.0.0' },
            data: { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} },
        }), { appVersion: '1.0.0' });

        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(2);
        expect(result.diagnostics).toEqual([
            { code: 'backup-empty-active-records', params: {}, severity: 'warning' },
            { code: 'backup-newer-version', params: { version: '2.0.0' }, severity: 'warning' },
        ]);
    });

    it('exposes structured size diagnostics for unknown and oversized backup files', () => {
        for (const [size, code] of [
            [null, 'backup-source-size-unknown'],
            [MAX_BACKUP_SOURCE_BYTES + 1, 'backup-source-too-large'],
        ] as const) {
            let failure: unknown;
            try {
                assertBackupSourceFileSize(size);
            } catch (error) {
                failure = error;
            }
            expect(getBackupSourceFileDiagnostic(failure)).toMatchObject({ code, severity: 'error' });
        }
    });

    it('validates a serialized backup and derives metadata from the file name', () => {
        const data = buildAppData();
        const fileName = createBackupFileName(new Date('2026-03-30T12:34:56.789Z'));
        const result = validateBackupJson(serializeBackupData(data), { fileName });

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(data);
        expect(result.metadata?.taskCount).toBe(1);
        expect(result.metadata?.projectCount).toBe(1);
        expect(result.metadata?.backupAt).toBe('2026-03-30T12:34:56.789Z');
        expect(result.warnings).toEqual([]);
    });

    it('removes permanently deleted content from backup tombstones', () => {
        const purgedAt = '2026-03-31T12:00:00.000Z';
        const data = buildAppData();
        data.tasks.push({
            ...data.tasks[0],
            id: 'purged-task',
            title: 'Private task',
            description: 'Private task notes',
            tags: ['private-tag'],
            contexts: ['@private'],
            checklist: [{ id: 'private-item', title: 'Private checklist item', isCompleted: false }],
            location: 'Private location',
            attachments: [{
                id: 'private-task-file',
                kind: 'file',
                title: 'Private task file',
                uri: '/managed/private-task.pdf',
                createdAt: purgedAt,
                updatedAt: purgedAt,
            }],
            deletedAt: '2026-03-31T11:00:00.000Z',
            purgedAt,
            updatedAt: purgedAt,
            rev: 7,
            revBy: 'delete-device',
        });
        data.tasks.push({
            ...data.tasks[0],
            id: 'trashed-task',
            title: 'Recoverable task',
            deletedAt: '2026-03-31T11:00:00.000Z',
            updatedAt: '2026-03-31T11:00:00.000Z',
        });
        data.projects.push({
            ...data.projects[0],
            id: 'purged-project',
            title: 'Private project',
            supportNotes: 'Private project notes',
            areaTitle: 'Private area',
            attachments: [{
                id: 'private-project-file',
                kind: 'file',
                title: 'Private project file',
                uri: '/managed/private-project.pdf',
                createdAt: purgedAt,
                updatedAt: purgedAt,
            }],
            deletedAt: '2026-03-31T11:00:00.000Z',
            purgedAt,
            updatedAt: purgedAt,
            rev: 8,
            revBy: 'delete-device',
        });
        data.sections.push({
            id: 'purged-section',
            projectId: 'purged-project',
            title: 'Private section',
            description: 'Private section notes',
            order: 3,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: purgedAt,
            deletedAt: '2026-03-31T11:00:00.000Z',
            rev: 9,
            revBy: 'delete-device',
        });
        data.settings.attachments = {
            pendingRemoteDeletes: [{
                cloudKey: 'attachments/private.pdf',
                title: 'Private attachment',
                attempts: 2,
                lastErrorAt: purgedAt,
            }],
        };

        const restoredAt = '2026-04-01T00:00:00.000Z';
        const serialized = serializeBackupData(data);
        const parsed = JSON.parse(serialized) as AppData;

        expect(parsed.tasks.find((task) => task.id === 'purged-task')).toEqual({
            id: 'purged-task',
            title: '(deleted)',
            status: 'inbox',
            tags: [],
            contexts: [],
            rev: 7,
            revBy: 'delete-device',
            createdAt: purgedAt,
            updatedAt: purgedAt,
            deletedAt: purgedAt,
            purgedAt,
        });
        expect(parsed.projects.find((project) => project.id === 'purged-project')).toEqual({
            id: 'purged-project',
            title: '(deleted)',
            status: 'active',
            color: '#6B7280',
            order: 0,
            tagIds: [],
            rev: 8,
            revBy: 'delete-device',
            createdAt: purgedAt,
            updatedAt: purgedAt,
            deletedAt: purgedAt,
            purgedAt,
        });
        expect(parsed.sections.find((section) => section.id === 'purged-section')).toEqual({
            id: 'purged-section',
            projectId: 'purged-project',
            title: '',
            order: 0,
            rev: 9,
            revBy: 'delete-device',
            createdAt: purgedAt,
            updatedAt: purgedAt,
            deletedAt: purgedAt,
        });
        expect(parsed.settings.attachments?.pendingRemoteDeletes).toEqual([{
            cloudKey: 'attachments/private.pdf',
            attempts: 2,
            lastErrorAt: purgedAt,
        }]);
        expect(parsed.tasks.find((task) => task.id === 'trashed-task')?.title).toBe('Recoverable task');
        expect(serialized).not.toContain('Private');
        const validation = validateBackupJson(serialized);
        expect(validation.valid).toBe(true);
        const restoredLegacy = prepareRestoredBackupDataForSync(data, { previousData: data, restoredAt });
        expect(restoredLegacy.sections.find((section) => section.id === 'purged-section')).toMatchObject({
            title: '',
            deletedAt: restoredAt,
        });
        expect(restoredLegacy.sections.find((section) => section.id === 'purged-section')?.description).toBeUndefined();

        const staleRemote: AppData = {
            ...buildAppData(),
            tasks: [{
                ...data.tasks.find((task) => task.id === 'purged-task')!,
                deletedAt: undefined,
                purgedAt: undefined,
                rev: 20,
                revBy: 'stale-device',
            }],
            projects: [{
                ...data.projects.find((project) => project.id === 'purged-project')!,
                deletedAt: undefined,
                purgedAt: undefined,
                rev: 20,
                revBy: 'stale-device',
            }],
            sections: [{
                ...data.sections[0],
                deletedAt: undefined,
                rev: 20,
                revBy: 'stale-device',
            }],
        };
        const restored = prepareRestoredBackupDataForSync(validation.data!, {
            previousData: staleRemote,
            restoredAt,
        });
        expect(restored.tasks.find((task) => task.id === 'purged-task')?.attachments).toEqual([{
            id: 'private-task-file',
            kind: 'file',
            title: '',
            uri: '/managed/private-task.pdf',
            createdAt: purgedAt,
            updatedAt: purgedAt,
        }]);
        expect(restored.projects.find((project) => project.id === 'purged-project')?.attachments).toEqual([{
            id: 'private-project-file',
            kind: 'file',
            title: '',
            uri: '/managed/private-project.pdf',
            createdAt: purgedAt,
            updatedAt: purgedAt,
        }]);

        for (const merged of [
            mergeAppData(restored, staleRemote, { nowIso: restoredAt }),
            mergeAppData(staleRemote, restored, { nowIso: restoredAt }),
        ]) {
            expect(merged.tasks.find((task) => task.id === 'purged-task')).toMatchObject({
                title: '(deleted)',
                deletedAt: restoredAt,
                purgedAt: restoredAt,
            });
            expect(merged.projects.find((project) => project.id === 'purged-project')).toMatchObject({
                title: '(deleted)',
                deletedAt: restoredAt,
                purgedAt: restoredAt,
            });
            expect(merged.sections.find((section) => section.id === 'purged-section')).toMatchObject({
                title: '',
                deletedAt: restoredAt,
            });
        }
    });

    it('rejects non-Mindwtr JSON payloads', () => {
        const result = validateBackupJson(JSON.stringify({
            tasks: {},
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        }), {
            fileName: 'package.json',
        });

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('tasks');
    });

    it('marks restored live backup records as fresh local sync operations', () => {
        const data = buildAppData();
        const restoredAt = '2026-04-01T00:00:10.000Z';
        data.areas = [{
            id: 'area-1',
            name: 'Area',
            order: 0,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        data.people = [{
            id: 'person-1',
            name: 'Alex',
            note: 'Design lead',
            referenceLink: 'https://example.com/alex',
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        data.projects[0] = {
            ...data.projects[0],
            areaId: 'area-1',
            rev: 4,
            revBy: 'old-device',
        };
        data.sections = [{
            id: 'section-1',
            projectId: 'project-1',
            title: 'Section',
            description: '',
            order: 0,
            isCollapsed: false,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        data.tasks[0] = {
            ...data.tasks[0],
            areaId: 'area-1',
            projectId: 'project-1',
            sectionId: 'section-1',
            rev: 4,
            revBy: 'old-device',
        };
        data.tasks.push({
            ...data.tasks[0],
            id: 'deleted-task',
            title: 'Deleted task',
            deletedAt: '2026-03-31T00:00:00.000Z',
            updatedAt: '2026-03-31T00:00:00.000Z',
            rev: 8,
            revBy: 'delete-device',
        });

        const restored = prepareRestoredBackupDataForSync(data, { restoredAt });

        expect(restored.tasks.find((task) => task.id === 'task-1')).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.projects[0]).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.sections[0]).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.areas[0]).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.people?.[0]).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.tasks.find((task) => task.id === 'deleted-task')).toMatchObject({
            updatedAt: restoredAt,
            rev: 9,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
            deletedAt: restoredAt,
        });
        expect(restored.settings).toMatchObject({
            pendingRemoteWriteAt: restoredAt,
            pendingRemoteWriteRetryAt: undefined,
            pendingRemoteWriteAttempts: undefined,
        });
    });

    it('does not restore device-local mobile app lock state', () => {
        const data = buildAppData();
        const restoredAt = '2026-04-01T00:00:10.000Z';
        data.settings = {
            diagnostics: { loggingEnabled: true },
            security: { mobileAppLockEnabled: true },
        };

        const restored = prepareRestoredBackupDataForSync(data, { restoredAt });

        expect(restored.settings.security).toBeUndefined();
        expect(restored.settings.diagnostics).toEqual({ loggingEnabled: true });
        expect(restored.settings.pendingRemoteWriteAt).toBe(restoredAt);
    });

    it('stamps backup rows above current same-id revisions, including deletions', () => {
        const restoredAt = '2026-04-01T00:00:10.000Z';
        const backup = buildAppData();
        backup.tasks = [
            { ...backup.tasks[0], title: 'Backup wins', rev: 2, revBy: 'backup-device' },
            {
                ...backup.tasks[0],
                id: 'deleted-task',
                title: 'Deleted in backup',
                deletedAt: '2026-03-30T13:00:00.000Z',
                rev: 3,
                revBy: 'backup-device',
            },
        ];
        const previousData = buildAppData();
        previousData.tasks = [
            { ...previousData.tasks[0], title: 'Newer current row', rev: 10, revBy: 'current-device' },
            {
                ...previousData.tasks[0],
                id: 'deleted-task',
                title: 'Current live row',
                rev: 12,
                revBy: 'current-device',
            },
        ];

        const restored = prepareRestoredBackupDataForSync(backup, { previousData, restoredAt });

        expect(restored.tasks.find((task) => task.id === 'task-1')).toMatchObject({
            title: 'Backup wins',
            rev: 11,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
            updatedAt: restoredAt,
        });
        expect(restored.tasks.find((task) => task.id === 'deleted-task')).toMatchObject({
            title: 'Deleted in backup',
            deletedAt: restoredAt,
            rev: 13,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
            updatedAt: restoredAt,
        });

        const forward = mergeAppData(restored, previousData);
        const reverse = mergeAppData(previousData, restored);
        const forwardLive = forward.tasks.find((task) => task.id === 'task-1');
        const reverseLive = reverse.tasks.find((task) => task.id === 'task-1');
        const forwardDeleted = forward.tasks.find((task) => task.id === 'deleted-task');
        const reverseDeleted = reverse.tasks.find((task) => task.id === 'deleted-task');
        expect(forwardLive).toEqual(reverseLive);
        expect(forwardLive).toMatchObject({
            title: 'Backup wins',
            rev: 11,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
            updatedAt: restoredAt,
        });
        expect(forwardDeleted).toEqual(reverseDeleted);
        expect(forwardDeleted).toMatchObject({
            title: 'Deleted in backup',
            deletedAt: restoredAt,
            rev: 13,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
            updatedAt: restoredAt,
        });
    });

    it.each(['tasks', 'projects'] as const)(
        'makes restored %s attachment children authoritative and convergent',
        (collection) => {
            const restoredAt = '2026-04-01T00:00:10.000Z';
            const backup = buildAppData();
            const previousData = buildAppData();
            const backupParent = backup[collection][0];
            const previousParent = previousData[collection][0];
            const restoredAttachment = {
                id: 'attachment-restored',
                kind: 'file' as const,
                title: 'Restored file',
                uri: 'attachments/restored.txt',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            };
            const absentFromBackupAttachment = {
                id: 'attachment-absent',
                kind: 'file' as const,
                title: 'Created after backup',
                uri: 'attachments/absent.txt',
                createdAt: '2026-03-20T00:00:00.000Z',
                updatedAt: '2026-03-31T00:00:00.000Z',
            };
            backupParent.attachments = [restoredAttachment];
            previousParent.attachments = [
                {
                    ...restoredAttachment,
                    uri: '',
                    updatedAt: '2026-03-31T00:00:00.000Z',
                    deletedAt: '2026-03-31T00:00:00.000Z',
                },
                absentFromBackupAttachment,
            ];

            const restored = prepareRestoredBackupDataForSync(backup, { previousData, restoredAt });
            const restoredParent = restored[collection][0];
            expect(restoredParent.attachments).toEqual([
                expect.objectContaining({
                    id: 'attachment-restored',
                    updatedAt: restoredAt,
                }),
                expect.objectContaining({
                    id: 'attachment-absent',
                    updatedAt: restoredAt,
                    deletedAt: restoredAt,
                }),
            ]);
            expect(restoredParent.attachments?.[0].deletedAt).toBeUndefined();

            const forward = mergeAppData(restored, previousData);
            const reverse = mergeAppData(previousData, restored);
            expect(forward[collection][0]).toEqual(reverse[collection][0]);
            expect(forward[collection][0].attachments).toEqual([
                expect.objectContaining({ id: 'attachment-restored', updatedAt: restoredAt }),
                expect.objectContaining({
                    id: 'attachment-absent',
                    updatedAt: restoredAt,
                    deletedAt: restoredAt,
                }),
            ]);
            expect(forward[collection][0].attachments?.[0].deletedAt).toBeUndefined();
            expect(mergeAppData(forward, previousData)[collection][0]).toEqual(forward[collection][0]);
        },
    );

    it('refreshes expired backup and carried tombstones so restore cleanup retains them', () => {
        const restoredAt = '2026-04-01T00:00:10.000Z';
        const backup = buildAppData();
        backup.tasks.push({
            ...backup.tasks[0],
            id: 'backup-deleted-task',
            title: 'Deleted in old backup',
            deletedAt: '2025-01-01T00:00:00.000Z',
            rev: 3,
            revBy: 'backup-device',
        });
        const previousData = buildAppData();
        previousData.tasks.push({
            ...previousData.tasks[0],
            id: 'purged-task',
            title: 'Purged after backup',
            deletedAt: '2025-01-01T00:00:00.000Z',
            purgedAt: '2025-01-02T00:00:00.000Z',
            rev: 7,
            revBy: 'current-device',
        });

        const restored = prepareRestoredBackupDataForSync(backup, { previousData, restoredAt });
        const refreshed = purgeExpiredTombstones(restored, restoredAt, 90);

        expect(restored.tasks.find((task) => task.id === 'purged-task')).toMatchObject({
            deletedAt: restoredAt,
            purgedAt: restoredAt,
            rev: 8,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
            updatedAt: restoredAt,
        });
        expect(restored.tasks.find((task) => task.id === 'backup-deleted-task')).toMatchObject({
            deletedAt: restoredAt,
            rev: 4,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
            updatedAt: restoredAt,
        });
        expect(refreshed.removedTaskTombstones).toBe(0);
        expect(refreshed.data.tasks.find((task) => task.id === 'purged-task')).toMatchObject({
            deletedAt: restoredAt,
            purgedAt: restoredAt,
        });
        expect(refreshed.data.tasks.find((task) => task.id === 'backup-deleted-task')).toMatchObject({
            deletedAt: restoredAt,
        });
    });

    it('keeps recovered backup data live when remote sync still has stale cascade tombstones', () => {
        const deletedAt = '2026-04-01T00:00:05.000Z';
        const restoredAt = '2026-04-01T00:00:10.000Z';
        const backup = buildAppData();
        backup.areas = [{
            id: 'area-1',
            name: 'Area',
            order: 0,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        backup.people = [{
            id: 'person-1',
            name: 'Alex',
            note: 'Design lead',
            referenceLink: 'https://example.com/alex',
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        backup.projects[0] = {
            ...backup.projects[0],
            areaId: 'area-1',
            areaTitle: 'Area',
            rev: 4,
            revBy: 'old-device',
        };
        backup.sections = [{
            id: 'section-1',
            projectId: 'project-1',
            title: 'Section',
            description: '',
            order: 0,
            isCollapsed: false,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        backup.tasks[0] = {
            ...backup.tasks[0],
            areaId: 'area-1',
            projectId: 'project-1',
            sectionId: 'section-1',
            rev: 4,
            revBy: 'old-device',
        };
        const restored = prepareRestoredBackupDataForSync(backup, { restoredAt });
        const remote: AppData = {
            tasks: [{
                ...backup.tasks[0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            projects: [{
                ...backup.projects[0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            sections: [{
                ...backup.sections[0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            areas: [{
                ...backup.areas[0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            people: [{
                ...backup.people![0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            settings: {},
        };

        const forward = mergeAppData(restored, remote, { nowIso: restoredAt });
        const reverse = mergeAppData(remote, restored, { nowIso: restoredAt });

        for (const merged of [forward, reverse]) {
            expect(merged.tasks[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.projects[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.projects[0].deletedAt).toBeUndefined();
            expect(merged.sections[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.sections[0].deletedAt).toBeUndefined();
            expect(merged.areas[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.areas[0].deletedAt).toBeUndefined();
            expect(merged.people?.[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.people?.[0].deletedAt).toBeUndefined();
        }
    });

    it('does not let the remote hand back records the restored backup dropped (#939)', () => {
        // The reported flow: import a pile of tasks, delete them, then restore a
        // backup taken before the import. The backup has no trace of them, the
        // remote still does, and without carrying the deletion forward the next
        // merge reads that absence as "new over there" and restores them.
        const restoredAt = '2026-04-01T00:00:10.000Z';
        const backup = buildAppData();
        const previousData: AppData = {
            ...backup,
            tasks: [
                ...backup.tasks,
                {
                    ...backup.tasks[0],
                    id: 'imported-task',
                    title: 'Imported then deleted',
                    rev: 3,
                    revBy: 'other-device',
                },
            ],
        };
        const remote: AppData = {
            ...previousData,
            tasks: previousData.tasks.map((task) => ({ ...task, rev: 12, revBy: 'other-device' })),
            settings: {},
        };

        const restored = prepareRestoredBackupDataForSync(backup, { previousData, restoredAt });

        for (const merged of [
            mergeAppData(restored, remote, { nowIso: restoredAt }),
            mergeAppData(remote, restored, { nowIso: restoredAt }),
        ]) {
            const imported = merged.tasks.find((task) => task.id === 'imported-task');
            expect(imported?.deletedAt).toBe(restoredAt);
            expect(merged.tasks.filter((task) => !task.deletedAt).map((task) => task.id)).toEqual(['task-1']);
        }
    });

    it('leaves records the restoring device never saw alone (#939)', () => {
        // Absence from a backup only means "deleted" for ids this device knew
        // about. A task another device created while this one was offline is not
        // ours to tombstone.
        const restoredAt = '2026-04-01T00:00:10.000Z';
        const backup = buildAppData();
        const restored = prepareRestoredBackupDataForSync(backup, { previousData: backup, restoredAt });
        const remote: AppData = {
            ...backup,
            tasks: [
                ...backup.tasks,
                {
                    ...backup.tasks[0],
                    id: 'other-device-task',
                    title: 'Made elsewhere',
                    rev: 2,
                    revBy: 'other-device',
                },
            ],
            settings: {},
        };

        const merged = mergeAppData(restored, remote, { nowIso: restoredAt });

        expect(merged.tasks.find((task) => task.id === 'other-device-task')?.deletedAt).toBeUndefined();
    });

    it('sanitizes hostile attachment paths out of a restored backup (SEC-08)', () => {
        // A backup file is user-supplied bytes, and restore stamps fresh revisions so its
        // records win the next merge — a traversal uri/cloudKey smuggled in here would be
        // published to every device without ever passing the sync-merge sanitizer.
        const restoredAt = '2026-04-01T00:00:10.000Z';
        const backup = buildAppData();
        const hostile = {
            id: 'attachment-1',
            kind: 'file' as const,
            title: 'Report',
            uri: 'file:///safe/%252e%252e/secret.txt',
            cloudKey: '../attachments/secret.txt',
            fileHash: 'not-a-digest',
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
        };
        backup.tasks[0].attachments = [hostile];
        backup.projects[0].attachments = [hostile];

        const restored = prepareRestoredBackupDataForSync(backup, { restoredAt });

        for (const attachments of [restored.tasks[0].attachments, restored.projects[0].attachments]) {
            // Degraded to "missing locally", never dropped: the user's record survives.
            expect(attachments).toHaveLength(1);
            expect(attachments?.[0].id).toBe('attachment-1');
            expect(attachments?.[0].uri).toBe('');
            expect(attachments?.[0].cloudKey).toBeUndefined();
            expect(attachments?.[0].fileHash).toBeUndefined();
        }
    });

    describe('countActiveRecords', () => {
        // Pinned verbatim from desktop's and mobile's data-transfer.ts before this refactor —
        // both had this exact 4-field object and both silently omitted `people`. Per the "a test
        // that iterates the new thing can't catch it shrinking" gotcha, this compares against the
        // OLD predicate directly rather than re-deriving expectations from countActiveRecords
        // itself, so a regression that drops a field back out would fail this test.
        const oldFourFieldPredicate = (data: AppData) => ({
            tasks: data.tasks.filter((task) => !task.deletedAt).length,
            projects: data.projects.filter((project) => !project.deletedAt).length,
            sections: data.sections.filter((section) => !section.deletedAt).length,
            areas: data.areas.filter((area) => !area.deletedAt).length,
        });

        it('matches the old hand-written predicate on every field it had, plus counts people', () => {
            const now = '2026-03-30T12:00:00.000Z';
            const data: AppData = {
                ...buildAppData(),
                sections: [
                    { id: 'section-1', projectId: 'project-1', title: 'Live', order: 0, createdAt: now, updatedAt: now },
                    { id: 'section-2', projectId: 'project-1', title: 'Gone', order: 1, createdAt: now, updatedAt: now, deletedAt: now },
                ],
                areas: [
                    { id: 'area-1', name: 'Live area', color: '#000', order: 0, createdAt: now, updatedAt: now },
                    { id: 'area-2', name: 'Gone area', color: '#000', order: 1, createdAt: now, updatedAt: now, deletedAt: now },
                ],
                people: [
                    { id: 'person-1', name: 'Alex', createdAt: now, updatedAt: now },
                    { id: 'person-2', name: 'Departed', createdAt: now, updatedAt: now, deletedAt: now },
                ],
            };

            const result = countActiveRecords(data);

            expect(result).toMatchObject(oldFourFieldPredicate(data));
            expect(result.people).toBe(1);
        });

        it('treats a missing people array as zero, not a crash', () => {
            const data: AppData = { ...buildAppData(), people: undefined as unknown as AppData['people'] };
            expect(countActiveRecords(data).people).toBe(0);
        });
    });
});
