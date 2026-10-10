import { translateWithFallback, type Task } from '@mindwtr/core';
import { useUiStore } from '../store/ui-store';
import { logInfo, logWarn } from './app-log';

export async function copyTaskTitles(
    tasks: Pick<Task, 'title' | 'description'>[],
    t: (key: string) => string,
    includeDescription = false,
    source: 'menu' | 'shortcut' = 'shortcut',
): Promise<void> {
    if (tasks.length === 0) return;
    const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback);
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    const diagnostic = {
        releaseCheck: 'v1.3.5/task-copy-diagnostics',
        source,
        documentFocused: typeof document !== 'undefined' && document.hasFocus(),
        activationSupported: Boolean(activation),
        activationActive: activation?.isActive ?? null,
        clipboardAvailable: typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function',
    };
    try {
        await navigator.clipboard.writeText(tasks.map((task) => {
            const description = includeDescription && task.description?.trim() ? `\n\n${task.description}` : '';
            return task.title + description;
        }).join('\n'));
        void logInfo('Task clipboard write completed', {
            scope: 'clipboard', extra: { ...diagnostic, outcome: 'copied' },
        }).catch(() => {});
        useUiStore.getState().showToast(
            includeDescription
                ? translate('list.taskCopied', 'Task copied to clipboard')
                : tasks.length === 1
                    ? translate('task.titleCopied', 'Title copied')
                    : translate('task.titlesCopied', 'Titles copied'),
            'success',
        );
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
