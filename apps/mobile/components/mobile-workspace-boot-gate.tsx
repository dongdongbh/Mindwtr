import React from 'react';
import * as Application from 'expo-application';
import { Platform } from 'react-native';

import { initializeMobileWorkspace } from '@/lib/sandbox-workspace';
import { logWarn, recoverRetainedFatalCrash, setupGlobalErrorLogging } from '@/lib/app-log';

const readCrashMetadata = (): { appVersion?: string; buildVersion?: string; platform?: string } => {
    const metadata: { appVersion?: string; buildVersion?: string; platform?: string } = {};
    try {
        if (typeof Platform.OS === 'string') metadata.platform = Platform.OS;
    } catch {
    }
    try {
        const appVersion = Application.nativeApplicationVersion;
        if (typeof appVersion === 'string') metadata.appVersion = appVersion;
    } catch {
    }
    try {
        const buildVersion = Application.nativeBuildVersion;
        if (typeof buildVersion === 'string') metadata.buildVersion = buildVersion;
    } catch {
    }
    return metadata;
};

export function MobileWorkspaceBootGate({ children }: { children: React.ReactNode }) {
    const [ready, setReady] = React.useState(false);

    React.useEffect(() => {
        try {
            setupGlobalErrorLogging({ crashMetadata: readCrashMetadata() });
            void recoverRetainedFatalCrash().catch(() => false);
        } catch {

        }
        let cancelled = false;
        void initializeMobileWorkspace()
            .then((result) => {
                if (result.requestError) {
                    void logWarn('Sandbox boot request could not be consumed', {
                        scope: 'sandbox',
                        extra: { outcome: 'personal-fallback' },
                    });
                }
                if (!cancelled) setReady(true);
            })
            .catch((error) => {
                void logWarn('Workspace bootstrap failed', {
                    scope: 'sandbox',
                    extra: { outcome: 'bootstrap-failed', error: error instanceof Error ? error.message : String(error) },
                });
            });
        return () => {
            cancelled = true;
        };
    }, []);

    return ready ? <>{children}</> : null;
}
