// File Sync's folder lease on the phones (moved from React Native's lib/sync-file-lock.ts, S5):
// the native lock's token kept for the cycle, its refusals normalized, and the release-time
// identity loss told apart. React Native binds its SyncFileLock Expo module; native Android binds
// SyncFileLockCore.kt over the host's lock channel.

import { normalizeSyncFileLockError, SyncFileLockBusyError, SyncFileLockUnavailableError } from './sync-service-utils';

/** The platform's lock: an opaque token per lease. Refusals reject with the lock's coded text. */
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

/** Release consumed the native token but its final pathname/inode check proved
 * the compatibility lock was replaced. Callers that have just committed local
 * encryption material must compensate, unlike an ordinary close failure. */
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

/**
 * Android and iOS hold an unreplaceable platform authority first, then the
 * exact persistent `.mindwtr.lock` for old-client compatibility. Cross-device
 * and non-advisory providers remain protected by document CAS and transition
 * final inventory validation rather than pretending a kernel lock is distributed.
 * Elsewhere (web, tests) one in-process lease stands in.
 */
export const createMobileFileSyncLeases = (host: {
    platform(): string;
    /** The platform's lock, or null when this build lacks it (the lease then fails closed). */
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

    /** Tests: forget the in-process lease. */
    const reset = () => {
        fallbackLeaseToken = null;
    };

    return { acquire, revalidate, release, reset };
};
