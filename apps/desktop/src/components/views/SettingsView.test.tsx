import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';

const calendarHookTracker = {
    mounts: 0,
    unmounts: 0,
};
const aiHookTracker = {
    enabled: [] as boolean[],
};
const resourceTracker = { sync: false, calendar: false, obsidian: false, advanced: false };
let pendingIntegrations: Promise<void> | null = null;
let calendarHookUseEffect: typeof import('react').useEffect | null = null;

vi.mock('../../hooks/usePerformanceMonitor', () => ({
    usePerformanceMonitor: () => ({
        enabled: false,
        metrics: {},
        measure: <T,>(_label: string, fn: () => T) => fn(),
        trackUseMemo: () => undefined,
        trackUseEffect: () => undefined,
    }),
}));

vi.mock('../../config/performanceBudgets', () => ({
    checkBudget: vi.fn(),
}));

vi.mock('../../lib/runtime', () => ({
    isTauriRuntime: () => false,
    isFlatpakRuntime: () => false,
    getInstallSourceOrFallback: vi.fn().mockResolvedValue('github-release'),
}));

vi.mock('../../lib/report-error', () => ({
    reportError: vi.fn(),
}));

vi.mock('../../lib/sync-service', () => ({
    SyncService: {
        cleanupAttachmentsNow: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../../lib/app-log', () => ({
    clearLog: vi.fn().mockResolvedValue(undefined),
    collectFeedbackDiagnostics: vi.fn().mockResolvedValue(null),
    getLogPath: vi.fn().mockResolvedValue('/tmp/mindwtr.log'),
}));

vi.mock('../../lib/settings-open-diagnostics', () => ({
    markSettingsOpenTrace: vi.fn(),
    measureSettingsOpenStep: vi.fn(async (_step: string, fn: () => unknown) => await fn()),
    wrapSettingsOpenImport: vi.fn((_step: string, loader: () => Promise<unknown>) => loader),
}));

vi.mock('../../lib/update-service', () => ({
    APP_STORE_LISTING_URL: 'https://example.com/app-store',
    GITHUB_RELEASES_URL: 'https://example.com/releases',
    HOMEBREW_CASK_URL: 'https://example.com/homebrew',
    MS_STORE_URL: 'https://example.com/ms-store',
    WINGET_PACKAGE_URL: 'https://example.com/winget',
    checkForUpdates: vi.fn().mockResolvedValue({
        hasUpdate: false,
        latestVersion: '0.0.0',
    }),
    compareVersions: vi.fn(() => 0),
    normalizeInstallSource: vi.fn((value: string) => value),
    verifyDownloadChecksum: vi.fn().mockResolvedValue(true),
}));

vi.mock('./settings/SettingsUpdateModal', () => ({
    SettingsUpdateModal: () => null,
}));

vi.mock('./settings/SettingsSidebar', () => ({
    SettingsSidebar: ({ items, onSelect }: { items: Array<{ id: string }>; onSelect: (id: string) => void }) => (
        <div>
            {items.map((item) => (
                <button key={item.id} type="button" onClick={() => onSelect(item.id)}>
                    {item.id}
                </button>
            ))}
        </div>
    ),
}));

vi.mock('./settings/SettingsMainPage', () => ({
    SettingsMainPage: () => <div>main-page</div>,
}));

vi.mock('./settings/SettingsGtdPage', () => ({
    SettingsGtdPage: () => <div>gtd-page</div>,
}));

vi.mock('./settings/SettingsAiPage', () => ({
    SettingsAiPage: () => <div>ai-page</div>,
}));

vi.mock('./settings/SettingsNotificationsPage', () => ({
    SettingsNotificationsPage: () => <div>notifications-page</div>,
}));

vi.mock('./settings/SettingsSyncPage', () => ({
    SettingsSyncPage: () => <div>sync-page</div>,
}));

vi.mock('./settings/SettingsAboutPage', () => ({
    SettingsAboutPage: () => <div>about-page</div>,
}));

vi.mock('./settings/SettingsIntegrationsPage', () => ({
    SettingsIntegrationsPage: () => {
        if (pendingIntegrations) throw pendingIntegrations;
        return <div>integrations-page</div>;
    },
}));

vi.mock('./settings/useAiSettings', () => ({
    useAiSettings: ({ enabled }: { enabled?: boolean }) => {
        aiHookTracker.enabled.push(enabled ?? true);
        return { aiEnabled: false };
    },
}));

vi.mock('./settings/useSyncSettings', () => ({
    useSyncSettings: ({ loadEnabled }: { loadEnabled?: boolean }) => {
        resourceTracker.sync = loadEnabled ?? true;
        return {
            syncPageProps: { syncError: null },
            dataTransferProps: { transferAction: null },
        };
    },
}));

vi.mock('./settings/useObsidianSettings', () => ({
    useObsidianSettings: ({ loadEnabled }: { loadEnabled?: boolean }) => {
        resourceTracker.obsidian = loadEnabled ?? true;
        return { obsidianEnabled: false };
    },
}));

vi.mock('./settings/useSettingsAdvancedPage', () => ({
    useSettingsAdvancedPage: ({ loadEnabled }: { loadEnabled?: boolean }) => {
        resourceTracker.advanced = loadEnabled ?? true;
        return {};
    },
}));

vi.mock('./settings/useCalendarSettings', () => ({
    useCalendarSettings: ({ loadEnabled }: { loadEnabled?: boolean }) => {
        resourceTracker.calendar = loadEnabled ?? true;
        if (!calendarHookUseEffect) {
            throw new Error('calendar hook useEffect not initialized');
        }

        calendarHookUseEffect(() => {
            calendarHookTracker.mounts += 1;
            return () => {
                calendarHookTracker.unmounts += 1;
            };
        }, []);

        return { externalCalendars: [], showSystemCalendarSection: false };
    },
}));

import { SettingsView } from './SettingsView';
import { isDesktopOnboardingHintDismissed } from '../../lib/desktop-onboarding-events';

describe('SettingsView', () => {
    it('loads only visited resource groups and keeps them active across navigation', async () => {
        const { getByRole } = render(
            <LanguageProvider>
                <KeybindingProvider currentView="settings" onNavigate={() => undefined}>
                    <SettingsView />
                </KeybindingProvider>
            </LanguageProvider>
        );
        expect(resourceTracker).toEqual({ sync: false, calendar: false, obsidian: false, advanced: false });
        fireEvent.click(getByRole('button', { name: 'integrations' }));
        expect(resourceTracker).toEqual({ sync: false, calendar: true, obsidian: true, advanced: false });
        fireEvent.click(getByRole('button', { name: 'main' }));
        expect(resourceTracker.calendar).toBe(true);
        fireEvent.click(getByRole('button', { name: 'data' }));
        expect(resourceTracker.sync).toBe(true);
        expect(resourceTracker.advanced).toBe(false);
        fireEvent.click(getByRole('button', { name: 'advanced' }));
        expect(resourceTracker.advanced).toBe(true);
        fireEvent.click(getByRole('button', { name: 'main' }));
        expect(resourceTracker).toEqual({ sync: true, calendar: true, obsidian: true, advanced: true });
        await act(async () => {});
    });

    beforeEach(async () => {
        pendingIntegrations = null;
        window.localStorage.clear();
        calendarHookTracker.mounts = 0;
        calendarHookTracker.unmounts = 0;
        aiHookTracker.enabled = [];
        calendarHookUseEffect = (await import('react')).useEffect;
        Object.defineProperty(window, 'requestAnimationFrame', {
            writable: true,
            value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
        });
        Object.defineProperty(window, 'cancelAnimationFrame', {
            writable: true,
            value: (id: number) => window.clearTimeout(id),
        });
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

    it('activates AI loading only while the AI settings page is open', async () => {
        const { getByRole } = render(
            <LanguageProvider>
                <KeybindingProvider currentView="settings" onNavigate={() => undefined}>
                    <SettingsView />
                </KeybindingProvider>
            </LanguageProvider>
        );

        expect(aiHookTracker.enabled[aiHookTracker.enabled.length - 1]).toBe(false);

        fireEvent.click(getByRole('button', { name: 'ai' }));

        await waitFor(() => {
            expect(aiHookTracker.enabled[aiHookTracker.enabled.length - 1]).toBe(true);
        });
    });

    it('keeps the current settings page visible until the requested page is ready', async () => {
        const { getByRole, getByText, queryByText } = render(
            <LanguageProvider>
                <KeybindingProvider currentView="settings" onNavigate={() => undefined}>
                    <SettingsView />
                </KeybindingProvider>
            </LanguageProvider>
        );
        await waitFor(() => expect(getByText('main-page')).toBeVisible());
        let resolvePage!: () => void;
        pendingIntegrations = new Promise<void>((resolve) => { resolvePage = resolve; });
        fireEvent.click(getByRole('button', { name: 'integrations' }));
        expect(getByText('main-page')).toBeVisible();
        expect(getByRole('main')).toHaveAttribute('aria-busy', 'true');
        await act(async () => {
            pendingIntegrations = null;
            resolvePage();
        });
        await waitFor(() => expect(getByText('integrations-page')).toBeVisible());
        expect(queryByText('main-page')).not.toBeInTheDocument();
        expect(getByRole('main')).toHaveAttribute('aria-busy', 'false');
    });

    it('keeps integrations state mounted across parent rerenders', async () => {
        const { getByRole, getByText } = render(
            <LanguageProvider>
                <KeybindingProvider currentView="settings" onNavigate={() => undefined}>
                    <SettingsView />
                </KeybindingProvider>
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getByRole('button', { name: 'integrations' }));
        });

        await waitFor(() => {
            expect(getByText('integrations-page')).toBeInTheDocument();
        });

        expect(calendarHookTracker.mounts).toBe(1);
        expect(calendarHookTracker.unmounts).toBe(0);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...(state.settings ?? {}),
                    sidebarCollapsed: true,
                },
            }));
        });

        await waitFor(() => {
            expect(getByText('integrations-page')).toBeInTheDocument();
        });

        expect(calendarHookTracker.mounts).toBe(1);
        expect(calendarHookTracker.unmounts).toBe(0);
    });

    it('opens an initial settings page when requested', async () => {
        const { getByText } = render(
            <LanguageProvider>
                <KeybindingProvider currentView="settings" onNavigate={() => undefined}>
                    <SettingsView initialPage="sync" />
                </KeybindingProvider>
            </LanguageProvider>
        );

        await waitFor(() => {
            expect(getByText('sync-page')).toBeInTheDocument();
        });
    });

    it('shows and dismisses a local onboarding handoff hint for settings destinations', async () => {
        const onResumeOnboarding = vi.fn();
        const { getByLabelText, getByText, queryByText } = render(
            <LanguageProvider>
                <KeybindingProvider currentView="settings" onNavigate={() => undefined}>
                    <SettingsView
                        initialPage="sync"
                        onboardingHintPage="sync"
                        onResumeOnboarding={onResumeOnboarding}
                    />
                </KeybindingProvider>
            </LanguageProvider>
        );

        await waitFor(() => {
            expect(getByText('Recommended sync path')).toBeInTheDocument();
        });

        fireEvent.click(getByText('Continue setup'));
        expect(onResumeOnboarding).toHaveBeenCalledTimes(1);

        fireEvent.click(getByLabelText('Dismiss onboarding hint'));

        expect(queryByText('Recommended sync path')).not.toBeInTheDocument();
        expect(isDesktopOnboardingHintDismissed('sync')).toBe(true);
        expect(isDesktopOnboardingHintDismissed('data')).toBe(false);
    });
});
