import { useCallback, useEffect, useRef, useState } from 'react';

import {
    generateDicewarePassphrase,
    isSyncEncryptionRemoteVersionUnavailableError,
    SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE,
    type SyncBackend,
    type SyncEncryptionTransitionProgress,
    type SyncEncryptionTransitionKind,
} from '@mindwtr/core';

import { logError } from '../../../../lib/app-log';
import { classifySyncEncryptionUpgradeFailure } from '@mindwtr/core/sync-encryption-card';
import {
    isSyncEncryptionCleanupDeferredError,
    isSyncEncryptionFailure,
} from '../../../../lib/sync-encryption-service';
import { SyncService } from '../../../../lib/sync-service';
import type {
    CloudProvider,
    SyncEncryptionController,
    SyncEncryptionErrorKind,
    SyncEncryptionWarningKind,
} from './types';


export const isEncryptionCapableBackend = (backend: SyncBackend, cloudProvider: CloudProvider): boolean => (
    backend === 'file' || backend === 'webdav' || (backend === 'cloud' && cloudProvider === 'dropbox')
);


export const classifyFailure = (error: unknown, terminal: SyncEncryptionErrorKind): SyncEncryptionErrorKind => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (message.includes('SYNC_ENCRYPTION_LEGACY')) return 'legacy-upgrade-required';
    if (message.includes('SYNC_ENCRYPTION_RECONCILIATION_REQUIRED')) return 'reconciliation-required';
    if (message.includes('SYNC_ENCRYPTION_TRUSTED_LOCAL_REQUIRED')) return 'trusted-local-required';
    if (message.includes('SYNC_ENCRYPTION_WRONG_PASSPHRASE')) return 'wrong-passphrase';
    if (message.includes('SYNC_ENCRYPTION_BACKEND_REQUIRED')) return 'backend-required';
    if (message.includes(SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE)) return 'backend-incompatible';
    if (isSyncEncryptionRemoteVersionUnavailableError(error)) return 'transition-incomplete';
    return isSyncEncryptionFailure(error) ? terminal : 'generic';
};

export function useSyncEncryptionSettings(
    syncBackend: SyncBackend,
    cloudProvider: CloudProvider,
    persistedSyncBackend: SyncBackend,
    persistedCloudProvider: CloudProvider,


    transportBusy = false,
): SyncEncryptionController {
    const supported = isEncryptionCapableBackend(syncBackend, cloudProvider);


    const pendingFirstSync = !isEncryptionCapableBackend(persistedSyncBackend, persistedCloudProvider);
    const [state, setState] = useState<SyncEncryptionController['state']>(null);
    const [stateUnavailable, setStateUnavailable] = useState(false);
    const [incompleteTransitionKind, setIncompleteTransitionKind] = useState<SyncEncryptionTransitionKind | null>(null);
    const [partlyEncrypted, setPartlyEncrypted] = useState(false);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<SyncEncryptionTransitionProgress | null>(null);
    const [error, setError] = useState<SyncEncryptionErrorKind | null>(null);
    const [warning, setWarning] = useState<SyncEncryptionWarningKind | null>(null);


    const readState = useCallback(async (): Promise<SyncEncryptionController['state']> => {
        try {
            const status = await SyncService.getSyncEncryptionStatus();
            setIncompleteTransitionKind(status.incompleteTransition ?? null);
            setPartlyEncrypted(Boolean(status.partlyEncrypted));
            if (status.incompleteTransition) setError((current) => current ?? 'transition-incomplete');
            return status.state;
        } catch (failure) {
            void logError(failure, { scope: 'sync-encryption', step: 'status' });
            return null;
        }
    }, []);

    useEffect(() => {
        if (!supported) {
            setState(null);
            setStateUnavailable(false);
            return;
        }
        let cancelled = false;
        void readState().then((next) => {
            if (!cancelled) {
                setState(next);
                setStateUnavailable(next === null);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [readState, supported]);


    const previousTransportBusy = useRef(transportBusy);
    useEffect(() => {
        const wasBusy = previousTransportBusy.current;
        previousTransportBusy.current = transportBusy;
        if (!wasBusy || transportBusy || !supported) return;
        let cancelled = false;
        void readState().then((next) => {
            if (!cancelled) {
                setState(next);
                setStateUnavailable(next === null);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [transportBusy, readState, supported]);

    const run = useCallback(async (
        operation: (onProgress: (value: SyncEncryptionTransitionProgress) => void) => Promise<void>,
        terminal: SyncEncryptionErrorKind,
        classify?: (error: unknown) => SyncEncryptionErrorKind | null,
    ): Promise<boolean> => {
        setBusy(true);
        setError(null);
        setWarning(null);
        setProgress(null);
        let succeeded = false;
        try {
            await operation(setProgress);
            succeeded = true;
        } catch (failure) {
            void logError(failure, { scope: 'sync-encryption', step: 'transition' });
            if (isSyncEncryptionCleanupDeferredError(failure)) {
                succeeded = true;
                setWarning('cleanup-deferred');
            } else {
                setError(classify?.(failure) ?? classifyFailure(failure, terminal));
            }
        }


        const nextState = await readState();
        setState(nextState);
        setStateUnavailable(nextState === null);
        setProgress(null);
        setBusy(false);
        return succeeded;
    }, [readState]);

    const enable = useCallback((passphrase: string) => run(
        (onProgress) => SyncService.enableSyncEncryption(passphrase, onProgress),
        'generic',
    ), [run]);

    const upgrade = useCallback((passphrase: string) => run(
        (onProgress) => SyncService.upgradeSyncEncryption(passphrase, onProgress),
        'generic',
        classifySyncEncryptionUpgradeFailure,
    ), [run]);

    const disable = useCallback(() => run(
        (onProgress) => SyncService.disableSyncEncryption(onProgress),
        'rotation-first',
    ), [run]);

    const changePassphrase = useCallback((current: string, next: string) => run(
        (onProgress) => SyncService.changeSyncEncryptionPassphrase(current, next, onProgress),
        'generic',
    ), [run]);

    const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
        setBusy(true);
        setError(null);
        setWarning(null);
        let accepted = false;
        try {
            const outcome = await SyncService.provideSyncEncryptionPassphrase(passphrase);
            accepted = outcome === 'ok';


            if (outcome === 'no-encrypted-remote') {
                accepted = true;
                setWarning('no-encrypted-remote');
            } else if (!accepted) {
                setError('wrong-passphrase');
            }
        } catch (failure) {
            void logError(failure, { scope: 'sync-encryption', step: 'unlock' });
            if (isSyncEncryptionCleanupDeferredError(failure)) {
                accepted = failure.outcome === 'ok';
                if (accepted) setWarning('cleanup-deferred');
                else setError('wrong-passphrase');
            } else {
                setError(classifyFailure(failure, 'wrong-passphrase'));
            }
        }
        const nextState = await readState();
        setState(nextState);
        setStateUnavailable(nextState === null);
        setBusy(false);
        return accepted;
    }, [readState]);

    const decline = useCallback(async () => {
        try {
            await SyncService.declineSyncEncryptionPassphrase();
        } catch (failure) {
            void logError(failure, { scope: 'sync-encryption', step: 'decline' });
        }
        const nextState = await readState();
        setState(nextState);
        setStateUnavailable(nextState === null);
    }, [readState]);

    const retryState = useCallback(async () => {
        setBusy(true);
        const nextState = await readState();
        setState(nextState);
        setStateUnavailable(nextState === null);
        setBusy(false);
    }, [readState]);

    return {
        state,
        stateUnavailable,
        incompleteTransitionKind,
        partlyEncrypted,
        supported,
        pendingFirstSync,
        busy,
        progress,
        error,
        warning,
        clearError: useCallback(() => setError(null), []),
        clearWarning: useCallback(() => setWarning(null), []),
        retryState,
        generatePassphrase: useCallback(() => generateDicewarePassphrase(), []),
        enable,
        upgrade,
        disable,
        changePassphrase,
        unlock,
        decline,
    };
}
