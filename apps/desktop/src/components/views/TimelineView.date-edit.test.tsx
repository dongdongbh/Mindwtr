import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Project, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { commitTimelineDateEdit } from '../../lib/timeline-date-edit';
import { showUndoToast } from '../../lib/undo-registry';
import { useUiStore } from '../../store/ui-store';
import { TimelineView } from './TimelineView';

vi.mock('../../lib/timeline-date-edit', () => ({ commitTimelineDateEdit: vi.fn() }));
vi.mock('../../lib/undo-registry', () => ({ showUndoToast: vi.fn() }));
const undo = vi.fn(async () => true);
const initialState = useTaskStore.getState();
const date = (offset: number) => {
    const value = new Date();
    value.setDate(value.getDate() + offset);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
const task: Task = { id: 'task', title: 'Dated work', status: 'next', tags: [], contexts: [], startTime: date(1), dueDate: date(6), createdAt: date(-30), updatedAt: date(-30) };
const project: Project = { id: 'project', title: 'Own project dates', status: 'active', startDate: date(0), dueDate: date(10), createdAt: date(-30), updatedAt: date(-30) } as Project;
const renderTimeline = () => render(<LanguageProvider><TimelineView /></LanguageProvider>);
const moveControl = () => screen.getByTestId('timeline-move-task');
const down = (control: HTMLElement, x = 100) => fireEvent.pointerDown(control, { pointerId: 1, button: 0, clientX: x });
const move = (x: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX: x });
const up = (x: number) => fireEvent.pointerUp(window, { pointerId: 1, clientX: x });

// jsdom lacks PointerEvent on some supported Node versions.
class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
    }
}

beforeEach(() => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    window.localStorage.clear();
    useTaskStore.setState(initialState, true);
    useTaskStore.setState({ _allTasks: [{ ...task }], _allProjects: [], _allAreas: [], settings: {} });
    vi.mocked(commitTimelineDateEdit).mockReset().mockResolvedValue({ status: 'saved', undo });
    vi.mocked(showUndoToast).mockClear();
    undo.mockReset().mockResolvedValue(true);
    useUiStore.setState({ toasts: [] });
});

describe('Timeline date editing', () => {
    it.each([{ zoom: 'Day', pixels: 32 }, { zoom: 'Week', pixels: 12 }, { zoom: 'Month', pixels: 4 }])(
        'previews locally and saves once using calendar-day snapping at $zoom zoom', async ({ zoom, pixels }) => {
            renderTimeline();
            fireEvent.click(screen.getByRole('button', { name: zoom }));
            const control = moveControl();
            down(control);
            move(100 + pixels * 2);
            expect(screen.getByRole('status')).toHaveTextContent('Start date:');
            expect(commitTimelineDateEdit).not.toHaveBeenCalled();
            expect(useTaskStore.getState()._allTasks[0].startTime).toBe(task.startTime);
            up(100 + pixels * 2);
            await waitFor(() => expect(commitTimelineDateEdit).toHaveBeenCalledOnce());
            expect(commitTimelineDateEdit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task', task: expect.objectContaining({ startTime: task.startTime }) }), { kind: 'move', days: 2 });
            fireEvent.click(control);
            expect(screen.queryByRole('dialog')).toBeNull();
            await waitFor(() => expect(showUndoToast).toHaveBeenCalledOnce());
        },
    );

    it.each(['Escape', 'pointercancel', 'blur'])('cancels a dragged gesture on %s and suppresses its click', (reason) => {
        renderTimeline();
        const control = moveControl();
        down(control); move(124);
        if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
        else if (reason === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 1 });
        else fireEvent.blur(window);
        up(124); fireEvent.click(control);
        expect(commitTimelineDateEdit).not.toHaveBeenCalled();
        expect(screen.queryByRole('status')).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('preserves click-to-open when a pointer does not move', () => {
        renderTimeline();
        const control = moveControl();
        down(control); up(100); fireEvent.click(control);
        expect(commitTimelineDateEdit).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('cancels on geometry changes and unmount', () => {
        const view = renderTimeline();
        down(moveControl()); move(124);
        fireEvent.click(screen.getByRole('button', { name: 'Day' }));
        up(124);
        expect(commitTimelineDateEdit).not.toHaveBeenCalled();
        down(moveControl()); move(132);
        view.unmount(); up(132);
        expect(commitTimelineDateEdit).not.toHaveBeenCalled();
    });

    it('accounts for horizontal scrolling during a gesture', async () => {
        renderTimeline();
        down(moveControl());
        screen.getByTestId('timeline-scroller').scrollLeft = 24;
        fireEvent.scroll(screen.getByTestId('timeline-scroller'));
        up(100);
        await waitFor(() => expect(commitTimelineDateEdit).toHaveBeenCalledWith(expect.anything(), { kind: 'move', days: 2 }));
    });

    it.each(['start', 'due'] as const)('resizes the explicit %s endpoint', async (edge) => {
        renderTimeline();
        const control = screen.getByTestId(`timeline-resize-${edge}`);
        down(control); move(112); up(112);
        await waitFor(() => expect(commitTimelineDateEdit).toHaveBeenCalledWith(expect.anything(), { kind: edge, days: 1 }));
    });

    it('does not commit a crossing resize', () => {
        renderTimeline();
        down(screen.getByTestId('timeline-resize-start')); move(196); up(196);
        expect(commitTimelineDateEdit).not.toHaveBeenCalled();
        expect(useUiStore.getState().toasts.slice(-1)[0]?.message).toMatch(/Could not update dates/);
    });

    it('moves a single-ended marker without resize controls or invented dates', async () => {
        useTaskStore.setState({ _allTasks: [{ ...task, startTime: undefined }] });
        renderTimeline();
        expect(screen.queryByTestId('timeline-resize-start')).toBeNull();
        expect(screen.queryByTestId('timeline-resize-due')).toBeNull();
        down(moveControl()); move(112); up(112);
        await waitFor(() => expect(commitTimelineDateEdit).toHaveBeenCalledOnce());
        expect(vi.mocked(commitTimelineDateEdit).mock.calls[0][0]).toMatchObject({ task: { startTime: undefined, dueDate: task.dueDate } });
    });

    it('moves only the project target and keeps inferred and historical spans inert', async () => {
        useTaskStore.setState({ _allProjects: [project], _allTasks: [{ ...task, projectId: project.id }] });
        renderTimeline();
        down(screen.getByTestId('timeline-move-project')); move(124); up(124);
        await waitFor(() => expect(commitTimelineDateEdit).toHaveBeenCalledWith({ kind: 'project', project }, { kind: 'move', days: 2 }));
        expect(useTaskStore.getState()._allTasks[0].startTime).toBe(task.startTime);
    });

    it.each(['inferred', 'historical'])('keeps %s project spans inert', (kind) => {
        if (kind === 'historical') window.localStorage.setItem('mindwtr:view:timeline:v1', JSON.stringify({ statuses: ['done'] }));
        useTaskStore.setState({
            _allProjects: [{ ...project, startDate: kind === 'inferred' ? undefined : project.startDate, status: kind === 'historical' ? 'archived' : 'active' }],
            _allTasks: [{ ...task, projectId: project.id, status: kind === 'historical' ? 'archived' : 'next' }],
        });
        renderTimeline();
        expect(screen.queryByTestId('timeline-move-project')).toBeNull();
        if (kind === 'historical') expect(screen.queryByTestId('timeline-move-task')).toBeNull();
    });

    it('uses original unclipped dates and hides the clipped endpoint handle', async () => {
        const spanning = { ...task, startTime: date(-500), dueDate: date(10) };
        useTaskStore.setState({ _allTasks: [spanning] });
        renderTimeline();
        expect(screen.queryByTestId('timeline-resize-start')).toBeNull();
        down(moveControl()); move(112); up(112);
        await waitFor(() => expect(commitTimelineDateEdit).toHaveBeenCalledWith(expect.objectContaining({ task: spanning }), { kind: 'move', days: 1 }));
    });

    it('uses the same commit path for keyboard edits and reports a concurrent edit conflict', async () => {
        vi.mocked(commitTimelineDateEdit).mockResolvedValue({ status: 'conflict' });
        renderTimeline();
        fireEvent.keyDown(moveControl(), { key: 'ArrowRight' });
        await waitFor(() => expect(commitTimelineDateEdit).toHaveBeenCalledWith(expect.anything(), { kind: 'move', days: 1 }));
        await waitFor(() => expect(useUiStore.getState().toasts.slice(-1)[0]?.message).toMatch(/Dates changed elsewhere/));
        expect(showUndoToast).not.toHaveBeenCalled();
    });

    it('drops the captured snapshot after a concurrent edit and reports conflict without overwriting', async () => {
        vi.mocked(commitTimelineDateEdit).mockResolvedValue({ status: 'conflict' });
        renderTimeline();
        down(moveControl()); move(112);
        act(() => useTaskStore.setState({ _allTasks: [{ ...task, title: 'Changed elsewhere', updatedAt: date(0) }] }));
        up(112);
        await waitFor(() => expect(commitTimelineDateEdit).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ title: task.title, updatedAt: task.updatedAt }) }), { kind: 'move', days: 1 }));
        expect(useTaskStore.getState()._allTasks[0].title).toBe('Changed elsewhere');
        await waitFor(() => expect(useUiStore.getState().toasts.slice(-1)[0]?.message).toMatch(/Dates changed elsewhere/));
    });

    it('blocks a second edit while saving and catches undo rejection', async () => {
        let finish!: (value: Awaited<ReturnType<typeof commitTimelineDateEdit>>) => void;
        vi.mocked(commitTimelineDateEdit).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
        renderTimeline();
        fireEvent.keyDown(moveControl(), { key: 'ArrowRight' });
        fireEvent.keyDown(moveControl(), { key: 'ArrowRight' });
        expect(commitTimelineDateEdit).toHaveBeenCalledOnce();
        await act(async () => finish({ status: 'saved', undo }));
        undo.mockRejectedValueOnce(new Error('failure')).mockResolvedValue(true);
        act(() => vi.mocked(showUndoToast).mock.calls[0][1]());
        await waitFor(() => expect(useUiStore.getState().toasts.slice(-1)[0]?.message).toMatch(/Could not undo date changes/));
        await waitFor(() => expect(showUndoToast).toHaveBeenCalledTimes(2));
        expect(vi.mocked(showUndoToast).mock.calls[1][1]).toBe(vi.mocked(showUndoToast).mock.calls[0][1]);
        await act(async () => vi.mocked(showUndoToast).mock.calls[1][1]());
        expect(undo).toHaveBeenCalledTimes(2);
        expect(commitTimelineDateEdit).toHaveBeenCalledOnce();
        expect(within(screen.getByTestId('timeline-bar')).getByRole('button', { name: /Move task dates/ })).toBeEnabled();
    });
});
