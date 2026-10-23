import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData, Project, Section, Task } from './types';
import type { StorageAdapter } from './storage';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import {
    createProjectToSectionPreviewer,
    getProjectToSectionEligibility,
    prepareProjectToSection,
    previewProjectToSection,
} from './project-to-section';
import { mergeAppData } from './sync';
import { getSequentialProjectTaskCues } from './project-utils';

const NOW = '2026-10-01T12:00:00.000Z';
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, title: id,
    status: 'active', color: '#123456', order: 0, tagIds: [], isSequential: false,
    rev: 1, revBy: 'device', createdAt: NOW, updatedAt: NOW, ...extra });
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id,
    status: 'next', tags: [], contexts: [], projectId: 'source', order: 0,
    rev: 1, revBy: 'device', createdAt: NOW, updatedAt: NOW, ...extra });
const section = (id: string, extra: Partial<Section> = {}): Section => ({ id,
    projectId: 'source', title: id, order: 0, rev: 1, revBy: 'device',
    createdAt: NOW, updatedAt: NOW, ...extra });

describe('project to section', () => {
    let saved: AppData;
    let saveData: ReturnType<typeof vi.fn>;
    let restartedStore: typeof import('./store') | null;

    const rows = (projects: Project[] = [project('source'), project('destination')],
        tasks: Task[] = [], sections: Section[] = []) => {
        useTaskStore.setState({ _allProjects: projects, _allTasks: tasks,
            _allSections: sections, _allAreas: [], settings: { deviceId: 'device' },
            persistenceFailure: null, lastDataChangeAt: 0 });
    };
    const prepare = () => {
        const result = prepareProjectToSection(useTaskStore.getState(), 'source', 'destination', '  New section  ');
        if (!result.ok) throw new Error(result.reason);
        return result.command;
    };

    beforeEach(() => {
        restartedStore = null;
        saved = { tasks: [], projects: [], sections: [], areas: [], settings: { deviceId: 'device' } };
        saveData = vi.fn(async (data: AppData) => { saved = JSON.parse(JSON.stringify(data)) as AppData; });
        setStorageAdapter({ getData: vi.fn(async () => saved), saveData } as StorageAdapter);
        rows();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW));
    });

    afterEach(async () => {
        saveData.mockImplementation(async (data: AppData) => { saved = data; });
        await flushPendingSave();
        resetForTests();
        if (restartedStore) {
            await restartedStore.flushPendingSave();
            restartedStore.resetForTests();
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('blocks each unsupported source and destination shape before writing', () => {
        const sourceCases: Array<[Partial<Project>, string]> = [
            [{ status: 'waiting' }, 'source-inactive'],
            [{ attachments: [{ id: 'a', kind: 'link', title: 'x', url: 'https://example.com', createdAt: NOW, updatedAt: NOW }] }, 'source-attachments'],
            [{ dueDate: '2026-10-02' }, 'source-dates'],
            [{ tagIds: ['tag'] }, 'source-tags'],
            [{ isFocused: true }, 'source-focus'],
            [{ taskSortBy: 'due' }, 'source-sort'],
            [{ viewSectionIds: { next: 'later' } }, 'source-view-sections'],
            [{ cancelledAt: NOW }, 'source-lifecycle'],
        ];
        for (const [patch, reason] of sourceCases) {
            rows([project('source', patch), project('destination')]);
            expect(getProjectToSectionEligibility(useTaskStore.getState(), 'source')).toEqual({ ok: false, reason });
        }
        rows([project('source'), project('destination')], [], [section('live')]);
        expect(getProjectToSectionEligibility(useTaskStore.getState(), 'source')).toEqual({ ok: false, reason: 'source-sections' });
        rows([project('source'), project('destination')], [task('archive-linked', { projectArchivedAt: NOW })]);
        expect(getProjectToSectionEligibility(useTaskStore.getState(), 'source')).toEqual({ ok: false, reason: 'source-lifecycle' });
        rows();
        expect(previewProjectToSection(useTaskStore.getState(), 'source', 'source')).toEqual({ ok: false, reason: 'same-project' });
        expect(previewProjectToSection(useTaskStore.getState(), 'source', 'missing')).toEqual({ ok: false, reason: 'missing-destination' });
        rows([project('source'), project('destination', { status: 'archived' })]);
        expect(previewProjectToSection(useTaskStore.getState(), 'source', 'destination')).toEqual({ ok: false, reason: 'destination-inactive' });
        rows([project('source'), project('destination', { archivedAt: NOW })]);
        expect(previewProjectToSection(useTaskStore.getState(), 'source', 'destination')).toEqual({ ok: false, reason: 'destination-inactive' });
        rows([project('source'), project('destination', { isSequential: true })]);
        expect(previewProjectToSection(useTaskStore.getState(), 'source', 'destination')).toEqual({ ok: false, reason: 'destination-sequential' });
        rows();
        expect(prepareProjectToSection(useTaskStore.getState(), 'source', 'destination', ' ')).toEqual({ ok: false, reason: 'invalid-title' });
        expect(saveData).not.toHaveBeenCalled();
    });

    it.each([undefined, 'project', 'section'] as const)('preserves a sequential source (%s) as an independent section and restores it with Undo', async (sequentialScope) => {
        const source = project('source', { isSequential: true, sequentialScope });
        const destination = project('destination', { isSequential: true, sequentialScope: 'section' });
        const existing = task('existing', { projectId: 'destination', sectionId: 'other', order: 1 });
        rows([source, destination], [task('second', { order: 2 }), existing, task('first', { order: 1 })],
            [section('other', { projectId: 'destination' })]);
        expect(getProjectToSectionEligibility(useTaskStore.getState(), 'source')).toEqual({ ok: true });
        const command = prepare();
        const converted = await useTaskStore.getState().convertProjectToSection(command);
        expect(converted.success).toBe(true);
        expect(saved.projects.find((row) => row.id === 'destination')).toEqual(destination);
        expect(saved.tasks.find((row) => row.id === 'existing')).toEqual(existing);
        const cues = () => getSequentialProjectTaskCues(destination,
            saved.tasks.filter((row) => row.projectId === 'destination'), saved.sections);
        expect(cues().get('first')).toBe('available');
        expect(cues().get('second')).toBe('later');
        expect(cues().get('existing')).toBe('available');
        saved.tasks.find((row) => row.id === 'first')!.status = 'done';
        expect(cues().get('second')).toBe('available');
        expect(cues().get('existing')).toBe('available');
        expect(await useTaskStore.getState().undoProjectToSection(command)).toMatchObject({ success: true });
        expect(saved.projects.find((row) => row.id === 'source')?.isSequential).toBe(true);
        expect(saved.projects.find((row) => row.id === 'source')?.sequentialScope).toBe(sequentialScope);
        expect(saved.tasks.find((row) => row.id === 'first')).toMatchObject({ projectId: 'source', order: 1 });
        expect(saved.tasks.find((row) => row.id === 'second')).toMatchObject({ projectId: 'source', order: 2 });
        expect(saved.projects.find((row) => row.id === 'destination')).toEqual(destination);
    });

    it.each([
        [true, false, undefined, 'destination-section-sequence'],
        [true, true, undefined, 'destination-section-sequence'],
        [true, true, 'project', 'destination-section-sequence'],
        [false, true, 'section', 'destination-sequential'],
    ] as const)('blocks incompatible flow modes (%s, %s, %s)', (sourceSequential, destinationSequential, scope, reason) => {
        rows([project('source', { isSequential: sourceSequential }),
            project('destination', { isSequential: destinationSequential, sequentialScope: scope })]);
        expect(previewProjectToSection(useTaskStore.getState(), 'source', 'destination')).toEqual({ ok: false, reason });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('turns a Sequential source into a Sequential section of a Per section destination (#1429)', async () => {
        rows([project('source', { isSequential: true }),
            project('destination', { isSequential: false, perSectionFlow: true })],
        [task('first', { order: 1 }), task('second', { order: 2 })]);
        const command = prepare();
        expect(await useTaskStore.getState().convertProjectToSection(command)).toMatchObject({ success: true });
        expect(saved.sections.find((row) => row.id === command.sectionId)?.isSequential).toBe(true);
        const destination = saved.projects.find((row) => row.id === 'destination')!;
        const cues = getSequentialProjectTaskCues(destination, saved.tasks, saved.sections);
        expect([cues.get('first'), cues.get('second')]).toEqual(['available', 'later']);

        // A Parallel source lands as an explicit Parallel section.
        rows([project('source'), project('destination', { perSectionFlow: true })], [task('only')]);
        const parallel = prepare();
        expect(parallel.section.isSequential).toBe(false);
    });

    it('refuses confirmation when the destination flow changes', async () => {
        rows([project('source', { isSequential: true }),
            project('destination', { isSequential: true, sequentialScope: 'section' })], [task('first')]);
        const command = prepare();
        useTaskStore.setState({ _allProjects: useTaskStore.getState()._allProjects.map((row) =>
            row.id === 'destination' ? { ...row, sequentialScope: 'project' } : row) });
        expect(await useTaskStore.getState().convertProjectToSection(command)).toMatchObject({ success: false, reason: 'conflict' });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('previews every destination exactly as previewProjectToSection does, for every source', () => {
        const projects = [
            project('source', { areaId: 'area-a', supportNotes: 'notes' }),
            project('plain'), project('in-area', { areaId: 'area-b' }), project('with-sections'),
            project('waiting', { status: 'waiting' }), project('someday', { status: 'someday' }),
            project('archived', { status: 'archived' }), project('archived-at', { archivedAt: NOW }),
            project('cancelled', { cancelledAt: NOW }), project('deleted', { deletedAt: NOW }),
            project('purged', { deletedAt: NOW, purgedAt: NOW }), project('sequential', { isSequential: true }),
            project('section-sequential', { isSequential: true, sequentialScope: 'section' }),
            project('dup'), project('dup', { title: 'dup twin' }),
            project('tagged', { tagIds: ['tag'] }), project('dated', { reviewAt: NOW }),
            project('archive-linked'), project('dead-section-only'),
        ];
        const sections = [section('live', { projectId: 'with-sections' }),
            section('gone', { projectId: 'dead-section-only', deletedAt: NOW })];
        const statuses: Task['status'][] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
        const tasks = [
            ...statuses.map((status, index) => task(`source-${status}`, { status, order: index })),
            task('source-deleted', { status: 'done', deletedAt: NOW }),
            task('source-purged', { status: 'archived', deletedAt: NOW, purgedAt: NOW }),
            task('plain-done', { projectId: 'plain', status: 'done' }),
            task('linked', { projectId: 'archive-linked', statusBeforeProjectArchive: 'next' }),
            task('linked-trashed', { projectId: 'dead-section-only', projectArchivedAt: NOW, deletedAt: NOW }),
            task('loose', { projectId: undefined, status: 'done' }),
        ];
        const state = { _allProjects: projects, _allSections: sections, _allTasks: tasks };
        const ids = [...new Set(projects.map((row) => row.id)), 'missing'];
        let okCount = 0;
        for (const sourceId of ids) {
            const previewDestination = createProjectToSectionPreviewer(state, sourceId);
            for (const destinationId of ids) {
                const expected = previewProjectToSection(state, sourceId, destinationId);
                if (expected.ok) okCount += 1;
                expect(previewDestination(destinationId), `${sourceId} -> ${destinationId}`).toEqual(expected);
            }
        }
        // The fixture must reach the success branch with real counts, not only blocked paths.
        expect(okCount).toBeGreaterThan(4);
        expect(createProjectToSectionPreviewer(state, 'source')('in-area')).toMatchObject({
            ok: true, taskCount: 7, completedCount: 1, archivedCount: 1 });
    });

    it('moves every live status in source order, preserves content, leaves Trash and deleted sections, and saves one snapshot', async () => {
        const attachment = { id: 'file', kind: 'file' as const, title: 'report', path: '/documents/report', createdAt: NOW, updatedAt: NOW };
        const recurrence = { frequency: 'daily' as const, interval: 1 };
        rows([project('source', { title: 'Plan', supportNotes: '  exact\nnotes  ', areaId: 'old' }),
            project('destination', { title: 'Destination', areaId: 'new' })], [
            task('late', { order: 9, status: 'archived', archivedAt: NOW, attachments: [attachment] }),
            task('first', { order: 1, status: 'done', completedAt: NOW, recurrence }),
            task('middle', { order: 5, status: 'waiting', description: 'Keep me', areaId: 'old', sectionId: 'deleted' }),
            task('trashed', { deletedAt: NOW, order: 2 }),
            task('existing', { projectId: 'destination', order: 20 }),
        ], [section('deleted', { deletedAt: NOW })]);
        const command = prepare();
        expect(command.preview).toMatchObject({ taskCount: 3, completedCount: 1, archivedCount: 1 });
        expect(command.tasks.map(({ before }) => before.id)).toEqual(['first', 'middle', 'late']);
        const result = await useTaskStore.getState().convertProjectToSection(command);
        expect(result.success).toBe(true);
        expect(saveData).toHaveBeenCalledTimes(1);
        expect(saved.sections).toHaveLength(2);
        expect(saved.sections.find((row) => row.id === command.sectionId)).toMatchObject({
            title: 'New section', description: '  exact\nnotes  ', projectId: 'destination' });
        expect(saved.projects.find((row) => row.id === 'source')?.deletedAt).toBe(NOW);
        expect(saved.tasks.find((row) => row.id === 'trashed')).toEqual(command.sourceTasks.find((row) => row.id === 'trashed'));
        expect(saved.sections.find((row) => row.id === 'deleted')).toEqual(command.sourceSections[0]);
        expect(saved.tasks.filter((row) => ['first', 'middle', 'late'].includes(row.id)).map((row) => row.id).sort())
            .toEqual(['first', 'late', 'middle']);
        for (const { before, after } of command.tasks) {
            const persisted = saved.tasks.find((row) => row.id === before.id)!;
            expect(persisted).toMatchObject({ id: before.id, title: before.title, status: before.status,
                projectId: 'destination', sectionId: command.sectionId, order: after.order });
            expect(persisted.areaId).toBeUndefined();
            expect(persisted.attachments).toEqual(before.attachments);
            expect(persisted.recurrence).toEqual(before.recurrence);
        }
        expect(command.tasks.map(({ after }) => after.order)).toEqual([21, 22, 23]);
        expect(saved.tasks).toHaveLength(5); // no recurring follow-up
        expect(await useTaskStore.getState().convertProjectToSection(command)).toMatchObject({ success: true });
        expect(useTaskStore.getState()._allSections.filter((row) => row.id === command.sectionId)).toHaveLength(1);
    });

    it('refuses a stale confirmation after source, destination, child, or membership changes', async () => {
        const initial = [task('child')];
        const mutate = [
            () => rows([project('source', { title: 'Changed' }), project('destination')], initial),
            () => rows([project('source'), project('destination', { title: 'Changed' })], initial),
            () => rows([project('source'), project('destination')], [task('child', { title: 'Changed' })]),
            () => rows([project('source'), project('destination')], [...initial, task('new')]),
            () => rows([project('source'), project('destination')], [...initial, task('new-dest', { projectId: 'destination' })]),
            () => rows([project('source'), project('destination')], initial, [section('new')]),
        ];
        for (const change of mutate) {
            rows([project('source'), project('destination')], initial);
            const command = prepare();
            change();
            expect(await useTaskStore.getState().convertProjectToSection(command)).toMatchObject({ success: false, reason: 'conflict' });
            expect(useTaskStore.getState()._allSections.some((row) => row.id === command.sectionId)).toBe(false);
        }
        expect(saveData).not.toHaveBeenCalled();
    });

    it('keeps a deleted source task in Trash when converted data merges with a stale peer', async () => {
        rows(undefined, [task('live'), task('trashed', { deletedAt: NOW })]);
        const before: AppData = { tasks: structuredClone(useTaskStore.getState()._allTasks),
            projects: structuredClone(useTaskStore.getState()._allProjects),
            sections: [], areas: [], settings: { deviceId: 'device' } };
        const command = prepare();
        expect((await useTaskStore.getState().convertProjectToSection(command)).success).toBe(true);
        const merged = mergeAppData(saved, before);
        expect(merged.tasks.find((row) => row.id === 'live')).toMatchObject({
            projectId: 'destination', sectionId: command.sectionId });
        const trashed = merged.tasks.find((row) => row.id === 'trashed');
        expect(trashed?.deletedAt).toBeDefined();
        expect(trashed?.sectionId).not.toBe(command.sectionId);
        expect(merged.tasks.filter((row) => row.id === 'trashed')).toHaveLength(1);
    });

    it('undoes owned fields while retaining later title/status edits, and refuses superseded assignments or new content', async () => {
        rows(undefined, [task('child')]);
        const command = prepare();
        const converted = await useTaskStore.getState().convertProjectToSection(command);
        if (!converted.success) throw new Error(converted.error);
        const edited = useTaskStore.getState()._allTasks.map((row) => row.id === 'child'
            ? { ...row, title: 'Edited later', status: 'done' as const, rev: nextRev(row.rev) } : row);
        useTaskStore.setState({ _allTasks: edited });
        const undone = await useTaskStore.getState().undoProjectToSection(converted.receipt);
        expect(undone).toEqual({ success: true, sourceProjectId: 'source' });
        expect(saved.tasks.find((row) => row.id === 'child')).toMatchObject({
            title: 'Edited later', status: 'done', projectId: 'source' });
        expect(saved.sections.find((row) => row.id === command.sectionId)?.deletedAt).toBe(NOW);
        expect(saved.projects.find((row) => row.id === 'source')?.deletedAt).toBeUndefined();
        expect(await useTaskStore.getState().undoProjectToSection(converted.receipt)).toMatchObject({ success: true });

        rows(undefined, [task('child')]);
        const another = prepare();
        const second = await useTaskStore.getState().convertProjectToSection(another);
        if (!second.success) throw new Error(second.error);
        useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks,
            task('new-content', { projectId: 'destination', sectionId: another.sectionId })] });
        expect(await useTaskStore.getState().undoProjectToSection(second.receipt)).toMatchObject({ success: false, reason: 'conflict' });
        useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.filter((row) => row.id !== 'new-content')
            .map((row) => row.id === 'child' ? { ...row, sectionId: undefined } : row) });
        expect(await useTaskStore.getState().undoProjectToSection(second.receipt)).toMatchObject({ success: false, reason: 'conflict' });
        useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((row) => row.id === 'child'
            ? { ...row, sectionId: another.sectionId, purgedAt: NOW } : row) });
        expect(await useTaskStore.getState().undoProjectToSection(second.receipt)).toMatchObject({ success: false, reason: 'conflict' });
    });

    it('retries a failed save with the same section ID and refuses a newer assignment', async () => {
        rows(undefined, [task('child')]);
        const command = prepare();
        saveData.mockRejectedValue(new Error('disk full'));
        const pending = useTaskStore.getState().convertProjectToSection(command);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await pending).toMatchObject({ success: false, reason: 'save-failed' });
        expect(useTaskStore.getState()._allSections.filter((row) => row.id === command.sectionId)).toHaveLength(1);
        saveData.mockImplementation(async (data: AppData) => { saved = JSON.parse(JSON.stringify(data)) as AppData; });
        expect(await useTaskStore.getState().convertProjectToSection(command)).toMatchObject({ success: true });
        expect(saved.sections.filter((row) => row.id === command.sectionId)).toHaveLength(1);
        useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((row) => row.id === 'child'
            ? { ...row, sectionId: undefined, rev: nextRev(row.rev) } : row) });
        expect(await useTaskStore.getState().convertProjectToSection(command)).toMatchObject({ success: false, reason: 'conflict' });
        expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'child')?.sectionId).toBeUndefined();
    });

    it('returns conflict when a task assignment or source row is superseded during the save', async () => {
        for (const change of ['assignment', 'source'] as const) {
            rows(undefined, [task('child')]);
            const command = prepare();
            let finishSave: (() => void) | undefined;
            saveData.mockImplementation(() => new Promise<void>((resolve) => { finishSave = resolve; }));
            const pending = useTaskStore.getState().convertProjectToSection(command);
            await vi.advanceTimersByTimeAsync(0);
            expect(finishSave).toBeDefined();
            if (change === 'assignment') {
                useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((row) => row.id === 'child'
                    ? { ...row, projectId: 'other', sectionId: undefined, rev: nextRev(row.rev) } : row) });
            } else {
                useTaskStore.setState({ _allProjects: useTaskStore.getState()._allProjects.map((row) => row.id === 'source'
                    ? { ...row, title: 'Newer title', rev: nextRev(row.rev) } : row) });
            }
            finishSave!();
            expect(await pending).toMatchObject({ success: false, reason: 'conflict' });
            expect(useTaskStore.getState()._allTasks.filter((row) => row.id === 'child')).toHaveLength(1);
            if (change === 'assignment') expect(useTaskStore.getState()._allTasks[0].projectId).toBe('other');
            else expect(useTaskStore.getState()._allProjects.find((row) => row.id === 'source')?.title).toBe('Newer title');
        }
    });

    it('replays the frozen command after an ambiguous save persisted and then rejected', async () => {
        rows(undefined, [task('child')]);
        const command = prepare();
        saveData.mockImplementation(async (data: AppData) => {
            saved = JSON.parse(JSON.stringify(data)) as AppData;
            throw new Error('reply lost after commit');
        });
        const pending = useTaskStore.getState().convertProjectToSection(command);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await pending).toMatchObject({ success: false, reason: 'save-failed' });
        expect(saved.sections.filter((row) => row.id === command.sectionId)).toHaveLength(1);
        const serializedCommand = JSON.parse(JSON.stringify(command)) as typeof command;
        vi.resetModules();
        restartedStore = await import('./store');
        restartedStore.setStorageAdapter({ getData: vi.fn(async () => saved),
            saveData: vi.fn(async (data: AppData) => { saved = data; }) } as StorageAdapter);
        await restartedStore.useTaskStore.getState().fetchData({ throwOnError: true });
        expect(await restartedStore.useTaskStore.getState().convertProjectToSection(serializedCommand))
            .toMatchObject({ success: true, sectionId: command.sectionId });
        expect(restartedStore.useTaskStore.getState()._allSections.filter((row) => row.id === command.sectionId))
            .toHaveLength(1);
    });

    it('replays a persisted conversion after reload and retries Undo after a failed save', async () => {
        rows(undefined, [task('child')]);
        const command = prepare();
        expect((await useTaskStore.getState().convertProjectToSection(command)).success).toBe(true);
        const serializedCommand = JSON.parse(JSON.stringify(command)) as typeof command;
        vi.resetModules();
        restartedStore = await import('./store');
        restartedStore.setStorageAdapter({ getData: vi.fn(async () => saved), saveData } as StorageAdapter);
        await restartedStore.useTaskStore.getState().fetchData({ throwOnError: true });
        expect(restartedStore.useTaskStore.getState()._allProjects.find((row) => row.id === 'source')).toEqual(command.source.after);
        expect(restartedStore.useTaskStore.getState()._allSections.find((row) => row.id === command.sectionId)).toEqual(command.section);
        expect(await restartedStore.useTaskStore.getState().convertProjectToSection(serializedCommand)).toMatchObject({ success: true });
        expect(restartedStore.useTaskStore.getState()._allSections.filter((row) => row.id === command.sectionId)).toHaveLength(1);
        saveData.mockRejectedValue(new Error('disk full'));
        const pending = restartedStore.useTaskStore.getState().undoProjectToSection(serializedCommand);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await pending).toMatchObject({ success: false, reason: 'save-failed' });
        saveData.mockImplementation(async (data: AppData) => { saved = JSON.parse(JSON.stringify(data)) as AppData; });
        expect(await restartedStore.useTaskStore.getState().undoProjectToSection(serializedCommand)).toMatchObject({ success: true });
        expect(saved.sections.filter((row) => row.id === command.sectionId)).toHaveLength(1);
        expect(saved.sections.find((row) => row.id === command.sectionId)?.deletedAt).toBeDefined();
    });
});

const nextRev = (rev?: number) => (rev ?? 0) + 1;
