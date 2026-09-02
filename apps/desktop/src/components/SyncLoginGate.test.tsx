import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SyncLoginGate } from './SyncLoginGate';
import { LanguageProvider } from '../contexts/language-context';
import { SyncService } from '../lib/sync-service';
import { getRequireSyncFlag } from '../lib/web-runtime-config';
import { logError } from '../lib/app-log';

vi.mock('../lib/web-runtime-config', () => ({
    getRequireSyncFlag: vi.fn(),
}));

vi.mock('../lib/app-log', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/app-log')>()),
    logError: vi.fn(),
}));

const StubRootApp = () => <div>root-app-rendered</div>;

const renderGate = () => render(
    <LanguageProvider><SyncLoginGate RootApp={StubRootApp} /></LanguageProvider>,
);

afterEach(() => {
    vi.restoreAllMocks();
});

describe('SyncLoginGate', () => {
    it('renders RootApp immediately when requireSync is false', async () => {
        vi.mocked(getRequireSyncFlag).mockResolvedValue(false);
        renderGate();

        await waitFor(() => expect(screen.getByText('root-app-rendered')).toBeInTheDocument());
    });

    it('renders RootApp when requireSync is true and a valid self-hosted config already exists', async () => {
        vi.mocked(getRequireSyncFlag).mockResolvedValue(true);
        vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('cloud');
        vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue('selfhosted');
        vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({
            url: 'https://cloud.example.com',
            token: 'a-valid-token-that-is-long-enough-000',
            allowInsecureHttp: false,
        });
        renderGate();

        await waitFor(() => expect(screen.getByText('root-app-rendered')).toBeInTheDocument());
    });

    it('renders the login screen when requireSync is true and no valid config exists', async () => {
        vi.mocked(getRequireSyncFlag).mockResolvedValue(true);
        vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('off');
        vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue('selfhosted');
        vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({ url: '', token: '', allowInsecureHttp: false });
        renderGate();

        await waitFor(() => expect(screen.getByLabelText('Self-hosted URL')).toBeInTheDocument());
        expect(screen.queryByText('root-app-rendered')).not.toBeInTheDocument();
    });

    it('fails open to RootApp and logs when the gate check throws', async () => {
        vi.mocked(getRequireSyncFlag).mockRejectedValue(new Error('runtime config unreachable'));
        renderGate();

        // A blank 'checking' screen forever would be worse than an unchecked app.
        await waitFor(() => expect(screen.getByText('root-app-rendered')).toBeInTheDocument());
        expect(vi.mocked(logError)).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'runtime config unreachable' }),
            { scope: 'sync-login-gate' },
        );
    });

    it('fails open to RootApp when reading the stored sync config throws', async () => {
        vi.mocked(getRequireSyncFlag).mockResolvedValue(true);
        vi.spyOn(SyncService, 'getSyncBackend').mockRejectedValue(new Error('storage unavailable'));
        vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue('selfhosted');
        vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({ url: '', token: '', allowInsecureHttp: false });
        renderGate();

        await waitFor(() => expect(screen.getByText('root-app-rendered')).toBeInTheDocument());
    });

    it('renders the login screen when the backend is cloud but the provider is dropbox, not selfhosted', async () => {
        vi.mocked(getRequireSyncFlag).mockResolvedValue(true);
        vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('cloud');
        vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue('dropbox');
        vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({ url: '', token: '', allowInsecureHttp: false });
        renderGate();

        await waitFor(() => expect(screen.getByLabelText('Self-hosted URL')).toBeInTheDocument());
    });
});
