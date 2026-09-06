import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createTaskDraft, setTaskDraftField, type Task, type TaskDraft } from '@mindwtr/core';

import { LanguageProvider } from '../contexts/language-context';
import { InboxProcessingQuickPanel, type InboxProcessingQuickPanelProps } from './InboxProcessingQuickPanel';
import { InboxProcessingWizard, type InboxProcessingWizardProps, type ProcessingStep } from './InboxProcessingWizard';
import type {
    InboxProcessingOptionLists,
    InboxProcessingVisibility,
} from './views/inbox/inbox-processing-utils';

const t = (key: string) => key;

const processingTask: Task = {
    id: 'task-1',
    title: 'Plan launch',
    status: 'inbox',
    contexts: [],
    tags: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
};

const visibility: InboxProcessingVisibility = {
    showProjectField: true,
    showAreaField: true,
    showContextsField: true,
    showTagsField: true,
    showPriorityField: true,
    showEnergyLevelField: true,
    showAssignedToField: true,
    showTimeEstimateField: true,
    showScheduleFields: false,
    showReferenceOption: true,
};

const options: InboxProcessingOptionLists = {
    projects: [],
    areas: [],
    allContexts: [],
    allTags: [],
    suggestedContexts: ['@home', '@office'],
    suggestedTags: ['#deep'],
    personOptions: [],
    timeEstimateOptions: ['30min', '1hr'],
};

const noop = vi.fn();

const scheduleField = () => ({
    date: '',
    timeDraft: '',
    hasTime: false,
    onDateChange: noop,
    onTimeDraftChange: noop,
    onTimeCommit: noop,
    onClear: noop,
    onDateOnly: noop,
});

const scheduleFields = {
    start: scheduleField(),
    due: scheduleField(),
    review: scheduleField(),
};

/**
 * Both panels take the task fields as one draft, so a render fixture is the
 * draft plus the surface's own state — not a 90-key object of value/setter
 * pairs. setField writes through the core reducer, exactly as the controller
 * does, so a field cascade lands in the test the same way it lands in the app.
 */
const useLiveDraft = (initial: Partial<TaskDraft> = {}) => {
    const [draft, setDraft] = useState<TaskDraft>(() => ({ ...createTaskDraft(processingTask), ...initial }));
    return {
        draft,
        setField: <K extends keyof TaskDraft>(field: K, value: TaskDraft[K]) => {
            setDraft((current) => setTaskDraftField(current, field, value));
        },
    };
};

function QuickPanelHarness(overrides: Partial<InboxProcessingQuickPanelProps> = {}) {
    const { draft, setField } = useLiveDraft();

    return (
        <LanguageProvider>
        <InboxProcessingQuickPanel
            t={t}
            processingTask={processingTask}
            remainingCount={1}
            draft={draft}
            setField={setField}
            visibility={visibility}
            options={options}
            processingMode="quick"
            onModeChange={noop}
            onSkip={noop}
            isReturningItem={false}
            onClose={noop}
            actionabilityChoice="actionable"
            setActionabilityChoice={noop}
            twoMinuteChoice="no"
            setTwoMinuteChoice={noop}
            executionChoice="defer"
            setExecutionChoice={noop}
            scheduleFields={scheduleFields}
            visibleScheduleFieldKeys={[]}
            delegateWho=""
            setDelegateWho={noop}
            delegateFollowUp=""
            setDelegateFollowUp={noop}
            onSendDelegateRequest={noop}
            onCreatePerson={noop}
            onCreateSomedaySection={noop as InboxProcessingQuickPanelProps['onCreateSomedaySection']}
            toggleContext={noop}
            toggleTag={noop}
            convertToProject={false}
            setConvertToProject={noop}
            nextActionDraft=""
            setNextActionDraft={noop}
            extraActionDrafts={[]}
            setExtraActionDrafts={noop}
            addProject={async () => null}
            onSubmit={noop}
            {...overrides}
        />
        </LanguageProvider>
    );
}

function WizardHarness({ processingStep = 'refine' as ProcessingStep, ...overrides }: Partial<InboxProcessingWizardProps> = {}) {
    const { draft, setField } = useLiveDraft();

    return (
        <LanguageProvider>
        <InboxProcessingWizard
            t={t}
            isProcessing
            processingTask={processingTask}
            processingMode="guided"
            onModeChange={noop}
            processingStep={processingStep}
            draft={draft}
            setField={setField}
            visibility={visibility}
            options={options}
            setIsProcessing={noop}
            canGoBack={false}
            onBack={noop}
            handleRefineNext={noop}
            handleSkip={noop}
            handleNotActionable={noop}
            handleLater={noop}
            handleIncubate={noop}
            isReturningItem={false}
            handleActionable={noop}
            showDoneNowShortcut={false}
            handleProjectCheckNo={noop}
            handleProjectCheckYes={noop}
            handleTwoMinDone={noop}
            handleTwoMinNo={noop}
            handleDefer={noop}
            handleDelegate={noop}
            delegateWho=""
            setDelegateWho={noop}
            delegateFollowUp=""
            setDelegateFollowUp={noop}
            handleDelegateBack={noop}
            handleSendDelegateRequest={noop}
            handleConfirmWaiting={noop}
            handleConfirmReference={noop}
            handleConfirmSomeday={noop}
            onCreatePerson={noop}
            onCreateSomedaySection={noop as InboxProcessingWizardProps['onCreateSomedaySection']}
            customContext=""
            setCustomContext={noop}
            addCustomContext={noop}
            customTag=""
            setCustomTag={noop}
            addCustomTag={noop}
            toggleContext={noop}
            toggleTag={noop}
            handleConfirmContexts={noop}
            convertToProject={false}
            setConvertToProject={noop}
            setNextActionDraft={noop}
            nextActionDraft=""
            extraActionDrafts={[]}
            setExtraActionDrafts={noop}
            handleConvertToProject={noop}
            projectSearch=""
            setProjectSearch={noop}
            filteredProjects={[]}
            addProject={async () => null}
            handleSetProject={noop}
            hasExactProjectMatch={false}
            areaById={new Map()}
            remainingCount={1}
            showProjectInRefine={false}
            scheduleFields={scheduleFields}
            visibleScheduleFieldKeys={[]}
            {...overrides}
        />
        </LanguageProvider>
    );
}

describe('InboxProcessingQuickPanel draft editing', () => {
    afterEach(() => {
        cleanup();
    });

    it('writes title edits through the draft', () => {
        const { getByLabelText } = render(<QuickPanelHarness />);
        const title = getByLabelText('taskEdit.titleLabel') as HTMLInputElement;

        expect(title.value).toBe('Plan launch');
        fireEvent.change(title, { target: { value: 'Clarified launch' } });

        expect((getByLabelText('taskEdit.titleLabel') as HTMLInputElement).value).toBe('Clarified launch');
    });

    it('lets a quick-mode project conversion collect more than one next action (#1167)', () => {
        const setExtraActionDrafts = vi.fn();
        const { getByText, getAllByPlaceholderText } = render(
            <QuickPanelHarness convertToProject extraActionDrafts={['Book venue']} setExtraActionDrafts={setExtraActionDrafts} />,
        );

        expect(getAllByPlaceholderText('taskEdit.titleLabel')).toHaveLength(2);
        fireEvent.click(getByText('+ process.addAnotherAction'));

        expect(setExtraActionDrafts).toHaveBeenCalledWith(['Book venue', '']);
    });

    it('uses the title input as the only project name input during conversion', () => {
        const { getByLabelText, queryByLabelText } = render(
            <QuickPanelHarness convertToProject />,
        );

        expect((getByLabelText('projects.projectName') as HTMLInputElement).value).toBe('Plan launch');
        expect(queryByLabelText('taskEdit.titleLabel')).toBeNull();
        expect(queryByLabelText('projects.title')).toBeNull();
    });

    // The draft stores the raw token text; the selected chips are derived from
    // it, so typing and clicking a suggestion cannot disagree.
    it('derives the selected contexts from the typed token text', () => {
        const { getByLabelText, getByRole } = render(<QuickPanelHarness />);

        expect(getByRole('button', { name: '@home' })).not.toHaveClass('bg-primary');
        fireEvent.change(getByLabelText('taskEdit.contextsLabel'), { target: { value: '@home' } });

        expect(getByRole('button', { name: '@home' })).toHaveClass('bg-primary');
        expect(getByRole('button', { name: '@office' })).not.toHaveClass('bg-primary');
    });

    it('clears an optional field when its chip is toggled off', () => {
        const { getByRole } = render(<QuickPanelHarness />);

        fireEvent.click(getByRole('button', { name: 'priority.high' }));
        expect(getByRole('button', { name: 'priority.high' })).toHaveClass('bg-primary');
        expect(getByRole('button', { name: 'priority.high' }).querySelector('[data-priority-flag="high"]'))
            .toHaveAttribute('stroke', '#f97316');

        fireEvent.click(getByRole('button', { name: 'priority.high' }));
        expect(getByRole('button', { name: 'priority.high' })).not.toHaveClass('bg-primary');
    });

    it('offers Area and Project controls before filing a Someday item', () => {
        const { getByText } = render(
            <QuickPanelHarness actionabilityChoice="someday" />,
        );

        expect(getByText('taskEdit.areaLabel')).toBeInTheDocument();
        expect(getByText('taskEdit.projectLabel')).toBeInTheDocument();
        expect(getByText('+ New section…')).toBeInTheDocument();
    });

    // #1155: filing a note as Reference has to offer the same containers the
    // Someday path does, so it lands in its project in one step.
    it('offers Area and Project controls before filing a Reference item', () => {
        const { getByText } = render(
            <QuickPanelHarness actionabilityChoice="reference" />,
        );

        expect(getByText('taskEdit.areaLabel')).toBeInTheDocument();
        expect(getByText('taskEdit.projectLabel')).toBeInTheDocument();
    });

    it('offers the same Area and Project controls before incubating an item', () => {
        const { getByText } = render(
            <QuickPanelHarness actionabilityChoice="incubate" />,
        );

        expect(getByText('taskEdit.areaLabel')).toBeInTheDocument();
        expect(getByText('taskEdit.projectLabel')).toBeInTheDocument();
        expect(getByText('+ New section…')).toBeInTheDocument();
    });
});

describe('InboxProcessingWizard draft editing', () => {
    afterEach(() => {
        cleanup();
    });

    it('writes refine-step title edits through the draft', () => {
        const { getByDisplayValue } = render(<WizardHarness />);

        fireEvent.change(getByDisplayValue('Plan launch'), { target: { value: 'Clarified launch' } });

        expect(getByDisplayValue('Clarified launch')).toBeTruthy();
    });

    it('labels the refine title as the project name while conversion is on', () => {
        const { getByText, queryByText } = render(<WizardHarness convertToProject />);

        expect(getByText('projects.projectName')).toBeInTheDocument();
        expect(queryByText('taskEdit.titleLabel')).toBeNull();
    });

    it('does not render a second project name input in the project step', () => {
        const { queryByText } = render(
            <WizardHarness processingStep="project" convertToProject />,
        );

        expect(queryByText('projects.projectName')).toBeNull();
    });

    it('writes organization-step selections through the draft', () => {
        const { getByLabelText, getByRole } = render(<WizardHarness processingStep="context" />);

        fireEvent.change(getByLabelText('taskEdit.energyLevel'), { target: { value: 'high' } });
        expect((getByLabelText('taskEdit.energyLevel') as HTMLSelectElement).value).toBe('high');

        fireEvent.click(getByRole('button', { name: 'priority.urgent' }));
        expect(getByRole('button', { name: 'priority.urgent' })).toHaveClass('bg-primary');
    });

    it('offers Area and Project controls before confirming Someday', () => {
        const handleConfirmSomeday = vi.fn();
        const { getByRole, getByText } = render(
            <WizardHarness processingStep="someday" handleConfirmSomeday={handleConfirmSomeday} />,
        );

        expect(getByText('taskEdit.areaLabel')).toBeInTheDocument();
        expect(getByText('taskEdit.projectLabel')).toBeInTheDocument();
        expect(getByText('+ New section…')).toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: 'process.someday' }));
        expect(handleConfirmSomeday).toHaveBeenCalledTimes(1);
    });

    it('offers Area and Project controls before confirming Reference', () => {
        const handleConfirmReference = vi.fn();
        const { getByRole, getByText } = render(
            <WizardHarness processingStep="reference" handleConfirmReference={handleConfirmReference} />,
        );

        expect(getByText('taskEdit.areaLabel')).toBeInTheDocument();
        expect(getByText('taskEdit.projectLabel')).toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: /process\.next/ }));
        expect(handleConfirmReference).toHaveBeenCalledTimes(1);
    });

    it('offers Area and Project controls before confirming Incubate', () => {
        const { getByRole, getByText } = render(
            <WizardHarness processingStep="actionable" />,
        );

        fireEvent.click(getByRole('button', { name: 'inbox.no' }));
        fireEvent.click(getByRole('button', { name: 'Incubate' }));

        expect(getByText('taskEdit.areaLabel')).toBeInTheDocument();
        expect(getByText('taskEdit.projectLabel')).toBeInTheDocument();
        expect(getByText('+ New section…')).toBeInTheDocument();
    });
});
