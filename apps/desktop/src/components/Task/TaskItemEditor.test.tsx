import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TaskItemEditor } from './TaskItemEditor';

const translations: Record<string, string> = {
    'taskEdit.scheduling': 'Scheduling',
    'taskEdit.organization': 'Organization',
    'taskEdit.details': 'Details',
    'taskEdit.schedulingEmpty': 'No scheduling fields',
    'taskEdit.organizationEmpty': 'No organization fields',
    'taskEdit.detailsEmpty': 'No details fields',
    'taskEdit.locationLabel': 'Location',
    'task.aria.location': 'Location',
    'taskEdit.locationPlaceholder': 'Add location',
    'taskEdit.duplicateTask': 'Duplicate task',
    'taskEdit.aiAssistant': 'AI assistant',
    'ai.working': 'Working...',
    'common.delete': 'Delete',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
};

const t = (key: string) => translations[key] ?? key;

const baseProps: Parameters<typeof TaskItemEditor>[0] = {
    t,
    editTitle: 'Reserve acupuncture',
    setEditTitle: vi.fn(),
    autoFocusTitle: false,
    resetCopilotDraft: vi.fn(),
    aiEnabled: false,
    isAIWorking: false,
    handleAIClarify: vi.fn(),
    handleAIBreakdown: vi.fn(),
    copilotSuggestion: null,
    copilotApplied: false,
    applyCopilotSuggestion: vi.fn(),
    copilotContext: undefined,
    copilotEstimate: undefined,
    copilotTags: [],
    timeEstimatesEnabled: false,
    aiError: null,
    aiBreakdownSteps: null,
    onAddBreakdownSteps: vi.fn(),
    onDismissBreakdown: vi.fn(),
    aiClarifyResponse: null,
    onSelectClarifyOption: vi.fn(),
    onApplyAISuggestion: vi.fn(),
    onDismissClarify: vi.fn(),
    projects: [],
    sections: [],
    areas: [],
    editProjectId: '',
    setEditProjectId: vi.fn(),
    editSectionId: '',
    setEditSectionId: vi.fn(),
    editAreaId: '',
    setEditAreaId: vi.fn(),
    onCreateProject: vi.fn().mockResolvedValue(null),
    onCreateArea: vi.fn().mockResolvedValue(null),
    onCreateSection: vi.fn().mockResolvedValue(null),
    showProjectField: false,
    showAreaField: false,
    showSectionField: false,
    basicFields: [],
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
    editLocation: '',
    setEditLocation: vi.fn(),
    language: 'en',
    inputContexts: [],
    onDuplicateTask: vi.fn(),
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
};

describe('TaskItemEditor', () => {
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

    it('shows a visible loading label while AI is working', () => {
        const { getByRole, getByText } = render(
            <TaskItemEditor
                {...baseProps}
                aiEnabled
                isAIWorking
            />
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

    it('does not show a delete action without an edit-mode delete handler', () => {
        const { queryByRole } = render(<TaskItemEditor {...baseProps} />);

        expect(queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });
});
