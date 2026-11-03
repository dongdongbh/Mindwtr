import { getTranslator, resolveI18nText, translateWithFallback, useTaskStore, type TranslateFn } from '@mindwtr/core';

import { getCurrentUiLanguage } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';


let lastUndoableAction: (() => void) | null = null;

export function registerUndoableAction(action: () => void): () => void {
    const run = () => {
        if (lastUndoableAction === run) lastUndoableAction = null;
        action();
    };
    lastUndoableAction = run;
    return run;
}

export function takeUndoableAction(): (() => void) | null {
    const action = lastUndoableAction;
    lastUndoableAction = null;
    return action;
}

export function clearUndoableAction(): void {
    lastUndoableAction = null;
}


const resolveUndoText = (key: string, fallback: string): string => resolveI18nText(
    getTranslator(useTaskStore.getState().settings?.language || getCurrentUiLanguage()),
    key,
    { fallback },
);


export function showUndoToast(message: string, undo: () => void, t?: TranslateFn): void {
    const action = registerUndoableAction(undo);
    if (useTaskStore.getState().settings?.undoNotificationsEnabled === false) return;
    const label = t ? translateWithFallback(t, 'common.undo', 'Undo') : resolveUndoText('common.undo', 'Undo');
    useUiStore.getState().showToast(message, 'info', 5000, {
        label,
        onClick: action,
    });
}
