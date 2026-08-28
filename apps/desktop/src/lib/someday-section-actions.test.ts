import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type ViewSectionDefinition } from '@mindwtr/core';

import { useUiStore } from '../store/ui-store';
import { createSomedaySection } from './someday-section-actions';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

function arrange(sections: ViewSectionDefinition[] = []) {
    const updateSettings = vi.fn(async () => undefined);
    useTaskStore.setState({
        settings: {
            gtd: {
                viewSections: { someday: sections },
            },
        },
        updateSettings,
    });
    return updateSettings;
}

function setSomedayGroupBy(groupBy: typeof initialUiState.listOptions.somedayGroupBy) {
    useUiStore.setState((state) => ({
        listOptions: { ...state.listOptions, somedayGroupBy: groupBy },
    }));
}

describe('createSomedaySection', () => {
    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
        setSomedayGroupBy('none');
    });

    it('groups by Someday section after creating the first section from the default axis', async () => {
        const updateSettings = arrange();

        const createdId = await createSomedaySection('Books to read');

        expect(createdId).toEqual(expect.any(String));
        expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
            gtd: expect.objectContaining({
                viewSections: {
                    someday: [expect.objectContaining({ id: createdId, title: 'Books to read', order: 0 })],
                },
            }),
        }));
        expect(useUiStore.getState().listOptions.somedayGroupBy).toBe('viewSection');
    });

    it('does not change the axis when creating a second section', async () => {
        arrange([{ id: 'books', title: 'Books to read', order: 0 }]);

        await createSomedaySection('Career ideas');

        expect(useUiStore.getState().listOptions.somedayGroupBy).toBe('none');
    });

    it('does not override an explicitly selected axis when creating the first section', async () => {
        arrange();
        setSomedayGroupBy('project');

        await createSomedaySection('Career ideas');

        expect(useUiStore.getState().listOptions.somedayGroupBy).toBe('project');
    });

    it('leaves the section axis selected after the last section is deleted', async () => {
        arrange();
        const createdId = await createSomedaySection('Books to read');
        expect(useUiStore.getState().listOptions.somedayGroupBy).toBe('viewSection');

        useTaskStore.setState({
            settings: {
                gtd: {
                    viewSections: {
                        someday: [{ id: createdId!, title: 'Books to read', order: 0 }],
                    },
                },
            },
        });
        useTaskStore.setState({
            settings: { gtd: { viewSections: { someday: [] } } },
        });

        expect(useUiStore.getState().listOptions.somedayGroupBy).toBe('viewSection');
    });
});
