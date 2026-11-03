


import type {
    BreakdownInput,
    BreakdownResponse,
    ClarifyInput,
    ClarifyResponse,
    ClarifySuggestion,
    ReviewAnalysisResponse,
    ReviewSnapshotItem,
} from './ai/types';
import {
    formatCaptureModalCopilotApplied,
    getCaptureModalCopilotParts,
    keepCaptureModalCopilotSuggestion,
    type CaptureModalCopilotPart,
} from './capture-modal-model';
import { formatAIErrorAlertBody } from './ai/utils';
import { filterReviewSuggestions, isActionableReviewSuggestion, type TitledReviewSuggestion } from './review-views-model';
import { redactSyncText } from './sync-settings-model';
import type { TaskDraft } from './task-draft';
import { getUsedTaskTokens } from './task-token-usage';
import type { AppSettings, ChecklistItem, Project, Task, TimeEstimate } from './types';

type Translate = (key: string) => string;


const urlPassword = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
        return decodeURIComponent(new URL(url).password) || null;
    } catch {
        return null;
    }
};


export function redactAIError(error: unknown, apiKey: string, settings: AppSettings | undefined): Error {
    const secrets = [apiKey, urlPassword(settings?.ai?.baseUrl)];
    const redacted = new Error(redactSyncText(error instanceof Error ? error.message : String(error), secrets));
    redacted.name = error instanceof Error ? redactSyncText(error.name, secrets) : 'Error';
    return redacted;
}


export const getAIErrorAlert = (error: unknown, t: Translate, apiKey: string, settings: AppSettings | undefined): { title: string; message: string } => ({
    title: t('ai.errorTitle'),
    message: formatAIErrorAlertBody(t('ai.errorBody'), redactAIError(error, apiKey, settings)),
});


export const TASK_COPILOT_DELAY_MS = 800;


export type TaskCopilotPart = CaptureModalCopilotPart;


export function getTaskCopilotText(title: string, description: string): string | null {
    const text = [String(title ?? '').trim(), String(description ?? '').trim()].filter(Boolean).join('\n');
    return text.length < 4 ? null : text;
}


export const keepTaskCopilotSuggestion = keepCaptureModalCopilotSuggestion;

export const getTaskCopilotParts = getCaptureModalCopilotParts;

export const formatTaskCopilotApplied = formatCaptureModalCopilotApplied;

const splitDraftTokens = (value: string | undefined) => (
    (value ?? '').split(',').map((token) => token.trim()).filter(Boolean)
);


export function applyTaskCopilotParts(
    draft: { contexts?: string; tags?: string },
    parts: readonly TaskCopilotPart[],
    timeEstimatesEnabled: boolean,
): { context?: string; tags: string[]; timeEstimate?: TimeEstimate; patch: Partial<Pick<TaskDraft, 'contexts' | 'tags' | 'timeEstimate'>> } {
    const context = parts.find((part) => part.kind === 'context')?.value;
    const estimate = parts.find((part) => part.kind === 'timeEstimate')?.value;
    const tags = parts.filter((part) => part.kind === 'tag').map((part) => part.value);
    const patch: Partial<Pick<TaskDraft, 'contexts' | 'tags' | 'timeEstimate'>> = {};
    if (context) patch.contexts = Array.from(new Set([...splitDraftTokens(draft.contexts), context])).join(', ');
    if (tags.length) patch.tags = Array.from(new Set([...splitDraftTokens(draft.tags), ...tags])).join(', ');
    const timeEstimate = estimate && timeEstimatesEnabled ? estimate as TimeEstimate : undefined;
    if (timeEstimate) patch.timeEstimate = timeEstimate;
    return { ...(context ? { context } : {}), tags, ...(timeEstimate ? { timeEstimate } : {}), patch };
}


export type TaskAIProjectContext = { projectTitle: string; projectTasks: string[] };


export function getTaskAIProjectContext(input: {
    projectId: string | undefined;
    projects: readonly Pick<Project, 'id' | 'title'>[];
    tasks: readonly Task[];
    taskId: string | undefined;
}): TaskAIProjectContext | null {
    if (!input.projectId) return null;
    const project = input.projects.find((item) => item.id === input.projectId);
    const projectTasks = input.tasks
        .filter((item) => item.projectId === input.projectId && item.id !== input.taskId && !item.deletedAt)
        .map((item) => `${item.title}${item.status ? ` (${item.status})` : ''}`)
        .filter(Boolean)
        .slice(0, 20);
    return {
        projectTitle: project?.title || '',
        projectTasks,
    };
}


export function buildTaskClarifyInput(input: {
    title: string;
    tasks: Task[];
    task: Pick<Task, 'startTime' | 'dueDate' | 'reviewAt'>;
    merged: Partial<Pick<Task, 'contexts' | 'startTime' | 'dueDate' | 'reviewAt'>>;
    projectContext: TaskAIProjectContext | null | undefined;
}): ClarifyInput {
    const contexts = Array.from(new Set([
        ...getUsedTaskTokens(input.tasks, (item) => item.contexts, { prefix: '@' }),
        ...(input.merged.contexts ?? []),
    ]));
    return {
        title: input.title,
        contexts,
        startTime: input.merged.startTime ?? input.task.startTime,
        dueDate: input.merged.dueDate ?? input.task.dueDate,
        reviewAt: input.merged.reviewAt ?? input.task.reviewAt,
        ...(input.projectContext ?? {}),
    };
}


export function buildInboxClarifyInput(input: {
    title: string;
    task: Pick<Task, 'title' | 'contexts'>;
    contextPool: readonly string[];
    selectedContexts: readonly string[];
}): ClarifyInput {
    return {
        title: input.title || input.task.title,
        contexts: Array.from(new Set([...input.contextPool, ...input.selectedContexts, ...(input.task.contexts ?? [])])),
    };
}


export type AIClarifyChoice = {
    label: string;
    variant?: 'primary' | 'secondary';
    apply: { type: 'title'; title: string } | { type: 'suggestion'; suggestion: ClarifySuggestion } | { type: 'cancel' };
};


export function getAIClarifyDialog(response: ClarifyResponse, t: Translate): { title: string; choices: AIClarifyChoice[] } {
    const choices: AIClarifyChoice[] = response.options.slice(0, 3).map((option) => ({
        label: option.label,
        apply: { type: 'title', title: option.action },
    }));
    if (response.suggestedAction?.title) {
        choices.push({ label: t('ai.applySuggestion'), variant: 'primary', apply: { type: 'suggestion', suggestion: response.suggestedAction } });
    }
    choices.push({ label: t('common.cancel'), variant: 'secondary', apply: { type: 'cancel' } });
    return { title: response.question || t('taskEdit.aiClarify'), choices };
}


export function getTaskClarifySuggestionEdit(
    draftContexts: string | undefined,
    suggested: Pick<ClarifySuggestion, 'title' | 'context' | 'timeEstimate'>,
): { title?: string; patch: Partial<Pick<TaskDraft, 'timeEstimate' | 'contexts'>> } {
    const patch: Partial<Pick<TaskDraft, 'timeEstimate' | 'contexts'>> = {};
    if (suggested.timeEstimate) patch.timeEstimate = suggested.timeEstimate;
    if (suggested.context) patch.contexts = Array.from(new Set([...splitDraftTokens(draftContexts), suggested.context])).join(', ');
    return { ...(suggested.title ? { title: suggested.title } : {}), patch };
}


export function buildTaskBreakdownInput(input: { title: string; description: string; projectContext: TaskAIProjectContext | null | undefined }): BreakdownInput {
    return {
        title: input.title,
        description: String(input.description ?? ''),
        ...(input.projectContext ?? {}),
    };
}


export const getTaskBreakdownSteps = (response: BreakdownResponse): string[] => (
    response.steps.map((step) => step.trim()).filter(Boolean).slice(0, 8)
);


export function getTaskBreakdownDialog(steps: readonly string[], t: Translate): {
    title: string;
    message: string;
    cancel: { label: string; variant: 'secondary' };
    add: { label: string; variant: 'primary' };
} {
    return {
        title: t('ai.breakdownTitle'),
        message: steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
        cancel: { label: t('common.cancel'), variant: 'secondary' },
        add: { label: t('ai.addSteps'), variant: 'primary' },
    };
}


export const appendTaskBreakdownSteps = (checklist: readonly ChecklistItem[], steps: readonly string[], newId: () => string): ChecklistItem[] => [
    ...checklist,
    ...steps.map((step) => ({ id: newId(), title: step, isCompleted: false })),
];


export const getWeeklyReviewAnalysisError = (error: unknown, t: Translate, apiKey: string, settings: AppSettings | undefined): string => (
    redactAIError(error, apiKey, settings).message || t('ai.errorBody')
);


export function readWeeklyReviewAnalysis(response: ReviewAnalysisResponse, staleItems: readonly ReviewSnapshotItem[]): {
    suggestions: TitledReviewSuggestion[];
    selectedIds: string[];
} {

    const suggestions = filterReviewSuggestions(response.suggestions || [], staleItems);
    return {
        suggestions,
        selectedIds: suggestions.filter(isActionableReviewSuggestion).map((suggestion) => suggestion.id),
    };
}
