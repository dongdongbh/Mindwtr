import { resolveFeatureFlags } from './resolve-feature-flags';
import { resolveProcessInboxContainerFields } from './process-inbox-workflow';
import type { ProcessInboxWorkflowEvent, ProcessInboxWorkflowFields } from './process-inbox-workflow';
import type { AppData, Task, TaskEditorFieldId } from './types';

export type ProcessInboxPlanField = Extract<
    TaskEditorFieldId,
    | 'project'
    | 'area'
    | 'contexts'
    | 'tags'
    | 'priority'
    | 'energyLevel'
    | 'assignedTo'
    | 'timeEstimate'
    | 'startTime'
    | 'dueDate'
    | 'reviewAt'
>;

export type ProcessInboxPlan = {
    defaultMode: 'guided' | 'quick';
    twoMinuteEnabled: boolean;
    twoMinuteFirst: boolean;
    projectFirst: boolean;
    contextStepEnabled: boolean;
    scheduleEnabled: boolean;
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    referenceEnabled: boolean;
    visibleFields: Readonly<Record<ProcessInboxPlanField, boolean>>;
    visibleScheduleFields: readonly Extract<ProcessInboxPlanField, 'startTime' | 'dueDate' | 'reviewAt'>[];
    showProjectStep: boolean;
    showOrganizationStep: boolean;
    showScheduleFields: boolean;
    initialGuidedStep: 'actionability' | 'two-minute';
};

const DEFAULT_VISIBLE_FIELDS = new Set<TaskEditorFieldId>([
    'project',
    'area',
    'contexts',
    'tags',
    'startTime',
    'dueDate',
    'reviewAt',
]);

/**
 * Resolve the complete policy plan for Process Inbox from persisted settings.
 * Platforms consume the plan; they do not independently reinterpret settings.
 */
export function resolveProcessInboxPlan(settings?: AppData['settings']): ProcessInboxPlan {
    const inboxProcessing = settings?.gtd?.inboxProcessing ?? {};
    const { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled } = resolveFeatureFlags(settings);
    const configuredHidden = settings?.gtd?.taskEditor?.hidden;
    const isVisible = (field: TaskEditorFieldId): boolean => configuredHidden
        ? !configuredHidden.includes(field)
        : DEFAULT_VISIBLE_FIELDS.has(field);
    const contextStepEnabled = inboxProcessing.contextStepEnabled !== false;
    const scheduleEnabled = inboxProcessing.scheduleEnabled === true;

    const visibleFields: Record<ProcessInboxPlanField, boolean> = {
        project: isVisible('project'),
        area: isVisible('area'),
        contexts: contextStepEnabled && isVisible('contexts'),
        tags: contextStepEnabled && isVisible('tags'),
        priority: prioritiesEnabled && isVisible('priority'),
        energyLevel: isVisible('energyLevel'),
        assignedTo: isVisible('assignedTo'),
        timeEstimate: timeEstimatesEnabled && isVisible('timeEstimate'),
        startTime: scheduleEnabled && isVisible('startTime'),
        dueDate: scheduleEnabled && isVisible('dueDate'),
        reviewAt: scheduleEnabled && isVisible('reviewAt'),
    };
    const visibleScheduleFields = (['startTime', 'dueDate', 'reviewAt'] as const)
        .filter((field) => visibleFields[field]);
    const twoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
    const twoMinuteFirst = inboxProcessing.twoMinuteFirst === true;

    return {
        defaultMode: inboxProcessing.defaultMode === 'quick' ? 'quick' : 'guided',
        twoMinuteEnabled,
        twoMinuteFirst,
        projectFirst: inboxProcessing.projectFirst === true,
        contextStepEnabled,
        scheduleEnabled,
        prioritiesEnabled,
        timeEstimatesEnabled,
        referenceEnabled: true,
        visibleFields,
        visibleScheduleFields,
        showProjectStep: visibleFields.project || visibleFields.area,
        showOrganizationStep: (
            visibleFields.contexts
            || visibleFields.tags
            || visibleFields.priority
            || visibleFields.energyLevel
            || visibleFields.assignedTo
            || visibleFields.timeEstimate
        ),
        showScheduleFields: visibleScheduleFields.length > 0,
        initialGuidedStep: twoMinuteEnabled && twoMinuteFirst ? 'two-minute' : 'actionability',
    };
}

export type ProcessInboxDecision =
    | { type: 'discard' | 'skip' | 'someday' | 'reference' | 'complete' | 'next' }
    | { type: 'later' }
    | { type: 'waiting'; followUpAt?: string };

export type ProcessInboxDecisionDraft = {
    fields: ProcessInboxWorkflowFields;
    /** Date commands parsed directly from the title. Unlike hydrated editor
     * state, these are explicit user input and must survive hidden fields. */
    explicitDateFields?: Partial<Pick<ProcessInboxWorkflowFields, 'startTime' | 'dueDate' | 'reviewAt'>>;
    taskUpdates?: Partial<Pick<Task, 'title' | 'description'>>;
};

export type ProcessInboxValidationReason = 'later-start-required';

export type ProcessInboxDecisionResetField =
    | 'startTime'
    | 'dueDate'
    | 'reviewAt'
    | 'delegate'
    | 'projectConversion';

export type PreparedProcessInboxDecision =
    | { ok: false; reason: ProcessInboxValidationReason }
    | {
        ok: true;
        event: ProcessInboxWorkflowEvent;
        taskUpdates: Partial<Pick<Task, 'title' | 'description'>> | undefined;
        resetFields: readonly ProcessInboxDecisionResetField[];
    };

function resolveSelectionFields(
    task: Task,
    fields: ProcessInboxWorkflowFields,
    plan: ProcessInboxPlan,
): ProcessInboxWorkflowFields {
    const projectId = plan.visibleFields.project ? fields.projectId : task.projectId;
    const areaId = plan.visibleFields.area ? fields.areaId : task.areaId;
    const includeContainers = plan.visibleFields.project || plan.visibleFields.area;
    return {
        ...(includeContainers ? resolveProcessInboxContainerFields(projectId, areaId) : {}),
        ...(plan.visibleFields.contexts ? { contexts: fields.contexts ?? [] } : {}),
        ...(plan.visibleFields.tags ? { tags: fields.tags ?? [] } : {}),
    };
}

function resolveActionFields(
    task: Task,
    fields: ProcessInboxWorkflowFields,
    plan: ProcessInboxPlan,
    explicitDateFields: ProcessInboxDecisionDraft['explicitDateFields'] = {},
): ProcessInboxWorkflowFields {
    return {
        ...resolveSelectionFields(task, fields, plan),
        ...(plan.visibleFields.priority ? { priority: fields.priority } : {}),
        ...(plan.visibleFields.energyLevel ? { energyLevel: fields.energyLevel } : {}),
        ...(plan.visibleFields.assignedTo ? { assignedTo: fields.assignedTo } : {}),
        ...(plan.visibleFields.timeEstimate ? { timeEstimate: fields.timeEstimate } : {}),
        ...explicitDateFields,
        // Visible controls take precedence over a title command. The desktop
        // adapter places the parsed value in `fields` until a control changes.
        ...(plan.visibleFields.startTime ? { startTime: fields.startTime } : {}),
        ...(plan.visibleFields.dueDate ? { dueDate: fields.dueDate } : {}),
        ...(plan.visibleFields.reviewAt ? { reviewAt: fields.reviewAt } : {}),
    };
}

/**
 * Validate and prepare a Process Inbox decision from a normalized platform
 * draft. This is the only place that decides which draft fields belong to a
 * destination; platform adapters retain input parsing and presentation.
 */
export function prepareProcessInboxDecision({
    task,
    draft,
    decision,
    plan,
}: {
    task: Task;
    draft: ProcessInboxDecisionDraft;
    decision: ProcessInboxDecision;
    plan: ProcessInboxPlan;
}): PreparedProcessInboxDecision {
    const selectionFields = resolveSelectionFields(task, draft.fields, plan);
    let event: ProcessInboxWorkflowEvent;
    let resetFields: readonly ProcessInboxDecisionResetField[] = [];

    switch (decision.type) {
        case 'discard':
            event = { type: 'discard' };
            break;
        case 'skip':
            event = { type: 'skip', fields: resolveActionFields(task, draft.fields, plan, draft.explicitDateFields) };
            break;
        case 'someday':
        case 'reference':
        case 'complete':
            event = { type: decision.type, fields: { ...selectionFields, ...draft.explicitDateFields } };
            break;
        case 'later': {
            const startTime = draft.fields.startTime;
            if (!startTime) {
                return { ok: false, reason: 'later-start-required' };
            }
            event = { type: 'later', fields: { ...selectionFields, startTime } };
            resetFields = ['startTime'];
            break;
        }
        case 'waiting':
            event = {
                type: 'waiting',
                // The delegate answer is part of this decision even when the
                // generic Assigned To editor field is hidden.
                fields: {
                    ...resolveActionFields(task, draft.fields, plan, draft.explicitDateFields),
                    assignedTo: draft.fields.assignedTo,
                },
                followUpAt: decision.followUpAt,
            };
            resetFields = ['delegate'];
            break;
        case 'next':
            event = { type: 'next', fields: resolveActionFields(task, draft.fields, plan, draft.explicitDateFields) };
            resetFields = ['startTime', 'dueDate', 'reviewAt', 'projectConversion'];
            break;
    }

    return {
        ok: true,
        event,
        taskUpdates: event.type === 'discard' ? undefined : draft.taskUpdates,
        resetFields,
    };
}
