import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';

const calendarHookTracker = {
    mounts: 0,
    unmounts: 0,
};
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
    SettingsIntegrationsPage: () => <div>integrations-page</div>,
}));

vi.mock('./settings/useAiSettings', () => ({
    useAiSettings: () => ({
        aiEnabled: false,
        aiProvider: 'openai',
        aiModel: '',
        aiBaseUrl: '',
        aiModelOptions: [],
        aiCopilotModel: '',
        aiCopilotOptions: [],
        aiReasoningEffort: 'medium',
        aiThinkingBudget: 0,
        anthropicThinkingEnabled: false,
        anthropicThinkingOptions: [],
        aiApiKey: '',
        speechEnabled: false,
        speechProvider: 'openai',
        speechModel: '',
        speechModelOptions: [],
        speechLanguage: '',
        speechMode: 'push-to-talk',
        speechFieldStrategy: 'append',
        speechApiKey: '',
        speechOfflineReady: false,
        speechOfflineSize: null,
        speechDownloadState: 'idle',
        speechDownloadError: null,
        onUpdateAISettings: vi.fn(),
        onUpdateSpeechSettings: vi.fn(),
        onProviderChange: vi.fn(),
        onSpeechProviderChange: vi.fn(),
        onToggleAnthropicThinking: vi.fn(),
        onAiApiKeyChange: vi.fn(),
        onSpeechApiKeyChange: vi.fn(),
        onDownloadWhisperModel: vi.fn(),
        onDeleteWhisperModel: vi.fn(),
    }),
}));

vi.mock('./settings/useSyncSettings', () => ({
    useSyncSettings: () => ({
        syncBackend: 'local',
        syncPath: '',
        setSyncPath: vi.fn(),
        webdavUrl: '',
        setWebdavUrl: vi.fn(),
        webdavUsername: '',
        setWebdavUsername: vi.fn(),
        webdavPassword: '',
        setWebdavPassword: vi.fn(),
        webdavHasPassword: false,
        isSavingWebDav: false,
        isTestingWebDav: false,
        webdavTestState: null,
        cloudUrl: '',
        setCloudUrl: vi.fn(),
        cloudToken: '',
        setCloudToken: vi.fn(),
        cloudProvider: 'mindwtr-cloud',
        dropboxAppKey: '',
        dropboxConfigured: false,
        dropboxConnected: false,
        dropboxBusy: false,
        dropboxAuthInProgress: false,
        dropboxRedirectUri: '',
        dropboxTestState: null,
        isSyncing: false,
        syncQueued: false,
        syncLastResult: null,
        syncLastResultAt: null,
        syncError: null,
        lastSyncDisplay: '',
        lastSyncStatus: 'idle',
        lastSyncStats: null,
        lastSyncHistory: [],
        conflictCount: 0,
        attachmentsLastCleanupDisplay: '',
        snapshots: [],
        isLoadingSnapshots: false,
        isRestoringSnapshot: false,
        handleSaveSyncPath: vi.fn(),
        handleChangeSyncLocation: vi.fn(),
        handleSetSyncBackend: vi.fn(),
        handleSaveWebDav: vi.fn(),
        handleTestWebDavConnection: vi.fn(),
        handleSaveCloud: vi.fn(),
        handleSetCloudProvider: vi.fn(),
        handleConnectDropbox: vi.fn(),
        handleDisconnectDropbox: vi.fn(),
        handleTestDropboxConnection: vi.fn(),
        handleSync: vi.fn(),
        handleRestoreSnapshot: vi.fn(),
    }),
}));

vi.mock('./settings/useObsidianSettings', () => ({
    useObsidianSettings: () => ({
        obsidianVaultPath: '',
        setObsidianVaultPath: vi.fn(),
        obsidianEnabled: false,
        setObsidianEnabled: vi.fn(),
        obsidianScanFoldersText: '/',
        setObsidianScanFoldersText: vi.fn(),
        obsidianInboxFile: 'Mindwtr/Inbox.md',
        setObsidianInboxFile: vi.fn(),
        obsidianTaskNotesIncludeArchived: false,
        setObsidianTaskNotesIncludeArchived: vi.fn(),
        obsidianNewTaskFormat: 'auto',
        setObsidianNewTaskFormat: vi.fn(),
        obsidianLastScannedAt: null,
        obsidianHasVaultMarker: null,
        obsidianVaultWarning: null,
        obsidianIsWatching: false,
        obsidianWatcherError: null,
        isSavingObsidian: false,
        isScanningObsidian: false,
        onBrowseObsidianVault: vi.fn(),
        onSaveObsidian: vi.fn(),
        onRemoveObsidian: vi.fn(),
        onRescanObsidian: vi.fn(),
    }),
}));

vi.mock('./settings/useCalendarSettings', () => ({
    useCalendarSettings: () => {
        if (!calendarHookUseEffect) {
            throw new Error('calendar hook useEffect not initialized');
        }

        calendarHookUseEffect(() => {
            calendarHookTracker.mounts += 1;
            return () => {
                calendarHookTracker.unmounts += 1;
            };
        }, []);

        return {
            externalCalendars: [],
            newCalendarName: '',
            newCalendarUrl: '',
            calendarError: null,
            systemCalendarPermission: 'unsupported',
            setNewCalendarName: vi.fn(),
            setNewCalendarUrl: vi.fn(),
            handleAddCalendar: vi.fn(),
            handleToggleCalendar: vi.fn(),
            handleRemoveCalendar: vi.fn(),
            handleRequestSystemCalendarPermission: vi.fn(),
        };
    },
}));

import { SettingsView } from './SettingsView';

describe('SettingsView', () => {
    beforeEach(async () => {
        calendarHookTracker.mounts = 0;
        calendarHookTracker.unmounts = 0;
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
});
