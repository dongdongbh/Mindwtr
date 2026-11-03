import { SQLITE_SCHEMA_VERSION } from '@mindwtr/core';

import {
    detectDesktopPlatform,
    getDesktopChannel,
    getDesktopLocale,
    getDesktopOsMajor,
    getDesktopVersion,
} from './analytics-heartbeat';
import { isDiagnosticsEnabled, logInfo } from './app-log';
import { isTauriRuntime } from './runtime';

let startupContextLogged = false;

const getLoggingReason = (loggingEnabled: boolean): string => {
    if (isDiagnosticsEnabled()) return 'diagnostics-build';
    return loggingEnabled ? 'user-enabled' : 'startup-force';
};


export async function logDesktopStartupContext(loggingEnabled: boolean): Promise<void> {
    if (startupContextLogged) return;
    startupContextLogged = true;

    const platform = detectDesktopPlatform();
    const [channel, version, syncBackend] = await Promise.all([
        getDesktopChannel(),
        getDesktopVersion(),
        isTauriRuntime()
            ? import('./sync-service')
                .then(({ SyncService }) => SyncService.getSyncBackend())
                .catch(() => 'off')
            : Promise.resolve('off'),
    ]);

    void logInfo('App started', {
        scope: 'startup',
        force: true,
        extra: {
            version,
            platform,
            osMajor: getDesktopOsMajor(platform),
            locale: getDesktopLocale(),
            channel,
            syncBackend,
            schemaVersion: String(SQLITE_SCHEMA_VERSION),
            loggingReason: getLoggingReason(loggingEnabled),
        },
    });
}
