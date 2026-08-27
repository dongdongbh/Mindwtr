import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
    SyncCryptoAuthError,
    SyncEncryptionRemoteVersionUnavailableError,
    SyncEncryptionTerminalError,
    type SyncBackend,
} from '@mindwtr/core';

import { getEnglishSettingsLabels } from '../labels';
import { SyncEncryptionSection } from './SyncEncryptionSection';
import { classifyFailure, isEncryptionCapableBackend } from './useSyncEncryptionSettings';
import type { SyncEncryptionController } from './types';

const t = getEnglishSettingsLabels();

const controller = (overrides: Partial<SyncEncryptionController> = {}): SyncEncryptionController => ({
    state: 'off',
    stateUnavailable: false,
    supported: true,
    pendingFirstSync: false,
    busy: false,
    progress: null,
    error: null,
    clearError: vi.fn(),
    retryState: vi.fn(async () => undefined),
    generatePassphrase: vi.fn(() => 'gerbil unpaved trombone cameo hazily wrongdoer'),
    enable: vi.fn(async () => true),
    disable: vi.fn(async () => true),
    changePassphrase: vi.fn(async () => true),
    unlock: vi.fn(async () => true),
    decline: vi.fn(async () => undefined),
    ...overrides,
});

// The submit control repeats the button label of the action that opened the form,
// so the trailing match is always the one inside the form.
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
        // The field is still there to try again, and nothing suggests broken data.
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
        // Rotating a passphrase against a location that no longer holds ciphertext is not a remedy.
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

describe('classifyFailure', () => {
    // Only the explicit verify sentinel may blame the passphrase: by the time a
    // rotation fails, the current passphrase has already been proven (#1056).
    it('blames the passphrase only on the verify sentinel, not on rotation failures', () => {
        expect(classifyFailure(new Error('SYNC_ENCRYPTION_WRONG_PASSPHRASE'), 'generic')).toBe('wrong-passphrase');
        expect(classifyFailure(new Error('SYNC_ENCRYPTION_BACKEND_REQUIRED'), 'generic')).toBe('backend-required');
        expect(classifyFailure(
            new SyncEncryptionRemoteVersionUnavailableError('data.json has no strong ETag'),
            'generic',
        )).toBe('transition-incomplete');
        expect(
            classifyFailure(new SyncEncryptionTerminalError(new SyncCryptoAuthError()), 'generic'),
        ).toBe('generic');
        expect(classifyFailure(new Error('disk full'), 'generic')).toBe('generic');
        // Disable keeps its terminal mapping: the remedy really is rotation-first.
        expect(
            classifyFailure(new SyncEncryptionTerminalError(new SyncCryptoAuthError()), 'rotation-first'),
        ).toBe('rotation-first');
    });
});
