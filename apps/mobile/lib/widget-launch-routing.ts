import { getWidgetLaunchState } from '@/modules/android-widget';

let routedToken = 0;
const listeners = new Set<() => void>();

/** Called by Expo Router before it navigates, independently of useIncomingUrl's duplicate-delivery suppression. */
export function recordWidgetLaunchRouting(url: string) {
    const state = getWidgetLaunchState();
    if (state?.stage !== 'pending' || state.url !== url) return;
    routedToken = state.token;
    for (const listener of listeners) listener();
}

export function getRoutedWidgetLaunchToken() { return routedToken; }

export function subscribeWidgetLaunchRouting(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
