


import { normalizeSyncFileLockError, SyncFileLockBusyError, SyncFileLockUnavailableError } from './sync-service-utils';


export type SyncFileLockNativePort = {
    acquireAsync(uri: string): Promise<string>;
    revalidateAsync(token: string): Promise<void>;
    releaseAsync(token: string): Promise<void>;
};

const SYNC_FILE_LOCK_IDENTITY_LOST_CODE = 'SYNC_FILE_LOCK_IDENTITY_LOST';

export type MobileFileSyncLease = {
    token: string;
    native: boolean;
};


export class SyncFileLockIdentityLostError extends SyncFileLockUnavailableError {
    constructor(cause: unknown) {
        super('Safe File Sync locking was lost because the lock identity changed.');
        this.name = 'SyncFileLockIdentityLostError';
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

const isNativeLockIdentityLoss = (error: unknown): boolean =>
    String(error ?? '').includes(SYNC_FILE_LOCK_IDENTITY_LOST_CODE)
    || /SYNC_FILE_LOCK_UNAVAILABLE:[^\n]*(?:identity|root)[^\n]*changed/i.test(String(error ?? ''));


export const createMobileFileSyncLeases = (host: {
    platform(): string;

    nativeModule(): SyncFileLockNativePort | null;
}) => {
    let fallbackLeaseToken: string | null = null;
    let fallbackLeaseSequence = 0;

    const acquire = async (syncFileUri: string): Promise<MobileFileSyncLease> => {
        const platform = host.platform();
        if (platform === 'android' || platform === 'ios') {
            const nativeModule = host.nativeModule();
            if (!nativeModule) {
                throw new SyncFileLockUnavailableError();
            }
            let token: string;
            try {
                token = await nativeModule.acquireAsync(syncFileUri);
            } catch (error) {
                throw normalizeSyncFileLockError(error);
            }
            if (!token || typeof token !== 'string') {
                throw new SyncFileLockUnavailableError();
            }
            return { token, native: true };
        }

        if (fallbackLeaseToken) {
            throw new SyncFileLockBusyError();
        }
        fallbackLeaseSequence += 1;
        fallbackLeaseToken = `mobile-process-${fallbackLeaseSequence}`;
        return { token: fallbackLeaseToken, native: false };
    };

    const revalidate = async (lease: MobileFileSyncLease): Promise<void> => {
        if (lease.native) {
            const nativeModule = host.nativeModule();
            if (!nativeModule) throw new SyncFileLockUnavailableError();
            try {
                await nativeModule.revalidateAsync(lease.token);
            } catch (error) {
                throw normalizeSyncFileLockError(error);
            }
            return;
        }
        if (fallbackLeaseToken !== lease.token) throw new SyncFileLockUnavailableError();
    };

    const release = async (lease: MobileFileSyncLease): Promise<void> => {
        if (lease.native) {
            const nativeModule = host.nativeModule();
            if (!nativeModule) {
                throw new SyncFileLockUnavailableError();
            }
            try {
                await nativeModule.releaseAsync(lease.token);
            } catch (error) {
                if (isNativeLockIdentityLoss(error)) throw new SyncFileLockIdentityLostError(error);
                throw normalizeSyncFileLockError(error);
            }
            return;
        }
        if (fallbackLeaseToken !== lease.token) {
            throw new SyncFileLockUnavailableError();
        }
        fallbackLeaseToken = null;
    };


    const reset = () => {
        fallbackLeaseToken = null;
    };

    return { acquire, revalidate, release, reset };
};
