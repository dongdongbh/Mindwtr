import { describe, expect, it } from 'vitest';
import { createSyncEncryptionCard, getSyncEncryptionCardMessages, isSyncEncryptionUpgradeAvailable, type SyncEncryptionCardHost } from './sync-encryption-card';
import { SyncEncryptionBackendIncompatibleError, SyncEncryptionRemoteConflictError, SyncEncryptionRemoteVersionUnavailableError, SyncEncryptionTerminalError, type SyncEncryptionTransitionKind } from './sync-encryption';
import { SyncCryptoAuthError, SyncCryptoUnsupportedError } from './sync-crypto';
import { SyncEncryptionCleanupDeferredError, isSyncEncryptionCleanupDeferredError } from './sync-encryption-service';
import { SyncRemoteMutationFenceUnavailableError } from './sync-remote-fence';

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
        upgrade: async () => undefined,
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
    it.each([
        [null, true], ['upgrade', true], ['enable', false], ['disable', false], ['change-passphrase', false],
    ] as const)('offers only a new or interrupted upgrade when transition is %s', (incompleteTransitionKind, expected) => {
        expect(isSyncEncryptionUpgradeAvailable({ state: 'enabled', partlyEncrypted: false, incompleteTransitionKind })).toBe(expected);
        expect(isSyncEncryptionUpgradeAvailable({ state: 'remote-encrypted-no-key', partlyEncrypted: false, incompleteTransitionKind })).toBe(expected);
    });


    it('upgrades only after an explicit flow and passes no UI snapshot as trusted data', async () => {
        const requests: unknown[][] = [];
        const { card, setState } = setup({
            upgrade: async (...args) => { requests.push(args); },
            appData: () => { throw new Error('An upgrade must read the durable local copy in its service'); },
        });
        setState('enabled');
        await card.refresh().done;
        card.setField('current', 'synthetic phrase');
        await card.submitUpgrade();
        expect(requests).toEqual([]);
        card.openFlow('upgrade');
        card.setField('current', 'synthetic phrase');
        await card.submitUpgrade();
        expect(requests).toEqual([['synthetic phrase', { onProgress: expect.any(Function) }]]);
        expect(card.getState()).toMatchObject({ flow: 'none', currentPassphrase: '', busy: false });
    });

    it.each([
        ['SYNC_ENCRYPTION_LEGACY', 'legacy-upgrade-required', 'settings.syncEncryptionErrorLegacy'],
        ['SYNC_ENCRYPTION_RECONCILIATION_REQUIRED', 'reconciliation-required', 'settings.syncEncryptionErrorReconciliation'],
        ['SYNC_ENCRYPTION_TRUSTED_LOCAL_REQUIRED', 'trusted-local-required', 'settings.syncEncryptionErrorTrustedLocal'],
    ] as const)('keeps %s actionable without calling it a wrong passphrase', async (code, error, label) => {
        const { card, setState } = setup({ provide: async () => { throw new Error(code); } });
        setState('remote-encrypted-no-key');
        await card.refresh().done;
        card.openFlow('unlock');
        card.setField('current', 'synthetic phrase');
        await card.submitUnlock();
        expect(card.getState().error).toBe(error);
        expect(getSyncEncryptionCardMessages(card.getState(), (key) => key).errorMessage).toBe(label);
    });

    it.each([
        [new SyncCryptoAuthError(), 'wrong-passphrase'],
        [new SyncEncryptionTerminalError(new SyncCryptoAuthError()), 'wrong-passphrase'],
        [new SyncCryptoUnsupportedError('unsupported format'), 'generic'],
        [new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError('corrupt header')), 'generic'],
        [new SyncEncryptionRemoteConflictError(), 'transition-incomplete'],
        [new Error('network unavailable'), 'generic'],
        [new Error('MWENC1 corrupt header'), 'generic'],
    ] as const)('classifies an upgrade failure %s without blaming unrelated failures on the passphrase', async (failure, error) => {
        const { card, setState } = setup({ upgrade: async () => { throw failure; } });
        setState('enabled');
        await card.refresh().done;
        card.openFlow('upgrade');
        card.setField('current', 'synthetic phrase');
        await card.submitUpgrade();
        expect(card.getState()).toMatchObject({ error, flow: 'upgrade', busy: false });
    });

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
        expect(interrupted.card.getState()).toMatchObject({ state: 'off', incompleteTransition: true, incompleteTransitionKind: 'enable', error: 'transition-incomplete' });

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

    it('names an enable cut off by a lost remote fence as unfinished, as the card reads it after a refresh', async () => {
        const cut = setup({ enable: async () => {
            cut.setIncomplete('enable');
            throw new SyncRemoteMutationFenceUnavailableError('Remote sync mutation fence validation failed: WebDAV File GET failed (503)');
        } });
        await cut.card.refresh().done;
        cut.card.openFlow('enable');
        cut.card.setField('next', 'p');
        cut.card.setField('confirm', 'p');
        await cut.card.submitEnable();
        expect(cut.card.getState()).toMatchObject({ incompleteTransition: true, error: 'transition-incomplete', busy: false });
        expect(getSyncEncryptionCardMessages(cut.card.getState(), (key) => key).errorMessage).toBe('settings.syncEncryptionErrorTransitionIncomplete');
        await cut.card.refresh().done;
        expect(cut.card.getState().error).toBe('transition-incomplete');

        const refused = setup({ enable: async () => { throw new SyncRemoteMutationFenceUnavailableError('Remote sync mutation fencing requires a valid provider Date response header'); } });
        await refused.card.refresh().done;
        refused.card.openFlow('enable');
        refused.card.setField('next', 'p');
        refused.card.setField('confirm', 'p');
        await refused.card.submitEnable();
        expect(refused.card.getState()).toMatchObject({ incompleteTransition: false, error: 'generic' });
    });

    it('keeps a specific error when the failed change is left unfinished, after the failure and after a refresh', async () => {
        const refused = setup({ enable: async () => {
            refused.setIncomplete('enable');
            throw new SyncEncryptionBackendIncompatibleError(new SyncEncryptionRemoteVersionUnavailableError('WebDAV data.json'));
        } });
        await refused.card.refresh().done;
        refused.card.openFlow('enable');
        refused.card.setField('next', 'p');
        refused.card.setField('confirm', 'p');
        await refused.card.submitEnable();
        expect(refused.card.getState()).toMatchObject({ incompleteTransition: true, error: 'backend-incompatible' });
        await refused.card.refresh().done;
        expect(refused.card.getState()).toMatchObject({ incompleteTransition: true, error: 'backend-incompatible' });

        const wrong = setup({ upgrade: async () => {
            wrong.setIncomplete('upgrade');
            throw new SyncCryptoAuthError();
        } });
        wrong.setState('enabled');
        await wrong.card.refresh().done;
        wrong.card.openFlow('upgrade');
        wrong.card.setField('current', 'synthetic phrase');
        await wrong.card.submitUpgrade();
        expect(wrong.card.getState()).toMatchObject({ incompleteTransition: true, error: 'wrong-passphrase' });
        await wrong.card.refresh().done;
        expect(wrong.card.getState()).toMatchObject({ incompleteTransition: true, error: 'wrong-passphrase' });
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

        const midway = setup({ enable: async () => { throw new SyncEncryptionRemoteVersionUnavailableError('data.json.enc'); } });
        await midway.card.refresh().done;
        midway.card.openFlow('enable');
        midway.card.setField('next', 'p');
        midway.card.setField('confirm', 'p');
        await midway.card.submitEnable();
        expect(midway.card.getState().error).toBe('transition-incomplete');
    });
});
