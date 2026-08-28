import { fireEvent, render } from '@testing-library/react';
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
        syncBackendCloudkit: 'iCloud',
        syncBackendChoiceHint: 'Choose one sync method. Turn sync off to keep data local to this device.',
        syncBackendGroupCloud: 'Cloud Sync',
        syncBackendGroupCloudDesc: 'Easy account sync handled by Mindwtr.',
        syncBackendGroupFile: 'Folder / File Sync',
        syncBackendGroupFileDesc: 'Bring your own local synced folder.',
        syncBackendGroupAdvanced: 'Advanced / Custom Server',
        syncBackendGroupAdvancedDesc: 'Use WebDAV or your own Mindwtr Cloud endpoint.',
        syncFolderLocation: 'Folder',
        savePath: 'Save',
        browse: 'Browse',
        testFolder: 'Test folder',
        testingFolder: 'Testing folder…',
        folderTestSucceeded: 'Folder test passed.',
        portalPathNote: 'This path is a sandbox mapping to the folder you chose. External tools should watch the original folder.',
        pathHint: 'Path hint',
        webdavUrl: 'WebDAV URL',
        webdavHint: 'WebDAV hint',
        webdavUsername: 'Username',
        webdavPassword: 'Password',
        webdavSave: 'Save WebDAV',
        testConnection: 'Test connection',
        webdavTestHint: 'WebDAV test hint',
        webdavTestAccessibility: 'Test WebDAV connection',
        allowInsecureHttp: 'Allow insecure connections',
        allowInsecureHttpHint: 'Only use this on trusted networks.',
        cloudUrl: 'Cloud URL',
        cloudHint: 'Cloud hint',
        cloudToken: 'Cloud token',
        cloudRememberToken: 'Remember token on this browser',
        cloudRememberTokenHint: 'Remember token hint',
        cloudSave: 'Save cloud',
        cloudProvider: 'Cloud provider',
        cloudProviderSelfHosted: 'Self-hosted',
        cloudProviderDropbox: 'Dropbox',
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
        calendarFeed: 'Calendar subscription',
        calendarFeedDesc: 'Publish a read-only feed.',
        calendarFeedWarning: 'Anyone with this URL can read the feed.',
        calendarFeedNone: 'No feed published yet.',
        calendarFeedCopy: 'Copy URL',
        calendarFeedGenerate: 'Generate URL',
        calendarFeedRegenerate: 'Regenerate',
        calendarFeedRevoke: 'Revoke',
    } as any,
    isTauri: true,
    syncBackend: 'cloud',
    onSetSyncBackend: vi.fn(),
    syncPath: '',
    onSyncPathChange: vi.fn(),
    onSaveSyncPath: vi.fn(),
    onBrowseSyncPath: vi.fn(),
    isTestingSyncPath: false,
    onTestSyncPath: vi.fn(),
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    webdavHasPassword: false,
    webdavAllowInsecureHttp: false,
    isSavingWebDav: false,
    isTestingWebDav: false,
    webdavTestState: 'idle',
    onWebdavUrlChange: vi.fn(),
    onWebdavUsernameChange: vi.fn(),
    onWebdavPasswordChange: vi.fn(),
    onWebdavAllowInsecureHttpChange: vi.fn(),
    onSaveWebDav: vi.fn(),
    onTestWebDavConnection: vi.fn(),
    cloudUrl: '',
    cloudToken: '',
    cloudRememberToken: false,
    cloudAllowInsecureHttp: false,
    cloudProvider: 'dropbox',
    dropboxConfigured: true,
    dropboxConnected: true,
    dropboxBusy: false,
    dropboxAuthInProgress: false,
    dropboxRedirectUri: 'http://127.0.0.1:53682/oauth/dropbox/callback',
    dropboxTestState: 'idle',
    onCloudUrlChange: vi.fn(),
    onCloudTokenChange: vi.fn(),
    onCloudRememberTokenChange: vi.fn(),
    onCloudAllowInsecureHttpChange: vi.fn(),
    onCloudProviderChange: vi.fn(),
    onSaveCloud: vi.fn(),
    calendarFeedUrl: null,
    calendarFeedBusy: false,
    onCopyCalendarFeedUrl: vi.fn(),
    onGenerateCalendarFeed: vi.fn(),
    onRevokeCalendarFeed: vi.fn(),
    onConnectDropbox: vi.fn(),
    onDisconnectDropbox: vi.fn(),
    onTestDropboxConnection: vi.fn(),
    isMacOS: false,
    webdavUrlError: false,
    cloudUrlError: false,
};

describe('SyncConfigurationSection', () => {
    it('offers a folder test and explains document-portal paths', () => {
        const onTestSyncPath = vi.fn();
        const { getByRole, getByText, queryByText, rerender } = render(
            <SyncConfigurationSection
                {...baseProps}
                syncBackend="file"
                syncPath="/run/user/1000/doc/portal-id/Sync"
                onTestSyncPath={onTestSyncPath}
            />
        );

        fireEvent.click(getByRole('button', { name: 'Test folder' }));

        expect(onTestSyncPath).toHaveBeenCalledTimes(1);
        expect(getByText(baseProps.t.portalPathNote)).toBeInTheDocument();

        rerender(
            <SyncConfigurationSection
                {...baseProps}
                syncBackend="file"
                syncPath="/home/user/Sync"
                onTestSyncPath={onTestSyncPath}
            />
        );
        expect(queryByText(baseProps.t.portalPathNote)).not.toBeInTheDocument();
    });

    it('disables the folder test while it is running', () => {
        const { getByRole } = render(
            <SyncConfigurationSection
                {...baseProps}
                syncBackend="file"
                syncPath="/home/user/Sync"
                isTestingSyncPath
            />
        );

        expect(getByRole('button', { name: 'Testing folder…' })).toBeDisabled();
    });

    it('shows Dropbox as a first-level sync backend without the nested cloud provider picker', () => {
        const { getByRole, queryByText } = render(<SyncConfigurationSection {...baseProps} />);
        const dropboxButton = getByRole('button', { name: /^Dropbox$/ });
        const selfHostedButton = getByRole('button', { name: /^Self-hosted$/ });

        expect(dropboxButton).toBeInTheDocument();
        expect(dropboxButton).toHaveAttribute('aria-pressed', 'true');
        expect(selfHostedButton).toBeInTheDocument();
        expect(selfHostedButton).toHaveAttribute('aria-pressed', 'false');
        expect(queryByText('Cloud Sync')).toBeInTheDocument();
        expect(queryByText('Easy account sync handled by Mindwtr.')).toBeInTheDocument();
        expect(queryByText('Folder / File Sync')).not.toBeInTheDocument();
        expect(queryByText('Advanced / Custom Server')).not.toBeInTheDocument();
        expect(queryByText('Cloud provider')).not.toBeInTheDocument();
        expect(queryByText('Sync description')).not.toBeInTheDocument();
        expect(getByRole('link', { name: /Data and Sync guide/ })).toHaveAttribute(
            'href',
            'https://docs.mindwtr.app/data-sync/'
        );
    });

    it('shows the selected backend group instead of all groups at once', () => {
        const { queryByText } = render(
            <SyncConfigurationSection
                {...baseProps}
                syncBackend="webdav"
                cloudProvider="dropbox"
            />
        );

        expect(queryByText('Advanced / Custom Server')).toBeInTheDocument();
        expect(queryByText('Use WebDAV or your own Mindwtr Cloud endpoint.')).toBeInTheDocument();
        expect(queryByText('Cloud Sync')).not.toBeInTheDocument();
        expect(queryByText('Folder / File Sync')).not.toBeInTheDocument();
    });

    it('uses settings-style switches for insecure HTTP options', () => {
        const onWebdavAllowInsecureHttpChange = vi.fn();
        const { getByRole, queryByRole } = render(
            <SyncConfigurationSection
                {...baseProps}
                syncBackend="webdav"
                onWebdavAllowInsecureHttpChange={onWebdavAllowInsecureHttpChange}
            />
        );

        const switchControl = getByRole('switch', { name: 'Allow insecure connections' });
        expect(switchControl).toHaveAttribute('aria-checked', 'false');
        expect(queryByRole('checkbox')).not.toBeInTheDocument();

        fireEvent.click(switchControl);

        expect(onWebdavAllowInsecureHttpChange).toHaveBeenCalledWith(true);
    });

    it('shows the remember-token switch only for browser self-hosted sync', () => {
        const onCloudRememberTokenChange = vi.fn();
        const { getByRole, rerender, queryByRole } = render(
            <SyncConfigurationSection
                {...baseProps}
                isTauri={false}
                cloudProvider="selfhosted"
                cloudRememberToken={false}
                onCloudRememberTokenChange={onCloudRememberTokenChange}
            />
        );

        const switchControl = getByRole('switch', { name: 'Remember token on this browser' });
        expect(switchControl).toHaveAttribute('aria-checked', 'false');

        fireEvent.click(switchControl);

        expect(onCloudRememberTokenChange).toHaveBeenCalledWith(true);

        rerender(
            <SyncConfigurationSection
                {...baseProps}
                isTauri
                cloudProvider="selfhosted"
                cloudRememberToken={false}
                onCloudRememberTokenChange={onCloudRememberTokenChange}
            />
        );

        expect(queryByRole('switch', { name: 'Remember token on this browser' })).not.toBeInTheDocument();
    });

    it('keeps Dropbox selection backward-compatible with the stored cloud backend shape', () => {
        const onSetSyncBackend = vi.fn();
        const onCloudProviderChange = vi.fn();
        const { getByRole } = render(
            <SyncConfigurationSection
                {...baseProps}
                cloudProvider="selfhosted"
                syncBackend="file"
                onCloudProviderChange={onCloudProviderChange}
                onSetSyncBackend={onSetSyncBackend}
            />
        );

        fireEvent.click(getByRole('button', { name: /^Dropbox$/ }));

        expect(onCloudProviderChange).toHaveBeenCalledWith('dropbox');
        expect(onSetSyncBackend).toHaveBeenCalledWith('cloud');
    });

    it('offers the calendar subscription controls only for self-hosted sync', () => {
        const onGenerateCalendarFeed = vi.fn();
        const { getByRole, queryByRole, queryByText, rerender } = render(
            <SyncConfigurationSection {...baseProps} cloudProvider="dropbox" />
        );

        expect(queryByText('Calendar subscription')).not.toBeInTheDocument();

        rerender(
            <SyncConfigurationSection
                {...baseProps}
                cloudProvider="selfhosted"
                onGenerateCalendarFeed={onGenerateCalendarFeed}
            />
        );

        expect(queryByText('Calendar subscription')).toBeInTheDocument();
        expect(queryByText('Anyone with this URL can read the feed.')).toBeInTheDocument();
        expect(queryByText('No feed published yet.')).toBeInTheDocument();
        // Nothing to copy or revoke until a feed exists.
        expect(queryByRole('button', { name: 'Copy URL' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Generate URL' }));
        expect(onGenerateCalendarFeed).toHaveBeenCalled();
    });

    it('shows the published subscription URL with copy, regenerate and revoke', () => {
        const onCopyCalendarFeedUrl = vi.fn();
        const onRevokeCalendarFeed = vi.fn();
        const { getByDisplayValue, getByRole, queryByRole } = render(
            <SyncConfigurationSection
                {...baseProps}
                cloudProvider="selfhosted"
                calendarFeedUrl="https://example.com/v1/calendar/abc.ics"
                onCopyCalendarFeedUrl={onCopyCalendarFeedUrl}
                onRevokeCalendarFeed={onRevokeCalendarFeed}
            />
        );

        expect(getByDisplayValue('https://example.com/v1/calendar/abc.ics')).toHaveAttribute('readonly');
        expect(queryByRole('button', { name: 'Generate URL' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: 'Regenerate' })).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Copy URL' }));
        fireEvent.click(getByRole('button', { name: 'Revoke' }));

        expect(onCopyCalendarFeedUrl).toHaveBeenCalled();
        expect(onRevokeCalendarFeed).toHaveBeenCalled();
    });

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
