import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useTaskStore, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { AgendaView } from './AgendaView';
import { useUiStore } from '../../store/ui-store';

const nowIso = '2026-02-28T12:00:00.000Z';

const focusedTask: Task = {
    id: 'focused-task',
    title: 'Focused task',
    status: 'next',
    isFocusedToday: true,
    checklist: [
        { id: 'item-1', title: 'Checklist item', isCompleted: false },
    ],
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
};

const renderAgenda = () => render(
    <LanguageProvider>
        <AgendaView />
    </LanguageProvider>
);

describe('AgendaView', () => {
    beforeEach(() => {
        useTaskStore.setState({
            tasks: [focusedTask],
            _allTasks: [focusedTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });
        useUiStore.setState({
            listOptions: {
                showDetails: false,
                nextGroupBy: 'none',
            },
        });
    });

    it('keeps focus task details open when checklist items are toggled', async () => {
        const { getByRole, getByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /toggle task details/i }));
        const checklistItem = getByText('Checklist item');
        expect(checklistItem).toBeInTheDocument();

        fireEvent.click(checklistItem);

        expect(getByText('Checklist item')).toBeInTheDocument();
    });

    it('keeps non-next tasks with start time today out of Today', () => {
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const startTodayTask: Task = {
            id: 'start-today-task',
            title: 'Start today inbox task',
            status: 'inbox',
            startTime: startToday,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [startTodayTask],
            _allTasks: [startTodayTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { queryByRole, queryByText } = renderAgenda();

        expect(queryByRole('heading', { name: /today/i })).not.toBeInTheDocument();
        expect(queryByText('Start today inbox task')).not.toBeInTheDocument();
    });

    it('shows next tasks with start time today in Today section (not Next Actions)', () => {
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const startTodayNextTask: Task = {
            id: 'start-today-next-task',
            title: 'Start today next task',
            status: 'next',
            startTime: startToday,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [startTodayNextTask],
            _allTasks: [startTodayNextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByRole } = renderAgenda();

        expect(getByRole('heading', { name: /today/i })).toBeInTheDocument();
        expect(getByText('Start today next task')).toBeInTheDocument();
        expect(queryByRole('heading', { name: /next actions/i })).not.toBeInTheDocument();
    });

    it('keeps waiting tasks with review dates out of Today', () => {
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const reviewDue = new Date(now.getTime() - 60_000).toISOString();
        const waitingTask: Task = {
            id: 'waiting-review-task',
            title: 'Waiting review task',
            status: 'waiting',
            startTime: startToday,
            reviewAt: reviewDue,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [waitingTask],
            _allTasks: [waitingTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getAllByText, getByRole, queryByRole } = renderAgenda();

        expect(queryByRole('heading', { name: /today/i })).not.toBeInTheDocument();
        expect(getByRole('heading', { name: /review due/i })).toBeInTheDocument();
        expect(getAllByText('Waiting review task')).toHaveLength(1);
    });

    it('opens editor when double-clicking a non-focused task row in Focus', () => {
        const nextTask: Task = {
            id: 'next-action-task',
            title: 'Next action task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [nextTask],
            _allTasks: [nextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByDisplayValue } = renderAgenda();
        const row = container.querySelector('[data-task-id="next-action-task"]');
        expect(row).toBeTruthy();

        fireEvent.doubleClick(row!);
        expect(getByDisplayValue('Next action task')).toBeInTheDocument();
    });

    it('groups next actions by context in Focus view', () => {
        const workTask: Task = {
            id: 'next-work-task',
            title: 'Work next task',
            status: 'next',
            contexts: ['@work'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const homeTask: Task = {
            id: 'next-home-task',
            title: 'Home next task',
            status: 'next',
            contexts: ['@home'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [workTask, homeTask],
            _allTasks: [workTask, homeTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByLabelText, getByText } = renderAgenda();
        const groupSelect = getByLabelText('Group') as HTMLSelectElement;
        fireEvent.change(groupSelect, { target: { value: 'context' } });

        expect(getByText('@work')).toBeInTheDocument();
        expect(getByText('@home')).toBeInTheDocument();
        expect(getByText('Work next task')).toBeInTheDocument();
        expect(getByText('Home next task')).toBeInTheDocument();
    });

    it('filters focus tasks by energy level', () => {
        const lowEnergyTask: Task = {
            id: 'low-energy-task',
            title: 'Low energy task',
            status: 'next',
            energyLevel: 'low',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const highEnergyTask: Task = {
            id: 'high-energy-task',
            title: 'High energy task',
            status: 'next',
            energyLevel: 'high',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [lowEnergyTask, highEnergyTask],
            _allTasks: [lowEnergyTask, highEnergyTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Show$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));

        expect(getByText('High energy task')).toBeInTheDocument();
        expect(queryByText('Low energy task')).not.toBeInTheDocument();
    });

    it('collapses next actions when the section header is toggled', () => {
        const nextTask: Task = {
            id: 'next-action-task',
            title: 'Next action task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const reviewTask: Task = {
            id: 'waiting-review-task',
            title: 'Waiting review task',
            status: 'waiting',
            reviewAt: '2026-02-27T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [nextTask, reviewTask],
            _allTasks: [nextTask, reviewTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByRole } = renderAgenda();
        const nextSectionButton = getByRole('button', { name: /next actions/i });

        expect(nextSectionButton).toHaveAttribute('aria-expanded', 'true');
        expect(container.querySelector('[data-task-id="next-action-task"]')).toBeTruthy();
        expect(container.querySelector('[data-task-id="waiting-review-task"]')).toBeTruthy();

        fireEvent.click(nextSectionButton);

        expect(getByRole('button', { name: /next actions/i })).toHaveAttribute('aria-expanded', 'false');
        expect(container.querySelector('[data-task-id="next-action-task"]')).toBeNull();
        expect(container.querySelector('[data-task-id="waiting-review-task"]')).toBeTruthy();
    });

    it('exposes the filter panel state with aria-expanded', () => {
        const { getByRole } = renderAgenda();

        const filtersButton = getByRole('button', { name: /^show$/i });
        expect(filtersButton).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(filtersButton);
        expect(getByRole('button', { name: /hide/i })).toHaveAttribute('aria-expanded', 'true');
    });

    it('renders every grouped no-context task when the list is large', () => {
        const tasks = Array.from({ length: 30 }, (_, index) => ({
            id: `next-task-${index + 1}`,
            title: `Next task ${index + 1}`,
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        } satisfies Task));

        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByLabelText, getByText } = renderAgenda();
        const groupSelect = getByLabelText('Group') as HTMLSelectElement;
        fireEvent.change(groupSelect, { target: { value: 'context' } });

        expect(getByText(/no context/i)).toBeInTheDocument();
        expect(getByText('Next task 30')).toBeInTheDocument();
    });
});
