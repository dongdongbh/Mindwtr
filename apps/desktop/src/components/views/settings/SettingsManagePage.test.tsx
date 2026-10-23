import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';

import { SettingsManagePage } from './SettingsManagePage';

const initialTaskState = useTaskStore.getState();

const translations: Record<string, string> = {
    'areas.manage': 'Manage Areas',
    'common.delete': 'Delete',
    'contexts.tags': 'Tags',
    'contexts.title': 'Contexts',
    'tags.title': 'Tags',
    'contexts.new': 'New context',
    'tags.new': 'New tag',
    'common.add': 'Add',
    'common.edit': 'Edit',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'settings.feedback.saveFailed': 'Could not save. Try again.',
    'people.title': 'People',
    'search.title': 'Search',
    'viewSections.somedaySections': 'Someday sections',
};

const translate = (key: string) => translations[key] ?? key;

describe('SettingsManagePage Someday sections', () => {
    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({
            _allAreas: [],
            _allPeople: [],
            _allTasks: [],
            settings: {
                gtd: {
                    viewSections: {
                        someday: [{ id: 'books', title: 'Books to read', order: 0 }],
                    },
                },
            },
        });
    });

    it('renders collapsed by default and deletes only the heading catalogue from Manage', async () => {
        const updateSettings = vi.fn(async () => undefined);
        const requestConfirmation = vi.fn(async () => true);
        useTaskStore.setState({ updateSettings });

        const view = render(
            <SettingsManagePage
                t={{ manage: 'Manage' }}
                translate={translate}
                requestConfirmation={requestConfirmation}
            />,
        );

        const toggle = view.getByRole('button', { name: /Someday sections\s*1/ });
        expect(view.queryByText('Books to read')).not.toBeInTheDocument();

        fireEvent.click(toggle);
        expect(view.getByDisplayValue('Books to read')).toBeInTheDocument();

        fireEvent.click(view.getByRole('button', { name: 'Delete' }));
        await waitFor(() => {
            expect(requestConfirmation).toHaveBeenCalledWith(expect.objectContaining({
                description: 'Delete "Books to read"?',
            }));
            expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
                gtd: expect.objectContaining({
                    viewSections: expect.objectContaining({ someday: [] }),
                }),
            }));
        });
    });

    it('edits one Someday section and keeps every other stored entry as it is, in stored order', async () => {
        // A newer app's entry this build cannot show.
        const folder = { kind: 'folder', children: ['books'] };
        const films = { id: 'films', title: 'Films', order: 1 };
        const books = { id: 'books', title: 'Books to read', order: 0 };
        const trips = { id: 'trips', title: 'Trips', order: 2 };
        const updateSettings = vi.fn(async () => undefined);
        // Sync adds Trips while the delete confirmation is open.
        const requestConfirmation = vi.fn(async () => {
            useTaskStore.setState({ settings: { gtd: { viewSections: { someday: [films, folder as never, books, trips] } } } });
            return true;
        });
        useTaskStore.setState({ updateSettings, settings: { gtd: { viewSections: { someday: [films, folder as never, books] } } } });

        const view = render(
            <SettingsManagePage
                t={{ manage: 'Manage' }}
                translate={translate}
                requestConfirmation={requestConfirmation}
            />,
        );
        fireEvent.click(view.getByRole('button', { name: /Someday sections\s*2/ }));

        const filmsInput = view.getByDisplayValue('Films');
        fireEvent.change(filmsInput, { target: { value: ' Movies ' } });
        fireEvent.blur(filmsInput);
        expect(updateSettings).toHaveBeenLastCalledWith({
            gtd: { viewSections: { someday: [{ ...films, title: 'Movies' }, folder, books] } },
        });

        fireEvent.click(view.getAllByRole('button', { name: 'Delete' })[0]);
        await waitFor(() => {
            expect(updateSettings).toHaveBeenLastCalledWith({
                gtd: { viewSections: { someday: [films, folder, trips] } },
            });
        });
    });

    it('refuses a new area named like a live area: Create is off, the line says why, the typed name stays', () => {
        const addArea = vi.fn(async () => null);
        const home = { id: 'home', name: 'Home', order: 0, color: '#22c55e', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' };
        useTaskStore.setState({ addArea, areas: [home], _allAreas: [home] });
        const view = render(
            <SettingsManagePage
                t={{ manage: 'Manage' }}
                translate={translate}
                requestConfirmation={vi.fn(async () => true)}
            />,
        );
        fireEvent.click(view.getByRole('button', { name: /Manage Areas\s*1/ }));

        const input = view.getByPlaceholderText('Area name');
        fireEvent.change(input, { target: { value: ' home ' } });
        expect(view.getByText('An area with this name already exists.')).toBeInTheDocument();
        expect(view.getByRole('button', { name: 'Create' })).toBeDisabled();
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(addArea).not.toHaveBeenCalled();
        expect(input).toHaveValue(' home ');
    });

    it('counts assignment and exact person contexts once and opens a completed-inclusive person review', () => {
        useTaskStore.setState({
            _allPeople: [{
                id: 'person-alex',
                name: 'Alex',
                createdAt: '2026-06-01T00:00:00.000Z',
                updatedAt: '2026-06-01T00:00:00.000Z',
            }, {
                id: 'person-casey',
                name: 'Casey',
                createdAt: '2026-06-01T00:00:00.000Z',
                updatedAt: '2026-06-01T00:00:00.000Z',
            }],
            _allTasks: [
                { id: 'assigned', title: 'Assigned', status: 'waiting', assignedTo: 'Alex', tags: [], contexts: [], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
                { id: 'context', title: 'Context', status: 'next', tags: [], contexts: ['@alex'], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
                { id: 'both', title: 'Both', status: 'next', assignedTo: 'Alex', tags: [], contexts: ['@Alex'], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
                { id: 'done', title: 'Done', status: 'done', tags: [], contexts: ['@Alex'], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
                { id: 'hierarchical', title: 'Other', status: 'next', tags: [], contexts: ['@Alex/Office'], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
                { id: 'archived-only', title: 'Archived', status: 'archived', assignedTo: 'Casey', tags: [], contexts: [], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
            ],
        });
        const onOpenSearch = vi.fn();
        window.addEventListener('mindwtr:open-search', onOpenSearch);
        const view = render(
            <SettingsManagePage
                t={{ manage: 'Manage' }}
                translate={translate}
                requestConfirmation={vi.fn(async () => true)}
            />,
        );

        fireEvent.click(view.getByRole('button', { name: /People\s*2/ }));
        expect(view.getByRole('button', { name: /Casey.*1.*tasks/ })).toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: /Alex.*4.*tasks.*Search/ }));

        expect(onOpenSearch).toHaveBeenCalledTimes(1);
        expect((onOpenSearch.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
            query: 'person:"Alex"',
            includeCompleted: true,
        });
        window.removeEventListener('mindwtr:open-search', onOpenSearch);
    });
});


describe('Manage saved contexts and tags', () => {
    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({ _allTasks: [], _allProjects: [], settings: {} });
    });

    it.each([
        ['context', 'Contexts', 'New context', 'addContext'],
        ['tag', 'Tags', 'New tag', 'addTag'],
    ] as const)('creates an unused %s only after Add and keeps its draft until saved', async (_kind, section, label, action) => {
        let finish!: () => void;
        const add = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
        useTaskStore.setState({ [action]: add });
        const view = render(<SettingsManagePage t={{ manage: 'Manage' }} translate={translate} requestConfirmation={vi.fn()} />);
        fireEvent.click(view.getByRole('button', { name: new RegExp(section + '\\s*0') }));
        const input = view.getByLabelText(label);
        fireEvent.change(input, { target: { value: '  Garden  ' } });
        expect(add).not.toHaveBeenCalled();
        fireEvent.click(view.getByRole('button', { name: 'Add' }));
        expect(add).toHaveBeenCalledWith('Garden');
        expect(input).toHaveValue('  Garden  ');
        expect(input).toBeDisabled();
        await act(async () => finish());
        expect(input).toHaveValue('');
        expect(useTaskStore.getState()._allTasks).toEqual([]);
    });

    it('keeps a failed creation visible and Escape cancels a draft without saving', async () => {
        const addContext = vi.fn().mockRejectedValue(new Error('Disk full'));
        useTaskStore.setState({ addContext });
        const view = render(<SettingsManagePage t={{ manage: 'Manage' }} translate={translate} requestConfirmation={vi.fn()} />);
        fireEvent.click(view.getByRole('button', { name: /Contexts\s*0/ }));
        const input = view.getByLabelText('New context');
        fireEvent.change(input, { target: { value: '@garden' } });
        fireEvent.click(view.getByRole('button', { name: 'Add' }));
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Could not save'));
        expect(input).toHaveValue('@garden');
        fireEvent.change(input, { target: { value: '@different' } });
        expect(input).toHaveValue('@garden');
        fireEvent.click(view.getByRole('button', { name: 'Close' }));
        expect(input).toHaveValue('');
        expect(addContext).toHaveBeenCalledTimes(1);
    });

    it('retains a failed rename draft and shows delete failures for unused catalogue rows', async () => {
        const stamp = '2026-10-20T00:00:00.000Z';
        const renameContext = vi.fn().mockRejectedValue(new Error('Disk full'));
        const deleteContext = vi.fn().mockRejectedValue(new Error('Disk full'));
        useTaskStore.setState({ renameContext, deleteContext, settings: { taxonomy: {
            contexts: [{ token: '@garden', rev: 1, revBy: 'test', updatedAt: stamp }],
        } } });
        const view = render(<SettingsManagePage t={{ manage: 'Manage' }} translate={translate} requestConfirmation={vi.fn()} />);
        fireEvent.click(view.getByRole('button', { name: /Contexts\s*1/ }));
        fireEvent.click(view.getByRole('button', { name: 'Edit' }));
        const input = view.getByDisplayValue('@garden');
        fireEvent.change(input, { target: { value: '@outside' } });
        fireEvent.click(view.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Could not save'));
        expect(input).toHaveValue('@outside');
        expect(renameContext).toHaveBeenCalledWith('@garden', '@outside');
        fireEvent.click(view.getByRole('button', { name: 'Close' }));
        fireEvent.click(view.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(deleteContext).toHaveBeenCalledWith('@garden'));
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Could not save'));
        expect(view.getByText('@garden')).toBeInTheDocument();
    });


    it.each(['rename', 'delete'] as const)('preserves %s errors and retry state across an optimistic inventory replacement', async (mode) => {
        const stamp = '2026-10-20T00:00:00.000Z';
        const entry = { token: '@garden', rev: 1, revBy: 'test', updatedAt: stamp };
        useTaskStore.setState({ settings: { taxonomy: { contexts: [entry] } }, _allTasks: [{
            id: 'assigned', title: 'Assigned', status: 'next', contexts: ['@garden'], tags: [], createdAt: stamp, updatedAt: stamp,
        }] });
        let reject!: (reason: Error) => void;
        let finish!: () => void;
        const change = vi.fn().mockImplementationOnce(() => {
            // The real store publishes its inventory before persistence has finished.
            useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((task) => ({ ...task, contexts: mode === 'rename' ? ['@outside'] : [] })), settings: { taxonomy: { contexts: [mode === 'rename'
                ? { ...entry, token: '@outside', rev: 2 }
                : { ...entry, deletedAt: stamp, rev: 2 }] } } });
            return new Promise<void>((_resolve, fail) => { reject = fail; });
        }).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
        useTaskStore.setState(mode === 'rename' ? { renameContext: change } : { deleteContext: change });
        const view = render(<SettingsManagePage t={{ manage: 'Manage' }} translate={translate} requestConfirmation={vi.fn()} />);
        fireEvent.click(view.getByRole('button', { name: /Contexts\s*1/ }));
        if (mode === 'rename') {
            fireEvent.click(view.getByRole('button', { name: 'Edit' }));
            fireEvent.change(view.getByDisplayValue('@garden'), { target: { value: '@outside' } });
        }
        const action = mode === 'rename' ? 'Save' : 'Delete';
        fireEvent.click(view.getByRole('button', { name: action }));
        expect(useTaskStore.getState().getDerivedState().allContexts).not.toContain('@garden');
        expect(mode === 'rename' ? view.getByDisplayValue('@outside') : view.getByText('@garden')).toBeInTheDocument();
        await act(async () => reject(new Error('Disk full')));
        expect(view.getByRole('alert')).toHaveTextContent('Could not save');
        if (mode === 'rename') {
            for (const attempted of ['@other', '@garden']) {
                fireEvent.change(view.getByDisplayValue('@outside'), { target: { value: attempted } });
                expect(view.getByDisplayValue('@outside')).toBeDisabled();
            }
            expect(useTaskStore.getState()._allTasks[0].contexts).toEqual(['@outside']);
        }
        fireEvent.click(view.getByRole('button', { name: /Contexts\s*1/ }));
        fireEvent.click(view.getByRole('button', { name: /Contexts\s*1/ }));
        expect(view.getByRole('alert')).toHaveTextContent('Could not save');
        if (mode === 'rename') expect(view.getByDisplayValue('@outside')).toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: action }));
        expect(change).toHaveBeenCalledTimes(2);
        if (mode === 'rename') expect(change).toHaveBeenLastCalledWith('@garden', '@outside');
        expect(view.getByRole('button', { name: action })).toBeDisabled();
        await act(async () => finish());
        expect(view.queryByRole('alert')).toBeNull();
        if (mode === 'rename') {
            expect(view.getByText('@outside')).toBeInTheDocument();
            fireEvent.click(view.getByRole('button', { name: 'Edit' }));
            expect(view.getByDisplayValue('@outside')).toBeEnabled();
        } else expect(view.queryByText('@garden')).toBeNull();
    });

});
