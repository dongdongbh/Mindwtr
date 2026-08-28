import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';

import { SettingsManagePage } from './SettingsManagePage';

const initialTaskState = useTaskStore.getState();

const translations: Record<string, string> = {
    'areas.manage': 'Manage Areas',
    'common.delete': 'Delete',
    'contexts.tags': 'Tags',
    'contexts.title': 'Contexts',
    'people.title': 'People',
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
});
