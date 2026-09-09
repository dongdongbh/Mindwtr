import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from '../../../contexts/language-context';
import { KeybindingProvider } from '../../../contexts/keybinding-context';

vi.mock('../../../hooks/usePerformanceMonitor', () => ({
    usePerformanceMonitor: () => ({
        enabled: false,
        metrics: {},
        measure: <T,>(_label: string, fn: () => T) => fn(),
        trackUseMemo: () => undefined,
        trackUseEffect: () => undefined,
    }),
}));

vi.mock('../../../config/performanceBudgets', () => ({ checkBudget: vi.fn() }));

vi.mock('../../../lib/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/runtime')>()),
    isTauriRuntime: () => false,
    isFlatpakRuntime: () => false,
    getInstallSourceOrFallback: vi.fn().mockResolvedValue('github-release'),
}));

vi.mock('../../../lib/report-error', () => ({ reportError: vi.fn() }));

vi.mock('../../../lib/sync-service', () => ({
    SyncService: {
        cleanupAttachmentsNow: vi.fn().mockResolvedValue(undefined),
        getSyncStatus: vi.fn(() => 'idle'),
        subscribe: vi.fn(() => () => undefined),
    },
}));

vi.mock('../../../lib/app-log', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/app-log')>()),
    clearLog: vi.fn().mockResolvedValue(undefined),
    collectFeedbackDiagnostics: vi.fn().mockResolvedValue(null),
    getLogPath: vi.fn().mockResolvedValue('/tmp/mindwtr.log'),
}));

vi.mock('../../../lib/settings-open-diagnostics', () => ({
    markSettingsOpenTrace: vi.fn(),
    measureSettingsOpenStep: vi.fn(async (_step: string, fn: () => unknown) => await fn()),
    wrapSettingsOpenImport: vi.fn((_step: string, loader: () => Promise<unknown>) => loader),
}));

vi.mock('../../../lib/update-service', () => ({
    APP_STORE_LISTING_URL: '',
    GITHUB_RELEASES_URL: '',
    HOMEBREW_CASK_URL: '',
    MS_STORE_URL: '',
    WINGET_PACKAGE_URL: '',
    checkForUpdates: vi.fn().mockResolvedValue({ hasUpdate: false, latestVersion: '0.0.0' }),
    compareVersions: vi.fn(() => 0),
    normalizeInstallSource: vi.fn((value: string) => value),
    verifyDownloadChecksum: vi.fn().mockResolvedValue(true),
}));

vi.mock('./SettingsUpdateModal', () => ({ SettingsUpdateModal: () => null }));

// Only the sidebar (the search UI) and the GTD page (the collapsed card the
// reporter's setting hides in) are real here; the rest would drag in Tauri
// plumbing this test doesn't exercise.
vi.mock('./useSyncSettings', () => ({
    useSyncSettings: () => ({
        syncPageProps: { syncError: null },
        dataTransferProps: { transferAction: null },
    }),
}));
vi.mock('./useAiSettings', () => ({ useAiSettings: () => ({ aiEnabled: false }) }));
vi.mock('./useObsidianSettings', () => ({ useObsidianSettings: () => ({ obsidianEnabled: false }) }));
vi.mock('./useCalendarSettings', () => ({
    useCalendarSettings: () => ({ externalCalendars: [], showSystemCalendarSection: false }),
}));
vi.mock('./SettingsMainPage', () => ({ SettingsMainPage: () => <div>main-page</div> }));
vi.mock('./SettingsAiPage', () => ({ SettingsAiPage: () => <div>ai-page</div> }));
vi.mock('./SettingsSyncPage', () => ({ SettingsSyncPage: () => <div>sync-page</div> }));
vi.mock('./SettingsDataPage', () => ({ SettingsDataPage: () => <div>data-page</div> }));
vi.mock('./SettingsAboutPage', () => ({ SettingsAboutPage: () => <div>about-page</div> }));
vi.mock('./SettingsIntegrationsPage', () => ({ SettingsIntegrationsPage: () => <div>integrations-page</div> }));

import { SettingsView } from '../SettingsView';

// The sidebar's small-screen page <select> also exposes `option` roles, so
// results are always queried inside the results listbox.
function resultOptions(): HTMLElement[] {
    const list = document.querySelector<HTMLElement>('[role="listbox"]');
    return list ? within(list).queryAllByRole('option') : [];
}

function renderSettings() {
    return render(
        <LanguageProvider>
            <KeybindingProvider currentView="settings" onNavigate={() => undefined}>
                <SettingsView />
            </KeybindingProvider>
        </LanguageProvider>,
    );
}

describe('settings search results', () => {
    beforeEach(() => {
        window.localStorage.clear();
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        });
        useTaskStore.setState((state) => ({
            ...state,
            settings: {},
            updateSettings: vi.fn().mockResolvedValue(undefined),
        }));
    });

    // The #884 reporter's exact miss: a setting buried in a collapsed card,
    // with nothing in the old search to say where it lived.
    it('lists the matched setting with its page and section path', () => {
        const { getByRole } = renderSettings();

        fireEvent.change(getByRole('combobox', { name: /search settings/i }), { target: { value: 'clean up quick add' } });

        const options = resultOptions();
        expect(options).toHaveLength(1);
        expect(options[0]).toHaveTextContent('Clean up quick add text');
        expect(options[0]).toHaveTextContent('GTD → Default capture method');
    });

    it('offers both quick-add settings for "quick add", each with its own path', () => {
        const { getByRole } = renderSettings();

        fireEvent.change(getByRole('combobox', { name: /search settings/i }), { target: { value: 'quick add' } });

        const text = resultOptions().map((option) => option.textContent ?? '');
        expect(text).toContainEqual(expect.stringContaining('Global quick add shortcut'));
        expect(text).toContainEqual(expect.stringContaining('General → Input'));
        expect(text).toContainEqual(expect.stringContaining('Clean up quick add text'));
    });

    it('navigates, expands the containing card and highlights the row', async () => {
        const { getByRole } = renderSettings();

        fireEvent.change(getByRole('combobox', { name: /search settings/i }), { target: { value: 'clean up quick add' } });
        fireEvent.click(resultOptions()[0]);

        // The disclosure that hides the row opens...
        await waitFor(() => {
            const card = document.querySelector('[data-settings-section="captureDefault"]');
            expect(card).toHaveAttribute('aria-expanded', 'true');
        });

        // ...and the row itself is marked so the eye lands on it.
        await waitFor(() => {
            expect(document.querySelector('[data-settings-key="quickAddAutoClean"]'))
                .toHaveAttribute('data-settings-highlight', 'true');
        });

        // Picking a result also leaves the search box empty again.
        expect(getByRole('combobox', { name: /search settings/i })).toHaveValue('');
    });

    it('moves through results with the arrow keys and picks with Enter', async () => {
        const { getByRole } = renderSettings();

        const input = getByRole('combobox', { name: /search settings/i });
        fireEvent.change(input, { target: { value: 'quick add' } });
        expect(resultOptions()[0]).toHaveAttribute('aria-selected', 'true');

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(resultOptions()[1]).toHaveAttribute('aria-selected', 'true');

        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => {
            expect(resultOptions()).toHaveLength(0);
        });
    });

    it('clears the query on Escape', () => {
        const { getByRole } = renderSettings();

        const input = getByRole('combobox', { name: /search settings/i });
        fireEvent.change(input, { target: { value: 'clean up quick add' } });
        expect(resultOptions()).toHaveLength(1);

        fireEvent.keyDown(input, { key: 'Escape' });
        expect(input).toHaveValue('');
        expect(resultOptions()).toHaveLength(0);
    });
});
