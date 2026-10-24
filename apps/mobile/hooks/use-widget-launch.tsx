import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { afterPaint } from '@mindwtr/core';
import { completeWidgetLaunch, getWidgetLaunchState, type WidgetLaunchState } from '@/modules/android-widget';
import { logInfo } from '@/lib/app-log';
import { getRoutedWidgetLaunchToken, subscribeWidgetLaunchRouting } from '@/lib/widget-launch-routing';

type EditorOutcome = 'list' | 'closed-clean' | 'preserved-draft';
type PendingLaunch = WidgetLaunchState & { editor: EditorOutcome; routed: boolean };
const editorListeners = new Set<() => EditorOutcome>();
export function subscribeWidgetLaunch(listener: () => EditorOutcome) {
    editorListeners.add(listener);
    return () => { editorListeners.delete(listener); };
}

export const WidgetLaunchContext = createContext<{
    pending: PendingLaunch | null;
    complete: (token: number) => void;
}>({ pending: null, complete: () => {} });

/** The native cover starts before Linking resumes the retained React tree. Keep that tree and its drafts mounted. */
export function useWidgetLaunch(incomingDelivery: number) {
    const [pending, setPending] = useState<PendingLaunch | null>(null);
    const delivered = useRef(0);
    const editorOutcome = useRef<EditorOutcome>('list');
    const logged = useRef('');
    const refresh = useCallback(() => {
        const state = getWidgetLaunchState();
        if (state?.stage === 'pending') {
            if (delivered.current !== state.token) {
                delivered.current = state.token;
                editorOutcome.current = 'list';
                // Same-route widget deliveries have no blur event. Reuse the editor's existing guarded decision.
                for (const listener of editorListeners) {
                    const outcome = listener();
                    if (outcome === 'preserved-draft' || (outcome === 'closed-clean' && editorOutcome.current === 'list')) editorOutcome.current = outcome;
                }
            }
            setPending({ ...state, editor: editorOutcome.current, routed: getRoutedWidgetLaunchToken() === state.token });
            return;
        }
        setPending(null);
        if (!state) return;
        const signature = `${state.token}:${state.stage}`;
        if (logged.current === signature) return;
        logged.current = signature;
        void logInfo('Widget launch handoff finished', {
            scope: 'navigation', force: true,
            extra: { releaseCheck: 'v1.3.8/widget-launch-destination', stage: state.stage, outcome: editorOutcome.current },
        }).catch(() => undefined);
    }, []);
    useEffect(() => {
        refresh();
        const subscription = AppState.addEventListener('change', refresh);
        const unsubscribeRouting = subscribeWidgetLaunchRouting(refresh);
        return () => { subscription.remove(); unsubscribeRouting(); };
    }, [incomingDelivery, refresh]);
    useEffect(() => {
        if (!pending) return;
        // Native also recovers independently if JS stops. This read records its actual result in Settings Diagnostics.
        const recovery = setTimeout(refresh, 5_100);
        return () => clearTimeout(recovery);
    }, [pending, refresh]);
    const complete = useCallback((token: number) => {
        void completeWidgetLaunch(token).then(refresh);
    }, [refresh]);
    return { pending, complete };
}

/** A fresh native layout in the focused destination is required even when the widget opens the current route. */
export function WidgetLaunchDestination({ path }: { path: string }) {
    const { pending, complete } = useContext(WidgetLaunchContext);
    if (!pending?.routed || pending.path !== path) return null;
    return <FocusedWidgetLaunchDestination key={pending.token} token={pending.token} complete={complete} />;
}

function FocusedWidgetLaunchDestination({ token, complete }: { token: number; complete: (token: number) => void }) {
    const focused = useIsFocused();
    const cancelPaint = useRef<(() => void) | undefined>(undefined);
    useEffect(() => () => cancelPaint.current?.(), [focused]);
    if (!focused) return null;
    return <View
        collapsable={false}
        pointerEvents="none"
        accessible={false}
        style={{ position: 'absolute', width: 1, height: 1 }}
        onLayout={() => {
            cancelPaint.current?.();
            cancelPaint.current = afterPaint(() => complete(token));
        }}
    />;
}
