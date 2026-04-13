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
    type TextInputSelectionChangeEventData,
    type NativeSyntheticEvent,
    type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
    applyMarkdownToolbarAction,
    continueMarkdownOnTextChange,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
} from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';

import { expandedMarkdownEditorStyles as styles } from './expanded-markdown-editor.styles';
import { KeyboardAccessoryHost } from './keyboard-accessory-host';
import { MarkdownFormatToolbar } from './markdown-format-toolbar';
import { MarkdownText } from './markdown-text';

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
    const valueRef = React.useRef(value);
    const selectionRef = React.useRef(selection);
    // Keep a local mirror while the fullscreen editor is open so Android
    // focus/toolbar interactions do not have to wait on parent rerenders.
    const [editorValue, setEditorValue] = React.useState(value);
    const [editorSelection, setEditorSelection] = React.useState(selection);
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
            pendingSelectionRef.current = null;
            setEditorValue(value);
            setEditorSelection(selection);
        }
        wasOpenRef.current = isOpen;
    }, [initialMode, isOpen, selection, value]);

    React.useEffect(() => {
        if (!isOpen) {
            pendingSelectionRef.current = null;
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
        }
        selectionRef.current = nextSelection;
        setEditorSelection(nextSelection);
        onSelectionChange(nextSelection);
    }, [onSelectionChange]);
    const handleToolbarSelectionChange = React.useCallback((nextSelection: MarkdownSelection) => {
        pendingSelectionRef.current = null;
        selectionRef.current = nextSelection;
        setEditorSelection(nextSelection);
        onSelectionChange(nextSelection);
    }, [onSelectionChange]);
    const restoreEditorFocus = React.useCallback((selectionOverride?: MarkdownSelection) => {
        const targetSelection = selectionOverride ?? selectionRef.current;
        if (targetSelection) {
            pendingSelectionRef.current = targetSelection;
        }
        const focusInput = () => {
            inputRef.current?.focus();
            if (targetSelection) {
                inputRef.current?.setNativeProps?.({ selection: targetSelection });
            }
        };
        requestAnimationFrame(focusInput);
        setTimeout(() => {
            focusInput();
            if (
                targetSelection
                && pendingSelectionRef.current
                && selectionsEqual(pendingSelectionRef.current, targetSelection)
            ) {
                pendingSelectionRef.current = null;
            }
        }, 40);
    }, []);
    const handleToolbarInteractionStart = React.useCallback(() => {
        toolbarInteractionUntilRef.current = Date.now() + 300;
        setIsInputFocused(true);
    }, []);

    const handleChangeText = React.useCallback((nextValue: string) => {
        const continued = continueMarkdownOnTextChange(
            valueRef.current,
            nextValue,
            selectionRef.current,
        );
        if (continued) {
            valueRef.current = continued.value;
            selectionRef.current = continued.selection;
            setEditorValue(continued.value);
            setEditorSelection(continued.selection);
            onChange(continued.value);
            onSelectionChange(continued.selection);
            restoreEditorFocus(continued.selection);
            return;
        }

        valueRef.current = nextValue;
        setEditorValue(nextValue);
        onChange(nextValue);
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
        setEditorValue(next.value);
        setEditorSelection(next.selection);

        if (!onApplyAction) {
            onChange(next.value);
            onSelectionChange(next.selection);
        }

        restoreEditorFocus(next.selection);
        return next;
    }, [onApplyAction, onChange, onSelectionChange, restoreEditorFocus]);

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
                            <Text style={[styles.modeButtonText, { color: tc.tint }]}>
                                {mode === 'edit' ? t('markdown.preview') : t('markdown.edit')}
                            </Text>
                        </TouchableOpacity>
                    </View>

                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                        keyboardVerticalOffset={0}
                        style={styles.body}
                    >
                        {mode === 'edit' ? (
                            <View style={styles.content}>
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
                                <TextInput
                                    ref={inputRef}
                                    style={[
                                        styles.editorInput,
                                        directionStyle,
                                        { color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border },
                                    ]}
                                    value={editorValue}
                                    onChangeText={handleChangeText}
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
                                    selection={editorSelection}
                                    onSelectionChange={handleSelectionChange}
                                    placeholder={placeholder}
                                    placeholderTextColor={tc.secondaryText}
                                    multiline
                                    accessibilityLabel={title}
                                    accessibilityHint={placeholder}
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
