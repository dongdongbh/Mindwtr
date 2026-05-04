import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { TaskItem } from '../components/TaskItem';
import { GlobalSearch } from '../components/GlobalSearch';
import { KeybindingHelpModal } from '../components/KeybindingHelpModal';
import { ToastHost } from '../components/ToastHost';
import { TaskItemRecurrenceModal } from '../components/Task/TaskItemRecurrenceModal';
import { Task, useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';
import { GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT } from '../lib/global-quick-add-shortcut';
import { PomodoroPanel } from '../components/views/PomodoroPanel';

const mockTask: Task = {
    id: '1',
    title: 'Test Task',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

const renderWithLanguage = (ui: React.ReactElement) => render(
    <LanguageProvider>
        {ui}
    </LanguageProvider>
);

const runAxe = (container: HTMLElement) => axe(container, {
    rules: {
        // jsdom cannot compute CSS variable/theme contrast reliably; keep this covered by browser/manual checks.
        'color-contrast': { enabled: false },
    },
});

const recurrenceText: Record<string, string> = {
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.save': 'Save',
    'keybindings.helpTitle': 'Keyboard shortcuts',
    'keybindings.helpSubtitle': 'Available shortcuts',
    'keybindings.styleLabel': 'Style',
    'keybindings.style.vim': 'Vim',
    'keybindings.section.global': 'Global',
    'keybindings.section.taskList': 'Task list',
    'keybindings.quickAdd': 'Quick add',
    'keybindings.openSettings': 'Open settings',
    'keybindings.toggleSidebar': 'Toggle sidebar',
    'keybindings.toggleFocusMode': 'Toggle focus mode',
    'keybindings.list.toggleDetails': 'Toggle details',
    'keybindings.list.toggleDensity': 'Toggle density',
    'keybindings.toggleFullscreen': 'Toggle fullscreen',
    'keybindings.openSearch': 'Open search',
    'keybindings.openHelp': 'Open help',
    'keybindings.focusSidebar': 'Focus sidebar',
    'keybindings.focusContent': 'Focus content',
    'keybindings.goInbox': 'Go to Inbox',
    'keybindings.goNext': 'Go to Next',
    'keybindings.goAgenda': 'Go to Agenda',
    'keybindings.goProjects': 'Go to Projects',
    'keybindings.goContexts': 'Go to Contexts',
    'keybindings.goReview': 'Go to Review',
    'keybindings.goWaiting': 'Go to Waiting',
    'keybindings.goSomeday': 'Go to Someday',
    'keybindings.goReference': 'Go to Reference',
    'keybindings.goCalendar': 'Go to Calendar',
    'keybindings.goBoard': 'Go to Board',
    'keybindings.goDone': 'Go to Done',
    'keybindings.goArchived': 'Go to Archived',
    'keybindings.list.nextPrev': 'Next or previous task',
    'keybindings.list.firstLast': 'First or last task',
    'keybindings.list.edit': 'Edit task',
    'keybindings.list.saveEdit': 'Save edit',
    'keybindings.list.cancelEdit': 'Cancel edit',
    'keybindings.list.toggleDone': 'Toggle done',
    'keybindings.list.delete': 'Delete task',
    'keybindings.list.newTask': 'New task',
    'nav.settings': 'Settings',
    'recurrence.customTitle': 'Custom recurrence',
    'recurrence.repeatEvery': 'Repeat every',
    'recurrence.monthUnit': 'month(s)',
    'recurrence.onLabel': 'On',
    'recurrence.onDayOfMonth': 'Day {day}',
    'recurrence.onNthWeekday': 'The {ordinal} {weekday}',
    'recurrence.ordinalSelectLabel': 'Recurrence ordinal',
    'recurrence.weekdaySelectLabel': 'Recurrence weekday',
    'recurrence.ordinal.first': 'First',
    'recurrence.ordinal.second': 'Second',
    'recurrence.ordinal.third': 'Third',
    'recurrence.ordinal.fourth': 'Fourth',
    'recurrence.ordinal.last': 'Last',
};

beforeEach(() => {
    useUiStore.setState({
        editingTaskId: null,
        toasts: [],
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Accessibility', () => {
    it('TaskItem should have no violations', async () => {
        const { container } = renderWithLanguage(<TaskItem task={mockTask} />);
        const results = await runAxe(container);
        expect(results.violations).toHaveLength(0);
    });

    it('ToastHost should have no violations', async () => {
        useUiStore.setState({
            toasts: [
                {
                    id: 'toast-1',
                    message: 'Sync completed',
                    tone: 'success',
                },
            ],
        });

        const { container } = renderWithLanguage(<ToastHost />);
        const results = await runAxe(container);
        expect(results.violations).toHaveLength(0);
    });

    it('GlobalSearch should have no violations when open', async () => {
        vi.useFakeTimers();
        const { container } = renderWithLanguage(<GlobalSearch onNavigate={vi.fn()} />);

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        vi.useRealTimers();

        const results = await runAxe(container);
        expect(results.violations).toHaveLength(0);
    });

    it('PomodoroPanel should have no violations with task linking enabled', async () => {
        useTaskStore.setState((state) => ({
            ...state,
            settings: {
                ...(state.settings ?? {}),
                notificationsEnabled: false,
                gtd: {
                    ...(state.settings?.gtd ?? {}),
                    pomodoro: {
                        ...(state.settings?.gtd?.pomodoro ?? {}),
                        linkTask: true,
                    },
                },
            },
            updateTask: vi.fn().mockResolvedValue(undefined),
        }));

        const { container } = renderWithLanguage(<PomodoroPanel tasks={[mockTask]} />);
        const results = await runAxe(container);
        expect(results.violations).toHaveLength(0);
    });

    it('KeybindingHelpModal should have no violations', async () => {
        const { container } = render(
            <KeybindingHelpModal
                style="vim"
                onClose={vi.fn()}
                currentView="inbox"
                quickAddShortcut={GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT}
                t={(key) => recurrenceText[key] ?? key}
            />
        );

        const results = await runAxe(container);
        expect(results.violations).toHaveLength(0);
    });

    it('TaskItemRecurrenceModal should have no violations', async () => {
        const { container } = render(
            <TaskItemRecurrenceModal
                t={(key) => recurrenceText[key] ?? key}
                weekdayOrder={['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']}
                weekdayLabels={{
                    MO: 'Monday',
                    TU: 'Tuesday',
                    WE: 'Wednesday',
                    TH: 'Thursday',
                    FR: 'Friday',
                    SA: 'Saturday',
                    SU: 'Sunday',
                }}
                customInterval={1}
                customMode="date"
                customOrdinal="1"
                customWeekday="MO"
                customMonthDay={1}
                onIntervalChange={vi.fn()}
                onModeChange={vi.fn()}
                onOrdinalChange={vi.fn()}
                onWeekdayChange={vi.fn()}
                onMonthDayChange={vi.fn()}
                onClose={vi.fn()}
                onApply={vi.fn()}
            />
        );

        const results = await runAxe(container);
        expect(results.violations).toHaveLength(0);
    });
});
