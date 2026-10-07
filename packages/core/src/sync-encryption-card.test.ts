import { describe, expect, it } from 'vitest';
import { createSyncEncryptionCard, getSyncEncryptionCardMessages, type SyncEncryptionCardHost } from './sync-encryption-card';
import { SyncEncryptionBackendIncompatibleError, SyncEncryptionRemoteVersionUnavailableError, SyncEncryptionTerminalError, type SyncEncryptionTransitionKind } from './sync-encryption';
import { SyncCryptoUnsupportedError } from './sync-crypto';
import { SyncEncryptionCleanupDeferredError, isSyncEncryptionCleanupDeferredError } from './sync-encryption-service';

function setup(overrides: Partial<SyncEncryptionCardHost> = {}) {
    const calls: unknown[][] = [];
    let state: 'off' | 'enabled' | 'remote-encrypted-no-key' = 'off';
    let incomplete: SyncEncryptionTransitionKind | undefined;
    let partly = false;
    let found: 'plaintext' | 'encrypted' | 'mixed' = 'mixed';
    const host: SyncEncryptionCardHost = {
        getStatus: async () => ({ state, ...(incomplete ? { incompleteTransition: incomplete } : {}), ...(partly ? { partlyEncrypted: true } : {}) }),
        recheck: async () => { calls.push(['recheck']); if (found !== 'mixed') partly = false; return found; },
        isBackendPending: async () => false,
        enable: async (passphrase) => { calls.push(['enable', passphrase]); state = 'enabled'; },
        change: async () => undefined,
        disable: async () => { state = 'off'; },
        provide: async (passphrase) => (passphrase === 'right' ? 'ok' : 'wrong-passphrase'),
        decline: async () => undefined,
        abandon: async () => { calls.push(['abandon']); const kind = incomplete ?? null; incomplete = undefined; state = 'off'; return kind; },
        isCleanupDeferredError: (error): error is Error & { cleanupKind?: string } => isSyncEncryptionCleanupDeferredError(error),
        randomBytes: (length) => new Uint8Array(length).fill(3),
        appData: () => null,
        logSettingsError: () => undefined,
        ...overrides,
    };
    return {
        card: createSyncEncryptionCard(host), calls,
        setState: (next: typeof state) => { state = next; },
        setIncomplete: (next: typeof incomplete) => { incomplete = next; },
        setPartly: (next: boolean, nextFound: typeof found = 'mixed') => { partly = next; found = nextFound; },
    };
}

describe('sync encryption card', () => {
    it('refuses two different passphrases before anything runs, and enables with the typed one', async () => {
        const { card, calls } = setup();
        await card.refresh().done;
        card.openFlow('enable');
        card.setField('next', 'one');
        card.setField('confirm', 'two');
        await card.submitEnable();
        expect(card.getState()).toMatchObject({ error: 'mismatch', flow: 'enable' });
        expect(calls).toEqual([]);
        card.setField('confirm', 'one');
        expect(card.getState().error).toBeNull();
        await card.submitEnable();
        expect(calls).toEqual([['enable', 'one']]);
        expect(card.getState()).toMatchObject({ state: 'enabled', flow: 'none', nextPassphrase: '', confirmPassphrase: '', busy: false });
    });

    it('fills both new-passphrase fields from the generator and shows them', async () => {
        const { card } = setup();
        await card.refresh().done;
        card.openFlow('enable');
        card.generate();
        const { nextPassphrase, confirmPassphrase, revealed, generated } = card.getState();
        expect(nextPassphrase.split(' ').length).toBeGreaterThan(3);
        expect(confirmPassphrase).toBe(nextPassphrase);
        expect({ revealed, generated }).toEqual({ revealed: true, generated: true });
    });

    it('closes a committed transition whose cleanup was deferred, with the file-lock warning', async () => {
        const { card } = setup({
            enable: async () => { throw new SyncEncryptionCleanupDeferredError(undefined, new Error('lock'), 0, 'file-lock'); },
        });
        await card.refresh().done;
        card.openFlow('enable');
        card.setField('next', 'p');
        card.setField('confirm', 'p');
        await card.submitEnable();
        expect(card.getState()).toMatchObject({ flow: 'none', error: null, warning: 'file-cleanup-deferred' });
    });

    it('re-prompts a wrong unlock passphrase and never reports a failed state read as off', async () => {
        const { card, setState } = setup();
        setState('remote-encrypted-no-key');
        await card.refresh().done;
        card.openFlow('unlock');
        card.setField('current', 'wrong');
        await card.submitUnlock();
        expect(card.getState()).toMatchObject({ flow: 'unlock', error: 'wrong-passphrase', state: 'remote-encrypted-no-key', currentPassphrase: 'wrong' });

        const failing = setup({ getStatus: async () => { throw new Error('unreadable'); } });
        await failing.card.refresh().done;
        expect(failing.card.getState()).toMatchObject({ state: null, stateUnavailable: true });
    });

    it('clearPassphrases preserves an inline failure and flow while blanking sensitive fields', async () => {
        const { card, setState } = setup();
        setState('remote-encrypted-no-key');
        await card.refresh().done;
        card.openFlow('unlock');
        card.generate();
        card.setField('current', 'wrong');
        await card.submitUnlock();
        const before = card.getState();
        expect(before).toMatchObject({ flow: 'unlock', error: 'wrong-passphrase', currentPassphrase: 'wrong', revealed: true, generated: true });
        expect(before.nextPassphrase).not.toBe('');
        expect(before.confirmPassphrase).not.toBe('');
        card.clearPassphrases();
        expect(card.getState()).toEqual({
            ...before, currentPassphrase: '', nextPassphrase: '', confirmPassphrase: '', revealed: false, generated: false,
        });
    });

    it('clearPassphrases preserves accepted busy work and a deferred-cleanup warning', async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const supplied: string[] = [];
        const { card, setState } = setup({ provide: async (phrase) => { supplied.push(phrase); await held; return 'wrong-passphrase'; } });
        setState('remote-encrypted-no-key');
        await card.refresh().done;
        card.openFlow('unlock');
        card.setField('current', 'accepted phrase');
        const pending = card.submitUnlock();
        try {
            const before = card.getState();
            expect(before).toMatchObject({ busy: true, flow: 'unlock', currentPassphrase: 'accepted phrase' });
            card.clearPassphrases();
            expect(card.getState()).toEqual({
                ...before, currentPassphrase: '', nextPassphrase: '', confirmPassphrase: '', revealed: false, generated: false,
            });
        } finally {
            release();
            await pending;
        }
        expect(supplied).toEqual(['accepted phrase']);
        expect(card.getState()).toMatchObject({ busy: false, error: 'wrong-passphrase', flow: 'unlock', currentPassphrase: '' });

        const deferred = setup({ enable: async () => { throw new SyncEncryptionCleanupDeferredError(undefined, new Error('lock'), 0, 'file-lock'); } }).card;
        await deferred.refresh().done;
        deferred.openFlow('enable');
        deferred.setField('next', 'phrase');
        deferred.setField('confirm', 'phrase');
        await deferred.submitEnable();
        deferred.setField('current', 'later draft');
        deferred.toggleRevealed();
        const warning = deferred.getState();
        expect(warning.warning).toBe('file-cleanup-deferred');
        deferred.clearPassphrases();
        expect(deferred.getState()).toEqual({
            ...warning, currentPassphrase: '', nextPassphrase: '', confirmPassphrase: '', revealed: false, generated: false,
        });
    });

    it.each([
        new SyncCryptoUnsupportedError('Unsupported MWENC1 format_version'),
        new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError('Unsupported MWENC1 format_version')),
    ])('does not label an unsupported encrypted container as a wrong passphrase: %s', async (failure) => {
        const { card, setState } = setup({ provide: async () => { throw failure; } });
        setState('remote-encrypted-no-key');
        await card.refresh().done;
        card.openFlow('unlock');
        card.setField('current', 'right');
        await card.submitUnlock();
        expect(card.getState()).toMatchObject({
            flow: 'unlock', state: 'remote-encrypted-no-key', error: 'generic', busy: false,
        });
    });

    it('offers "Abandon setup" only while a change is unfinished, and it clears the unfinished change', async () => {
        const fresh = setup();
        await fresh.card.refresh().done;
        expect(fresh.card.getState().incompleteTransition).toBe(false);

        const { card, calls, setIncomplete } = setup();
        setIncomplete('enable');
        await card.refresh().done;
        expect(card.getState()).toMatchObject({ incompleteTransition: true, error: 'transition-incomplete' });
        card.openFlow('abandon');
        await card.submitAbandon();
        expect(calls).toEqual([['abandon']]);
        expect(card.getState()).toMatchObject({ state: 'off', flow: 'none', incompleteTransition: false, error: null, busy: false });
    });

    it('retains the durable unfinished kind across refresh, transition failure, and completion', async () => {
        const current = setup();
        current.setIncomplete('disable');
        await current.card.refresh().done;
        expect(current.card.getState()).toMatchObject({ incompleteTransition: true, incompleteTransitionKind: 'disable' });
        current.setIncomplete('enable');
        await current.card.refresh().done;
        expect(current.card.getState()).toMatchObject({ incompleteTransition: true, incompleteTransitionKind: 'enable' });

        const interrupted = setup({ enable: async () => {
            interrupted.setIncomplete('enable');
            throw new Error('interrupted');
        } });
        await interrupted.card.refresh().done;
        interrupted.card.openFlow('enable');
        interrupted.card.setField('next', 'phrase');
        interrupted.card.setField('confirm', 'phrase');
        await interrupted.card.submitEnable();
        expect(interrupted.card.getState()).toMatchObject({ state: 'off', incompleteTransition: true, incompleteTransitionKind: 'enable' });

        const completed = setup({ enable: async () => {
            completed.setIncomplete(undefined);
            completed.setState('enabled');
        } });
        completed.setIncomplete('enable');
        await completed.card.refresh().done;
        completed.card.openFlow('enable');
        completed.card.setField('next', 'phrase');
        completed.card.setField('confirm', 'phrase');
        await completed.card.submitEnable();
        expect(completed.card.getState()).toMatchObject({ state: 'enabled', incompleteTransition: false, incompleteTransitionKind: null });
    });

    it('holds a partly encrypted location until "Check this location again" finds it whole', async () => {
        const { card, calls, setPartly } = setup();
        setPartly(true, 'mixed');
        await card.refresh().done;
        expect(card.getState().partlyEncrypted).toBe(true);
        await card.recheckLocation();
        expect(calls).toEqual([['recheck']]);
        expect(card.getState()).toMatchObject({ partlyEncrypted: true, busy: false });
        setPartly(true, 'plaintext');
        await card.recheckLocation();
        expect(card.getState()).toMatchObject({ partlyEncrypted: false, busy: false, state: 'off' });
    });

    it('names a server without strong ETags as incompatible when it is refused before anything changed', async () => {
        const { card } = setup({
            enable: async () => { throw new SyncEncryptionBackendIncompatibleError(new SyncEncryptionRemoteVersionUnavailableError('WebDAV data.json')); },
        });
        await card.refresh().done;
        card.openFlow('enable');
        card.setField('next', 'p');
        card.setField('confirm', 'p');
        await card.submitEnable();
        expect(card.getState()).toMatchObject({ state: 'off', flow: 'enable', error: 'backend-incompatible', busy: false });
        expect(getSyncEncryptionCardMessages(card.getState(), (key) => key).errorMessage).toBe('settings.syncEncryptionErrorBackendIncompatible');
        // A version lost mid-transition still reads as an incomplete change, as before.
        const midway = setup({ enable: async () => { throw new SyncEncryptionRemoteVersionUnavailableError('data.json.enc'); } });
        await midway.card.refresh().done;
        midway.card.openFlow('enable');
        midway.card.setField('next', 'p');
        midway.card.setField('confirm', 'p');
        await midway.card.submitEnable();
        expect(midway.card.getState().error).toBe('transition-incomplete');
    });
});
