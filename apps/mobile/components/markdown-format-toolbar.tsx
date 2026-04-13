import React from 'react';
import {
    Keyboard,
    Pressable,
    Platform,
    ScrollView,
    Text,
    TextInput,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
    MARKDOWN_TOOLBAR_ACTIONS,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
} from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';

import { KeyboardAccessoryPortal } from './keyboard-accessory-host';
import { markdownFormatToolbarStyles as styles } from './markdown-format-toolbar.styles';

type MarkdownFormatToolbarProps = {
    selection: MarkdownSelection;
    onSelectionChange: (selection: MarkdownSelection) => void;
    inputRef: React.RefObject<TextInput | null>;
    t: (key: string) => string;
    tc: ThemeColors;
    visible: boolean;
    canUndo: boolean;
    onUndo: () => MarkdownSelection | undefined;
    onApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult | void;
    onInteractionStart?: () => void;
};

const translateWithFallback = (t: (key: string) => string, key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
};

const renderActionLabel = (actionId: MarkdownToolbarActionId, shortLabel: string, color: string) => {
    switch (actionId) {
        case 'bulletList':
            return <Ionicons name="list-outline" size={16} color={color} />;
        case 'taskList':
            return <Ionicons name="checkbox-outline" size={16} color={color} />;
        default:
            return (
                <Text
                    style={[
                        styles.buttonText,
                        actionId === 'italic' ? styles.buttonTextItalic : null,
                        { color },
                    ]}
                >
                    {shortLabel}
                </Text>
            );
    }
};

export function MarkdownFormatToolbar({
    selection,
    onSelectionChange,
    inputRef,
    t,
    tc,
    visible,
    canUndo,
    onUndo,
    onApplyAction,
    onInteractionStart,
}: MarkdownFormatToolbarProps) {
    const [keyboardInset, setKeyboardInset] = React.useState(0);

    React.useEffect(() => {
        if (typeof Keyboard?.addListener !== 'function') return;

        const updateKeyboardInset = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
            const metrics = typeof Keyboard.metrics === 'function' ? Keyboard.metrics() : undefined;
            const explicitInset = typeof event.endCoordinates?.height === 'number'
                ? Math.max(0, event.endCoordinates.height)
                : 0;
            const measuredInset = typeof metrics?.height === 'number'
                ? Math.max(0, metrics.height)
                : 0;
            setKeyboardInset(measuredInset || explicitInset);
        };

        const resetKeyboardInset = () => setKeyboardInset(0);

        const showListener = Keyboard.addListener('keyboardDidShow', updateKeyboardInset);
        const changeListener = Keyboard.addListener('keyboardDidChangeFrame', updateKeyboardInset);
        const hideListener = Keyboard.addListener('keyboardDidHide', resetKeyboardInset);

        return () => {
            showListener.remove();
            changeListener.remove();
            hideListener.remove();
        };
    }, []);

    const restoreSelection = React.useCallback((nextSelection?: MarkdownSelection) => {
        if (!nextSelection) return;
        onSelectionChange(nextSelection);

        const focusInput = () => {
            inputRef.current?.focus();
            inputRef.current?.setNativeProps?.({ selection: nextSelection });
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(focusInput);
            return;
        }

        setTimeout(focusInput, 0);
    }, [inputRef, onSelectionChange]);

    const keepInputFocused = React.useCallback(() => {
        const targetSelection = selection;

        const focusInput = () => {
            inputRef.current?.focus();
            inputRef.current?.setNativeProps?.({ selection: targetSelection });
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(focusInput);
            return;
        }

        setTimeout(focusInput, 0);
    }, [inputRef, selection]);

    const handleUndo = React.useCallback(() => {
        if (!canUndo) return;
        restoreSelection(onUndo() ?? undefined);
    }, [canUndo, onUndo, restoreSelection]);

    const handleApplyAction = React.useCallback((actionId: MarkdownToolbarActionId) => {
        restoreSelection(onApplyAction(actionId, selection)?.selection);
    }, [onApplyAction, restoreSelection, selection]);

    if (!visible || keyboardInset <= 0) {
        return null;
    }

    const toolbarBottom = Platform.OS === 'android' ? 0 : keyboardInset;

    return (
        <KeyboardAccessoryPortal>
            <View pointerEvents="box-none" style={styles.overlay}>
                <View
                    style={[
                        styles.floatingBar,
                        {
                            bottom: toolbarBottom,
                            backgroundColor: tc.bg,
                            borderTopColor: tc.border,
                        },
                    ]}
                >
                    <View style={styles.row}>
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            style={styles.scroll}
                            contentContainerStyle={styles.content}
                            keyboardShouldPersistTaps="always"
                        >
                            {MARKDOWN_TOOLBAR_ACTIONS.map((action) => (
                                <Pressable
                                    key={action.id}
                                    focusable={false}
                                    onPressIn={() => {
                                        onInteractionStart?.();
                                        keepInputFocused();
                                        handleApplyAction(action.id);
                                    }}
                                    style={({ pressed }) => [
                                        styles.button,
                                        { backgroundColor: pressed ? tc.filterBg : 'transparent' },
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityLabel={translateWithFallback(t, action.labelKey, action.fallbackLabel)}
                                    hitSlop={8}
                                >
                                    {renderActionLabel(action.id, action.shortLabel, tc.text)}
                                </Pressable>
                            ))}
                        </ScrollView>

                        <View style={styles.trailingActions}>
                            <View style={[styles.divider, { backgroundColor: tc.border }]} />

                            <Pressable
                                focusable={false}
                                onPressIn={() => {
                                    onInteractionStart?.();
                                    keepInputFocused();
                                    handleUndo();
                                }}
                                disabled={!canUndo}
                                style={({ pressed }) => [
                                    styles.button,
                                    !canUndo ? styles.buttonDisabled : null,
                                    { backgroundColor: pressed ? tc.filterBg : 'transparent' },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={translateWithFallback(t, 'common.undo', 'Undo')}
                                hitSlop={8}
                            >
                                <Ionicons name="arrow-undo-outline" size={18} color={tc.text} />
                            </Pressable>
                        </View>
                    </View>
                </View>
            </View>
        </KeyboardAccessoryPortal>
    );
}
