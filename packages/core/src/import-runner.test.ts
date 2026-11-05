import { describe, expect, it } from 'vitest';

import {
    parseImportSource,
    runImport,
    summarizeBackupMerge,
    type DataTransferBoundaries,
    type ImportRunnerLog,
} from './import-runner';
import { SYNC_BACKUP_RESTORE_REV_BY } from './sync-revision';
import {
    createMockArea,
    createMockProject,
    createMockSection,
    createMockTask,
    mockAppData,
} from './sync-test-utils';
import type { ParsedTodoistProject } from './todoist-import';
import type { AppData } from './types';


const buildBoundaries = (currentData: AppData) => {
    const persisted: AppData[] = [];
    let refreshed = 0;
    const boundaries: DataTransferBoundaries = {
        flushPendingSave: async () => undefined,
        getCurrentChangeAt: () => 1,
        readCurrentData: async () => currentData,
        createRecoverySnapshot: async () => 'snapshot-1',
        persistData: async (data) => {
            persisted.push(data);
        },
        refreshData: async () => {
            refreshed += 1;
        },
    };
    return { boundaries, persisted, refreshedCount: () => refreshed };
};

const buildLog = () => {
    const infoCalls: { message: string; context?: { extra?: Record<string, unknown>; scope?: string } }[] = [];
    const errorCalls: { error: unknown; context: { extra?: Record<string, unknown>; scope: string } }[] = [];
    const log: ImportRunnerLog = {
        logInfo: (message, context) => {
            infoCalls.push({ message, context });
        },
        logError: (error, context) => {
            errorCalls.push({ error, context });
        },
    };
    return { log, infoCalls, errorCalls };
};

describe('runImport', () => {
    it('dispatches source parsing through the same descriptor as apply and count', () => {
        const result = parseImportSource('todoist', {
            fileName: 'Inbox.csv',
            text: 'TYPE,CONTENT\n task,Inbox task',
        });

        expect(result.valid).toBe(true);
        expect(result.preview).toMatchObject({
            fileName: 'Inbox.csv',
            taskCount: 1,
        });
        expect(result.diagnostics).toEqual([]);
    });

    it('returns stable diagnostic codes and parameters instead of requiring shells to render prose', () => {
        const result = parseImportSource('todoist', {
            fileName: 'Inbox.csv',
            text: 'TYPE,CONTENT,DATE,DATE_LANG\ntask,Repeat task,every day,en',
        });

        expect(result.diagnostics).toContainEqual({
            code: 'unsupported-recurrence',
            params: { count: 1 },
            severity: 'warning',
        });

        const invalid = parseImportSource('mindwtr-csv', {
            fileName: 'export.csv',
            text: 'Status\nnext',
        });
        expect(invalid.diagnostics).toContainEqual({
            code: 'missing-required-column',
            params: { column: 'Title' },
            severity: 'error',
        });
    });

    it('dispatches to the backup descriptor, persists, and logs start/complete', async () => {
        const restoredData = mockAppData();
        const { boundaries, persisted, refreshedCount } = buildBoundaries(mockAppData());
        const { log, infoCalls } = buildLog();

        const { result, snapshotName } = await runImport('backup', restoredData, boundaries, log);

        expect(result.tasks).toEqual(restoredData.tasks);
        expect(snapshotName).toBe('snapshot-1');
        expect(persisted).toHaveLength(1);
        expect(refreshedCount()).toBe(1);
        expect(infoCalls.map((call) => call.message)).toEqual(['Backup restore started', 'Backup restore complete']);
        expect(infoCalls[1]?.context?.extra).toMatchObject({ operation: 'restoreBackup', source: 'backup' });
    });

    it('dispatches to the todoist descriptor and logs countExtra from the real importer result', async () => {
        const { boundaries } = buildBoundaries(mockAppData());
        const { log, infoCalls } = buildLog();
        const parsed: ParsedTodoistProject[] = [];

        const { result } = await runImport('todoist', parsed, boundaries, log);

        expect(result.importedTaskCount).toBe(0);


        expect(infoCalls[1]?.context?.extra).toMatchObject({
            operation: 'importTodoist',
            tasks: '0',
            projects: '0',
            sections: '0',
            checklistItems: '0',
        });
    });


    const buildDivergedData = () => {
        const local = mockAppData([
            createMockTask('local-only', '2026-01-05T00:00:00.000Z'),
            createMockTask('shared', '2026-01-01T00:00:00.000Z'),
            createMockTask('newer-local', '2026-02-01T00:00:00.000Z'),
            createMockTask('deleted-locally', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z'),
        ]);
        const backup = mockAppData([
            { ...createMockTask('shared', '2026-01-20T00:00:00.000Z'), title: 'From backup' },
            { ...createMockTask('newer-local', '2026-01-01T00:00:00.000Z'), title: 'From backup' },
            createMockTask('deleted-locally', '2026-02-01T00:00:00.000Z'),
            createMockTask('backup-only', '2026-01-15T00:00:00.000Z'),
        ]);
        return { local, backup };
    };

    it('merges a backup additively instead of replacing local data', async () => {
        const { local, backup } = buildDivergedData();
        const { boundaries, persisted } = buildBoundaries(local);
        const { log, infoCalls } = buildLog();

        const { result } = await runImport('backup-merge', backup, boundaries, log);

        const byId = new Map(persisted[0].tasks.map((task) => [task.id, task]));
        expect(byId.get('local-only')).toBeDefined();
        expect(byId.get('backup-only')).toBeDefined();
        expect(byId.get('shared')?.title).toBe('From backup');
        expect(byId.get('newer-local')?.title).toBe('Task newer-local');


        expect(byId.get('deleted-locally')?.deletedAt).toBe('2026-01-10T00:00:00.000Z');


        expect(persisted[0].tasks.some((task) => task.revBy === SYNC_BACKUP_RESTORE_REV_BY)).toBe(false);
        expect(byId.get('local-only')?.updatedAt).toBe('2026-01-05T00:00:00.000Z');


        expect(result.stats.tasks.resolvedUsingIncoming).toBe(2);
        expect(summarizeBackupMerge(result)).toEqual({ added: 1, updated: 1 });
        expect(infoCalls.map((call) => call.message)).toEqual(['Backup merge started', 'Backup merge complete']);
        expect(infoCalls[1]?.context?.extra).toMatchObject({
            operation: 'mergeBackup',
            source: 'backup-merge',
            tasksAdded: '1',
            tasksUpdated: '1',
        });
    });

    it('keeps live local entities when a newer backup contains their tombstones', async () => {
        const localUpdatedAt = '2026-01-01T00:00:00.000Z';
        const deletedAt = '2026-02-01T00:00:00.000Z';
        const local = {
            ...mockAppData(
                [{ ...createMockTask('task', localUpdatedAt), rev: 1 }],
                [{ ...createMockProject('project', localUpdatedAt), rev: 1 }],
                [{ ...createMockSection('section', 'project', localUpdatedAt), rev: 1 }],
            ),
            areas: [{ ...createMockArea('area', localUpdatedAt), rev: 1 }],
        };
        const backup = {
            ...mockAppData(
                [{ ...createMockTask('task', deletedAt), purgedAt: deletedAt, rev: 2 }],
                [{ ...createMockProject('project', deletedAt, deletedAt), rev: 2 }],
                [{ ...createMockSection('section', 'project', deletedAt, deletedAt), rev: 2 }],
            ),
            areas: [{ ...createMockArea('area', deletedAt, deletedAt), rev: 2 }],
        };
        const { boundaries, persisted } = buildBoundaries(local);
        const { log } = buildLog();

        await runImport('backup-merge', backup, boundaries, log);

        expect({
            task: persisted[0].tasks[0]?.deletedAt,
            project: persisted[0].projects[0]?.deletedAt,
            section: persisted[0].sections[0]?.deletedAt,
            area: persisted[0].areas[0]?.deletedAt,
        }).toEqual({ task: undefined, project: undefined, section: undefined, area: undefined });
    });

    it('keeps live local attachments when a backup contains attachment tombstones', async () => {
        const localUpdatedAt = '2026-01-01T00:00:00.000Z';
        const deletedAt = '2026-02-01T00:00:00.000Z';
        const liveAttachment = {
            id: 'attachment',
            kind: 'file' as const,
            title: 'Local attachment',
            uri: 'file:///local/attachment.txt',
            createdAt: localUpdatedAt,
            updatedAt: localUpdatedAt,
        };
        const deletedAttachment = { ...liveAttachment, updatedAt: deletedAt, deletedAt };
        const locallyDeletedAttachment = {
            ...liveAttachment,
            id: 'deleted-locally',
            updatedAt: '2026-01-10T00:00:00.000Z',
            deletedAt: '2026-01-10T00:00:00.000Z',
        };
        const newerBackupAttachment = {
            ...liveAttachment,
            id: 'deleted-locally',
            title: 'Newer backup attachment',
            updatedAt: deletedAt,
        };
        const local = mockAppData(
            [{ ...createMockTask('task', localUpdatedAt), attachments: [liveAttachment, locallyDeletedAttachment], rev: 1 }],
            [{ ...createMockProject('project', localUpdatedAt), attachments: [liveAttachment, locallyDeletedAttachment], rev: 1 }],
        );
        const backup = mockAppData(
            [{ ...createMockTask('task', deletedAt), attachments: [deletedAttachment, newerBackupAttachment], rev: 2 }],
            [{ ...createMockProject('project', deletedAt), attachments: [deletedAttachment, newerBackupAttachment], rev: 2 }],
        );
        const { boundaries, persisted } = buildBoundaries(local);
        const { log } = buildLog();

        await runImport('backup-merge', backup, boundaries, log);

        const taskAttachments = new Map(persisted[0].tasks[0]?.attachments?.map((item) => [item.id, item]));
        const projectAttachments = new Map(persisted[0].projects[0]?.attachments?.map((item) => [item.id, item]));
        expect({
            task: taskAttachments.get('attachment')?.deletedAt,
            project: projectAttachments.get('attachment')?.deletedAt,
            locallyDeletedTask: taskAttachments.get('deleted-locally')?.deletedAt,
            locallyDeletedProject: projectAttachments.get('deleted-locally')?.deletedAt,
        }).toEqual({
            task: undefined,
            project: undefined,
            locallyDeletedTask: '2026-01-10T00:00:00.000Z',
            locallyDeletedProject: '2026-01-10T00:00:00.000Z',
        });
    });

    it('sanitizes hostile attachment paths out of an additively merged backup (SEC-08)', async () => {
        const now = '2026-01-01T00:00:00.000Z';
        const hostile = {
            id: 'attachment',
            kind: 'file' as const,
            title: 'Report',
            uri: 'file:///safe/%252e%252e/secret.txt',
            cloudKey: '../attachments/secret.txt',
            fileHash: 'not-a-digest',
            createdAt: now,
            updatedAt: now,
        };
        const local = mockAppData(
            [{ ...createMockTask('task', now), rev: 1 }],
            [{ ...createMockProject('project', now), rev: 1 }],
        );
        const backup = mockAppData(
            [{ ...createMockTask('task', now), attachments: [hostile], rev: 2 }],
            [{ ...createMockProject('project', now), attachments: [hostile], rev: 2 }],
        );
        const { boundaries, persisted } = buildBoundaries(local);
        const { log } = buildLog();

        await runImport('backup-merge', backup, boundaries, log);

        for (const attachments of [persisted[0].tasks[0]?.attachments, persisted[0].projects[0]?.attachments]) {
            expect(attachments).toHaveLength(1);
            expect(attachments?.[0].uri).toBe('');
            expect(attachments?.[0].cloudKey).toBeUndefined();
            expect(attachments?.[0].fileHash).toBeUndefined();
        }
    });

    it('keeps restore replacing local data and outranking local tombstones', async () => {
        const { local, backup } = buildDivergedData();
        const { boundaries, persisted } = buildBoundaries(local);
        const { log } = buildLog();

        await runImport('backup', backup, boundaries, log);

        const byId = new Map(persisted[0].tasks.map((task) => [task.id, task]));
        expect(byId.get('deleted-locally')?.deletedAt).toBeUndefined();
        expect(byId.get('newer-local')?.title).toBe('From backup');
        expect(byId.get('backup-only')?.revBy).toBe(SYNC_BACKUP_RESTORE_REV_BY);
    });

    it('logs and rethrows when the importer throws, without logging completion', async () => {
        const { boundaries } = buildBoundaries(mockAppData());
        const { log, infoCalls, errorCalls } = buildLog();
        const failingBoundaries: DataTransferBoundaries = {
            ...boundaries,
            readCurrentData: async () => {
                throw new Error('read failed');
            },
        };

        await expect(runImport('backup', mockAppData(), failingBoundaries, log)).rejects.toThrow(
            'read failed'
        );

        expect(infoCalls.map((call) => call.message)).toEqual(['Backup restore started']);
        expect(errorCalls).toHaveLength(1);
        expect(errorCalls[0]?.context).toMatchObject({ scope: 'transfer', extra: { operation: 'restoreBackup' } });
    });
});
