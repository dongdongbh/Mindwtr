import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeObsidianConfig, type ObsidianConfig, type ObsidianScanResult } from '../lib/obsidian-scanner';

const scanFileMock = vi.hoisted(() => vi.fn());
const scanVaultMock = vi.hoisted(() => vi.fn());
const setConfigMock = vi.hoisted(() => vi.fn());
const startWatcherMock = vi.hoisted(() => vi.fn());
const stopWatcherMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/obsidian-service', async () => {
    return {
        ObsidianService: {
            getConfig: vi.fn(),
            hasVaultMarker: vi.fn(),
            scanVault: scanVaultMock,
            scanFile: scanFileMock,
            setConfig: setConfigMock,
            startWatcher: startWatcherMock,
            stopWatcher: stopWatcherMock,
        },
    };
});

import { useObsidianStore } from './obsidian-store';

const initialState = useObsidianStore.getState();

const enabledConfig: ObsidianConfig = normalizeObsidianConfig({
    vaultPath: '/Vault',
    enabled: true,
    scanFolders: ['/'],
});

const emptyScanResult: ObsidianScanResult = {
    tasks: [],
    scannedFileCount: 0,
    scannedRelativePaths: [],
    taskNotesDetectedPaths: [],
    warnings: [],
    importMode: 'inline',
};

const resetStore = () => {
    useObsidianStore.setState(initialState, true);
    useObsidianStore.setState((state) => ({
        ...state,
        config: enabledConfig,
        isScanning: false,
        hasScannedThisSession: false,
        error: null,
    }));
};

beforeEach(() => {
    resetStore();
    scanVaultMock.mockReset();
    scanFileMock.mockReset();
    setConfigMock.mockReset();
    startWatcherMock.mockReset();
    stopWatcherMock.mockReset();
    setConfigMock.mockImplementation(async (config: Partial<ObsidianConfig>) => normalizeObsidianConfig(config));
});

afterEach(() => {
    resetStore();
    vi.restoreAllMocks();
});

describe('useObsidianStore', () => {
    it('shares an in-flight rescan for repeated requests against the same vault', async () => {
        let resolveScan!: (result: ObsidianScanResult) => void;
        scanVaultMock.mockReturnValueOnce(new Promise<ObsidianScanResult>((resolve) => {
            resolveScan = resolve;
        }));

        const firstScan = useObsidianStore.getState().rescan();
        const secondScan = useObsidianStore.getState().rescan();

        expect(scanVaultMock).toHaveBeenCalledTimes(1);
        expect(useObsidianStore.getState().isScanning).toBe(true);

        resolveScan(emptyScanResult);
        await Promise.all([firstScan, secondScan]);

        expect(setConfigMock).toHaveBeenCalledTimes(1);
        expect(useObsidianStore.getState()).toMatchObject({
            error: null,
            hasScannedThisSession: true,
            isScanning: false,
            scannedFileCount: 0,
        });
    });
});


it('invalidates a full scan started before the required tag changed', async () => {
    let finish!: (value: ObsidianScanResult) => void;
    scanVaultMock.mockReturnValueOnce(new Promise<ObsidianScanResult>((resolve) => { finish = resolve; }));
    const pending = useObsidianStore.getState().rescan();
    const saving = useObsidianStore.getState().updateConfig({ requiredInlineTag: '#task' });
    finish({ ...emptyScanResult, scannedFileCount: 42 });
    await Promise.all([pending, saving]);
    expect(useObsidianStore.getState().config.requiredInlineTag).toBe('#task');
    expect(useObsidianStore.getState().scannedFileCount).toBe(0);
    expect(useObsidianStore.getState().hasScannedThisSession).toBe(false);
    scanVaultMock.mockResolvedValueOnce(emptyScanResult);
    await useObsidianStore.getState().rescan();
    expect(scanVaultMock.mock.calls[1][0].requiredInlineTag).toBe('#task');
});

it('discards an in-flight live file update after a filter change', async () => {
    useObsidianStore.setState({ hasScannedThisSession: true });
    let finish!: (value: unknown) => void;
    scanFileMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = useObsidianStore.getState().handleFilesChanged({ changed: ['Inbox.md'], deleted: [] });
    await vi.waitFor(() => expect(scanFileMock).toHaveBeenCalledOnce());
    await useObsidianStore.getState().updateConfig({ requiredInlineTag: '#task' });
    finish({ tasks: [], warning: null, isTracked: true, relativeFilePath: 'Inbox.md', detectedTaskNotes: false });
    expect(await pending).toBeNull();
    expect(useObsidianStore.getState().scannedRelativePaths).toEqual([]);
});


it('persists the new filter after an older scan timestamp write finishes', async () => {
    scanVaultMock.mockResolvedValueOnce(emptyScanResult);
    let finishWrite!: (value: ObsidianConfig) => void;
    setConfigMock.mockImplementationOnce(() => new Promise<ObsidianConfig>((resolve) => { finishWrite = resolve; }));
    const pending = useObsidianStore.getState().rescan();
    await vi.waitFor(() => expect(setConfigMock).toHaveBeenCalledOnce());
    const saving = useObsidianStore.getState().updateConfig({ requiredInlineTag: '#task' });
    expect(setConfigMock).toHaveBeenCalledOnce();
    finishWrite(normalizeObsidianConfig(setConfigMock.mock.calls[0][0]));
    await Promise.all([pending, saving]);
    expect(setConfigMock.mock.calls[1][0].requiredInlineTag).toBe('#task');
    expect(useObsidianStore.getState().config.requiredInlineTag).toBe('#task');
    expect(useObsidianStore.getState().hasScannedThisSession).toBe(false);
});
