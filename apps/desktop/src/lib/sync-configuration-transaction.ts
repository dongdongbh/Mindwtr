import type { CloudProvider } from '@mindwtr/core';

import type { CloudConfig, WebDavConfig } from './sync-attachment-backends';
import type { SyncBackend } from './sync-service-utils';

export type DesktopSyncConfigOverride = {
    backend: SyncBackend;
    syncPath?: string;
    webdav?: WebDavConfig;
    cloudProvider?: CloudProvider;
    cloud?: CloudConfig;
    /** Opaque native handle for a Dropbox OAuth result that has not replaced
     *  the durable credential bundle yet. Token bytes never enter JS. */
    dropboxCredentialHandle?: string;
};

export type SecretAuthority = 'known' | 'opaque';

export type PersistedWebDavConfiguration = Omit<WebDavConfig, 'password' | 'hasPassword'> & {
    password: string | null;
    passwordAuthority: SecretAuthority;
    hasPassword: boolean | null;
    allowInsecureHttp: boolean;
    allowWeakFingerprint: boolean;
};

export type PersistedCloudConfiguration = Omit<CloudConfig, 'token'> & {
    token: string | null;
    tokenAuthority: SecretAuthority;
    allowInsecureHttp: boolean;
    rememberToken: boolean;
};

type WritableWebDavConfiguration = Omit<PersistedWebDavConfiguration, 'password' | 'passwordAuthority' | 'hasPassword'> & {
    password: string;
    hasPassword: boolean;
};

type WritableCloudConfiguration = Omit<PersistedCloudConfiguration, 'token' | 'tokenAuthority'> & {
    token: string;
};

export type SyncConfigurationSecretRequirements = {
    requireWebdavPassword?: boolean;
    requireCloudToken?: boolean;
};

export type PersistedDesktopSyncConfiguration = {
    backend: SyncBackend;
    syncPath: string;
    webdav: PersistedWebDavConfiguration;
    cloudProvider: CloudProvider;
    cloud: PersistedCloudConfiguration;
};

export type SyncConfigurationTransactionDependencies = {
    recoverDropboxCredentialsBeforeConfiguration: () => Promise<void>;
    readConfiguration: (
        requirements?: SyncConfigurationSecretRequirements,
    ) => Promise<PersistedDesktopSyncConfiguration>;
    writeBackend: (backend: SyncBackend) => Promise<void>;
    writeSyncPath: (path: string) => Promise<{ success: boolean; path: string; error?: string }>;
    clearSyncPath: () => Promise<void>;
    writeWebDav: (config: WritableWebDavConfiguration) => Promise<void>;
    writeCloud: (config: WritableCloudConfiguration) => Promise<void>;
    writeCloudProvider: (provider: CloudProvider) => Promise<void>;
    promoteDropboxCredentials: (credentialHandle: string) => Promise<void>;
    discardDropboxCredentials: (credentialHandle: string) => Promise<void>;
    rollbackDropboxCredentials: (credentialHandle: string) => Promise<void>;
    finalizeDropboxCredentials: (credentialHandle: string) => Promise<void>;
};

export type SyncConfigurationCommitResult = {
    committed: true;
    cleanupPending: boolean;
    handleFinalized: boolean;
};

const errorMessage = (error: unknown): string => {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    const text = String(error ?? '').trim();
    return text || 'Unknown sync configuration error';
};

type TouchedTransportFields = {
    syncPath: boolean;
    webdav: boolean;
    cloud: boolean;
    cloudProvider: boolean;
};

const createTouchedTransportFields = (): TouchedTransportFields => ({
    syncPath: false,
    webdav: false,
    cloud: false,
    cloudProvider: false,
});

// The prior secret is only needed when the candidate has none of its own to
// write: `writeCandidateTransport` carries it forward. Demanding a readable
// prior for a candidate that replaces it made re-entering credentials
// impossible once the secret authority went away — the exact dead end #1043
// reported on a keyring-less sandbox ("I re-enter my username and password,
// but the error persists"). The post-write verification below still requires
// the new secret to read back exactly.
const getCandidateSecretRequirements = (
    candidate: DesktopSyncConfigOverride,
    previous: PersistedDesktopSyncConfiguration,
): SyncConfigurationSecretRequirements => ({
    requireWebdavPassword: candidate.backend === 'webdav'
        && !candidate.webdav?.password?.trim()
        && (
            previous.backend === 'webdav'
            || Boolean(previous.webdav.url.trim())
            || Boolean(previous.webdav.username.trim())
            || previous.webdav.hasPassword === true
        ),
    requireCloudToken: candidate.backend === 'cloud'
        && (candidate.cloudProvider ?? 'selfhosted') === 'selfhosted'
        && !candidate.cloud?.token?.trim()
        && (
            (previous.backend === 'cloud' && previous.cloudProvider === 'selfhosted')
            || Boolean(previous.cloud.url.trim())
            || previous.cloud.rememberToken
            || (
                previous.cloud.tokenAuthority === 'known'
                && Boolean(previous.cloud.token?.trim())
            )
        ),
});

const webdavSecretMatches = (
    actual: PersistedWebDavConfiguration,
    expected: PersistedWebDavConfiguration,
): boolean => {
    if (expected.passwordAuthority === 'opaque') return true;
    return actual.passwordAuthority === 'known'
        && actual.password === expected.password
        && actual.hasPassword === expected.hasPassword;
};

const cloudSecretMatches = (
    actual: PersistedCloudConfiguration,
    expected: PersistedCloudConfiguration,
): boolean => {
    if (expected.tokenAuthority === 'opaque') return true;
    return actual.tokenAuthority === 'known'
        && actual.token === expected.token;
};

const markChangedTransportFields = (
    actual: PersistedDesktopSyncConfiguration,
    expected: PersistedDesktopSyncConfiguration,
    touched: TouchedTransportFields,
): void => {
    if (actual.syncPath !== expected.syncPath) touched.syncPath = true;
    if (
        actual.webdav.url !== expected.webdav.url
        || actual.webdav.username !== expected.webdav.username
        || !webdavSecretMatches(actual.webdav, expected.webdav)
        || actual.webdav.allowInsecureHttp !== expected.webdav.allowInsecureHttp
        || actual.webdav.allowWeakFingerprint !== expected.webdav.allowWeakFingerprint
    ) {
        touched.webdav = true;
    }
    if (
        actual.cloud.url !== expected.cloud.url
        || !cloudSecretMatches(actual.cloud, expected.cloud)
        || actual.cloud.allowInsecureHttp !== expected.cloud.allowInsecureHttp
        || actual.cloud.rememberToken !== expected.cloud.rememberToken
    ) {
        touched.cloud = true;
    }
    if (actual.cloudProvider !== expected.cloudProvider) touched.cloudProvider = true;
};

const configurationMatches = (
    actual: PersistedDesktopSyncConfiguration,
    expected: PersistedDesktopSyncConfiguration,
): boolean => (
    actual.backend === expected.backend
    && actual.syncPath === expected.syncPath
    && actual.cloudProvider === expected.cloudProvider
    && actual.webdav.url === expected.webdav.url
    && actual.webdav.username === expected.webdav.username
    && webdavSecretMatches(actual.webdav, expected.webdav)
    && actual.webdav.allowInsecureHttp === expected.webdav.allowInsecureHttp
    && actual.webdav.allowWeakFingerprint === expected.webdav.allowWeakFingerprint
    && actual.cloud.url === expected.cloud.url
    && cloudSecretMatches(actual.cloud, expected.cloud)
    && actual.cloud.allowInsecureHttp === expected.cloud.allowInsecureHttp
    && actual.cloud.rememberToken === expected.cloud.rememberToken
);

const ensureBackendDisabled = async (
    dependencies: SyncConfigurationTransactionDependencies,
    requirements: SyncConfigurationSecretRequirements,
): Promise<PersistedDesktopSyncConfiguration> => {
    await dependencies.writeBackend('off');
    const disabled = await dependencies.readConfiguration(requirements);
    if (disabled.backend !== 'off') {
        throw new Error('Sync backend is not durably disabled');
    }
    return disabled;
};

const restoreLastProvenConfiguration = async (
    previous: PersistedDesktopSyncConfiguration,
    dependencies: SyncConfigurationTransactionDependencies,
    options: {
        reactivatePreviousBackend: boolean;
        requirements: SyncConfigurationSecretRequirements;
        touched: TouchedTransportFields;
    },
): Promise<void> => {
    const failures: string[] = [];
    const attempt = async (label: string, operation: () => Promise<unknown>) => {
        try {
            await operation();
        } catch (error) {
            failures.push(`${label}: ${errorMessage(error)}`);
        }
    };

    // Rollback itself is staged behind the same activation flag. Do not mutate
    // credentials or transports unless native persistence first proves the
    // backend is off.
    try {
        await ensureBackendDisabled(dependencies, {});
    } catch (error) {
        await attempt('keep sync disabled', () => dependencies.writeBackend('off'));
        throw new Error(
            `Previous sync settings were not restored because sync could not be durably disabled. ${errorMessage(error)}`,
        );
    }

    // Only restore fields whose candidate write was attempted. Untouched
    // opaque secret slots stay natively authoritative and are never rewritten
    // as concrete empty values.
    if (options.touched.syncPath) {
        if (previous.syncPath) {
            await attempt('restore file path', async () => {
                const result = await dependencies.writeSyncPath(previous.syncPath);
                if (!result.success) {
                    throw new Error(result.error || 'Failed to restore sync path');
                }
            });
        } else {
            await attempt('clear file path', () => dependencies.clearSyncPath());
        }
    }
    if (options.touched.webdav) {
        if (previous.webdav.passwordAuthority !== 'known' || previous.webdav.password === null) {
            const cleanOpaquePrior = previous.backend !== 'webdav'
                && !previous.webdav.url.trim()
                && !previous.webdav.username.trim()
                && previous.webdav.hasPassword !== true;
            if (!cleanOpaquePrior) {
                failures.push('restore WebDAV config: previous password is opaque');
            } else {
                await attempt('restore empty WebDAV config', () => dependencies.writeWebDav({
                    ...previous.webdav,
                    password: '',
                    hasPassword: false,
                }));
            }
        } else {
            const previousPassword = previous.webdav.password;
            await attempt('restore WebDAV config', () => dependencies.writeWebDav({
                ...previous.webdav,
                password: previousPassword,
                hasPassword: previous.webdav.hasPassword === true,
            }));
        }
    }
    if (options.touched.cloud) {
        if (previous.cloud.tokenAuthority !== 'known' || previous.cloud.token === null) {
            const cleanOpaquePrior = !(
                previous.backend === 'cloud' && previous.cloudProvider === 'selfhosted'
            )
                && !previous.cloud.url.trim()
                && !previous.cloud.rememberToken;
            if (!cleanOpaquePrior) {
                failures.push('restore cloud config: previous token is opaque');
            } else {
                await attempt('restore empty cloud config', () => dependencies.writeCloud({
                    ...previous.cloud,
                    token: '',
                }));
            }
        } else {
            const previousToken = previous.cloud.token;
            await attempt('restore cloud config', () => dependencies.writeCloud({
                ...previous.cloud,
                token: previousToken,
            }));
        }
    }
    if (options.touched.cloudProvider) {
        await attempt('restore cloud provider', () => dependencies.writeCloudProvider(previous.cloudProvider));
    }

    if (failures.length === 0) {
        await attempt('verify restored transports', async () => {
            const restored = await dependencies.readConfiguration(options.requirements);
            const expectedDisabled = { ...previous, backend: 'off' as const };
            if (!configurationMatches(restored, expectedDisabled)) {
                throw new Error('restored transport values do not match the last proven configuration');
            }
        });
    }

    if (
        failures.length === 0
        && options.reactivatePreviousBackend
        && previous.backend !== 'off'
    ) {
        await attempt('reactivate previous backend', () => dependencies.writeBackend(previous.backend));
        await attempt('verify previous backend', async () => {
            const restored = await dependencies.readConfiguration(options.requirements);
            if (!configurationMatches(restored, previous)) {
                throw new Error('reactivated configuration does not match the last proven configuration');
            }
        });
    }

    if (failures.length > 0) {
        // Never reactivate a snapshot that was only partly restored. This final
        // write is deliberately last even when an earlier disable failed.
        await attempt('keep sync disabled', () => dependencies.writeBackend('off'));
        throw new Error(`Previous sync settings could not be fully restored; sync remains disabled. ${failures.join('; ')}`);
    }
};

const writeCandidateTransport = async (
    candidate: DesktopSyncConfigOverride,
    previous: PersistedDesktopSyncConfiguration,
    dependencies: SyncConfigurationTransactionDependencies,
    touched: TouchedTransportFields,
): Promise<PersistedDesktopSyncConfiguration> => {
    if (candidate.backend === 'file') {
        touched.syncPath = true;
        const result = await dependencies.writeSyncPath(candidate.syncPath ?? '');
        if (!result.success) {
            throw new Error(result.error || 'Failed to save sync path');
        }
        return { ...previous, backend: 'off', syncPath: result.path };
    }

    if (candidate.backend === 'webdav') {
        if (!candidate.webdav) throw new Error('WebDAV configuration is required');
        const candidatePassword = candidate.webdav.password?.trim();
        if (
            previous.webdav.passwordAuthority === 'opaque'
            && !candidatePassword
        ) {
            throw new Error('A WebDAV password is required because no prior password is available');
        }
        const password = candidatePassword
            || (previous.webdav.passwordAuthority === 'known' ? previous.webdav.password : '')
            || '';
        const webdav: PersistedWebDavConfiguration = {
            ...candidate.webdav,
            password,
            passwordAuthority: 'known',
            hasPassword: Boolean(password),
            allowInsecureHttp: candidate.webdav.allowInsecureHttp
                ?? previous.webdav.allowInsecureHttp,
            allowWeakFingerprint: candidate.webdav.allowWeakFingerprint
                ?? previous.webdav.allowWeakFingerprint,
        };
        touched.webdav = true;
        await dependencies.writeWebDav({
            ...webdav,
            password,
            hasPassword: Boolean(password),
        });
        return { ...previous, backend: 'off', webdav };
    }

    if (candidate.backend === 'cloud') {
        const provider = candidate.cloudProvider ?? 'selfhosted';
        if (provider === 'selfhosted') {
            if (!candidate.cloud) throw new Error('Self-hosted configuration is required');
            const candidateToken = candidate.cloud.token?.trim();
            if (
                previous.cloud.tokenAuthority === 'opaque'
                && !candidateToken
            ) {
                throw new Error('A self-hosted token is required because no prior token is available');
            }
            const token = candidateToken
                || (previous.cloud.tokenAuthority === 'known' ? previous.cloud.token : '')
                || '';
            const cloud: PersistedCloudConfiguration = {
                ...candidate.cloud,
                token,
                tokenAuthority: 'known',
                allowInsecureHttp: candidate.cloud.allowInsecureHttp
                    ?? previous.cloud.allowInsecureHttp,
                rememberToken: candidate.cloud.rememberToken
                    ?? previous.cloud.rememberToken,
            };
            touched.cloud = true;
            await dependencies.writeCloud({ ...cloud, token });
            touched.cloudProvider = true;
            await dependencies.writeCloudProvider(provider);
            return { ...previous, backend: 'off', cloudProvider: provider, cloud };
        }
        touched.cloudProvider = true;
        await dependencies.writeCloudProvider(provider);
        return { ...previous, backend: 'off', cloudProvider: provider };
    }

    return { ...previous, backend: 'off' };
};

/**
 * Commits a transport only after its activation probe has succeeded. The
 * backend is an activation flag: an existing backend is disabled before any
 * credential/path mutation, and the prior complete snapshot is restored and
 * verified after every failed write.
 */
export async function commitProvenSyncConfiguration(
    candidate: DesktopSyncConfigOverride,
    dependencies: SyncConfigurationTransactionDependencies,
): Promise<SyncConfigurationCommitResult> {
    const credentialHandle = candidate.dropboxCredentialHandle?.trim() || null;
    if (
        credentialHandle
        && (candidate.backend !== 'cloud' || candidate.cloudProvider !== 'dropbox')
    ) {
        throw new Error('A staged Dropbox credential can only activate the Dropbox backend');
    }
    // A reload can leave a native promotion journal that changes the durable
    // provider/backend snapshot. Settle it before reading or mutating any sync
    // configuration. A current staged handle owns its own transaction instead.
    if (!credentialHandle) {
        await dependencies.recoverDropboxCredentialsBeforeConfiguration();
    }
    const tolerantPrevious = await dependencies.readConfiguration();
    const requirements = getCandidateSecretRequirements(candidate, tolerantPrevious);
    const previous = requirements.requireWebdavPassword || requirements.requireCloudToken
        ? await dependencies.readConfiguration(requirements)
        : tolerantPrevious;
    const touched = createTouchedTransportFields();
    let verificationRequirements = requirements;
    let candidateMutationStarted = false;
    let credentialPromotionAttempted = false;

    try {
        // The `off` write can commit even when its verification read (or the
        // IPC response carrying that read) fails. Mark the potential mutation
        // before awaiting so that uncertainty enters the contained rollback
        // path instead of returning as though persistence were untouched.
        candidateMutationStarted = true;
        const initialDisabled = await ensureBackendDisabled(dependencies, requirements);
        const expectedInitialDisabled = { ...previous, backend: 'off' as const };
        if (!configurationMatches(initialDisabled, expectedInitialDisabled)) {
            markChangedTransportFields(initialDisabled, expectedInitialDisabled, touched);
            throw new Error('Disabling sync changed the persisted transport configuration');
        }
        const expectedDisabled = await writeCandidateTransport(candidate, previous, dependencies, touched);
        verificationRequirements = {
            requireWebdavPassword: requirements.requireWebdavPassword || touched.webdav,
            requireCloudToken: requirements.requireCloudToken || touched.cloud,
        };
        const persistedDisabled = await dependencies.readConfiguration(verificationRequirements);
        if (!configurationMatches(persistedDisabled, expectedDisabled)) {
            throw new Error('Persisted sync settings did not match the proven candidate');
        }

        if (credentialHandle) {
            credentialPromotionAttempted = true;
            await dependencies.promoteDropboxCredentials(credentialHandle);
            const persistedAfterPromotion = await dependencies.readConfiguration(verificationRequirements);
            if (!configurationMatches(persistedAfterPromotion, expectedDisabled)) {
                throw new Error('Dropbox credentials were promoted while sync was not durably disabled');
            }
        }

        await dependencies.writeBackend(candidate.backend);
        const expectedActive = { ...expectedDisabled, backend: candidate.backend };
        const persistedActive = await dependencies.readConfiguration(verificationRequirements);
        if (!configurationMatches(persistedActive, expectedActive)) {
            throw new Error('Activated sync settings did not match the proven candidate');
        }

    } catch (commitError) {
        // A staged-but-unpromoted handle contains no durable mutation and can
        // be discarded without touching the active credential slot.
        let credentialCleanupError: unknown = null;
        if (credentialHandle && !credentialPromotionAttempted) {
            try {
                await dependencies.discardDropboxCredentials(credentialHandle);
            } catch (cleanupError) {
                credentialCleanupError = cleanupError;
            }
        }

        if (!candidateMutationStarted) {
            if (credentialCleanupError) {
                throw new Error(`${errorMessage(commitError)}. ${errorMessage(credentialCleanupError)}`);
            }
            throw commitError;
        }

        let rollbackDisableError: unknown = null;
        try {
            await ensureBackendDisabled(dependencies, {});
        } catch (disableError) {
            rollbackDisableError = disableError;
            // A failed read-back may still follow a successful `off` write.
            // Make one last best-effort write before asking native rollback,
            // whose own raw-config guard refuses to touch credentials unless
            // the backend is actually off.
            try {
                await dependencies.writeBackend('off');
            } catch (bestEffortDisableError) {
                rollbackDisableError = new Error(
                    `${errorMessage(disableError)}. ${errorMessage(bestEffortDisableError)}`,
                );
            }
        }

        let credentialRollbackError: unknown = null;
        if (credentialHandle && credentialPromotionAttempted) {
            try {
                await dependencies.rollbackDropboxCredentials(credentialHandle);
            } catch (error) {
                credentialRollbackError = error;
            }
        }

        if (rollbackDisableError) {
            const credentialDetail = credentialRollbackError
                ? ` Previous Dropbox credentials could not be restored. ${errorMessage(credentialRollbackError)}`
                : '';
            throw new Error(
                `${errorMessage(commitError)}. Sync could not be durably disabled for transport rollback; no further transport changes were attempted. ${errorMessage(rollbackDisableError)}${credentialDetail}`,
            );
        }

        try {
            await restoreLastProvenConfiguration(previous, dependencies, {
                // Reusing the old Dropbox backend is unsafe until its previous
                // credential bundle has also been restored successfully.
                reactivatePreviousBackend: credentialRollbackError === null,
                // Candidate/touched secrets require exact readback while being
                // proven, but rollback must verify against the prior snapshot's
                // own authority. A clean opaque prior remains intentionally
                // non-strict after its empty identity is restored.
                requirements,
                touched,
            });
        } catch (rollbackError) {
            const cleanupDetail = credentialCleanupError
                ? ` ${errorMessage(credentialCleanupError)}`
                : '';
            const credentialDetail = credentialRollbackError
                ? ` ${errorMessage(credentialRollbackError)}`
                : '';
            throw new Error(
                `${errorMessage(commitError)}. ${errorMessage(rollbackError)}${cleanupDetail}${credentialDetail}`,
            );
        }

        if (credentialRollbackError) {
            throw new Error(
                `${errorMessage(commitError)}. Previous Dropbox credentials could not be restored; sync remains disabled. ${errorMessage(credentialRollbackError)}`,
            );
        }
        if (credentialCleanupError) {
            throw new Error(
                `${errorMessage(commitError)}. Previous sync settings were restored, but the staged Dropbox credential could not be discarded. ${errorMessage(credentialCleanupError)}`,
            );
        }
        throw commitError;
    }

    // The exact active snapshot above is the commit point. Finalization only
    // removes the now-obsolete rollback material, so an IPC/lost-response
    // failure here must never enter the pre-commit rollback path.
    if (!credentialHandle) {
        return { committed: true, cleanupPending: false, handleFinalized: true };
    }
    try {
        await dependencies.finalizeDropboxCredentials(credentialHandle);
        return { committed: true, cleanupPending: false, handleFinalized: true };
    } catch {
        return { committed: true, cleanupPending: true, handleFinalized: false };
    }
}
