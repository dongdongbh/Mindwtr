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

    }
};


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

    }
};


export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
    recordWidgetLaunchRouting(path);


    const route = resolveSystemPath(path, initial);
    if (route.kind === 'shareHandoff') logShareHandoffRouted(initial);
    if (route.kind === 'dropboxCallback') logDropboxCallbackRouted();
    if (route.kind === 'quickCapture') logControlCaptureRouted(path, initial);
    return route.path;
}
