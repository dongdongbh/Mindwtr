import { resolveSystemPath } from '@mindwtr/core';
import { recordWidgetLaunchRouting } from '@/lib/widget-launch-routing';

const logShareHandoffRouted = (initial: boolean): void => {
    try {
        void import('@/lib/app-log')
            .then(({ logInfo }) => logInfo('Share handoff routed', {
                scope: 'routing',
                extra: {
                    releaseCheck: 'v1.3.1/share-handoff-route',
                    stage: 'handoff-routed',
                    delivery: initial ? 'cold' : 'warm',
                },
                force: true,
            }))
            .catch(() => undefined);
    } catch {
        // Optional diagnostics must not block a share handoff.
    }
};

const logDropboxCallbackRouted = (): void => {
    try {
        void import('@/lib/app-log')
            .then(({ logInfo }) => logInfo('Dropbox OAuth callback routed', {
                scope: 'routing',
                extra: {
                    releaseCheck: 'v1.3.0/dropbox-oauth-route',
                    stage: 'callback-routed',
                },
                force: true,
            }))
            .catch(() => undefined);
    } catch {
        // Diagnostics must never become part of system URL routing.
    }
};

// The Control Center control cannot be tested off-device, and its tap runs native code a tester
// never sees. The app-side intent tags its link with `source=control`, so this line proves the
// tap reached the app and was routed to the capture sheet.
const logControlCaptureRouted = (path: string, initial: boolean): void => {
    try {
        if (new URL(path).searchParams.get('source') !== 'control') return;
        void import('@/lib/app-log')
            .then(({ logInfo }) => logInfo('Control Center quick capture routed', {
                scope: 'routing',
                extra: {
                    releaseCheck: 'v1.3.2/ios-control-capture',
                    stage: 'capture-routed',
                    delivery: initial ? 'cold' : 'warm',
                },
                force: true,
            }))
            .catch(() => undefined);
    } catch {
        // Diagnostics must never become part of system URL routing.
    }
};

// Expo Router routes incoming system URLs by path, so mindwtr://open-feature
// would land on the Unmatched Route screen before the root-layout hook can
// redirect. Rewrite it to the destination route up front (#755).
//
// Entity-open links (mindwtr://open?task=...) get the same treatment (#1017):
// land on /inbox immediately so there's no Unmatched Route flash, then
// useRootLayoutExternalCapture's incoming-URL effect (which still sees the
// original URL via Linking.useURL()) resolves the real entity once data is
// ready and re-navigates.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
    recordWidgetLaunchRouting(path);
    // The rules are core's (resolveSystemPath), shared with the native Android app; the diagnostics stay here.
    // - expo-share-intent uses the scheme-derived App Group entry name, not an application route: its original
    //   Linking URL stays intact for the provider. A cold launch needs a valid base route; on a warm delivery Expo
    //   Router ignores the empty result, so nothing races the provider's populated capture modal.
    // - The external-capture hook opens the prefilled confirmation from the original Linking delivery. Letting
    //   Router also visit /capture opens a blank quick-capture sheet behind it, which reappears after closing.
    //   Invalid capture payloads also belong to that hook's error handling.
    // - The hidden tab route depends on a focus callback that is not reliable during an Android widget/tile cold
    //   launch. The root capture modal is purpose-built for system entry points and works on both cold and warm
    //   launches. origin=system lets the modal send the app back behind the previous screen after the capture
    //   ends (#1169); in-app openers never set it.
    const route = resolveSystemPath(path, initial);
    if (route.kind === 'shareHandoff') logShareHandoffRouted(initial);
    if (route.kind === 'dropboxCallback') logDropboxCallbackRouted();
    if (route.kind === 'quickCapture') logControlCaptureRouted(path, initial);
    return route.path;
}
