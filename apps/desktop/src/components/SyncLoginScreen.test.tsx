import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SyncLoginScreen } from './SyncLoginScreen';
import { LanguageProvider } from '../contexts/language-context';
import { SyncService } from '../lib/sync-service';

const renderScreen = (onLoggedIn: () => void) => render(
    <LanguageProvider><SyncLoginScreen onLoggedIn={onLoggedIn} /></LanguageProvider>,
);

const VALID_TOKEN = 'a-valid-token-that-is-long-enough-000';

const fillAndSubmit = (url: string, token: string) => {
    fireEvent.change(screen.getByLabelText('Self-hosted URL'), { target: { value: url } });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('SyncLoginScreen', () => {
    it('rejects an invalid URL without calling the sync service', () => {
        const onLoggedIn = vi.fn();
        const performSync = vi.spyOn(SyncService, 'performSync');
        renderScreen(onLoggedIn);

        fillAndSubmit('not-a-url', VALID_TOKEN);

        expect(screen.getByText('Enter a valid http(s) URL.')).toBeInTheDocument();
        expect(performSync).not.toHaveBeenCalled();
        expect(onLoggedIn).not.toHaveBeenCalled();
    });

    it('rejects a malformed token without calling the sync service', () => {
        const onLoggedIn = vi.fn();
        const performSync = vi.spyOn(SyncService, 'performSync');
        renderScreen(onLoggedIn);

        fillAndSubmit('https://cloud.example.com', 'short');

        expect(screen.getByText(/20-512 characters/)).toBeInTheDocument();
        expect(performSync).not.toHaveBeenCalled();
        expect(onLoggedIn).not.toHaveBeenCalled();
    });

    it('commits config and calls onLoggedIn after a successful probe', async () => {
        const onLoggedIn = vi.fn();
        const performSync = vi.spyOn(SyncService, 'performSync').mockResolvedValue({ success: true });
        const commit = vi.spyOn(SyncService, 'commitProvenSyncConfiguration').mockResolvedValue({
            cleanupPending: false,
        } as never);
        renderScreen(onLoggedIn);

        fillAndSubmit('https://cloud.example.com', VALID_TOKEN);

        await waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
        expect(commit).toHaveBeenCalledWith({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
            cloud: { url: 'https://cloud.example.com', token: VALID_TOKEN, allowInsecureHttp: false, rememberToken: true },
        });
        // Activation probe, then the real post-commit sync.
        expect(performSync).toHaveBeenCalledTimes(2);
        expect(performSync).toHaveBeenNthCalledWith(2, { manual: true, ignorePendingRemoteWriteBackoff: true });
    });

    it('commits config when the probe only finds an encrypted remote with no local key', async () => {
        const onLoggedIn = vi.fn();
        vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: false,
            error: 'SYNC_ENCRYPTION_REMOTE_ENCRYPTED',
        });
        const commit = vi.spyOn(SyncService, 'commitProvenSyncConfiguration').mockResolvedValue({
            cleanupPending: false,
        } as never);
        renderScreen(onLoggedIn);

        fillAndSubmit('https://cloud.example.com', VALID_TOKEN);

        await waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it('retries a requeued probe up to 3 attempts, then shows an error without committing', async () => {
        const onLoggedIn = vi.fn();
        const performSync = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
            skipped: 'requeued',
        });
        const commit = vi.spyOn(SyncService, 'commitProvenSyncConfiguration');
        renderScreen(onLoggedIn);

        fillAndSubmit('https://cloud.example.com', VALID_TOKEN);

        await waitFor(() => expect(performSync).toHaveBeenCalledTimes(3));
        expect(commit).not.toHaveBeenCalled();
        expect(onLoggedIn).not.toHaveBeenCalled();
        expect(screen.getByText(/Couldn't connect/)).toBeInTheDocument();
    });

    it('treats a pendingRemoteWriteBackoff skip as a failure without retrying', async () => {
        const onLoggedIn = vi.fn();
        // success:true, but decided from local backoff state without any network
        // call, so it proves nothing about these credentials.
        const performSync = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
            skipped: 'pendingRemoteWriteBackoff',
            remoteWriteDeferred: true,
        });
        const commit = vi.spyOn(SyncService, 'commitProvenSyncConfiguration');
        renderScreen(onLoggedIn);

        fillAndSubmit('https://cloud.example.com', VALID_TOKEN);

        await waitFor(() => expect(screen.getByText(/Couldn't connect/)).toBeInTheDocument());
        // Not 'requeued', so the retry loop must not run it again.
        expect(performSync).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
        expect(onLoggedIn).not.toHaveBeenCalled();
    });

    it('treats a busy remote fence as a failure without retrying', async () => {
        const onLoggedIn = vi.fn();
        const performSync = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
            skipped: 'remoteFenceBusy',
            remoteFenceDeferred: 'busy',
        });
        const commit = vi.spyOn(SyncService, 'commitProvenSyncConfiguration');
        renderScreen(onLoggedIn);

        fillAndSubmit('https://cloud.example.com', VALID_TOKEN);

        await waitFor(() => expect(screen.getByText(/Couldn't connect/)).toBeInTheDocument());
        expect(performSync).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
        expect(onLoggedIn).not.toHaveBeenCalled();
    });

    it('shows a generic error with the trimmed reason on a plain probe failure', async () => {
        const onLoggedIn = vi.fn();
        vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: false,
            error: 'Cloud GET failed (401): Unauthorized',
        });
        const commit = vi.spyOn(SyncService, 'commitProvenSyncConfiguration');
        renderScreen(onLoggedIn);

        fillAndSubmit('https://cloud.example.com', VALID_TOKEN);

        await waitFor(() => expect(screen.getByText(/Couldn't connect/)).toBeInTheDocument());
        expect(screen.getByText(/Cloud GET failed \(401\): Unauthorized/)).toBeInTheDocument();
        expect(commit).not.toHaveBeenCalled();
        expect(onLoggedIn).not.toHaveBeenCalled();
    });
});
