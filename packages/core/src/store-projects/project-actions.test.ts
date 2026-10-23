import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from '../store';
import type { StorageAdapter } from '../storage';
import type { AppData } from '../types';
import { buildNewProject, projectAreaSelection } from './project-actions';
import { buildProjectViewSectionUpdate } from '../view-sections';
import * as logger from '../logger';
import type { Project, Section } from '../types';

const BASE_NOW = '2026-06-14T12:00:00.000Z';

describe('project actions', () => {
    let saveData: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        saveData = vi.fn().mockResolvedValue(undefined);
        const storage: StorageAdapter = {
            getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData,
        };
        setStorageAdapter(storage);
        useTaskStore.setState({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
            isLoading: false,
            error: null,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _tasksById: new Map(),
            _projectsById: new Map(),
            _sectionsById: new Map(),
            _areasById: new Map(),
            lastDataChangeAt: 0,
        });
        vi.useFakeTimers();
        vi.setSystemTime(new Date(BASE_NOW));
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const latestSavedData = (): AppData => {
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData | undefined;
        expect(saved).toBeDefined();
        return saved!;
    };

    it('builds new projects with shared add/promote defaults', () => {
        const existingProject = {
            id: 'project-existing',
            title: 'Existing',
            status: 'active' as const,
            color: '#111111',
            order: 4,
            areaId: 'area-1',
            tagIds: [],
            createdAt: BASE_NOW,
            updatedAt: BASE_NOW,
        };

        const existingArea = {
            id: 'area-1',
            name: 'Home',
            order: 0,
            createdAt: BASE_NOW,
            updatedAt: BASE_NOW,
        };

        const somedayProject = buildNewProject({
            title: 'Parked',
            initialProps: { status: 'someday', isFocused: true },
            existingProjects: [],
            existingAreas: [],
            settings: {},
            deviceId: 'device-1',
            now: BASE_NOW,
        });
        expect(somedayProject.status).toBe('someday');
        expect(somedayProject.isFocused).toBe(false);

        const project = buildNewProject({
            title: '  Launch  ',
            color: '#3b82f6',
            initialProps: { areaId: 'area-1', tagIds: ['#launch'] },
            existingProjects: [existingProject],
            existingAreas: [existingArea],
            settings: { gtd: { defaultProjectFlowMode: 'sequential' } },
            deviceId: 'device-1',
            now: BASE_NOW,
            id: 'project-new',
        });

        expect(project).toMatchObject({
            id: 'project-new',
            title: 'Launch',
            color: '#3b82f6',
            order: 5,
            areaId: 'area-1',
            status: 'active',
            rev: 1,
            revBy: 'device-1',
            createdAt: BASE_NOW,
            updatedAt: BASE_NOW,
            isSequential: true,
            isFocused: false,
            tagIds: ['#launch'],
            // Denormalized copy of the area name; omitting it leaves a project
            // the sync merge has to repair on the next cycle.
            areaTitle: 'Home',
        });

        const explicitParallelProject = buildNewProject({
            title: 'Parallel',
            color: '#22c55e',
            initialProps: { isSequential: false },
            existingProjects: [],
            existingAreas: [],
            settings: { gtd: { defaultProjectFlowMode: 'sequential' } },
            deviceId: 'device-1',
            now: BASE_NOW,
            id: 'project-parallel',
        });

        expect(explicitParallelProject.isSequential).toBe(false);
    });

    it('keeps RN own Area selection distinct from omission and honors an explicit finite order', () => {
        const source = { id: 'source', title: 'Source', status: 'active' as const, color: '#3b82f6',
            areaId: 'a', areaTitle: 'Area A', order: 1, tagIds: [], createdAt: BASE_NOW, updatedAt: BASE_NOW };
        const target = { ...source, id: 'target', areaId: 'b', areaTitle: 'Area B', order: 7 };
        const tombstone = { ...target, id: 'deleted', order: 9, deletedAt: BASE_NOW };
        const areas = [{ id: 'a', name: 'Area A', order: 0, createdAt: BASE_NOW, updatedAt: BASE_NOW },
            { id: 'b', name: ' Area B ', order: 1, createdAt: BASE_NOW, updatedAt: BASE_NOW }];
        expect(projectAreaSelection(source, { title: 'Renamed' }, [source, target, tombstone], areas))
            .toEqual({ selected: false, metadataChanged: false, fields: {}, order: undefined });
        expect(projectAreaSelection(source, { areaId: 'b' }, [source, target, tombstone], areas))
            .toEqual({ selected: true, metadataChanged: true,
                fields: { areaId: 'b', areaTitle: 'Area B', color: '#94a3b8' }, order: 10 });
        expect(projectAreaSelection(source, { areaId: 'b', order: 3 }, [source, target, tombstone], areas))
            .toMatchObject({ fields: { areaId: 'b', areaTitle: 'Area B' }, order: 3 });
        expect(projectAreaSelection(source, { areaId: undefined }, [source, target, tombstone], areas))
            .toMatchObject({ selected: true, fields: { areaId: undefined, areaTitle: undefined }, order: 0 });
    });

    it('allows the same project title in different areas', async () => {
        const { addArea, addProject } = useTaskStore.getState();
        const home = await addArea('Home');
        const work = await addArea('Work');
        expect(home).not.toBeNull();
        expect(work).not.toBeNull();
        if (!home || !work) return;

        const homeProject = await addProject('Launch', '#3b82f6', { areaId: home.id });
        const workProject = await addProject('Launch', '#22c55e', { areaId: work.id });
        const repeatedHomeProject = await addProject(' launch ', '#ef4444', { areaId: home.id });

        expect(homeProject).not.toBeNull();
        expect(workProject).not.toBeNull();
        expect(homeProject?.id).not.toBe(workProject?.id);
        expect(repeatedHomeProject?.id).toBe(homeProject?.id);
        expect(useTaskStore.getState()._allProjects).toHaveLength(2);
        expect(workProject).toMatchObject({
            title: 'Launch',
            color: '#22c55e',
            areaId: work.id,
        });
    });

    it('deletes the project while detaching live tasks from its project and sections', async () => {
        const { addProject, addSection, addTask, deleteProject, deleteTask } = useTaskStore.getState();
        const project = await addProject('Launch', '#3b82f6');
        expect(project).not.toBeNull();
        if (!project) return;
        const section = await addSection(project.id, 'Planning');
        expect(section).not.toBeNull();
        if (!section) return;

        const taskResult = await addTask('Project task', {
            projectId: project.id,
            sectionId: section.id,
            status: 'next',
        });
        const deletedTaskResult = await addTask('Already deleted task', {
            projectId: project.id,
            sectionId: section.id,
            status: 'next',
        });
        expect(taskResult.success).toBe(true);
        expect(deletedTaskResult.success).toBe(true);
        if (!taskResult.success || !deletedTaskResult.success) return;

        vi.setSystemTime(new Date('2026-06-14T12:05:00.000Z'));
        await deleteTask(deletedTaskResult.id);
        const deletedTaskBeforeProjectDelete = useTaskStore.getState()._allTasks.find((task) => task.id === deletedTaskResult.id);
        expect(deletedTaskBeforeProjectDelete?.deletedAt).toBe('2026-06-14T12:05:00.000Z');

        vi.setSystemTime(new Date(BASE_NOW));
        await deleteProject(project.id);
        await flushPendingSave();

        const state = useTaskStore.getState();
        expect(state.projects).toEqual([]);
        expect(state.sections).toEqual([]);
        expect(state.tasks.map((task) => task.id)).toEqual([taskResult.id]);

        const saved = latestSavedData();
        expect(saved.projects.find((item) => item.id === project.id)).toMatchObject({
            deletedAt: BASE_NOW,
            updatedAt: BASE_NOW,
        });
        expect(saved.sections.find((item) => item.id === section.id)).toMatchObject({
            deletedAt: BASE_NOW,
            updatedAt: BASE_NOW,
        });
        const savedTask = saved.tasks.find((task) => task.id === taskResult.id);
        expect(savedTask).toMatchObject({
            projectId: undefined,
            sectionId: undefined,
            deletedAt: undefined,
            updatedAt: BASE_NOW,
        });
        expect(savedTask?.rev).toBe(2);
        expect(saved.tasks.find((task) => task.id === deletedTaskResult.id)?.deletedAt).toBe('2026-06-14T12:05:00.000Z');
    });

    it('clears remote attachment metadata when duplicating a project', async () => {
        const { addProject, addTask, duplicateProject } = useTaskStore.getState();
        const project = await addProject('Launch', '#3b82f6', {
            attachments: [{
                id: 'project-attachment',
                kind: 'file',
                title: 'Project brief',
                uri: 'file:///project-brief.pdf',
                createdAt: BASE_NOW,
                updatedAt: BASE_NOW,
                cloudKey: 'attachments/project-brief.pdf',
                fileHash: 'project-hash',
                localStatus: 'available',
                contentRev: 3,
                contentMtimeMs: 1750000000000,
                contentSize: 4096,
            }],
        });
        expect(project).not.toBeNull();
        if (!project) return;

        const taskResult = await addTask('Project task', {
            projectId: project.id,
            status: 'next',
            attachments: [{
                id: 'task-attachment',
                kind: 'file',
                title: 'Task brief',
                uri: 'file:///task-brief.pdf',
                createdAt: BASE_NOW,
                updatedAt: BASE_NOW,
                cloudKey: 'attachments/task-brief.pdf',
                fileHash: 'task-hash',
                localStatus: 'available',
                contentRev: 2,
                contentMtimeMs: 1750000000000,
                contentSize: 2048,
            }],
        });
        expect(taskResult.success).toBe(true);
        if (!taskResult.success) return;

        const duplicatedProject = await duplicateProject(project.id);
        expect(duplicatedProject).not.toBeNull();
        if (!duplicatedProject) return;

        const state = useTaskStore.getState();
        const copiedProjectAttachment = state._allProjects
            .find((item) => item.id === duplicatedProject.id)
            ?.attachments?.[0];
        expect(copiedProjectAttachment).toMatchObject({
            title: 'Project brief',
            uri: 'file:///project-brief.pdf',
            createdAt: BASE_NOW,
            updatedAt: BASE_NOW,
        });
        expect(copiedProjectAttachment?.id).not.toBe('project-attachment');
        expect(copiedProjectAttachment?.cloudKey).toBeUndefined();
        expect(copiedProjectAttachment?.fileHash).toBeUndefined();
        expect(copiedProjectAttachment?.localStatus).toBeUndefined();
        expect(copiedProjectAttachment?.contentRev).toBeUndefined();
        expect(copiedProjectAttachment?.contentMtimeMs).toBeUndefined();
        expect(copiedProjectAttachment?.contentSize).toBeUndefined();

        const copiedTaskAttachment = state._allTasks
            .find((task) => task.projectId === duplicatedProject.id)
            ?.attachments?.[0];
        expect(copiedTaskAttachment).toMatchObject({
            title: 'Task brief',
            uri: 'file:///task-brief.pdf',
            createdAt: BASE_NOW,
            updatedAt: BASE_NOW,
        });
        expect(copiedTaskAttachment?.id).not.toBe('task-attachment');
        expect(copiedTaskAttachment?.cloudKey).toBeUndefined();
        expect(copiedTaskAttachment?.fileHash).toBeUndefined();
        expect(copiedTaskAttachment?.localStatus).toBeUndefined();
        expect(copiedTaskAttachment?.contentRev).toBeUndefined();
        expect(copiedTaskAttachment?.contentMtimeMs).toBeUndefined();
        expect(copiedTaskAttachment?.contentSize).toBeUndefined();
    });

    it('keeps reference tasks as reference (not next) when duplicating a project', async () => {
        const { addProject, addSection, addTask, duplicateProject } = useTaskStore.getState();
        const project = await addProject('Template', '#3b82f6');
        expect(project).not.toBeNull();
        if (!project) return;
        const section = await addSection(project.id, 'Notes');
        expect(section).not.toBeNull();
        if (!section) return;

        const referenceTaskResult = await addTask('Reference notes', {
            projectId: project.id,
            sectionId: section.id,
            status: 'reference',
            dueDate: BASE_NOW,
            checklist: [{ id: 'item-1', title: 'Read this', isCompleted: true }],
        });
        const doneTaskResult = await addTask('Done task', {
            projectId: project.id,
            sectionId: section.id,
            status: 'done',
        });
        const nextTaskResult = await addTask('Next task', {
            projectId: project.id,
            sectionId: section.id,
            status: 'next',
        });
        expect(referenceTaskResult.success).toBe(true);
        expect(doneTaskResult.success).toBe(true);
        expect(nextTaskResult.success).toBe(true);
        if (!referenceTaskResult.success || !doneTaskResult.success || !nextTaskResult.success) return;

        const duplicatedProject = await duplicateProject(project.id);
        expect(duplicatedProject).not.toBeNull();
        if (!duplicatedProject) return;

        const copiedTasks = useTaskStore
            .getState()
            ._allTasks.filter((task) => task.projectId === duplicatedProject.id);
        const copiedSectionId = useTaskStore
            .getState()
            ._allSections.find((sec) => sec.projectId === duplicatedProject.id)?.id;
        expect(copiedSectionId).toBeDefined();

        const copiedReference = copiedTasks.find((task) => task.title === 'Reference notes');
        expect(copiedReference).toMatchObject({
            status: 'reference',
            sectionId: copiedSectionId,
            dueDate: undefined,
        });
        expect(copiedReference?.checklist?.[0]).toMatchObject({ isCompleted: false });
        expect(copiedReference?.checklist?.[0].id).not.toBe('item-1');

        const copiedDone = copiedTasks.find((task) => task.title === 'Done task');
        expect(copiedDone).toMatchObject({ status: 'next', sectionId: copiedSectionId });

        const copiedNext = copiedTasks.find((task) => task.title === 'Next task');
        expect(copiedNext).toMatchObject({ status: 'next', sectionId: copiedSectionId });
    });

    it('moves a Project to the destination Area and appends a cleared Project to No Area', async () => {
        const { addArea, addProject, updateProject } = useTaskStore.getState();
        const alpha = await addArea('Alpha');
        const beta = await addArea('Beta');
        if (!alpha || !beta) throw new Error('Area setup failed');
        const moving = await addProject('Moving', '#3b82f6', { areaId: alpha.id, order: 4,
            supportNotes: 'keep raw notes' });
        const inBeta = await addProject('Existing Beta', '#22c55e', { areaId: beta.id, order: 7 });
        const noArea = await addProject('Existing No Area', '#ef4444', { order: 9 });
        if (!moving || !inBeta || !noArea) throw new Error('Project setup failed');
        const otherBefore = [inBeta.id, noArea.id].map((id) =>
            structuredClone(useTaskStore.getState()._allProjects.find((row) => row.id === id)!));

        expect(await updateProject(moving.id, { areaId: beta.id })).toEqual({ success: true });
        await flushPendingSave();
        const moved = useTaskStore.getState()._allProjects.find((row) => row.id === moving.id);
        expect(moved).toMatchObject({ areaId: beta.id, areaTitle: 'Beta', order: 8,
            supportNotes: 'keep raw notes' });
        expect(latestSavedData().projects.find((row) => row.id === moving.id)).toEqual(moved);

        expect(await updateProject(moving.id, { areaId: undefined })).toEqual({ success: true });
        await flushPendingSave();
        const cleared = useTaskStore.getState()._allProjects.find((row) => row.id === moving.id);
        expect(cleared?.areaId).toBeUndefined();
        expect(cleared?.areaTitle).toBeUndefined();
        expect(cleared?.order).toBe(10);
        expect(cleared?.supportNotes).toBe('keep raw notes');
        expect(latestSavedData().projects.find((row) => row.id === moving.id)).toEqual(cleared);
        expect([inBeta.id, noArea.id].map((id) =>
            useTaskStore.getState()._allProjects.find((row) => row.id === id))).toEqual(otherBefore);
    });

    it('places a Someday project in a view section with a stamped rev, keeping it across reactivation (#1319)', async () => {
        const { addProject, addTask, updateProject } = useTaskStore.getState();
        const project = await addProject('Trip', '#3b82f6', { status: 'someday' });
        if (!project) throw new Error('Project setup failed');
        await addTask('Pack', { projectId: project.id, status: 'next' });
        const before = useTaskStore.getState()._allProjects.find((row) => row.id === project.id)!;
        const tasksBefore = structuredClone(useTaskStore.getState()._allTasks);

        const update = buildProjectViewSectionUpdate(before, 'someday', 'travel');
        expect(update).toEqual({ viewSectionIds: { someday: 'travel' } });
        expect(await updateProject(project.id, update!)).toEqual({ success: true });
        await flushPendingSave();
        const placed = useTaskStore.getState()._allProjects.find((row) => row.id === project.id)!;
        expect(placed.viewSectionIds).toEqual({ someday: 'travel' });
        expect(placed.rev).toBe((before.rev ?? 0) + 1);
        expect(placed.revBy).toBeTruthy();
        expect(latestSavedData().projects.find((row) => row.id === project.id)).toEqual(placed);
        // The section is the project's own; its tasks are never written.
        expect(useTaskStore.getState()._allTasks).toEqual(tasksBefore);
        expect(buildProjectViewSectionUpdate(placed, 'someday', 'travel')).toBeNull();

        expect(await updateProject(project.id, { status: 'active' })).toEqual({ success: true });
        expect(useTaskStore.getState()._allProjects.find((row) => row.id === project.id)?.viewSectionIds)
            .toEqual({ someday: 'travel' });
        expect(await updateProject(project.id, { status: 'someday' })).toEqual({ success: true });
        const reparked = useTaskStore.getState()._allProjects.find((row) => row.id === project.id)!;
        expect(reparked.viewSectionIds).toEqual({ someday: 'travel' });

        expect(await updateProject(project.id, buildProjectViewSectionUpdate(reparked, 'someday')!)).toEqual({ success: true });
        expect(useTaskStore.getState()._allProjects.find((row) => row.id === project.id)?.viewSectionIds).toEqual({});
    });

    it('switches Flow mode in one write, stamps section defaults, and keeps stored choices (#1429)', async () => {
        const at = '2026-06-01T00:00:00.000Z';
        const project: Project = { id: 'trip', title: 'Camping Trip', status: 'active', color: '#6B7280', order: 0,
            tagIds: [], isSequential: true, sequentialScope: 'section', rev: 3, revBy: 'peer', createdAt: at, updatedAt: at };
        const sections: Section[] = [
            { id: 'book', projectId: 'trip', title: 'Book campsite', order: 0, rev: 1, createdAt: at, updatedAt: at },
            { id: 'prep', projectId: 'trip', title: 'Prep', order: 1, isSequential: false, rev: 1, createdAt: at, updatedAt: at },
        ];
        useTaskStore.setState({ _allProjects: [project], _projectsById: new Map([[project.id, project]]),
            _allSections: sections, _sectionsById: new Map(sections.map((row) => [row.id, row])) });
        const info = vi.spyOn(logger, 'logInfo');
        const { setProjectFlowMode, updateSection } = useTaskStore.getState();

        expect(await setProjectFlowMode('trip', 'perSection')).toEqual({ success: true });
        let saved = latestSavedData();
        expect(saved.projects[0]).toMatchObject({ isSequential: false, perSectionFlow: true, sequentialScope: 'section', rev: 4 });
        // The unset section keeps the within-sections behavior; the stored Parallel choice stays.
        expect(saved.sections.map((row) => [row.id, row.isSequential, row.rev])).toEqual([['book', true, 2], ['prep', false, 1]]);
        expect(info).toHaveBeenCalledWith('Project flow mode saved', expect.objectContaining({
            context: { releaseCheck: 'v1.3.7/section-flow-mode', mode: 'perSection', sectionDefaults: 1 },
        }));

        expect(await updateSection('prep', { isSequential: true })).toEqual({ success: true });
        expect(info).toHaveBeenCalledWith('Project flow mode saved', expect.objectContaining({
            context: { releaseCheck: 'v1.3.7/section-flow-mode', mode: 'sectionSequential', sectionDefaults: 0 },
        }));

        expect(await setProjectFlowMode('trip', 'sequential')).toEqual({ success: true });
        saved = latestSavedData();
        expect(saved.projects[0]).toMatchObject({ isSequential: true, perSectionFlow: false });
        expect(saved.sections.map((row) => row.isSequential)).toEqual([true, true]);

        expect(await setProjectFlowMode('trip', 'perSection')).toEqual({ success: true });
        saved = latestSavedData();
        expect(saved.projects[0]).toMatchObject({ isSequential: false, perSectionFlow: true });
        expect(saved.sections.map((row) => [row.isSequential, row.rev])).toEqual([[true, 2], [true, 2]]);
        const writes = saveData.mock.calls.length;
        expect(await setProjectFlowMode('trip', 'perSection')).toEqual({ success: true });
        expect(saveData.mock.calls.length).toBe(writes);
        expect(await setProjectFlowMode('missing', 'parallel')).toEqual({ success: false, error: 'Project not found' });
    });

    it('keeps the sequencing sets stable across section edits that do not change them (#1429)', async () => {
        const at = '2026-06-01T00:00:00.000Z';
        const project: Project = { id: 'trip', title: 'Camping Trip', status: 'active', color: '#6B7280', order: 0,
            tagIds: [], perSectionFlow: true, rev: 1, createdAt: at, updatedAt: at };
        const sections: Section[] = [
            { id: 'book', projectId: 'trip', title: 'Book campsite', order: 0, isSequential: true, rev: 1, createdAt: at, updatedAt: at },
            { id: 'prep', projectId: 'trip', title: 'Prep', order: 1, rev: 1, createdAt: at, updatedAt: at },
        ];
        useTaskStore.setState({ _allProjects: [project], _projectsById: new Map([[project.id, project]]),
            _allSections: sections, _sectionsById: new Map(sections.map((row) => [row.id, row])) });
        const sets = () => {
            const derived = useTaskStore.getState().getDerivedState();
            return [derived.sequentialProjectIds, derived.sequentialWithinSectionProjectIds, derived.sequentialSectionKeys];
        };
        const before = sets();
        expect([...before[2]]).toEqual(['trip:book']);
        const { updateSection, reorderSections } = useTaskStore.getState();
        await updateSection('prep', { title: 'Pack' });
        await updateSection('book', { isCollapsed: true });
        await reorderSections('trip', ['prep', 'book']);
        const after = sets();
        after.forEach((set, index) => expect(set).toBe(before[index]));
        await updateSection('prep', { isSequential: true });
        const changed = sets();
        expect(changed[2]).not.toBe(before[2]);
        expect([...changed[2]].sort()).toEqual(['trip:book', 'trip:prep']);
        expect(changed[0]).toBe(before[0]);
    });

    it('does not treat an omitted Area patch or a same-Area selection as a move', async () => {
        const { addArea, addProject, updateProject } = useTaskStore.getState();
        const area = await addArea('Alpha');
        if (!area) throw new Error('Area setup failed');
        const project = await addProject('Project', '#3b82f6', { areaId: area.id, order: 4 });
        if (!project) throw new Error('Project setup failed');
        useTaskStore.setState((state) => ({
            _allProjects: state._allProjects.map((row) => row.id === project.id
                ? { ...row, areaTitle: 'legacy title' } : row),
        }));
        expect(await updateProject(project.id, { title: 'Renamed' })).toEqual({ success: true });
        const afterOmitted = useTaskStore.getState()._allProjects.find((row) => row.id === project.id);
        expect(afterOmitted).toMatchObject({ title: 'Renamed', areaId: area.id,
            areaTitle: 'legacy title', order: 4 });
        expect(await updateProject(project.id, { areaId: area.id })).toEqual({ success: true });
        const afterSame = useTaskStore.getState()._allProjects.find((row) => row.id === project.id);
        expect(afterSame).toMatchObject({ areaId: area.id, areaTitle: 'Alpha', order: 4 });

        const noArea = await addProject('Already unassigned', '#22c55e', { order: 9 });
        if (!noArea) throw new Error('No Area setup failed');
        useTaskStore.setState((state) => ({
            _allProjects: state._allProjects.map((row) => row.id === noArea.id
                ? { ...row, areaTitle: 'old stale title' } : row),
        }));
        expect(await updateProject(noArea.id, { areaId: undefined })).toEqual({ success: true });
        const afterNoArea = useTaskStore.getState()._allProjects.find((row) => row.id === noArea.id);
        expect(afterNoArea?.areaTitle).toBeUndefined();
        expect(afterNoArea?.areaId).toBeUndefined();
        expect(afterNoArea?.order).toBe(9);
    });

});
