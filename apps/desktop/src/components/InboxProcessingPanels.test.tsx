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
            toggleContext={noop}
            toggleTag={noop}
            convertToProject={false}
            setConvertToProject={noop}
            projectTitleDraft=""
            setProjectTitleDraft={noop}
            nextActionDraft=""
            setNextActionDraft={noop}
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
            onCreatePerson={noop}
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
            setProjectTitleDraft={noop}
            setNextActionDraft={noop}
            projectTitleDraft=""
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

        fireEvent.click(getByRole('button', { name: 'priority.high' }));
        expect(getByRole('button', { name: 'priority.high' })).not.toHaveClass('bg-primary');
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

    it('writes organization-step selections through the draft', () => {
        const { getByLabelText, getByRole } = render(<WizardHarness processingStep="context" />);

        fireEvent.change(getByLabelText('taskEdit.energyLevel'), { target: { value: 'high' } });
        expect((getByLabelText('taskEdit.energyLevel') as HTMLSelectElement).value).toBe('high');

        fireEvent.click(getByRole('button', { name: 'priority.urgent' }));
        expect(getByRole('button', { name: 'priority.urgent' })).toHaveClass('bg-primary');
    });
});
