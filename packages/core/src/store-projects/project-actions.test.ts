import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from '../store';
import type { StorageAdapter } from '../storage';
import type { AppData } from '../types';
import { buildNewProject } from './project-actions';

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
});
