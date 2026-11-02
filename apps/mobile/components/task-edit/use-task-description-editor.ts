import React from 'react';
import { TextInput, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import {
    applyMarkdownKeyboardShortcut,
    applyMarkdownToolbarAction,
    continueMarkdownOnTextChange,
    isMarkdownEditorAssistEnabled,
    useTaskStore,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type Task,
} from '@mindwtr/core';
import type { TaskDraftSetter } from '@mindwtr/core/task-draft';

import {
    applyMarkdownPairInsertionWithSelectionFallback,
    applyMarkdownUrlPasteWithSelectionFallback,
    createIgnoredNativePairChangeFromTextChange,
    shouldIgnoreNativePairChange,
    type IgnoredNativePairChange,
    isRangeSelection,
} from '../markdown-selection-utils';

const selectionsEqual = (left: MarkdownSelection, right: MarkdownSelection) => (
    left.start === right.start && left.end === right.end
);

type UseTaskDescriptionEditorParams = {
    task: Task | null;
    descriptionDraft: string;
    descriptionDraftRef: React.MutableRefObject<string>;
    setDescriptionDraft: React.Dispatch<React.SetStateAction<string>>;
    descriptionDebounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    setDraftField: TaskDraftSetter;
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
    setDraftField,
    resetCopilotDraft,
    onMarkdownOverlayVisibilityChange,
    onInputFocusTracked,
}: UseTaskDescriptionEditorParams) {
    const [descriptionExpanded, setDescriptionExpanded] = React.useState(false);
    const descriptionInputRef = React.useRef<TextInput | null>(null);
    const descriptionUndoRef = React.useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
    const [descriptionUndoDepth, setDescriptionUndoDepth] = React.useState(0);
    const [isDescriptionInputFocused, setIsDescriptionInputFocused] = React.useState(false);
    const [descriptionSelectionRestorePending, setDescriptionSelectionRestorePending] = React.useState(false);
    const [descriptionSelection, setDescriptionSelection] = React.useState<MarkdownSelection>({
        start: descriptionDraft.length,
        end: descriptionDraft.length,
    });
    const descriptionSelectionRef = React.useRef(descriptionSelection);
    const lastDescriptionRangeRef = React.useRef<MarkdownSelection | null>(isRangeSelection(descriptionSelection) ? descriptionSelection : null);
    const pendingDescriptionSelectionRef = React.useRef<MarkdownSelection | null>(null);
    const ignoredNativePairChangeRef = React.useRef<IgnoredNativePairChange | null>(null);

    React.useEffect(() => {
        descriptionSelectionRef.current = descriptionSelection;
        if (isRangeSelection(descriptionSelection)) {
            lastDescriptionRangeRef.current = descriptionSelection;
        }
    }, [descriptionSelection]);

    const restoreDescriptionSelection = React.useCallback((selection: MarkdownSelection) => {
        pendingDescriptionSelectionRef.current = selection;
        setDescriptionSelectionRestorePending(true);
        const applySelection = () => {
            descriptionInputRef.current?.focus?.();
            descriptionInputRef.current?.setNativeProps?.({ selection });
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(applySelection);
        } else {
            setTimeout(applySelection, 0);
        }
        const applyDelayedSelection = (shouldClearPending: boolean) => {
            applySelection();
            if (
                shouldClearPending
                && pendingDescriptionSelectionRef.current
                && selectionsEqual(pendingDescriptionSelectionRef.current, selection)
            ) {
                pendingDescriptionSelectionRef.current = null;
            }
            if (
                shouldClearPending
                && (
                    !pendingDescriptionSelectionRef.current
                    || selectionsEqual(pendingDescriptionSelectionRef.current, selection)
                )
            ) {
                setDescriptionSelectionRestorePending(false);
            }
        };
        setTimeout(() => {
            applyDelayedSelection(false);
        }, 40);
        setTimeout(() => {
            applyDelayedSelection(false);
        }, 140);
        setTimeout(() => {
            applyDelayedSelection(true);
        }, 300);
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
        lastDescriptionRangeRef.current = null;
        ignoredNativePairChangeRef.current = null;
        setDescriptionSelectionRestorePending(false);
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
            lastDescriptionRangeRef.current = isRangeSelection(options.nextSelection) ? options.nextSelection : null;
            setDescriptionSelection(options.nextSelection);
        }
        resetCopilotDraft();
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
        }
        descriptionDebounceRef.current = setTimeout(() => {
            setDraftField('description', text);
        }, 250);
    }, [
        descriptionDebounceRef,
        descriptionDraftRef,
        pushDescriptionUndoEntry,
        resetCopilotDraft,
        setDescriptionDraft,
        setDraftField,
    ]);

    const handleDescriptionChange = React.useCallback((text: string) => {
        const ignoredNativeChange = ignoredNativePairChangeRef.current;
        if (ignoredNativeChange) {
            if (shouldIgnoreNativePairChange(text, descriptionDraftRef.current, ignoredNativeChange)) {
                restoreDescriptionSelection(ignoredNativeChange.selection);
                return;
            }
            ignoredNativePairChangeRef.current = null;
        }

        const currentSelection = descriptionSelectionRef.current;
        const previousValue = descriptionDraftRef.current;
        const fallbackSelection = lastDescriptionRangeRef.current;
        const assistEnabled = isMarkdownEditorAssistEnabled(useTaskStore.getState().settings);
        const pastedUrl = applyMarkdownUrlPasteWithSelectionFallback(
            previousValue,
            text,
            currentSelection,
            fallbackSelection,
            { assist: assistEnabled },
        );
        if (pastedUrl) {
            lastDescriptionRangeRef.current = null;
            applyDescriptionValue(pastedUrl.result.value, {
                baseSelection: pastedUrl.baseSelection,
                nextSelection: pastedUrl.result.selection,
            });
            restoreDescriptionSelection(pastedUrl.result.selection);
            return;
        }
        const pairedInsertion = applyMarkdownPairInsertionWithSelectionFallback(
            previousValue,
            text,
            currentSelection,
            fallbackSelection,
            { assist: assistEnabled },
        );
        if (pairedInsertion) {
            ignoredNativePairChangeRef.current = createIgnoredNativePairChangeFromTextChange(
                previousValue,
                text,
                pairedInsertion.baseSelection,
                pairedInsertion.result,
            );
            lastDescriptionRangeRef.current = isRangeSelection(pairedInsertion.result.selection)
                ? pairedInsertion.result.selection
                : null;
            applyDescriptionValue(pairedInsertion.result.value, {
                baseSelection: pairedInsertion.baseSelection,
                nextSelection: pairedInsertion.result.selection,
            });
            restoreDescriptionSelection(pairedInsertion.result.selection);
            return;
        }
        const continued = continueMarkdownOnTextChange(
            descriptionDraftRef.current,
            text,
            descriptionSelectionRef.current,
            { assist: assistEnabled },
        );
        if (continued) {
            lastDescriptionRangeRef.current = null;
            applyDescriptionValue(continued.value, {
                baseSelection: descriptionSelectionRef.current,
                nextSelection: continued.selection,
            });
            restoreDescriptionSelection(continued.selection);
            return;
        }
        lastDescriptionRangeRef.current = null;
        applyDescriptionValue(text);
    }, [applyDescriptionValue, descriptionDraftRef, restoreDescriptionSelection]);

    // Auto-pairing intentionally lives only in handleDescriptionChange. On Android the
    // keyPress event is synthesized from the same native edit as the text change (and
    // preventDefault cannot cancel it), so pairing here too processes one keystroke
    // twice — IME-specific echo orders then double the pair (#565).
    const handleDescriptionKeyPress = React.useCallback((event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (event.nativeEvent.key === 'Backspace') {
            ignoredNativePairChangeRef.current = null;
        }
        const next = applyMarkdownKeyboardShortcut(
            descriptionDraftRef.current,
            descriptionSelectionRef.current,
            { key: event.nativeEvent.key },
        );
        if (!next) return;
        event.preventDefault?.();
        applyDescriptionValue(next.value, {
            baseSelection: descriptionSelectionRef.current,
            nextSelection: next.selection,
        });
        restoreDescriptionSelection(next.selection);
    }, [applyDescriptionValue, descriptionDraftRef, restoreDescriptionSelection]);

    const handleDescriptionSelectionChange = React.useCallback((selection: MarkdownSelection) => {
        const pendingSelection = pendingDescriptionSelectionRef.current;
        if (pendingSelection) {
            if (!selectionsEqual(pendingSelection, selection)) {
                return;
            }
            pendingDescriptionSelectionRef.current = null;
            setDescriptionSelectionRestorePending(false);
        }
        descriptionSelectionRef.current = selection;
        if (isRangeSelection(selection)) {
            lastDescriptionRangeRef.current = selection;
        } else {
            lastDescriptionRangeRef.current = null;
        }
        setDescriptionSelection(selection);
    }, []);

    const handleDescriptionUndo = React.useCallback(() => {
        const previousEntry = descriptionUndoRef.current[descriptionUndoRef.current.length - 1];
        if (!previousEntry) return undefined;
        descriptionUndoRef.current = descriptionUndoRef.current.slice(0, -1);
        setDescriptionUndoDepth(descriptionUndoRef.current.length);
        lastDescriptionRangeRef.current = null;
        applyDescriptionValue(previousEntry.value, {
            nextSelection: previousEntry.selection,
            recordUndo: false,
        });
        return previousEntry.selection;
    }, [applyDescriptionValue]);

    const handleDescriptionApplyAction = React.useCallback((actionId: MarkdownToolbarActionId, selection: MarkdownSelection): MarkdownToolbarResult => {
        const next = applyMarkdownToolbarAction(descriptionDraftRef.current, selection, actionId);
        lastDescriptionRangeRef.current = null;
        applyDescriptionValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        return next;
    }, [applyDescriptionValue, descriptionDraftRef]);
    const applyDescriptionResult = React.useCallback((next: MarkdownToolbarResult) => {
        lastDescriptionRangeRef.current = null;
        applyDescriptionValue(next.value, {
            baseSelection: descriptionSelectionRef.current,
            nextSelection: next.selection,
        });
        restoreDescriptionSelection(next.selection);
    }, [applyDescriptionValue, restoreDescriptionSelection]);

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
        descriptionSelectionRestorePending,
        setDescriptionSelection: handleDescriptionSelectionChange,
        descriptionUndoDepth,
        isDescriptionInputFocused,
        setIsDescriptionInputFocused,
        handleDescriptionChange,
        handleDescriptionKeyPress,
        handleDescriptionUndo,
        handleDescriptionApplyAction,
        applyDescriptionResult,
        openDescriptionExpandedEditor,
        closeDescriptionExpandedEditor,
    };
}
