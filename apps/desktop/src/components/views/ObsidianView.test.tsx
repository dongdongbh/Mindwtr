import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

import { LanguageProvider } from '../../contexts/language-context';
import { useTaskStore } from '@mindwtr/core';
import { ObsidianService } from '../../lib/obsidian-service';
import { useObsidianStore } from '../../store/obsidian-store';
import { ObsidianView } from './ObsidianView';

const initialState = useObsidianStore.getState();
const initialTaskState = useTaskStore.getState();

const renderWithProviders = () => render(
    <LanguageProvider>
        <ObsidianView />
    </LanguageProvider>
);

const resetObsidianStore = () => {
    act(() => {
        useObsidianStore.setState(initialState, true);
        useTaskStore.setState(initialTaskState, true);
    });
};

beforeEach(() => {
    resetObsidianStore();
    act(() => {
        useObsidianStore.setState((state) => ({
            ...state,
            config: {
                vaultPath: null,
                vaultName: '',
                scanFolders: ['/'],
                inboxFile: 'Mindwtr/Inbox.md',
                requiredInlineTag: '',
                taskNotesIncludeArchived: false,
                dataviewMetadataEnabled: false,
                newTaskFormat: 'auto',
                lastScannedAt: null,
                enabled: false,
            },
            tasks: [],
            scannedFileCount: 0,
            scannedRelativePaths: [],
            taskNotesDetectedPaths: [],
            importMode: 'inline',
            hasScannedThisSession: true,
            hasVaultMarker: null,
            isInitialized: true,
            isLoadingConfig: false,
            isScanning: false,
            isWatching: false,
            error: null,
            watcherError: null,
            loadConfig: vi.fn().mockResolvedValue(undefined),
            rescan: vi.fn().mockResolvedValue(undefined),
            clearError: vi.fn(),
        }));
    });

});

afterEach(() => {
    cleanup();
    resetObsidianStore();
    vi.restoreAllMocks();

});

describe('ObsidianView', () => {
    it('shows setup guidance when no vault is configured', () => {
        const { getByText, getByRole } = renderWithProviders();

        expect(getByText('Set up an Obsidian vault')).toBeInTheDocument();
        expect(getByRole('button', { name: 'Open settings' })).toBeInTheDocument();
    });

    it('renders imported tasks and source links', () => {
        act(() => {
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    vaultPath: '/Vault',
                    vaultName: 'Vault',
                    scanFolders: ['/'],
                    inboxFile: 'Mindwtr/Inbox.md',
                    requiredInlineTag: '',
                    taskNotesIncludeArchived: false,
                    dataviewMetadataEnabled: false,
                    newTaskFormat: 'auto',
                    lastScannedAt: '2026-03-14T11:00:00.000Z',
                    enabled: true,
                },
                scannedFileCount: 3,
                taskNotesDetectedPaths: [],
                importMode: 'inline',
                isWatching: true,
                tasks: [{
                    id: 'obsidian-1',
                    text: 'Draft spec #writing',
                    completed: false,
                    tags: ['writing'],
                    wikiLinks: ['Spec Note'],
                    nestingLevel: 0,
                    source: {
                        vaultName: 'Vault',
                        vaultPath: '/Vault',
                        relativeFilePath: 'Projects/Alpha.md',
                        lineNumber: 12,
                        fileModifiedAt: '2026-03-14T10:00:00.000Z',
                        noteTags: ['project/alpha'],
                    },
                    format: 'inline',
                }],
            }));
        });

        const { getByText, getByRole } = renderWithProviders();

        expect(getByText('Draft spec #writing')).toBeInTheDocument();
        expect(getByText('Projects/Alpha.md:12')).toBeInTheDocument();
        expect(getByText('[[Spec Note]]')).toBeInTheDocument();
        expect(getByRole('button', { name: 'Open in Obsidian' })).toBeInTheDocument();
        expect(getByRole('button', { name: 'Add task' })).toBeInTheDocument();
        expect(getByText('Notes scanned: 3')).toBeInTheDocument();
        expect(getByText('Watching for changes')).toBeInTheDocument();
    });

    it('hides completed tasks by default and reveals them on toggle', () => {
        act(() => {
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    vaultPath: '/Vault',
                    vaultName: 'Vault',
                    scanFolders: ['/'],
                    inboxFile: 'Mindwtr/Inbox.md',
                    requiredInlineTag: '',
                    taskNotesIncludeArchived: false,
                    dataviewMetadataEnabled: false,
                    newTaskFormat: 'auto',
                    lastScannedAt: '2026-03-14T11:00:00.000Z',
                    enabled: true,
                },
                scannedFileCount: 2,
                taskNotesDetectedPaths: [],
                importMode: 'inline',
                isWatching: true,
                tasks: [
                    {
                        id: 'obsidian-open',
                        text: 'Open follow-up',
                        completed: false,
                        tags: [],
                        wikiLinks: [],
                        nestingLevel: 0,
                        source: {
                            vaultName: 'Vault',
                            vaultPath: '/Vault',
                            relativeFilePath: 'Projects/Alpha.md',
                            lineNumber: 12,
                            fileModifiedAt: '2026-03-14T10:00:00.000Z',
                            noteTags: [],
                        },
                        format: 'inline',
                    },
                    {
                        id: 'obsidian-done',
                        text: 'Closed follow-up',
                        completed: true,
                        tags: [],
                        wikiLinks: [],
                        nestingLevel: 0,
                        source: {
                            vaultName: 'Vault',
                            vaultPath: '/Vault',
                            relativeFilePath: 'Projects/Alpha.md',
                            lineNumber: 18,
                            fileModifiedAt: '2026-03-14T10:00:00.000Z',
                            noteTags: [],
                        },
                        format: 'inline',
                    },
                ],
            }));
        });

        const { getByRole, getByText, queryByText } = renderWithProviders();

        expect(getByText('Open follow-up')).toBeInTheDocument();
        expect(queryByText('Closed follow-up')).not.toBeInTheDocument();
        expect(getByText('Completed hidden: 1')).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Show completed' }));

        expect(getByText('Closed follow-up')).toBeInTheDocument();
        expect(queryByText('Completed hidden: 1')).not.toBeInTheDocument();
    });

    it('rescans once when a configured vault has not been scanned in this session', async () => {
        const rescan = vi.fn().mockResolvedValue(undefined);

        act(() => {
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    vaultPath: '/Vault',
                    vaultName: 'Vault',
                    scanFolders: ['/'],
                    inboxFile: 'Mindwtr/Inbox.md',
                    requiredInlineTag: '',
                    taskNotesIncludeArchived: false,
                    dataviewMetadataEnabled: false,
                    newTaskFormat: 'auto',
                    lastScannedAt: null,
                    enabled: true,
                },
                taskNotesDetectedPaths: [],
                importMode: 'inline',
                hasScannedThisSession: false,
                rescan,
            }));
        });

        renderWithProviders();

        await waitFor(() => {
            expect(rescan).toHaveBeenCalledTimes(1);
        });
    });

    it('renders tasknotes metadata when tasknotes tasks are present', () => {
        act(() => {
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    vaultPath: '/Vault',
                    vaultName: 'Vault',
                    scanFolders: ['/'],
                    inboxFile: 'Mindwtr/Inbox.md',
                    requiredInlineTag: '',
                    taskNotesIncludeArchived: false,
                    dataviewMetadataEnabled: false,
                    newTaskFormat: 'auto',
                    lastScannedAt: '2026-03-14T11:00:00.000Z',
                    enabled: true,
                },
                scannedFileCount: 1,
                taskNotesDetectedPaths: [
                    'TaskNotes/Archive/Old task.md',
                    'TaskNotes/Review quarterly report.md',
                ],
                importMode: 'tasknotes',
                tasks: [{
                    id: 'obsidian-tasknotes-1',
                    text: 'Review quarterly report',
                    completed: false,
                    tags: ['work'],
                    wikiLinks: [],
                    nestingLevel: 0,
                    source: {
                        vaultName: 'Vault',
                        vaultPath: '/Vault',
                        relativeFilePath: 'TaskNotes/Review quarterly report.md',
                        lineNumber: 0,
                        fileModifiedAt: '2026-03-14T10:00:00.000Z',
                        noteTags: ['work'],
                    },
                    format: 'tasknotes',
                    taskNotesData: {
                        rawStatus: 'in-progress',
                        mindwtrStatus: 'next',
                        priority: 'high',
                        dueDate: '2025-01-15',
                        scheduledDate: '2025-01-14',
                        contexts: ['office'],
                        projects: ['Q1 Planning'],
                        timeEstimateMinutes: 120,
                        recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
                        completedDate: null,
                        bodyPreview: 'Key points to review',
                    },
                }],
            }));
        });

        const { getAllByText, getByText } = renderWithProviders();

        expect(getAllByText('TaskNotes').length).toBeGreaterThan(0);
        expect(getByText('Q1 Planning')).toBeInTheDocument();
        expect(getByText('@office')).toBeInTheDocument();
        expect(getByText(/120m/)).toBeInTheDocument();
        expect(getByText(/Creates a new TaskNotes file in/)).toBeInTheDocument();
        expect(getByText('TaskNotes mode is active')).toBeInTheDocument();
        expect(getByText('TaskNotes/Archive/Old task.md')).toBeInTheDocument();
        expect(getAllByText('TaskNotes/Review quarterly report.md').length).toBeGreaterThan(0);
    });

    it('renders Dataview metadata imported from inline tasks', () => {
        act(() => {
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    vaultPath: '/Vault',
                    vaultName: 'Vault',
                    scanFolders: ['/'],
                    inboxFile: 'Mindwtr/Inbox.md',
                    requiredInlineTag: '',
                    taskNotesIncludeArchived: false,
                    dataviewMetadataEnabled: true,
                    newTaskFormat: 'auto',
                    lastScannedAt: '2026-03-14T11:00:00.000Z',
                    enabled: true,
                },
                scannedFileCount: 1,
                taskNotesDetectedPaths: [],
                importMode: 'inline',
                tasks: [{
                    id: 'obsidian-dataview-1',
                    text: 'Draft proposal [project:: Launch]',
                    completed: false,
                    tags: ['writing'],
                    wikiLinks: [],
                    nestingLevel: 0,
                    source: {
                        vaultName: 'Vault',
                        vaultPath: '/Vault',
                        relativeFilePath: 'Projects/Launch.md',
                        lineNumber: 8,
                        fileModifiedAt: '2026-03-14T10:00:00.000Z',
                        noteTags: [],
                    },
                    format: 'inline',
                    dataviewData: {
                        priority: 'medium',
                        dueDate: '2026-05-01',
                        scheduledDate: '2026-04-28',
                        contexts: ['desk'],
                        projects: ['Launch'],
                        tags: ['writing'],
                        timeEstimateMinutes: 45,
                    },
                }],
            }));
        });

        const { getByText } = renderWithProviders();

        expect(getByText('Dataview')).toBeInTheDocument();
        expect(getByText('Launch')).toBeInTheDocument();
        expect(getByText('@desk')).toBeInTheDocument();
        expect(getByText(/45m/)).toBeInTheDocument();
        expect(getByText(/Due:/)).toBeInTheDocument();
        expect(getByText(/Scheduled:/)).toBeInTheDocument();
    });

    it('brings an imported Obsidian task into Mindwtr with a source backlink', async () => {
        const toggleInline = vi.spyOn(ObsidianService, 'toggleTask');
        const toggleTaskNotes = vi.spyOn(ObsidianService, 'toggleTaskNotesTask');
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [],
                _allTasks: [],
                _tasksById: new Map(),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    vaultPath: '/Vault',
                    vaultName: 'Vault',
                    scanFolders: ['/'],
                    inboxFile: 'Mindwtr/Inbox.md',
                    requiredInlineTag: '',
                    taskNotesIncludeArchived: false,
                    dataviewMetadataEnabled: true,
                    newTaskFormat: 'auto',
                    lastScannedAt: '2026-03-14T11:00:00.000Z',
                    enabled: true,
                },
                scannedFileCount: 1,
                taskNotesDetectedPaths: [],
                importMode: 'inline',
                tasks: [{
                    id: 'obsidian-import-1',
                    text: 'Draft launch brief',
                    completed: false,
                    tags: ['writing'],
                    wikiLinks: [],
                    nestingLevel: 0,
                    source: {
                        vaultName: 'Vault',
                        vaultPath: '/Vault',
                        relativeFilePath: 'Projects/Launch.md',
                        lineNumber: 8,
                        fileModifiedAt: '2026-03-14T10:00:00.000Z',
                        noteTags: [],
                    },
                    format: 'inline',
                    dataviewData: {
                        priority: 'medium',
                        dueDate: '2026-05-01',
                        scheduledDate: '2026-04-28',
                        contexts: ['desk'],
                        projects: ['Launch'],
                        tags: ['strategy'],
                        timeEstimateMinutes: 45,
                    },
                }],
            }));
        });

        const { getByRole } = renderWithProviders();

        fireEvent.click(getByRole('button', { name: 'Bring into Mindwtr' }));

        await waitFor(() => {
            const createdTask = useTaskStore.getState()._allTasks.find((task) => task.title === 'Draft launch brief');
            expect(createdTask).toMatchObject({
                status: 'inbox',
                priority: 'medium',
                dueDate: '2026-05-01',
                startTime: '2026-04-28',
                contexts: ['@desk'],
                tags: ['writing', 'strategy'],
            });
            expect(createdTask?.attachments?.[0]).toMatchObject({
                kind: 'link',
                title: 'Obsidian source',
                uri: 'obsidian://open?vault=Vault&file=Projects%2FLaunch',
            });
        });

        fireEvent.click(getByRole('button', { name: 'Bring into Mindwtr' }));

        await waitFor(() => {
            const createdTasks = useTaskStore.getState()._allTasks.filter((task) => (
                task.attachments?.some((attachment) => attachment.uri === 'obsidian://open?vault=Vault&file=Projects%2FLaunch')
            ));
            expect(createdTasks).toHaveLength(1);
        });
        expect(toggleInline).not.toHaveBeenCalled();
        expect(toggleTaskNotes).not.toHaveBeenCalled();
    });

    it('keeps identical checkboxes distinct and recognizes one after its line number moves', async () => {
        const sourceUri = 'obsidian://open?vault=Vault&file=Projects%2FLaunch';
        const legacyTask = {
            id: 'legacy-note-link',
            title: 'Previously imported note task',
            status: 'inbox' as const,
            tags: [],
            contexts: [],
            attachments: [{
                id: 'legacy-random-link-id',
                kind: 'link' as const,
                title: 'Obsidian source',
                uri: sourceUri,
                createdAt: '2026-03-14T09:00:00.000Z',
                updatedAt: '2026-03-14T09:00:00.000Z',
            }],
            createdAt: '2026-03-14T09:00:00.000Z',
            updatedAt: '2026-03-14T09:00:00.000Z',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [legacyTask],
                _allTasks: [legacyTask],
                _tasksById: new Map([[legacyTask.id, legacyTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    vaultPath: '/Vault',
                    vaultName: 'Vault',
                    scanFolders: ['/'],
                    inboxFile: 'Mindwtr/Inbox.md',
                    requiredInlineTag: '',
                    taskNotesIncludeArchived: false,
                    dataviewMetadataEnabled: false,
                    newTaskFormat: 'auto',
                    lastScannedAt: '2026-03-14T11:00:00.000Z',
                    enabled: true,
                },
                scannedFileCount: 1,
                importMode: 'inline',
                tasks: [
                    {
                        id: 'obsidian-import-1',
                        text: 'Draft launch brief',
                        completed: false,
                        tags: [],
                        wikiLinks: [],
                        nestingLevel: 0,
                        source: {
                            vaultName: 'Vault',
                            vaultPath: '/Vault',
                            relativeFilePath: 'Projects/Launch.md',
                            lineNumber: 8,
                            fileModifiedAt: '2026-03-14T10:00:00.000Z',
                            noteTags: [],
                        },
                        format: 'inline',
                    },
                    {
                        id: 'obsidian-import-2',
                        text: 'Draft launch brief',
                        completed: false,
                        tags: [],
                        wikiLinks: [],
                        nestingLevel: 0,
                        source: {
                            vaultName: 'Vault',
                            vaultPath: '/Vault',
                            relativeFilePath: 'Projects/Launch.md',
                            lineNumber: 12,
                            fileModifiedAt: '2026-03-14T10:00:00.000Z',
                            noteTags: [],
                        },
                        format: 'inline',
                    },
                ],
            }));
        });

        const { getAllByRole } = renderWithProviders();
        const promoteButtons = getAllByRole('button', { name: 'Bring into Mindwtr' });

        fireEvent.click(promoteButtons[0]);
        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.some((task) => task.title === 'Draft launch brief')).toBe(true);
        });

        fireEvent.click(promoteButtons[1]);
        await waitFor(() => {
            const promoted = useTaskStore.getState()._allTasks.filter((task) => (
                task.title === 'Draft launch brief'
            ));
            expect(promoted).toHaveLength(2);
            expect(promoted.map((task) => task.attachments?.[0]?.id)).toHaveLength(2);
            expect(new Set(promoted.map((task) => task.attachments?.[0]?.id)).size).toBe(2);
            expect(promoted.every((task) => task.attachments?.[0]?.uri === sourceUri)).toBe(true);
        });

        fireEvent.click(promoteButtons[0]);
        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.filter((task) => task.title === 'Draft launch brief')).toHaveLength(2);
        });

        act(() => {
            useObsidianStore.setState((state) => ({
                ...state,
                tasks: state.tasks.map((task) => task.id === 'obsidian-import-1'
                    ? {
                        ...task,
                        id: 'obsidian-import-1-moved',
                        source: { ...task.source, lineNumber: 10 },
                    }
                    : task),
            }));
        });

        fireEvent.click(getAllByRole('button', { name: 'Bring into Mindwtr' })[0]);
        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.filter((task) => task.title === 'Draft launch brief')).toHaveLength(2);
        });
    });

    it('recognizes the same checkbox imported with a legacy random attachment id', () => {
        const sourceUri = 'obsidian://open?vault=Vault&file=Projects%2FLaunch';
        const addTask = vi.fn().mockResolvedValue({ success: true });
        const legacyTask = {
            id: 'legacy-checkbox-task',
            title: '  Draft   launch brief  ',
            status: 'inbox' as const,
            tags: [],
            contexts: [],
            attachments: [{
                id: 'legacy-random-link-id',
                kind: 'link' as const,
                title: 'Obsidian source',
                uri: sourceUri,
                createdAt: '2026-03-14T09:00:00.000Z',
                updatedAt: '2026-03-14T09:00:00.000Z',
            }],
            createdAt: '2026-03-14T09:00:00.000Z',
            updatedAt: '2026-03-14T09:00:00.000Z',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
                tasks: [legacyTask],
                _allTasks: [legacyTask],
                _tasksById: new Map([[legacyTask.id, legacyTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    vaultPath: '/Vault',
                    vaultName: 'Vault',
                    scanFolders: ['/'],
                    inboxFile: 'Mindwtr/Inbox.md',
                    requiredInlineTag: '',
                    taskNotesIncludeArchived: false,
                    dataviewMetadataEnabled: false,
                    newTaskFormat: 'auto',
                    lastScannedAt: '2026-03-14T11:00:00.000Z',
                    enabled: true,
                },
                scannedFileCount: 1,
                importMode: 'inline',
                tasks: [{
                    id: 'obsidian-import-1',
                    text: 'Draft launch brief',
                    completed: false,
                    tags: [],
                    wikiLinks: [],
                    nestingLevel: 0,
                    source: {
                        vaultName: 'Vault',
                        vaultPath: '/Vault',
                        relativeFilePath: 'Projects/Launch.md',
                        lineNumber: 8,
                        fileModifiedAt: '2026-03-14T10:00:00.000Z',
                        noteTags: [],
                    },
                    format: 'inline',
                }],
            }));
        });

        const { getByRole } = renderWithProviders();
        fireEvent.click(getByRole('button', { name: 'Bring into Mindwtr' }));

        expect(addTask).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._allTasks).toEqual([legacyTask]);
    });

});
