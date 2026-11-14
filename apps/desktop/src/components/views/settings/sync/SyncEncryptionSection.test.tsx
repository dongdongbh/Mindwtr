import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
    SyncCryptoAuthError,
    SyncCryptoUnsupportedError,
    SyncEncryptionRemoteConflictError,
    SyncEncryptionBackendIncompatibleError,
    SyncEncryptionRemoteVersionUnavailableError,
    SyncEncryptionTerminalError,
    type SyncBackend,
} from '@mindwtr/core';

import { getEnglishSettingsLabels } from '../labels';
import { SyncEncryptionCleanupDeferredError } from '../../../../lib/sync-encryption-service';
import { SyncService } from '../../../../lib/sync-service';
import { SyncEncryptionSection } from './SyncEncryptionSection';
import {
    classifyFailure,
    isEncryptionCapableBackend,
    useSyncEncryptionSettings,
} from './useSyncEncryptionSettings';
import type { SyncEncryptionController } from './types';

const t = getEnglishSettingsLabels();

const controller = (overrides: Partial<SyncEncryptionController> = {}): SyncEncryptionController => ({
    state: 'off',
    stateUnavailable: false,
    incompleteTransitionKind: null,
    partlyEncrypted: false,
    supported: true,
    pendingFirstSync: false,
    busy: false,
    progress: null,
    error: null,
    warning: null,
    clearError: vi.fn(),
    clearWarning: vi.fn(),
    retryState: vi.fn(async () => undefined),
    generatePassphrase: vi.fn(() => 'gerbil unpaved trombone cameo hazily wrongdoer'),
    enable: vi.fn(async () => true),
    upgrade: vi.fn(async () => true),
    disable: vi.fn(async () => true),
    changePassphrase: vi.fn(async () => true),
    unlock: vi.fn(async () => true),
    decline: vi.fn(async () => undefined),
    ...overrides,
});


const lastButton = (name: string): HTMLElement => {
    const matches = screen.getAllByRole('button', { name });
    return matches[matches.length - 1];
};

const type = (label: string, value: string) => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('encryption-capable backends', () => {
    it.each<[SyncBackend, 'selfhosted' | 'dropbox', boolean]>([
        ['file', 'selfhosted', true],
        ['webdav', 'selfhosted', true],
        ['cloud', 'dropbox', true],
        ['cloud', 'selfhosted', false],
        ['cloudkit', 'selfhosted', false],
        ['off', 'selfhosted', false],
    ])('%s / %s -> %s', (backend, provider, expected) => {
        expect(isEncryptionCapableBackend(backend, provider)).toBe(expected);
    });
});

describe('SyncEncryptionSection', () => {
    it.each([
        ['upgrade', true], ['enable', false], ['disable', false], ['change-passphrase', false],
    ] as const)('offers upgrade only for a matching interrupted transition: %s', (incompleteTransitionKind, available) => {
        render(<SyncEncryptionSection t={t} encryption={controller({ state: 'enabled', incompleteTransitionKind })} />);
        expect(screen.queryByRole('button', { name: t.syncEncryptionUpgrade }) !== null).toBe(available);
    });

    it.each(['enabled', 'remote-encrypted-no-key'] as const)('confirms upgrade explicitly with compatibility warnings and a passphrase for %s', async (state) => {
        const encryption = controller({ state });
        render(<SyncEncryptionSection t={t} encryption={encryption} />);
        expect(encryption.upgrade).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionUpgrade }));
        expect(screen.getByText(t.syncEncryptionUpgradeWarning)).toBeTruthy();
        expect(lastButton(t.syncEncryptionUpgrade)).toBeDisabled();
        type(t.syncEncryptionCurrentPassphrase, 'synthetic phrase');
        fireEvent.click(lastButton(t.syncEncryptionUpgrade));
        await waitFor(() => expect(encryption.upgrade).toHaveBeenCalledWith('synthetic phrase'));
        expect(screen.queryByLabelText(t.syncEncryptionCurrentPassphrase)).toBeNull();
    });


    it('renders nothing for a backend that cannot be encrypted', () => {
        const { container } = render(
            <SyncEncryptionSection t={t} encryption={controller({ supported: false, state: null })} />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing until the first status read resolves', () => {
        const { container } = render(
            <SyncEncryptionSection t={t} encryption={controller({ state: null })} />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('shows a retryable recovery state when local encryption status is unavailable', () => {
        const encryption = controller({ state: null, stateUnavailable: true });
        render(<SyncEncryptionSection t={t} encryption={encryption} />);

        expect(screen.getByRole('alert')).toHaveTextContent(t.syncEncryptionStateUnavailable);
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionRetry }));
        expect(encryption.retryState).toHaveBeenCalledOnce();
    });

    it('shows both warnings before anything can be enabled', () => {
        render(<SyncEncryptionSection t={t} encryption={controller()} />);
        expect(screen.queryByText(t.syncEncryptionWarningLost)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionEnable }));

        expect(screen.getByText(t.syncEncryptionWarningLost)).toBeTruthy();
        expect(screen.getByText(t.syncEncryptionWarningDevices)).toBeTruthy();
    });

    it('enables with the typed passphrase once both fields match', async () => {
        const encryption = controller();
        render(<SyncEncryptionSection t={t} encryption={encryption} />);
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionEnable }));

        type(t.syncEncryptionPassphrase, 'first swimmer bagpipe unlisted');
        type(t.syncEncryptionPassphraseConfirm, 'first swimmer bagpipe unlisted');
        fireEvent.click(lastButton(t.syncEncryptionEnable));

        await waitFor(() => expect(encryption.enable).toHaveBeenCalledWith('first swimmer bagpipe unlisted'));
    });

    it('blocks a mismatch client-side and never calls the API', async () => {
        const encryption = controller();
        render(<SyncEncryptionSection t={t} encryption={encryption} />);
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionEnable }));

        type(t.syncEncryptionPassphrase, 'first swimmer bagpipe unlisted');
        type(t.syncEncryptionPassphraseConfirm, 'first swimmer bagpipe unlistad');
        fireEvent.click(lastButton(t.syncEncryptionEnable));

        expect(await screen.findByText(t.syncEncryptionErrorMismatch)).toBeTruthy();
        expect(encryption.enable).not.toHaveBeenCalled();
    });

    it('keeps the submit button disabled while either field is empty', () => {
        render(<SyncEncryptionSection t={t} encryption={controller()} />);
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionEnable }));

        const submit = lastButton(t.syncEncryptionEnable);
        expect(submit).toBeDisabled();

        type(t.syncEncryptionPassphrase, 'only one side');
        expect(submit).toBeDisabled();

        type(t.syncEncryptionPassphraseConfirm, 'only one side');
        expect(submit).not.toBeDisabled();
    });

    it('fills both fields from the generator and enables with the generated phrase', async () => {
        const encryption = controller();
        render(<SyncEncryptionSection t={t} encryption={encryption} />);
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionEnable }));
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionGenerate }));

        const generated = 'gerbil unpaved trombone cameo hazily wrongdoer';
        expect(screen.getByLabelText(t.syncEncryptionPassphrase)).toHaveValue(generated);
        expect(screen.getByLabelText(t.syncEncryptionPassphraseConfirm)).toHaveValue(generated);
        expect(screen.getByText(t.syncEncryptionGeneratedHint)).toBeTruthy();

        fireEvent.click(lastButton(t.syncEncryptionEnable));
        await waitFor(() => expect(encryption.enable).toHaveBeenCalledWith(generated));
    });

    it('passes both values through when changing the passphrase', async () => {
        const encryption = controller({ state: 'enabled' });
        render(<SyncEncryptionSection t={t} encryption={encryption} />);
        expect(screen.getByText(t.syncEncryptionStatusOn)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionChange }));
        type(t.syncEncryptionCurrentPassphrase, 'old phrase here');
        type(t.syncEncryptionNewPassphrase, 'new phrase here');
        type(t.syncEncryptionPassphraseConfirm, 'new phrase here');
        fireEvent.click(lastButton(t.syncEncryptionChange));

        await waitFor(() => expect(encryption.changePassphrase).toHaveBeenCalledWith('old phrase here', 'new phrase here'));
    });

    it('re-warns before turning encryption off', async () => {
        const encryption = controller({ state: 'enabled' });
        render(<SyncEncryptionSection t={t} encryption={encryption} />);

        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionDisable }));
        expect(screen.getByText(t.syncEncryptionDisableWarning)).toBeTruthy();

        fireEvent.click(lastButton(t.syncEncryptionDisable));
        await waitFor(() => expect(encryption.disable).toHaveBeenCalled());
    });

    it('explains that enabling before the first sync keeps the first upload encrypted', () => {
        render(<SyncEncryptionSection t={t} encryption={controller({ pendingFirstSync: true })} />);

        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionEnable }));
        expect(screen.getByText(t.syncEncryptionEnableBeforeFirstSyncHint)).toBeTruthy();
    });

    it('does not promise a remote decrypt when disabling with no configured backend', () => {
        render(<SyncEncryptionSection t={t} encryption={controller({ state: 'enabled', pendingFirstSync: true })} />);

        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionDisable }));
        expect(screen.getByText(t.syncEncryptionDisableWarningNoBackend)).toBeTruthy();
        expect(screen.queryByText(t.syncEncryptionDisableWarning)).toBeNull();
    });

    it('names the missing sync connection when a remote-only operation is refused', () => {
        render(<SyncEncryptionSection t={t} encryption={controller({ state: 'enabled', error: 'backend-required' })} />);
        expect(screen.getByText(t.syncEncryptionErrorBackendRequired)).toBeTruthy();
    });

    it('points a wedged disable at the passphrase change that has to finish first', () => {
        render(<SyncEncryptionSection t={t} encryption={controller({ state: 'enabled', error: 'rotation-first' })} />);
        expect(screen.getByText(t.syncEncryptionErrorRotationFirst)).toBeTruthy();
    });

    it('explains how to resume a transition whose remote version could not be verified', () => {
        render(<SyncEncryptionSection t={t} encryption={controller({ state: 'enabled', error: 'transition-incomplete' })} />);
        expect(screen.getByText(t.syncEncryptionErrorTransitionIncomplete)).toBeTruthy();
    });

    it('names an incompatible WebDAV server instead of a retry', () => {
        render(<SyncEncryptionSection t={t} encryption={controller({ state: 'off', error: 'backend-incompatible' })} />);
        expect(screen.getByText(t.syncEncryptionErrorBackendIncompatible)).toBeTruthy();
    });

    it('shows committed cleanup deferral as a non-retry status warning', () => {
        render(
            <SyncEncryptionSection
                t={t}
                encryption={controller({ state: 'enabled', warning: 'cleanup-deferred' })}
            />,
        );

        expect(screen.getByRole('status')).toHaveTextContent(t.syncEncryptionCleanupDeferred);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows transition progress while a transition runs', () => {
        render(
            <SyncEncryptionSection
                t={t}
                encryption={controller({ busy: true, progress: { phase: 'attachments', completed: 3, total: 12 } })}
            />,
        );
        expect(screen.getByRole('status').textContent).toContain(t.syncEncryptionProgressAttachments);
        expect(screen.getByRole('status').textContent).toContain('3 / 12');
    });

    it('re-prompts inline when the entered passphrase is wrong', async () => {
        const encryption = controller({ state: 'remote-encrypted-no-key', unlock: vi.fn(async () => false) });
        const { rerender } = render(<SyncEncryptionSection t={t} encryption={encryption} />);
        expect(screen.getByText(t.syncEncryptionLockedTitle)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionUnlock }));
        type(t.syncEncryptionPassphrase, 'not the right one');
        fireEvent.click(lastButton(t.syncEncryptionUnlock));
        await waitFor(() => expect(encryption.unlock).toHaveBeenCalledWith('not the right one'));

        rerender(
            <SyncEncryptionSection
                t={t}
                encryption={{ ...encryption, error: 'wrong-passphrase' }}
            />,
        );
        expect(screen.getByText(t.syncEncryptionErrorWrongPassphrase)).toBeTruthy();

        expect(screen.getByLabelText(t.syncEncryptionPassphrase)).toBeTruthy();
    });

    it('declines through the persisted API and says sync stays paused', () => {
        const encryption = controller({ state: 'remote-encrypted-no-key' });
        render(<SyncEncryptionSection t={t} encryption={encryption} />);

        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionUnlock }));
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionDecline }));

        expect(encryption.decline).toHaveBeenCalled();
        expect(screen.getByText(t.syncEncryptionPausedDesc)).toBeTruthy();
        expect(screen.queryByLabelText(t.syncEncryptionPassphrase)).toBeNull();
    });

    it('surfaces a peer-disabled sync location with the disable remedy and no passphrase change', async () => {
        const encryption = controller({ state: 'remote-plaintext' });
        render(<SyncEncryptionSection t={t} encryption={encryption} />);

        expect(screen.getByText(t.syncEncryptionRemotePlaintextDesc)).toBeTruthy();

        expect(screen.queryByRole('button', { name: t.syncEncryptionChange })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionDisable }));
        fireEvent.click(lastButton(t.syncEncryptionDisable));
        await waitFor(() => expect(encryption.disable).toHaveBeenCalled());
    });

    it('toggles passphrase visibility', () => {
        render(<SyncEncryptionSection t={t} encryption={controller()} />);
        fireEvent.click(screen.getByRole('button', { name: t.syncEncryptionEnable }));

        expect(screen.getByLabelText(t.syncEncryptionPassphrase)).toHaveAttribute('type', 'password');
        fireEvent.click(screen.getAllByRole('button', { name: t.syncEncryptionShowPassphrase })[0]);
        expect(screen.getByLabelText(t.syncEncryptionPassphrase)).toHaveAttribute('type', 'text');
    });
});

describe('useSyncEncryptionSettings cleanup outcome', () => {
    it('refreshes and reports success when the transition committed but lock cleanup was deferred', async () => {
        const status = vi.spyOn(SyncService, 'getSyncEncryptionStatus')
            .mockResolvedValueOnce({ state: 'off' })
            .mockResolvedValue({ state: 'enabled', kdfParams: { mKib: 64, t: 1, p: 1 } });
        const cleanupError = new SyncEncryptionCleanupDeferredError(undefined, new Error('release failed'), 12_000);
        const enable = vi.spyOn(SyncService, 'enableSyncEncryption').mockRejectedValueOnce(cleanupError);
        const { result, unmount } = renderHook(() => useSyncEncryptionSettings(
            'webdav',
            'selfhosted',
            'webdav',
            'selfhosted',
        ));
        await waitFor(() => expect(result.current.state).toBe('off'));

        let succeeded = false;
        await act(async () => {
            succeeded = await result.current.enable('correct horse battery');
        });

        expect(succeeded).toBe(true);
        expect(result.current.state).toBe('enabled');
        expect(result.current.warning).toBe('cleanup-deferred');
        expect(result.current.error).toBeNull();
        enable.mockRestore();
        status.mockRestore();
        unmount();
    });
});

describe('useSyncEncryptionSettings unfinished change', () => {
    it.each([
        [new Error('Remote sync mutation fence validation failed: WebDAV File GET failed (503)'), 'enable', 'transition-incomplete'],
        [new Error('Remote sync mutation fencing requires a valid provider Date response header'), undefined, 'generic'],
        [new Error('SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE: no strong ETag'), 'enable', 'backend-incompatible'],
    ] as const)('names a generic failure that leaves the change unfinished as unfinished (%s)', async (failure, left, expected) => {
        const status = vi.spyOn(SyncService, 'getSyncEncryptionStatus').mockResolvedValueOnce({ state: 'off' })
            .mockResolvedValue({ state: 'off', ...(left ? { incompleteTransition: left } : {}) });
        const enable = vi.spyOn(SyncService, 'enableSyncEncryption').mockRejectedValue(failure);
        try {
            const { result } = renderHook(() => useSyncEncryptionSettings('webdav', 'selfhosted', 'webdav', 'selfhosted'));
            await waitFor(() => expect(result.current.state).toBe('off'));
            await act(async () => { expect(await result.current.enable('synthetic phrase')).toBe(false); });
            expect(result.current.error).toBe(expected);
        } finally {
            status.mockRestore();
            enable.mockRestore();
        }
    });
});

describe('upgrade failure classification through the desktop service', () => {
    it.each([
        [new SyncCryptoAuthError(), 'wrong-passphrase'],
        [new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError('corrupt header')), 'generic'],
        [new SyncEncryptionRemoteConflictError(), 'transition-incomplete'],
        [new Error('network unavailable'), 'generic'],
    ] as const)('keeps %s distinct from an incorrect passphrase', async (failure, expected) => {
        const status = vi.spyOn(SyncService, 'getSyncEncryptionStatus').mockResolvedValue({ state: 'enabled' });
        const upgrade = vi.spyOn(SyncService, 'upgradeSyncEncryption').mockRejectedValue(failure);
        try {
            const { result } = renderHook(() => useSyncEncryptionSettings('webdav', 'selfhosted', 'webdav', 'selfhosted'));
            await waitFor(() => expect(result.current.state).toBe('enabled'));
            await act(async () => { expect(await result.current.upgrade('synthetic phrase')).toBe(false); });
            expect(result.current.error).toBe(expected);
            expect(upgrade).toHaveBeenCalledWith('synthetic phrase', expect.any(Function));
        } finally {
            status.mockRestore();
            upgrade.mockRestore();
        }
    });
});

describe('classifyFailure', () => {


    it('blames the passphrase only on the verify sentinel, not on rotation failures', () => {
        expect(classifyFailure(new Error('SYNC_ENCRYPTION_WRONG_PASSPHRASE'), 'generic')).toBe('wrong-passphrase');
        expect(classifyFailure(new Error('SYNC_ENCRYPTION_BACKEND_REQUIRED'), 'generic')).toBe('backend-required');
        expect(classifyFailure(
            new SyncEncryptionRemoteVersionUnavailableError('data.json has no strong ETag'),
            'generic',
        )).toBe('transition-incomplete');

        expect(classifyFailure(
            new SyncEncryptionBackendIncompatibleError(new SyncEncryptionRemoteVersionUnavailableError('WebDAV data.json')),
            'generic',
        )).toBe('backend-incompatible');
        expect(
            classifyFailure(new SyncEncryptionTerminalError(new SyncCryptoAuthError()), 'generic'),
        ).toBe('generic');
        expect(classifyFailure(new Error('disk full'), 'generic')).toBe('generic');

        expect(
            classifyFailure(new SyncEncryptionTerminalError(new SyncCryptoAuthError()), 'rotation-first'),
        ).toBe('rotation-first');
    });
});

describe('useSyncEncryptionSettings transport refresh (#1001)', () => {
    it('re-reads state on the falling edge of a transport action', async () => {
        const status = vi.spyOn(SyncService, 'getSyncEncryptionStatus')
            .mockResolvedValueOnce({ state: 'off' })
            .mockResolvedValue({ state: 'remote-encrypted-no-key' });
        const { result, rerender, unmount } = renderHook(
            ({ busy }: { busy: boolean }) => useSyncEncryptionSettings('webdav', 'selfhosted', 'webdav', 'selfhosted', busy),
            { initialProps: { busy: false } },
        );
        await waitFor(() => expect(result.current.state).toBe('off'));


        rerender({ busy: true });
        rerender({ busy: false });
        await waitFor(() => expect(result.current.state).toBe('remote-encrypted-no-key'));

        status.mockRestore();
        unmount();
    });
});
