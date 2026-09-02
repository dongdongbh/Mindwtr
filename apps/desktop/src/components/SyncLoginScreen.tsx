import { useState, type FormEvent } from 'react';
import {
    isConnectionAllowed,
    isValidCloudSyncToken,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { SyncService, type DesktopSyncConfigOverride } from '../lib/sync-service';
import { classifySyncEncryptionFailure } from '../lib/sync-encryption-service';
import { isValidHttpUrl } from './views/settings/sync/sync-page-utils';

const ACTIVATION_PROBE_ATTEMPTS = 3;

export function SyncLoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
    const { t } = useLanguage();
    const [url, setUrl] = useState('');
    const [token, setToken] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const fail = (reason?: string) => {
        const trimmedReason = reason?.trim().slice(0, 200);
        setError(trimmedReason ? `${t('syncLogin.connectFailed')}\n${trimmedReason}` : t('syncLogin.connectFailed'));
    };

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        const trimmedUrl = url.trim();
        const trimmedToken = token.trim();

        if (!isValidHttpUrl(trimmedUrl)) {
            setError(t('settings.sync.validHttpUrl'));
            return;
        }
        if (!isConnectionAllowed(trimmedUrl, SYNC_LOCAL_INSECURE_URL_OPTIONS)) {
            setError(t('settings.syncMobile.publicHttpSyncUrlsAreBlockedUseHttpsOrEnable'));
            return;
        }
        if (!isValidCloudSyncToken(trimmedToken)) {
            setError(t('settings.sync.invalidToken'));
            return;
        }

        setError('');
        setSubmitting(true);
        try {
            const configOverride: DesktopSyncConfigOverride = {
                backend: 'cloud',
                cloudProvider: 'selfhosted',
                cloud: { url: trimmedUrl, token: trimmedToken, allowInsecureHttp: false, rememberToken: true },
            };

            let probeResult = await SyncService.performSync({
                activationProbe: true,
                configOverride,
                manual: true,
            });
            for (
                let attempt = 1;
                probeResult.skipped === 'requeued' && attempt < ACTIVATION_PROBE_ATTEMPTS;
                attempt += 1
            ) {
                probeResult = await SyncService.performSync({
                    activationProbe: true,
                    configOverride,
                    manual: true,
                });
            }

            if (probeResult.skipped === 'requeued') {
                fail(probeResult.error);
                return;
            }

            const provenEnough = probeResult.success
                || classifySyncEncryptionFailure(probeResult.error) === 'remote-encrypted-no-key';

            if (!provenEnough) {
                fail(probeResult.error);
                return;
            }

            await SyncService.commitProvenSyncConfiguration(configOverride);
            await SyncService.performSync({ manual: true, ignorePendingRemoteWriteBackoff: true });
            onLoggedIn();
        } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
            <form
                onSubmit={handleSubmit}
                className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
            >
                <h1 className="text-lg font-semibold text-foreground">{t('syncLogin.title')}</h1>

                <div className="space-y-1">
                    <label htmlFor="sync-login-url" className="text-sm font-medium text-foreground">
                        {t('settings.cloudUrl')}
                    </label>
                    <input
                        id="sync-login-url"
                        type="text"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://example.com"
                        autoComplete="username"
                        className="w-full bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                </div>

                <div className="space-y-1">
                    <label htmlFor="sync-login-token" className="text-sm font-medium text-foreground">
                        {t('settings.cloudToken')}
                    </label>
                    <input
                        id="sync-login-token"
                        type="password"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        autoComplete="current-password"
                        className="w-full bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                </div>

                {error && (
                    <p className="text-sm text-destructive whitespace-pre-line">{error}</p>
                )}

                <button
                    type="submit"
                    disabled={submitting}
                    className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                >
                    {t('syncLogin.submitButton')}
                </button>
            </form>
        </div>
    );
}
