import { describe, expect, it, vi } from 'vitest';
import { CLOCK_SKEW_THRESHOLD_MS, SYNC_REPAIR_REV_BY, mergeAppData, mergeAppDataWithStats } from './sync';
import { getTaskDateCoherenceIssues } from './task-date-coherence';
import {
    normalizeAreaForSyncMerge,
    normalizeAppData,
    normalizeProjectForSyncMerge,
    normalizeRevisionMetadata,
    normalizeTaskForSyncMerge,
    repairMergedSyncReferences,
    validateMergedSyncData,
} from './sync-normalization';
import { normalizeTaskForContentComparison, toComparableSignature } from './sync-signatures';
import { createMockArea, createMockProject, createMockSection, createMockTask, mockAppData } from './sync-test-utils';
import type { AppData, Area, Project, Task } from './types';

const NOW = '2026-01-01T00:00:00.000Z';

describe('normalizeTaskForSyncMerge repeatReminderMinutes', () => {
    const taskWith = (repeatReminderMinutes: number): Task => ({
        id: 't', title: 't', status: 'next', tags: [], contexts: [],
        createdAt: NOW, updatedAt: NOW, repeatReminderMinutes,
    });

    it('coerces an out-of-range repeatReminderMinutes to undefined', () => {
        const task = normalizeTaskForSyncMerge(taskWith(7), NOW);
        expect(task.repeatReminderMinutes).toBeUndefined();
    });

    it('preserves a valid repeatReminderMinutes', () => {
        const task = normalizeTaskForSyncMerge(taskWith(15), NOW);
        expect(task.repeatReminderMinutes).toBe(15);
    });

    it('coerces an invalid timeSpentMinutes to undefined and preserves a valid one', () => {
        const invalid = normalizeTaskForSyncMerge({ ...taskWith(15), timeSpentMinutes: -20 }, NOW);
        expect(invalid.timeSpentMinutes).toBeUndefined();
        const valid = normalizeTaskForSyncMerge({ ...taskWith(15), timeSpentMinutes: 75 }, NOW);
        expect(valid.timeSpentMinutes).toBe(75);
    });

    it('drops unknown legacy task fields', () => {
        const task = normalizeTaskForSyncMerge({
            ...taskWith(15),
            removedLegacyField: 'stale remote value',
        } as Task & Record<string, unknown>, NOW) as Task & Record<string, unknown>;

        expect(task.removedLegacyField).toBeUndefined();
    });
});

const normalizeForMerge = (data: AppData, nowIso = NOW): AppData => {
    const normalized = normalizeAppData(data);
    return {
        ...normalized,
        tasks: normalized.tasks.map((task) => normalizeRevisionMetadata(normalizeTaskForSyncMerge(task, nowIso))),
        projects: normalized.projects.map((project) => normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))),
        sections: normalized.sections.map((section) => normalizeRevisionMetadata(section)),
        areas: normalized.areas.map((area) => normalizeRevisionMetadata(normalizeAreaForSyncMerge(area, nowIso))),
    };
};

describe('sync normalization', () => {
    it('preserves viewSectionIds when merging with an old-client task that lacks the field', () => {
        const localTask = {
            ...createMockTask('task-view-section', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            title: 'Local title',
            rev: 1,
            revBy: 'new-client',
            viewSectionIds: { someday: 'books' },
        };
        const { viewSectionIds: _omitted, ...oldClientTask } = {
            ...localTask,
            title: 'Updated by old client',
            rev: 2,
            revBy: 'old-client',
            updatedAt: '2026-01-01T00:01:00.000Z',
        };
        const local = mockAppData([localTask]);
        const incoming = mockAppData([oldClientTask as Task]);

        const forward = mergeAppData(local, incoming, { nowIso: NOW });
        const reverse = mergeAppData(incoming, local, { nowIso: NOW });

        expect(forward.tasks[0]).toMatchObject({
            title: 'Updated by old client',
            viewSectionIds: { someday: 'books' },
        });
        expect(reverse.tasks[0]).toEqual(forward.tasks[0]);
        expect(mergeAppData(forward, incoming, { nowIso: NOW }).tasks[0]).toEqual(forward.tasks[0]);
    });

    it('stamps purged-content compaction once so a legacy peer cannot republish the full tombstone', () => {
        const purgedAt = '2025-12-31T23:00:00.000Z';
        const full = mockAppData(
            [{
                ...createMockTask('task-1', purgedAt, purgedAt),
                title: 'Private task',
                description: 'Private task notes',
                attachments: [{
                    id: 'attachment-1',
                    kind: 'file',
                    title: 'Private attachment',
                    uri: 'file:///private/attachment.txt',
                    mimeType: 'text/plain',
                    createdAt: purgedAt,
                    updatedAt: purgedAt,
                }],
                purgedAt,
                rev: 7,
                revBy: 'device-a',
            }],
            [{
                ...createMockProject('project-1', purgedAt, purgedAt),
                title: 'Private project',
                supportNotes: 'Private project notes',
                attachments: [{
                    id: 'attachment-2',
                    kind: 'file',
                    title: 'Private project attachment',
                    uri: 'file:///private/project.txt',
                    createdAt: purgedAt,
                    updatedAt: purgedAt,
                }],
                purgedAt,
                rev: 8,
                revBy: 'device-a',
            }],
            [{
                ...createMockSection('section-1', 'project-1', purgedAt, purgedAt),
                title: 'Private section',
                description: 'Private section notes',
                rev: 9,
                revBy: 'device-a',
            }],
        );
        const compact = mergeAppData(full, mockAppData(), { nowIso: NOW });
        const sqliteRoundTrip = {
            ...compact,
            tasks: compact.tasks.map((task) => ({
                ...task,
                isFocusedToday: false,
                suppressMindwtrReminders: false,
                showFutureRecurrence: false,
            })),
            projects: compact.projects.map((project) => ({
                ...project,
                isSequential: false,
                isFocused: false,
            })),
            sections: compact.sections.map((section) => ({ ...section, isCollapsed: false })),
        };

        expect(compact.tasks[0]).toMatchObject({ title: '(deleted)', purgedAt });
        expect(compact.tasks[0].description).toBeUndefined();
        expect(compact.projects[0]).toMatchObject({ title: '(deleted)', purgedAt });
        expect(compact.projects[0].supportNotes).toBeUndefined();
        expect(compact.sections[0]).toMatchObject({ title: '', deletedAt: purgedAt });
        expect(compact.sections[0].description).toBeUndefined();
        expect([
            [compact.tasks[0].rev, compact.tasks[0].revBy],
            [compact.projects[0].rev, compact.projects[0].revBy],
            [compact.sections[0].rev, compact.sections[0].revBy],
        ]).toEqual([
            [8, SYNC_REPAIR_REV_BY],
            [9, SYNC_REPAIR_REV_BY],
            [10, SYNC_REPAIR_REV_BY],
        ]);

        const legacyReplay = mergeAppData(compact, full, { nowIso: NOW });
        const secondCurrentMerge = mergeAppData(compact, legacyReplay, { nowIso: NOW });
        for (const merged of [
            mergeAppData(full, compact, { nowIso: NOW }),
            legacyReplay,
            mergeAppData(compact, compact, { nowIso: NOW }),
            mergeAppData(sqliteRoundTrip, sqliteRoundTrip, { nowIso: NOW }),
            secondCurrentMerge,
        ]) {
            expect(merged.tasks).toEqual(compact.tasks);
            expect(merged.projects).toEqual(compact.projects);
            expect(merged.sections).toEqual(compact.sections);
        }

        const semanticFalse = normalizeTaskForSyncMerge({
            ...compact.tasks[0],
            isFocusedTodayBeforeProjectArchive: false,
        }, NOW);
        expect(semanticFalse.rev).toBe((compact.tasks[0].rev ?? 0) + 1);
        expect(semanticFalse.isFocusedTodayBeforeProjectArchive).toBeUndefined();
    });

    it('compacts a retained section when its project is purged on the other side', () => {
        const purgedAt = '2025-12-31T23:00:00.000Z';
        const project = {
            ...createMockProject('project-1', '2025-12-30T23:00:00.000Z'),
            rev: 1,
            revBy: 'device-a',
        };
        const merged = mergeAppData(
            mockAppData([], [project], [{
                ...createMockSection('section-1', project.id, '2025-12-30T23:00:00.000Z'),
                title: 'Private section',
                description: 'Private section notes',
                rev: 1,
                revBy: 'device-a',
            }]),
            mockAppData([], [{
                ...project,
                deletedAt: purgedAt,
                purgedAt,
                updatedAt: purgedAt,
                rev: 2,
                revBy: 'device-b',
            }]),
            { nowIso: NOW },
        );

        expect(merged.sections[0]).toMatchObject({
            title: '',
            deletedAt: purgedAt,
            rev: 2,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(merged.sections[0].description).toBeUndefined();
    });

    it('stamps a retained soft-deleted section when its project is purged on the other side', () => {
        const purgedAt = '2025-12-31T23:00:00.000Z';
        const project = {
            ...createMockProject('project-1', '2025-12-30T23:00:00.000Z'),
            rev: 1,
            revBy: 'device-a',
        };
        const merged = mergeAppData(
            mockAppData([], [project], [{
                ...createMockSection('section-1', project.id, purgedAt, purgedAt),
                title: 'Private section',
                description: 'Private section notes',
                deletedAt: purgedAt,
                rev: 4,
                revBy: 'device-a',
            }]),
            mockAppData([], [{
                ...project,
                deletedAt: purgedAt,
                purgedAt,
                updatedAt: purgedAt,
                rev: 2,
                revBy: 'device-b',
            }]),
            { nowIso: NOW },
        );

        expect(merged.sections[0]).toMatchObject({
            title: '',
            deletedAt: purgedAt,
            rev: 5,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(merged.sections[0].description).toBeUndefined();
    });

    it('normalizes malformed entity fields idempotently before merge', () => {
        const task = {
            ...createMockTask('task-1', '2025-12-31T23:00:00.000Z'),
            tags: ['home', 3, null],
            contexts: ['work', false],
            sectionId: '   ',
            isFocusedToday: 'yes',
            rev: 3,
            revBy: ' device-a ',
        } as unknown as Task;
        const project = {
            ...createMockProject('project-1', '2025-12-31T23:00:00.000Z'),
            status: 'SOMEDAY',
            color: '',
            tagIds: ['tag-1', 42],
            areaId: '',
            areaTitle: '   ',
            isSequential: 'true',
            sequentialScope: 'not-a-scope',
        } as unknown as Project;
        const area = {
            ...createMockArea('area-1', '2025-12-31T23:00:00.000Z'),
            color: '',
            icon: '',
            order: Number.NaN,
        } satisfies Area;
        const data: AppData = {
            tasks: [task],
            projects: [project],
            sections: [createMockSection('section-1', 'project-1', '2025-12-31T23:00:00.000Z')],
            areas: [area],
            settings: {},
        };

        const once = normalizeForMerge(data);
        const twice = normalizeForMerge(once);

        expect(twice).toEqual(once);
        expect(once.tasks[0]).toMatchObject({
            tags: ['home'],
            contexts: ['work'],
            sectionId: undefined,
            isFocusedToday: false,
            rev: 3,
            revBy: 'device-a',
        });
        expect(once.projects[0]).toMatchObject({
            status: 'someday',
            color: '#6B7280',
            tagIds: ['tag-1'],
            areaId: undefined,
            areaTitle: undefined,
            isSequential: false,
            sequentialScope: undefined,
        });
        expect(once.areas[0]).toMatchObject({
            color: undefined,
            icon: undefined,
            order: undefined,
        });
    });

    it('strips invalid revision metadata and validates malformed revisions', () => {
        expect(normalizeRevisionMetadata({ rev: '4', revBy: 'device-a' })).toEqual({ revBy: 'device-a' });
        expect(normalizeRevisionMetadata({ rev: 4, revBy: ' device-a ' })).toEqual({ rev: 4, revBy: 'device-a' });
        expect(normalizeRevisionMetadata({ rev: -1, revBy: '   ' })).toEqual({});

        const invalidData = {
            tasks: [{
                ...createMockTask('task-1', '2025-12-31T23:00:00.000Z'),
                rev: -1,
                revBy: '',
            }],
            projects: [{
                ...createMockProject('project-1', '2025-12-31T23:00:00.000Z'),
                rev: 1.5,
                revBy: ['device-a'],
            }],
            sections: [{
                ...createMockSection('section-1', 'project-1', '2025-12-31T23:00:00.000Z'),
                rev: Number.POSITIVE_INFINITY,
                revBy: 42,
            }],
            areas: [{
                ...createMockArea('area-1', '2025-12-31T23:00:00.000Z'),
                rev: '2',
                revBy: '   ',
            }],
            settings: {},
        } as unknown as AppData;

        expect(validateMergedSyncData(invalidData)).toEqual(expect.arrayContaining([
            'tasks[0].rev must be a non-negative integer when present',
            'tasks[0].revBy must be a non-empty string when present',
            'projects[0].rev must be a non-negative integer when present',
            'projects[0].revBy must be a non-empty string when present',
            'sections[0].rev must be a non-negative integer when present',
            'sections[0].revBy must be a non-empty string when present',
            'areas[0].rev must be a non-negative integer when present',
            'areas[0].revBy must be a non-empty string when present',
        ]));
    });

    it('clears focus flags from tasks with future start dates during merge normalization', () => {
        const task = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z'),
            status: 'next',
            startTime: '2026-01-03',
            isFocusedToday: true,
        } satisfies Task;

        const normalized = normalizeTaskForSyncMerge(task, '2026-01-01T10:00:00.000Z');

        expect(normalized.startTime).toBe('2026-01-03');
        expect(normalized.isFocusedToday).toBe(false);
    });

    it('detects date incoherence from incoming synced tasks without mutating dates', () => {
        const task = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z'),
            status: 'next',
            dueDate: '2026-04-24',
            startTime: '2026-04-25',
        } satisfies Task;

        const normalized = normalizeTaskForSyncMerge(task, '2026-04-20T10:00:00.000Z');

        expect(getTaskDateCoherenceIssues(normalized)).toEqual([{
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        }]);
        expect(normalized.startTime).toBe('2026-04-25');
        expect(normalized.dueDate).toBe('2026-04-24');
    });

    it('sanitizes synced task attachment URIs and cloud keys during normalization', () => {
        const task = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z'),
            attachments: [
                {
                    id: 'att-1',
                    kind: 'file',
                    title: 'Unsafe',
                    uri: 'file:///safe/%252e%252e/secret.txt',
                    cloudKey: '../attachments/secret.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'att-2',
                    kind: 'file',
                    title: 'Safe',
                    uri: 'file:///local/attachments/safe.txt',
                    cloudKey: 'attachments/att-2.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } satisfies Task;

        const normalized = normalizeTaskForSyncMerge(task, '2026-04-20T10:00:00.000Z');

        expect(normalized.attachments?.[0]?.uri).toBe('');
        expect(normalized.attachments?.[0]?.cloudKey).toBeUndefined();
        expect(normalized.attachments?.[1]?.uri).toBe('file:///local/attachments/safe.txt');
        expect(normalized.attachments?.[1]?.cloudKey).toBe('attachments/att-2.txt');
    });

    it('drops a malformed synced attachment fileHash so integrity validation stays enforceable', () => {
        const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
        const task = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z'),
            attachments: [
                {
                    id: 'att-1',
                    kind: 'file',
                    title: 'Truncated digest',
                    uri: '/local/a.txt',
                    fileHash: digest.slice(0, 32),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'att-2',
                    kind: 'file',
                    title: 'Real digest',
                    uri: '/local/b.txt',
                    fileHash: digest.toUpperCase(),
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } satisfies Task;

        const normalized = normalizeTaskForSyncMerge(task, '2026-04-20T10:00:00.000Z');

        expect(normalized.attachments?.[0]?.fileHash).toBeUndefined();
        expect(normalized.attachments?.[1]?.fileHash).toBe(digest.toUpperCase());
    });

    it('sanitizes synced project attachment cloud keys during normalization', () => {
        const project = {
            ...createMockProject('project-1', '2026-01-01T00:00:00.000Z'),
            attachments: [
                {
                    id: 'att-1',
                    kind: 'file',
                    title: 'Unsafe',
                    uri: '/tmp/safe.txt',
                    cloudKey: 'attachments/../secret.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } satisfies Project;

        const normalized = normalizeProjectForSyncMerge(project);

        expect(normalized.attachments?.[0]?.uri).toBe('/tmp/safe.txt');
        expect(normalized.attachments?.[0]?.cloudKey).toBeUndefined();
    });

    it('does not let one-sided revBy metadata decide equal-revision conflicts', () => {
        const updatedAt = '2026-01-01T00:00:00.000Z';
        const local = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            title: 'zz local deterministic winner',
            rev: 7,
        }]);
        const incoming = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            title: 'aa incoming has revBy',
            rev: 7,
            revBy: 'device-z',
        }]);

        const forward = mergeAppDataWithStats(local, incoming, { nowIso: NOW });
        const reverse = mergeAppDataWithStats(incoming, local, { nowIso: NOW });

        expect(forward.data.tasks[0].title).toBe('zz local deterministic winner');
        expect(reverse.data.tasks[0].title).toBe('zz local deterministic winner');
        expect(forward.stats.tasks.conflictReasonCounts?.content).toBe(1);
    });

    it('uses deterministic ordering when timestamps and revision metadata both match', () => {
        const updatedAt = '2026-01-01T00:00:00.000Z';
        const left = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            title: 'aa lower signature',
            rev: 8,
            revBy: 'device-a',
        }]);
        const right = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            title: 'zz higher signature',
            rev: 8,
            revBy: 'device-a',
        }]);

        const forward = mergeAppDataWithStats(left, right, { nowIso: NOW });
        const reverse = mergeAppDataWithStats(right, left, { nowIso: NOW });

        expect(forward.data.tasks[0].title).toBe('zz higher signature');
        expect(reverse.data.tasks[0].title).toBe('zz higher signature');
    });

    it('keeps normalize merge normalize round trips idempotent', () => {
        const local = normalizeForMerge(mockAppData([
            {
                ...createMockTask('task-1', '2026-01-01T01:00:00.000Z'),
                title: 'Local title',
                tags: ['one', 2],
                rev: 2,
                revBy: 'local-device',
            } as unknown as Task,
        ], [
            {
                ...createMockProject('project-1', '2026-01-01T00:30:00.000Z'),
                status: 'WAITING',
                rev: 2,
                revBy: 'local-device',
            } as unknown as Project,
        ]));
        const incoming = normalizeForMerge(mockAppData([
            {
                ...createMockTask('task-1', '2026-01-01T02:00:00.000Z'),
                title: 'Incoming title',
                contexts: ['office', null],
                rev: 3,
                revBy: 'incoming-device',
            } as unknown as Task,
        ], [
            {
                ...createMockProject('project-1', '2026-01-01T02:00:00.000Z'),
                status: 'ACTIVE',
                tagIds: ['tag-a', null],
                rev: 3,
                revBy: 'incoming-device',
            } as unknown as Project,
        ]));

        const merged = mergeAppData(local, incoming, { nowIso: NOW });
        const normalizedAfterMerge = normalizeForMerge(merged);
        const mergedAgain = mergeAppData(normalizedAfterMerge, normalizedAfterMerge, { nowIso: NOW });

        expect(normalizeForMerge(mergedAgain)).toEqual(normalizedAfterMerge);
        expect(validateMergedSyncData(normalizedAfterMerge)).toEqual([]);
    });

    it('repairs deleted area project section references once and preserves tombstones', () => {
        const data: AppData = {
            tasks: [{
                ...createMockTask('task-1', '2025-12-31T23:00:00.000Z'),
                projectId: 'deleted-project',
                sectionId: 'deleted-project-section',
                areaId: 'deleted-area',
                order: 1,
                orderNum: 1,
                rev: 5,
                revBy: 'device-a',
            }],
            projects: [
                {
                    ...createMockProject('project-1', '2025-12-31T23:00:00.000Z'),
                    areaId: 'deleted-area',
                    areaTitle: 'Deleted area',
                    rev: 5,
                    revBy: 'device-a',
                },
                createMockProject('deleted-project', '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ],
            sections: [
                createMockSection('deleted-project-section', 'deleted-project', '2025-12-31T23:00:00.000Z'),
            ],
            areas: [
                createMockArea('deleted-area', '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ],
            settings: {},
        };

        const repaired = repairMergedSyncReferences(data, NOW);
        const repairedAgain = repairMergedSyncReferences(repaired, '2026-01-02T00:00:00.000Z');

        expect(repairedAgain).toEqual(repaired);
        expect(repaired.projects[0]).toMatchObject({
            areaId: undefined,
            areaTitle: undefined,
            updatedAt: NOW,
            rev: 6,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(repaired.sections[0]).toMatchObject({
            deletedAt: NOW,
            updatedAt: NOW,
            rev: 1,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(repaired.tasks[0]).toMatchObject({
            projectId: undefined,
            sectionId: undefined,
            areaId: undefined,
            order: undefined,
            orderNum: undefined,
            updatedAt: NOW,
            rev: 6,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(repaired.areas[0].deletedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('repairs missing task container references once before sync persistence', () => {
        const data: AppData = {
            tasks: [{
                ...createMockTask('task-missing-container', '2025-12-31T23:00:00.000Z'),
                projectId: 'missing-project',
                sectionId: 'missing-section',
                areaId: 'missing-area',
                order: 4,
                orderNum: 4,
                rev: 9,
                revBy: 'device-a',
            }],
            projects: [{
                ...createMockProject('project-missing-area', '2025-12-31T23:00:00.000Z'),
                areaId: 'missing-area',
                areaTitle: 'Missing area',
                rev: 3,
                revBy: 'device-a',
            }],
            sections: [],
            areas: [],
            settings: {},
        };

        const repaired = repairMergedSyncReferences(data, NOW);
        const repairedAgain = repairMergedSyncReferences(repaired, '2026-01-02T00:00:00.000Z');

        expect(repairedAgain).toEqual(repaired);
        expect(repaired.projects[0]).toMatchObject({
            areaId: undefined,
            areaTitle: undefined,
            updatedAt: NOW,
            rev: 4,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(repaired.tasks[0]).toMatchObject({
            projectId: undefined,
            sectionId: undefined,
            areaId: undefined,
            order: undefined,
            orderNum: undefined,
            updatedAt: NOW,
            rev: 10,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(validateMergedSyncData(repaired)).toEqual([]);
    });

    it('reports missing parent references during sync validation', () => {
        const invalidData: AppData = {
            tasks: [{
                ...createMockTask('task-missing-parents', '2025-12-31T23:00:00.000Z'),
                projectId: 'missing-project',
                sectionId: 'missing-section',
                areaId: 'missing-area',
            }],
            projects: [{
                ...createMockProject('project-missing-area', '2025-12-31T23:00:00.000Z'),
                areaId: 'missing-area',
            }],
            sections: [{
                ...createMockSection('section-missing-project', 'missing-project', '2025-12-31T23:00:00.000Z'),
            }],
            areas: [],
            settings: {},
        };

        expect(validateMergedSyncData(invalidData)).toEqual(expect.arrayContaining([
            'projects[0].areaId must reference an existing area',
            'sections[0].projectId must reference an existing project',
            'tasks[0].projectId must reference an existing project',
            'tasks[0].areaId must reference an existing area',
            'tasks[0].sectionId must reference an existing section',
        ]));
    });

    it('clamps adversarial future timestamps during merge comparison', () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date(NOW).getTime());
        try {
            const local = mockAppData([
                createMockTask('task-1', '2099-01-01T00:00:00.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('task-1', NOW),
            ]);

            const result = mergeAppDataWithStats(local, incoming, { nowIso: NOW });

            expect(result.stats.tasks.maxClockSkewMs).toBeLessThanOrEqual(CLOCK_SKEW_THRESHOLD_MS);
            expect(validateMergedSyncData(result.data)).toEqual([]);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('does not report clock skew at the warning boundary', () => {
        const localUpdatedAt = '2026-01-01T00:00:00.000Z';
        const incomingUpdatedAt = new Date(Date.parse(localUpdatedAt) + CLOCK_SKEW_THRESHOLD_MS).toISOString();
        const result = mergeAppDataWithStats(
            mockAppData([{ ...createMockTask('task-1', localUpdatedAt), title: 'Local title' }]),
            mockAppData([{ ...createMockTask('task-1', incomingUpdatedAt), title: 'Incoming title' }]),
            { nowIso: NOW },
        );

        expect(result.stats.tasks.maxClockSkewMs).toBe(CLOCK_SKEW_THRESHOLD_MS);
        expect(result.clockSkewWarning).toBeUndefined();
    });

    it('preserves a live undelete when it is newer than a remote tombstone', () => {
        const deleted = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            title: 'Deleted copy',
        };
        const undeleted = {
            ...createMockTask('task-1', '2026-01-01T00:02:00.000Z'),
            title: 'Restored copy',
        };

        const forward = mergeAppData(mockAppData([deleted]), mockAppData([undeleted]), { nowIso: NOW });
        const reverse = mergeAppData(mockAppData([undeleted]), mockAppData([deleted]), { nowIso: NOW });

        expect(forward.tasks[0]).toMatchObject({
            title: 'Restored copy',
            deletedAt: undefined,
        });
        expect(reverse.tasks[0]).toMatchObject({
            title: 'Restored copy',
            deletedAt: undefined,
        });
    });
});

// Regression coverage for #902: the macOS CloudKit bridge could box booleans
// read off iOS-written records as numeric NSNumbers, which NSJSONSerialization
// then emits as JSON numbers (1/0) instead of booleans. The sync-merge
// normalizers must treat `1` as `true` so a numeric boolean never gets
// coerced to `false` by a strict `=== true` check.
describe('sync-merge numeric boolean tolerance (#902)', () => {
    it('treats numeric 1 as true for task synced booleans, mirroring the strict-boolean case', () => {
        const numeric = normalizeTaskForSyncMerge({
            ...createMockTask('task-1', NOW),
            recurrence: 'daily',
            isFocusedToday: 1,
            suppressMindwtrReminders: 1,
            showFutureRecurrence: 1,
        } as unknown as Task, NOW);

        expect(numeric.isFocusedToday).toBe(true);
        expect(numeric.suppressMindwtrReminders).toBe(true);
        expect(numeric.showFutureRecurrence).toBe(true);

        const strict = normalizeTaskForSyncMerge({
            ...createMockTask('task-1', NOW),
            recurrence: 'daily',
            isFocusedToday: true,
            suppressMindwtrReminders: true,
            showFutureRecurrence: true,
        }, NOW);

        expect(numeric).toEqual(strict);
    });

    it('treats numeric 0 or absent task synced booleans as false/undefined exactly as before', () => {
        const zero = normalizeTaskForSyncMerge({
            ...createMockTask('task-1', NOW),
            recurrence: 'daily',
            isFocusedToday: 0,
            suppressMindwtrReminders: 0,
            showFutureRecurrence: 0,
        } as unknown as Task, NOW);

        expect(zero.isFocusedToday).toBe(false);
        expect(zero.suppressMindwtrReminders).toBe(false);
        expect(zero.showFutureRecurrence).toBeUndefined();

        const absent = normalizeTaskForSyncMerge(createMockTask('task-1', NOW), NOW);

        expect(absent.isFocusedToday).toBe(false);
        expect(absent.suppressMindwtrReminders).toBe(false);
        expect(absent.showFutureRecurrence).toBeUndefined();
    });

    it('treats numeric 1 as true for project synced booleans, mirroring the strict-boolean case', () => {
        const numeric = normalizeProjectForSyncMerge({
            ...createMockProject('project-1', NOW),
            isSequential: 1,
            isFocused: 1,
        } as unknown as Project);

        expect(numeric.isSequential).toBe(true);
        expect(numeric.isFocused).toBe(true);

        const strict = normalizeProjectForSyncMerge({
            ...createMockProject('project-1', NOW),
            isSequential: true,
            isFocused: true,
        });

        expect(numeric).toEqual(strict);
    });

    it('treats numeric 0 or absent project synced booleans as false exactly as before', () => {
        const zero = normalizeProjectForSyncMerge({
            ...createMockProject('project-1', NOW),
            isSequential: 0,
            isFocused: 0,
        } as unknown as Project);

        expect(zero.isSequential).toBe(false);
        expect(zero.isFocused).toBe(false);

        const absent = normalizeProjectForSyncMerge(createMockProject('project-1', NOW));

        expect(absent.isSequential).toBe(false);
        expect(absent.isFocused).toBe(false);
    });

    it('is idempotent when re-normalizing a numeric-boolean task or project', () => {
        const task = { ...createMockTask('task-1', NOW), isFocusedToday: 1 } as unknown as Task;
        const once = normalizeTaskForSyncMerge(task, NOW);
        const twice = normalizeTaskForSyncMerge(once, NOW);
        expect(twice).toEqual(once);

        const project = { ...createMockProject('project-1', NOW), isSequential: 1, isFocused: 1 } as unknown as Project;
        const projectOnce = normalizeProjectForSyncMerge(project);
        const projectTwice = normalizeProjectForSyncMerge(projectOnce);
        expect(projectTwice).toEqual(projectOnce);
    });

    it('resolves the #902 regression: a numeric-boolean remote star wins the merge instead of being coerced to false', () => {
        const updatedAt = '2026-01-01T00:00:00.000Z';
        const local = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            isFocusedToday: false,
            rev: 5,
            revBy: 'macos-device',
        }]);
        const incoming = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            // Simulates the un-fixed macOS CloudKit bridge reading an iOS-written
            // record: the boolean arrives as a JSON number, not a JSON boolean.
            isFocusedToday: 1,
            rev: 6,
            revBy: 'ios-device',
        } as unknown as Task]);

        const merged = mergeAppDataWithStats(local, incoming, { nowIso: NOW });

        expect(merged.data.tasks[0].isFocusedToday).toBe(true);
    });

    it('produces zero content diff between a numeric-boolean remote copy and a real-boolean local copy at the same rev', () => {
        const updatedAt = '2026-01-01T00:00:00.000Z';
        const localTask = {
            ...createMockTask('task-1', updatedAt),
            isFocusedToday: true,
            rev: 4,
            revBy: 'device-a',
        } satisfies Task;
        const remoteTask = {
            ...createMockTask('task-1', updatedAt),
            isFocusedToday: 1,
            rev: 4,
            revBy: 'device-a',
        } as unknown as Task;

        const localNormalized = normalizeTaskForSyncMerge(localTask, NOW);
        const remoteNormalized = normalizeTaskForSyncMerge(remoteTask, NOW);

        const localSignature = toComparableSignature(normalizeTaskForContentComparison(localNormalized));
        const remoteSignature = toComparableSignature(normalizeTaskForContentComparison(remoteNormalized));
        expect(remoteSignature).toBe(localSignature);

        const forward = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([remoteTask]), { nowIso: NOW });
        const reverse = mergeAppDataWithStats(mockAppData([remoteTask]), mockAppData([localTask]), { nowIso: NOW });

        expect(forward.stats.tasks.conflictReasonCounts?.content ?? 0).toBe(0);
        expect(reverse.stats.tasks.conflictReasonCounts?.content ?? 0).toBe(0);
        expect(forward.data.tasks[0].isFocusedToday).toBe(true);
        expect(reverse.data.tasks[0].isFocusedToday).toBe(true);
    });
});
