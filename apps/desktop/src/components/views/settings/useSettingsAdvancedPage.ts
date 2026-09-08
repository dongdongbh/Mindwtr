import { useCallback, useEffect, useState } from 'react';
import { useTaskStore, type AppData } from '@mindwtr/core';

import { reportError } from '../../../lib/report-error';
import {
    isSupportedProxyUrl,
    normalizeProxyUrl,
    syncNativeProxyUrl,
} from '../../../lib/tauri-http';
import {
    DEFAULT_LOCAL_API_PORT,
    getLocalApiServerStatus,
    normalizeLocalApiPortInput,
    setLocalApiServerConfig,
    type LocalApiServerStatus,
} from '../../../lib/local-api-server';
import {
    getDesktopRenderingConfig,
    setDesktopRenderingConfig,
    type DesktopRenderingConfig,
} from '../../../lib/desktop-rendering';
import { useUiStore } from '../../../store/ui-store';
import type { SettingsLabels } from './labels';
import type { SettingsAdvancedPageProps } from './SettingsAdvancedPage';

type UseSettingsAdvancedPageOptions = {
    loadEnabled?: boolean;
    isTauri: boolean;
    showSaved: () => void;
    t: Pick<SettingsLabels, 'localApiPortInvalid' | 'networkProxyInvalid'>;
};

/**
 * Local API server, network proxy and hardware acceleration state. Returns
 * members already named as props so SettingsView can spread them.
 */
export function useSettingsAdvancedPage({
    loadEnabled = true,
    isTauri,
    showSaved,
    t,
}: UseSettingsAdvancedPageOptions): Omit<SettingsAdvancedPageProps, 't'> {
    const settings =
        useTaskStore((state) => state.settings) ?? ({} as AppData['settings']);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const showToast = useUiStore((state) => state.showToast);

    const [localApiStatus, setLocalApiStatus] = useState<LocalApiServerStatus>({
        enabled: false,
        running: false,
        port: DEFAULT_LOCAL_API_PORT,
        url: null,
        error: null,
    });
    const [localApiPortInput, setLocalApiPortInput] = useState(
        String(DEFAULT_LOCAL_API_PORT),
    );
    const [localApiBusy, setLocalApiBusy] = useState(false);
    const [localApiPortError, setLocalApiPortError] = useState('');
    const [networkProxyUrl, setNetworkProxyUrl] = useState(() =>
        normalizeProxyUrl(settings?.network?.proxyUrl),
    );
    const [desktopRenderingConfig, setDesktopRenderingConfigState] = useState<DesktopRenderingConfig>({
        disableHardwareAcceleration: false,
    });
    const [desktopRenderingBusy, setDesktopRenderingBusy] = useState(false);

    useEffect(() => {
        setNetworkProxyUrl(normalizeProxyUrl(settings?.network?.proxyUrl));
    }, [settings?.network?.proxyUrl]);

    const applyLocalApiStatus = useCallback((status: LocalApiServerStatus) => {
        setLocalApiStatus(status);
        setLocalApiPortInput(String(status.port || DEFAULT_LOCAL_API_PORT));
        setLocalApiPortError('');
    }, []);

    useEffect(() => {
        if (!loadEnabled || !isTauri) return;
        let cancelled = false;
        getDesktopRenderingConfig()
            .then((config) => {
                if (!cancelled) setDesktopRenderingConfigState(config);
            })
            .catch((error) => {
                if (!cancelled) reportError('Failed to read desktop rendering setting', error);
            });
        return () => {
            cancelled = true;
        };
    }, [loadEnabled, isTauri]);

    useEffect(() => {
        if (!loadEnabled || !isTauri) return;
        let cancelled = false;
        getLocalApiServerStatus()
            .then((status) => {
                if (!cancelled) applyLocalApiStatus(status);
            })
            .catch((error) => {
                if (!cancelled) {
                    setLocalApiPortError(error instanceof Error ? error.message : String(error));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [loadEnabled, applyLocalApiStatus, isTauri]);

    const onDesktopRenderingToggle = useCallback(async (disableHardwareAcceleration: boolean) => {
        if (!isTauri || desktopRenderingBusy) return;
        setDesktopRenderingBusy(true);
        try {
            const config = await setDesktopRenderingConfig({ disableHardwareAcceleration });
            setDesktopRenderingConfigState(config);
            showSaved();
        } catch (error) {
            reportError('Failed to update desktop rendering setting', error);
            showToast(error instanceof Error ? error.message : String(error), 'error');
        } finally {
            setDesktopRenderingBusy(false);
        }
    }, [desktopRenderingBusy, isTauri, showSaved, showToast]);

    const onSaveNetworkProxy = useCallback(async () => {
        const trimmedProxyUrl = normalizeProxyUrl(networkProxyUrl);
        if (!isSupportedProxyUrl(trimmedProxyUrl)) {
            showToast(t.networkProxyInvalid, 'error');
            return;
        }
        try {
            // Native sync requests read the proxy from config.toml; keep it in
            // step with the setting or they keep going out direct (#864).
            await syncNativeProxyUrl(trimmedProxyUrl);
        } catch (error) {
            reportError('Failed to apply proxy to native sync', error);
            showToast(error instanceof Error ? error.message : String(error), 'error');
            return;
        }
        await updateSettings({
            network: {
                // Empty string is an explicit clear; undefined would read as
                // "never configured" and skip the native mirror on startup.
                proxyUrl: trimmedProxyUrl,
            },
        });
        setNetworkProxyUrl(trimmedProxyUrl);
        showSaved();
    }, [networkProxyUrl, showSaved, showToast, t.networkProxyInvalid, updateSettings]);

    const onLocalApiToggle = useCallback(
        async (enabled: boolean) => {
            if (!isTauri || localApiBusy) return;
            const port = normalizeLocalApiPortInput(localApiPortInput);
            if (!port) {
                setLocalApiPortError(t.localApiPortInvalid);
                return;
            }
            setLocalApiBusy(true);
            try {
                const status = await setLocalApiServerConfig({ enabled, port });
                applyLocalApiStatus(status);
                if (enabled && !status.running && status.error) {
                    setLocalApiPortError(status.error);
                    return;
                }
                showSaved();
            } catch (error) {
                setLocalApiPortError(error instanceof Error ? error.message : String(error));
                reportError('Failed to update local API server', error);
            } finally {
                setLocalApiBusy(false);
            }
        },
        [
            applyLocalApiStatus,
            isTauri,
            localApiBusy,
            localApiPortInput,
            showSaved,
            t.localApiPortInvalid,
        ],
    );

    const onLocalApiPortCommit = useCallback(async () => {
        if (!isTauri || localApiBusy) return;
        const port = normalizeLocalApiPortInput(localApiPortInput);
        if (!port) {
            setLocalApiPortError(t.localApiPortInvalid);
            return;
        }
        if (port === localApiStatus.port) {
            setLocalApiPortError('');
            return;
        }
        setLocalApiBusy(true);
        try {
            const status = await setLocalApiServerConfig({
                enabled: localApiStatus.enabled,
                port,
            });
            applyLocalApiStatus(status);
            if (localApiStatus.enabled && !status.running && status.error) {
                setLocalApiPortError(status.error);
                return;
            }
            showSaved();
        } catch (error) {
            setLocalApiPortError(error instanceof Error ? error.message : String(error));
            reportError('Failed to update local API server port', error);
        } finally {
            setLocalApiBusy(false);
        }
    }, [
        applyLocalApiStatus,
        isTauri,
        localApiBusy,
        localApiPortInput,
        localApiStatus.enabled,
        localApiStatus.port,
        showSaved,
        t.localApiPortInvalid,
    ]);

    return {
        isTauri,
        localApiStatus,
        localApiPortInput,
        localApiBusy,
        localApiPortError,
        networkProxyUrl,
        desktopRenderingConfig,
        desktopRenderingBusy,
        onLocalApiToggle,
        onLocalApiPortInputChange: setLocalApiPortInput,
        onLocalApiPortCommit,
        onNetworkProxyUrlChange: setNetworkProxyUrl,
        onSaveNetworkProxy,
        onDesktopRenderingToggle,
    };
}
