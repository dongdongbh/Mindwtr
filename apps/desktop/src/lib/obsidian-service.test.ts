import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObsidianSourceRef } from '@mindwtr/core';

const isTauriRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const invokeMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock('./runtime', () => ({
    isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('./app-log', () => ({
    logWarn: logWarnMock,
}));

import { ObsidianService, formatScanFoldersInput, parseScanFoldersInput } from './obsidian-service';

const sourceRef: ObsidianSourceRef = {
    vaultName: 'My Vault',
    vaultPath: '/Vault',
    relativeFilePath: 'Projects/Alpha Plan.md',
    lineNumber: 12,
    fileModifiedAt: '2026-03-14T12:00:00.000Z',
    noteTags: [],
};

afterEach(() => {
    localStorage.clear();
    isTauriRuntimeMock.mockReset();
    isTauriRuntimeMock.mockReturnValue(false);
    invokeMock.mockReset();
    logWarnMock.mockReset();
    vi.restoreAllMocks();
});

describe('obsidian-service helpers', () => {
    it('parses scan folder input into normalized relative folders', () => {
        expect(parseScanFoldersInput('Projects\nInbox, /, ./Area/../Daily')).toEqual([
            'Projects',
            'Inbox',
            '/',
            'Daily',
        ]);
    });

    it('formats scan folders into a stable editable string', () => {
        expect(formatScanFoldersInput(['Projects', '/', 'Projects', 'Daily/Notes'])).toBe('Projects, /, Daily/Notes');
    });

    it('builds Obsidian URIs with encoded vault and file names', () => {
        expect(ObsidianService.buildObsidianUri(sourceRef)).toBe(
            'obsidian://open?vault=My%20Vault&file=Projects%2FAlpha%20Plan'
        );
    });

    it('opens obsidian URIs through the browser when not running in Tauri', async () => {
        const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

        await ObsidianService.openTaskInObsidian(sourceRef);

        expect(openSpy).toHaveBeenCalledWith(
            'obsidian://open?vault=My%20Vault&file=Projects%2FAlpha%20Plan',
            '_blank',
            'noopener,noreferrer'
        );
    });

    it('checks the vault marker through the desktop backend in Tauri', async () => {
        isTauriRuntimeMock.mockReturnValue(true);
        invokeMock.mockResolvedValueOnce(true);

        await expect(ObsidianService.hasVaultMarker('/Vault')).resolves.toBe(true);

        expect(invokeMock).toHaveBeenCalledWith('check_obsidian_vault_marker', {
            vaultPath: '/Vault',
        });
    });

    it('treats vault marker lookup failures as unknown instead of surfacing a UI error', async () => {
        isTauriRuntimeMock.mockReturnValue(true);
        invokeMock.mockRejectedValue(new Error('forbidden'));

        await expect(ObsidianService.hasVaultMarker('/Vault')).resolves.toBeNull();
        await expect(ObsidianService.inspectVault('/Vault')).resolves.toEqual({
            hasObsidianDir: null,
        });
        expect(logWarnMock).toHaveBeenCalledTimes(2);
    });
});
