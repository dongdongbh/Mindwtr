import { describe, expect, it } from 'vitest';

import {
    commitProvenSyncConfiguration,
    type PersistedDesktopSyncConfiguration,
    type SyncConfigurationTransactionDependencies,
} from './sync-configuration-transaction';

const OLD_PASSWORD = 'old-webdav-password';
const OLD_TOKEN = 'old-cloud-token';
const COMMITTED_RESULT = {
    committed: true,
    cleanupPending: false,
    handleFinalized: true,
} as const;

const baselineConfiguration = (): PersistedDesktopSyncConfiguration => ({
    backend: 'cloud',
    syncPath: '',
    webdav: {
        url: 'https://old-dav.example.com',
        username: 'old-user',
        password: OLD_PASSWORD,
        passwordAuthority: 'known',
        hasPassword: true,
        allowInsecureHttp: false,
        allowWeakFingerprint: false,
    },
    cloudProvider: 'selfhosted',
    cloud: {
        url: 'https://old-cloud.example.com',
        token: OLD_TOKEN,
        tokenAuthority: 'known',
        allowInsecureHttp: false,
        rememberToken: false,
    },
});

type FailureStep = 'file' | 'webdav' | 'cloud' | 'provider' | 'backend';

const cloneConfiguration = (
    value: PersistedDesktopSyncConfiguration,
): PersistedDesktopSyncConfiguration => structuredClone(value);

const createTransactionHarness = (
    initial: PersistedDesktopSyncConfiguration,
    failureStep?: FailureStep,
    rollbackFailureStep?: Exclude<FailureStep, 'backend'>,
) => {
    const state = cloneConfiguration(initial);
    let primaryFailureInjected = false;
    let rollbackStarted = false;
    const events: string[] = [];

    const maybeFail = (step: FailureStep) => {
        if (!primaryFailureInjected && failureStep === step) {
            primaryFailureInjected = true;
            throw new Error(`injected ${step} failure`);
        }
        if (rollbackStarted && rollbackFailureStep === step) {
            throw new Error(`injected rollback ${step} failure`);
        }
    };
    const markRollback = () => {
        if (primaryFailureInjected) rollbackStarted = true;
    };

    const dependencies: SyncConfigurationTransactionDependencies = {
        recoverDropboxCredentialsBeforeConfiguration: async () => undefined,
        readConfiguration: async (requirements) => {
            events.push('read');
            markRollback();
            if (
                requirements?.requireWebdavPassword
                && state.webdav.passwordAuthority === 'opaque'
            ) {
                throw new Error('WebDAV password is unavailable');
            }
            if (
                requirements?.requireCloudToken
                && state.cloud.tokenAuthority === 'opaque'
            ) {
                throw new Error('Self-hosted token is unavailable');
            }
            return cloneConfiguration(state);
        },
        writeBackend: async (backend) => {
            events.push(`backend:${backend}`);
            markRollback();
            state.backend = backend;
            if (backend !== 'off') maybeFail('backend');
        },
        writeSyncPath: async (syncPath) => {
            events.push(`file:${syncPath || '<empty>'}`);
            markRollback();
            state.syncPath = syncPath;
            maybeFail('file');
            return { success: true, path: syncPath };
        },
        clearSyncPath: async () => {
            events.push('file:<clear>');
            markRollback();
            state.syncPath = '';
            maybeFail('file');
        },
        writeWebDav: async (webdav) => {
            events.push(`webdav:${webdav.url || '<empty>'}`);
            markRollback();
            state.webdav = { ...webdav, passwordAuthority: 'known' };
            maybeFail('webdav');
        },
        writeCloud: async (cloud) => {
            events.push(`cloud:${cloud.url || '<empty>'}`);
            markRollback();
            state.cloud = { ...cloud, tokenAuthority: 'known' };
            maybeFail('cloud');
        },
        writeCloudProvider: async (provider) => {
            events.push(`provider:${provider}`);
            markRollback();
            state.cloudProvider = provider;
            maybeFail('provider');
        },
        promoteDropboxCredentials: async (credentialHandle) => {
            events.push(`dropbox:promote:${credentialHandle}`);
        },
        discardDropboxCredentials: async (credentialHandle) => {
            events.push(`dropbox:discard:${credentialHandle}`);
        },
        rollbackDropboxCredentials: async (credentialHandle) => {
            events.push(`dropbox:rollback:${credentialHandle}`);
        },
        finalizeDropboxCredentials: async (credentialHandle) => {
            events.push(`dropbox:finalize:${credentialHandle}`);
        },
    };

    return {
        dependencies,
        events,
        getState: () => cloneConfiguration(state),
    };
};

describe('commitProvenSyncConfiguration', () => {
    it.each([
        {
            label: 'file',
            candidate: { backend: 'file' as const, syncPath: '/reloaded/file-sync' },
        },
        {
            label: 'self-hosted',
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'selfhosted' as const,
                cloud: {
                    url: 'https://reloaded-cloud.example.com',
                    token: 'replacement-token',
                },
            },
        },
    ])('settles reload-time Dropbox recovery before the first $label snapshot or write', async ({ candidate }) => {
        const initial = baselineConfiguration();
        initial.backend = 'cloud';
        initial.cloudProvider = 'dropbox';
        const harness = createTransactionHarness(initial);
        harness.dependencies.recoverDropboxCredentialsBeforeConfiguration = async () => {
            harness.events.push('dropbox:recover-before-configuration');
        };

        await expect(commitProvenSyncConfiguration(candidate, harness.dependencies)).resolves.toEqual(COMMITTED_RESULT);

        expect(harness.events[0]).toBe('dropbox:recover-before-configuration');
        expect(harness.events[1]).toBe('read');
        expect(harness.events.indexOf('dropbox:recover-before-configuration')).toBeLessThan(
            harness.events.findIndex((event) => event.startsWith('backend:')),
        );
    });

    it('aborts before every snapshot and write when reload-time Dropbox recovery fails', async () => {
        const initial = baselineConfiguration();
        initial.cloudProvider = 'dropbox';
        const harness = createTransactionHarness(initial);
        harness.dependencies.recoverDropboxCredentialsBeforeConfiguration = async () => {
            harness.events.push('dropbox:recover-before-configuration');
            throw new Error('pending Dropbox promotion could not be recovered');
        };

        await expect(commitProvenSyncConfiguration(
            { backend: 'file', syncPath: '/must-not-write' },
            harness.dependencies,
        )).rejects.toThrow('pending Dropbox promotion could not be recovered');

        expect(harness.events).toEqual(['dropbox:recover-before-configuration']);
        expect(harness.getState()).toEqual(initial);
    });

    it.each([
        {
            label: 'file',
            candidate: { backend: 'file' as const, syncPath: '/new/sync' },
        },
        {
            label: 'Dropbox',
            candidate: { backend: 'cloud' as const, cloudProvider: 'dropbox' as const },
        },
        {
            label: 'off',
            candidate: { backend: 'off' as const },
        },
    ])('commits a $label candidate without reading unrelated opaque secrets', async ({ candidate }) => {
        const initial = baselineConfiguration();
        initial.webdav = {
            ...initial.webdav,
            password: null,
            passwordAuthority: 'opaque',
            hasPassword: null,
        };
        initial.cloud = {
            ...initial.cloud,
            token: null,
            tokenAuthority: 'opaque',
        };
        const harness = createTransactionHarness(initial);

        await expect(commitProvenSyncConfiguration(candidate, harness.dependencies)).resolves.toEqual(COMMITTED_RESULT);

        expect(harness.events.some((event) => event.startsWith('webdav:'))).toBe(false);
        expect(harness.events.some((event) => event.startsWith('cloud:'))).toBe(false);
        expect(harness.getState().backend).toBe(candidate.backend);
    });

    it.each([
        {
            label: 'WebDAV',
            expectedError: /WebDAV password is unavailable/i,
            candidate: {
                backend: 'webdav' as const,
                webdav: {
                    url: 'https://new-dav.example.com',
                    username: 'new-user',
                },
            },
        },
        {
            label: 'self-hosted',
            expectedError: /Self-hosted token is unavailable/i,
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'selfhosted' as const,
                cloud: {
                    url: 'https://new-cloud.example.com',
                    token: '',
                },
            },
        },
    ])('fails a $label edit that must reuse an opaque prior secret before mutation', async ({
        candidate,
        expectedError,
    }) => {
        const initial = baselineConfiguration();
        initial.webdav = {
            ...initial.webdav,
            password: null,
            passwordAuthority: 'opaque',
            hasPassword: null,
        };
        initial.cloud = {
            ...initial.cloud,
            token: null,
            tokenAuthority: 'opaque',
        };
        const harness = createTransactionHarness(initial);

        await expect(commitProvenSyncConfiguration(candidate, harness.dependencies)).rejects.toThrow(expectedError);

        expect(harness.events).toEqual(['read', 'read']);
        expect(harness.getState()).toEqual(initial);
    });

    // #1043: on a sandbox without a Secret Service the prior secret can become
    // unreadable while its endpoint stays configured. Re-entering the secret is
    // the only recovery, so it must not be gated on reading the one it replaces.
    it.each([
        {
            label: 'WebDAV',
            candidate: {
                backend: 'webdav' as const,
                webdav: {
                    url: 'https://old-dav.example.com',
                    username: 'old-user',
                    password: 're-entered-password',
                },
            },
            expectedSecret: (state: PersistedDesktopSyncConfiguration) => state.webdav.password,
        },
        {
            label: 'self-hosted',
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'selfhosted' as const,
                cloud: {
                    url: 'https://old-cloud.example.com',
                    token: 're-entered-token',
                },
            },
            expectedSecret: (state: PersistedDesktopSyncConfiguration) => state.cloud.token,
        },
    ])('re-enters a $label secret over an opaque prior one', async ({ candidate, expectedSecret }) => {
        const initial = baselineConfiguration();
        initial.webdav = {
            ...initial.webdav,
            password: null,
            passwordAuthority: 'opaque',
            hasPassword: null,
        };
        initial.cloud = {
            ...initial.cloud,
            token: null,
            tokenAuthority: 'opaque',
        };
        const harness = createTransactionHarness(initial);

        await expect(commitProvenSyncConfiguration(candidate, harness.dependencies)).resolves.toEqual(COMMITTED_RESULT);

        const state = harness.getState();
        expect(state.backend).toBe(candidate.backend);
        expect(expectedSecret(state)).toBe(
            candidate.backend === 'webdav' ? 're-entered-password' : 're-entered-token',
        );
    });

    it.each([
        {
            label: 'WebDAV',
            candidate: {
                backend: 'webdav' as const,
                webdav: {
                    url: 'https://first-dav.example.com',
                    username: 'first-user',
                    password: 'first-password',
                },
            },
        },
        {
            label: 'self-hosted',
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'selfhosted' as const,
                cloud: {
                    url: 'https://first-cloud.example.com',
                    token: 'first-token',
                },
            },
        },
    ])('allows clean first $label setup when unrelated prior secret state is opaque', async ({ candidate }) => {
        const initial = baselineConfiguration();
        initial.backend = 'off';
        initial.webdav = {
            ...initial.webdav,
            url: '',
            username: '',
            password: null,
            passwordAuthority: 'opaque',
            hasPassword: null,
        };
        initial.cloud = {
            ...initial.cloud,
            url: '',
            token: null,
            tokenAuthority: 'opaque',
            rememberToken: false,
        };
        const harness = createTransactionHarness(initial);

        await expect(commitProvenSyncConfiguration(candidate, harness.dependencies)).resolves.toEqual(COMMITTED_RESULT);

        expect(harness.getState().backend).toBe(candidate.backend);
        expect(harness.events.filter((event) => event === 'read').length).toBeGreaterThan(1);
    });

    it.each([
        {
            label: 'WebDAV',
            candidate: {
                backend: 'webdav' as const,
                webdav: {
                    url: 'https://candidate-dav.example.com',
                    username: 'candidate-user',
                    password: 'candidate-password',
                },
            },
            makePriorOpaque: (initial: PersistedDesktopSyncConfiguration) => {
                initial.webdav = {
                    ...initial.webdav,
                    url: '',
                    username: '',
                    password: null,
                    passwordAuthority: 'opaque',
                    hasPassword: null,
                };
            },
            isRestoredEmpty: (state: PersistedDesktopSyncConfiguration) => (
                state.webdav.url === '' && state.webdav.password === ''
            ),
            requiresCandidateSecret: (requirements: { requireWebdavPassword?: boolean }) => (
                requirements.requireWebdavPassword === true
            ),
        },
        {
            label: 'self-hosted',
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'selfhosted' as const,
                cloud: {
                    url: 'https://candidate-cloud.example.com',
                    token: 'candidate-token',
                },
            },
            makePriorOpaque: (initial: PersistedDesktopSyncConfiguration) => {
                initial.cloud = {
                    ...initial.cloud,
                    url: '',
                    token: null,
                    tokenAuthority: 'opaque',
                    rememberToken: false,
                };
            },
            isRestoredEmpty: (state: PersistedDesktopSyncConfiguration) => (
                state.cloud.url === '' && state.cloud.token === ''
            ),
            requiresCandidateSecret: (requirements: { requireCloudToken?: boolean }) => (
                requirements.requireCloudToken === true
            ),
        },
    ])('uses prior secret authority when rolling back a clean opaque $label candidate', async ({
        candidate,
        makePriorOpaque,
        isRestoredEmpty,
        requiresCandidateSecret,
    }) => {
        const initial = baselineConfiguration();
        initial.backend = 'file';
        initial.syncPath = '/last-proven-file-sync';
        makePriorOpaque(initial);
        const harness = createTransactionHarness(initial, 'backend');
        const readConfiguration = harness.dependencies.readConfiguration;
        harness.dependencies.readConfiguration = async (requirements = {}) => {
            const snapshot = await readConfiguration(requirements);
            // Model a native/keyring outage: exact candidate readback works
            // while the candidate exists, but the restored empty identity is
            // still represented as opaque. Rollback must not reuse the
            // candidate's strict secret requirement.
            if (requiresCandidateSecret(requirements) && isRestoredEmpty(harness.getState())) {
                throw new Error('restored empty secret remains opaque');
            }
            return snapshot;
        };

        await expect(commitProvenSyncConfiguration(candidate, harness.dependencies)).rejects.toThrow(
            'injected backend failure',
        );

        expect(harness.getState().backend).toBe('file');
        expect(isRestoredEmpty(harness.getState())).toBe(true);
        expect(harness.events.slice(-2)).toEqual(['backend:file', 'read']);
    });

    it.each([
        {
            step: 'webdav' as const,
            candidate: {
                backend: 'webdav' as const,
                webdav: {
                    url: 'https://new-dav.example.com',
                    username: 'new-user',
                    password: 'new-webdav-password',
                },
            },
        },
        {
            step: 'cloud' as const,
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'selfhosted' as const,
                cloud: {
                    url: 'https://new-cloud.example.com',
                    token: 'new-cloud-token',
                },
            },
        },
        {
            step: 'file' as const,
            candidate: {
                backend: 'file' as const,
                syncPath: '/new/sync/path',
            },
        },
        {
            step: 'provider' as const,
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'dropbox' as const,
            },
        },
        {
            step: 'backend' as const,
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'selfhosted' as const,
                cloud: {
                    url: 'https://new-cloud.example.com',
                    token: 'new-cloud-token',
                },
            },
        },
    ])('restores the complete last-proven configuration after a $step failure', async ({ step, candidate }) => {
        const initial = baselineConfiguration();
        const harness = createTransactionHarness(initial, step);

        await expect(commitProvenSyncConfiguration(candidate, harness.dependencies))
            .rejects.toThrow(`injected ${step} failure`);

        expect(harness.getState()).toEqual(initial);
        expect(harness.events).toContain('backend:off');
        expect(harness.events.slice(-2)).toEqual([`backend:${initial.backend}`, 'read']);
    });

    it('disables an already-active matching backend before replacing its credentials', async () => {
        const initial = baselineConfiguration();
        const harness = createTransactionHarness(initial);

        await commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
            cloud: {
                url: 'https://new-cloud.example.com',
                token: 'new-cloud-token',
            },
        }, harness.dependencies);

        // One opening read: a candidate carrying its own token never needs the
        // strict re-read of the secret it is about to replace (#1043).
        expect(harness.events).toEqual([
            'read',
            'backend:off',
            'read',
            'cloud:https://new-cloud.example.com',
            'provider:selfhosted',
            'read',
            'backend:cloud',
            'read',
        ]);
        expect(harness.getState()).toMatchObject({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
            cloud: {
                url: 'https://new-cloud.example.com',
                token: 'new-cloud-token',
            },
        });
    });

    it('promotes same-provider Dropbox credentials only while the backend is durably off', async () => {
        const initial = baselineConfiguration();
        initial.cloudProvider = 'dropbox';
        const harness = createTransactionHarness(initial);

        await commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies);

        expect(harness.events).toEqual([
            'read',
            'backend:off',
            'read',
            'provider:dropbox',
            'read',
            'dropbox:promote:candidate-handle',
            'read',
            'backend:cloud',
            'read',
            'dropbox:finalize:candidate-handle',
        ]);
        expect(harness.getState()).toEqual(initial);
    });

    it('treats an uncertain finalize response after active readback as committed cleanup', async () => {
        const initial = baselineConfiguration();
        initial.backend = 'file';
        initial.syncPath = '/previous-file-sync';
        const harness = createTransactionHarness(initial);
        harness.dependencies.finalizeDropboxCredentials = async (credentialHandle) => {
            harness.events.push(`dropbox:finalize:${credentialHandle}:lost-response`);
            throw new Error('finalize response was lost');
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies)).resolves.toEqual({
            committed: true,
            cleanupPending: true,
            handleFinalized: false,
        });

        expect(harness.getState()).toMatchObject({
            backend: 'cloud',
            cloudProvider: 'dropbox',
        });
        expect(harness.events).toContain('dropbox:finalize:candidate-handle:lost-response');
        expect(harness.events).not.toContain('dropbox:rollback:candidate-handle');
        expect(harness.events.lastIndexOf('backend:file')).toBe(-1);
    });

    it('rolls promoted Dropbox credentials back before restoring and reactivating the old backend', async () => {
        const initial = baselineConfiguration();
        initial.cloudProvider = 'dropbox';
        const harness = createTransactionHarness(initial, 'backend');

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies)).rejects.toThrow('injected backend failure');

        expect(harness.getState()).toEqual(initial);
        const rollbackIndex = harness.events.indexOf('dropbox:rollback:candidate-handle');
        const restoreProviderIndex = harness.events.lastIndexOf('provider:dropbox');
        const reactivateIndex = harness.events.lastIndexOf('backend:cloud');
        expect(rollbackIndex).toBeGreaterThan(-1);
        expect(restoreProviderIndex).toBeGreaterThan(rollbackIndex);
        expect(reactivateIndex).toBeGreaterThan(restoreProviderIndex);
        expect(harness.events).not.toContain('dropbox:finalize:candidate-handle');
    });

    it('does not mutate transports or promote credentials when backend-off durability cannot be proven', async () => {
        const initial = baselineConfiguration();
        const harness = createTransactionHarness(initial);
        harness.dependencies.writeBackend = async (backend) => {
            harness.events.push(`backend:${backend}:ignored`);
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies)).rejects.toThrow(/sync backend is not durably disabled/i);

        expect(harness.getState()).toEqual(initial);
        expect(harness.events).not.toContain('provider:dropbox');
        expect(harness.events).not.toContain('dropbox:promote:candidate-handle');
        expect(harness.events).toContain('dropbox:discard:candidate-handle');
    });

    it('restores the previous configuration when the first off write commits but its readback fails', async () => {
        const initial = baselineConfiguration();
        const harness = createTransactionHarness(initial);
        const writeBackend = harness.dependencies.writeBackend;
        const readConfiguration = harness.dependencies.readConfiguration;
        let failInitialDisableRead = false;
        let offWrites = 0;

        harness.dependencies.writeBackend = async (backend) => {
            await writeBackend(backend);
            if (backend === 'off') {
                offWrites += 1;
                if (offWrites === 1) failInitialDisableRead = true;
            }
        };
        harness.dependencies.readConfiguration = async (requirements) => {
            if (failInitialDisableRead) {
                failInitialDisableRead = false;
                harness.events.push('read:initial-disable-lost-response');
                throw new Error('initial disable read response was lost');
            }
            return readConfiguration(requirements);
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies)).rejects.toThrow(/initial disable read response was lost/i);

        expect(harness.getState()).toEqual(initial);
        expect(offWrites).toBeGreaterThan(1);
        expect(harness.events).toContain('read:initial-disable-lost-response');
        expect(harness.events).toContain('dropbox:discard:candidate-handle');
        expect(harness.events).not.toContain('dropbox:promote:candidate-handle');
        expect(harness.events[harness.events.length - 2]).toBe('backend:cloud');
        expect(harness.events[harness.events.length - 1]).toBe('read');
    });

    it('restores transport state even when discarding an unpromoted candidate fails', async () => {
        const initial = baselineConfiguration();
        const harness = createTransactionHarness(initial, 'provider');
        harness.dependencies.discardDropboxCredentials = async (credentialHandle) => {
            harness.events.push(`dropbox:discard:${credentialHandle}:failed`);
            throw new Error('candidate discard failed');
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies)).rejects.toThrow(/candidate discard failed/i);

        expect(harness.getState()).toEqual(initial);
        expect(harness.events).toContain('dropbox:discard:candidate-handle:failed');
        expect(harness.events).not.toContain('dropbox:promote:candidate-handle');
    });

    it('restores transport state if disabling the backend unexpectedly mutates it', async () => {
        const initial = baselineConfiguration();
        const harness = createTransactionHarness(initial);
        const writeBackend = harness.dependencies.writeBackend;
        let corrupted = false;
        harness.dependencies.writeBackend = async (backend) => {
            await writeBackend(backend);
            if (backend === 'off' && !corrupted) {
                corrupted = true;
                const writeCloud = harness.dependencies.writeCloud;
                await writeCloud({
                    ...initial.cloud,
                    token: initial.cloud.token ?? '',
                    url: 'https://unexpected.example.com',
                });
            }
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
            cloud: {
                url: 'https://candidate.example.com',
                token: 'candidate-token',
            },
        }, harness.dependencies)).rejects.toThrow(/disabling sync changed/i);

        expect(harness.getState()).toEqual(initial);
    });

    it('rolls back when final backend activation does not persist', async () => {
        const initial = baselineConfiguration();
        initial.cloudProvider = 'dropbox';
        const harness = createTransactionHarness(initial);
        const writeBackend = harness.dependencies.writeBackend;
        let candidateActivationIgnored = false;
        harness.dependencies.writeBackend = async (backend) => {
            if (backend === 'cloud' && !candidateActivationIgnored) {
                candidateActivationIgnored = true;
                harness.events.push('backend:cloud:ignored');
                return;
            }
            await writeBackend(backend);
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies)).rejects.toThrow(/did not match the proven candidate/i);

        expect(harness.getState()).toEqual(initial);
        expect(harness.events).toContain('dropbox:rollback:candidate-handle');
        expect(harness.events).not.toContain('dropbox:finalize:candidate-handle');
    });

    it('keeps sync off when promoted Dropbox credentials cannot be rolled back', async () => {
        const initial = baselineConfiguration();
        initial.cloudProvider = 'dropbox';
        const harness = createTransactionHarness(initial, 'backend');
        harness.dependencies.rollbackDropboxCredentials = async (credentialHandle) => {
            harness.events.push(`dropbox:rollback:${credentialHandle}:failed`);
            throw new Error('credential rollback failed');
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies)).rejects.toThrow(/credentials could not be restored; sync remains disabled/i);

        expect(harness.getState().backend).toBe('off');
        expect(harness.events).toContain('dropbox:rollback:candidate-handle:failed');
        expect(harness.events[harness.events.length - 1]).toBe('read');
    });

    it('still attempts native credential rollback when backend-off readback fails', async () => {
        const initial = baselineConfiguration();
        initial.cloudProvider = 'dropbox';
        const harness = createTransactionHarness(initial, 'backend');
        const writeBackend = harness.dependencies.writeBackend;
        const readConfiguration = harness.dependencies.readConfiguration;
        let failRollbackDisableRead = false;
        harness.dependencies.writeBackend = async (backend) => {
            try {
                await writeBackend(backend);
            } catch (error) {
                failRollbackDisableRead = true;
                throw error;
            }
        };
        harness.dependencies.readConfiguration = async () => {
            if (failRollbackDisableRead) {
                failRollbackDisableRead = false;
                harness.events.push('read:rollback-disable-failed');
                throw new Error('rollback disable read failed');
            }
            return readConfiguration();
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'candidate-handle',
        }, harness.dependencies)).rejects.toThrow(/could not be durably disabled/i);

        expect(harness.getState().backend).toBe('off');
        expect(harness.events).toContain('read:rollback-disable-failed');
        expect(harness.events).toContain('dropbox:rollback:candidate-handle');
    });

    it('verifies native-style snapshots without depending on object key order', async () => {
        const harness = createTransactionHarness(baselineConfiguration());
        const readConfiguration = harness.dependencies.readConfiguration;
        harness.dependencies.readConfiguration = async () => {
            const value = await readConfiguration();
            return {
                cloud: {
                    rememberToken: value.cloud.rememberToken,
                    allowInsecureHttp: value.cloud.allowInsecureHttp,
                    token: value.cloud.token,
                    tokenAuthority: value.cloud.tokenAuthority,
                    url: value.cloud.url,
                },
                cloudProvider: value.cloudProvider,
                webdav: {
                    allowWeakFingerprint: value.webdav.allowWeakFingerprint,
                    allowInsecureHttp: value.webdav.allowInsecureHttp,
                    hasPassword: value.webdav.hasPassword,
                    password: value.webdav.password,
                    passwordAuthority: value.webdav.passwordAuthority,
                    username: value.webdav.username,
                    url: value.webdav.url,
                },
                syncPath: value.syncPath,
                backend: value.backend,
            };
        };

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
            cloud: {
                url: 'https://new-cloud.example.com',
                token: 'new-cloud-token',
            },
        }, harness.dependencies)).resolves.toEqual(COMMITTED_RESULT);

        expect(harness.getState().backend).toBe('cloud');
    });

    it('preserves a disabled weak-fingerprint override when a proven WebDAV candidate omits it', async () => {
        const initial = baselineConfiguration();
        initial.backend = 'webdav';
        initial.webdav.allowWeakFingerprint = false;
        const harness = createTransactionHarness(initial);

        await commitProvenSyncConfiguration({
            backend: 'webdav',
            webdav: {
                url: 'https://new-dav.example.com',
                username: 'alice',
                password: 'new-password',
            },
        }, harness.dependencies);

        expect(harness.getState().webdav.allowWeakFingerprint).toBe(false);
        expect(harness.getState().backend).toBe('webdav');
    });

    it('restores only the touched transport before reactivating the old backend', async () => {
        const initial: PersistedDesktopSyncConfiguration = {
            ...baselineConfiguration(),
            backend: 'webdav',
            syncPath: '',
            webdav: {
                url: 'https://old-dav.example.com',
                username: 'old-user',
                password: '',
                passwordAuthority: 'known',
                hasPassword: false,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
        };
        const harness = createTransactionHarness(initial, 'backend');

        await expect(commitProvenSyncConfiguration({
            backend: 'webdav',
            webdav: {
                url: 'https://new-dav.example.com',
                username: 'new-user',
                password: 'candidate-secret',
            },
        }, harness.dependencies)).rejects.toThrow('injected backend failure');

        expect(harness.getState()).toEqual(initial);
        expect(harness.events).not.toContain('file:<clear>');
        expect(harness.events).not.toContain('cloud:https://old-cloud.example.com');
        expect(harness.events).toContain('webdav:https://old-dav.example.com');
    });

    it('keeps sync off when rollback cannot be completely restored and verified', async () => {
        const initial = baselineConfiguration();
        const harness = createTransactionHarness(initial, 'provider', 'provider');

        await expect(commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
        }, harness.dependencies)).rejects.toThrow(/sync remains disabled/i);

        expect(harness.getState().backend).toBe('off');
        expect(harness.events[harness.events.length - 1]).toBe('backend:off');
    });
});
