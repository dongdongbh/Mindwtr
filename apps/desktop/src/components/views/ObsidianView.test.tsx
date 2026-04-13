import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

import { LanguageProvider } from '../../contexts/language-context';
import { useObsidianStore } from '../../store/obsidian-store';
import { ObsidianView } from './ObsidianView';

const initialState = useObsidianStore.getState();

const renderWithProviders = () => render(
    <LanguageProvider>
        <ObsidianView />
    </LanguageProvider>
);

const resetObsidianStore = () => {
    act(() => {
        useObsidianStore.setState(initialState, true);
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
                taskNotesIncludeArchived: false,
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
                    taskNotesIncludeArchived: false,
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
                    taskNotesIncludeArchived: false,
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
                    taskNotesIncludeArchived: false,
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
});
