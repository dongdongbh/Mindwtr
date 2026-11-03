import { hasTimeComponent, safeParseDate, safeParseDueDate } from './date';
import { tFallback } from './i18n';
import type { Task } from './types';

export type TaskDateCoherenceIssueCode = 'start_after_due';

export type TaskDateCoherenceIssue = {
    code: TaskDateCoherenceIssueCode;
    field: 'startTime';
    relatedField: 'dueDate';
};

export type TaskDateCoherenceResult = {
    coherent: boolean;
    issues: TaskDateCoherenceIssue[];
};

type TaskDateCoherenceInput = Pick<Task, 'dueDate' | 'startTime'>;
type TaskDateCoherenceContext = { startLocalDay?: string };

const compareStartAfterDue = (task: TaskDateCoherenceInput, context?: TaskDateCoherenceContext): boolean => {
    const start = safeParseDate(task.startTime);
    const due = safeParseDueDate(task.dueDate);
    if (!start || !due) return false;


    if (!hasTimeComponent(task.dueDate)) {


        if (context?.startLocalDay) return context.startLocalDay > task.dueDate!;
        due.setHours(23, 59, 59, 999);
    }
    return start.getTime() > due.getTime();
};

export const getTaskDateCoherenceIssues = (
    task: TaskDateCoherenceInput,
    context?: TaskDateCoherenceContext,
): TaskDateCoherenceIssue[] => {
    const issues: TaskDateCoherenceIssue[] = [];
    if (compareStartAfterDue(task, context)) {
        issues.push({
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        });
    }
    return issues;
};

export const getTaskDateCoherence = (
    task: TaskDateCoherenceInput,
    context?: TaskDateCoherenceContext,
): TaskDateCoherenceResult => {
    const issues = getTaskDateCoherenceIssues(task, context);
    return {
        coherent: issues.length === 0,
        issues,
    };
};

export const isTaskDateCoherent = (task: TaskDateCoherenceInput, context?: TaskDateCoherenceContext): boolean => (
    getTaskDateCoherenceIssues(task, context).length === 0
);


export const getTaskEditorDateIssueLabel = (
    task: TaskDateCoherenceInput,
    t: (key: string) => string,
): string => (
    getTaskDateCoherenceIssues(task).some((issue) => issue.code === 'start_after_due')
        ? tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date')
        : ''
);
