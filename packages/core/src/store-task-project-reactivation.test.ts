import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    applyTaskProjectReactivationTransition,
    buildEntityMap,
    findTaskProjectReactivationTarget,
} from './store-helpers';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { StorageAdapter } from './storage';
import type { AppData, Project, Section, Task } from './types';

const CREATED_AT = '2026-09-08T08:00:00.000Z';
const ARCHIVED_AT = '2026-09-08T09:00:00.000Z';
const REOPENED_AT = '2026-09-08T10:00:00.000Z';

const project = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Lifecycle project',
    status: 'active',
    color: '#2563EB',
    order: 0,
    tagIds: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const section = (overrides: Partial<Section> = {}): Section => ({
    id: 'section-1',
    projectId: 'project-1',
    title: 'Named section',
    order: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    projectId: 'project-1',
    sectionId: 'section-1',
    tags: [],
    contexts: [],
    pushCount: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const cloneValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const cloneData = (data: AppData): AppData => cloneValue(data);

const resetStore = (data?: AppData): void => {
    const tasks = data?.tasks ?? [];
    const projects = data?.projects ?? [];
    const sections = data?.sections ?? [];
    const areas = data?.areas ?? [];
    const people = data?.people ?? [];
    useTaskStore.setState({
        tasks,
        projects,
        sections,
        areas,
        people,
        settings: data?.settings ?? {},
        isLoading: false,
        error: null,
        persistenceFailure: null,
        _allTasks: tasks,
        _allProjects: projects,
        _allSections: sections,
        _allAreas: areas,
        _allPeople: people,
        _tasksById: buildEntityMap(tasks),
        _projectsById: buildEntityMap(projects),
        _sectionsById: buildEntityMap(sections),
        _areasById: buildEntityMap(areas),
        _peopleById: buildEntityMap(people),
        lastDataChangeAt: 0,
    });
};

describe('task-driven project reactivation transition', () => {
    it.each(['inbox', 'next', 'waiting', 'someday'] as const)(
        'finds the final live archived parent for actionable status %s',
        (status) => {
            const source = task('selected', {
                status: 'done',
                projectArchivedAt: ARCHIVED_AT,
            });
            const oldParent = project({ id: 'old-project', status: 'archived' });
            const finalParent = project({ id: 'final-project', status: 'archived' });

            expect(findTaskProjectReactivationTarget(source, {
                status,
                projectId: ' final-project ',
            }, [oldParent, finalParent])).toBe(finalParent);
        },
    );

    it('permits an explicit next-to-next repair under an archived parent', () => {
        const source = task('selected', { status: 'next' });
        expect(findTaskProjectReactivationTarget(
            source,
            { status: 'next' },
            [project({ status: 'archived' })],
        )?.id).toBe('project-1');
    });

    it('reactivates only the task final project assignment', () => {
        const source = task('selected', {
            status: 'done',
            projectId: 'old-project',
            sectionId: undefined,
            projectArchivedAt: ARCHIVED_AT,
        });
        const updated = task('selected', {
            status: 'next',
            projectId: 'final-project',
            sectionId: undefined,
            projectArchivedAt: undefined,
        });
        const oldParent = project({ id: 'old-project', status: 'archived' });
        const finalParent = project({ id: 'final-project', status: 'archived' });

        const result = applyTaskProjectReactivationTransition(
            [{ task: source, updates: { status: 'next', projectId: 'final-project' } }],
            [updated],
            [oldParent, finalParent],
            [],
            REOPENED_AT,
            'device-b',
        );

        expect(result.reactivatedProjectIds).toEqual(['final-project']);
        expect(result.projects.find((item) => item.id === 'old-project')?.status).toBe('archived');
        expect(result.projects.find((item) => item.id === 'final-project')?.status).toBe('active');
        expect(result.tasks[0]).toBe(updated);
    });

    it.each([
        ['notes only', { description: 'Changed note' }],
        ['done', { status: 'done' as const }],
        ['archived', { status: 'archived' as const }],
        ['reference', { status: 'reference' as const }],
        ['deleted task', { status: 'next' as const, deletedAt: REOPENED_AT }],
        ['purged task', { status: 'next' as const, purgedAt: REOPENED_AT }],
    ])('preserves collection identity for excluded %s updates', (_label, updates) => {
        const source = task('selected', { status: 'done', projectArchivedAt: ARCHIVED_AT });
        const tasks = [source];
        const projects = [project({ status: 'archived' })];
        const sections = [section({
            deletedAt: ARCHIVED_AT,
            projectArchivedAt: ARCHIVED_AT,
            updatedAt: ARCHIVED_AT,
        })];

        const result = applyTaskProjectReactivationTransition(
            [{ task: source, updates }],
            tasks,
            projects,
            sections,
            REOPENED_AT,
            'device-b',
        );

        expect(result).toEqual({ tasks, projects, sections, reactivatedProjectIds: [] });
        expect(result.tasks).toBe(tasks);
        expect(result.projects).toBe(projects);
        expect(result.sections).toBe(sections);
    });

    it.each([
        ['deleted', { deletedAt: ARCHIVED_AT }],
        ['purged', { purgedAt: ARCHIVED_AT }],
    ])('does not reactivate a %s parent', (_label, parentUpdates) => {
        const source = task('selected', { status: 'done', projectArchivedAt: ARCHIVED_AT });
        expect(findTaskProjectReactivationTarget(
            source,
            { status: 'next' },
            [project({ status: 'archived', ...parentUpdates })],
        )).toBeUndefined();
    });

    it('activates the final parent, restores only owned sections, and retires sibling markers with fresh revisions', () => {
        const sourceBeforeUpdate = task('selected', {
            status: 'done',
            completedAt: ARCHIVED_AT,
            statusBeforeProjectArchive: 'next',
            projectArchivedAt: ARCHIVED_AT,
            updatedAt: ARCHIVED_AT,
            rev: 2,
        });
        const selectedAfterUpdate = task('selected', {
            status: 'waiting',
            completedAt: undefined,
            statusBeforeProjectArchive: undefined,
            projectArchivedAt: undefined,
            updatedAt: REOPENED_AT,
            rev: 3,
            revBy: 'device-b',
        });
        const archiveOwnedSibling = task('archive-owned', {
            status: 'done',
            completedAt: ARCHIVED_AT,
            statusBeforeProjectArchive: 'waiting',
            completedAtBeforeProjectArchive: '2026-09-01T07:00:00.000Z',
            isFocusedTodayBeforeProjectArchive: true,
            projectArchivedAt: ARCHIVED_AT,
            updatedAt: ARCHIVED_AT,
            rev: 5,
        });
        const genuineDone = task('genuine-done', {
            status: 'done',
            completedAt: '2026-09-02T07:00:00.000Z',
            description: 'Preserve note',
            rev: 7,
        });
        const independentlyCancelled = task('independently-cancelled', {
            status: 'archived',
            completedAt: undefined,
            cancelledAt: '2026-09-03T07:00:00.000Z',
            rev: 8,
        });
        const reference = task('reference', { status: 'reference', rev: 9 });
        const ownedSection = section({
            deletedAt: ARCHIVED_AT,
            projectArchivedAt: ARCHIVED_AT,
            updatedAt: ARCHIVED_AT,
            rev: 4,
        });
        const independentlyDeletedSection = section({
            id: 'section-deleted',
            deletedAt: ARCHIVED_AT,
            deletedAtBeforeProjectArchive: '2026-09-01T08:00:00.000Z',
            projectArchivedAt: ARCHIVED_AT,
            updatedAt: ARCHIVED_AT,
            rev: 6,
        });
        const archivedProject = project({
            status: 'archived',
            cancelledAt: ARCHIVED_AT,
            updatedAt: ARCHIVED_AT,
            rev: 10,
        });
        const tasks = [selectedAfterUpdate, archiveOwnedSibling, genuineDone, independentlyCancelled, reference];
        const projects = [archivedProject];
        const sections = [ownedSection, independentlyDeletedSection];

        const result = applyTaskProjectReactivationTransition(
            [{ task: sourceBeforeUpdate, updates: { status: 'waiting' } }],
            tasks,
            projects,
            sections,
            REOPENED_AT,
            'device-b',
        );

        expect(result.reactivatedProjectIds).toEqual(['project-1']);
        expect(result.projects[0]).toMatchObject({
            status: 'active',
            cancelledAt: undefined,
            updatedAt: REOPENED_AT,
            rev: 11,
            revBy: 'device-b',
        });
        expect(result.sections[0]).toMatchObject({
            deletedAt: undefined,
            projectArchivedAt: undefined,
            updatedAt: REOPENED_AT,
            rev: 5,
            revBy: 'device-b',
        });
        expect(result.sections[1]).toBe(independentlyDeletedSection);
        expect(result.tasks[0]).toBe(selectedAfterUpdate);
        expect(result.tasks[1]).toEqual({
            ...archiveOwnedSibling,
            statusBeforeProjectArchive: undefined,
            completedAtBeforeProjectArchive: undefined,
            isFocusedTodayBeforeProjectArchive: undefined,
            projectArchivedAt: undefined,
            updatedAt: REOPENED_AT,
            rev: 6,
            revBy: 'device-b',
        });
        expect(result.tasks[2]).toBe(genuineDone);
        expect(result.tasks[3]).toBe(independentlyCancelled);
        expect(result.tasks[4]).toBe(reference);
    });
});

describe('task-driven project reactivation persistence', () => {
    beforeEach(() => {
        resetForTests();
        resetStore();
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        setLogger(consoleLogger);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('persists the reopened task, parent, and archive-owned section after the archive save already flushed', async () => {
        let persisted: AppData = {
            tasks: [
                task('selected', {
                    recurrence: 'daily',
                    dueDate: '2026-09-10T08:00:00.000Z',
                }),
                task('archive-owned', {
                    status: 'waiting',
                    isFocusedToday: true,
                    description: 'Keep sibling fields',
                }),
                task('genuine-done', {
                    status: 'done',
                    completedAt: CREATED_AT,
                    description: 'Already complete',
                }),
                task('independently-cancelled', {
                    status: 'archived',
                    cancelledAt: '2026-09-02T08:00:00.000Z',
                }),
                task('reference', { status: 'reference' }),
            ],
            projects: [project()],
            sections: [section()],
            areas: [],
            people: [],
            settings: { deviceId: 'device-a' },
        };
        const storage: StorageAdapter = {
            getData: vi.fn(async () => cloneData(persisted)),
            saveData: vi.fn(async (data) => {
                persisted = cloneData(data);
            }),
            saveTask: vi.fn(async (savedTask) => {
                persisted = {
                    ...persisted,
                    tasks: persisted.tasks.map((item) => item.id === savedTask.id ? cloneValue(savedTask) : item),
                };
            }),
        };
        setStorageAdapter(storage);
        resetStore();
        await useTaskStore.getState().fetchData({ silent: true });

        await useTaskStore.getState().updateProject('project-1', { status: 'archived' });
        await flushPendingSave();
        expect(persisted.projects[0]?.status).toBe('archived');
        const firstArchiveSibling = cloneValue(
            persisted.tasks.find((item) => item.id === 'archive-owned')!,
        );
        expect(firstArchiveSibling).toMatchObject({
            status: 'done',
            description: 'Keep sibling fields',
            isFocusedToday: false,
            statusBeforeProjectArchive: 'waiting',
            projectArchivedAt: expect.any(String),
        });
        expect(persisted.tasks.find((item) => item.id === 'reference')?.status).toBe('reference');

        const result = await useTaskStore.getState().moveTask('selected', 'next');
        expect(result).toEqual({ success: true });
        await flushPendingSave();
        expect(storage.saveTask).not.toHaveBeenCalled();

        resetStore();
        await useTaskStore.getState().fetchData({ silent: true });
        let reloaded = useTaskStore.getState();
        expect(reloaded._projectsById.get('project-1')?.status).toBe('active');
        expect(reloaded._tasksById.get('selected')).toMatchObject({
            status: 'next',
            projectId: 'project-1',
            sectionId: 'section-1',
        });
        expect(reloaded._sectionsById.get('section-1')?.deletedAt).toBeUndefined();
        expect(reloaded._allTasks).toHaveLength(5);
        expect(reloaded._tasksById.get('selected')?.recurrence).toEqual({ rule: 'daily' });
        const retiredSibling = reloaded._tasksById.get('archive-owned')!;
        expect(retiredSibling).toMatchObject({
            status: firstArchiveSibling.status,
            completedAt: firstArchiveSibling.completedAt,
            isFocusedToday: firstArchiveSibling.isFocusedToday,
            description: firstArchiveSibling.description,
            rev: (firstArchiveSibling.rev ?? 0) + 1,
        });
        expect(retiredSibling.statusBeforeProjectArchive).toBeUndefined();
        expect(retiredSibling.projectArchivedAt).toBeUndefined();
        expect(reloaded._tasksById.get('genuine-done')).toMatchObject({
            status: 'done',
            completedAt: CREATED_AT,
            description: 'Already complete',
        });
        expect(reloaded._tasksById.get('independently-cancelled')).toMatchObject({
            status: 'archived',
            cancelledAt: '2026-09-02T08:00:00.000Z',
        });
        expect(reloaded._tasksById.get('reference')?.status).toBe('reference');

        const siblingBeforeSecondCycle = cloneValue(retiredSibling);
        const referenceBeforeSecondCycle = cloneValue(reloaded._tasksById.get('reference')!);
        await reloaded.updateProject('project-1', { status: 'archived' });
        await flushPendingSave();
        const secondResult = await useTaskStore.getState().moveTask('selected', 'someday');
        expect(secondResult).toEqual({ success: true });
        await flushPendingSave();

        resetStore();
        await useTaskStore.getState().fetchData({ silent: true });
        reloaded = useTaskStore.getState();
        expect(reloaded._projectsById.get('project-1')?.status).toBe('active');
        expect(reloaded._sectionsById.get('section-1')?.deletedAt).toBeUndefined();
        expect(reloaded._tasksById.get('selected')?.status).toBe('someday');
        expect(reloaded._tasksById.get('archive-owned')).toEqual(siblingBeforeSecondCycle);
        expect(reloaded._tasksById.get('reference')).toEqual(referenceBeforeSecondCycle);
        expect(reloaded._allTasks).toHaveLength(5);
    });

    it('batch-reactivates every final parent and waits for the multi-entity snapshot to persist', async () => {
        let persisted: AppData = {
            tasks: [
                task('task-1', {
                    status: 'done',
                    completedAt: ARCHIVED_AT,
                    statusBeforeProjectArchive: 'next',
                    projectArchivedAt: ARCHIVED_AT,
                    updatedAt: ARCHIVED_AT,
                    rev: 2,
                }),
                task('task-2', {
                    status: 'archived',
                    projectId: 'project-2',
                    sectionId: 'section-2',
                    cancelledAt: ARCHIVED_AT,
                    statusBeforeProjectArchive: 'waiting',
                    projectArchivedAt: ARCHIVED_AT,
                    updatedAt: ARCHIVED_AT,
                    rev: 2,
                }),
            ],
            projects: [
                project({ status: 'archived', updatedAt: ARCHIVED_AT, rev: 2 }),
                project({
                    id: 'project-2',
                    status: 'archived',
                    cancelledAt: ARCHIVED_AT,
                    updatedAt: ARCHIVED_AT,
                    rev: 2,
                }),
            ],
            sections: [
                section({
                    deletedAt: ARCHIVED_AT,
                    projectArchivedAt: ARCHIVED_AT,
                    updatedAt: ARCHIVED_AT,
                    rev: 2,
                }),
                section({
                    id: 'section-2',
                    projectId: 'project-2',
                    deletedAt: ARCHIVED_AT,
                    projectArchivedAt: ARCHIVED_AT,
                    updatedAt: ARCHIVED_AT,
                    rev: 2,
                }),
            ],
            areas: [],
            people: [],
            settings: { deviceId: 'device-a' },
        };
        let releaseSave: (() => void) | undefined;
        const storage: StorageAdapter = {
            getData: vi.fn(async () => cloneData(persisted)),
            saveData: vi.fn((data) => new Promise<void>((resolve) => {
                releaseSave = () => {
                    persisted = cloneData(data);
                    resolve();
                };
            })),
            saveTask: vi.fn(async () => undefined),
        };
        setStorageAdapter(storage);
        resetStore();
        await useTaskStore.getState().fetchData({ silent: true });

        let settled = false;
        const resultPromise = useTaskStore.getState().batchUpdateTasks([
            { id: 'task-1', updates: { status: 'inbox' } },
            { id: 'task-2', updates: { status: 'someday' } },
        ]).then((result) => {
            settled = true;
            return result;
        });
        await vi.waitFor(() => expect(storage.saveData).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        releaseSave?.();

        await expect(resultPromise).resolves.toEqual({ success: true });
        expect(storage.saveTask).not.toHaveBeenCalled();
        expect(persisted.projects.map((item) => item.status)).toEqual(['active', 'active']);
        expect(persisted.projects[1]?.cancelledAt).toBeUndefined();
        expect(persisted.sections.every((item) => !item.deletedAt)).toBe(true);
        expect(persisted.tasks.map((item) => item.status)).toEqual(['inbox', 'someday']);
    });

    it('retries an unrelated failed snapshot without emitting a project-reactivation proof', async () => {
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        let persisted: AppData = {
            tasks: [task('selected', { title: 'Before failed edit' })],
            projects: [project()],
            sections: [section()],
            areas: [],
            people: [],
            settings: { deviceId: 'device-a', theme: 'light' },
        };
        const optimistic: AppData = {
            ...cloneData(persisted),
            tasks: [task('selected', { title: 'Optimistic edited title', rev: 2 })],
            settings: { deviceId: 'device-a', theme: 'dark' },
        };
        const storage: StorageAdapter = {
            getData: vi.fn(async () => cloneData(persisted)),
            saveData: vi.fn(async (data) => {
                persisted = cloneData(data);
            }),
            saveTask: vi.fn(async () => undefined),
        };
        setStorageAdapter(storage);
        resetStore(optimistic);
        useTaskStore.setState({
            persistenceFailure: {
                message: 'Earlier settings snapshot failed',
                failedAt: REOPENED_AT,
                retrying: false,
            },
        });
        const taskBeforeRetry = cloneValue(useTaskStore.getState()._tasksById.get('selected')!);

        await expect(useTaskStore.getState().moveTask('selected', 'next')).resolves.toEqual({ success: true });

        expect(storage.saveData).toHaveBeenCalledTimes(1);
        expect(storage.saveTask).not.toHaveBeenCalled();
        expect(persisted.tasks[0]).toEqual(taskBeforeRetry);
        expect(persisted.settings.theme).toBe('dark');
        expect(useTaskStore.getState()._tasksById.get('selected')).toEqual(taskBeforeRetry);
        expect(logs.filter((entry) => entry.context?.releaseCheck === 'v1.3.0/reopen-project-task')).toEqual([]);
    });

    it('returns a failed durable save and retries the unchanged optimistic state without revision churn', async () => {
        vi.useFakeTimers();
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        const initial: AppData = {
            tasks: [task('selected', {
                status: 'done',
                completedAt: ARCHIVED_AT,
                statusBeforeProjectArchive: 'next',
                projectArchivedAt: ARCHIVED_AT,
                updatedAt: ARCHIVED_AT,
                rev: 2,
            })],
            projects: [project({ status: 'archived', updatedAt: ARCHIVED_AT, rev: 2 })],
            sections: [section({
                deletedAt: ARCHIVED_AT,
                projectArchivedAt: ARCHIVED_AT,
                updatedAt: ARCHIVED_AT,
                rev: 2,
            })],
            areas: [],
            people: [],
            settings: { deviceId: 'device-a' },
        };
        let persisted = cloneData(initial);
        let failSaves = true;
        const storage: StorageAdapter = {
            getData: vi.fn(async () => cloneData(persisted)),
            saveData: vi.fn(async (data) => {
                if (failSaves) throw new Error('disk unavailable');
                persisted = cloneData(data);
            }),
            saveTask: vi.fn(async () => undefined),
        };
        setStorageAdapter(storage);
        resetStore();
        await useTaskStore.getState().fetchData({ silent: true });

        const firstAttempt = useTaskStore.getState().moveTask('selected', 'next');
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(firstAttempt).resolves.toEqual({
            success: false,
            error: 'Failed to save task and project reactivation: disk unavailable',
        });
        expect(useTaskStore.getState().persistenceFailure?.message).toContain('disk unavailable');
        expect(persisted).toEqual(initial);
        expect(logs.filter((entry) => entry.context?.releaseCheck === 'v1.3.0/reopen-project-task')).toEqual([]);

        const optimisticTask = cloneValue(useTaskStore.getState()._tasksById.get('selected')!);
        const optimisticProject = cloneValue(useTaskStore.getState()._projectsById.get('project-1')!);
        const optimisticSection = cloneValue(useTaskStore.getState()._sectionsById.get('section-1')!);
        failSaves = false;

        const retry = useTaskStore.getState().moveTask('selected', 'next');
        await vi.runAllTimersAsync();
        await expect(retry).resolves.toEqual({ success: true });
        expect(useTaskStore.getState().persistenceFailure).toBeNull();
        expect(useTaskStore.getState()._tasksById.get('selected')).toEqual(optimisticTask);
        expect(useTaskStore.getState()._projectsById.get('project-1')).toEqual(optimisticProject);
        expect(useTaskStore.getState()._sectionsById.get('section-1')).toEqual(optimisticSection);
        expect(persisted.tasks[0]).toEqual(optimisticTask);
        expect(persisted.projects[0]).toEqual(optimisticProject);
        expect(persisted.sections[0]).toEqual(optimisticSection);
        expect(logs.filter((entry) => entry.context?.releaseCheck === 'v1.3.0/reopen-project-task')).toEqual([]);
    }, 15_000);
});
