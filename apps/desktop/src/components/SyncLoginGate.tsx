import { useEffect, useState, type ComponentType } from 'react';
import { logError } from '../lib/app-log';
import { SyncService } from '../lib/sync-service';
import { getRequireSyncFlag } from '../lib/web-runtime-config';
import { SyncLoginScreen } from './SyncLoginScreen';

type GateState = 'checking' | 'needs-login' | 'ready';

async function hasStoredSelfHostedCloudConfig(): Promise<boolean> {
    const [backend, provider, config] = await Promise.all([
        SyncService.getSyncBackend(),
        SyncService.getCloudProvider(),
        SyncService.getCloudConfig(),
    ]);
    return backend === 'cloud'
        && provider === 'selfhosted'
        && Boolean(config.url.trim())
        && Boolean(config.token.trim());
}

export function SyncLoginGate({ RootApp }: { RootApp: ComponentType }) {
    const [state, setState] = useState<GateState>('checking');

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const requireSync = await getRequireSyncFlag();
                if (!requireSync) {
                    if (active) setState('ready');
                    return;
                }
                const loggedIn = await hasStoredSelfHostedCloudConfig();
                if (active) setState(loggedIn ? 'ready' : 'needs-login');
            } catch (error) {
                // Fail OPEN: staying in 'checking' renders null forever, so a
                // transient read failure would be a permanent blank page with no
                // way out. This gate is a convenience check, not access control
                // (getRequireSyncFlag() resolves false on failure for the same
                // reason), so never lock someone out of their own local data.
                void logError(error, { scope: 'sync-login-gate' });
                if (active) setState('ready');
            }
        })();
        return () => {
            active = false;
        };
    }, []);

    if (state === 'checking') return null;
    if (state === 'needs-login') {
        return <SyncLoginScreen onLoggedIn={() => setState('ready')} />;
    }
    return <RootApp />;
}
