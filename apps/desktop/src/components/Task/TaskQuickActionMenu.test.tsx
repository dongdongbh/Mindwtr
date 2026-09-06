import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import type { Task } from '@mindwtr/core';
import { reportError } from '../../lib/report-error';
import { TaskQuickActionMenu } from './TaskQuickActionMenu';

vi.mock('../../lib/report-error', () => ({
    reportError: vi.fn(),
}));

const now = '2026-02-01T00:00:00.000Z';

const task: Task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    contexts: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
};

const t = (key: string) => ({
    'areas.create': 'Create area',
    'areas.search': 'Search areas',
    'calendar.nextMonth': 'Next month',
    'calendar.prevMonth': 'Previous month',
    'common.cancel': 'Cancel',
    'common.clear': 'Clear',
    'common.delete': 'Delete',
    'common.noMatches': 'No matches',
    'common.save': 'Save',
    'nav.calendar': 'Calendar',
    'projects.duplicate': 'Duplicate',
    'projects.search': 'Search projects',
    'review.markReviewed': 'Mark reviewed',
    'task.convertToReference': 'Convert to Reference',
    'task.convertToSection': 'Convert to Section',
    'task.createProjectFromTask': 'Create project from task',
    'task.aria.dueTime': 'Due time',
    'task.aria.reviewTime': 'Review time',
    'task.aria.startTime': 'Start time',
    'taskEdit.areaLabel': 'Area',
    'priority.low': 'Low',
    'priority.medium': 'Medium',
    'priority.high': 'High',
    'priority.urgent': 'Urgent',
    'taskEdit.contextsLabel': 'Contexts',
    'taskEdit.dueDateLabel': 'Due Date',
    'taskEdit.priorityLabel': 'Priority',
    'taskEdit.moreOptions': 'More options',
    'taskEdit.noAreaOption': 'No Area',
    'taskEdit.noProjectOption': 'No Project',
    'taskEdit.projectLabel': 'Project',
    'taskEdit.reviewDateLabel': 'Review Date',
    'taskEdit.startDateLabel': 'Start Date',
}[key] ?? key);

const createMenuProps = (overrides: Partial<ComponentProps<typeof TaskQuickActionMenu>> = {}): ComponentProps<typeof TaskQuickActionMenu> => ({
    task,
    x: 16,
    y: 16,
    t,
    dateFormatSetting: 'system',
    nativeDateInputLocale: 'en-US',
    contextOptions: [],
    areas: [],
    projects: [],
    readOnly: false,
    prioritiesEnabled: true,
    onClose: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onStatusChange: vi.fn(),
    onCreateArea: vi.fn(async () => null),
    onUpdateTask: vi.fn(async () => ({ success: true })),
    ...overrides,
});

const renderMenu = (overrides: Partial<ComponentProps<typeof TaskQuickActionMenu>> = {}) => {
    const props = createMenuProps(overrides);
    render(<TaskQuickActionMenu {...props} />);
    return props;
};

const renderClosableMenu = (overrides: Partial<ComponentProps<typeof TaskQuickActionMenu>> = {}) => {
    const props = createMenuProps(overrides);
    function Harness() {
        const [open, setOpen] = useState(true);
        return open ? (
            <TaskQuickActionMenu
                {...props}
                onClose={(options) => {
                    props.onClose(options);
                    setOpen(false);
                }}
            />
        ) : null;
    }
    render(<Harness />);
    return props;
};

describe('TaskQuickActionMenu', () => {
    it('opens one panel at a time and exposes dialog state without pressed state', () => {
        renderMenu();

        expect(screen.getByRole('menu', { name: /more options/i })).toBeInTheDocument();
        const startButton = screen.getByRole('menuitem', { name: /start date/i });
        expect(startButton).toHaveAttribute('aria-haspopup', 'dialog');
        expect(startButton).toHaveAttribute('aria-expanded', 'false');
        expect(startButton).not.toHaveAttribute('aria-pressed');
        expect(startButton).toHaveClass('focus-visible:ring-2');

        fireEvent.click(startButton);

        expect(startButton).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('dialog', { name: /start date/i }))
            .toHaveClass('w-[min(30rem,calc(100vw-1rem))]');

        const dueButton = screen.getByRole('menuitem', { name: 'Due Date…' });
        fireEvent.click(dueButton);

        expect(dueButton).toHaveAttribute('aria-haspopup', 'dialog');
        expect(startButton).toHaveAttribute('aria-expanded', 'false');
        expect(dueButton).toHaveAttribute('aria-expanded', 'true');
        expect(dueButton).not.toHaveAttribute('aria-pressed');
        expect(dueButton).toHaveClass('focus-visible:ring-2');
        expect(screen.getByRole('dialog', { name: /due date/i })).toBeInTheDocument();

        const reviewButton = screen.getByRole('menuitem', { name: /review date/i });
        fireEvent.click(reviewButton);

        expect(dueButton).toHaveAttribute('aria-expanded', 'false');
        expect(reviewButton).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('dialog', { name: /review date/i })).toBeInTheDocument();
    });

    it('uses Escape to close the active panel before closing the menu', () => {
        const props = renderMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: /due date/i })).not.toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when clicking outside an open date panel', () => {
        const props = renderMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));

        fireEvent.mouseDown(document.body);

        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on an outside click but does not also activate the control underneath it', () => {
        const outsideClick = vi.fn();
        const outsideButton = document.createElement('button');
        outsideButton.textContent = 'Add task to calendar';
        outsideButton.addEventListener('click', outsideClick);
        document.body.appendChild(outsideButton);

        try {
            const props = renderMenu();

            // A real dismissing gesture fires mousedown, then (on the same
            // target) click — both are part of the same user click.
            fireEvent.mouseDown(outsideButton);
            fireEvent.click(outsideButton);

            expect(props.onClose).toHaveBeenCalledTimes(1);
            expect(outsideClick).not.toHaveBeenCalled();
        } finally {
            document.body.removeChild(outsideButton);
        }
    });

    // Pointer dismissals must not restore focus to the opener: the deferred
    // focus() lands after whatever the pointer opened next (another row's
    // menu) and leaves the old row wearing the focus ring (#999). Keyboard
    // closes keep the a11y focus-return.
    it('marks pointer dismissals as no-focus-restore', () => {
        const props = renderMenu();
        fireEvent.mouseDown(document.body);
        expect(props.onClose).toHaveBeenCalledWith({ restoreFocus: false });
        // Finish the gesture: the dismissal armed capture-once click/mouseup
        // swallowers on window, which would otherwise eat the next test's
        // first click.
        fireEvent.mouseUp(document.body);
        fireEvent.click(document.body);
    });

    it('keeps the a11y focus-return on keyboard closes', () => {
        const props = renderMenu();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).toHaveBeenCalledTimes(1);
        expect(props.onClose).not.toHaveBeenCalledWith({ restoreFocus: false });
    });

    it('ignores the initial layout scroll after opening but closes on later scrolls', () => {
        vi.useFakeTimers();
        try {
            const props = renderMenu();

            fireEvent.scroll(window);
            expect(props.onClose).not.toHaveBeenCalled();

            vi.advanceTimersByTime(160);
            fireEvent.scroll(window);

            expect(props.onClose).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    // Focusing a partially clipped item on mousedown scrolls it into view;
    // dismissing on that scroll unmounted the menu before mouseup, so the tap
    // silently did nothing (feedback 9cb87074).
    it('stays open when the scroll comes from inside the menu surface', () => {
        vi.useFakeTimers();
        try {
            const props = renderMenu();
            vi.advanceTimersByTime(160);

            fireEvent.scroll(screen.getByRole('menu'));
            expect(props.onClose).not.toHaveBeenCalled();

            fireEvent.scroll(window);
            expect(props.onClose).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes the due date mini calendar when clicking elsewhere in the quick panel', () => {
        const props = renderMenu({ task: { ...task, dueDate: '2026-04-12' } });
        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));

        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        fireEvent.focus(within(panel).getByLabelText('Due Date'));
        fireEvent.click(within(panel).getByRole('button', { name: 'Due Date Calendar' }));
        expect(screen.getByRole('dialog', { name: 'Due Date Calendar' })).toBeInTheDocument();

        fireEvent.pointerDown(within(panel).getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByRole('dialog', { name: 'Due Date Calendar' })).not.toBeInTheDocument();
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it('discards a popover-selected quick date when Cancel is clicked', async () => {
        const user = userEvent.setup();
        const props = renderMenu({ task: { ...task, dueDate: '2026-04-12' } });
        await user.click(screen.getByRole('menuitem', { name: 'Due Date…' }));

        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        await user.click(within(panel).getByRole('button', { name: 'Due Date Calendar' }));
        const calendar = screen.getByRole('dialog', { name: 'Due Date Calendar' });
        await user.click(within(calendar).getByRole('button', { name: 'Tomorrow' }));

        // Picking a suggestion applies to the draft and closes the popover.
        expect(screen.queryByRole('dialog', { name: 'Due Date Calendar' })).not.toBeInTheDocument();

        await user.click(within(panel).getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByRole('dialog', { name: 'Due Date' })).not.toBeInTheDocument();
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it('saves a popover-selected quick date with one click', async () => {
        const user = userEvent.setup();
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({ onUpdateTask });
        await user.click(screen.getByRole('menuitem', { name: 'Due Date…' }));

        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        await user.click(within(panel).getByRole('button', { name: 'Due Date Calendar' }));
        const calendar = screen.getByRole('dialog', { name: 'Due Date Calendar' });
        await user.click(within(calendar).getByRole('button', { name: 'Tomorrow' }));

        await user.click(within(panel).getByRole('button', { name: 'Save' }));

        const tomorrow = new Date();
        tomorrow.setHours(0, 0, 0, 0);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const pad = (value: number) => String(value).padStart(2, '0');
        const expected = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

        await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
        expect(onUpdateTask).toHaveBeenCalledWith({ dueDate: expected });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('saves a start date from the quick action panel', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({ onUpdateTask });

        fireEvent.click(screen.getByRole('menuitem', { name: /start date/i }));

        const dialog = screen.getByRole('dialog', { name: /start date/i });
        fireEvent.change(within(dialog).getByLabelText('Start Date'), {
            target: { value: '2026-02-04' },
        });
        fireEvent.change(within(dialog).getByLabelText('Start time'), {
            target: { value: '09:30' },
        });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ startTime: '2026-02-04T09:30' });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('saves the panel draft when Enter is pressed in a field', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({ onUpdateTask });

        fireEvent.click(screen.getByRole('menuitem', { name: /start date/i }));
        const dialog = screen.getByRole('dialog', { name: /start date/i });
        const input = within(dialog).getByLabelText('Start Date');
        fireEvent.change(input, { target: { value: '2026-02-04' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ startTime: '2026-02-04' });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('closes without saving when Enter is pressed on an unchanged draft', () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({ task: { ...task, dueDate: '2026-04-12' }, onUpdateTask });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));
        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        fireEvent.keyDown(within(panel).getByLabelText('Due Date'), { key: 'Enter' });

        expect(onUpdateTask).not.toHaveBeenCalled();
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('moves the task into a project from the Project panel and drops its section', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, sectionId: 'section-old' },
            projects: [{
                id: 'project-alpha',
                title: 'Alpha',
                status: 'active',
                color: '#2563eb',
                order: 0,
                tagIds: [],
                createdAt: now,
                updatedAt: now,
            }],
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Project…' }));
        const panel = screen.getByRole('dialog', { name: 'Project' });
        expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
        fireEvent.click(within(panel).getByRole('button', { name: 'No Project' }));
        fireEvent.click(screen.getByRole('option', { name: 'Alpha' }));
        fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith({ projectId: 'project-alpha', sectionId: undefined }));
        await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    });

    it('leaves Enter to the area selector dropdown instead of saving the panel', () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            areas: [{
                id: 'area-work',
                name: 'Work',
                color: '#2563eb',
                order: 0,
                createdAt: now,
                updatedAt: now,
            }],
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Area…' }));
        fireEvent.click(screen.getByRole('button', { name: 'No Area' }));
        const search = screen.getByRole('textbox', { name: 'Search areas' });
        fireEvent.change(search, { target: { value: 'Wo' } });
        fireEvent.keyDown(search, { key: 'Enter' });

        // Enter picked the area in the dropdown; the panel stays open for Save.
        expect(onUpdateTask).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
        const panel = screen.getByRole('dialog', { name: 'Area' });
        expect(within(panel).getByRole('button', { name: 'Work' })).toBeInTheDocument();
    });

    it('keeps a mini-calendar date in the draft until Save', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, dueDate: '2026-04-12' },
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));
        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        fireEvent.focus(within(panel).getByLabelText('Due Date'));
        fireEvent.click(within(panel).getByRole('button', { name: 'Due Date Calendar' }));

        const calendarDay = screen.getByRole('button', { name: /April 19, 2026/i });
        fireEvent.pointerDown(calendarDay);
        fireEvent.click(calendarDay);

        expect(onUpdateTask).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
        expect(within(panel).getByLabelText('Due Date')).toHaveValue('04/19/2026');

        fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
        expect(onUpdateTask).toHaveBeenCalledWith({ dueDate: '2026-04-19' });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('uses the configured date format when saving quick action date text', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, dueDate: '2026-04-12' },
            dateFormatSetting: 'dmy',
            nativeDateInputLocale: 'en-GB-u-fw-mon',
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));
        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        const input = within(panel).getByLabelText('Due Date') as HTMLInputElement;

        expect(input.value).toBe('12/04/2026');
        fireEvent.change(input, { target: { value: '19/04/2026' } });
        fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ dueDate: '2026-04-19' });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('marks a review-due task reviewed from the quick action menu', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, reviewAt: '2000-01-01T00:00:00.000Z' },
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Mark reviewed' }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ reviewAt: undefined });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('advances a review-due task one week from the quick action menu', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, reviewAt: '2000-01-01' },
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Review in 1 week' }));

        const expected = new Date();
        expected.setDate(expected.getDate() + 7);
        const expectedDate = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`;
        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ reviewAt: expectedDate });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('does not show mark reviewed for future review dates', () => {
        renderMenu({
            task: { ...task, reviewAt: '2999-01-01T00:00:00.000Z' },
        });

        expect(screen.queryByRole('menuitem', { name: 'Mark reviewed' })).not.toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Review in 1 week' })).not.toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: /review date/i })).toBeInTheDocument();
    });

    it('keeps the menu open while selecting an area from the selector dropdown', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderClosableMenu({
            areas: [{
                id: 'area-work',
                name: 'Work',
                color: '#2563eb',
                order: 0,
                createdAt: now,
                updatedAt: now,
            }],
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Area…' }));
        fireEvent.click(screen.getByRole('button', { name: 'No Area' }));

        const option = screen.getByRole('option', { name: 'Work' });
        fireEvent.mouseDown(option);
        expect(props.onClose).not.toHaveBeenCalled();

        fireEvent.click(option);
        const panel = screen.getByRole('dialog', { name: 'Area' });
        expect(within(panel).getByRole('button', { name: 'Work' })).toBeInTheDocument();

        fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ areaId: 'area-work' });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('focuses the menu container on open, with no item pre-highlighted', () => {
        renderMenu();

        expect(document.activeElement).toBe(screen.getByRole('menu', { name: /more options/i }));
    });

    it('moves between menu items with arrow keys, wrapping at the ends', () => {
        renderMenu();

        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /start date/i }));

        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Due Date…' }));

        fireEvent.keyDown(window, { key: 'ArrowUp' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /start date/i }));

        fireEvent.keyDown(window, { key: 'ArrowUp' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));

        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /start date/i }));
    });

    it('highlights the focused item with a plain focus style, not focus-visible only', () => {
        renderMenu();

        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(document.activeElement).toHaveClass('focus:bg-muted');
    });

    it('jumps to the first and last item with Home and End', () => {
        renderMenu();

        fireEvent.keyDown(window, { key: 'End' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));

        fireEvent.keyDown(window, { key: 'Home' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /start date/i }));
    });

    it('opens the focused submenu panel with ArrowRight and closes it with ArrowLeft', () => {
        renderMenu();

        const startButton = screen.getByRole('menuitem', { name: /start date/i });
        startButton.focus();
        fireEvent.keyDown(window, { key: 'ArrowRight' });

        expect(screen.getByRole('dialog', { name: /start date/i })).toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'ArrowLeft' });

        expect(screen.queryByRole('dialog', { name: /start date/i })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(startButton);
    });

    it('returns focus to the anchoring item when Escape closes a panel', () => {
        renderMenu();

        const dueButton = screen.getByRole('menuitem', { name: 'Due Date…' });
        fireEvent.click(dueButton);
        expect(screen.getByRole('dialog', { name: 'Due Date' })).toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'Escape' });

        expect(screen.queryByRole('dialog', { name: 'Due Date' })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(dueButton);
    });

    it('skips disabled items when moving focus', () => {
        renderMenu({
            focusAction: {
                isFocused: false,
                canToggle: false,
                label: "Add to today's focus",
                title: 'Clarify first',
                onToggle: vi.fn(),
            },
        });

        fireEvent.keyDown(window, { key: 'Home' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /start date/i }));
    });

    it('lets Escape close the area selector dropdown before the panel and menu', () => {
        const props = renderMenu({
            areas: [{
                id: 'area-work',
                name: 'Work',
                color: '#2563eb',
                order: 0,
                createdAt: now,
                updatedAt: now,
            }],
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Area…' }));
        fireEvent.click(screen.getByRole('button', { name: 'No Area' }));
        const search = screen.getByRole('textbox', { name: 'Search areas' });

        fireEvent.keyDown(search, { key: 'Escape' });
        expect(screen.queryByRole('option', { name: 'Work' })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Area' })).toBeInTheDocument();
        expect(props.onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Area' })).not.toBeInTheDocument();
        expect(props.onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps secondary task row actions in the quick menu', () => {
        const onStatusChange = vi.fn();
        const props = renderMenu({ onStatusChange });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Convert to Reference' }));
        expect(onStatusChange).toHaveBeenCalledWith('reference');
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('runs the convert-to-section action only for a task in a project', () => {
        const onConvertToSection = vi.fn();
        renderMenu({ onConvertToSection });
        expect(screen.queryByRole('menuitem', { name: 'Convert to Section' })).not.toBeInTheDocument();

        const props = renderMenu({
            onConvertToSection,
            task: { ...task, id: 'task-2', projectId: 'project-1' },
        });
        fireEvent.click(screen.getByRole('menuitem', { name: 'Convert to Section' }));

        expect(onConvertToSection).toHaveBeenCalledTimes(1);
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('runs the promote-to-project action from the quick menu', () => {
        const onPromoteToProject = vi.fn();
        const props = renderMenu({ onPromoteToProject });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Create project from task' }));

        expect(onPromoteToProject).toHaveBeenCalledTimes(1);
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('runs the focus action from the quick menu and closes it', () => {
        const onToggle = vi.fn();
        const props = renderMenu({
            focusAction: {
                isFocused: false,
                canToggle: true,
                label: "Add to today's focus",
                title: "Add to today's focus",
                onToggle,
            },
        });

        fireEvent.click(screen.getByRole('menuitem', { name: /add to today's focus/i }));

        expect(onToggle).toHaveBeenCalledTimes(1);
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    // Dismissing the menu must not also activate whatever sits underneath. On the
    // calendar that fall-through opened the "add task to calendar" composer as a
    // side effect of closing the menu (#867). Timing is the whole point of this
    // test: `click` only arrives after `mouseup`, a separate user action, so the
    // task queue is allowed to drain in between exactly as a real press does. A
    // version that dispatched mousedown and click back-to-back passed against an
    // implementation that was broken in the browser.
    const withControlUnderneath = async (
        run: (outside: HTMLButtonElement) => Promise<void>,
    ): Promise<ReturnType<typeof vi.fn>> => {
        const underneath = vi.fn();
        const outside = document.createElement('button');
        outside.addEventListener('click', underneath);
        document.body.appendChild(outside);
        try {
            await run(outside);
        } finally {
            outside.remove();
        }
        return underneath;
    };

    it('swallows the click that dismisses it so the control underneath is not activated', async () => {
        const underneath = await withControlUnderneath(async (outside) => {
            const props = renderClosableMenu();

            fireEvent.mouseDown(outside);
            expect(props.onClose).toHaveBeenCalled();

            await new Promise((resolve) => { setTimeout(resolve, 0); });
            fireEvent.click(outside);
        });

        expect(underneath).not.toHaveBeenCalled();
    });

    it('stops swallowing once the press turns into a drag, so a later click still lands', async () => {
        const underneath = await withControlUnderneath(async (outside) => {
            renderClosableMenu();

            fireEvent.mouseDown(outside);
            // No click ever follows a press that became a drag.
            fireEvent.dragStart(outside);

            await new Promise((resolve) => { setTimeout(resolve, 0); });
            fireEvent.click(outside);
        });

        expect(underneath).toHaveBeenCalledTimes(1);
    });

    it('shows disabled focus actions with a reason', () => {
        const onToggle = vi.fn();
        const reason = 'Clarify this task before adding it to Focus.';
        const props = renderMenu({
            focusAction: {
                isFocused: false,
                canToggle: false,
                label: "Add to today's focus",
                title: reason,
                onToggle,
            },
        });

        const focusAction = screen.getByRole('menuitem', { name: /add to today's focus/i });
        expect(focusAction).toBeDisabled();
        expect(focusAction).toHaveAttribute('title', reason);

        fireEvent.click(focusAction);

        expect(onToggle).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
    });

    describe('priority panel', () => {
        it('persists a chosen priority with its dot and closes the menu once', async () => {
            const user = userEvent.setup();
            const props = renderClosableMenu({ task: { ...task, priority: 'medium' } });
            await user.click(screen.getByRole('menuitem', { name: 'Priority…' }));

            const dialog = screen.getByRole('dialog', { name: 'Priority' });
            // Exactly the four non-empty choices carry the canonical flag; Clear carries none.
            expect(document.querySelectorAll('[data-priority-flag]')).toHaveLength(4);
            const lowFlag = dialog.querySelector('[data-priority-flag="low"]');
            expect(lowFlag).toHaveAttribute('stroke', '#3b82f6');
            expect(within(dialog).getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true');

            await user.click(within(dialog).getByRole('button', { name: 'High' }));

            await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
            expect(props.onUpdateTask).toHaveBeenCalledTimes(1);
            expect(props.onUpdateTask).toHaveBeenCalledWith({ priority: 'high' });
        });

        it('clears the priority through undefined', async () => {
            const user = userEvent.setup();
            const props = renderClosableMenu({ task: { ...task, priority: 'urgent' } });
            await user.click(screen.getByRole('menuitem', { name: 'Priority…' }));

            const dialog = screen.getByRole('dialog', { name: 'Priority' });
            await user.click(within(dialog).getByRole('button', { name: 'Clear' }));

            await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
            expect(props.onUpdateTask).toHaveBeenCalledTimes(1);
            expect(props.onUpdateTask).toHaveBeenCalledWith({ priority: undefined });
        });

        it('hides the priority action when priorities are disabled', () => {
            renderMenu({ prioritiesEnabled: false });

            expect(screen.queryByRole('menuitem', { name: 'Priority…' })).not.toBeInTheDocument();
        });

        it('hides the priority action for read-only tasks', () => {
            renderMenu({ readOnly: true });

            expect(screen.queryByRole('menuitem', { name: 'Priority…' })).not.toBeInTheDocument();
        });

        it('keeps the panel open for retry after a failed update', async () => {
            const user = userEvent.setup();
            const onUpdateTask = vi.fn()
                .mockResolvedValueOnce({ success: false, error: 'sync offline' })
                .mockResolvedValueOnce({ success: true });
            const props = renderClosableMenu({ task: { ...task, priority: 'medium' }, onUpdateTask });
            await user.click(screen.getByRole('menuitem', { name: 'Priority…' }));

            const dialog = screen.getByRole('dialog', { name: 'Priority' });
            await user.click(within(dialog).getByRole('button', { name: 'High' }));

            expect(onUpdateTask).toHaveBeenCalledWith({ priority: 'high' });
            expect(props.onClose).not.toHaveBeenCalled();
            expect(reportError).toHaveBeenCalledTimes(1);

            // The panel stays mounted, the pending state clears, and a retry succeeds.
            await user.click(within(dialog).getByRole('button', { name: 'High' }));

            await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
            expect(onUpdateTask).toHaveBeenCalledTimes(2);
            expect(reportError).toHaveBeenCalledTimes(1);
        });
    });
});
