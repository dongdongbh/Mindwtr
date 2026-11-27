import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useTaskStore, type Project, type Task } from '@mindwtr/core';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { LanguageProvider } from './contexts/language-context';
import { dispatchNavigateEvent } from './lib/navigation-events';
import { useUiStore } from './store/ui-store';

const timestamp = '2026-11-25T17:00:00Z';
const project = (id: string, title: string): Project => ({
    id, title, status: 'active', color: '#6644aa', order: 0, tagIds: [], createdAt: timestamp, updatedAt: timestamp,
});
const tokenTask = (id: string, context: string): Task => ({
    id, title: id, status: 'next', contexts: [context], tags: [], createdAt: timestamp, updatedAt: timestamp,
});
const projects = [project('alpha', 'Alpha Project'), project('bravo', 'Bravo Project')];
const tasks = [tokenTask('a', '@alpha'), tokenTask('b', '@bravo')];

function renderApp() {
    return render(<LanguageProvider><App /><input aria-label="Test input" /></LanguageProvider>);
}

function historyKey(key: 'ArrowLeft' | 'ArrowRight', target: Window | HTMLElement = window) {
    return fireEvent.keyDown(target, { key, altKey: true });
}

function historyMouse(button: 3 | 4) {
    fireEvent(document.body, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button }));
}

function currentView() {
    return new URLSearchParams(location.search).get('view');
}

describe('desktop navigation history', () => {
    beforeEach(() => {
        window.localStorage.clear();
        window.history.replaceState(null, '', '?view=inbox');
        useTaskStore.setState((state) => ({
            ...state,
            tasks,
            projects,
            sections: [],
            areas: [],
            _allTasks: tasks,
            _allProjects: projects,
            _allSections: [],
            _allAreas: [],
            _tasksById: new Map(tasks.map((task) => [task.id, task])),
            _projectsById: new Map(projects.map((item) => [item.id, item])),
            _sectionsById: new Map(),
            _areasById: new Map(),
            settings: { savedSearches: [{ id: 'alpha', name: 'Saved Alpha', query: 'a' }] },
            highlightTaskId: null,
            isLoading: false,
            error: null,
        }));
        useUiStore.setState({ projectView: { selectedProjectId: null }, editingTaskId: null, toasts: [] });
    });

    it('uses shared keyboard and mouse commands and discards a forward branch after a new visit', () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
        act(() => dispatchNavigateEvent('savedSearch:alpha'));
        expect(currentView()).toBe('savedSearch:alpha');

        historyKey('ArrowLeft');
        expect(currentView()).toBe('calendar');
        historyMouse(4);
        expect(currentView()).toBe('savedSearch:alpha');

        historyMouse(3);
        expect(currentView()).toBe('calendar');
        fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
        historyKey('ArrowRight');
        expect(currentView()).toBe('savedSearch:alpha');

        historyMouse(3);
        expect(currentView()).toBe('calendar');
        act(() => dispatchNavigateEvent('agenda'));
        historyKey('ArrowRight');
        expect(currentView()).toBe('agenda');
        historyKey('ArrowLeft');
        historyKey('ArrowLeft');
        historyKey('ArrowLeft');
        expect(currentView()).toBe('inbox');
    });

    it('replays project selection and context combinations and skips deleted destinations', () => {
        const { container } = renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
        const selectProject = (id: string) => {
            const button = container.querySelector(`[data-project-navigation-item][data-project-id="${id}"]`);
            if (!button) throw new Error(`Project ${id} is missing from navigation`);
            fireEvent.click(button);
        };
        selectProject('alpha');
        selectProject('bravo');
        historyKey('ArrowLeft');
        expect(useUiStore.getState().projectView.selectedProjectId).toBe('alpha');
        historyKey('ArrowRight');
        expect(useUiStore.getState().projectView.selectedProjectId).toBe('bravo');

        fireEvent.click(screen.getByRole('button', { name: 'Contexts' }));
        const contextButton = (token: string) => within(screen.getByRole('main')).getByRole('button', { name: new RegExp(`^@${token} \\(1\\)`) });
        fireEvent.click(contextButton('alpha'));
        fireEvent.click(contextButton('bravo'), { ctrlKey: true });
        expect(contextButton('alpha')).toHaveAttribute('aria-pressed', 'true');
        expect(contextButton('bravo')).toHaveAttribute('aria-pressed', 'true');
        historyKey('ArrowLeft');
        expect(contextButton('alpha')).toHaveAttribute('aria-pressed', 'true');
        expect(contextButton('bravo')).toHaveAttribute('aria-pressed', 'false');
        historyKey('ArrowRight');
        expect(contextButton('bravo')).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Any' }));

        act(() => dispatchNavigateEvent('savedSearch:alpha'));
        historyKey('ArrowLeft');
        expect(contextButton('alpha')).toHaveAttribute('aria-pressed', 'true');
        expect(contextButton('bravo')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Any' })).toHaveAttribute('aria-pressed', 'true');
        historyKey('ArrowRight');
        expect(currentView()).toBe('savedSearch:alpha');
        fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
        act(() => useTaskStore.setState((state) => ({
            projects: [projects[0]],
            tasks: [],
            settings: { ...state.settings, savedSearches: [] },
        })));
        historyKey('ArrowLeft');
        expect(currentView()).toBe('contexts');
        expect(screen.queryByRole('button', { name: /^@alpha \(0\)/ })).not.toBeInTheDocument();
        historyKey('ArrowLeft');
        expect(currentView()).toBe('projects');
        expect(useUiStore.getState().projectView.selectedProjectId).toBe('alpha');
    });

    it('keeps editing surfaces and the shortcut dialog in control', () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
        const input = screen.getByRole('textbox', { name: 'Test input' });
        input.focus();
        expect(historyKey('ArrowLeft', input)).toBe(true);
        historyMouse(3);
        expect(currentView()).toBe('calendar');
        input.blur();

        act(() => useUiStore.getState().setEditingTaskId('a'));
        historyKey('ArrowLeft');
        expect(currentView()).toBe('calendar');
        act(() => useUiStore.getState().setEditingTaskId(null));

        fireEvent.keyDown(window, { key: '?' });
        const help = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' });
        expect(within(help).getByText('Alt+←')).toBeInTheDocument();
        expect(within(help).getByText('Alt+→')).toBeInTheDocument();
        historyKey('ArrowLeft');
        expect(currentView()).toBe('calendar');
        fireEvent.keyDown(window, { key: 'Escape' });
        historyKey('ArrowLeft');
        expect(currentView()).toBe('inbox');
    });
});
