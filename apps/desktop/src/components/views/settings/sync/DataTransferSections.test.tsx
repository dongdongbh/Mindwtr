import { act, fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { expandSettingsSection } from '../settings-search';
import { BackupSection, ImportSection } from './DataTransferSections';

const labels = {
    backup: 'Backup',
    backupDesc: 'Export, restore or merge a backup.',
    importData: 'Import Data',
    importDataDesc: 'Import exports from other apps.',
    gettingStartedContentAction: 'Localized Getting Started recovery',
    gettingStartedContentDesc: 'Localized guided setup description.',
    importSetupGuideTitle: 'Localized import guide',
    exportBackup: 'Export Backup',
    exportBackupDesc: 'Save backup.',
    restoreBackup: 'Restore Backup',
    restoreBackupDesc: 'Restore backup.',
    mergeBackup: 'Merge Backup',
    mergeBackupDesc: 'Merge a backup.',
    importTodoist: 'Import from Todoist',
    importTodoistDesc: 'Import Todoist exports.',
    importTickTick: 'Import from TickTick',
    importTickTickDesc: 'Import TickTick exports.',
    importDgt: 'Import from DGT GTD',
    importDgtDesc: 'Import DGT GTD exports.',
    importOmniFocus: 'Import from OmniFocus',
    importOmniFocusDesc: 'Import OmniFocus exports.',
    importMindwtrCsv: 'Import from Mindwtr CSV',
    importMindwtrCsvDesc: 'Import a Mindwtr CSV file.',
    syncing: 'Working...',
};

const backupProps = {
    t: labels,
    transferAction: null,
    onExportBackup: vi.fn(),
    onExportCsv: vi.fn(),
    onExportTaskNotes: vi.fn(),
    onRestoreBackup: vi.fn(),
    onMergeBackup: vi.fn(),
    onAddGettingStartedContent: vi.fn(),
} as unknown as ComponentProps<typeof BackupSection>;

const importProps = {
    t: labels,
    transferAction: null,
    onImportTodoist: vi.fn(),
    onImportTickTick: vi.fn(),
    onImportDgt: vi.fn(),
    onImportOmniFocus: vi.fn(),
    onImportMindwtrCsv: vi.fn(),
} as unknown as ComponentProps<typeof ImportSection>;


function expandRows(getByRole: ReturnType<typeof render>['getByRole'], name: RegExp) {
    fireEvent.click(getByRole('button', { name }));
}

describe('BackupSection', () => {
    it.each([
        ['export', /export backup/i],
        ['restore', /restore backup/i],
        ['merge', /merge backup/i],
    ] as const)('shows progress only on the active %s row', (transferAction, activeLabel) => {
        const { getAllByText, getByRole } = render(
            <BackupSection {...backupProps} transferAction={transferAction} />
        );
        expandRows(getByRole, /^backup/i);

        const statuses = getAllByText('Working...');
        expect(statuses).toHaveLength(1);
        expect(statuses[0].closest('button')).toBe(getByRole('button', { name: activeLabel }));
    });

    it('keeps the backup rows folded behind the header until it is expanded', () => {
        const { getByRole, queryByRole } = render(<BackupSection {...backupProps} />);

        const header = getByRole('button', { name: /^backup/i });
        expect(header).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: /export backup/i })).toBeNull();

        fireEvent.click(header);

        expect(header).toHaveAttribute('aria-expanded', 'true');
        expect(getByRole('button', { name: /export backup/i })).toBeTruthy();
    });


    it('unfolds when settings search reveals a backup row, and leaves imports alone', () => {
        const { getByRole, queryByRole } = render(
            <>
                <BackupSection {...backupProps} />
                <ImportSection {...importProps} />
            </>
        );

        let expanded = false;
        act(() => {
            expanded = expandSettingsSection('backup');
        });

        expect(expanded).toBe(true);
        expect(getByRole('button', { name: /restore backup/i })).toBeTruthy();
        expect(getByRole('button', { name: /^import data/i })).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: /import from omnifocus/i })).toBeNull();
    });

    it('offers merging a backup beside restoring one', () => {
        const onMergeBackup = vi.fn();
        const onRestoreBackup = vi.fn();
        const { getByRole } = render(
            <BackupSection
                {...backupProps}
                onMergeBackup={onMergeBackup}
                onRestoreBackup={onRestoreBackup}
            />
        );
        expandRows(getByRole, /^backup/i);

        fireEvent.click(getByRole('button', { name: /merge backup/i }));

        expect(onMergeBackup).toHaveBeenCalledTimes(1);
        expect(onRestoreBackup).not.toHaveBeenCalled();
    });

    it('exposes a recovery action for Getting Started content', () => {
        const onAddGettingStartedContent = vi.fn();
        const { getByRole, getByText } = render(
            <BackupSection
                {...backupProps}
                onAddGettingStartedContent={onAddGettingStartedContent}
            />
        );
        expandRows(getByRole, /^backup/i);

        fireEvent.click(getByRole('button', { name: /localized getting started recovery/i }));

        expect(onAddGettingStartedContent).toHaveBeenCalledTimes(1);
        expect(getByText('Localized guided setup description.')).toBeTruthy();
    });
});

describe('ImportSection', () => {
    it.each([
        ['import:todoist', /import from todoist/i],
        ['import:ticktick', /import from ticktick/i],
        ['import:dgt', /import from dgt gtd/i],
        ['import:omnifocus', /import from omnifocus/i],
        ['import:mindwtr-csv', /import from mindwtr csv/i],
    ] as const)('shows progress only on the active %s row', (transferAction, activeLabel) => {
        const { getAllByText, getByRole } = render(
            <ImportSection {...importProps} transferAction={transferAction} />
        );
        expandRows(getByRole, /^import data/i);

        const statuses = getAllByText('Working...');
        expect(statuses).toHaveLength(1);
        expect(statuses[0].closest('button')).toBe(getByRole('button', { name: activeLabel }));
    });

    it('links to the import guide in the docs site', () => {
        const { getByRole } = render(<ImportSection {...importProps} />);
        expandRows(getByRole, /^import data/i);

        expect(getByRole('link', { name: /Localized import guide/ })).toHaveAttribute(
            'href',
            'https://docs.mindwtr.app/import/'
        );
    });

    it('keeps the importers folded behind the header until it is expanded', () => {
        const { getByRole, queryByRole } = render(<ImportSection {...importProps} />);

        const header = getByRole('button', { name: /^import data/i });
        expect(header).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: /import from todoist/i })).toBeNull();

        fireEvent.click(header);

        expect(header).toHaveAttribute('aria-expanded', 'true');
        expect(getByRole('button', { name: /import from todoist/i })).toBeTruthy();
    });

    it('unfolds when settings search reveals an importer, and leaves backup alone', () => {
        const { getByRole, queryByRole } = render(
            <>
                <BackupSection {...backupProps} />
                <ImportSection {...importProps} />
            </>
        );

        let expanded = false;
        act(() => {
            expanded = expandSettingsSection('importData');
        });

        expect(expanded).toBe(true);
        expect(getByRole('button', { name: /import from omnifocus/i })).toBeTruthy();
        expect(getByRole('button', { name: /^backup/i })).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: /restore backup/i })).toBeNull();
    });

    it('calls the TickTick import action', () => {
        const onImportTickTick = vi.fn();
        const { getByRole } = render(
            <ImportSection
                {...importProps}
                onImportTickTick={onImportTickTick}
            />
        );
        expandRows(getByRole, /^import data/i);

        fireEvent.click(getByRole('button', { name: /import from ticktick/i }));

        expect(onImportTickTick).toHaveBeenCalledTimes(1);
    });
});
