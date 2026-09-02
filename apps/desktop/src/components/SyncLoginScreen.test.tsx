import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { SyncLoginScreen } from './SyncLoginScreen';
import { LanguageProvider } from '../contexts/language-context';
import { SyncService } from '../lib/sync-service';
import { getWebDefaultCloudUrl } from '../lib/web-runtime-config';

vi.mock('../lib/web-runtime-config', () => ({
    getWebDefaultCloudUrl: vi.fn(),
}));

const renderScreen = (onLoggedIn: () => void) => render(
    <LanguageProvider><SyncLoginScreen onLoggedIn={onLoggedIn} /></LanguageProvider>,
);

const VALID_TOKEN = 'a-valid-token-that-is-long-enough-000';

const fillAndSubmit = (url: string, token: string) => {
    fireEvent.change(screen.getByLabelText('Self-hosted URL'), { target: { value: url } });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
};

beforeEach(() => {
    // Default: no default URL, so the prefill effect is a no-op unless a
    // test overrides it.
    vi.mocked(getWebDefaultCloudUrl).mockResolvedValue('');
});

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

    it('treats a pendingRemoteWriteBackoff skip carrying a stale encryption error as a failure', async () => {
        const onLoggedIn = vi.fn();
        // success:true and a `SYNC_ENCRYPTION_REMOTE_ENCRYPTED`-shaped `error`,
        // but the error is `lastSyncError` carried over from persisted settings
        // (a stale sentinel from an earlier, unrelated sync attempt on this
        // device) and the backoff skip never talked to the server. Without the
        // `!success` gate on the encrypted-remote branch, this would have been
        // wrongly treated as proof and let the login through.
        const performSync = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
            skipped: 'pendingRemoteWriteBackoff',
            remoteWriteDeferred: true,
            error: 'SYNC_ENCRYPTION_REMOTE_ENCRYPTED',
        });
        const commit = vi.spyOn(SyncService, 'commitProvenSyncConfiguration');
        renderScreen(onLoggedIn);

        fillAndSubmit('https://cloud.example.com', VALID_TOKEN);

        await waitFor(() => expect(screen.getByText(/Couldn't connect/)).toBeInTheDocument());
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

    it('prefills the URL field from the runtime-config default and shows both hints', async () => {
        vi.mocked(getWebDefaultCloudUrl).mockResolvedValue('https://runtime-default.example.com');
        renderScreen(vi.fn());

        await waitFor(() => expect(screen.getByLabelText('Self-hosted URL')).toHaveValue(
            'https://runtime-default.example.com',
        ));

        expect(screen.getByText('Use your self-hosted endpoint URL.')).toBeInTheDocument();
        expect(screen.getByText(
            "Mindwtr doesn't use user accounts. Your devices connect to your server with this access token.",
        )).toBeInTheDocument();
    });

    it('does not overwrite a URL the user already typed with the runtime-config default', async () => {
        vi.mocked(getWebDefaultCloudUrl).mockResolvedValue('https://runtime-default.example.com');
        renderScreen(vi.fn());

        fireEvent.change(screen.getByLabelText('Self-hosted URL'), {
            target: { value: 'https://user-typed.example.com' },
        });

        // Give the prefill promise a chance to resolve; the field must stay
        // as the user typed it.
        await waitFor(() => expect(getWebDefaultCloudUrl).toHaveBeenCalled());
        expect(screen.getByLabelText('Self-hosted URL')).toHaveValue('https://user-typed.example.com');
    });

    it('does not update state after unmount when the prefill resolves late', async () => {
        // Reproduces the race the `active` guard closes: SyncLoginGate
        // unmounts this screen the instant onLoggedIn() fires, but
        // getWebDefaultCloudUrl()'s underlying fetch can take up to 3s
        // (PROBE_TIMEOUT_MS in web-runtime-config.ts) to resolve. Without the
        // guard, the prefill's `.then` would call setUrl on an unmounted
        // component.
        let resolvePrefill: (url: string) => void = () => {};
        vi.mocked(getWebDefaultCloudUrl).mockReturnValue(
            new Promise<string>((resolve) => {
                resolvePrefill = resolve;
            }),
        );
        // On React 18+, a state update on an already-unmounted component is
        // a silent no-op (the "Cannot update an unmounted component" warning
        // was removed), so this can't be observed via a React dev warning.
        // console.error is still asserted as a general regression guard: if
        // this ever regresses to something that *does* throw or warn (e.g. a
        // future change that logs on prefill), this test will catch it.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { unmount } = renderScreen(vi.fn());
        unmount();

        resolvePrefill('https://late.example.com');
        // Let the effect's `.then` microtask (and any state update it would
        // have triggered) run.
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleError).not.toHaveBeenCalled();
    });
});
