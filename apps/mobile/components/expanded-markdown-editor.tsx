import React from 'react';
import {
    InteractionManager,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    Platform,
    ScrollView,
    Text,
    TextInput,
    TouchableOpacity,
    View,
    type TextInputKeyPressEventData,
    type TextInputSelectionChangeEventData,
    type NativeSyntheticEvent,
    type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Eye, Pencil } from 'lucide-react-native';
import {
    applyMarkdownKeyboardShortcut,
    applyMarkdownToolbarAction,
    continueMarkdownOnTextChange,
    isMarkdownEditorAssistEnabled,
    useTaskStore,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
} from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';

import { expandedMarkdownEditorStyles as styles } from './expanded-markdown-editor.styles';
import { KeyboardAccessoryHost } from './keyboard-accessory-host';
import { MarkdownFormatToolbar } from './markdown-format-toolbar';
import { MarkdownReferenceAutocomplete } from './markdown-reference-autocomplete';
import {
    applyMarkdownPairInsertionWithSelectionFallback,
    applyMarkdownUrlPasteWithSelectionFallback,
    createIgnoredNativePairChangeFromTextChange,
    shouldIgnoreNativePairChange,
    type IgnoredNativePairChange,
    isRangeSelection,
} from './markdown-selection-utils';
import { MarkdownText } from './markdown-text';
import { getControlledTextInputSelection } from './text-input-selection';

const selectionsEqual = (left: MarkdownSelection, right: MarkdownSelection) => (
    left.start === right.start && left.end === right.end
);

type ExpandedMarkdownEditorProps = {
    isOpen: boolean;
    onClose: () => void;
    value: string;
    onChange: (value: string) => void;
    onCommit?: () => void;
    title: string;
    headerTitle?: string;
    placeholder: string;
    t: (key: string) => string;
    initialMode?: 'edit' | 'preview';
    direction?: 'ltr' | 'rtl';
    selection: MarkdownSelection;
    onSelectionChange: (selection: MarkdownSelection) => void;
    canUndo: boolean;
    onUndo: () => MarkdownSelection | undefined;
    onApplyAction?: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult | void;
    currentTaskId?: string;
};

export function ExpandedMarkdownEditor({
    isOpen,
    onClose,
    value,
    onChange,
    onCommit,
    title,
    headerTitle,
    placeholder,
    t,
    initialMode = 'edit',
    direction,
    selection,
    onSelectionChange,
    canUndo,
    onUndo,
    onApplyAction,
    currentTaskId,
}: ExpandedMarkdownEditorProps) {
    const tc = useThemeColors();
    const inputRef = React.useRef<TextInput | null>(null);
    const focusTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusInteractionRef = React.useRef<ReturnType<typeof InteractionManager.runAfterInteractions> | null>(null);
    const openedAtRef = React.useRef(0);
    const pendingInitialFocusRef = React.useRef(false);
    const wasOpenRef = React.useRef(false);
    const toolbarInteractionUntilRef = React.useRef(0);
    const pendingSelectionRef = React.useRef<MarkdownSelection | null>(null);
    const lastRangeSelectionRef = React.useRef<MarkdownSelection | null>(isRangeSelection(selection) ? selection : null);
    const ignoredNativePairChangeRef = React.useRef<IgnoredNativePairChange | null>(null);
    const valueRef = React.useRef(value);
    const selectionRef = React.useRef(selection);
    // Keep a local mirror while the fullscreen editor is open so Android
    // focus/toolbar interactions do not have to wait on parent rerenders.
    const [editorValue, setEditorValue] = React.useState(value);
    const [editorSelection, setEditorSelection] = React.useState(selection);
    const [selectionRestorePending, setSelectionRestorePending] = React.useState(false);
    const [mode, setMode] = React.useState<'edit' | 'preview'>(initialMode);
    const [isInputFocused, setIsInputFocused] = React.useState(false);
    const resolvedHeaderTitle = (headerTitle || '').trim() || title;
    const directionStyle: TextStyle | undefined = direction
        ? {
            writingDirection: direction,
            textAlign: direction === 'rtl' ? 'right' : 'left',
        }
        : undefined;
    React.useEffect(() => {
        if (isOpen && !wasOpenRef.current) {
            openedAtRef.current = Date.now();
            pendingInitialFocusRef.current = true;
            setMode(initialMode);
            valueRef.current = value;
            selectionRef.current = selection;
            lastRangeSelectionRef.current = isRangeSelection(selection) ? selection : null;
            pendingSelectionRef.current = null;
            ignoredNativePairChangeRef.current = null;
            setSelectionRestorePending(false);
            setEditorValue(value);
            setEditorSelection(selection);
        }
        wasOpenRef.current = isOpen;
    }, [initialMode, isOpen, selection, value]);

    React.useEffect(() => {
        if (!isOpen) {
            pendingSelectionRef.current = null;
            lastRangeSelectionRef.current = null;
            ignoredNativePairChangeRef.current = null;
            setSelectionRestorePending(false);
            setIsInputFocused(false);
        }
    }, [isOpen]);

    const scheduleEditorFocus = React.useCallback(() => {
        if (focusInteractionRef.current?.cancel) {
            focusInteractionRef.current.cancel();
        }
        if (focusTimerRef.current) {
            clearTimeout(focusTimerRef.current);
            focusTimerRef.current = null;
        }
        focusInteractionRef.current = InteractionManager.runAfterInteractions(() => {
            focusTimerRef.current = setTimeout(() => {
                inputRef.current?.focus();
                if (selectionRef.current) {
                    inputRef.current?.setNativeProps?.({ selection: selectionRef.current });
                }
            }, Platform.OS === 'android' ? 120 : 30);
        });
    }, []);

    React.useEffect(() => {
        if (!isOpen || mode !== 'edit') return;
        if (pendingInitialFocusRef.current) return;
        if (wasOpenRef.current) {
            scheduleEditorFocus();
        }
    }, [isOpen, mode, scheduleEditorFocus]);

    React.useEffect(() => {
        if (value === valueRef.current) return;
        valueRef.current = value;
        setEditorValue(value);
    }, [value]);

    React.useEffect(() => {
        if (
            selection.start === selectionRef.current.start
            && selection.end === selectionRef.current.end
        ) {
            return;
        }
        selectionRef.current = selection;
        if (isRangeSelection(selection)) {
            lastRangeSelectionRef.current = selection;
        } else {
            lastRangeSelectionRef.current = null;
        }
        setEditorSelection(selection);
    }, [selection]);
    React.useEffect(() => () => {
        if (focusInteractionRef.current?.cancel) {
            focusInteractionRef.current.cancel();
        }
        if (focusTimerRef.current) {
            clearTimeout(focusTimerRef.current);
            focusTimerRef.current = null;
        }
    }, []);

    const handleClose = React.useCallback(() => {
        onCommit?.();
        onClose();
    }, [onClose, onCommit]);
    const handleRequestClose = React.useCallback(() => {
        const elapsed = Date.now() - openedAtRef.current;
        if (Platform.OS === 'android' && elapsed < 750) {
            if (mode === 'edit') {
                requestAnimationFrame(() => {
                    inputRef.current?.focus();
                });
            }
            return;
        }
        handleClose();
    }, [handleClose, mode]);

    const handleToggleMode = React.useCallback(() => {
        setMode((prev) => {
            const next = prev === 'edit' ? 'preview' : 'edit';
            if (next === 'preview') {
                Keyboard.dismiss();
                setIsInputFocused(false);
            }
            return next;
        });
    }, []);

    const handleSelectionChange = React.useCallback((event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const nextSelection = event.nativeEvent.selection;
        const pendingSelection = pendingSelectionRef.current;
        if (pendingSelection) {
            if (!selectionsEqual(pendingSelection, nextSelection)) {
                return;
            }
            pendingSelectionRef.current = null;
            setSelectionRestorePending(false);
        }
        selectionRef.current = nextSelection;
        if (isRangeSelection(nextSelection)) {
            lastRangeSelectionRef.current = nextSelection;
        } else {
            lastRangeSelectionRef.current = null;
        }
        setEditorSelection(nextSelection);
        onSelectionChange(nextSelection);
    }, [onSelectionChange]);
    const handleToolbarSelectionChange = React.useCallback((nextSelection: MarkdownSelection) => {
        pendingSelectionRef.current = null;
        setSelectionRestorePending(false);
        selectionRef.current = nextSelection;
        if (isRangeSelection(nextSelection)) {
            lastRangeSelectionRef.current = nextSelection;
        } else {
            lastRangeSelectionRef.current = null;
        }
        setEditorSelection(nextSelection);
        onSelectionChange(nextSelection);
    }, [onSelectionChange]);
    const restoreEditorFocus = React.useCallback((selectionOverride?: MarkdownSelection) => {
        const targetSelection = selectionOverride ?? selectionRef.current;
        if (targetSelection) {
            pendingSelectionRef.current = targetSelection;
            setSelectionRestorePending(true);
        }
        const focusInput = () => {
            inputRef.current?.focus();
            if (targetSelection) {
                inputRef.current?.setNativeProps?.({ selection: targetSelection });
            }
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(focusInput);
        } else {
            setTimeout(focusInput, 0);
        }
        const applyDelayedFocus = (shouldClearPending: boolean) => {
            focusInput();
            if (
                targetSelection
                && pendingSelectionRef.current
                && shouldClearPending
                && selectionsEqual(pendingSelectionRef.current, targetSelection)
            ) {
                pendingSelectionRef.current = null;
            }
            if (
                shouldClearPending
                && (
                    !pendingSelectionRef.current
                    || (targetSelection && selectionsEqual(pendingSelectionRef.current, targetSelection))
                )
            ) {
                setSelectionRestorePending(false);
            }
        };
        setTimeout(() => {
            applyDelayedFocus(false);
        }, 40);
        setTimeout(() => {
            applyDelayedFocus(false);
        }, 140);
        setTimeout(() => {
            applyDelayedFocus(true);
        }, 300);
    }, []);
    const handleToolbarInteractionStart = React.useCallback(() => {
        toolbarInteractionUntilRef.current = Date.now() + 300;
        setIsInputFocused(true);
    }, []);

    const handleChangeText = React.useCallback((nextValue: string) => {
        const ignoredNativeChange = ignoredNativePairChangeRef.current;
        if (ignoredNativeChange) {
            if (shouldIgnoreNativePairChange(nextValue, valueRef.current, ignoredNativeChange)) {
                restoreEditorFocus(ignoredNativeChange.selection);
                return;
            }
            ignoredNativePairChangeRef.current = null;
        }

        const currentSelection = selectionRef.current;
        const previousValue = valueRef.current;
        const fallbackSelection = lastRangeSelectionRef.current;
        const assistEnabled = isMarkdownEditorAssistEnabled(useTaskStore.getState().settings);
        const pastedUrl = applyMarkdownUrlPasteWithSelectionFallback(
            previousValue,
            nextValue,
            currentSelection,
            fallbackSelection,
            { assist: assistEnabled },
        );
        if (pastedUrl) {
            valueRef.current = pastedUrl.result.value;
            selectionRef.current = pastedUrl.result.selection;
            lastRangeSelectionRef.current = isRangeSelection(pastedUrl.result.selection) ? pastedUrl.result.selection : null;
            setEditorValue(pastedUrl.result.value);
            setEditorSelection(pastedUrl.result.selection);
            onChange(pastedUrl.result.value);
            onSelectionChange(pastedUrl.result.selection);
            restoreEditorFocus(pastedUrl.result.selection);
            return;
        }

        const pairedInsertion = applyMarkdownPairInsertionWithSelectionFallback(
            valueRef.current,
            nextValue,
            selectionRef.current,
            fallbackSelection,
            { assist: assistEnabled },
        );
        if (pairedInsertion) {
            ignoredNativePairChangeRef.current = createIgnoredNativePairChangeFromTextChange(
                valueRef.current,
                nextValue,
                pairedInsertion.baseSelection,
                pairedInsertion.result,
            );
            valueRef.current = pairedInsertion.result.value;
            selectionRef.current = pairedInsertion.result.selection;
            lastRangeSelectionRef.current = isRangeSelection(pairedInsertion.result.selection) ? pairedInsertion.result.selection : null;
            setEditorValue(pairedInsertion.result.value);
            setEditorSelection(pairedInsertion.result.selection);
            onChange(pairedInsertion.result.value);
            onSelectionChange(pairedInsertion.result.selection);
            restoreEditorFocus(pairedInsertion.result.selection);
            return;
        }

        const continued = continueMarkdownOnTextChange(
            valueRef.current,
            nextValue,
            selectionRef.current,
            { assist: assistEnabled },
        );
        if (continued) {
            lastRangeSelectionRef.current = null;
            valueRef.current = continued.value;
            selectionRef.current = continued.selection;
            setEditorValue(continued.value);
            setEditorSelection(continued.selection);
            onChange(continued.value);
            onSelectionChange(continued.selection);
            restoreEditorFocus(continued.selection);
            return;
        }

        lastRangeSelectionRef.current = null;
        valueRef.current = nextValue;
        setEditorValue(nextValue);
        onChange(nextValue);
    }, [onChange, onSelectionChange, restoreEditorFocus]);
    // Auto-pairing intentionally lives only in the text-change handler. On Android the
    // keyPress event is synthesized from the same native edit as the text change (and
    // preventDefault cannot cancel it), so pairing here too processes one keystroke
    // twice — IME-specific echo orders then double the pair (#565).
    const handleKeyPress = React.useCallback((event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        const next = applyMarkdownKeyboardShortcut(
            valueRef.current,
            selectionRef.current,
            { key: event.nativeEvent.key },
        );
        if (!next) return;
        event.preventDefault?.();
        valueRef.current = next.value;
        selectionRef.current = next.selection;
        lastRangeSelectionRef.current = isRangeSelection(next.selection) ? next.selection : null;
        setEditorValue(next.value);
        setEditorSelection(next.selection);
        onChange(next.value);
        onSelectionChange(next.selection);
        restoreEditorFocus(next.selection);
    }, [onChange, onSelectionChange, restoreEditorFocus]);

    const handleApplyAction = React.useCallback((actionId: MarkdownToolbarActionId, currentSelection: MarkdownSelection) => {
        const liveSelection = selectionRef.current ?? currentSelection;
        const next = onApplyAction
            ? onApplyAction(actionId, liveSelection)
            : applyMarkdownToolbarAction(valueRef.current, liveSelection, actionId);
        if (!next) {
            return undefined;
        }

        valueRef.current = next.value;
        selectionRef.current = next.selection;
        lastRangeSelectionRef.current = isRangeSelection(next.selection) ? next.selection : null;
        setEditorValue(next.value);
        setEditorSelection(next.selection);

        if (!onApplyAction) {
            onChange(next.value);
            onSelectionChange(next.selection);
        }

        restoreEditorFocus(next.selection);
        return next;
    }, [onApplyAction, onChange, onSelectionChange, restoreEditorFocus]);
    const handleAutocompleteApply = React.useCallback((next: MarkdownToolbarResult) => {
        valueRef.current = next.value;
        selectionRef.current = next.selection;
        lastRangeSelectionRef.current = isRangeSelection(next.selection) ? next.selection : null;
        setEditorValue(next.value);
        setEditorSelection(next.selection);
        onChange(next.value);
        onSelectionChange(next.selection);
        restoreEditorFocus(next.selection);
    }, [onChange, onSelectionChange, restoreEditorFocus]);
    const editContentStyle = React.useMemo(() => [
        styles.content,
        isInputFocused ? styles.contentWithToolbar : null,
    ], [isInputFocused]);

    return (
        <Modal
            visible={isOpen}
            animationType="slide"
            presentationStyle="fullScreen"
            onRequestClose={handleRequestClose}
            onShow={() => {
                if (initialMode === 'edit') {
                    pendingInitialFocusRef.current = false;
                    scheduleEditorFocus();
                }
            }}
        >
            <KeyboardAccessoryHost>
                <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['top', 'bottom']}>
                    <View style={[styles.header, { borderBottomColor: tc.border }]}>
                        <TouchableOpacity
                            onPress={() => handleClose()}
                            style={[
                                styles.closeButton,
                                direction === 'rtl' ? { left: undefined, right: 16 } : null,
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={t('markdown.collapse')}
                        >
                            <Ionicons name="close" size={24} color={tc.text} />
                        </TouchableOpacity>

                        <Text style={[styles.title, { color: tc.text }]} numberOfLines={1}>
                            {resolvedHeaderTitle}
                        </Text>

                        <TouchableOpacity
                            onPress={handleToggleMode}
                            style={[
                                styles.modeButton,
                                direction === 'rtl' ? { right: undefined, left: 16 } : null,
                                { backgroundColor: tc.cardBg, borderColor: tc.border },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={mode === 'edit' ? t('markdown.preview') : t('markdown.edit')}
                        >
                            {mode === 'edit' ? (
                                <Eye size={18} color={tc.tint} aria-hidden accessible={false} pointerEvents="none" />
                            ) : (
                                <Pencil size={18} color={tc.tint} aria-hidden accessible={false} pointerEvents="none" />
                            )}
                        </TouchableOpacity>
                    </View>

                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                        keyboardVerticalOffset={0}
                        style={styles.body}
                    >
                        {mode === 'edit' ? (
                            <View style={editContentStyle}>
                                <MarkdownReferenceAutocomplete
                                    currentTaskId={currentTaskId}
                                    value={editorValue}
                                    selection={editorSelection}
                                    inputRef={inputRef}
                                    visible={isInputFocused}
                                    onApplyResult={handleAutocompleteApply}
                                    t={t}
                                    tc={tc}
                                />
                                <TextInput
                                    ref={inputRef}
                                    style={[
                                        styles.editorInput,
                                        directionStyle,
                                        { color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border },
                                    ]}
                                    value={editorValue}
                                    onChangeText={handleChangeText}
                                    onKeyPress={handleKeyPress}
                                    onFocus={() => {
                                        setIsInputFocused(true);
                                    }}
                                    onBlur={() => {
                                        const preserveFocus = toolbarInteractionUntilRef.current > Date.now();
                                        if (preserveFocus) {
                                            restoreEditorFocus();
                                            return;
                                        }
                                        setTimeout(() => {
                                            if (!inputRef.current?.isFocused?.()) {
                                                setIsInputFocused(false);
                                            }
                                        }, 0);
                                    }}
                                    selection={getControlledTextInputSelection(editorSelection, {
                                        force: selectionRestorePending,
                                    })}
                                    onSelectionChange={handleSelectionChange}
                                    placeholder={placeholder}
                                    placeholderTextColor={tc.secondaryText}
                                    multiline
                                    spellCheck={true}
                                    autoCorrect={true}
                                    autoCapitalize="sentences"
                                    autoComplete="off"
                                    importantForAutofill="no"
                                    inputMode="text"
                                    textContentType="none"
                                    keyboardType="default"
                                    accessibilityLabel={title}
                                    accessibilityHint={placeholder}
                                />
                                <MarkdownFormatToolbar
                                    selection={editorSelection}
                                    onSelectionChange={handleToolbarSelectionChange}
                                    inputRef={inputRef}
                                    t={t}
                                    tc={tc}
                                    visible={isInputFocused}
                                    canUndo={canUndo}
                                    onUndo={onUndo}
                                    onApplyAction={handleApplyAction}
                                    onInteractionStart={handleToolbarInteractionStart}
                                />
                            </View>
                        ) : (
                            <ScrollView
                                style={styles.previewScroll}
                                contentContainerStyle={styles.previewContent}
                                keyboardShouldPersistTaps="handled"
                            >
                                <View style={[styles.previewSurface, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                                    <MarkdownText markdown={editorValue} tc={tc} direction={direction} />
                                </View>
                            </ScrollView>
                        )}
                    </KeyboardAvoidingView>
                </SafeAreaView>
            </KeyboardAccessoryHost>
        </Modal>
    );
}
