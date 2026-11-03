import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type ViewSectionDefinition } from '@mindwtr/core';

import { useUiStore } from '../store/ui-store';
import { createSomedaySection } from './someday-section-actions';

const flushMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    flushPendingSave: flushMock,
}));

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
        flushMock.mockReset();
        flushMock.mockResolvedValue(undefined);
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
        expect(flushMock).toHaveBeenCalledTimes(1);
    });

    it('keeps every stored entry as it is, in stored order, including ones this build cannot show', async () => {

        const folder = { kind: 'folder', children: ['books'] } as unknown as ViewSectionDefinition;
        const books = { id: 'books', title: 'Books to read', order: 1 };
        const films = { id: 'films', title: 'Films', order: 0 };
        const updateSettings = arrange([books, folder, films]);

        const createdId = await createSomedaySection('Career ideas');

        expect(updateSettings).toHaveBeenCalledWith({
            gtd: { viewSections: { someday: [books, folder, films, { id: createdId, title: 'Career ideas', order: 2 }] } },
        });
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

    it('does not return an optimistic existing id after terminal save failure until recovery is durable', async () => {
        const persistedSections: { current: ViewSectionDefinition[] } = { current: [] };
        const updateSettings = vi.fn(async (updates: Parameters<typeof initialTaskState.updateSettings>[0]) => {
            useTaskStore.setState((state) => ({
                settings: { ...state.settings, ...updates },
            }));
        });
        const retryPersistence = vi.fn(async () => {
            persistedSections.current = [
                ...(useTaskStore.getState().settings?.gtd?.viewSections?.someday ?? []),
            ];
            useTaskStore.setState({ persistenceFailure: null });
        });
        useTaskStore.setState({
            settings: { gtd: { viewSections: { someday: [] } } },
            updateSettings,
            retryPersistence,
            persistenceFailure: null,
        });
        flushMock.mockImplementationOnce(async () => {
            useTaskStore.setState({
                persistenceFailure: {
                    message: 'Disk unavailable',
                    failedAt: '2026-09-15T00:00:00.000Z',
                    retrying: false,
                },
            });
            throw new Error('terminal storage failure');
        });

        await expect(createSomedaySection('Books to read')).rejects.toThrow('terminal storage failure');
        const optimisticId = useTaskStore.getState().settings?.gtd?.viewSections?.someday?.[0]?.id;
        expect(optimisticId).toEqual(expect.any(String));
        expect(persistedSections.current).toEqual([]);
        expect(useUiStore.getState().listOptions.somedayGroupBy).toBe('none');

        retryPersistence.mockRejectedValueOnce(new Error('recovery still unavailable'));
        await expect(createSomedaySection('Books to read')).rejects.toThrow('recovery still unavailable');
        expect(persistedSections.current).toEqual([]);

        const recoveredId = await createSomedaySection('Books to read');
        expect(recoveredId).toBe(optimisticId);
        expect(updateSettings).toHaveBeenCalledTimes(1);
        expect(retryPersistence).toHaveBeenCalledTimes(2);
        expect(persistedSections.current).toEqual([expect.objectContaining({ id: optimisticId, title: 'Books to read' })]);
        expect(useUiStore.getState().listOptions.somedayGroupBy).toBe('viewSection');


        useTaskStore.setState({ settings: { gtd: { viewSections: { someday: persistedSections.current } } } });
        expect(useTaskStore.getState().settings?.gtd?.viewSections?.someday?.[0]?.id).toBe(optimisticId);
    });
});
