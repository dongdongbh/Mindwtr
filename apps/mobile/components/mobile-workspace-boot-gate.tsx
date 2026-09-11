import React from 'react';

import { initializeMobileWorkspace } from '@/lib/sandbox-workspace';
import { logWarn } from '@/lib/app-log';

export function MobileWorkspaceBootGate({ children }: { children: React.ReactNode }) {
    const [ready, setReady] = React.useState(false);

    React.useEffect(() => {
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
