import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    Animated,
    Easing,
    PanResponder,
    Pressable,
    StyleSheet,
    Text,
    View,
    type GestureResponderEvent,
    type PanResponderGestureState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { logError } from '@/lib/app-log';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export type ToastOptions = {
    title?: string;
    message: string;
    tone?: ToastTone;
    durationMs?: number;
    actionLabel?: string;
    onAction?: () => void | Promise<void>;
};

type ToastState = ToastOptions & {
    id: number;
};

type ToastContextValue = {
    showToast: (options: ToastOptions) => void;
    dismissToast: () => void;
};

type ToastRenderState = {
    toast: ToastState | null;
    opacity: Animated.Value;
    translateX: Animated.Value;
    translateY: Animated.Value;
    panHandlers: ReturnType<typeof PanResponder.create>['panHandlers'];
    showToast: (options: ToastOptions) => void;
    dismissToast: () => void;
    topViewportId: number | null;
    registerViewport: (id: number) => void;
    unregisterViewport: (id: number) => void;
    bottomOffset: number;
    setBottomOffset: (offset: number) => void;
};

const TOAST_DEFAULT_DURATION_MS = 3200;
const TOAST_ACTION_DURATION_MS = 5200;
const TOAST_QUEUE_GAP_MS = 120;
const TOAST_SWIPE_ACTIVATION_DISTANCE = 12;
const TOAST_SWIPE_DISMISS_DISTANCE = 72;
const TOAST_SWIPE_DISMISS_VELOCITY = 0.55;
const TOAST_SWIPE_EXIT_DISTANCE = 420;
const TOAST_SWIPE_TARGET_TEST_ID = 'toast-swipe-dismiss-target';

const ToastContext = createContext<ToastContextValue | null>(null);
const ToastRenderContext = createContext<ToastRenderState | null>(null);

let nextViewportId = 1;

const shouldStartToastSwipe = (_event: GestureResponderEvent, gestureState: PanResponderGestureState): boolean => {
    const horizontalDistance = Math.abs(gestureState.dx);
    const verticalDistance = Math.abs(gestureState.dy);
    return horizontalDistance > TOAST_SWIPE_ACTIVATION_DISTANCE && horizontalDistance > verticalDistance * 1.4;
};

const getToastSwipeExitTranslateX = (gestureState: PanResponderGestureState): number | null => {
    const horizontalDistance = Math.abs(gestureState.dx);
    const horizontalVelocity = Math.abs(gestureState.vx);
    if (horizontalDistance < TOAST_SWIPE_DISMISS_DISTANCE && horizontalVelocity < TOAST_SWIPE_DISMISS_VELOCITY) {
        return null;
    }

    const direction = gestureState.dx !== 0 ? Math.sign(gestureState.dx) : Math.sign(gestureState.vx || 1);
    return direction * TOAST_SWIPE_EXIT_DISTANCE;
};

export function ToastProvider({ children }: { children: ReactNode }) {
    const [queue, setQueue] = useState<ToastState[]>([]);
    // Lift the root overlay above a persistent bottom bar (the tab bar) so an
    // undo toast never covers it (#1044). ponytail: single value, not a stack —
    // only the tabs layout registers one; add a stack if a second caller appears.
    const [bottomOffset, setBottomOffset] = useState(0);
    // Native <Modal> windows cover the root overlay, so modal content mounts a
    // ToastViewport and the toast renders in the topmost registered one (#834).
    const [viewportStack, setViewportStack] = useState<number[]>([]);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const queueAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const opacity = useRef(new Animated.Value(0)).current;
    const translateX = useRef(new Animated.Value(0)).current;
    const translateY = useRef(new Animated.Value(18)).current;
    const nextToastId = useRef(1);
    const isDismissingRef = useRef(false);
    const queueRef = useRef<ToastState[]>([]);
    const activeToastRef = useRef<ToastState | null>(null);
    const toast = queue[0] ?? null;

    useEffect(() => {
        queueRef.current = queue;
        activeToastRef.current = toast;
    }, [queue, toast]);

    const clearTimer = useCallback(() => {
        if (!timerRef.current) return;
        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const clearQueueAdvanceTimer = useCallback(() => {
        if (!queueAdvanceTimerRef.current) return;
        clearTimeout(queueAdvanceTimerRef.current);
        queueAdvanceTimerRef.current = null;
    }, []);

    const dismissToast = useCallback((exitTranslateX = 0) => {
        clearTimer();
        clearQueueAdvanceTimer();
        if (!activeToastRef.current || isDismissingRef.current) return;
        isDismissingRef.current = true;
        Animated.parallel([
            Animated.timing(opacity, {
                toValue: 0,
                duration: 150,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
            }),
            Animated.timing(translateY, {
                toValue: 18,
                duration: 180,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
            }),
            Animated.timing(translateX, {
                toValue: exitTranslateX,
                duration: 180,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
            }),
        ]).start(() => {
            const advanceQueue = () => {
                isDismissingRef.current = false;
                translateX.setValue(0);
                setQueue((current) => current.slice(1));
            };
            if (queueRef.current.length > 1) {
                queueAdvanceTimerRef.current = setTimeout(() => {
                    queueAdvanceTimerRef.current = null;
                    advanceQueue();
                }, TOAST_QUEUE_GAP_MS);
                return;
            }
            advanceQueue();
        });
    }, [clearQueueAdvanceTimer, clearTimer, opacity, translateX, translateY]);

    const resetToastSwipeOffset = useCallback(() => {
        Animated.timing(translateX, {
            toValue: 0,
            duration: 140,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        }).start();
    }, [translateX]);

    const panResponder = useMemo(() => PanResponder.create({
        onMoveShouldSetPanResponder: shouldStartToastSwipe,
        onMoveShouldSetPanResponderCapture: shouldStartToastSwipe,
        onPanResponderMove: (_event, gestureState) => {
            translateX.setValue(gestureState.dx);
        },
        onPanResponderRelease: (_event, gestureState) => {
            const exitTranslateX = getToastSwipeExitTranslateX(gestureState);
            if (exitTranslateX !== null) {
                dismissToast(exitTranslateX);
                return;
            }
            resetToastSwipeOffset();
        },
        onPanResponderTerminate: resetToastSwipeOffset,
    }), [dismissToast, resetToastSwipeOffset, translateX]);

    const showToast = useCallback((options: ToastOptions) => {
        setQueue((current) => [
            ...current,
            {
                id: nextToastId.current++,
                tone: options.tone ?? 'info',
                durationMs: options.durationMs ?? (options.actionLabel ? TOAST_ACTION_DURATION_MS : TOAST_DEFAULT_DURATION_MS),
                ...options,
            },
        ]);
    }, []);

    useEffect(() => {
        if (!toast) return undefined;
        isDismissingRef.current = false;

        opacity.stopAnimation();
        translateX.stopAnimation();
        translateY.stopAnimation();
        opacity.setValue(0);
        translateX.setValue(0);
        translateY.setValue(18);

        Animated.parallel([
            Animated.timing(opacity, {
                toValue: 1,
                duration: 180,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }),
            Animated.timing(translateY, {
                toValue: 0,
                duration: 220,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }),
        ]).start();

        timerRef.current = setTimeout(() => {
            dismissToast();
        }, toast.durationMs ?? TOAST_DEFAULT_DURATION_MS);

        return clearTimer;
    }, [clearTimer, dismissToast, opacity, toast, translateX, translateY]);

    useEffect(() => () => {
        clearTimer();
        clearQueueAdvanceTimer();
    }, [clearQueueAdvanceTimer, clearTimer]);

    const value = useMemo<ToastContextValue>(() => ({
        showToast,
        dismissToast,
    }), [dismissToast, showToast]);

    const registerViewport = useCallback((id: number) => {
        setViewportStack((current) => [...current.filter((entry) => entry !== id), id]);
    }, []);

    const unregisterViewport = useCallback((id: number) => {
        setViewportStack((current) => current.filter((entry) => entry !== id));
    }, []);

    const topViewportId = viewportStack.length > 0 ? viewportStack[viewportStack.length - 1] : null;

    const renderState = useMemo<ToastRenderState>(() => ({
        toast,
        opacity,
        translateX,
        translateY,
        panHandlers: panResponder.panHandlers,
        showToast,
        dismissToast,
        topViewportId,
        registerViewport,
        unregisterViewport,
        bottomOffset,
        setBottomOffset,
    }), [bottomOffset, dismissToast, opacity, panResponder, registerViewport, showToast, toast, topViewportId, translateX, translateY, unregisterViewport]);

    return (
        <ToastContext.Provider value={value}>
            <ToastRenderContext.Provider value={renderState}>
                {children}
                {topViewportId === null && <ToastOverlay respectBottomOffset />}
            </ToastRenderContext.Provider>
        </ToastContext.Provider>
    );
}

function ToastOverlay({ respectBottomOffset = false }: { respectBottomOffset?: boolean }) {
    const renderState = useContext(ToastRenderContext);
    const insets = useSafeAreaInsets();
    const tc = useThemeColors();
    if (!renderState?.toast) return null;
    const { toast, opacity, translateX, translateY, panHandlers, showToast, dismissToast } = renderState;
    // The registered offset (tab bar height) already contains the bottom safe
    // area; modal viewports have no tab bar, so they keep the plain inset.
    const bottomOffset = respectBottomOffset ? renderState.bottomOffset : 0;
    const paddingBottom = bottomOffset > 0
        ? bottomOffset + 12
        : Math.max(insets.bottom, 16) + 16;

    const accentColor = toast.tone === 'success'
        ? tc.success
        : toast.tone === 'warning'
            ? tc.warning
            : toast.tone === 'error'
                ? tc.danger
                : tc.tint;

    return (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            <View
                pointerEvents="box-none"
                style={[
                    styles.viewport,
                    { paddingBottom },
                ]}
            >
                <Animated.View
                    testID={TOAST_SWIPE_TARGET_TEST_ID}
                    {...panHandlers}
                    style={[
                        styles.toast,
                        {
                            backgroundColor: tc.cardBg,
                            borderColor: tc.border,
                            opacity,
                            transform: [{ translateX }, { translateY }],
                        },
                    ]}
                >
                    <View style={[styles.accent, { backgroundColor: accentColor }]} />
                    <View style={styles.content}>
                        {toast.title ? (
                            <Text style={[styles.title, { color: tc.text }]} numberOfLines={2}>
                                {toast.title}
                            </Text>
                        ) : null}
                        <Text style={[styles.message, { color: tc.secondaryText }]} numberOfLines={toast.actionLabel ? 4 : 5}>
                            {toast.message}
                        </Text>
                    </View>
                    {toast.actionLabel ? (
                        <Pressable
                            accessibilityRole="button"
                            onPress={async () => {
                                try {
                                    await toast.onAction?.();
                                    dismissToast();
                                } catch (error) {
                                    void logError(error, { scope: 'toast', extra: { message: 'Toast action failed' } });
                                    dismissToast();
                                    showToast({
                                        title: 'Action failed',
                                        message: error instanceof Error && error.message.trim()
                                            ? error.message
                                            : 'Please try again.',
                                        tone: 'error',
                                    });
                                }
                            }}
                            style={styles.actionButton}
                        >
                            <Text style={[styles.actionLabel, { color: accentColor }]}>
                                {toast.actionLabel}
                            </Text>
                        </Pressable>
                    ) : null}
                </Animated.View>
            </View>
        </View>
    );
}

// Mount inside a native <Modal>'s content so toasts fired while the modal is
// open render above it instead of behind the modal window. The most recently
// opened modal wins; the root overlay takes over when no viewport is mounted.
export function ToastViewport() {
    const renderState = useContext(ToastRenderContext);
    const idRef = useRef<number | null>(null);
    if (idRef.current === null) {
        idRef.current = nextViewportId++;
    }
    const id = idRef.current;
    const registerViewport = renderState?.registerViewport;
    const unregisterViewport = renderState?.unregisterViewport;

    useEffect(() => {
        if (!registerViewport || !unregisterViewport) return undefined;
        registerViewport(id);
        return () => unregisterViewport(id);
    }, [id, registerViewport, unregisterViewport]);

    if (!renderState || renderState.topViewportId !== id) return null;
    return <ToastOverlay />;
}

// Mount where a persistent bottom bar lives (the tabs layout) so root-overlay
// toasts render above the bar instead of covering it (#1044). Pass the bar's
// full height including its safe-area inset.
export function useToastBottomOffset(offset: number) {
    const renderState = useContext(ToastRenderContext);
    const setBottomOffset = renderState?.setBottomOffset;
    useEffect(() => {
        if (!setBottomOffset) return undefined;
        setBottomOffset(offset);
        return () => setBottomOffset(0);
    }, [offset, setBottomOffset]);
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return ctx;
}

const styles = StyleSheet.create({
    viewport: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    toast: {
        width: '100%',
        maxWidth: 520,
        minHeight: 56,
        borderRadius: 18,
        borderWidth: 1,
        paddingVertical: 14,
        paddingLeft: 16,
        paddingRight: 14,
        flexDirection: 'row',
        alignItems: 'center',
        shadowColor: '#000000',
        shadowOpacity: 0.18,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 10 },
        elevation: 10,
    },
    accent: {
        width: 4,
        alignSelf: 'stretch',
        borderRadius: 999,
        marginRight: 12,
    },
    content: {
        flex: 1,
        gap: 3,
    },
    title: {
        fontSize: 15,
        fontWeight: '700',
    },
    message: {
        fontSize: 13,
        lineHeight: 18,
    },
    actionButton: {
        marginLeft: 12,
        minWidth: 44,
        minHeight: 44,
        paddingHorizontal: 10,
        paddingVertical: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionLabel: {
        fontSize: 13,
        fontWeight: '700',
    },
});
