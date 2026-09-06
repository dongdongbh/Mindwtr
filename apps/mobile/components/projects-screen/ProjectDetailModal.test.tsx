import React from 'react';
import { Alert, Dimensions, Keyboard, KeyboardAvoidingView, Modal, Platform, Text, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Section, Task } from '@mindwtr/core';

const mockScrollTo = vi.hoisted(() => vi.fn());
const mockScrollToOffset = vi.hoisted(() => vi.fn());
const mockFindNodeHandle = vi.hoisted(() => vi.fn(() => 9001));
const mockMeasureInWindow = vi.hoisted(() => vi.fn());

const themeColors = vi.hoisted(() => ({
    bg: '#0f172a',
    cardBg: '#111827',
    taskItemBg: '#1f2937',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    icon: '#94a3b8',
    border: '#334155',
    tint: '#60a5fa',
    onTint: '#0f172a',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#60a5fa',
    inputBg: '#1e293b',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
    filterBg: '#1e293b',
}));

const translate = vi.hoisted(() => (key: string) => ({
    'attachments.addFile': 'Add file',
    'attachments.addLink': 'Add link',
    'attachments.title': 'Attachments',
    'common.back': 'Back',
    'common.clear': 'Clear',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.hideCompleted': 'Hide completed',
    'common.loading': 'Loading',
    'common.none': 'None',
    'common.notSet': 'Not set',
    'common.save': 'Save',
    'common.showCompleted': 'Show completed',
    'nav.addTask': 'Add task',
    'markdown.edit': 'Edit',
    'markdown.expand': 'Expand',
    'markdown.preview': 'Preview',
    'project.notes': 'Project notes',
    'projects.archive': 'Archive',
    'projects.complete': 'Complete',
    'projects.areaLabel': 'Area',
    'projects.addSection': 'Add Section',
    'projects.deleteSectionConfirm': 'Are you sure you want to delete this section?',
    'projects.duplicate': 'Duplicate',
    'projects.moveDown': 'Move down',
    'projects.moveUp': 'Move up',
    'projects.notesPlaceholder': 'Notes',
    'projects.noArea': 'No Area',
    'projects.reactivate': 'Reactivate',
    'projects.reorderTasks': 'Order',
    'projects.reviewAt': 'Review',
    'projects.sectionPlaceholder': 'Section title',
    'projects.sectionsLabel': 'Sections',
    'projects.sequentialAcrossSections': 'Across sections',
    'projects.sequentialScope': 'Sequential Scope',
    'projects.sequentialWithinSections': 'Within sections',
    'projects.statusLabel': 'Status',
    'sort.default': 'Default',
    'sort.due': 'Due date',
    'sort.label': 'Sort',
    'settings.manage': 'Manage',
    'status.active': 'Active',
    'status.someday': 'Someday',
    'status.waiting': 'Waiting',
    'taskEdit.details': 'Details',
    'taskEdit.dueDateLabel': 'Due Date',
    'taskEdit.startDateLabel': 'Start Date',
    'taskEdit.tagsLabel': 'Tags',
}[key] ?? key));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => themeColors,
}));
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));
vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: translate, language: 'en', setLanguage: () => {}, isReady: true }),
}));

// The modal reads its section/project writers straight off the store. The real
// zustand hook cannot run here (mobile vitest resolves a second React copy), so
// the store is a plain selector over spies.
const storeActions = vi.hoisted(() => ({
    _allProjects: [] as Project[],
    addSection: vi.fn(),
    deleteSection: vi.fn(),
    reorderSections: vi.fn(),
    updateProject: vi.fn(),
    updateSection: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    const useTaskStore = Object.assign(
        (selector?: (state: typeof storeActions) => unknown) => (selector ? selector(storeActions) : storeActions),
        { getState: () => storeActions, subscribe: () => () => {} },
    );
    return { ...actual, useTaskStore };
});

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    const ReactModule = await import('react');
    return {
        ...actual,
        findNodeHandle: mockFindNodeHandle,
        ScrollView: ReactModule.forwardRef((props: any, ref) => {
            ReactModule.useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
            return ReactModule.createElement('ScrollView', props, props.children);
        }),
        UIManager: {
            ...((actual as any).UIManager ?? {}),
            measureInWindow: mockMeasureInWindow,
        },
    };
});

vi.mock('@react-native-community/datetimepicker', () => ({
    __esModule: true,
    default: () => null,
}));

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return {
        Ionicons: (props: any) => ReactModule.createElement('Ionicons', props),
    };
});

vi.mock('lucide-react-native', () => ({
    CheckCircle2: () => null,
    ClipboardCheck: () => null,
    GripVertical: () => null,
    X: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: any) => children,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-gesture-handler', () => ({
    GestureHandlerRootView: ({ children }: any) => children,
}));

vi.mock('react-native-draggable-flatlist', () => ({
    NestableScrollContainer: ({ children }: any) => children,
}));

vi.mock('../../components/keyboard-accessory-host', () => ({
    KeyboardAccessoryHost: ({ children }: any) => children,
}));

vi.mock('../../components/expanded-markdown-editor', () => ({
    ExpandedMarkdownEditor: () => null,
}));

vi.mock('../../components/markdown-format-toolbar', () => ({
    MarkdownFormatToolbar: () => null,
}));

vi.mock('../../components/markdown-reference-autocomplete', () => ({
    MarkdownReferenceAutocomplete: () => null,
}));

vi.mock('../../components/markdown-text', () => ({
    MarkdownText: () => null,
}));

const taskListPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('../../components/task-list', async () => {
    const ReactModule = await import('react');
    return {
        TaskList: (props: any) => {
            taskListPropsSpy(props);
            if (props.listRef) {
                props.listRef.current = { scrollToOffset: mockScrollToOffset };
            }
            return ReactModule.createElement(
                ReactModule.Fragment,
                null,
                props.headerAccessory,
                props.listHeaderComponent,
            );
        },
    };
});

vi.mock('../../components/AttachmentProgressIndicator', () => ({
    AttachmentProgressIndicator: () => null,
}));

import DateTimePicker from '@react-native-community/datetimepicker';
import { ProjectDetailModal, getProjectDetailModalSafeAreaEdges } from './ProjectDetailModal';
import { getProjectDetailTaskListOptions } from './ProjectTaskList';

const project = (status: Project['status']): Project => ({
    id: 'project-1',
    title: 'Launch',
    status,
    color: '#3b82f6',
    order: 0,
    tagIds: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
});

const section = (id: string, title: string): Section => ({
    id,
    projectId: 'project-1',
    title,
    order: 0,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
});

const originalPlatformOs = Platform.OS;
const originalTimeZone = process.env.TZ;

const setPlatform = (os: typeof Platform.OS) => {
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: os,
    });
};

const findOptionButton = (root: ReturnType<typeof create>['root'], testID: string) => (
    root.find((node) => node.props.testID === testID && node.props.accessibilityRole === 'button')
);

const findContainingModal = (node: any) => {
    let current = node.parent;
    while (current && current.type !== Modal) current = current.parent;
    return current;
};

type ProjectDetailModalProps = React.ComponentProps<typeof ProjectDetailModal>;

const createNotesEditor = (
    overrides: Partial<ProjectDetailModalProps['notes']> = {},
): ProjectDetailModalProps['notes'] => ({
    commitSelectedProjectNotes: vi.fn(),
    handleSelectedProjectNotesApplyAction: vi.fn(() => ({ value: '', selection: { start: 0, end: 0 } })),
    handleSelectedProjectNotesApplyAutocomplete: vi.fn(),
    handleSelectedProjectNotesChange: vi.fn(),
    handleSelectedProjectNotesSelectionChange: vi.fn(),
    handleSelectedProjectNotesUndo: vi.fn(),
    isSelectedProjectNotesFocused: false,
    notesExpanded: true,
    notesFullscreen: false,
    resetProjectNotesUi: vi.fn(),
    selectedProjectNotes: 'Draft',
    selectedProjectNotesDirection: 'ltr',
    selectedProjectNotesInputRef: { current: null },
    selectedProjectNotesSelection: { start: 5, end: 5 },
    selectedProjectNotesTextDirectionStyle: { writingDirection: 'ltr', textAlign: 'left' } as const,
    selectedProjectNotesUndoDepth: 0,
    setIsSelectedProjectNotesFocused: vi.fn(),
    setNotesExpanded: vi.fn(),
    setNotesFullscreen: vi.fn(),
    setShowNotesPreview: vi.fn(),
    showNotesPreview: false,
    ...overrides,
});

const createAttachments = (
    overrides: Partial<ProjectDetailModalProps['attachments']> = {},
): ProjectDetailModalProps['attachments'] => ({
    addProjectFileAttachment: vi.fn(),
    confirmAddProjectLink: vi.fn(),
    downloadAttachment: vi.fn(),
    imagePreviewAttachment: null,
    linkInput: '',
    linkModalVisible: false,
    openAttachment: vi.fn(),
    removeProjectAttachment: vi.fn(),
    resetProjectAttachmentUi: vi.fn(),
    setImagePreviewAttachment: vi.fn(),
    setLinkInput: vi.fn(),
    setLinkModalVisible: vi.fn(),
    ...overrides,
});

const createProjectDetailModalProps = (
    overrides: Partial<ProjectDetailModalProps> = {},
): ProjectDetailModalProps => ({
    areaName: 'No Area',
    attachments: createAttachments(),
    notes: createNotesEditor(),
    onClose: vi.fn(),
    onDeleteProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onOpenAreaPicker: vi.fn(),
    onOpenQuickAdd: vi.fn(),
    onOpenTagPicker: vi.fn(),
    onProjectChange: vi.fn(),
    onTaskSortByChange: vi.fn(),
    project: { ...project('active'), supportNotes: 'Draft' },
    sections: [],
    taskSortBy: 'default',
    ...overrides,
});

// The section, status, area, tag and date controls live behind the collapsed
// details toggle, so anything reaching them has to expand it first.
const expandProjectDetails = (tree: ReturnType<typeof create>) => {
    act(() => {
        tree.root.findByProps({ testID: 'project-details-toggle' }).props.onPress();
    });
};

beforeEach(() => {
    storeActions._allProjects = [];
    for (const action of Object.values(storeActions)) {
        if (typeof action === 'function') action.mockReset();
    }
});

afterEach(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatformOs,
    });
    mockScrollTo.mockReset();
    mockFindNodeHandle.mockReset();
    mockFindNodeHandle.mockReturnValue(9001);
    mockMeasureInWindow.mockReset();
    taskListPropsSpy.mockClear();
    vi.restoreAllMocks();
});

describe('ProjectDetailModal safe area handling', () => {
    it('reserves the top inset for Android full-screen release modals', () => {
        expect(getProjectDetailModalSafeAreaEdges('fullScreen')).toEqual(['top', 'left', 'right', 'bottom']);
    });

    it('preserves the existing page-sheet header spacing path', () => {
        expect(getProjectDetailModalSafeAreaEdges('pageSheet')).toEqual(['left', 'right', 'bottom']);
    });
});

describe('ProjectDetailModal progressive disclosure', () => {
    it('keeps tasks near the top with a compact collapsed project summary', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                areaName: 'Personal',
                notes: createNotesEditor({ selectedProjectNotes: '' }),
                project: { ...project('someday'), isSequential: false, supportNotes: '' },
                sections: [
                    section('section-1', 'Accommodation'),
                    section('section-2', 'Itinerary'),
                    section('section-3', 'Flights'),
                ],
            })} />);
        });

        const summary = tree.root.findByProps({ testID: 'project-details-summary' });
        expect(summary.props.children).toBe('Someday · Parallel · Personal · 3 Sections');
        expect(tree.root.findAllByProps({ testID: 'project-status-picker' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'project-actions-section' })).toHaveLength(0);
    });

    it('reveals the project metadata controls once details are expanded', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        expect(tree.root.findAllByProps({ testID: 'project-status-picker' })).toHaveLength(0);

        expandProjectDetails(tree);

        expect(tree.root.findByProps({ testID: 'project-status-picker' })).toBeTruthy();
        expect(tree.root.findByProps({ testID: 'project-sections-button' })).toBeTruthy();
        expect(tree.root.findAllByProps({ testID: 'project-details-summary' })).toHaveLength(0);
    });
});

describe('ProjectDetailModal notes editing', () => {
    it('commits project notes when the inline notes editor blurs', () => {
        const notes = createNotesEditor();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ notes })} />);
        });

        expandProjectDetails(tree);

        const notesInput = tree.root.findAllByType(TextInput).find((input) => (
            input.props.placeholder === 'Notes'
        ));

        expect(notesInput).toBeTruthy();

        act(() => {
            notesInput?.props.onBlur();
        });

        expect(notes.commitSelectedProjectNotes).toHaveBeenCalledTimes(1);
    });

    it('opens the fullscreen notes editor from the notes header', () => {
        const notes = createNotesEditor();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ notes })} />);
        });

        expandProjectDetails(tree);

        act(() => {
            tree.root.findByProps({ accessibilityLabel: 'Expand' }).props.onPress();
        });

        expect(notes.setNotesFullscreen).toHaveBeenCalledWith(true);
    });
});

describe('ProjectDetailModal section management', () => {
    it('creates a section from project details', async () => {
        storeActions.addSection.mockResolvedValue(section('section-created', 'Grammar'));
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        expandProjectDetails(tree);

        await act(async () => {
            tree.root.findByProps({ testID: 'project-sections-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-add-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-title-input' }).props.onChangeText('Grammar');
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'project-section-save-button' }).props.onPress();
        });

        expect(storeActions.addSection).toHaveBeenCalledWith('project-1', 'Grammar');
    });

    it('renames an existing section from project details', async () => {
        storeActions.updateSection.mockResolvedValue({ ok: true });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                sections: [section('section-1', 'Planning')],
            })} />);
        });

        expandProjectDetails(tree);

        await act(async () => {
            tree.root.findByProps({ testID: 'project-sections-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-edit-section-1' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-title-input' }).props.onChangeText('Speaking');
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'project-section-save-button' }).props.onPress();
        });

        expect(storeActions.updateSection).toHaveBeenCalledWith('section-1', { title: 'Speaking' });
    });

    it('confirms before deleting a section from project details', async () => {
        vi.spyOn(Alert, 'alert').mockImplementation(((_title, _message, buttons) => {
            buttons?.[1]?.onPress?.();
        }) as typeof Alert.alert);
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                sections: [section('section-1', 'Planning')],
            })} />);
        });

        expandProjectDetails(tree);

        await act(async () => {
            tree.root.findByProps({ testID: 'project-sections-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-delete-section-1' }).props.onPress();
        });

        expect(Alert.alert).toHaveBeenCalledWith(
            'Sections',
            'Are you sure you want to delete this section?',
            expect.any(Array),
        );
        expect(storeActions.deleteSection).toHaveBeenCalledWith('section-1');
    });

    it('reorders sections from project details', async () => {
        storeActions.reorderSections.mockResolvedValue(undefined);
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                sections: [
                    { ...section('section-1', 'Planning'), order: 0 },
                    { ...section('section-2', 'Speaking'), order: 1 },
                ],
            })} />);
        });

        expandProjectDetails(tree);

        await act(async () => {
            tree.root.findByProps({ testID: 'project-sections-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-move-down-section-1' }).props.onPress();
        });

        expect(storeActions.reorderSections).toHaveBeenCalledWith('project-1', ['section-2', 'section-1']);
    });
});

describe('ProjectDetailModal metadata pickers', () => {
    it('opens the status menu and writes the picked status', () => {
        const onProjectChange = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ onProjectChange })} />);
        });

        expandProjectDetails(tree);

        expect(tree.root.findAllByProps({ testID: 'project-status-menu-item-waiting' })).toHaveLength(0);

        act(() => {
            tree.root.findByProps({ testID: 'project-status-picker' }).props.onPress();
        });

        expect(tree.root.findByProps({ testID: 'project-status-menu-item-waiting' })).toBeTruthy();

        act(() => {
            tree.root.findByProps({ testID: 'project-status-menu-item-waiting' }).props.onPress();
        });

        expect(storeActions.updateProject).toHaveBeenCalledWith('project-1', { status: 'waiting' });
        expect(onProjectChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'waiting' }));
        expect(tree.root.findAllByProps({ testID: 'project-status-menu-item-waiting' })).toHaveLength(0);
    });

    it('closes the status menu before handing off to the area picker', () => {
        const onOpenAreaPicker = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ onOpenAreaPicker })} />);
        });

        expandProjectDetails(tree);

        act(() => {
            tree.root.findByProps({ testID: 'project-status-picker' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-area-picker' }).props.onPress();
        });

        expect(onOpenAreaPicker).toHaveBeenCalledTimes(1);
        expect(tree.root.findAllByProps({ testID: 'project-status-menu-item-waiting' })).toHaveLength(0);
    });

    it('keeps a picked due date on its local calendar day in a negative offset and clears it', () => {
        process.env.TZ = 'America/Los_Angeles';
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        expandProjectDetails(tree);

        expect(tree.root.findAllByType(DateTimePicker)).toHaveLength(0);

        act(() => {
            tree.root.findByProps({ testID: 'project-due-date-picker' }).props.onPress();
        });

        expect(tree.root.findAllByType(DateTimePicker)).toHaveLength(1);

        act(() => {
            tree.root.findByType(DateTimePicker).props.onChange({}, new Date(2026, 7, 1, 23, 30));
        });

        expect(storeActions.updateProject).toHaveBeenCalledWith('project-1', { dueDate: '2026-08-01' });
        expect(tree.root.findAllByType(DateTimePicker)).toHaveLength(0);

        let stored!: ReturnType<typeof create>;
        act(() => {
            stored = create(<ProjectDetailModal {...createProjectDetailModalProps({
                project: { ...project('active'), dueDate: '2026-08-01' },
            })} />);
        });
        expandProjectDetails(stored);
        act(() => {
            stored.root.findByProps({ accessibilityLabel: 'Clear Due Date' }).props.onPress();
        });
        expect(storeActions.updateProject).toHaveBeenLastCalledWith('project-1', { dueDate: undefined });

        act(() => {
            tree.root.findByProps({ testID: 'project-review-date-picker' }).props.onPress();
        });

        expect(tree.root.findAllByType(DateTimePicker)).toHaveLength(1);
    });

    it('keeps a picked start date on its local calendar day in a positive offset and clears it', () => {
        process.env.TZ = 'Asia/Tokyo';
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        expandProjectDetails(tree);

        act(() => {
            tree.root.findByProps({ testID: 'project-start-date-picker' }).props.onPress();
        });
        act(() => {
            tree.root.findByType(DateTimePicker).props.onChange({}, new Date(2026, 9, 5, 0, 30));
        });

        expect(storeActions.updateProject).toHaveBeenCalledWith('project-1', { startDate: '2026-10-05' });
        expect(tree.root.findAllByType(DateTimePicker)).toHaveLength(0);

        // The clear button only exists once a date is stored, and the mocked
        // store never writes back, so it needs a project that already has one.
        let stored!: ReturnType<typeof create>;
        act(() => {
            stored = create(<ProjectDetailModal {...createProjectDetailModalProps({
                project: { ...project('active'), startDate: '2026-10-05' },
            })} />);
        });
        expandProjectDetails(stored);
        act(() => {
            stored.root.findByProps({ accessibilityLabel: 'Clear Start Date' }).props.onPress();
        });
        expect(storeActions.updateProject).toHaveBeenLastCalledWith('project-1', { startDate: undefined });
    });
});

describe('ProjectDetailModal task sorting', () => {
    it('opens global quick add for project task creation instead of inline add', () => {
        const onOpenQuickAdd = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ onOpenQuickAdd })} />);
        });

        act(() => {
            tree.root.findByProps({ testID: 'project-add-task-button' }).props.onPress();
        });

        expect(onOpenQuickAdd).toHaveBeenCalledWith(expect.objectContaining({
            id: 'project-1',
            title: 'Launch',
        }));
    });

    it('passes the project-local sort to TaskList and handles sort changes', () => {
        const onTaskSortByChange = vi.fn();
        const selectedProjectTasks = [
            {
                id: 'project-task-1',
                title: 'Project task',
                status: 'next',
                projectId: 'project-1',
                createdAt: '2026-05-12T00:00:00.000Z',
                updatedAt: '2026-05-12T00:00:00.000Z',
            },
        ] as Task[];
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                onTaskSortByChange,
                taskSortBy: 'default',
                tasks: selectedProjectTasks,
            })} />);
        });

        expect(taskListPropsSpy).toHaveBeenCalled();
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].project.sortBy).toBe('default');
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].taskSource).toBe(selectedProjectTasks);
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].showFilterButton).toBe(false);

        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-view-sort-option' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'sort-option-due' }).props.onPress();
        });

        expect(onTaskSortByChange).toHaveBeenCalledWith('due');
    });

    it('filters individually archived tasks until Show completed is enabled', () => {
        const activeTask = {
            id: 'project-task-active',
            title: 'Active project task',
            status: 'next',
            projectId: 'project-1',
            createdAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
        } as Task;
        const archivedTask = {
            ...activeTask,
            id: 'project-task-archived',
            title: 'Archived project task',
            status: 'archived',
        } as Task;
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                tasks: [activeTask, archivedTask],
            })} />);
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].taskSource).toEqual([activeTask]);

        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });
        act(() => {
            findOptionButton(tree.root, 'project-view-completed-option').props.onPress();
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].taskSource).toEqual([activeTask, archivedTask]);
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].project.includeArchived).toBe(true);
    });

    it('supplies archived tasks to an archived project list', () => {
        const archivedTask = {
            id: 'project-task-archived',
            title: 'Archived project task',
            status: 'archived',
            projectId: 'project-1',
            createdAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
        } as Task;

        act(() => {
            create(<ProjectDetailModal {...createProjectDetailModalProps({
                project: project('archived'),
                tasks: [archivedTask],
            })} />);
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].taskSource).toEqual([archivedTask]);
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].project.includeArchived).toBe(true);
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].project.readOnly).toBe(true);
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].enableBulkActions).toBe(false);
    });

    it('keeps project task controls outside the scrolling task list', () => {
        const onOpenQuickAdd = vi.fn();
        const onTaskSortByChange = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                onOpenQuickAdd,
                onTaskSortByChange,
                sections: [
                    section('section-1', 'Research'),
                    section('section-2', 'Design'),
                ],
            })} />);
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].headerAccessory).toBeUndefined();
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].externalFilterOpenSignal).toBe(0);

        act(() => {
            tree.root.findByProps({ testID: 'project-task-filter-button' }).props.onPress();
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].externalFilterOpenSignal).toBe(1);

        act(() => {
            tree.root.findByProps({ testID: 'project-add-task-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-view-sort-option' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'sort-option-due' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-view-completed-option' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-view-reorder-option' }).props.onPress();
        });

        expect(onOpenQuickAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-1' }));
        expect(onTaskSortByChange).toHaveBeenCalledWith('due');
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].project.includeDone).toBe(true);
        expect(tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.accessibilityState).toEqual({
            expanded: false,
            selected: true,
        });
    });

    it('keeps completed-task visibility inside the compact view-options menu', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });

        const hiddenToggle = findOptionButton(tree.root, 'project-view-completed-option');
        expect(hiddenToggle.props.accessibilityRole).toBe('button');
        expect(hiddenToggle.props.accessibilityState).toEqual({ selected: false, disabled: false });
        expect(hiddenToggle.findByProps({ name: 'eye-off-outline' }).props.name).toBe('eye-off-outline');

        act(() => {
            hiddenToggle.props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });

        const visibleToggle = findOptionButton(tree.root, 'project-view-completed-option');
        expect(visibleToggle.props.accessibilityState).toEqual({ selected: true, disabled: false });
        expect(visibleToggle.findByProps({ name: 'eye-outline' }).props.name).toBe('eye-outline');
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].project.includeDone).toBe(true);
    });

    it('pins project bulk selection actions above the scrolling task list', () => {
        const onOpenOrganize = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        const taskListProps = taskListPropsSpy.mock.calls.at(-1)?.[0];
        expect(taskListProps.bulkBarPlacement).toBe('external');
        expect(taskListProps.project.enableBulkOrganize).toBe(true);
        expect(typeof taskListProps.onBulkBarPropsChange).toBe('function');

        act(() => {
            taskListProps.onBulkBarPropsChange({
                bulkActionLabel: '',
                bulkActionLoading: false,
                handleBatchDelete: vi.fn(),
                handleBatchMove: vi.fn(),
                hasSelection: true,
                onExitSelectionMode: vi.fn(),
                onOpenOrganize,
                onOpenTagModal: vi.fn(),
                onToggleRangeSelectMode: vi.fn(),
                rangeSelectMode: false,
                selectedCount: 3,
                t: translate,
                themeColors,
            });
        });

        const pinnedBulkBar = tree.root.findByProps({ testID: 'project-task-selection-bulk-bar' });
        expect(pinnedBulkBar.findByProps({ testID: 'task-list-range-select-toggle' })).toBeTruthy();

        act(() => {
            pinnedBulkBar.findByProps({ accessibilityLabel: 'Bulk organize' }).props.onPress();
        });

        expect(onOpenOrganize).toHaveBeenCalledTimes(1);
    });

    it('reflects the active in-sheet filter count on the pinned filter button badge', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        const taskListProps = taskListPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof taskListProps.onFilterStateChange).toBe('function');

        act(() => {
            taskListProps.onFilterStateChange({ activeCount: 2, hasActive: true });
        });

        const filterButton = tree.root.findByProps({ testID: 'project-task-filter-button' });
        expect(filterButton.findAllByProps({ children: 2 }).length).toBeGreaterThan(0);
    });
});

describe('ProjectDetailModal project task scrolling', () => {
    it('scrolls the task list back to the top when reopening a project', () => {
        const selectedProject = { ...project('active'), supportNotes: 'Draft' };
        const selectedProjectTasks = Array.from({ length: 120 }, (_, index) => ({
            id: `project-task-${index + 1}`,
            title: `Project task ${index + 1}`,
            status: 'next',
            projectId: selectedProject.id,
            createdAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
        })) as Task[];
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                project: selectedProject,
                tasks: selectedProjectTasks,
            })} />);
        });

        act(() => {
            taskListPropsSpy.mock.calls.at(-1)?.[0].onListScroll({
                nativeEvent: { contentOffset: { y: 720 } },
            });
        });

        taskListPropsSpy.mockClear();

        act(() => {
            tree.update(<ProjectDetailModal {...createProjectDetailModalProps({
                project: null,
                tasks: [],
            })} />);
        });

        expect(taskListPropsSpy).not.toHaveBeenCalled();
        mockScrollToOffset.mockClear();

        act(() => {
            tree.update(<ProjectDetailModal {...createProjectDetailModalProps({
                project: selectedProject,
                tasks: selectedProjectTasks,
            })} />);
        });

        expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    });


    // #784: exiting reorder mode must NOT restore the pre-reorder offset —
    // TaskList scrolls to the region the reorder view was showing instead, and
    // a restore here would yank the viewport away from the dropped task. The
    // saved offset is reset so it cannot leak into a later bulk-bar restore.
    it('drops the pre-reorder scroll offset when exiting reorder mode', () => {
        act(() => {
            create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        act(() => {
            taskListPropsSpy.mock.calls.at(-1)?.[0].onListScroll({
                nativeEvent: { contentOffset: { y: 480 } },
            });
        });

        act(() => {
            taskListPropsSpy.mock.calls.at(-1)?.[0].project.onReorderModeChange(true);
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].project.reorderMode).toBe(true);
        mockScrollToOffset.mockClear();

        act(() => {
            taskListPropsSpy.mock.calls.at(-1)?.[0].project.onReorderModeChange(false);
        });

        expect(mockScrollToOffset).not.toHaveBeenCalled();

        const taskListProps = taskListPropsSpy.mock.calls.at(-1)?.[0];
        act(() => {
            taskListProps.onBulkBarPropsChange({
                bulkActionLabel: '',
                bulkActionLoading: false,
                handleBatchDelete: vi.fn(),
                handleBatchMove: vi.fn(),
                hasSelection: true,
                onExitSelectionMode: vi.fn(),
                onOpenTagModal: vi.fn(),
                onToggleRangeSelectMode: vi.fn(),
                rangeSelectMode: false,
                selectedCount: 1,
                t: translate,
                themeColors,
            });
        });

        expect(mockScrollToOffset).not.toHaveBeenCalledWith({ offset: 480, animated: false });
    });

    it('restores the project task scroll offset when the external bulk bar appears', () => {
        act(() => {
            create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        act(() => {
            taskListPropsSpy.mock.calls.at(-1)?.[0].onListScroll({
                nativeEvent: { contentOffset: { y: 480 } },
            });
        });

        const taskListProps = taskListPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof taskListProps.onBulkBarPropsChange).toBe('function');
        mockScrollToOffset.mockClear();

        act(() => {
            taskListProps.onBulkBarPropsChange({
                bulkActionLabel: '',
                bulkActionLoading: false,
                handleBatchDelete: vi.fn(),
                handleBatchMove: vi.fn(),
                hasSelection: true,
                onExitSelectionMode: vi.fn(),
                onOpenTagModal: vi.fn(),
                onToggleRangeSelectMode: vi.fn(),
                rangeSelectMode: false,
                selectedCount: 1,
                t: translate,
                themeColors,
            });
        });

        expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: 480, animated: false });
    });
});

describe('ProjectDetailModal keyboard handling', () => {
    it('uses Android height-based keyboard avoidance for the project workspace', () => {
        setPlatform('android');
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        expect(tree.root.findByType(KeyboardAvoidingView).props.behavior).toBe('height');
        expect(taskListPropsSpy).toHaveBeenCalled();
    });

    it('adds Android keyboard bottom space so project quick-add can scroll above the keyboard', () => {
        setPlatform('android');
        vi.spyOn(Dimensions, 'get').mockReturnValue({
            width: 390,
            height: 800,
            scale: 3,
            fontScale: 1,
        });
        const listeners = new Map<string, (event?: any) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: any) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);
        act(() => {
            create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { screenY: 520 } });
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].contentPaddingBottom).toBe(292);
    });

});

describe('ProjectDetailModal lifecycle actions', () => {
    it('moves Duplicate and Archive out of the persistent details stack', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        expect(tree.root.findAllByProps({ testID: 'project-actions-section' })).toHaveLength(0);

        act(() => {
            tree.root.findByProps({ testID: 'project-actions-menu-button' }).props.onPress();
        });

        const duplicate = tree.root.findByProps({ testID: 'project-duplicate-button' });
        expect(duplicate).toBeTruthy();
        expect(tree.root.findByProps({ testID: 'project-archive-button' })).toBeTruthy();
        expect(duplicate.findAllByProps({ testID: 'project-type-toggle' })).toHaveLength(0);
    });

    it('deletes the project from the actions menu after a confirm', () => {
        // The swipe action on the project list was the only way to delete a
        // project on mobile; a reporter looking next to Archive found nothing (#1142).
        vi.spyOn(Alert, 'alert').mockImplementation(((_title, _message, buttons) => {
            buttons?.[1]?.onPress?.();
        }) as typeof Alert.alert);
        const props = createProjectDetailModalProps();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...props} />);
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-actions-menu-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-delete-button' }).props.onPress();
        });

        expect(Alert.alert).toHaveBeenCalledWith(
            'projects.title',
            'projects.deleteConfirm',
            expect.any(Array),
        );
        expect(props.onDeleteProject).toHaveBeenCalledWith(props.project?.id);
    });

    it('archives from the Archive action with a single tap and no native confirm', () => {
        const onProjectChange = vi.fn();
        const alertSpy = vi.spyOn(Alert, 'alert');
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ onProjectChange })} />);
        });

        act(() => {
            tree.root.findByProps({ testID: 'project-actions-menu-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-archive-button' }).props.onPress();
        });

        expect(storeActions.updateProject).toHaveBeenCalledWith('project-1', { status: 'archived' });
        expect(onProjectChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'archived' }));
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('reactivates an archived project with a plain active status write', () => {
        const onProjectChange = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                onProjectChange,
                project: { ...project('archived'), supportNotes: 'Draft' },
            })} />);
        });

        act(() => {
            tree.root.findByProps({ testID: 'project-actions-menu-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-reactivate-button' }).props.onPress();
        });

        expect(storeActions.updateProject).toHaveBeenCalledWith('project-1', { status: 'active' });
        expect(onProjectChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    });

    it('shows the archive explanation only inside the on-demand actions menu', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        const hiddenArchiveAction = findOptionButton(tree.root, 'project-archive-button');
        expect(findContainingModal(hiddenArchiveAction)?.props.visible).toBe(false);

        act(() => {
            tree.root.findByProps({ testID: 'project-actions-menu-button' }).props.onPress();
        });

        const archiveAction = findOptionButton(tree.root, 'project-archive-button');
        expect(findContainingModal(archiveAction)?.props.visible).toBe(true);
        const description = archiveAction.findAll((node) => (
            typeof node.props.children === 'string'
            && node.props.children.toLowerCase().includes('archived')
        ));
        expect(description.length).toBeGreaterThan(0);
    });

    it('shows Reactivate instead of Archive in the actions menu for archived projects', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                project: { ...project('archived'), supportNotes: 'Draft' },
            })} />);
        });

        act(() => {
            tree.root.findByProps({ testID: 'project-actions-menu-button' }).props.onPress();
        });

        expect(tree.root.findByProps({ testID: 'project-reactivate-button' })).toBeTruthy();
        expect(tree.root.findAllByProps({ testID: 'project-archive-button' })).toHaveLength(0);
    });
});

describe('ProjectDetailModal archived projects', () => {
    it('shows archived task data without quick-add or reorder controls', () => {
        expect(getProjectDetailTaskListOptions(project('archived'))).toEqual({
            allowAdd: false,
            enableProjectReorder: false,
            groupCompletedTasksLast: false,
            includeArchived: true,
            includeDone: true,
            readOnly: true,
        });
    });

    it('keeps normal task controls and hides done tasks for non-archived projects by default', () => {
        expect(getProjectDetailTaskListOptions(project('active'))).toEqual({
            allowAdd: true,
            enableProjectReorder: true,
            groupCompletedTasksLast: false,
            includeArchived: false,
            includeDone: false,
            readOnly: false,
        });
    });

    it('shows done and individually archived tasks for active projects when the completed toggle is on', () => {
        expect(getProjectDetailTaskListOptions(project('active'), true)).toEqual({
            allowAdd: true,
            enableProjectReorder: true,
            groupCompletedTasksLast: true,
            includeArchived: true,
            includeDone: true,
            readOnly: false,
        });
    });

    it('keeps done tasks in sequence for sequential projects', () => {
        expect(getProjectDetailTaskListOptions({ ...project('active'), isSequential: true }, true)).toEqual({
            allowAdd: true,
            enableProjectReorder: true,
            groupCompletedTasksLast: false,
            includeArchived: true,
            includeDone: true,
            readOnly: false,
        });
    });

    it('keeps archived project metadata, notes, attachments, and sort controls read-only', () => {
        const notes = createNotesEditor();
        const attachments = createAttachments();
        const onProjectChange = vi.fn();
        const onTaskSortByChange = vi.fn();
        const archivedProject: Project = {
            ...project('archived'),
            supportNotes: 'Historical notes',
            dueDate: '2026-09-01',
            reviewAt: '2026-09-02T12:00:00.000Z',
            attachments: [{
                id: 'attachment-1',
                kind: 'link',
                title: 'Reference',
                uri: 'https://example.com',
                createdAt: '2026-08-31T00:00:00.000Z',
                updatedAt: '2026-08-31T00:00:00.000Z',
            }],
        };
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                attachments,
                notes,
                onProjectChange,
                onTaskSortByChange,
                project: archivedProject,
            })} />);
        });

        const titleInput = tree.root.findAllByType(TextInput).find((input) => input.props.value === 'Launch');
        expect(titleInput?.props.editable).toBe(false);

        expandProjectDetails(tree);

        expect(tree.root.findByProps({ testID: 'project-status-picker' }).props.disabled).toBe(true);
        expect(tree.root.findByProps({ testID: 'project-type-toggle' }).props.disabled).toBe(true);
        expect(tree.root.findByProps({ testID: 'project-area-picker' }).props.disabled).toBe(true);
        expect(tree.root.findByProps({ testID: 'project-due-date-picker' }).props.disabled).toBe(true);
        expect(tree.root.findByProps({ testID: 'project-review-date-picker' }).props.disabled).toBe(true);
        expect(tree.root.findAllByType(TextInput).some((input) => input.props.placeholder === 'Notes')).toBe(false);

        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });
        const sortOption = findOptionButton(tree.root, 'project-view-sort-option');
        expect(sortOption.props.disabled).toBe(true);
        expect(sortOption.props.accessibilityHint).toBe('Reactivate');

        act(() => {
            titleInput?.props.onEndEditing();
            tree.root.findByProps({ testID: 'project-type-toggle' }).props.onPress();
            sortOption.props.onPress();
        });

        expect(storeActions.updateProject).not.toHaveBeenCalled();
        expect(onProjectChange).not.toHaveBeenCalled();
        expect(onTaskSortByChange).not.toHaveBeenCalled();
        expect(notes.commitSelectedProjectNotes).not.toHaveBeenCalled();
        expect(attachments.addProjectFileAttachment).not.toHaveBeenCalled();
        expect(attachments.removeProjectAttachment).not.toHaveBeenCalled();
    });

    it('blocks stale task creation as soon as the live project becomes archived', () => {
        const activeProject = project('active');
        const archivedProject = { ...activeProject, status: 'archived' as const };
        const onOpenQuickAdd = vi.fn();
        const onProjectChange = vi.fn();
        const props = createProjectDetailModalProps({
            onOpenQuickAdd,
            onProjectChange,
            project: activeProject,
        });
        storeActions._allProjects = [activeProject];
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...props} />);
        });
        const staleOpenQuickAdd = tree.root.findByProps({ testID: 'project-add-task-button' }).props.onPress;

        storeActions._allProjects = [archivedProject];
        act(() => {
            staleOpenQuickAdd();
            tree.update(<ProjectDetailModal {...props} />);
        });

        expect(onOpenQuickAdd).not.toHaveBeenCalled();
        const taskListProps = taskListPropsSpy.mock.calls.at(-1)?.[0];
        expect(taskListProps.project.readOnly).toBe(true);
        expect(taskListProps.enableBulkActions).toBe(false);
        expect(onProjectChange).toHaveBeenCalledWith(archivedProject);
    });
});

// The manual "Order" entry used to disappear entirely while a custom sort was
// active, which read as "manual ordering doesn't exist" (Discord report). It
// now stays visible, disabled, with a hint naming the way back.
describe('ProjectDetailModal reorder option under a custom sort', () => {
    it('shows the Order row disabled with a default-sort hint instead of hiding it', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                sections: [section('section-1', 'One'), section('section-2', 'Two')],
                taskSortBy: 'due',
            })} />);
        });

        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });

        const row = findOptionButton(tree.root, 'project-view-reorder-option');
        expect(row.props.disabled).toBe(true);
        expect(row.props.accessibilityState).toEqual({ selected: false, disabled: true });
        expect(
            tree.root.findAllByType(Text).some((node) =>
                String(node.props.children) === 'Available when Sort is Default'),
        ).toBe(true);
    });

    it('keeps the Order row enabled under the default sort', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                sections: [section('section-1', 'One'), section('section-2', 'Two')],
            })} />);
        });

        act(() => {
            tree.root.findByProps({ testID: 'project-task-view-options-button' }).props.onPress();
        });

        const row = findOptionButton(tree.root, 'project-view-reorder-option');
        expect(row.props.disabled).toBe(false);
        expect(
            tree.root.findAllByType(Text).some((node) =>
                String(node.props.children) === 'Available when Sort is Default'),
        ).toBe(false);
    });
});
