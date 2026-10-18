import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from '../store';
import { compareProjectsByOrder, sortTasksByBoardOrder } from '../task-utils';
import type { StorageAdapter } from '../storage';
import type { AppData, Project, Section, Task } from '../types';

const BASE_NOW = '2026-06-11T12:00:00.000Z';


describe('reorderProjectTasks', () => {
    let saveData: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        saveData = vi.fn().mockResolvedValue(undefined);
        const storage: StorageAdapter = {
            getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData,
        };
        setStorageAdapter(storage);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(BASE_NOW));
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const project: Project = {
        id: 'project-1',
        title: 'Project 1',
        status: 'active',
        color: '#2563eb',
        order: 0,
        tagIds: [],
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        rev: 1,
        revBy: 'device-a',
    };

    const makeTask = (index: number): Task => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        status: 'next',
        projectId: project.id,
        tags: [],
        contexts: [],
        order: index * 1024,
        orderNum: index * 1024,
        createdAt: `2026-06-01T00:${String(index).padStart(2, '0')}:00.000Z`,
        updatedAt: '2026-06-01T00:00:00.000Z',
        rev: 1,
        revBy: 'device-a',
    });

    const seedProjectTasks = (count: number) => {
        const tasks = Array.from({ length: count }, (_, index) => makeTask(index));
        useTaskStore.setState({
            tasks,
            projects: [project],
            sections: [],
            areas: [],
            settings: { deviceId: 'device-a' },
            isLoading: false,
            error: null,
            _allTasks: tasks,
            _allProjects: [project],
            _allSections: [],
            _allAreas: [],
            _tasksById: new Map(tasks.map((task) => [task.id, task])),
            _projectsById: new Map([[project.id, project]]),
            _sectionsById: new Map(),
            _areasById: new Map(),
            lastDataChangeAt: 0,
        });
        return tasks;
    };

    it('updates only the moved task when a sparse order slot exists', async () => {
        const originalTasks = seedProjectTasks(100);
        const orderedIds = originalTasks.map((task) => task.id);
        const [movedId] = orderedIds.splice(50, 1);
        orderedIds.splice(60, 0, movedId!);

        await useTaskStore.getState().reorderProjectTasks(project.id, orderedIds);

        const tasksById = new Map(useTaskStore.getState()._allTasks.map((task) => [task.id, task]));
        const originalById = new Map(originalTasks.map((task) => [task.id, task]));
        const changedTaskIds = useTaskStore.getState()._allTasks
            .filter((task) => {
                const original = originalById.get(task.id);
                return original && (
                    task.order !== original.order
                    || task.orderNum !== original.orderNum
                    || task.rev !== original.rev
                    || task.updatedAt !== original.updatedAt
                );
            })
            .map((task) => task.id);

        expect(changedTaskIds).toEqual([movedId]);

        const moved = tasksById.get(movedId!);
        const previous = tasksById.get(orderedIds[59]!);
        const next = tasksById.get(orderedIds[61]!);
        expect(moved?.order).toBeGreaterThan(previous?.order ?? Number.NEGATIVE_INFINITY);
        expect(moved?.order).toBeLessThan(next?.order ?? Number.POSITIVE_INFINITY);
        expect(moved?.orderNum).toBe(moved?.order);
        expect(moved?.rev).toBe(2);
        expect(moved?.revBy).toBe('device-a');

        const sortedIds = [...useTaskStore.getState()._allTasks]
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((task) => task.id);
        expect(sortedIds).toEqual(orderedIds);

        await flushPendingSave();
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData | undefined;
        expect(saved?.tasks.filter((task) => task.rev === 2).map((task) => task.id)).toEqual([movedId]);
    });

    it.each([
        { shown: ['task-2', 'task-0'], moved: 'task-0', expected: ['task-1', 'task-2', 'task-0'] },
        { shown: ['task-2', 'task-0'], moved: 'task-2', expected: ['task-2', 'task-0', 'task-1'] },
    ])('preserves hidden rows and writes only the actual dragged task ($moved)', async ({ shown, moved, expected }) => {
        const original = seedProjectTasks(3);
        await useTaskStore.getState().reorderProjectTasks(project.id, shown, null, moved);

        const current = useTaskStore.getState()._allTasks;
        expect([...current].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((task) => task.id)).toEqual(expected);
        expect(current.filter((task) => task.rev !== 1).map((task) => task.id)).toEqual([moved]);
        for (const task of original.filter((task) => task.id !== moved)) {
            expect(current.find((row) => row.id === task.id)).toEqual(task);
        }
        await flushPendingSave();
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData;
        expect(saved.tasks.filter((task) => task.rev !== 1).map((task) => task.id)).toEqual([moved]);
        for (const task of original.filter((task) => task.id !== moved)) {
            expect(saved.tasks.find((row) => row.id === task.id)).toEqual(task);
        }
        await useTaskStore.getState().reorderProjectTasks(project.id, shown, null, moved);
        expect(useTaskStore.getState()._allTasks).toEqual(current);
    });

    it('inserts beside the visible neighbor without rewriting hidden or out-of-scope rows', async () => {
        const [a, hidden, c, moved] = seedProjectTasks(4);
        const other = { ...makeTask(4), id: 'other-project', projectId: 'other-project' };
        const tasks = [...useTaskStore.getState()._allTasks, other];
        useTaskStore.setState({ tasks, _allTasks: tasks, _tasksById: new Map(tasks.map((task) => [task.id, task])) });

        await useTaskStore.getState().reorderProjectTasks(project.id, [a.id, moved.id, c.id], null, moved.id);

        const current = useTaskStore.getState()._allTasks;
        expect([...current.filter((task) => task.projectId === project.id)]
            .sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map((task) => task.id))
            .toEqual([a.id, moved.id, hidden.id, c.id]);
        expect(current.filter((task) => task.rev !== 1).map((task) => task.id)).toEqual([moved.id]);
        expect(current.find((task) => task.id === other.id)).toEqual(other);
    });

    it('ignores duplicate, deleted, and foreign IDs within a section-scoped filtered drop', async () => {
        const [a, hidden, c] = seedProjectTasks(3);
        const sectionTasks = [a, hidden, c].map((task) => ({ ...task, sectionId: 'section-1' }));
        const deleted = { ...makeTask(3), id: 'deleted', sectionId: 'section-1', deletedAt: BASE_NOW };
        const foreign = { ...makeTask(4), id: 'foreign', sectionId: 'section-2' };
        const tasks = [...sectionTasks, deleted, foreign];
        useTaskStore.setState({ tasks, _allTasks: tasks, _tasksById: new Map(tasks.map((task) => [task.id, task])) });

        await useTaskStore.getState().reorderProjectTasks(project.id,
            [c.id, deleted.id, foreign.id, c.id, a.id], 'section-1', c.id);

        const current = useTaskStore.getState()._allTasks;
        expect(current.filter((task) => task.rev !== 1).map((task) => task.id)).toEqual([c.id]);
        for (const task of [hidden, deleted, foreign]) {
            expect(current.find((row) => row.id === task.id)).toEqual(tasks.find((row) => row.id === task.id));
        }
    });

    it('writes integer orders for sparse moves so integer-typed storage keeps them (#784)', async () => {
        const tasks = seedProjectTasks(3).map((task, index) => ({
            ...task,
            order: [0, 5, 1024][index],
            orderNum: [0, 5, 1024][index],
        }));
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            _tasksById: new Map(tasks.map((task) => [task.id, task])),
        });

        // task-2 dropped between orders 0 and 5: midpoint 2.5 must round to an integer.
        await useTaskStore.getState().reorderProjectTasks(project.id, ['task-0', 'task-2', 'task-1'], undefined, 'task-2');

        const moved = useTaskStore.getState()._allTasks.find((task) => task.id === 'task-2');
        expect(moved?.order).toBe(2);
        expect(Number.isInteger(moved?.order)).toBe(true);
    });

    it('rebalances to integer orders when no integer gap exists between neighbors', async () => {
        const tasks = seedProjectTasks(3).map((task, index) => ({
            ...task,
            order: [3, 4, 1024][index],
            orderNum: [3, 4, 1024][index],
        }));
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            _tasksById: new Map(tasks.map((task) => [task.id, task])),
        });

        // task-2 dropped between orders 3 and 4: no integer fits, so every task
        // is renumbered instead of writing a fractional midpoint.
        await useTaskStore.getState().reorderProjectTasks(project.id, ['task-0', 'task-2', 'task-1'], undefined, 'task-2');

        const state = useTaskStore.getState()._allTasks;
        for (const task of state) {
            expect(Number.isInteger(task.order)).toBe(true);
        }
        const sortedIds = [...state]
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((task) => task.id);
        expect(sortedIds).toEqual(['task-0', 'task-2', 'task-1']);
    });
});

describe('reorderProjects', () => {
    let saveData: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        saveData = vi.fn().mockResolvedValue(undefined);
        const storage: StorageAdapter = {
            getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData,
        };
        setStorageAdapter(storage);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(BASE_NOW));
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const makeProject = (index: number): Project => ({
        id: `project-${index}`,
        title: `Project ${index}`,
        status: 'active',
        color: '#2563eb',
        order: index * 1024,
        tagIds: [],
        createdAt: `2026-06-01T00:${String(index).padStart(2, '0')}:00.000Z`,
        updatedAt: '2026-06-01T00:00:00.000Z',
        rev: 1,
        revBy: 'device-a',
    });

    const seedProjects = (count: number) => {
        const projects = Array.from({ length: count }, (_, index) => makeProject(index));
        useTaskStore.setState({
            tasks: [],
            projects,
            sections: [],
            areas: [],
            settings: { deviceId: 'device-a' },
            isLoading: false,
            error: null,
            _allTasks: [],
            _allProjects: projects,
            _allSections: [],
            _allAreas: [],
            _tasksById: new Map(),
            _projectsById: new Map(projects.map((project) => [project.id, project])),
            _sectionsById: new Map(),
            _areasById: new Map(),
            lastDataChangeAt: 0,
        });
        return projects;
    };

    it('updates only the moved project when a sparse order slot exists', async () => {
        const originalProjects = seedProjects(5);
        const orderedIds = originalProjects.map((project) => project.id);
        const [movedId] = orderedIds.splice(1, 1);
        orderedIds.splice(3, 0, movedId!);

        await useTaskStore.getState().reorderProjects(orderedIds);

        const projectsById = new Map(useTaskStore.getState()._allProjects.map((project) => [project.id, project]));
        const originalById = new Map(originalProjects.map((project) => [project.id, project]));
        const changedProjectIds = useTaskStore.getState()._allProjects
            .filter((project) => {
                const original = originalById.get(project.id);
                return original && (
                    project.order !== original.order
                    || project.rev !== original.rev
                    || project.updatedAt !== original.updatedAt
                );
            })
            .map((project) => project.id);

        expect(changedProjectIds).toEqual([movedId]);

        const moved = projectsById.get(movedId!);
        const previous = projectsById.get(orderedIds[2]!);
        const next = projectsById.get(orderedIds[4]!);
        expect(moved?.order).toBeGreaterThan(previous?.order ?? Number.NEGATIVE_INFINITY);
        expect(moved?.order).toBeLessThan(next?.order ?? Number.POSITIVE_INFINITY);

        const sortedIds = [...useTaskStore.getState()._allProjects]
            .sort((a, b) => a.order - b.order)
            .map((project) => project.id);
        expect(sortedIds).toEqual(orderedIds);

        await flushPendingSave();
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData | undefined;
        expect(saved?.projects.filter((project) => project.rev === 2).map((project) => project.id)).toEqual([movedId]);
    });

    it('reorders a project without stored order using the same comparator as the displayed list', async () => {
        seedProjects(0);
        const first = { ...makeProject(0), order: 100 };
        const missingOrder = makeProject(1);
        delete (missingOrder as Partial<Project>).order;
        useTaskStore.setState({ _allProjects: [first, missingOrder] });
        expect([...useTaskStore.getState()._allProjects].sort(compareProjectsByOrder).map((row) => row.id))
            .toEqual([first.id, missingOrder.id]);

        await useTaskStore.getState().reorderProjects([missingOrder.id, first.id]);
        await flushPendingSave();

        expect([...useTaskStore.getState()._allProjects].sort(compareProjectsByOrder).map((row) => row.id))
            .toEqual([missingOrder.id, first.id]);
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData | undefined;
        expect(saved?.projects.find((row) => row.id === missingOrder.id)?.order).toBeLessThan(first.order);
    });
});

describe('reorderSections', () => {
    let saveData: ReturnType<typeof vi.fn>;

    const project: Project = {
        id: 'project-1',
        title: 'Project 1',
        status: 'active',
        color: '#2563eb',
        order: 0,
        tagIds: [],
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        rev: 1,
        revBy: 'device-a',
    };

    beforeEach(() => {
        saveData = vi.fn().mockResolvedValue(undefined);
        const storage: StorageAdapter = {
            getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData,
        };
        setStorageAdapter(storage);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(BASE_NOW));
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const makeSection = (index: number): Section => ({
        id: `section-${index}`,
        projectId: project.id,
        title: `Section ${index}`,
        order: index * 1024,
        createdAt: `2026-06-01T00:${String(index).padStart(2, '0')}:00.000Z`,
        updatedAt: '2026-06-01T00:00:00.000Z',
        rev: 1,
        revBy: 'device-a',
    });

    const seedSections = (count: number) => {
        const sections = Array.from({ length: count }, (_, index) => makeSection(index));
        useTaskStore.setState({
            tasks: [],
            projects: [project],
            sections,
            areas: [],
            settings: { deviceId: 'device-a' },
            isLoading: false,
            error: null,
            _allTasks: [],
            _allProjects: [project],
            _allSections: sections,
            _allAreas: [],
            _tasksById: new Map(),
            _projectsById: new Map([[project.id, project]]),
            _sectionsById: new Map(sections.map((section) => [section.id, section])),
            _areasById: new Map(),
            lastDataChangeAt: 0,
        });
        return sections;
    };

    it('updates only the moved section when a sparse order slot exists', async () => {
        const originalSections = seedSections(5);
        const orderedIds = originalSections.map((section) => section.id);
        const [movedId] = orderedIds.splice(1, 1);
        orderedIds.splice(3, 0, movedId!);

        await useTaskStore.getState().reorderSections(project.id, orderedIds);

        const sectionsById = new Map(useTaskStore.getState()._allSections.map((section) => [section.id, section]));
        const originalById = new Map(originalSections.map((section) => [section.id, section]));
        const changedSectionIds = useTaskStore.getState()._allSections
            .filter((section) => {
                const original = originalById.get(section.id);
                return original && (
                    section.order !== original.order
                    || section.rev !== original.rev
                    || section.updatedAt !== original.updatedAt
                );
            })
            .map((section) => section.id);

        expect(changedSectionIds).toEqual([movedId]);

        const moved = sectionsById.get(movedId!);
        const previous = sectionsById.get(orderedIds[2]!);
        const next = sectionsById.get(orderedIds[4]!);
        expect(moved?.order).toBeGreaterThan(previous?.order ?? Number.NEGATIVE_INFINITY);
        expect(moved?.order).toBeLessThan(next?.order ?? Number.POSITIVE_INFINITY);

        const sortedIds = [...useTaskStore.getState()._allSections]
            .sort((a, b) => a.order - b.order)
            .map((section) => section.id);
        expect(sortedIds).toEqual(orderedIds);

        await flushPendingSave();
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData | undefined;
        expect(saved?.sections.filter((section) => section.rev === 2).map((section) => section.id)).toEqual([movedId]);
    });
});

describe('reorderBoardTasks', () => {
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

    const addStatusTask = async (title: string, status: 'next' | 'waiting') => {
        const { addTask } = useTaskStore.getState();
        await addTask(title, { status });
        const task = useTaskStore.getState()._allTasks.find((item) => item.title === title);
        expect(task).toBeDefined();
        return task!;
    };

    const orderedNextIds = () => sortTasksByBoardOrder(
        useTaskStore.getState().tasks.filter((task) => task.status === 'next'),
    ).map((task) => task.id);

    it('uses the same incoming order as the Board for unordered cards', async () => {
        const a = await addStatusTask('A', 'next');
        const b = await addStatusTask('B', 'next');
        await useTaskStore.getState().updateTask(a.id, { createdAt: '2026-09-20T00:00:00.000Z' });
        await useTaskStore.getState().updateTask(b.id, { createdAt: '2026-09-10T00:00:00.000Z' });
        expect(orderedNextIds()).toEqual([a.id, b.id]);
        await useTaskStore.getState().reorderBoardTasks('next', [b.id, a.id]);
        expect(orderedNextIds()).toEqual([b.id, a.id]);
    });

    it('keeps hidden cards in place when shown cards are reordered', async () => {
        const a = await addStatusTask('A hidden', 'next');
        const b = await addStatusTask('B shown', 'next');
        const c = await addStatusTask('C hidden', 'next');
        const d = await addStatusTask('D shown', 'next');
        for (const [index, task] of [a, b, c, d].entries()) {
            await useTaskStore.getState().updateTask(task.id, { boardOrder: index * 1024 });
        }
        const before = new Map(useTaskStore.getState().tasks.map((task) => [task.id, task.rev]));
        await useTaskStore.getState().reorderBoardTasks('next', [d.id, b.id], d.id);
        expect(orderedNextIds()).toEqual([a.id, d.id, b.id, c.id]);
        const after = new Map(useTaskStore.getState().tasks.map((task) => [task.id, task.rev]));
        for (const task of [a, b, c]) expect(after.get(task.id)).toBe(before.get(task.id));
        expect(after.get(d.id)).toBe((before.get(d.id) ?? 0) + 1);
    });

    it('moves the first shown card after the last without moving hidden cards', async () => {
        const a = await addStatusTask('A hidden', 'next');
        const b = await addStatusTask('B shown', 'next');
        const c = await addStatusTask('C hidden', 'next');
        const d = await addStatusTask('D shown', 'next');
        for (const [index, task] of [a, b, c, d].entries()) {
            await useTaskStore.getState().updateTask(task.id, { boardOrder: index * 1024 });
        }
        const before = new Map(useTaskStore.getState().tasks.map((task) => [task.id, task.rev]));
        await useTaskStore.getState().reorderBoardTasks('next', [d.id, b.id], b.id);
        expect(orderedNextIds()).toEqual([a.id, c.id, d.id, b.id]);
        const after = new Map(useTaskStore.getState().tasks.map((task) => [task.id, task.rev]));
        for (const task of [a, c, d]) expect(after.get(task.id)).toBe(before.get(task.id));
        expect(after.get(b.id)).toBe((before.get(b.id) ?? 0) + 1);
    });

    it('places a moved card directly after its shown anchor', async () => {
        const a = await addStatusTask('A shown', 'next');
        const hidden = await addStatusTask('Hidden', 'next');
        const b = await addStatusTask('B shown', 'next');
        const moved = await addStatusTask('Moved', 'next');
        for (const [index, task] of [a, hidden, b, moved].entries()) {
            await useTaskStore.getState().updateTask(task.id, { boardOrder: index * 1024 });
        }
        await useTaskStore.getState().reorderBoardTasks('next', [a.id, moved.id, b.id], moved.id);
        expect(orderedNextIds()).toEqual([a.id, moved.id, hidden.id, b.id]);
    });

    it('updates only the moved board task when a sparse order slot exists', async () => {
        const q = await addStatusTask('Task Q', 'next');
        const w = await addStatusTask('Task W', 'next');
        const e = await addStatusTask('Task E', 'next');
        const r = await addStatusTask('Task R', 'next');

        await useTaskStore.getState().reorderBoardTasks('next', [e.id, q.id, w.id, r.id]);

        const byId = new Map(useTaskStore.getState().tasks.map((task) => [task.id, task]));
        expect(orderedNextIds()).toEqual([e.id, q.id, w.id, r.id]);
        expect(byId.get(e.id)?.boardOrder).toBe(0);
        expect(byId.get(q.id)?.boardOrder).toBeUndefined();
        expect(byId.get(w.id)?.boardOrder).toBeUndefined();
        expect(byId.get(r.id)?.boardOrder).toBeUndefined();
        expect(byId.get(e.id)?.rev).toBe((e.rev ?? 0) + 1);
        expect(byId.get(q.id)?.rev).toBe(q.rev);
        expect(byId.get(w.id)?.rev).toBe(w.rev);
        expect(byId.get(r.id)?.rev).toBe(r.rev);

        await flushPendingSave();
        const saved = latestSavedData();
        expect(saved.tasks.filter((task) => task.rev === (e.rev ?? 0) + 1).map((task) => task.id)).toEqual([e.id]);
        expect(saved.tasks.find((task) => task.id === e.id)?.boardOrder).toBe(0);
    });

    it('leaves tasks in other statuses untouched', async () => {
        const next = await addStatusTask('Next Task', 'next');
        const waiting = await addStatusTask('Waiting Task', 'waiting');

        await useTaskStore.getState().reorderBoardTasks('next', [next.id]);

        const state = useTaskStore.getState();
        expect(state.tasks.find((task) => task.id === waiting.id)?.boardOrder).toBeUndefined();
        expect(state.tasks.find((task) => task.id === waiting.id)?.rev).toBe(waiting.rev);
    });

    it('appends same-status tasks missing from orderedIds after the ordered ones', async () => {
        const a = await addStatusTask('A', 'next');
        const b = await addStatusTask('B', 'next');
        const c = await addStatusTask('C', 'next');

        await useTaskStore.getState().reorderBoardTasks('next', [c.id, a.id]);

        const byId = new Map(useTaskStore.getState().tasks.map((task) => [task.id, task]));
        expect(orderedNextIds()).toEqual([c.id, a.id, b.id]);
        expect(byId.get(c.id)?.boardOrder).toBe(0);
        expect(byId.get(a.id)?.boardOrder).toBeUndefined();
        expect(byId.get(b.id)?.boardOrder).toBeUndefined();
    });

    it('ignores ids that are not tasks in the target status', async () => {
        const a = await addStatusTask('A', 'next');
        const waiting = await addStatusTask('W', 'waiting');

        await useTaskStore.getState().reorderBoardTasks('next', [waiting.id, 'missing-id', a.id]);

        const byId = new Map(useTaskStore.getState().tasks.map((task) => [task.id, task]));
        expect(orderedNextIds()).toEqual([a.id]);
        expect(byId.get(a.id)?.boardOrder).toBeUndefined();
        expect(byId.get(waiting.id)?.boardOrder).toBeUndefined();
    });

    it('clears boardOrder when a task changes status', async () => {
        const a = await addStatusTask('A', 'next');
        const b = await addStatusTask('B', 'next');
        await useTaskStore.getState().reorderBoardTasks('next', [b.id, a.id]);
        expect(useTaskStore.getState().tasks.find((task) => task.id === b.id)?.boardOrder).toBe(0);

        await useTaskStore.getState().moveTask(b.id, 'waiting');

        const moved = useTaskStore.getState().tasks.find((task) => task.id === b.id);
        expect(moved?.status).toBe('waiting');
        expect(moved?.boardOrder).toBeUndefined();
    });

    it('keeps boardOrder when a task updates without a status change', async () => {
        const a = await addStatusTask('A', 'next');
        const b = await addStatusTask('B', 'next');
        await useTaskStore.getState().reorderBoardTasks('next', [b.id, a.id]);

        await useTaskStore.getState().updateTask(b.id, { title: 'B renamed' });

        const updated = useTaskStore.getState().tasks.find((task) => task.id === b.id);
        expect(updated?.boardOrder).toBe(0);
        expect(orderedNextIds()).toEqual([b.id, a.id]);
    });
});
