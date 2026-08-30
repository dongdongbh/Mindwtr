import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsAboutPage } from './useSettingsAboutPage';
import { getEnglishSettingsLabels } from './labels';
import { UpdateRateLimitedError } from '../../../lib/update-service';

const runtimeMock = vi.hoisted(() => ({
    isTauriRuntime: vi.fn(() => true),
    getInstallSourceOrFallback: vi.fn<() => Promise<string>>(),
}));

const updateServiceMock = vi.hoisted(() => ({
    checkForUpdates: vi.fn(async () => ({ hasUpdate: false })),
}));

vi.mock('../../../lib/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/runtime')>()),
    isTauriRuntime: runtimeMock.isTauriRuntime,
    getInstallSourceOrFallback: runtimeMock.getInstallSourceOrFallback,
}));

vi.mock('../../../lib/update-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/update-service')>()),
    checkForUpdates: updateServiceMock.checkForUpdates,
}));

vi.mock('@tauri-apps/api/app', () => ({
    getVersion: vi.fn(async () => '1.0.0'),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async () => null),
}));

vi.mock('../../../lib/app-log', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/app-log')>()),
    getLogPath: vi.fn(async () => ''),
}));

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/report-error', () => ({ reportError: reportErrorMock }));

function Harness() {
    useSettingsAboutPage({ t: getEnglishSettingsLabels() });
    return null;
}

type AboutPageResult = ReturnType<typeof useSettingsAboutPage>;

function CaptureHarness({ onResult }: { onResult: (result: AboutPageResult) => void }) {
    onResult(useSettingsAboutPage({ t: getEnglishSettingsLabels() }));
    return null;
}

describe('useSettingsAboutPage background update check', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
    });

    it('stays offline until install source detection identifies a quiet channel', async () => {
        // Slow detection resolving to scoop: before the fix the check fired
        // with the initial 'unknown' source while detection was in flight.
        let resolveSource: (value: string) => void = () => {};
        runtimeMock.getInstallSourceOrFallback.mockImplementation(
            () => new Promise<string>((resolve) => { resolveSource = resolve; }),
        );

        render(<Harness />);

        // Give the app-version effect time to settle so the badge check would
        // have been eligible to run if it ignored the unresolved source.
        await waitFor(() => expect(runtimeMock.getInstallSourceOrFallback).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(updateServiceMock.checkForUpdates).not.toHaveBeenCalled();

        resolveSource('scoop');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(updateServiceMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it('runs the background check once detection resolves a non-quiet channel', async () => {
        runtimeMock.getInstallSourceOrFallback.mockResolvedValue('winget');

        render(<Harness />);

        await waitFor(() => expect(updateServiceMock.checkForUpdates).toHaveBeenCalledTimes(1));
        expect(updateServiceMock.checkForUpdates).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ installSource: 'winget' }),
        );
    });

    it('reports the localized copy, not the error message, when the check is rate-limited', async () => {
        const labels = getEnglishSettingsLabels();
        runtimeMock.getInstallSourceOrFallback.mockResolvedValue('scoop');
        updateServiceMock.checkForUpdates.mockRejectedValue(new UpdateRateLimitedError());

        let result!: AboutPageResult;
        render(<CaptureHarness onResult={(value) => { result = value; }} />);
        await waitFor(() => expect(result).toBeDefined());

        await result.aboutPageProps.onCheckUpdates();

        expect(reportErrorMock).toHaveBeenCalledWith(
            'Update check failed',
            expect.any(UpdateRateLimitedError),
            { userMessage: labels.updateRateLimited },
        );
        // The raw Error message is diagnostic-only and must never be the copy.
        expect(labels.updateRateLimited).not.toBe(new UpdateRateLimitedError().message);
    });
});

describe('useSettingsAboutPage web build', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
    });

    it('reports a real version and no updater on the web build (was "vweb")', async () => {
        runtimeMock.isTauriRuntime.mockReturnValue(false);
        let latest: AboutPageResult | null = null;
        render(<CaptureHarness onResult={(result) => { latest = result; }} />);
        await waitFor(() => {
            expect(latest!.aboutPageProps.appVersion).toMatch(/^\d+\.\d+\.\d+/);
        });
        expect(latest!.aboutPageProps.appVersion).not.toBe('web');
        expect(latest!.aboutPageProps.updatesSupported).toBe(false);
        expect(updateServiceMock.checkForUpdates).not.toHaveBeenCalled();
    });

    it('keeps the updater available in the native desktop app', async () => {
        runtimeMock.isTauriRuntime.mockReturnValue(true);
        let latest: AboutPageResult | null = null;
        render(<CaptureHarness onResult={(result) => { latest = result; }} />);
        await waitFor(() => {
            expect(latest!.aboutPageProps.updatesSupported).toBe(true);
        });
    });
});
