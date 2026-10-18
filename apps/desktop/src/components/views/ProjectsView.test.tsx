import { ViewSidebarContext } from '../../contexts/view-sidebar-context';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardSensor, type DragEndEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { AREA_FILTER_NONE, flushPendingSave, getStorageAdapter, setStorageAdapter, useTaskStore, type Area, type Project, type Task } from '@mindwtr/core';
import { registerUndoableAction, showUndoToast } from '../../lib/undo-registry';

import { ProjectsView } from './ProjectsView';

const initialTaskState = useTaskStore.getState();
const dndCallbacks = vi.hoisted(() => ({ current: null as null | { onDragEnd?: (event: DragEndEvent) => void } }));
vi.mock('@mindwtr/core', async () => {
    const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    return { ...actual, flushPendingSave: vi.fn(actual.flushPendingSave) };
});
const dndSensorCalls: Array<{ sensor: unknown; options: unknown }> = [];

vi.mock('@dnd-kit/core', async () => {
    const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');
    return {
        ...actual,
        DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
            dndCallbacks.current = props;
            return <actual.DndContext {...props} />;
        },
        useSensor: (sensor: unknown, options: unknown) => {
            dndSensorCalls.push({ sensor, options });
            return actual.useSensor(sensor as never, options as never);
        },
    };
});

const setProjectView = vi.fn();
const showToast = vi.fn();
const requestConfirmation = vi.fn();
let resizeObserverCallback: ResizeObserverCallback | null = null;
let animationFrameId = 0;
const queuedAnimationFrames = new Map<number, FrameRequestCallback>();
const projectsViewStoreOverrides = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

const createDeferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const flushAnimationFrames = () => {
    const callbacks = Array.from(queuedAnimationFrames.values());
    queuedAnimationFrames.clear();
    callbacks.forEach((callback) => callback(Date.now()));
};

vi.mock('../ErrorBoundary', () => ({
    ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const quickAreaName = vi.hoisted(() => ({ current: 'Created area' }));
vi.mock('../PromptModal', () => ({
    PromptModal: ({ isOpen, onConfirm, validate }: { isOpen: boolean; onConfirm: (value: string) => void; validate?: (value: string) => string | null }) => (
        isOpen
            ? (
                <>
                    {validate?.(quickAreaName.current) && <p>{validate(quickAreaName.current)}</p>}
                    <button type="button" onClick={() => onConfirm(quickAreaName.current)}>Confirm quick area</button>
                </>
            )
            : null
    ),
}));

vi.mock('./projects/AreaManagerModal', () => ({
    AreaManagerModal: ({ newAreaName, onChangeNewAreaName, onCreateArea }: {
        newAreaName: string;
        onChangeNewAreaName: (event: { target: { value: string } }) => void;
        onCreateArea: () => void;
    }) => (
        <>
            <input aria-label="New area name" value={newAreaName} onChange={onChangeNewAreaName} />
            <button type="button" onClick={onCreateArea}>Create area</button>
        </>
    ),
}));

vi.mock('./projects/ProjectsSidebar', () => ({
    ProjectsSidebar: ({
        collapseLabel,
        onToggleCollapsed,
        onSelectProject,
        onActivateProject,
        navigationVisible,
        onRequestNavigationVisible,
    }: {
        collapseLabel?: string;
        onToggleCollapsed?: () => void;
        onSelectProject?: (projectId: string) => void;
        onActivateProject?: (projectId: string) => void;
        navigationVisible?: boolean;
        onRequestNavigationVisible?: () => void;
    }) => (
        <div data-testid="projects-sidebar">
            Projects sidebar
            <span data-testid="projects-sidebar-navigation-visible">{String(navigationVisible)}</span>
            {onSelectProject && (
                <button type="button" onClick={() => onSelectProject('project-1')}>Select project</button>
            )}
            {onActivateProject && (
                <button type="button" onClick={() => onActivateProject('project-1')}>Activate project</button>
            )}
            {onRequestNavigationVisible && (
                <button type="button" onClick={onRequestNavigationVisible}>Request project navigation</button>
            )}
            {collapseLabel && onToggleCollapsed && (
                <button type="button" aria-label={collapseLabel} onClick={onToggleCollapsed}>
                    Collapse
                </button>
            )}
        </div>
    ),
}));

vi.mock('./projects/ProjectWorkspace', () => ({
    ProjectWorkspace: ({
        projectsSidebarCollapsed,
        onToggleProjectsSidebar,
        onRequestQuickArea,
        onManageAreas,
        onConvertProjectToSection,
    }: {
        projectsSidebarCollapsed?: boolean;
        onToggleProjectsSidebar?: () => void;
        onRequestQuickArea?: (projectId: string) => void;
        onManageAreas?: () => void;
        onConvertProjectToSection?: (projectId: string) => void;
    }) => (
        <div data-testid="project-workspace">
            Workspace
            {onManageAreas && <button type="button" onClick={onManageAreas}>Manage areas</button>}
            {onConvertProjectToSection && <button type="button" onClick={() => onConvertProjectToSection('project-1')}>Convert project</button>}
            {onRequestQuickArea && (
                <button type="button" onClick={() => onRequestQuickArea('project-1')}>Request quick area</button>
            )}
            {projectsSidebarCollapsed && onToggleProjectsSidebar && (
                <button type="button" aria-label="Expand projects panel" onClick={onToggleProjectsSidebar}>
                    Expand
                </button>
            )}
        </div>
    ),
}));

vi.mock('./projects/ProjectToSectionDialog', () => ({
    ProjectToSectionDialog: ({ source, onSuccess }: { source: Project; onSuccess: (result: unknown) => void }) => <div role="dialog">
        <span>{source.title}</span>
        <button type="button" onClick={() => onSuccess({ destinationProjectId: 'project-2', receipt: { sourceProjectId: source.id } })}>Complete conversion</button>
    </div>,
}));

vi.mock('../../lib/report-error', () => ({ reportError: vi.fn() }));

vi.mock('../../lib/undo-registry', () => ({ registerUndoableAction: vi.fn(), showUndoToast: vi.fn() }));

vi.mock('../../contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({
            'projects.collapseSidebar': 'Collapse projects panel',
            'projects.expandSidebar': 'Expand projects panel',
            'projects.resizeSidebar': 'Resize projects panel',
        }[key] ?? key),
        language: 'en',
    }),
}));

vi.mock('../../hooks/useConfirmDialog', () => ({
    useConfirmDialog: () => ({
        requestConfirmation,
        confirmModal: null,
    }),
}));

vi.mock('../../hooks/usePerformanceMonitor', () => ({
    usePerformanceMonitor: () => ({
        enabled: false,
        metrics: {},
    }),
}));

vi.mock('../../config/performanceBudgets', () => ({
    checkBudget: vi.fn(),
}));

vi.mock('../../store/ui-store', () => ({
    useUiStore: (selector: (state: unknown) => unknown) => selector({
        projectView: { selectedProjectId: null },
        setProjectView,
        showToast,
    }),
}));

vi.mock('./projects/useAreaSidebarState', () => ({
    useAreaSidebarState: () => ({
        selectedArea: { included: [], excluded: [] },
        selectedAreaValue: '__all__',
        sortedAreas: [],
        areaById: new Map(),
        areaFilterLabel: null,
        areaSensors: [],
        toggleAreaCollapse: vi.fn(),
        handleAreaDragEnd: vi.fn(),
        handleDeleteArea: vi.fn(),
    }),
}));

vi.mock('./projects/useProjectsViewStore', () => ({
    useProjectsViewStore: () => ({
        projects: [],
        tasks: [],
        sections: [],
        areas: [],
        addArea: vi.fn(),
        updateArea: vi.fn(),
        deleteArea: vi.fn(),
        reorderAreas: vi.fn(),
        reorderProjects: vi.fn(),
        reorderProjectTasks: vi.fn(),
        addProject: vi.fn(),
        updateProject: vi.fn(),
        deleteProject: vi.fn(),
        restoreProject: vi.fn(),
        duplicateProject: vi.fn(),
        updateTask: vi.fn(),
        batchMoveTasks: vi.fn(),
        batchDeleteTasks: vi.fn(),
        batchUpdateTasks: vi.fn(),
        addSection: vi.fn(),
        updateSection: vi.fn(),
        deleteSection: vi.fn(),
        toggleProjectFocus: vi.fn(),
        allTasks: [],
        highlightTaskId: null,
        setHighlightTask: vi.fn(),
        settings: {},
        getDerivedState: () => ({
            allContexts: [],
            allTags: [],
        }),
        projectTaskSummaryById: new Map(),
        ...projectsViewStoreOverrides.current,
    }),
}));

describe('ProjectsView', () => {
    it('moves the project navigator into the shared sidebar and restores its standalone fallback', () => {
        const slot = document.createElement('div');
        document.body.append(slot);
        const view = render(<ViewSidebarContext.Provider value={slot}><ProjectsView /></ViewSidebarContext.Provider>);
        expect(slot.querySelector('[data-testid="projects-sidebar"]')).not.toBeNull();
        expect(view.container.querySelector('[data-testid="projects-sidebar"]')).toBeNull();
        expect(screen.getAllByTestId('projects-sidebar')).toHaveLength(1);
        expect(screen.getByTestId('projects-sidebar-navigation-visible')).toHaveTextContent('true');
        expect(screen.queryByRole('separator')).not.toBeInTheDocument();
        view.rerender(<ViewSidebarContext.Provider value={null}><ProjectsView /></ViewSidebarContext.Provider>);
        expect(slot.children).toHaveLength(0);
        expect(view.container.querySelector('[data-testid="projects-sidebar"]')).not.toBeNull();
        view.unmount();
        slot.remove();
    });

    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        setProjectView.mockReset();
        showToast.mockReset();
        requestConfirmation.mockReset();
        dndSensorCalls.length = 0;
        dndCallbacks.current = null;
        vi.mocked(flushPendingSave).mockReset().mockResolvedValue(undefined);
        vi.mocked(registerUndoableAction).mockReset();
        vi.mocked(showUndoToast).mockReset();
        resizeObserverCallback = null;
        animationFrameId = 0;
        queuedAnimationFrames.clear();
        projectsViewStoreOverrides.current = {};
        quickAreaName.current = 'Created area';
        window.localStorage.clear();
        Object.defineProperty(window, 'requestAnimationFrame', {
            configurable: true,
            writable: true,
            value: vi.fn((callback: FrameRequestCallback) => {
                animationFrameId += 1;
                queuedAnimationFrames.set(animationFrameId, callback);
                return animationFrameId;
            }),
        });
        Object.defineProperty(window, 'cancelAnimationFrame', {
            configurable: true,
            writable: true,
            value: vi.fn((id: number) => {
                queuedAnimationFrames.delete(id);
            }),
        });
        class ResizeObserverMock {
            observe = vi.fn();
            disconnect = vi.fn();

            constructor(callback: ResizeObserverCallback) {
                resizeObserverCallback = callback;
            }
        }
        Object.defineProperty(window, 'ResizeObserver', {
            configurable: true,
            writable: true,
            value: ResizeObserverMock,
        });
        Object.defineProperty(globalThis, 'ResizeObserver', {
            configurable: true,
            writable: true,
            value: ResizeObserverMock,
        });
    });

    const taskDropEvent = (sortable: boolean, targetId: string, targetData: Record<string, unknown>): DragEndEvent => ({
        active: { id: 'task-1', data: { current: { type: 'task', sortable } }, rect: { current: { initial: null, translated: null } } },
        over: { id: targetId, data: { current: targetData }, rect: new DOMRect(), disabled: false },
        activatorEvent: new Event('pointerdown'), collisions: null, delta: { x: 0, y: 0 },
    });
    const dropTask = (sortable = true, section = 'active', projectId = 'project-2') => {
        act(() => dndCallbacks.current?.onDragEnd?.(taskDropEvent(sortable, projectId, { type: 'project', section })));
    };

    const setupTaskMove = (overrides: Record<string, unknown> = {}) => {
        const now = '2026-10-06T12:00:00.000Z';
        const source: Project = { id: 'project-1', title: 'Source', status: 'active', color: '#f00', order: 0, tagIds: [], createdAt: now, updatedAt: now };
        const destination: Project = { ...source, id: 'project-2', title: 'Destination' };
        const task: Task = { id: 'task-1', title: 'Keep this title', status: 'waiting', projectId: source.id, sectionId: 'source-section', order: 4, orderNum: 4, tags: ['keep'], contexts: ['@keep'], createdAt: now, updatedAt: now };
        const updateTask = vi.fn().mockResolvedValue({ success: true });
        projectsViewStoreOverrides.current = { projects: [source, destination], allTasks: [task], updateTask, ...overrides };
        render(<ProjectsView />);
        return { task, updateTask };
    };

    it.each([true, false])('routes the task grip from sortable=%s to the sidebar without changing status', async (sortable) => {
        const { task, updateTask } = setupTaskMove();
        dropTask(sortable);
        await waitFor(() => expect(showUndoToast).toHaveBeenCalled());

        expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { projectId: 'project-2' });
        expect(flushPendingSave).toHaveBeenCalledOnce();
        const undo = vi.mocked(showUndoToast).mock.calls[0][1];
        act(() => undo());
        await waitFor(() => expect(flushPendingSave).toHaveBeenCalledTimes(2));
        expect(updateTask).toHaveBeenLastCalledWith(task.id, {
            projectId: task.projectId, sectionId: task.sectionId, areaId: task.areaId,
            order: task.order, orderNum: task.orderNum,
        });
    });

    it('routes a task grip to an Area through the same store update path', async () => {
        const { task, updateTask } = setupTaskMove();
        act(() => dndCallbacks.current?.onDragEnd?.(taskDropEvent(false, `project-area:active:${AREA_FILTER_NONE}`, {
            zone: 'projectArea', section: 'active', areaId: AREA_FILTER_NONE,
        })));
        await waitFor(() => expect(showUndoToast).toHaveBeenCalledOnce());
        expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { projectId: undefined, areaId: undefined });
    });

    it('waits for durable persistence before confirming a project move', async () => {
        const saved = createDeferred<void>();
        vi.mocked(flushPendingSave).mockReturnValueOnce(saved.promise);
        setupTaskMove();
        dropTask();
        await waitFor(() => expect(flushPendingSave).toHaveBeenCalledOnce());
        expect(showUndoToast).not.toHaveBeenCalled();
        await act(async () => saved.resolve());
        await waitFor(() => expect(showUndoToast).toHaveBeenCalledOnce());
    });

    it.each(['result', 'persistence'])('shows failure and registers no undo for a failed %s', async (failure) => {
        const updateTask = vi.fn().mockResolvedValue(failure === 'result' ? { success: false, error: 'Move refused' } : { success: true });
        if (failure === 'persistence') vi.mocked(flushPendingSave).mockRejectedValueOnce(new Error('Disk unavailable'));
        setupTaskMove({ updateTask });
        dropTask();
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed to move task', 'error'));
        expect(showUndoToast).not.toHaveBeenCalled();
        expect(registerUndoableAction).not.toHaveBeenCalled();
    });

    it('uses the core store to clear the old section and restores only placement on undo', async () => {
        const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
        vi.mocked(flushPendingSave).mockImplementation(actual.flushPendingSave);
        const { task } = setupTaskMove({ updateTask: initialTaskState.updateTask });
        const projects = projectsViewStoreOverrides.current.projects as Project[];
        const originalStorage = getStorageAdapter();
        const saveData = vi.fn().mockResolvedValue(undefined);
        setStorageAdapter({ getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }), saveData });
        try {
            act(() => useTaskStore.setState({
                _allTasks: [task], _allProjects: projects,
                _allSections: [{ id: 'source-section', projectId: task.projectId!, title: 'Source section', order: 0, createdAt: task.createdAt, updatedAt: task.updatedAt }],
                settings: { ...initialTaskState.settings, deviceId: 'test-device' },
            }));
            dropTask();
            await waitFor(() => expect(showUndoToast).toHaveBeenCalledOnce());
            expect(useTaskStore.getState()._tasksById.get(task.id)).toMatchObject({ projectId: 'project-2', status: 'waiting', contexts: ['@keep'], order: 4, orderNum: 4 });
            expect(useTaskStore.getState()._tasksById.get(task.id)?.sectionId).toBeUndefined();
            expect(saveData).toHaveBeenCalled();

            await act(async () => {
                await initialTaskState.updateTask(task.id, { title: 'Edited after moving', contexts: ['@new'] });
                await actual.flushPendingSave();
            });
            act(() => vi.mocked(showUndoToast).mock.calls[0][1]());
            await waitFor(() => expect(useTaskStore.getState()._tasksById.get(task.id)?.projectId).toBe(task.projectId));
            await actual.flushPendingSave();
            expect(useTaskStore.getState()._tasksById.get(task.id)).toMatchObject({
                projectId: task.projectId, sectionId: task.sectionId, order: 4, orderNum: 4,
                title: 'Edited after moving', contexts: ['@new'], status: 'waiting',
            });
        } finally {
            await actual.flushPendingSave();
            setStorageAdapter(originalStorage);
        }
    });

    it('reports an unsuccessful structured result from undo', async () => {
        const { updateTask } = setupTaskMove();
        dropTask();
        await waitFor(() => expect(showUndoToast).toHaveBeenCalledOnce());
        updateTask.mockResolvedValueOnce({ success: false, error: 'Section removed' });
        act(() => vi.mocked(showUndoToast).mock.calls[0][1]());
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed to move task', 'error'));
        expect(flushPendingSave).toHaveBeenCalledOnce();
    });

    it('reports durable undo failure', async () => {
        setupTaskMove();
        dropTask();
        await waitFor(() => expect(showUndoToast).toHaveBeenCalledOnce());
        vi.mocked(flushPendingSave).mockRejectedValueOnce(new Error('Disk unavailable'));
        act(() => vi.mocked(showUndoToast).mock.calls[0][1]());
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed to move task', 'error'));
    });

    it('keeps keyboard undo when undo notifications are disabled', async () => {
        setupTaskMove({ settings: { undoNotificationsEnabled: false } });
        dropTask();
        await waitFor(() => expect(registerUndoableAction).toHaveBeenCalledOnce());
        expect(showToast).toHaveBeenCalledWith('Moved to Destination', 'success');
        expect(showUndoToast).not.toHaveBeenCalled();
    });

    it.each(['archived', 'deleted', 'same'])('ignores %s project targets', async (kind) => {
        const now = '2026-10-06T12:00:00.000Z';
        const target: Project = { id: 'project-2', title: 'Target', status: kind === 'archived' ? 'archived' : 'active', deletedAt: kind === 'deleted' ? now : undefined, color: '#f00', order: 0, tagIds: [], createdAt: now, updatedAt: now };
        const { updateTask } = setupTaskMove(kind === 'same' ? {} : { projects: [target] });
        dropTask(true, kind === 'archived' ? 'archived' : 'active', kind === 'same' ? 'project-1' : target.id);
        await act(async () => { await Promise.resolve(); });
        expect(updateTask).not.toHaveBeenCalled();
        expect(showUndoToast).not.toHaveBeenCalled();
    });

    it('registers keyboard coordinates for project and task reordering', () => {
        render(<ProjectsView />);

        const keyboardSensor = dndSensorCalls.find(({ sensor }) => sensor === KeyboardSensor);
        expect(keyboardSensor?.options).toMatchObject({
            coordinateGetter: sortableKeyboardCoordinates,
        });
    });

    it('keeps the conversion dialog mounted after the source leaves live projects and reveals the destination Area', async () => {
        const now = '2026-08-31T12:00:00.000Z';
        const source: Project = { id: 'project-1', title: 'Source', status: 'active', color: '#f00', order: 0, tagIds: [], areaId: 'area-1', createdAt: now, updatedAt: now };
        const destination: Project = { ...source, id: 'project-2', title: 'Destination', areaId: 'area-2' };
        const areas: Area[] = [
            { id: 'area-1', name: 'Area one', order: 0, createdAt: now, updatedAt: now },
            { id: 'area-2', name: 'Area two', order: 1, createdAt: now, updatedAt: now },
        ];
        const updateSettings = vi.fn(async (updates: Parameters<typeof initialTaskState.updateSettings>[0]) => {
            useTaskStore.setState((state) => ({ settings: { ...state.settings, ...updates } }));
        });
        useTaskStore.setState({ _allProjects: [source, destination], _allAreas: areas, areas, settings: { ...initialTaskState.settings, filters: { areaId: 'area-1', areaIds: ['area-1'], excludedAreaIds: [] } }, updateSettings });
        projectsViewStoreOverrides.current = { projects: [source, destination], areas };
        const view = render(<ProjectsView />);
        fireEvent.click(screen.getByRole('button', { name: 'Convert project' }));
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Source'));
        projectsViewStoreOverrides.current = { projects: [destination], areas };
        useTaskStore.setState({ _allProjects: [{ ...source, deletedAt: now }, destination], _allAreas: areas, areas });
        view.rerender(<ProjectsView />);
        expect(screen.getByRole('dialog')).toHaveTextContent('Source');
        expect(useTaskStore.getState().settings.filters?.areaIds).toEqual(['area-1']);
        expect(useTaskStore.getState().areas).toHaveLength(2);
        fireEvent.click(screen.getByRole('button', { name: 'Complete conversion' }));
        await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ filters: expect.objectContaining({ areaIds: ['area-2'] }) })));
        await waitFor(() => expect(setProjectView).toHaveBeenCalledWith({ selectedProjectId: 'project-2' }));
    });

    it('does not assign a newly created area after the target project archives', async () => {
        const now = '2026-08-31T12:00:00.000Z';
        const activeProject: Project = {
            id: 'project-1',
            title: 'Launch',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: now,
            updatedAt: now,
        };
        const createdArea: Area = {
            id: 'area-created',
            name: 'Created area',
            order: 0,
            createdAt: now,
            updatedAt: now,
        };
        const areaCreation = createDeferred<void>();
        const addArea = vi.fn(() => areaCreation.promise);
        const updateProject = vi.fn();
        projectsViewStoreOverrides.current = { addArea, updateProject };
        act(() => {
            useTaskStore.setState({
                _allProjects: [activeProject],
                areas: [],
            });
        });

        render(<ProjectsView />);
        fireEvent.click(screen.getByRole('button', { name: 'Request quick area' }));
        fireEvent.click(screen.getByRole('button', { name: 'Confirm quick area' }));
        expect(addArea).toHaveBeenCalledWith('Created area', { color: '#94a3b8' });

        act(() => {
            useTaskStore.setState({
                _allProjects: [{ ...activeProject, status: 'archived' }],
                areas: [createdArea],
                _allAreas: [createdArea],
            });
        });
        await act(async () => {
            areaCreation.resolve();
            await areaCreation.promise;
        });

        await waitFor(() => expect(updateProject).not.toHaveBeenCalled());
        expect(useTaskStore.getState()._allAreas).toContainEqual(createdArea);
    });

    it('refuses a new area named like a live area in both create flows and keeps the typed name', async () => {
        const now = '2026-08-31T12:00:00.000Z';
        const home: Area = { id: 'area-home', name: 'Home', order: 0, color: '#22c55e', createdAt: now, updatedAt: now };
        const addArea = vi.fn();
        projectsViewStoreOverrides.current = { addArea, areas: [home] };
        render(<ProjectsView />);

        // Manage areas: Create does nothing and the typed name stays.
        fireEvent.click(screen.getByRole('button', { name: 'Manage areas' }));
        fireEvent.change(screen.getByLabelText('New area name'), { target: { value: ' home ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create area' }));
        expect(addArea).not.toHaveBeenCalled();
        expect(screen.getByLabelText('New area name')).toHaveValue(' home ');

        // The project's quick "new area" prompt: refused with the line, and it stays open.
        quickAreaName.current = 'HOME';
        fireEvent.click(screen.getByRole('button', { name: 'Request quick area' }));
        expect(screen.getByText('An area with this name already exists.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Confirm quick area' }));
        await act(async () => { await Promise.resolve(); });
        expect(addArea).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Confirm quick area' })).toBeInTheDocument();
    });

    it('allows keyboard resizing of the projects sidebar and persists the width', async () => {
        const originalInnerWidth = window.innerWidth;
        const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 1500,
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get: () => 1800,
        });

        render(<ProjectsView />);
        act(() => {
            flushAnimationFrames();
        });

        const separator = screen.getByRole('separator', { name: 'Resize projects panel' });
        const sidebar = screen.getByTestId('projects-sidebar').parentElement?.parentElement;
        const layout = sidebar?.parentElement;

        expect(sidebar).not.toBeNull();
        expect(layout).not.toBeNull();
        expect(sidebar).toHaveStyle({ width: '304px' });
        expect(layout).toHaveStyle({ maxWidth: '1344px' });

        fireEvent.keyDown(separator, { key: 'ArrowRight' });

        await waitFor(() => {
            expect(sidebar).toHaveStyle({ width: '328px' });
        });
        await waitFor(() => {
            expect(layout).toHaveStyle({ maxWidth: '1416px' });
        });
        await waitFor(() => {
            expect(window.localStorage.getItem('mindwtr:projects:sidebarWidth')).toBe('328');
        });

        if (originalClientWidthDescriptor) {
            Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidthDescriptor);
        } else {
            delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
        }
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        });
    });

    it('allows ultra-wide desktops to expand the projects sidebar beyond the compact cap', async () => {
        const originalInnerWidth = window.innerWidth;
        const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 4480,
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get: () => 4480,
        });

        render(<ProjectsView />);
        act(() => {
            flushAnimationFrames();
        });

        const separator = screen.getByRole('separator', { name: 'Resize projects panel' });
        const sidebar = screen.getByTestId('projects-sidebar').parentElement?.parentElement;
        const layout = sidebar?.parentElement;

        expect(sidebar).not.toBeNull();
        expect(layout).not.toBeNull();
        expect(separator).toHaveAttribute('aria-valuemax', '1200');
        expect(layout).toHaveClass('mx-auto');

        fireEvent.keyDown(separator, { key: 'End' });

        await waitFor(() => {
            expect(sidebar).toHaveStyle({ width: '1200px' });
        });
        await waitFor(() => {
            expect(layout).toHaveStyle({ maxWidth: '4096px' });
        });

        if (originalClientWidthDescriptor) {
            Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidthDescriptor);
        } else {
            delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
        }
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        });
    });

    it('coalesces ResizeObserver sidebar sync work into a single animation frame', () => {
        const requestAnimationFrameMock = window.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>;

        render(<ProjectsView />);
        act(() => {
            flushAnimationFrames();
        });
        requestAnimationFrameMock.mockClear();

        expect(resizeObserverCallback).not.toBeNull();

        act(() => {
            resizeObserverCallback?.([], {} as ResizeObserver);
            resizeObserverCallback?.([], {} as ResizeObserver);
        });

        expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);
    });

    it('collapses and restores the projects sidebar panel', async () => {
        const originalInnerWidth = window.innerWidth;
        const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 1500,
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get: () => 1800,
        });

        render(<ProjectsView />);
        act(() => {
            flushAnimationFrames();
        });

        const sidebarFrame = screen.getByTestId('projects-sidebar').parentElement?.parentElement;
        const layout = sidebarFrame?.parentElement;
        expect(sidebarFrame).toHaveStyle({ width: '304px' });
        expect(layout).toHaveStyle({ maxWidth: '1344px' });
        expect(screen.getByRole('separator', { name: 'Resize projects panel' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Collapse projects panel' }));

        await waitFor(() => {
            expect(screen.queryByTestId('projects-sidebar')).not.toBeInTheDocument();
        });
        expect(screen.queryByTestId('projects-sidebar-collapsed')).not.toBeInTheDocument();
        expect(sidebarFrame).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Expand projects panel' })).toBeInTheDocument();
        expect(layout).toHaveStyle({ maxWidth: '1592px' });
        expect(screen.queryByRole('separator', { name: 'Resize projects panel' })).not.toBeInTheDocument();
        expect(window.localStorage.getItem('mindwtr:view:projects:v1')).toContain('"projectsSidebarCollapsed":true');

        fireEvent.click(screen.getByRole('button', { name: 'Expand projects panel' }));

        await waitFor(() => {
            expect(screen.getByTestId('projects-sidebar')).toBeInTheDocument();
        });
        const restoredSidebarFrame = screen.getByTestId('projects-sidebar').parentElement?.parentElement;
        expect(restoredSidebarFrame).toHaveStyle({ width: '304px' });
        expect(layout).toHaveStyle({ maxWidth: '1344px' });
        expect(screen.getByRole('separator', { name: 'Resize projects panel' })).toBeInTheDocument();

        if (originalClientWidthDescriptor) {
            Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidthDescriptor);
        } else {
            delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
        }
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        });
    });

    it('keeps compact project navigation mounted, opens it for keyboard focus, and closes only on activation', async () => {
        const originalInnerWidth = window.innerWidth;
        const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 700,
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get: () => 700,
        });

        render(<ProjectsView />);
        act(() => {
            flushAnimationFrames();
        });

        const sidebar = screen.getByTestId('projects-sidebar');
        const sidebarFrame = sidebar.parentElement?.parentElement;
        expect(sidebarFrame).toHaveClass('hidden');
        expect(screen.getByTestId('projects-sidebar-navigation-visible')).toHaveTextContent('false');

        fireEvent.click(screen.getByRole('button', { name: 'Request project navigation' }));
        await waitFor(() => expect(sidebarFrame).not.toHaveClass('hidden'));
        expect(screen.getByTestId('projects-sidebar-navigation-visible')).toHaveTextContent('true');

        fireEvent.click(screen.getByRole('button', { name: 'Select project' }));
        expect(setProjectView).toHaveBeenCalledWith({ selectedProjectId: 'project-1' });
        expect(sidebarFrame).not.toHaveClass('hidden');

        fireEvent.click(screen.getByRole('button', { name: 'Activate project' }));
        await waitFor(() => expect(sidebarFrame).toHaveClass('hidden'));

        if (originalClientWidthDescriptor) {
            Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidthDescriptor);
        } else {
            delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
        }
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        });
    });
});
