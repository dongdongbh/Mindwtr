import { describe, it, expect } from 'vitest';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { isTaskEditorSectionFieldVisible } from './task-editor-layout';
import {
    buildLoadContext,
    runLoadMigrations,
    MIGRATION_VERSION,
    type LoadContext,
} from './store-load-migrations';
import { applyProjectLifecycleTransition } from './store-helpers';
import { repairMergedSyncReferences } from './sync-normalization';
import type { AppData, AppSettings, Area, Person, Project, Section, Task } from './types';

const NOW_ISO = '2026-04-10T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

// Settings for a document that has already been through every migration at
// least once, so a test that opts in to exactly one stale field is the only
// thing that can fire.
const settledSettings = (): AppSettings => ({
    deviceId: 'device-a',
    analyticsProfileId: 'profile-a',
    migrations: {
        version: MIGRATION_VERSION,
        lastAutoArchiveAt: NOW_ISO,
        lastTombstoneCleanupAt: NOW_ISO,
    },
    gtd: {
        taskEditor: { defaultsVersion: 9999 },
        focusGroupByDefaultsVersion: 9999,
    },
});

const settledData = (overrides: Partial<AppData> = {}): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: settledSettings(),
    ...overrides,
});

const ctxFor = (data: AppData, isFreshInstall = false): LoadContext =>
    buildLoadContext(data.settings, isFreshInstall, NOW_ISO, NOW_MS);

describe('runLoadMigrations', () => {
    it('applies nothing and reports no migrations for an already-settled document', () => {
        const data = settledData();
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual([]);
        expect(result).toBe(data);
    });

    it('normalize-area-timestamps: fills in missing createdAt/updatedAt/order and self-reports', () => {
        const data = settledData({ areas: [{ id: 'area-1', name: 'Work' } as Area] });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['normalize-area-timestamps']);
        expect(result.areas[0]).toMatchObject({ createdAt: NOW_ISO, updatedAt: NOW_ISO, order: 0 });
    });

    it('one-time schema migration: applies its whole group together when migrations.version is stale', () => {
        const data = settledData();
        data.settings = { ...data.settings, migrations: { ...data.settings.migrations, version: 0 } };
        const { applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(expect.arrayContaining([
            'bump-migrations-version',
            'normalize-project-status-and-tags',
            'migrate-project-order',
            'migrate-legacy-areas',
        ]));
    });

    it('migrate-project-order: assigns order per area when missing, in encounter order', () => {
        const data = settledData({
            projects: [
                { id: 'p1', title: 'A', status: 'active', color: '#000', tagIds: [], createdAt: NOW_ISO, updatedAt: NOW_ISO } as unknown as Project,
                { id: 'p2', title: 'B', status: 'active', color: '#000', tagIds: [], createdAt: NOW_ISO, updatedAt: NOW_ISO } as unknown as Project,
            ],
        });
        data.settings = { ...data.settings, migrations: { ...data.settings.migrations, version: 0 } };
        const { data: result } = runLoadMigrations(data, ctxFor(data));
        expect(result.projects.map((project) => project.order)).toEqual([0, 1]);
    });

    it('migrate-legacy-areas: derives an area from a legacy areaTitle and links the project to it', () => {
        const data = settledData({
            projects: [{
                id: 'p1', title: 'A', status: 'active', color: '#000', order: 0, tagIds: [],
                areaTitle: 'Work', createdAt: NOW_ISO, updatedAt: NOW_ISO,
            } as unknown as Project],
        });
        data.settings = { ...data.settings, migrations: { ...data.settings.migrations, version: 0 } };
        const { data: result } = runLoadMigrations(data, ctxFor(data));
        const project = result.projects[0];
        expect(project.areaId).toBeTruthy();
        expect(result.areas.find((area) => area.id === project.areaId)?.name).toBe('Work');
    });

    it('dedupe-areas-by-name: tombstones a duplicate area name and remaps referencing projects', () => {
        const areaA: Area = { id: 'area-a', name: 'Work', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
        const areaB: Area = { id: 'area-b', name: 'Work', order: 1, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' };
        const data = settledData({
            areas: [areaA, areaB],
            projects: [{
                id: 'p1', title: 'P', status: 'active', color: '#000', order: 0, tagIds: [],
                areaId: 'area-b', createdAt: NOW_ISO, updatedAt: NOW_ISO,
            } as unknown as Project],
        });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['dedupe-areas-by-name']);
        expect(result.areas.find((area) => area.id === 'area-b')?.deletedAt).toBeTruthy();
        expect(result.projects[0].areaId).toBe('area-a');
    });

    it('archive-descendants-of-archived-projects: completes active tasks and archives sections under an archived project', () => {
        const data = settledData({
            projects: [{ id: 'p1', title: 'P', status: 'archived', color: '#000', order: 0, tagIds: [], createdAt: NOW_ISO, updatedAt: NOW_ISO } as unknown as Project],
            sections: [{ id: 's1', projectId: 'p1', title: 'S', order: 0, createdAt: NOW_ISO, updatedAt: NOW_ISO } as Section],
            tasks: [{ id: 't1', title: 'T', status: 'next', tags: [], contexts: [], projectId: 'p1', createdAt: NOW_ISO, updatedAt: NOW_ISO } as unknown as Task],
        });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['archive-descendants-of-archived-projects']);
        expect(result.tasks[0].status).toBe('done');
        expect(result.sections[0].deletedAt).toBeTruthy();
    });

    it('archive-descendants-of-archived-projects: preserves a reference through archive, load, and reactivation', () => {
        const createdAt = '2026-04-01T00:00:00.000Z';
        const archivedAt = '2026-04-09T00:00:00.000Z';
        const reactivatedAt = '2026-04-11T00:00:00.000Z';
        const project = {
            id: 'p1', title: 'P', status: 'active', color: '#000', order: 0, tagIds: [],
            createdAt, updatedAt: createdAt, rev: 1, revBy: 'device-a',
        } as Project;
        const section = {
            id: 's1', projectId: 'p1', title: 'S', order: 0,
            createdAt, updatedAt: createdAt, rev: 1, revBy: 'device-a',
        } as Section;
        const reference = {
            id: 'reference', title: 'R', status: 'reference', tags: [], contexts: [],
            projectId: 'p1', sectionId: 's1', createdAt, updatedAt: createdAt,
            rev: 7, revBy: 'device-a',
        } as Task;
        const actionable = {
            id: 'actionable', title: 'A', status: 'next', tags: [], contexts: [],
            projectId: 'p1', sectionId: 's1', createdAt, updatedAt: createdAt,
            rev: 3, revBy: 'device-a',
        } as Task;
        const archived = applyProjectLifecycleTransition(
            project,
            { status: 'archived' },
            [reference, actionable],
            [section],
            archivedAt,
            'device-a',
        );
        const archivedData = settledData({
            projects: [{ ...project, ...archived.projectUpdates, updatedAt: archivedAt }],
            tasks: archived.tasks,
            sections: archived.sections,
        });
        const archivedReference = archivedData.tasks.find((task) => task.id === reference.id)!;
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            const firstLoad = runLoadMigrations(archivedData, ctxFor(archivedData));
            expect(firstLoad.applied).toEqual([]);
            expect(firstLoad.data.tasks.find((task) => task.id === reference.id)).toEqual(archivedReference);

            const secondLoad = runLoadMigrations(firstLoad.data, ctxFor(firstLoad.data));
            expect(secondLoad.applied).toEqual([]);
            expect(secondLoad.data).toBe(firstLoad.data);

            const reactivated = applyProjectLifecycleTransition(
                firstLoad.data.projects[0],
                { status: 'active' },
                firstLoad.data.tasks,
                firstLoad.data.sections,
                reactivatedAt,
                'device-a',
            );
            expect(reactivated.tasks.find((task) => task.id === reference.id)).toEqual({
                ...archivedReference,
                archivedAt: undefined,
                updatedAt: reactivatedAt,
                rev: 9,
            });
            expect(reactivated.tasks.find((task) => task.id === actionable.id)).toMatchObject({
                status: 'next',
                completedAt: undefined,
                projectArchivedAt: undefined,
            });
            expect(logs.filter((log) => log.context?.releaseCheck === 'v1.3.0/archive-reference-preserved'))
                .toEqual([
                    expect.objectContaining({ level: 'info', context: expect.objectContaining({ count: 1 }) }),
                    expect.objectContaining({ level: 'info', context: expect.objectContaining({ count: 1 }) }),
                ]);
        } finally {
            setLogger(consoleLogger);
        }
    });

    it.each([
        { outcome: 'completed', autoArchiveDays: 0, expectedTaskStatus: 'next' },
        { outcome: 'cancelled', autoArchiveDays: 0, expectedTaskStatus: 'next' },
        { outcome: 'completed with default task auto-archive', autoArchiveDays: undefined, expectedTaskStatus: 'archived' },
    ] as const)(
        'retains an untouched $outcome project section and child through expiry, load, and reactivation',
        ({ outcome, autoArchiveDays, expectedTaskStatus }) => {
            const archivedAt = '2026-01-01T12:00:00.000Z';
            const project: Project = {
                id: 'project', title: 'Project', status: 'active', color: '#94a3b8',
                order: 0, tagIds: [], createdAt: archivedAt, updatedAt: archivedAt,
                rev: 1, revBy: 'device-a',
            };
            const section: Section = {
                id: 'section', projectId: project.id, title: 'Retained plan',
                description: 'Preparation notes', order: 4, createdAt: archivedAt,
                updatedAt: archivedAt, rev: 1, revBy: 'device-a',
            };
            const task: Task = {
                id: 'task', title: 'Next action', status: 'next', projectId: project.id,
                sectionId: section.id, tags: [], contexts: [], createdAt: archivedAt,
                updatedAt: archivedAt, rev: 1, revBy: 'device-a',
            };
            const archived = applyProjectLifecycleTransition(
                project,
                outcome === 'cancelled' ? { status: 'archived', cancelledAt: archivedAt } : { status: 'archived' },
                [task], [section], archivedAt, 'device-a',
            );
            const archiveData = settledData({
                projects: [{ ...project, ...archived.projectUpdates, updatedAt: archivedAt }],
                sections: archived.sections,
                tasks: archived.tasks,
            });
            archiveData.settings = {
                ...archiveData.settings,
                // Isolate project restoration from the normal 7-day auto-archive
                // sweep; the default policy is also covered by the third row.
                gtd: autoArchiveDays === undefined
                    ? archiveData.settings.gtd
                    : { ...archiveData.settings.gtd, autoArchiveDays },
                migrations: { ...archiveData.settings.migrations, lastTombstoneCleanupAt: archivedAt },
            };

            const firstLoad = runLoadMigrations(archiveData, ctxFor(archiveData));
            const canonical = repairMergedSyncReferences(firstLoad.data, NOW_ISO);
            const secondLoad = runLoadMigrations(canonical, ctxFor(canonical));
            const reactivated = applyProjectLifecycleTransition(
                secondLoad.data.projects[0], { status: 'active' },
                secondLoad.data.tasks, secondLoad.data.sections,
                '2026-04-11T12:00:00.000Z', 'device-a',
            );

            expect(firstLoad.data.sections).toEqual(archived.sections);
            expect(canonical.tasks).toEqual(firstLoad.data.tasks);
            expect(secondLoad.data.sections).toEqual(firstLoad.data.sections);
            expect(reactivated.sections[0]).toMatchObject({
                id: 'section', title: 'Retained plan', description: 'Preparation notes',
                order: 4, deletedAt: undefined,
            });
            expect(reactivated.tasks[0]).toMatchObject({
                id: 'task', status: expectedTaskStatus, projectId: 'project', sectionId: 'section',
            });
        },
    );

    it('repair-dangling-entity-references: clears task references that no longer resolve', () => {
        const data = settledData({
            tasks: [{
                id: 't1', title: 'T', status: 'next', tags: [], contexts: [],
                projectId: 'missing', sectionId: 'missing', areaId: 'missing',
                createdAt: NOW_ISO, updatedAt: NOW_ISO,
            } as unknown as Task],
        });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['repair-dangling-entity-references']);
        expect(result.tasks[0].projectId).toBeUndefined();
        expect(result.tasks[0].sectionId).toBeUndefined();
        expect(result.tasks[0].areaId).toBeUndefined();
    });

    it('repair-dangling-entity-references: preserves an operation-owned archived section link', () => {
        const createdAt = '2026-04-01T00:00:00.000Z';
        const archivedAt = '2026-04-09T00:00:00.000Z';
        const cancelledAt = '2026-04-08T10:00:00.000Z';
        const data = settledData({
            projects: [{
                id: 'p1', title: 'P', status: 'archived', cancelledAt, color: '#000', order: 0, tagIds: [],
                createdAt, updatedAt: archivedAt,
            } as Project],
            sections: [{
                id: 's1', projectId: 'p1', title: 'S', order: 4,
                createdAt, updatedAt: archivedAt, deletedAt: archivedAt, projectArchivedAt: archivedAt,
            } as Section],
            tasks: [{
                id: 't1', title: 'T', status: 'archived', tags: [], contexts: [],
                projectId: 'p1', sectionId: 's1', order: 7, cancelledAt, projectArchivedAt: archivedAt,
                statusBeforeProjectArchive: 'next', createdAt, updatedAt: archivedAt,
            } as Task],
        });

        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).not.toContain('repair-dangling-entity-references');
        expect(result.tasks[0]).toMatchObject({ sectionId: 's1', order: 7 });
        expect(result.sections[0]).toMatchObject({ order: 4, deletedAt: archivedAt });
    });

    it('clear-deleted-task-project-archive-metadata: clears archive metadata from a deleted task tombstone', () => {
        const data = settledData({
            tasks: [{
                id: 't1', title: 'T', status: 'done', tags: [], contexts: [],
                createdAt: NOW_ISO, updatedAt: NOW_ISO, deletedAt: NOW_ISO,
                statusBeforeProjectArchive: 'next', projectArchivedAt: NOW_ISO,
            } as unknown as Task],
        });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['clear-deleted-task-project-archive-metadata']);
        expect(result.tasks[0].statusBeforeProjectArchive).toBeUndefined();
        expect(result.tasks[0].projectArchivedAt).toBeUndefined();
    });

    it('promote-scheduled-tasks: promotes an inbox task whose due date has passed', () => {
        const data = settledData({
            tasks: [{ id: 't1', title: 'T', status: 'inbox', tags: [], contexts: [], dueDate: '2026-04-01', createdAt: '2026-03-20T00:00:00.000Z', updatedAt: '2026-03-20T00:00:00.000Z' } as unknown as Task],
        });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['promote-scheduled-tasks']);
        expect(result.tasks[0].status).toBe('next');
    });

    it('promote-scheduled-tasks: keeps a task the user put in Inbox after its date arrived (#1452)', () => {
        const data = settledData({
            tasks: [{
                id: 't1', title: 'T', status: 'inbox', tags: [], contexts: [],
                startTime: '2026-04-01', dueDate: '2026-04-01T21:00:00.000Z',
                createdAt: '2026-03-20T00:00:00.000Z', updatedAt: '2026-04-05T00:00:00.000Z',
            } as unknown as Task],
        });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).not.toContain('promote-scheduled-tasks');
        expect(result.tasks[0].status).toBe('inbox');
    });

    // `settledSettings` carries `lastAutoArchiveAt: NOW_ISO`, i.e. a pass that just
    // ran. The old twice-daily throttle skipped this load entirely, so a stale task
    // sat in Done across restarts with nothing to explain why (#959).
    it('auto-archive-stale-tasks: archives a stale completed task on a load right after the last pass', () => {
        const data = settledData({
            tasks: [{
                id: 't1', title: 'T', status: 'done', tags: [], contexts: [],
                completedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            } as unknown as Task],
        });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['auto-archive-stale-tasks']);
        expect(result.tasks[0].status).toBe('archived');
    });

    it('auto-archive-stale-tasks: writes nothing when no completed task is stale yet', () => {
        const data = settledData({
            tasks: [{
                id: 't1', title: 'T', status: 'done', tags: [], contexts: [],
                completedAt: NOW_ISO, createdAt: NOW_ISO, updatedAt: NOW_ISO,
            } as unknown as Task],
        });
        const { applied } = runLoadMigrations(data, ctxFor(data));
        // No bookkeeping timestamp to bump, so an idle load stays a no-op.
        expect(applied).toEqual([]);
    });

    it('purge-expired-tombstones + bump-tombstone-cleanup-timestamp: purges an expired tombstone once the throttle elapses', () => {
        const data = settledData({
            tasks: [{
                id: 't1', title: 'T', status: 'done', tags: [], contexts: [],
                createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
                deletedAt: '2000-01-01T00:00:00.000Z', purgedAt: '2000-01-01T00:00:00.000Z',
            } as unknown as Task],
        });
        data.settings = { ...data.settings, migrations: { ...data.settings.migrations, lastTombstoneCleanupAt: '2000-01-01T00:00:00.000Z' } };
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['bump-tombstone-cleanup-timestamp', 'purge-expired-tombstones']);
        expect(result.tasks).toHaveLength(0);
    });

    it('ensure-device-id: assigns a device id when settings has none', () => {
        const data = settledData();
        data.settings = { ...data.settings, deviceId: undefined };
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['ensure-device-id']);
        expect(result.settings.deviceId).toBeTruthy();
    });

    it('ensure-analytics-profile-id: assigns a dataset id when settings has none', () => {
        const data = settledData();
        data.settings = { ...data.settings, analyticsProfileId: undefined };
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['ensure-analytics-profile-id']);
        expect(result.settings.analyticsProfileId).toBeTruthy();
        expect(result.settings.deviceId).toBe('device-a');
    });

    it('fresh-install-notifications-default: defaults notifications off only on a fresh install', () => {
        const data = settledData();
        data.settings = { ...data.settings, notificationsEnabled: undefined };
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data, true));
        expect(applied).toEqual(['fresh-install-notifications-default']);
        expect(result.settings.notificationsEnabled).toBe(false);
    });

    it('leaves notifications untouched when not a fresh install', () => {
        const data = settledData();
        data.settings = { ...data.settings, notificationsEnabled: undefined };
        const { applied } = runLoadMigrations(data, ctxFor(data, false));
        expect(applied).not.toContain('fresh-install-notifications-default');
    });

    it('task-editor-defaults: migrates an uncustomized layout to the lean default hidden set', () => {
        const data = settledData();
        data.settings = { ...data.settings, gtd: { ...data.settings.gtd, taskEditor: { hidden: [], defaultsVersion: 4 } } };
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['task-editor-defaults']);
        expect(result.settings.gtd?.taskEditor?.defaultsVersion).toBe(5);
        expect(result.settings.gtd?.taskEditor?.hidden).toEqual(expect.arrayContaining(['section', 'priority']));
        expect(isTaskEditorSectionFieldVisible(result.settings.gtd?.taskEditor, {
            projectId: 'project-with-sections', sectionId: undefined, hasProjectSections: true,
        })).toBe(true);
    });

    it('focus-group-by-defaults: migrates the legacy context grouping default to none', () => {
        const data = settledData();
        data.settings = { ...data.settings, gtd: { ...data.settings.gtd, focusGroupBy: 'context', focusGroupByDefaultsVersion: undefined } };
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['focus-group-by-defaults']);
        expect(result.settings.gtd?.focusGroupBy).toBe('none');
    });

    it('normalize-people-for-load: tombstones a blank-name person', () => {
        const data = settledData({
            people: [{ id: 'person-1', name: '   ', createdAt: NOW_ISO, updatedAt: NOW_ISO } as unknown as Person],
        });
        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));
        expect(applied).toEqual(['normalize-people-for-load']);
        expect(result.people?.[0]?.deletedAt).toBeTruthy();
    });

    it('reports every migration that mutated data, in pipeline order, and nothing else', () => {
        // Two independent triggers: a due inbox task (promote-scheduled-tasks)
        // and a tombstone-cleanup throttle that has elapsed with an expired
        // tombstone to purge. Everything else in this fixture is already settled.
        const data = settledData({
            tasks: [
                { id: 't-due', title: 'Due', status: 'inbox', tags: [], contexts: [], dueDate: '2026-04-01', createdAt: '2026-03-20T00:00:00.000Z', updatedAt: '2026-03-20T00:00:00.000Z' } as unknown as Task,
                {
                    id: 't-tombstone', title: 'Old', status: 'done', tags: [], contexts: [],
                    createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
                    deletedAt: '2000-01-01T00:00:00.000Z', purgedAt: '2000-01-01T00:00:00.000Z',
                } as unknown as Task,
            ],
        });
        data.settings = { ...data.settings, migrations: { ...data.settings.migrations, lastTombstoneCleanupAt: '2000-01-01T00:00:00.000Z' } };

        const { data: result, applied } = runLoadMigrations(data, ctxFor(data));

        expect(applied).toEqual(['bump-tombstone-cleanup-timestamp', 'promote-scheduled-tasks', 'purge-expired-tombstones']);
        expect(result.tasks.map((task) => task.id)).toEqual(['t-due']);
        expect(result.tasks[0].status).toBe('next');
    });

    // One malformed row used to take the whole pipeline down, and the load path's
    // outer catch leaves the store empty forever after that -- every launch.
    it('isolates a throwing migration so the rest of the pipeline still runs', () => {
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            const data = settledData({ areas: [null as unknown as Area] });
            data.settings = { ...data.settings, gtd: { ...data.settings.gtd, taskEditor: { hidden: [], defaultsVersion: 4 } } };

            const { data: result, applied } = runLoadMigrations(data, ctxFor(data));

            expect(applied).not.toContain('normalize-area-timestamps');
            expect(applied).toContain('task-editor-defaults');
            expect(result.settings.gtd?.taskEditor?.defaultsVersion).toBe(5);
            expect(logs.some((log) => (
                log.level === 'warn'
                && log.message.includes('Load migration failed')
                && JSON.stringify(log.context).includes('normalize-area-timestamps')
            ))).toBe(true);
        } finally {
            setLogger(consoleLogger);
        }
    });

    // The version bump is the receipt for the one-time schema backfill. Writing it
    // while one of those migrations was skipped closes shouldRunSchemaMigration
    // forever, so the skipped step never gets a second chance.
    it('keeps the schema gate open when a schema-gated migration fails', () => {
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            const data = settledData({ projects: [null as unknown as Project] });
            data.settings = { ...data.settings, migrations: { ...data.settings.migrations, version: 0 } };

            const { data: result, applied } = runLoadMigrations(data, ctxFor(data));

            expect(applied).not.toContain('normalize-project-status-and-tags');
            expect(applied).not.toContain('bump-migrations-version');
            expect(result.settings.migrations?.version ?? 0).toBe(0);
            // The next launch must still see the backfill as owed.
            expect(buildLoadContext(result.settings, false, NOW_ISO, NOW_MS).shouldRunSchemaMigration).toBe(true);
        } finally {
            setLogger(consoleLogger);
        }
    });

    it('still bumps the version when the failure is outside the schema group', () => {
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            // No schema-gated migration reads sections, so only the ungated
            // repair pass trips here.
            const data = settledData({ sections: [null as unknown as Section] });
            data.settings = { ...data.settings, migrations: { ...data.settings.migrations, version: 0 } };

            const { data: result, applied } = runLoadMigrations(data, ctxFor(data));

            expect(applied).not.toContain('repair-dangling-entity-references');
            expect(applied).toContain('bump-migrations-version');
            expect(result.settings.migrations?.version).toBe(MIGRATION_VERSION);
        } finally {
            setLogger(consoleLogger);
        }
    });

    it('idempotence: running the pipeline twice over the same data applies nothing the second time', () => {
        const messyData: AppData = {
            tasks: [{ id: 't1', title: 'Due', status: 'inbox', tags: [], contexts: [], dueDate: '2026-04-01', createdAt: NOW_ISO, updatedAt: NOW_ISO } as unknown as Task],
            projects: [{
                id: 'p1', title: 'Legacy', status: 'active', color: '#000', tagIds: [],
                areaTitle: 'Work', createdAt: NOW_ISO, updatedAt: NOW_ISO,
            } as unknown as Project],
            sections: [],
            areas: [{ id: 'area-1', name: 'Work' } as Area],
            people: [],
            settings: { migrations: { version: 0 } } as unknown as AppSettings,
        };

        const firstCtx = buildLoadContext(messyData.settings, false, NOW_ISO, NOW_MS);
        const first = runLoadMigrations(messyData, firstCtx);
        expect(first.applied.length).toBeGreaterThan(0);

        const secondCtx = buildLoadContext(first.data.settings, false, NOW_ISO, NOW_MS);
        const second = runLoadMigrations(first.data, secondCtx);

        expect(second.applied).toEqual([]);
        expect(second.data).toBe(first.data);
    });

    // The narrow fixture above touches three migrations. This one carries a row
    // for every shape the risky migrations rewrite, so a pass that re-stamps
    // rev/updatedAt on every load (the sync rewrite-loop class) cannot hide.
    it('idempotence: the pipeline settles on archive, tombstone, attachment and dedupe shapes', () => {
        const ARCHIVED_AT = '2025-12-01T00:00:00.000Z';
        const EXPIRED_AT = '2025-11-01T00:00:00.000Z';
        const RECENT_AT = '2026-04-01T00:00:00.000Z';

        const messyData: AppData = {
            tasks: [
                // recover-legacy-project-references: a reference child of an
                // archived project still wearing the legacy completion markers.
                {
                    id: 't-legacy-reference', title: 'Reference child', status: 'done',
                    tags: [], contexts: [], projectId: 'p-archived',
                    statusBeforeProjectArchive: 'reference', projectArchivedAt: ARCHIVED_AT,
                    completedAt: ARCHIVED_AT, createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT,
                } as unknown as Task,
                // archive-descendants-of-archived-projects: a still-open child
                // and (below) a still-live section under the archived project.
                {
                    id: 't-archive-child', title: 'Open child', status: 'next',
                    tags: [], contexts: [], projectId: 'p-archived',
                    createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT,
                } as unknown as Task,
                // purge-expired-tombstones: an expired task tombstone.
                {
                    id: 't-tombstone', title: 'Deleted long ago', status: 'next',
                    tags: [], contexts: [], deletedAt: EXPIRED_AT,
                    createdAt: EXPIRED_AT, updatedAt: EXPIRED_AT,
                } as unknown as Task,
                // purge-expired-tombstones: attachment pruning inside a live task,
                // plus normalize-people-for-load's assignedTo derivation.
                {
                    id: 't-attachment', title: 'Has a file', status: 'next',
                    tags: [], contexts: [], assignedTo: 'Alex',
                    attachments: [
                        {
                            id: 'att-live', kind: 'file', title: 'Spec.pdf', uri: 'file:///spec.pdf',
                            createdAt: RECENT_AT, updatedAt: RECENT_AT,
                        },
                        {
                            id: 'att-gone', kind: 'file', title: 'Old.pdf', uri: 'file:///old.pdf',
                            createdAt: EXPIRED_AT, updatedAt: EXPIRED_AT, deletedAt: EXPIRED_AT,
                        },
                    ],
                    createdAt: RECENT_AT, updatedAt: RECENT_AT,
                } as unknown as Task,
                // A cancelled task: archived, never completed.
                {
                    id: 't-cancelled', title: 'Called off', status: 'archived',
                    tags: [], contexts: [], cancelledAt: RECENT_AT,
                    createdAt: RECENT_AT, updatedAt: RECENT_AT,
                } as unknown as Task,
                // auto-archive-stale-tasks: a done task older than the window.
                {
                    id: 't-stale-done', title: 'Finished ages ago', status: 'done',
                    tags: [], contexts: [], completedAt: ARCHIVED_AT,
                    createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT,
                } as unknown as Task,
                // promote-scheduled-tasks: an inbox task whose due date has passed.
                {
                    id: 't-scheduled', title: 'Was due', status: 'inbox',
                    tags: [], contexts: [], dueDate: '2026-04-01',
                    createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT,
                } as unknown as Task,
            ],
            projects: [
                {
                    id: 'p-archived', title: 'Archived', status: 'archived', color: '#000', tagIds: [],
                    createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT,
                } as unknown as Project,
                {
                    id: 'p-live', title: 'Live', status: 'active', color: '#000', tagIds: [],
                    areaId: 'area-work-b', areaTitle: 'Work',
                    createdAt: RECENT_AT, updatedAt: RECENT_AT,
                } as unknown as Project,
            ],
            sections: [
                // An archived section: deletedAt == updatedAt == projectArchivedAt,
                // expired but retained because its project can still be restored.
                {
                    id: 's-archived', projectId: 'p-archived', title: 'Archived section', order: 0,
                    projectArchivedAt: ARCHIVED_AT, deletedAt: ARCHIVED_AT,
                    createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT,
                } as unknown as Section,
                {
                    id: 's-live-under-archived', projectId: 'p-archived', title: 'Still live', order: 2,
                    createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT,
                } as unknown as Section,
                // A plain expired section tombstone, which the purge does remove.
                {
                    id: 's-tombstone', projectId: 'p-live', title: 'Deleted section', order: 1,
                    deletedAt: EXPIRED_AT, createdAt: EXPIRED_AT, updatedAt: EXPIRED_AT,
                } as unknown as Section,
            ],
            // dedupe-areas-by-name: two live areas with the same name.
            areas: [
                { id: 'area-work-a', name: 'Work', order: 0, createdAt: RECENT_AT, updatedAt: RECENT_AT } as Area,
                { id: 'area-work-b', name: 'work', order: 1, createdAt: RECENT_AT, updatedAt: RECENT_AT } as Area,
            ],
            people: [
                { id: 'person-1', name: 'Alex', createdAt: RECENT_AT, updatedAt: RECENT_AT } as Person,
            ],
            settings: {
                deviceId: 'device-a',
                migrations: { version: 0 },
                savedFilters: [
                    { id: 'sf-live', name: 'Live', view: 'all', criteria: {}, createdAt: RECENT_AT, updatedAt: RECENT_AT },
                    { id: 'sf-gone', name: 'Gone', view: 'all', criteria: {}, createdAt: EXPIRED_AT, updatedAt: EXPIRED_AT, deletedAt: EXPIRED_AT },
                ],
            } as unknown as AppSettings,
        };

        const first = runLoadMigrations(messyData, buildLoadContext(messyData.settings, false, NOW_ISO, NOW_MS));
        // Every risky migration really ran, so the property below has something
        // to prove. A name dropping out of this list means the fixture drifted.
        for (const name of [
            'recover-legacy-project-references',
            'promote-scheduled-tasks',
            'auto-archive-stale-tasks',
            'dedupe-areas-by-name',
            'archive-descendants-of-archived-projects',
            'purge-expired-tombstones',
        ]) {
            expect(first.applied).toContain(name);
        }
        // The purge kept the restorable archive section and dropped the rest.
        expect(first.data.sections.map((section) => section.id).sort()).toEqual(['s-archived', 's-live-under-archived']);
        expect(first.data.tasks.map((task) => task.id)).not.toContain('t-tombstone');

        const second = runLoadMigrations(first.data, buildLoadContext(first.data.settings, false, NOW_ISO, NOW_MS));
        expect(second.applied).toEqual([]);
        expect(second.data).toBe(first.data);

        // Past the 24 h cleanup throttle only the two throttled steps run again,
        // and neither may change a single row.
        const laterIso = new Date(NOW_MS + 25 * 60 * 60 * 1000).toISOString();
        const third = runLoadMigrations(
            second.data,
            buildLoadContext(second.data.settings, false, laterIso, NOW_MS + 25 * 60 * 60 * 1000)
        );
        expect(third.applied).toEqual(['bump-tombstone-cleanup-timestamp', 'purge-expired-tombstones']);
        expect(third.data.tasks).toEqual(first.data.tasks);
        expect(third.data.projects).toEqual(first.data.projects);
        expect(third.data.sections).toEqual(first.data.sections);
        expect(third.data.areas).toEqual(first.data.areas);
        expect(third.data.people).toEqual(first.data.people);
        expect(third.data.settings.savedFilters).toEqual(first.data.settings.savedFilters);
    });
});
