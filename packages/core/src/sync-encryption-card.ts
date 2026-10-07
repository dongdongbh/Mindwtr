/**
 * Settings › Sync's encryption card: its state read, its flows (enable, change
 * passphrase, turn off, unlock), what each failure means, and the messages it
 * shows. It moved here from React Native's
 * `apps/mobile/components/settings/sync-settings-encryption-card.tsx` (the card
 * now renders from this controller) so the native apps run the same rules; each
 * host binds the sync encryption service, its random bytes and its error log.
 *
 * The passphrase fields are the card's own text; a host that draws its own
 * fields sends them with a submit (`setFields`), and nothing here stores or
 * logs them.
 */
import { generateDicewarePassphrase } from './diceware';
import { SyncCryptoUnsupportedError } from './sync-crypto';
import type { AppData } from './types';
import {
    SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE,
    SyncEncryptionTerminalError,
    isSyncEncryptionRemoteVersionUnavailableError,
    type SyncEncryptionState,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionKind,
    type SyncEncryptionTransitionProgress,
} from './sync-encryption';

type Translate = (key: string) => string;

/** Which message the card shows after a failed transition. `rotation-first` is the
 *  one terminal case with a remedy: an interrupted passphrase change left the sync
 *  location on two salts, and only re-running the change can heal it. */
export type SyncEncryptionCardError =
    | 'mismatch'
    | 'wrong-passphrase'
    | 'rotation-first'
    | 'backend-required'
    | 'backend-incompatible'
    | 'transition-incomplete'
    | 'generic';

export type SyncEncryptionCardFlow = 'none' | 'enable' | 'change' | 'disable' | 'unlock' | 'abandon';
export type SyncEncryptionCardWarning = 'cleanup-deferred' | 'file-cleanup-deferred' | 'no-encrypted-remote';
export type SyncEncryptionPassphraseField = 'current' | 'next' | 'confirm';

type TransitionOptions = { appData?: AppData | null; onProgress?: (progress: SyncEncryptionTransitionProgress) => void };

/** The sync encryption service (core's `createSyncEncryptionService`, bound by the host). */
export type SyncEncryptionCardHost = {
    getStatus(): Promise<SyncEncryptionStatus>;
    isBackendPending(): Promise<boolean>;
    enable(passphrase: string, options: TransitionOptions): Promise<void>;
    change(current: string, next: string, options: TransitionOptions): Promise<void>;
    disable(options: TransitionOptions): Promise<void>;
    provide(passphrase: string): Promise<'ok' | 'wrong-passphrase' | 'no-encrypted-remote'>;
    decline(): Promise<void>;
    /** "Abandon setup": this device drops an unfinished change, locally (sync-encryption-service.ts). */
    abandon(): Promise<unknown>;
    /** "Check this location again" for a partly encrypted location (sync-encryption-service.ts recheckPartlyEncryptedLocation). */
    recheck(): Promise<unknown>;
    isCleanupDeferredError(error: unknown): error is Error & { cleanupKind?: string; outcome?: unknown };
    randomBytes(length: number): Uint8Array;
    /** Supplies the attachment worklist; phase 2 leaves attachments plaintext without it. */
    appData(): AppData | null;
    logSettingsError(error: unknown): void;
};

export type SyncEncryptionCardState = {
    state: SyncEncryptionState | null;
    stateUnavailable: boolean;
    /** A change (enable, change, disable) is unfinished on this device: "Abandon setup" is offered. */
    incompleteTransition: boolean;
    /** The durable unfinished kind, retained for hosts that admit a selected recovery flow. */
    incompleteTransitionKind: SyncEncryptionTransitionKind | null;
    /** This device holds the location as partly encrypted (an encryption change cut off there): it syncs nothing there
     *  until "Check this location again" finds it whole. */
    partlyEncrypted: boolean;
    flow: SyncEncryptionCardFlow;
    busy: boolean;
    progress: SyncEncryptionTransitionProgress | null;
    error: SyncEncryptionCardError | null;
    warning: SyncEncryptionCardWarning | null;
    currentPassphrase: string;
    nextPassphrase: string;
    confirmPassphrase: string;
    revealed: boolean;
    generated: boolean;
    // Durable backend, not the screen's editor selection: a typed-but-unproven config
    // still runs transitions local-only, and the copy must say so (#1001).
    pendingFirstSync: boolean;
};

const INITIAL_STATE: SyncEncryptionCardState = {
    state: null,
    stateUnavailable: false,
    incompleteTransition: false,
    incompleteTransitionKind: null,
    partlyEncrypted: false,
    flow: 'none',
    busy: false,
    progress: null,
    error: null,
    warning: null,
    currentPassphrase: '',
    nextPassphrase: '',
    confirmPassphrase: '',
    revealed: false,
    generated: false,
    pendingFirstSync: false,
};

export const classifySyncEncryptionCardFailure = (error: unknown, terminal: SyncEncryptionCardError): SyncEncryptionCardError => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (message.includes('SYNC_ENCRYPTION_BACKEND_REQUIRED')) return 'backend-required';
    if (message.includes('SYNC_ENCRYPTION_TRANSITION_INCOMPLETE')) return 'transition-incomplete';
    if (message.includes(SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE)) return 'backend-incompatible';
    if (isSyncEncryptionRemoteVersionUnavailableError(error)) return 'transition-incomplete';
    if (error instanceof SyncCryptoUnsupportedError
        || error instanceof SyncEncryptionTerminalError && error.cause instanceof SyncCryptoUnsupportedError) return 'generic';
    if (/MWENC1|SYNC_ENCRYPTION|passphrase/i.test(message)) return terminal;
    return 'generic';
};

const SYNC_ENCRYPTION_CARD_ERROR_KEYS: Record<SyncEncryptionCardError, string> = {
    mismatch: 'settings.syncEncryptionErrorMismatch',
    'wrong-passphrase': 'settings.syncEncryptionErrorWrongPassphrase',
    'rotation-first': 'settings.syncEncryptionErrorRotationFirst',
    'backend-required': 'settings.syncEncryptionErrorBackendRequired',
    'backend-incompatible': 'settings.syncEncryptionErrorBackendIncompatible',
    'transition-incomplete': 'settings.syncEncryptionErrorTransitionIncomplete',
    generic: 'settings.syncEncryptionErrorGeneric',
};

/** The card's error, progress and warning lines for its state. */
export const getSyncEncryptionCardMessages = (card: Pick<SyncEncryptionCardState, 'error' | 'progress' | 'warning'>, t: Translate) => {
    const { error, progress, warning } = card;
    const errorMessage = error ? t(SYNC_ENCRYPTION_CARD_ERROR_KEYS[error]) : null;
    const progressLabel = progress
        ? `${progress.phase === 'attachments'
            ? t('settings.syncEncryptionProgressAttachments')
            : t('settings.syncEncryptionProgressDocuments')} ${progress.completed} / ${progress.total}`
        : null;
    const warningMessage = warning === 'cleanup-deferred'
        ? t('settings.syncEncryptionCleanupDeferred')
        : warning === 'file-cleanup-deferred'
            ? t('settings.syncEncryptionFileCleanupDeferred')
            : warning === 'no-encrypted-remote'
                ? t('settings.syncEncryptionNoEncryptedRemote')
                : null;
    return { errorMessage, progressLabel, warningMessage };
};

export function createSyncEncryptionCard(host: SyncEncryptionCardHost) {
    let card = INITIAL_STATE;
    const listeners = new Set<() => void>();
    const set = (patch: Partial<SyncEncryptionCardState>) => {
        card = { ...card, ...patch };
        for (const listener of listeners) listener();
    };

    // A status read that failed says nothing about the folder; reporting 'off'
    // would offer "Enable encryption" for a folder that may already be encrypted.
    // null is paired with stateUnavailable so the card can offer a safe retry
    // without guessing that encryption is off.
    const readState = async (): Promise<{
        state: SyncEncryptionState | null;
        unavailable: boolean;
        incomplete: boolean;
        incompleteKind: SyncEncryptionTransitionKind | null;
        partly: boolean;
    }> => {
        try {
            const status = await host.getStatus();
            return {
                state: status.state,
                unavailable: false,
                incomplete: Boolean(status.incompleteTransition),
                incompleteKind: status.incompleteTransition ?? null,
                partly: Boolean(status.partlyEncrypted),
            };
        } catch (failure) {
            host.logSettingsError(failure);
            return { state: null, unavailable: true, incomplete: false, incompleteKind: null, partly: false };
        }
    };

    /**
     * Reads the state and whether a durable backend exists: when the card opens,
     * and when a transport action finishes (activating a folder that already holds
     * ciphertext persists 'remote-encrypted-no-key' during the probe, and the card
     * must flip from "set a new passphrase" to "enter the existing passphrase"
     * without the user first failing an enable, #1001). The answer cancels it; its
     * `done` settles once both reads are applied.
     */
    const refresh = (): (() => void) & { done: Promise<void> } => {
        let cancelled = false;
        const read = readState().then((next) => {
            if (!cancelled) {
                set({ state: next.state, stateUnavailable: next.unavailable, incompleteTransition: next.incomplete, incompleteTransitionKind: next.incompleteKind, partlyEncrypted: next.partly });
                if (next.incomplete) set({ error: 'transition-incomplete' });
            }
        });
        const pending = host.isBackendPending()
            .then((backendPending) => {
                if (!cancelled) set({ pendingFirstSync: backendPending });
            })
            .catch((error) => host.logSettingsError(error));
        return Object.assign(() => {
            cancelled = true;
        }, { done: Promise.all([read, pending]).then(() => undefined) });
    };

    /** Retires staged plaintext without dismissing its flow or inline outcome. */
    const clearPassphrases = () => set({
        currentPassphrase: '',
        nextPassphrase: '',
        confirmPassphrase: '',
        revealed: false,
        generated: false,
    });

    const closeFlow = () => {
        set({
            flow: 'none',
            currentPassphrase: '',
            nextPassphrase: '',
            confirmPassphrase: '',
            revealed: false,
            generated: false,
            error: null,
        });
    };

    const openFlow = (next: SyncEncryptionCardFlow) => {
        closeFlow();
        set({ warning: null, flow: next });
    };

    const generate = () => {
        const phrase = generateDicewarePassphrase(undefined, host.randomBytes);
        set({
            nextPassphrase: phrase,
            confirmPassphrase: phrase,
            revealed: true,
            generated: true,
            error: null,
            warning: null,
        });
    };

    /** A typed passphrase field; typing clears the error. */
    const setField = (field: SyncEncryptionPassphraseField, value: string) => {
        set(field === 'current' ? { currentPassphrase: value } : field === 'next' ? { nextPassphrase: value } : { confirmPassphrase: value });
        set({ error: null });
    };

    const toggleRevealed = () => set({ revealed: !card.revealed });

    const run = async (operation: () => Promise<void>, terminal: SyncEncryptionCardError) => {
        set({ busy: true, error: null, progress: null });
        let succeeded = false;
        let cleanupDeferred: SyncEncryptionCardWarning | null = null;
        try {
            await operation();
            succeeded = true;
        } catch (failure) {
            host.logSettingsError(failure);
            if (host.isCleanupDeferredError(failure)) {
                succeeded = true;
                cleanupDeferred = failure.cleanupKind === 'file-lock'
                    ? 'file-cleanup-deferred'
                    : 'cleanup-deferred';
                set({ warning: cleanupDeferred });
            } else {
                set({ error: classifySyncEncryptionCardFailure(failure, terminal) });
            }
        }
        // Transitions are resumable, so a half-finished run still moved the state.
        const nextState = await readState();
        set({ state: nextState.state, stateUnavailable: nextState.unavailable, incompleteTransition: nextState.incomplete, incompleteTransitionKind: nextState.incompleteKind, partlyEncrypted: nextState.partly });
        if (nextState.incomplete) set({ error: 'transition-incomplete' });
        set({ pendingFirstSync: await host.isBackendPending().catch(() => false) });
        set({ progress: null, busy: false });
        if (succeeded) {
            closeFlow();
            if (cleanupDeferred) set({ warning: cleanupDeferred });
        }
    };

    const onProgress = (progress: SyncEncryptionTransitionProgress) => set({ progress });

    const submitEnable = () => {
        if (card.nextPassphrase !== card.confirmPassphrase) {
            set({ error: 'mismatch' });
            return Promise.resolve();
        }
        const passphrase = card.nextPassphrase;
        return run(
            () => host.enable(passphrase, { appData: host.appData(), onProgress }),
            'generic',
        );
    };

    const submitChange = () => {
        if (card.nextPassphrase !== card.confirmPassphrase) {
            set({ error: 'mismatch' });
            return Promise.resolve();
        }
        const { currentPassphrase, nextPassphrase } = card;
        return run(
            () => host.change(currentPassphrase, nextPassphrase, { appData: host.appData(), onProgress }),
            'wrong-passphrase',
        );
    };

    const submitDisable = () => run(() => host.disable({ appData: host.appData(), onProgress }), 'rotation-first');

    const submitUnlock = async () => {
        set({ busy: true, error: null, warning: null });
        let accepted = false;
        let cleanupDeferred: SyncEncryptionCardWarning | null = null;
        try {
            const outcome = await host.provide(card.currentPassphrase);
            accepted = outcome === 'ok';
            // #1138: nothing encrypted is here any more, so the lock described a location
            // this device has left behind. Core already cleared it; close the flow and say
            // what changed rather than reporting a wrong passphrase.
            if (outcome === 'no-encrypted-remote') {
                accepted = true;
                cleanupDeferred = 'no-encrypted-remote';
                set({ warning: 'no-encrypted-remote' });
            } else if (!accepted) {
                set({ error: 'wrong-passphrase' });
            }
        } catch (failure) {
            host.logSettingsError(failure);
            if (host.isCleanupDeferredError(failure)) {
                accepted = failure.outcome === 'ok';
                if (accepted) {
                    cleanupDeferred = failure.cleanupKind === 'file-lock'
                        ? 'file-cleanup-deferred'
                        : 'cleanup-deferred';
                    set({ warning: cleanupDeferred });
                } else {
                    set({ error: 'wrong-passphrase' });
                }
            } else {
                set({ error: classifySyncEncryptionCardFailure(failure, 'wrong-passphrase') });
            }
        }
        const nextState = await readState();
        set({ state: nextState.state, stateUnavailable: nextState.unavailable, incompleteTransition: nextState.incomplete, incompleteTransitionKind: nextState.incompleteKind, partlyEncrypted: nextState.partly, busy: false });
        if (accepted) {
            closeFlow();
            if (cleanupDeferred) set({ warning: cleanupDeferred });
        }
    };

    /** "Abandon setup": the unfinished change is dropped on this device only; the card reads off again. */
    const submitAbandon = () => run(async () => { await host.abandon(); }, 'generic');

    /** "Check this location again": a whole location clears the mark (the card reads it again either way). */
    const recheckLocation = () => run(async () => { await host.recheck(); }, 'generic');

    /** "Not now": keeps the persisted no-key state; sync stays paused. */
    const decline = () => {
        closeFlow();
        return host.decline()
            .catch((error) => host.logSettingsError(error))
            .then(async () => {
                const nextState = await readState();
                set({ state: nextState.state, stateUnavailable: nextState.unavailable, incompleteTransition: nextState.incomplete, incompleteTransitionKind: nextState.incompleteKind, partlyEncrypted: nextState.partly });
            });
    };

    const retryState = async () => {
        set({ busy: true });
        const nextState = await readState();
        set({ state: nextState.state, stateUnavailable: nextState.unavailable, incompleteTransition: nextState.incomplete, incompleteTransitionKind: nextState.incompleteKind, partlyEncrypted: nextState.partly, busy: false });
    };

    return {
        getState: (): SyncEncryptionCardState => card,
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        refresh,
        openFlow,
        closeFlow,
        clearPassphrases,
        generate,
        setField,
        toggleRevealed,
        submitEnable,
        submitChange,
        submitDisable,
        submitUnlock,
        submitAbandon,
        recheckLocation,
        decline,
        retryState,
    };
}

export type SyncEncryptionCard = ReturnType<typeof createSyncEncryptionCard>;
