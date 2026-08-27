import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createTaskDraft, type Task } from '@mindwtr/core';

import { TaskItemEditor } from './TaskItemEditor';

type EditorAi = Parameters<typeof TaskItemEditor>[0]['ai'];

// The editor takes the AI hook's result whole, so a panel test is a small
// object literal instead of two dozen props.
const createAi = (overrides: Partial<EditorAi> = {}): EditorAi => ({
    aiEnabled: true,
    isAIWorking: false,
    aiClarifyResponse: null,
    aiError: null,
    aiBreakdownSteps: null,
    copilotSuggestion: null,
    copilotContext: undefined,
    copilotEstimate: undefined,
    copilotTags: [],
    pendingCopilotParts: [],
    resetCopilotDraft: vi.fn(),
    resetAiState: vi.fn(),
    clearAiBreakdown: vi.fn(),
    clearAiClarify: vi.fn(),
    applyCopilotPart: vi.fn(),
    applyCopilotSuggestion: vi.fn(),
    addBreakdownStepsToChecklist: vi.fn(),
    selectClarifyOption: vi.fn(),
    applyClarifySuggestion: vi.fn(),
    handleAIClarify: vi.fn(async () => undefined),
    handleAIBreakdown: vi.fn(async () => undefined),
    ...overrides,
});

const baseTask: Task = {
    id: 'task-1',
    title: 'Reserve acupuncture',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
};

const translations: Record<string, string> = {
    'taskEdit.scheduling': 'Scheduling',
    'taskEdit.organization': 'Organization',
    'taskEdit.details': 'Details',
    'taskEdit.schedulingEmpty': 'No scheduling fields',
    'taskEdit.organizationEmpty': 'No organization fields',
    'taskEdit.detailsEmpty': 'No details fields',
    'areas.create': 'Create area',
    'areas.search': 'Search areas',
    'common.noMatches': 'No matches',
    'projects.addSection': 'Add section',
    'projects.create': 'Create project',
    'projects.search': 'Search projects',
    'projects.title': 'Projects',
    'sections.search': 'Search sections',
    'taskEdit.areaLabel': 'Area',
    'taskEdit.locationLabel': 'Location',
    'taskEdit.noAreaOption': 'No Area',
    'taskEdit.noProjectOption': 'No Project',
    'taskEdit.noSectionOption': 'No Section',
    'taskEdit.sectionLabel': 'Section',
    'taskEdit.titleLabel': 'Task title',
    'taskEdit.editorLayoutHelpLabel': 'Editor layout help',
    'taskEdit.editorLayoutHelpText': 'You can customize which fields appear here in Settings -> GTD -> Task Editor Layout.',
    'task.aria.location': 'Location',
    'taskEdit.locationPlaceholder': 'Add location',
    'taskEdit.duplicateTask': 'Duplicate task',
    'taskEdit.aiAssistant': 'AI assistant',
    'ai.working': 'Working...',
    'ai.breakdownTitle': 'Suggested steps',
    'ai.addSteps': 'Add steps',
    'ai.applySuggestion': 'Apply suggestion',
    'copilot.suggested': 'Suggested:',
    'copilot.applyHint': 'Click to apply',
    'copilot.applyAll': 'Apply all',
    'copilot.applied': 'Applied:',
    'common.delete': 'Delete',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'status.done': 'Done',
};

const t = (key: string) => translations[key] ?? key;

// jsdom has no scrollIntoView; the reveal effect calls it after expanding
// the section holding Attachments.
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
});

const createDataTransfer = (types: string[], files: File[] = []) =>
    ({ types, files }) as unknown as DataTransfer;

const baseProps: Parameters<typeof TaskItemEditor>[0] = {
    t,
    draft: createTaskDraft(baseTask),
    setField: vi.fn(),
    autoFocusTitle: false,
    ai: createAi({ aiEnabled: false }),
    timeEstimatesEnabled: false,
    projects: [],
    sections: [],
    areas: [],
    somedaySections: [],
    onCreateProject: vi.fn().mockResolvedValue(null),
    onCreateArea: vi.fn().mockResolvedValue(null),
    onCreateSection: vi.fn().mockResolvedValue(null),
    organizerFields: [],
    basicFieldsBeforeOrganizers: [],
    basicFieldsAfterOrganizers: [],
    schedulingFields: ['recurrence'],
    organizationFields: ['contexts'],
    detailsFields: ['description'],
    sectionCounts: {
        scheduling: 1,
        organization: 1,
        details: 1,
    },
    sectionOpenDefaults: {
        basic: true,
        scheduling: false,
        organization: false,
        details: false,
    },
    renderField: (fieldId) => <div>{`field:${fieldId}`}</div>,
    language: 'en',
    inputContexts: [],
    onDuplicateTask: vi.fn(),
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
};

describe('TaskItemEditor', () => {
    it('assigns a Someday section without changing project or project-section membership', () => {
        const setField = vi.fn();
        const somedayTask: Task = {
            ...baseTask,
            status: 'someday',
            projectId: 'project-1',
            sectionId: 'project-section-1',
            viewSectionIds: { waiting: 'waiting-heading' },
        };
        const { getByRole } = render(
            <TaskItemEditor
                {...baseProps}
                draft={createTaskDraft(somedayTask)}
                setField={setField}
                somedaySections={[{ id: 'books', title: 'Books to read', order: 0 }]}
            />
        );

        fireEvent.change(getByRole('combobox', { name: 'Someday section' }), {
            target: { value: 'books' },
        });

        expect(setField).toHaveBeenCalledWith('viewSectionIds', {
            someday: 'books',
            waiting: 'waiting-heading',
        });
        expect(setField).not.toHaveBeenCalledWith('projectId', expect.anything());
        expect(setField).not.toHaveBeenCalledWith('sectionId', expect.anything());
    });

    it('keeps optional sections collapsed when their defaults are off', () => {
        const { getByRole, queryByText } = render(<TaskItemEditor {...baseProps} />);

        expect(getByRole('button', { name: /Scheduling/i })).toHaveAttribute('aria-expanded', 'false');
        expect(getByRole('button', { name: /Organization/i })).toHaveAttribute('aria-expanded', 'false');
        expect(getByRole('button', { name: /Details/i })).toHaveAttribute('aria-expanded', 'false');

        expect(queryByText('field:recurrence')).not.toBeInTheDocument();
        expect(queryByText('field:contexts')).not.toBeInTheDocument();
        expect(queryByText('field:description')).not.toBeInTheDocument();
        expect(queryByText('Location')).not.toBeInTheDocument();
    });

    it('does not render optional sections that have no fields', () => {
        const { getByRole, queryByRole } = render(
            <TaskItemEditor
                {...baseProps}
                schedulingFields={[]}
                organizationFields={['contexts']}
                detailsFields={[]}
                sectionCounts={{ scheduling: 0, organization: 0, details: 0 }}
            />
        );

        expect(queryByRole('button', { name: /Scheduling/i })).not.toBeInTheDocument();
        expect(getByRole('button', { name: /Organization/i })).toBeInTheDocument();
        expect(queryByRole('button', { name: /Details/i })).not.toBeInTheDocument();
    });

    it('shows a visible loading label while AI is working', () => {
        const { getByRole, getByText } = render(
            <TaskItemEditor {...baseProps} ai={createAi({ isAIWorking: true })} />
        );

        expect(getByRole('button', { name: 'AI assistant' })).toBeDisabled();
        expect(getByText('Working...')).toBeInTheDocument();
    });

    it('calls the edit-mode delete action when provided', () => {
        const onDeleteTask = vi.fn();
        const { getByRole } = render(
            <TaskItemEditor
                {...baseProps}
                onDeleteTask={onDeleteTask}
            />
        );

        fireEvent.click(getByRole('button', { name: 'Delete' }));

        expect(onDeleteTask).toHaveBeenCalledTimes(1);
    });

    it('calls the title-row done action when provided', () => {
        const onMarkDone = vi.fn();
        const { getByRole } = render(
            <TaskItemEditor
                {...baseProps}
                onMarkDone={onMarkDone}
            />
        );

        const doneButton = getByRole('button', { name: 'Done' });
        expect(doneButton).toHaveAttribute('aria-pressed', 'false');
        expect(doneButton).toHaveClass('focus-visible:ring-2');
        expect(doneButton).not.toHaveClass('focus:ring-2');
        fireEvent.click(doneButton);

        expect(onMarkDone).toHaveBeenCalledTimes(1);
    });

    it('requests a completion time when the title-row done action is right-clicked', () => {
        const onMarkDone = vi.fn();
        const onRequestBackdatedComplete = vi.fn();
        const { getByRole } = render(
            <TaskItemEditor
                {...baseProps}
                onMarkDone={onMarkDone}
                onRequestBackdatedComplete={onRequestBackdatedComplete}
            />
        );

        fireEvent.contextMenu(getByRole('button', { name: 'Done' }));

        expect(onRequestBackdatedComplete).toHaveBeenCalledTimes(1);
        expect(onMarkDone).not.toHaveBeenCalled();
    });

    it('emphasizes the task title field in the editor header', () => {
        const { getByRole } = render(<TaskItemEditor {...baseProps} />);

        expect(getByRole('combobox', { name: 'Task title' })).toHaveClass(
            'text-lg',
            'font-semibold',
            'text-foreground',
            'focus-visible:ring-2'
        );
    });

    it('shows task editor layout help in an inline popover', () => {
        const { getByRole, getByText, queryByText } = render(<TaskItemEditor {...baseProps} />);

        fireEvent.click(getByRole('button', { name: 'Editor layout help' }));

        expect(getByText('You can customize which fields appear here in Settings -> GTD -> Task Editor Layout.')).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Editor layout help' }));

        expect(queryByText('You can customize which fields appear here in Settings -> GTD -> Task Editor Layout.')).not.toBeInTheDocument();
    });

    it('uses stronger weight for organization field labels without changing label size', () => {
        const { getByText } = render(
            <TaskItemEditor
                {...baseProps}
                organizerFields={['area', 'project', 'section']}
            />
        );

        ['Area', 'Projects', 'Section'].forEach((label) => {
            expect(getByText(label)).toHaveClass('text-xs', 'font-semibold');
            expect(getByText(label)).not.toHaveClass('font-medium');
        });
    });

    it('does not show a delete action without an edit-mode delete handler', () => {
        const { queryByRole } = render(<TaskItemEditor {...baseProps} />);

        expect(queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });
});

describe('TaskItemEditor AI panels', () => {
    it('renders nothing from the AI hook while AI is disabled', () => {
        const { queryByRole, queryByText } = render(
            <TaskItemEditor
                {...baseProps}
                ai={createAi({ aiEnabled: false, aiError: 'Rate limited', aiBreakdownSteps: ['Step one'] })}
            />
        );

        expect(queryByRole('button', { name: 'AI assistant' })).not.toBeInTheDocument();
        expect(queryByText('Rate limited')).not.toBeInTheDocument();
        expect(queryByText('Suggested steps')).not.toBeInTheDocument();
    });

    it('lists breakdown steps and turns them into checklist items', () => {
        const addBreakdownStepsToChecklist = vi.fn();
        const clearAiBreakdown = vi.fn();
        const { getByText } = render(
            <TaskItemEditor
                {...baseProps}
                ai={createAi({
                    aiBreakdownSteps: ['Call the clinic', 'Book a slot'],
                    addBreakdownStepsToChecklist,
                    clearAiBreakdown,
                })}
            />
        );

        const panel = getByText('Suggested steps').parentElement!;
        expect(within(panel).getByText('1. Call the clinic')).toBeInTheDocument();
        expect(within(panel).getByText('2. Book a slot')).toBeInTheDocument();

        fireEvent.click(within(panel).getByRole('button', { name: 'Add steps' }));
        expect(addBreakdownStepsToChecklist).toHaveBeenCalledTimes(1);

        fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
        expect(clearAiBreakdown).toHaveBeenCalledTimes(1);
    });

    it('offers each clarify option and the suggested action', () => {
        const selectClarifyOption = vi.fn();
        const applyClarifySuggestion = vi.fn();
        const { getByText } = render(
            <TaskItemEditor
                {...baseProps}
                ai={createAi({
                    aiClarifyResponse: {
                        question: 'What does done look like?',
                        options: [
                            { label: 'Book it', action: 'Book the acupuncture slot' },
                            { label: 'Ask first', action: 'Ask about availability' },
                        ],
                        suggestedAction: { title: 'Book the acupuncture slot' },
                    },
                    selectClarifyOption,
                    applyClarifySuggestion,
                })}
            />
        );

        const panel = getByText('What does done look like?').parentElement!;

        fireEvent.click(within(panel).getByRole('button', { name: 'Ask first' }));
        expect(selectClarifyOption).toHaveBeenCalledWith('Ask about availability');

        fireEvent.click(within(panel).getByRole('button', { name: 'Apply suggestion' }));
        expect(applyClarifySuggestion).toHaveBeenCalledTimes(1);
    });

    it('applies one suggested part per chip, and the rest through apply all', () => {
        const applyCopilotPart = vi.fn();
        const applyCopilotSuggestion = vi.fn();
        const { getByRole } = render(
            <TaskItemEditor
                {...baseProps}
                timeEstimatesEnabled
                ai={createAi({
                    copilotSuggestion: { context: '@phone', timeEstimate: '15min', tags: ['#health'] },
                    pendingCopilotParts: [
                        { kind: 'context', value: '@phone' },
                        { kind: 'timeEstimate', value: '15min' },
                        { kind: 'tag', value: '#health' },
                    ],
                    applyCopilotPart,
                    applyCopilotSuggestion,
                })}
            />
        );

        fireEvent.click(getByRole('button', { name: '#health' }));
        expect(applyCopilotPart).toHaveBeenCalledTimes(1);
        expect(applyCopilotPart).toHaveBeenCalledWith({ kind: 'tag', value: '#health' });
        expect(applyCopilotSuggestion).not.toHaveBeenCalled();

        fireEvent.click(getByRole('button', { name: 'Apply all' }));
        expect(applyCopilotSuggestion).toHaveBeenCalledTimes(1);
    });

    it('keeps the unapplied parts suggestible beside the applied summary', () => {
        const { getByRole, getByText, queryByRole } = render(
            <TaskItemEditor
                {...baseProps}
                timeEstimatesEnabled
                ai={createAi({
                    copilotSuggestion: { context: '@phone', timeEstimate: '15min' },
                    copilotContext: '@phone',
                    pendingCopilotParts: [{ kind: 'timeEstimate', value: '15min' }],
                })}
            />
        );

        expect(getByRole('button', { name: '15min' })).toBeInTheDocument();
        expect(queryByRole('button', { name: '@phone' })).not.toBeInTheDocument();
        // A lone remaining part needs no "apply all".
        expect(queryByRole('button', { name: 'Apply all' })).not.toBeInTheDocument();
        expect(getByText(/Applied:/)).toHaveTextContent('@phone');
    });

    it('drops the suggestion row once every part is applied', () => {
        const { getByText, queryByRole } = render(
            <TaskItemEditor
                {...baseProps}
                timeEstimatesEnabled
                ai={createAi({
                    copilotSuggestion: { context: '@phone' },
                    copilotContext: '@phone',
                    copilotEstimate: '15min',
                    pendingCopilotParts: [],
                })}
            />
        );

        expect(queryByRole('button', { name: '@phone' })).not.toBeInTheDocument();
        const applied = getByText(/Applied:/);
        expect(applied).toHaveTextContent('@phone');
        expect(applied).toHaveTextContent('15min');
    });

    it('shows the AI error text when a request fails', () => {
        const { getByText } = render(
            <TaskItemEditor {...baseProps} ai={createAi({ aiError: 'Rate limited by the provider' })} />
        );

        expect(getByText('Rate limited by the provider')).toBeInTheDocument();
    });
});

describe('TaskItemEditor file drop', () => {
    it('ignores a task drag (non-Files dataTransfer types) so calendar/sidebar dragging still works', () => {
        const onFilesDropped = vi.fn();
        const { container } = render(<TaskItemEditor {...baseProps} onFilesDropped={onFilesDropped} />);
        const form = container.querySelector('form')!;

        const dataTransfer = createDataTransfer(['application/x-mindwtr-task']);
        fireEvent.dragOver(form, { dataTransfer });
        fireEvent.drop(form, { dataTransfer });

        expect(onFilesDropped).not.toHaveBeenCalled();
    });

    it('attaches OS files dropped anywhere on the editor', () => {
        const onFilesDropped = vi.fn();
        const file = new File(['hi'], 'a.txt');
        const { container } = render(<TaskItemEditor {...baseProps} onFilesDropped={onFilesDropped} />);
        const form = container.querySelector('form')!;

        const dataTransfer = createDataTransfer(['Files'], [file]);
        fireEvent.dragOver(form, { dataTransfer });
        fireEvent.drop(form, { dataTransfer });

        expect(onFilesDropped).toHaveBeenCalledWith([file]);
    });

    it('opens the section holding Attachments on drop, wherever the user assigned it', () => {
        const onFilesDropped = vi.fn();
        const file = new File(['hi'], 'a.txt');
        const { container, getByRole, getByText } = render(
            <TaskItemEditor
                {...baseProps}
                organizationFields={['attachments']}
                onFilesDropped={onFilesDropped}
            />
        );
        const form = container.querySelector('form')!;
        expect(getByRole('button', { name: /Organization/i })).toHaveAttribute('aria-expanded', 'false');

        const dataTransfer = createDataTransfer(['Files'], [file]);
        fireEvent.dragOver(form, { dataTransfer });
        fireEvent.drop(form, { dataTransfer });

        expect(onFilesDropped).toHaveBeenCalledWith([file]);
        expect(getByRole('button', { name: /Organization/i })).toHaveAttribute('aria-expanded', 'true');
        expect(getByText('field:attachments')).toBeInTheDocument();
    });
});
