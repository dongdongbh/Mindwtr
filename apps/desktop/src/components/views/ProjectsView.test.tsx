import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardSensor } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

import { ProjectsView } from './ProjectsView';

const dndSensorCalls: Array<{ sensor: unknown; options: unknown }> = [];

vi.mock('@dnd-kit/core', async () => {
    const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');
    return {
        ...actual,
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

const flushAnimationFrames = () => {
    const callbacks = Array.from(queuedAnimationFrames.values());
    queuedAnimationFrames.clear();
    callbacks.forEach((callback) => callback(Date.now()));
};

vi.mock('../ErrorBoundary', () => ({
    ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../PromptModal', () => ({
    PromptModal: () => null,
}));

vi.mock('./projects/AreaManagerModal', () => ({
    AreaManagerModal: () => null,
}));

vi.mock('./projects/ProjectsSidebar', () => ({
    ProjectsSidebar: ({
        collapseLabel,
        onToggleCollapsed,
    }: {
        collapseLabel?: string;
        onToggleCollapsed?: () => void;
    }) => (
        <div data-testid="projects-sidebar">
            Projects sidebar
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
    }: {
        projectsSidebarCollapsed?: boolean;
        onToggleProjectsSidebar?: () => void;
    }) => (
        <div data-testid="project-workspace">
            Workspace
            {projectsSidebarCollapsed && onToggleProjectsSidebar && (
                <button type="button" aria-label="Expand projects panel" onClick={onToggleProjectsSidebar}>
                    Expand
                </button>
            )}
        </div>
    ),
}));

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
    }),
}));

describe('ProjectsView', () => {
    beforeEach(() => {
        setProjectView.mockReset();
        showToast.mockReset();
        requestConfirmation.mockReset();
        dndSensorCalls.length = 0;
        resizeObserverCallback = null;
        animationFrameId = 0;
        queuedAnimationFrames.clear();
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

    it('registers keyboard coordinates for project and task reordering', () => {
        render(<ProjectsView />);

        const keyboardSensor = dndSensorCalls.find(({ sensor }) => sensor === KeyboardSensor);
        expect(keyboardSensor?.options).toMatchObject({
            coordinateGetter: sortableKeyboardCoordinates,
        });
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
});
