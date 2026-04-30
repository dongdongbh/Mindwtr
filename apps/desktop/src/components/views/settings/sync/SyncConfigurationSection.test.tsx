import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SyncConfigurationSection } from './SyncConfigurationSection';

const baseProps: Parameters<typeof SyncConfigurationSection>[0] = {
    t: {
        sync: 'Sync',
        syncDescription: 'Sync description',
        syncBackend: 'Sync backend',
        syncBackendOff: 'Off',
        syncBackendFile: 'File',
        syncBackendWebdav: 'WebDAV',
        syncBackendCloud: 'Self-Hosted',
        syncFolderLocation: 'Folder',
        savePath: 'Save',
        browse: 'Browse',
        pathHint: 'Path hint',
        webdavUrl: 'WebDAV URL',
        webdavHint: 'WebDAV hint',
        webdavUsername: 'Username',
        webdavPassword: 'Password',
        webdavSave: 'Save WebDAV',
        testConnection: 'Test connection',
        webdavTestHint: 'WebDAV test hint',
        webdavTestAccessibility: 'Test WebDAV connection',
        cloudUrl: 'Cloud URL',
        cloudHint: 'Cloud hint',
        cloudToken: 'Cloud token',
        cloudSave: 'Save cloud',
        cloudProvider: 'Cloud provider',
        cloudProviderSelfHosted: 'Self-hosted',
        cloudProviderDropbox: 'Dropbox',
        cloudProviderCloudkit: 'iCloud',
        cloudkitDesc: 'CloudKit description',
        dropboxAppKey: 'Dropbox account',
        dropboxAppKeyHint: 'Dropbox app key is injected at build/release time.',
        dropboxRedirectUri: 'Redirect URI',
        dropboxStatus: 'Status',
        dropboxConnected: 'Connected',
        dropboxNotConnected: 'Not connected',
        dropboxConnect: 'Connect Dropbox',
        dropboxDisconnect: 'Disconnect Dropbox',
        dropboxTest: 'Test connection',
        dropboxTestReachable: 'Reachable',
        dropboxTestFailed: 'Failed',
    } as any,
    isTauri: true,
    syncBackend: 'cloud',
    onSetSyncBackend: vi.fn(),
    syncPath: '',
    onSyncPathChange: vi.fn(),
    onSaveSyncPath: vi.fn(),
    onBrowseSyncPath: vi.fn(),
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    webdavHasPassword: false,
    isSavingWebDav: false,
    isTestingWebDav: false,
    webdavTestState: 'idle',
    onWebdavUrlChange: vi.fn(),
    onWebdavUsernameChange: vi.fn(),
    onWebdavPasswordChange: vi.fn(),
    onSaveWebDav: vi.fn(),
    onTestWebDavConnection: vi.fn(),
    cloudUrl: '',
    cloudToken: '',
    cloudProvider: 'dropbox',
    dropboxConfigured: true,
    dropboxConnected: true,
    dropboxBusy: false,
    dropboxAuthInProgress: false,
    dropboxRedirectUri: 'http://127.0.0.1:53682/oauth/dropbox/callback',
    dropboxTestState: 'idle',
    onCloudUrlChange: vi.fn(),
    onCloudTokenChange: vi.fn(),
    onCloudProviderChange: vi.fn(),
    onSaveCloud: vi.fn(),
    onConnectDropbox: vi.fn(),
    onDisconnectDropbox: vi.fn(),
    onTestDropboxConnection: vi.fn(),
    isMacOS: false,
    webdavUrlError: false,
    cloudUrlError: false,
};

describe('SyncConfigurationSection', () => {
    it('hides the Dropbox redirect URI when OAuth is not in progress', () => {
        const { queryByText } = render(<SyncConfigurationSection {...baseProps} />);

        expect(queryByText(/Redirect URI:/i)).not.toBeInTheDocument();
    });

    it('shows the Dropbox redirect URI while OAuth is in progress', () => {
        const { getByText } = render(
            <SyncConfigurationSection
                {...baseProps}
                dropboxAuthInProgress
            />
        );

        expect(getByText(/Redirect URI:/i)).toBeInTheDocument();
        expect(getByText(baseProps.dropboxRedirectUri)).toBeInTheDocument();
    });
});
