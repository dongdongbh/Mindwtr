import React from 'react';
import {
    Dimensions,
    Keyboard,
    Pressable,
    Platform,
    ScrollView,
    Text,
    TextInput,
    View,
    useWindowDimensions,
    type LayoutChangeEvent,
} from 'react-native';
import { FontAwesome, Ionicons } from '@expo/vector-icons';
import {
    MARKDOWN_TOOLBAR_ACTIONS,
    translateWithFallback,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
} from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';

import { KeyboardAccessoryPortal } from './keyboard-accessory-host';
import { markdownFormatToolbarStyles as styles } from './markdown-format-toolbar.styles';
import { useAdaptiveWindow } from './adaptive-window-context';

const TOOLBAR_MIN_BUTTON_SIZE = 32;
const TOOLBAR_MAX_BUTTON_SIZE = 40;
const TOOLBAR_OUTER_PADDING = 16;
const TOOLBAR_FIXED_CHROME = 18;
const TOOLBAR_ACTION_GAP = 2;
const MIN_RESIZED_WINDOW_DELTA = 48;
const RESIZED_WINDOW_TOLERANCE = 32;
const ANDROID_KEYBOARD_EDGE_GAP = 0;
const ANDROID_STALE_KEYBOARD_METRICS_MAX_INSET = 96;

const getKeyboardMetricsInset = () => {
    const metrics = typeof Keyboard.metrics === 'function' ? Keyboard.metrics() : undefined;
    return typeof metrics?.height === 'number' && Number.isFinite(metrics.height)
        ? Math.max(0, metrics.height)
        : 0;
};

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
    placement?: 'keyboard' | 'inline';
};

type KeyboardInsetSnapshot = {
    windowHeight: number;
    screenHeight: number;
    keyboardInset: number;
    keyboardTop?: number;
    resizedWindowDelta: number;
    windowAlreadyEndsAtKeyboardTop: boolean;
    windowAndKeyboardFitScreen: boolean;
};

type KeyboardToolbarState = {
    visible: boolean;
    bottomOffset: number;
    ready: boolean;
};

const createHiddenKeyboardToolbarState = (): KeyboardToolbarState => ({
    visible: false,
    bottomOffset: 0,
    ready: false,
});

const renderActionLabel = (
    actionId: MarkdownToolbarActionId,
    shortLabel: string,
    color: string,
    iconSize: number,
    fontSize: number,
) => {
    switch (actionId) {
        case 'bulletList':
            return <Ionicons name="list-outline" size={iconSize} color={color} />;
        case 'orderedList':
            return <Ionicons name="list-circle-outline" size={iconSize} color={color} />;
        case 'taskList':
            return <Ionicons name="checkbox-outline" size={iconSize} color={color} />;
        case 'horizontalRule':
            return <Ionicons name="remove-outline" size={iconSize} color={color} />;
        case 'quote':
            return <Ionicons name="chatbox-ellipses-outline" size={iconSize} color={color} />;
        case 'link':
            return <Ionicons name="link-outline" size={iconSize} color={color} />;
        case 'code':
            return <Ionicons name="code-slash-outline" size={iconSize} color={color} />;
        case 'codeBlock':
            return <Ionicons name="code-working-outline" size={iconSize} color={color} />;
        case 'italic':
            return <FontAwesome name="italic" size={Math.max(12, Math.round(iconSize * 0.64))} color={color} />;
        case 'strikethrough':
            return <FontAwesome name="strikethrough" size={Math.max(12, Math.round(iconSize * 0.64))} color={color} />;
        default:
            return (
                <Text
                    style={[
                        styles.buttonText,
                        { color, fontSize },
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
    placement = 'keyboard',
}: MarkdownFormatToolbarProps) {
    const { width: windowWidth } = useWindowDimensions();
    const adaptiveWindow = useAdaptiveWindow();
    const constrainToolbar = adaptiveWindow.isExpanded || Boolean(adaptiveWindow.activeFeature);
    const toolbarWidth = constrainToolbar
        ? Math.min(860, adaptiveWindow.foregroundFrame.width)
        : windowWidth;
    const toolbarLeft = adaptiveWindow.foregroundFrame.x
        + Math.max(0, (adaptiveWindow.foregroundFrame.width - toolbarWidth) / 2);
    const [keyboardToolbarState, setKeyboardToolbarState] = React.useState<KeyboardToolbarState>(() => {
        if (placement === 'inline') {
            return {
                visible: true,
                bottomOffset: 0,
                ready: true,
            };
        }
        return {
            visible: getKeyboardMetricsInset() > 0,
            bottomOffset: 0,
            ready: false,
        };
    });
    const baselineWindowHeightRef = React.useRef(Dimensions.get('window').height);
    const overlayHeightRef = React.useRef<number | null>(null);
    const lastKeyboardSnapshotRef = React.useRef<KeyboardInsetSnapshot | null>(null);
    const suppressPressUntilRef = React.useRef(0);

    const buttonSize = React.useMemo(() => {
        const buttonCount = MARKDOWN_TOOLBAR_ACTIONS.length + 1;
        const gapsWidth = TOOLBAR_ACTION_GAP * Math.max(0, MARKDOWN_TOOLBAR_ACTIONS.length - 1);
        const availableWidth = Math.max(
            0,
            toolbarWidth - TOOLBAR_OUTER_PADDING - TOOLBAR_FIXED_CHROME - gapsWidth,
        );
        const fittedSize = Math.floor(availableWidth / buttonCount);
        return Math.max(TOOLBAR_MIN_BUTTON_SIZE, Math.min(TOOLBAR_MAX_BUTTON_SIZE, fittedSize));
    }, [toolbarWidth]);
    const iconSize = Math.max(18, Math.min(22, Math.round(buttonSize * 0.58)));
    const fontSize = Math.max(12, Math.min(14, Math.round(buttonSize * 0.36)));
    const adaptiveButtonStyle = React.useMemo(() => ({
        minHeight: buttonSize,
        minWidth: buttonSize,
        paddingHorizontal: 0,
        width: buttonSize,
    }), [buttonSize]);

    const resolveKeyboardBottomOffset = React.useCallback((snapshot: KeyboardInsetSnapshot) => {
        const overlayHeight = overlayHeightRef.current;
        const hasKeyboardInset = snapshot.keyboardInset > 0;
        const hasKeyboardTop = typeof snapshot.keyboardTop === 'number' && Number.isFinite(snapshot.keyboardTop);
        const hasScreenHeight = Number.isFinite(snapshot.screenHeight) && snapshot.screenHeight > 0;
        const hasOverlayHeight = typeof overlayHeight === 'number' && Number.isFinite(overlayHeight) && overlayHeight > 0;
        const overlayAlreadyEndsAtKeyboardTop = hasKeyboardInset
            && hasOverlayHeight
            && hasKeyboardTop
            && overlayHeight <= (snapshot.keyboardTop ?? 0) + RESIZED_WINDOW_TOLERANCE;
        const overlayAndKeyboardFitScreen = hasKeyboardInset
            && hasOverlayHeight
            && hasScreenHeight
            && overlayHeight + snapshot.keyboardInset <= snapshot.screenHeight + RESIZED_WINDOW_TOLERANCE;
        const isWindowAlreadyAboveKeyboard = Platform.OS === 'android'
            && hasKeyboardInset
            && (
                snapshot.windowAlreadyEndsAtKeyboardTop
                || snapshot.windowAndKeyboardFitScreen
                || overlayAlreadyEndsAtKeyboardTop
                || overlayAndKeyboardFitScreen
                || snapshot.resizedWindowDelta >= Math.max(MIN_RESIZED_WINDOW_DELTA, snapshot.keyboardInset * 0.5)
            );

        const isSmallAndroidInset = Platform.OS === 'android'
            && hasKeyboardInset
            && snapshot.keyboardInset <= ANDROID_STALE_KEYBOARD_METRICS_MAX_INSET;

        return isWindowAlreadyAboveKeyboard || isSmallAndroidInset ? 0 : snapshot.keyboardInset;
    }, []);

    React.useEffect(() => {
        if (placement !== 'keyboard') {
            setKeyboardToolbarState({
                visible: true,
                bottomOffset: 0,
                ready: true,
            });
            return;
        }
        if (typeof Keyboard?.addListener !== 'function') return;

        const updateKeyboardInset = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
            const metrics = typeof Keyboard.metrics === 'function' ? Keyboard.metrics() : undefined;
            const windowHeight = Dimensions.get('window').height;
            const screenHeight = Dimensions.get('screen').height;
            const explicitInset = typeof event.endCoordinates?.height === 'number'
                ? Math.max(0, event.endCoordinates.height)
                : 0;
            const measuredInset = typeof metrics?.height === 'number'
                ? Math.max(0, metrics.height)
                : 0;
            const eventScreenY = typeof event.endCoordinates?.screenY === 'number'
                ? event.endCoordinates.screenY
                : undefined;
            const metricsScreenY = typeof metrics?.screenY === 'number'
                ? metrics.screenY
                : undefined;
            const keyboardTop = eventScreenY ?? metricsScreenY;
            const screenInset = typeof keyboardTop === 'number'
                ? Math.max(0, screenHeight - keyboardTop)
                : 0;
            const keyboardInset = Math.max(measuredInset, explicitInset, screenInset);
            if (keyboardInset <= 0) {
                overlayHeightRef.current = null;
                lastKeyboardSnapshotRef.current = null;
                setKeyboardToolbarState(createHiddenKeyboardToolbarState());
                return;
            }

            baselineWindowHeightRef.current = Math.max(baselineWindowHeightRef.current, windowHeight);
            const resizedWindowDelta = Math.max(0, baselineWindowHeightRef.current - windowHeight);
            const hasKeyboardTop = typeof keyboardTop === 'number' && Number.isFinite(keyboardTop);
            const hasScreenHeight = Number.isFinite(screenHeight) && screenHeight > 0;
            const windowAlreadyEndsAtKeyboardTop = hasKeyboardTop
                && windowHeight <= keyboardTop + RESIZED_WINDOW_TOLERANCE;
            const windowAndKeyboardFitScreen = hasScreenHeight
                && windowHeight + keyboardInset <= screenHeight + RESIZED_WINDOW_TOLERANCE;
            const snapshot = {
                windowHeight,
                screenHeight,
                keyboardInset,
                keyboardTop,
                resizedWindowDelta,
                windowAlreadyEndsAtKeyboardTop,
                windowAndKeyboardFitScreen,
            };
            lastKeyboardSnapshotRef.current = snapshot;
            setKeyboardToolbarState({
                visible: keyboardInset > 0,
                bottomOffset: resolveKeyboardBottomOffset(snapshot),
                ready: keyboardInset > 0 && overlayHeightRef.current !== null,
            });
        };

        const resetKeyboardInset = () => {
            baselineWindowHeightRef.current = Dimensions.get('window').height;
            overlayHeightRef.current = null;
            lastKeyboardSnapshotRef.current = null;
            setKeyboardToolbarState(createHiddenKeyboardToolbarState());
        };

        updateKeyboardInset({});
        const showListener = Keyboard.addListener('keyboardDidShow', updateKeyboardInset);
        const changeListener = Keyboard.addListener('keyboardDidChangeFrame', updateKeyboardInset);
        const hideListener = Keyboard.addListener('keyboardDidHide', resetKeyboardInset);

        return () => {
            showListener.remove();
            changeListener.remove();
            hideListener.remove();
        };
    }, [placement, resolveKeyboardBottomOffset]);

    React.useEffect(() => {
        if (visible || placement !== 'keyboard') return;
        overlayHeightRef.current = null;
        setKeyboardToolbarState((current) => (
            current.ready ? { ...current, ready: false } : current
        ));
    }, [placement, visible]);

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
    const guardScrollPress = React.useCallback((durationMs = 180) => {
        suppressPressUntilRef.current = Date.now() + durationMs;
    }, []);
    const shouldSuppressPress = React.useCallback(() => (
        suppressPressUntilRef.current > Date.now()
    ), []);

    if (!visible || (placement === 'keyboard' && !keyboardToolbarState.visible)) {
        return null;
    }

    const handleOverlayLayout = (event: LayoutChangeEvent) => {
        const { height } = event.nativeEvent.layout;
        overlayHeightRef.current = height;
        const snapshot = lastKeyboardSnapshotRef.current;
        if (snapshot && snapshot.keyboardInset > 0) {
            setKeyboardToolbarState({
                visible: true,
                bottomOffset: resolveKeyboardBottomOffset(snapshot),
                ready: true,
            });
        }
    };

    const toolbarContent = (
        <View style={styles.row}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.scroll}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="always"
                onScrollBeginDrag={() => guardScrollPress(260)}
                onScrollEndDrag={() => guardScrollPress(120)}
                onMomentumScrollBegin={() => guardScrollPress(260)}
                onMomentumScrollEnd={() => guardScrollPress(80)}
            >
                {MARKDOWN_TOOLBAR_ACTIONS.map((action) => (
                    <Pressable
                        key={action.id}
                        focusable={false}
                        onPressIn={() => {
                            onInteractionStart?.();
                            keepInputFocused();
                        }}
                        onPress={() => {
                            if (shouldSuppressPress()) return;
                            handleApplyAction(action.id);
                        }}
                        style={({ pressed }) => [
                            styles.button,
                            adaptiveButtonStyle,
                            { backgroundColor: pressed ? tc.filterBg : 'transparent' },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={translateWithFallback(t, action.labelKey, action.fallbackLabel)}
                        hitSlop={8}
                    >
                        {renderActionLabel(action.id, action.shortLabel, tc.text, iconSize, fontSize)}
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
                    }}
                    onPress={() => {
                        if (shouldSuppressPress()) return;
                        handleUndo();
                    }}
                    disabled={!canUndo}
                    style={({ pressed }) => [
                        styles.button,
                        adaptiveButtonStyle,
                        !canUndo ? styles.buttonDisabled : null,
                        { backgroundColor: pressed ? tc.filterBg : 'transparent' },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={translateWithFallback(t, 'common.undo', 'Undo')}
                    hitSlop={8}
                >
                    <Ionicons name="arrow-undo-outline" size={iconSize} color={tc.text} />
                </Pressable>
            </View>
        </View>
    );

    if (placement === 'inline') {
        return (
            <View
                style={[
                    styles.inlineBar,
                    {
                        backgroundColor: tc.cardBg,
                        borderColor: tc.border,
                    },
                ]}
            >
                {toolbarContent}
            </View>
        );
    }

    return (
        <KeyboardAccessoryPortal renderFallback={false}>
            <View pointerEvents="box-none" style={styles.overlay} onLayout={handleOverlayLayout}>
                {keyboardToolbarState.ready ? (
                    <View
                        style={[
                            styles.floatingBar,
                            {
                                bottom: keyboardToolbarState.bottomOffset + (Platform.OS === 'android' ? ANDROID_KEYBOARD_EDGE_GAP : 0),
                                backgroundColor: tc.bg,
                                borderTopColor: tc.border,
                                ...(constrainToolbar ? {
                                    left: toolbarLeft,
                                    right: undefined,
                                    width: toolbarWidth,
                                } : {}),
                            },
                        ]}
                    >
                        {toolbarContent}
                    </View>
                ) : null}
            </View>
        </KeyboardAccessoryPortal>
    );
}
