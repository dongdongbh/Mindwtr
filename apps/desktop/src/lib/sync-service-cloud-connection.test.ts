import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncService, __syncServiceTestUtils } from './sync-service';
import { collectFeedbackDiagnostics, isLoggingEnabled, logInfo as appLogInfo } from './app-log';

const releaseCheck = 'v1.3.8/docker-lan-cloud-test';

afterEach(async () => {
    vi.unstubAllGlobals();
    __syncServiceTestUtils.resetDependenciesForTests();
    await SyncService.resetForTests();
});

function setupConnectionTest(origin = 'http://192.168.1.50:5173', native = false) {
    const logInfo = vi.fn(async () => null);
    const logWarn = vi.fn(async () => null);
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', {
        headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('window', { location: new URL(origin) });
    vi.stubGlobal('fetch', fetcher);
    __syncServiceTestUtils.setDependenciesForTests({
        isTauriRuntime: () => native,
        getTauriFetch: async () => undefined,
        logInfo,
        logWarn,
    });
    return { fetcher, logInfo, logWarn };
}

describe('self-hosted browser connection test diagnostic', () => {
    it('proves the same-host HTTP cross-port request succeeded without logging its URL or token', async () => {
        const { fetcher, logInfo } = setupConnectionTest();
        let finishRequest = (_response: Response): void => {};
        fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRequest = resolve; }));
        const result = SyncService.testCloudConnection({
            url: ' http://192.168.1.50:8787 ',
            token: 'private-test-token',
            allowInsecureHttp: true,
        });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
        expect(logInfo).not.toHaveBeenCalled();
        finishRequest(new Response('{}', { headers: { 'content-type': 'application/json' } }));
        await result;

        expect(logInfo).toHaveBeenCalledExactlyOnceWith('Browser same-host HTTP cloud connection test succeeded', {
            scope: 'sync',
            force: true,
            extra: { releaseCheck },
        });
    });

    it('includes the successful browser test in shared Diagnostics with debug logging off', async () => {
        setupConnectionTest();
        __syncServiceTestUtils.setDependenciesForTests({ logInfo: appLogInfo });
        expect(isLoggingEnabled()).toBe(false);
        await SyncService.testCloudConnection({
            url: 'http://192.168.1.50:8787', token: 'private-test-token', allowInsecureHttp: true,
        });
        const diagnostics = await collectFeedbackDiagnostics();
        expect(diagnostics).toContain('Browser same-host HTTP cloud connection test succeeded');
        expect(diagnostics).toContain(releaseCheck);
        expect(diagnostics).not.toContain('192.168.1.50');
        expect(diagnostics).not.toContain('private-test-token');
    });

    it.each([
        ['native', 'http://192.168.1.50:5173', 'http://192.168.1.50:8787', true],
        ['HTTPS app', 'https://192.168.1.50:5173', 'http://192.168.1.50:8787', false],
        ['HTTPS cloud', 'http://192.168.1.50:5173', 'https://192.168.1.50:8787', false],
        ['other host', 'http://192.168.1.50:5173', 'http://192.168.1.51:8787', false],
        ['same port', 'http://192.168.1.50:5173', 'http://192.168.1.50:5173', false],
    ])('does not claim the Docker LAN path for %s', async (_case, origin, url, native) => {
        const { fetcher, logInfo } = setupConnectionTest(origin, native);
        await SyncService.testCloudConnection({ url, allowInsecureHttp: true });
        expect(fetcher).toHaveBeenCalledOnce();
        expect(logInfo).not.toHaveBeenCalled();
    });

    it('does not log success when the server refuses the connection test', async () => {
        const { fetcher, logInfo, logWarn } = setupConnectionTest();
        fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
        await expect(SyncService.testCloudConnection({
            url: 'http://192.168.1.50:8787', allowInsecureHttp: true,
        })).rejects.toThrow('401');
        expect(logInfo).not.toHaveBeenCalled();
        expect(logWarn).toHaveBeenCalledOnce();
    });

    it('keeps the existing public HTTP opt-in check before making a request', async () => {
        const { fetcher, logInfo } = setupConnectionTest('http://cloud.example:5173');
        await expect(SyncService.testCloudConnection({
            url: 'http://cloud.example:8787', allowInsecureHttp: false,
        })).rejects.toThrow('HTTPS');
        expect(fetcher).not.toHaveBeenCalled();
        expect(logInfo).not.toHaveBeenCalled();
    });
});
