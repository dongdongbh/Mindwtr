import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SettingsObsidianSection } from './SettingsObsidianSection';

const t = {
    obsidianIntegrationGuideTitle: 'Obsidian integration guide',
    obsidianVault: 'Obsidian vault import',
    obsidianVaultDesc: 'Import tasks from a local Obsidian vault.',
    obsidianEnable: 'Enable Obsidian integration',
    obsidianVaultPath: 'Vault folder',
    obsidianVaultPathHint: 'Select the root folder of your vault.',
    obsidianDetectedVaults: 'Detected vaults:',
    obsidianScanFolders: 'Scan folders',
    obsidianScanFoldersHint: 'One relative folder per line.',
    obsidianRequiredInlineTag: 'Required inline task tag',
    obsidianRequiredInlineTagHint: 'Only checkbox tags count.',
    obsidianInboxFile: 'Mindwtr inbox note',
    obsidianInboxFileHint: 'Relative path for new notes.',
    obsidianDataview: 'Dataview metadata',
    obsidianDataviewDesc: 'Read Dataview fields.',
    obsidianDataviewMetadata: 'Import Dataview fields',
    obsidianDataviewMetadataHint: 'Reads project:: and due:: fields.',
    obsidianTaskNotes: 'TaskNotes',
    obsidianTaskNotesDesc: 'TaskNotes file options.',
    obsidianTaskNotesIncludeArchived: 'Include archived TaskNotes',
    obsidianTaskNotesIncludeArchivedHint: 'Keep archived TaskNotes visible.',
    obsidianNewTaskFormat: 'New task format',
    obsidianNewTaskFormatHint: 'Choose how new notes are written.',
    obsidianNewTaskFormatAuto: 'Auto-detect',
    obsidianNewTaskFormatInline: 'Inline',
    obsidianNewTaskFormatTaskNotes: 'TaskNotes',
    obsidianWatching: 'Watching vault',
    obsidianWatcherUnavailable: 'Watcher unavailable.',
    obsidianSave: 'Save Obsidian settings',
    obsidianRemove: 'Disconnect vault',
    obsidianRescan: 'Rescan vault',
    obsidianRescanning: 'Rescanning…',
    obsidianLastScanned: 'Last Obsidian scan',
    obsidianNeverScanned: 'Never scanned',
    obsidianMissingMarker: 'Missing .obsidian folder',
    browse: 'Browse...',
};

const baseProps: Parameters<typeof SettingsObsidianSection>[0] = {
    t,
    isTauri: false,
    obsidianVaultPath: '',
    obsidianEnabled: false,
    obsidianScanFoldersText: '/',
    obsidianRequiredInlineTag: '',
    onObsidianRequiredInlineTagChange: vi.fn(),
    obsidianInboxFile: 'Mindwtr/Inbox.md',
    obsidianTaskNotesIncludeArchived: false,
    obsidianDataviewMetadataEnabled: false,
    obsidianNewTaskFormat: 'auto',
    obsidianLastScannedAt: null,
    obsidianHasVaultMarker: null,
    obsidianVaultWarning: null,
    obsidianIsWatching: false,
    obsidianWatcherError: null,
    isSavingObsidian: false,
    isScanningObsidian: false,
    onObsidianVaultPathChange: vi.fn(),
    onObsidianEnabledChange: vi.fn(),
    onObsidianScanFoldersTextChange: vi.fn(),
    onObsidianInboxFileChange: vi.fn(),
    onObsidianTaskNotesIncludeArchivedChange: vi.fn(),
    onObsidianDataviewMetadataEnabledChange: vi.fn(),
    onObsidianNewTaskFormatChange: vi.fn(),
    onBrowseObsidianVault: vi.fn(),
    onSaveObsidian: vi.fn(),
    onRemoveObsidian: vi.fn(),
    onRescanObsidian: vi.fn(),
};

describe('SettingsObsidianSection', () => {
    it('links to the Obsidian integration guide in the docs site', () => {
        const { getByRole } = render(<SettingsObsidianSection {...baseProps} />);

        expect(getByRole('link', { name: /Obsidian integration guide/ })).toHaveAttribute(
            'href',
            'https://docs.mindwtr.app/power-users/obsidian',
        );
    });

    it('starts collapsed and expands on demand', () => {
        const { getByRole, queryByText, getByText } = render(<SettingsObsidianSection {...baseProps} />);

        const toggle = getByRole('button', { name: /Obsidian vault import/i });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(queryByText('Vault folder')).not.toBeInTheDocument();

        fireEvent.click(toggle);

        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(getByText('Vault folder')).toBeInTheDocument();
        expect(getByText('Save Obsidian settings')).toBeInTheDocument();
    });

    it('toggles Dataview metadata import from the expanded settings', () => {
        const onChange = vi.fn();
        const { getAllByRole, getByRole } = render(
            <SettingsObsidianSection
                {...baseProps}
                onObsidianDataviewMetadataEnabledChange={onChange}
            />
        );

        fireEvent.click(getByRole('button', { name: /Obsidian vault import/i }));
        fireEvent.click(getAllByRole('switch')[1]);

        expect(onChange).toHaveBeenCalledWith(true);
    });
});
