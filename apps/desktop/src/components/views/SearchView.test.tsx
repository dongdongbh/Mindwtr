import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useTaskStore, type Task } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { SearchView } from './SearchView';

const initialTaskState = useTaskStore.getState();
const nowIso = '2026-06-01T12:00:00.000Z';

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
});

const renderSearchView = () => render(
    <LanguageProvider>
        <SearchView savedSearchId="saved-1" />
    </LanguageProvider>,
);

describe('SearchView', () => {
    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        const tasks = [
            makeTask('task-1', { title: 'Launch notes' }),
            makeTask('task-2', { title: 'Launch checklist' }),
            makeTask('task-3', { title: 'Home errands' }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {
                savedSearches: [
                    {
                        id: 'saved-1',
                        name: 'Launch',
                        query: 'Launch',
                    },
                ],
            },
        });
    });

    it('selects and clears all visible saved-search results', () => {
        const { getAllByRole, getByRole, getByText, queryByText } = renderSearchView();

        expect(getByText('Launch notes')).toBeInTheDocument();
        expect(getByText('Launch checklist')).toBeInTheDocument();
        expect(queryByText('Home errands')).not.toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true, true]);

        fireEvent.click(getByRole('button', { name: 'Clear' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([false, false]);
    });

    it('shows bulk organize for selected saved-search results', () => {
        const { getByRole } = renderSearchView();

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getByRole('button', { name: 'Bulk organize' })).toBeInTheDocument();
    });
});
