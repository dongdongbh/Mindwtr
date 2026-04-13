import React from 'react';
import { TextInput } from 'react-native';
import {
    applyMarkdownToolbarAction,
    continueMarkdownOnTextChange,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type Task,
} from '@mindwtr/core';

import type { SetEditedTask } from './use-task-edit-state';

const selectionsEqual = (left: MarkdownSelection, right: MarkdownSelection) => (
    left.start === right.start && left.end === right.end
);

type UseTaskDescriptionEditorParams = {
    task: Task | null;
    descriptionDraft: string;
    descriptionDraftRef: React.MutableRefObject<string>;
    setDescriptionDraft: React.Dispatch<React.SetStateAction<string>>;
    descriptionDebounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    setEditedTask: SetEditedTask;
    resetCopilotDraft: () => void;
    onMarkdownOverlayVisibilityChange: (visible: boolean) => void;
    onInputFocusTracked: (targetInput?: number | string) => void;
};

export type TaskDescriptionEditor = ReturnType<typeof useTaskDescriptionEditor>;

export function useTaskDescriptionEditor({
    task,
    descriptionDraft,
    descriptionDraftRef,
    setDescriptionDraft,
    descriptionDebounceRef,
    setEditedTask,
    resetCopilotDraft,
    onMarkdownOverlayVisibilityChange,
    onInputFocusTracked,
}: UseTaskDescriptionEditorParams) {
    const [descriptionExpanded, setDescriptionExpanded] = React.useState(false);
    const descriptionInputRef = React.useRef<TextInput | null>(null);
    const descriptionUndoRef = React.useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
    const [descriptionUndoDepth, setDescriptionUndoDepth] = React.useState(0);
    const [isDescriptionInputFocused, setIsDescriptionInputFocused] = React.useState(false);
    const [descriptionSelection, setDescriptionSelection] = React.useState<MarkdownSelection>({
        start: descriptionDraft.length,
        end: descriptionDraft.length,
    });
    const descriptionSelectionRef = React.useRef(descriptionSelection);
    const pendingDescriptionSelectionRef = React.useRef<MarkdownSelection | null>(null);

    React.useEffect(() => {
        descriptionSelectionRef.current = descriptionSelection;
    }, [descriptionSelection]);

    const restoreDescriptionSelection = React.useCallback((selection: MarkdownSelection) => {
        pendingDescriptionSelectionRef.current = selection;
        const applySelection = () => {
            descriptionInputRef.current?.setNativeProps?.({ selection });
        };
        requestAnimationFrame(applySelection);
        setTimeout(() => {
            applySelection();
            if (
                pendingDescriptionSelectionRef.current
                && selectionsEqual(pendingDescriptionSelectionRef.current, selection)
            ) {
                pendingDescriptionSelectionRef.current = null;
            }
        }, 40);
    }, []);

    React.useEffect(() => {
        setDescriptionSelection((prev) => {
            const nextStart = Math.min(prev.start, descriptionDraft.length);
            const nextEnd = Math.min(prev.end, descriptionDraft.length);
            if (nextStart === prev.start && nextEnd === prev.end) {
                return prev;
            }
            return { start: nextStart, end: nextEnd };
        });
    }, [descriptionDraft.length]);

    React.useEffect(() => {
        descriptionUndoRef.current = [];
        setDescriptionUndoDepth(0);
        setIsDescriptionInputFocused(false);
        setDescriptionExpanded(false);
        const resetSelection = { start: 0, end: 0 };
        pendingDescriptionSelectionRef.current = null;
        descriptionSelectionRef.current = resetSelection;
        setDescriptionSelection(resetSelection);
    }, [task?.id]);

    const pushDescriptionUndoEntry = React.useCallback((value: string, selection: MarkdownSelection) => {
        const previousEntry = descriptionUndoRef.current[descriptionUndoRef.current.length - 1];
        if (
            previousEntry
            && previousEntry.value === value
            && previousEntry.selection.start === selection.start
            && previousEntry.selection.end === selection.end
        ) {
            return;
        }
        const nextUndoEntries = [...descriptionUndoRef.current, { value, selection }];
        descriptionUndoRef.current = nextUndoEntries.length > 100
            ? nextUndoEntries.slice(nextUndoEntries.length - 100)
            : nextUndoEntries;
        setDescriptionUndoDepth(descriptionUndoRef.current.length);
    }, []);

    const applyDescriptionValue = React.useCallback((
        text: string,
        options?: {
            nextSelection?: MarkdownSelection;
            recordUndo?: boolean;
            baseSelection?: MarkdownSelection;
        },
    ) => {
        if ((options?.recordUndo ?? true) && text !== descriptionDraftRef.current) {
            pushDescriptionUndoEntry(descriptionDraftRef.current, options?.baseSelection ?? descriptionSelectionRef.current);
        }
        setDescriptionDraft(text);
        descriptionDraftRef.current = text;
        if (options?.nextSelection) {
            descriptionSelectionRef.current = options.nextSelection;
            setDescriptionSelection(options.nextSelection);
        }
        resetCopilotDraft();
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
        }
        descriptionDebounceRef.current = setTimeout(() => {
            setEditedTask((prev) => ({ ...prev, description: text }));
        }, 250);
    }, [
        descriptionDebounceRef,
        descriptionDraftRef,
        pushDescriptionUndoEntry,
        resetCopilotDraft,
        setDescriptionDraft,
        setEditedTask,
    ]);

    const handleDescriptionChange = React.useCallback((text: string) => {
        const continued = continueMarkdownOnTextChange(
            descriptionDraftRef.current,
            text,
            descriptionSelectionRef.current,
        );
        if (continued) {
            applyDescriptionValue(continued.value, {
                baseSelection: descriptionSelectionRef.current,
                nextSelection: continued.selection,
            });
            restoreDescriptionSelection(continued.selection);
            return;
        }
        applyDescriptionValue(text);
    }, [applyDescriptionValue, restoreDescriptionSelection]);

    const handleDescriptionSelectionChange = React.useCallback((selection: MarkdownSelection) => {
        const pendingSelection = pendingDescriptionSelectionRef.current;
        if (pendingSelection) {
            if (!selectionsEqual(pendingSelection, selection)) {
                return;
            }
            pendingDescriptionSelectionRef.current = null;
        }
        descriptionSelectionRef.current = selection;
        setDescriptionSelection(selection);
    }, []);

    const handleDescriptionUndo = React.useCallback(() => {
        const previousEntry = descriptionUndoRef.current[descriptionUndoRef.current.length - 1];
        if (!previousEntry) return undefined;
        descriptionUndoRef.current = descriptionUndoRef.current.slice(0, -1);
        setDescriptionUndoDepth(descriptionUndoRef.current.length);
        applyDescriptionValue(previousEntry.value, {
            nextSelection: previousEntry.selection,
            recordUndo: false,
        });
        return previousEntry.selection;
    }, [applyDescriptionValue]);

    const handleDescriptionApplyAction = React.useCallback((actionId: MarkdownToolbarActionId, selection: MarkdownSelection): MarkdownToolbarResult => {
        const next = applyMarkdownToolbarAction(descriptionDraftRef.current, selection, actionId);
        applyDescriptionValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        return next;
    }, [applyDescriptionValue, descriptionDraftRef]);

    const openDescriptionExpandedEditor = React.useCallback(() => {
        descriptionInputRef.current?.blur();
        setIsDescriptionInputFocused(false);
        onInputFocusTracked(undefined);
        onMarkdownOverlayVisibilityChange(true);
        setDescriptionExpanded(true);
    }, [onInputFocusTracked, onMarkdownOverlayVisibilityChange]);

    const closeDescriptionExpandedEditor = React.useCallback(() => {
        onMarkdownOverlayVisibilityChange(false);
        setDescriptionExpanded(false);
    }, [onMarkdownOverlayVisibilityChange]);

    return {
        descriptionExpanded,
        descriptionInputRef,
        descriptionSelection,
        setDescriptionSelection: handleDescriptionSelectionChange,
        descriptionUndoDepth,
        isDescriptionInputFocused,
        setIsDescriptionInputFocused,
        handleDescriptionChange,
        handleDescriptionUndo,
        handleDescriptionApplyAction,
        openDescriptionExpandedEditor,
        closeDescriptionExpandedEditor,
    };
}
