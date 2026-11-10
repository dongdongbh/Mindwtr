import { translateWithFallback, type Task } from '@mindwtr/core';
import { useUiStore } from '../store/ui-store';
import { logInfo, logWarn } from './app-log';

type TaskClipboardInput = { isTrusted: boolean; detail: number };

export async function copyTaskTitles(
    tasks: Pick<Task, 'title' | 'description'>[],
    t: (key: string) => string,
    includeDescription = false,
    source: 'menu' | 'shortcut' = 'shortcut',
    input?: TaskClipboardInput,
): Promise<void> {
    if (tasks.length === 0) return;
    const text = tasks.map((task) => {
        const description = includeDescription && task.description?.trim() ? `\n\n${task.description}` : '';
        return task.title + description;
    }).join('\n');
    const message = includeDescription
        ? translateWithFallback(t, 'list.taskCopied', 'Task copied to clipboard')
        : tasks.length === 1
            ? translateWithFallback(t, 'task.titleCopied', 'Title copied')
            : translateWithFallback(t, 'task.titlesCopied', 'Titles copied');
    await writeTaskClipboard(text, t, message, source, input);
}

export async function copyTaskDetails(
    task: Pick<Task, 'title' | 'description' | 'checklist' | 'startTime' | 'dueDate'>,
    projectTitle: string | undefined,
    t: (key: string) => string,
    input?: TaskClipboardInput,
): Promise<void> {
    const fields: string[] = [];
    if (projectTitle) fields.push(`${translateWithFallback(t, 'taskEdit.projectLabel', 'Project')}: ${projectTitle}`);
    if (task.startTime) fields.push(`${translateWithFallback(t, 'taskEdit.startDateLabel', 'Start Date')}: ${task.startTime}`);
    if (task.dueDate) fields.push(`${translateWithFallback(t, 'taskEdit.dueDateLabel', 'Due Date')}: ${task.dueDate}`);
    const checklist = task.checklist?.map((item) => `[${item.isCompleted ? 'x' : ' '}] ${item.title}`).join('\n');
    const text = [task.title, fields.join('\n'), task.description?.trim() ? task.description : undefined, checklist].filter(Boolean).join('\n\n');
    await writeTaskClipboard(text, t, translateWithFallback(t, 'list.taskCopied', 'Task copied to clipboard'), 'menu', input);
}

export async function copyTaskReference(
    taskId: string,
    kind: 'link' | 'id',
    t: (key: string) => string,
    input?: TaskClipboardInput,
): Promise<void> {
    await writeTaskClipboard(
        kind === 'link' ? `mindwtr://open?task=${encodeURIComponent(taskId)}` : taskId,
        t,
        translateWithFallback(t, 'list.taskCopied', 'Task copied to clipboard'),
        'menu',
        input,
    );
}

async function writeTaskClipboard(
    text: string,
    t: (key: string) => string,
    message: string,
    source: 'menu' | 'shortcut',
    input?: TaskClipboardInput,
): Promise<void> {
    const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback);
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    const diagnostic = {
        releaseCheck: 'v1.3.7/task-copy-input',
        source,
        inputTrusted: input?.isTrusted ?? null,
        inputKind: input ? input.detail > 0 ? 'pointer' : 'keyboard-or-assistive' : 'not-provided',
        documentFocused: typeof document !== 'undefined' && document.hasFocus(),
        activationSupported: Boolean(activation),
        activationActive: activation?.isActive ?? null,
        clipboardAvailable: typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function',
    };
    try {
        await navigator.clipboard.writeText(text);
        void logInfo('Task clipboard write completed', {
            scope: 'clipboard', extra: { ...diagnostic, outcome: 'copied' },
        }).catch(() => {});
        useUiStore.getState().showToast(message, 'success');
    } catch (error) {
        const errorKind = !diagnostic.clipboardAvailable ? 'unavailable'
            : (error instanceof Error || error instanceof DOMException) && ['NotAllowedError', 'SecurityError', 'AbortError', 'TypeError'].includes(error.name)
                ? error.name : 'other';
        void logWarn('Task clipboard write failed', {
            scope: 'clipboard', extra: { ...diagnostic, outcome: 'failed', errorKind },
        }).catch(() => {});
        useUiStore.getState().showToast(translate('list.taskCopyFailed', 'Could not copy task'), 'error');
    }
}
