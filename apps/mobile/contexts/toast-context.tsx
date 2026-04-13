import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
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

const TOAST_DEFAULT_DURATION_MS = 3200;
const TOAST_ACTION_DURATION_MS = 5200;
const TOAST_QUEUE_GAP_MS = 120;

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
    const insets = useSafeAreaInsets();
    const tc = useThemeColors();
    const [queue, setQueue] = useState<ToastState[]>([]);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const queueAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const opacity = useRef(new Animated.Value(0)).current;
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

    const dismissToast = useCallback(() => {
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
        ]).start(() => {
            const advanceQueue = () => {
                isDismissingRef.current = false;
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
    }, [clearQueueAdvanceTimer, clearTimer, opacity, translateY]);

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
        translateY.stopAnimation();
        opacity.setValue(0);
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
    }, [clearTimer, dismissToast, opacity, toast, translateY]);

    useEffect(() => () => {
        clearTimer();
        clearQueueAdvanceTimer();
    }, [clearQueueAdvanceTimer, clearTimer]);

    const value = useMemo<ToastContextValue>(() => ({
        showToast,
        dismissToast,
    }), [dismissToast, showToast]);

    const accentColor = toast?.tone === 'success'
        ? tc.success
        : toast?.tone === 'warning'
            ? tc.warning
            : toast?.tone === 'error'
                ? tc.danger
                : tc.tint;

    return (
        <ToastContext.Provider value={value}>
            {children}
            <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                {toast && (
                    <View
                        pointerEvents="box-none"
                        style={[
                            styles.viewport,
                            { paddingBottom: Math.max(insets.bottom, 16) + 16 },
                        ]}
                    >
                        <Animated.View
                            style={[
                                styles.toast,
                                {
                                    backgroundColor: tc.cardBg,
                                    borderColor: tc.border,
                                    opacity,
                                    transform: [{ translateY }],
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
                )}
            </View>
        </ToastContext.Provider>
    );
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
