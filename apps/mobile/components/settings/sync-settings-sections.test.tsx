import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { describe, expect, it, vi } from 'vitest';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import {
  BackgroundSyncInfoCard,
  RecoverySnapshotsCard,
  SyncBackupSection,
  SyncPreferencesCard,
} from './sync-settings-sections';

const tc = {
  bg: '#0f172a',
  cardBg: '#111827',
  border: '#334155',
  text: '#f8fafc',
  secondaryText: '#94a3b8',
  tint: '#3b82f6',
} as unknown as ThemeColors;

const translate = (key: string) => key;
const noop = () => undefined;

const baseProps = {
  backupAction: null,
  handleAddGettingStartedContent: noop,
  handleBackup: noop,
  handleExportCsv: noop,
  handleExportTaskNotes: noop,
  handleImportDgt: noop,
  handleImportMindwtrCsv: noop,
  handleImportOmniFocus: noop,
  handleImportTickTick: noop,
  handleImportTodoist: noop,
  handleMergeBackup: noop,
  handleRestoreBackup: noop,
  isBackupBusy: false,
  isGettingStartedDisabled: false,
  isGettingStartedBusy: false,
  isSyncing: false,
  tr: translate,
  t: translate,
  tc,
} as const;

const renderedText = (tree: renderer.ReactTestRenderer): string[] =>
  tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');

describe('SyncBackupSection', () => {
  const actionRows = [
    ['data-transfer-export', 'settings.exportBackup', 'settings.saveToSyncFolder'],
    ['data-transfer-restore', 'settings.syncMobile.restoreBackup', 'settings.syncMobile.replaceLocalDataFromABackupJsonFile'],
    ['data-transfer-merge', 'settings.mergeBackup', 'settings.mergeBackupDesc'],
    ['add-getting-started-content', 'settings.gettingStartedContentAction', 'settings.gettingStartedContentDesc'],
    ['data-transfer-import-todoist', 'settings.syncMobile.importFromTodoist', 'settings.syncMobile.importTodoistCsvOrZipExportsIntoMindwtrProjects'],
    ['data-transfer-import-ticktick', 'settings.syncMobile.importFromTicktick', 'settings.syncMobile.importTicktickCsvOrZipBackupsIntoMindwtrAreas'],
    ['data-transfer-import-dgt', 'settings.syncMobile.importFromDgtGtd', 'settings.syncMobile.importDgtGtdJsonOrZipExportsIntoMindwtrAreas'],
    ['data-transfer-import-omnifocus', 'settings.syncMobile.importFromOmnifocus', 'settings.syncMobile.importOmnifocusCsvJsonOrZipExportsIntoMindwtrProjects'],
    ['data-transfer-import-mindwtr-csv', 'settings.syncMobile.importFromMindwtrCsv', 'settings.syncMobile.importMindwtrCsvFileIntoMindwtrAreasProjectsAndTasks'],
  ] as const;

  function expand(tree: renderer.ReactTestRenderer, ...testIDs: string[]) {
    act(() => {
      for (const testID of testIDs) {
        tree.root.findByProps({ testID }).props.onPress();
      }
    });
  }

  it.each([
    ['import:todoist', 'handleImportTodoist'],
    ['import:ticktick', 'handleImportTickTick'],
    ['import:dgt', 'handleImportDgt'],
    ['import:omnifocus', 'handleImportOmniFocus'],
    ['import:mindwtr-csv', 'handleImportMindwtrCsv'],
  ] as const)('shows one spinner on the active %s row', (backupAction, handlerName) => {
    const handlers = {
      handleImportTodoist: vi.fn(),
      handleImportTickTick: vi.fn(),
      handleImportDgt: vi.fn(),
      handleImportOmniFocus: vi.fn(),
      handleImportMindwtrCsv: vi.fn(),
    };
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SyncBackupSection {...baseProps} {...handlers} backupAction={backupAction} isBackupBusy />,
      );
    });
    expand(tree, 'backup-disclosure', 'import-disclosure');

    const spinners = tree.root.findAllByType(ActivityIndicator);
    expect(spinners).toHaveLength(1);
    expect(spinners[0].parent?.props.onPress).toBe(handlers[handlerName]);
  });

  it('starts with both cards folded, showing only their disclosure headers', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SyncBackupSection {...baseProps} />);
    });

    for (const testID of ['backup-disclosure', 'import-disclosure']) {
      expect(tree.root.findByProps({ testID }).props.accessibilityState, testID).toEqual({ expanded: false });
    }
    const texts = renderedText(tree);
    expect(texts).toContain('settings.backup');
    expect(texts).toContain('settings.importData');
    expect(texts).not.toContain('settings.exportBackup');
    expect(texts).not.toContain('settings.syncMobile.importFromTodoist');
    const chevrons = tree.root.findAllByType(Ionicons);
    expect(chevrons).toHaveLength(2);
    for (const chevron of chevrons) {
      expect(chevron.props.accessible).toBe(false);
      expect(chevron.props.accessibilityElementsHidden).toBe(true);
      expect(chevron.props.importantForAccessibility).toBe('no-hide-descendants');
    }
  });

  // The split the maintainer asked for: opening one card must not drag the
  // other errand's rows in with it.
  it('reveals only the backup rows when the backup header is pressed', () => {
    const handleBackup = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SyncBackupSection {...baseProps} handleBackup={handleBackup} />);
    });

    expand(tree, 'backup-disclosure');

    expect(tree.root.findByProps({ testID: 'backup-disclosure' }).props.accessibilityState)
      .toEqual({ expanded: true });
    expect(tree.root.findByProps({ testID: 'import-disclosure' }).props.accessibilityState)
      .toEqual({ expanded: false });
    const texts = renderedText(tree);
    expect(texts).toContain('settings.exportBackup');
    expect(texts).toContain('settings.gettingStartedContentAction');
    expect(texts).not.toContain('settings.syncMobile.importFromMindwtrCsv');

    act(() => {
      tree.root.findAllByProps({ onPress: handleBackup })[0].props.onPress();
    });
    expect(handleBackup).toHaveBeenCalledTimes(1);
  });

  it('reveals only the importers when the import header is pressed, guide link first', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SyncBackupSection {...baseProps} importGuide={<Text>import-guide</Text>} />,
      );
    });

    expand(tree, 'import-disclosure');

    const texts = renderedText(tree);
    expect(texts).toContain('settings.syncMobile.importFromMindwtrCsv');
    expect(texts).not.toContain('settings.exportBackup');
    expect(texts.indexOf('import-guide')).toBeLessThan(
      texts.indexOf('settings.syncMobile.importFromTodoist'),
    );
  });

  it('exposes every revealed data action as a named button with disabled and busy state', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SyncBackupSection
          {...baseProps}
          backupAction="import:ticktick"
          isBackupBusy
        />,
      );
    });
    expand(tree, 'backup-disclosure', 'import-disclosure');

    for (const [testID, label, hint] of actionRows) {
      const row = tree.root.findByProps({ testID });
      expect(row.props.accessibilityRole, testID).toBe('button');
      expect(row.props.accessibilityLabel, testID).toBe(label);
      expect(row.props.accessibilityHint, testID).toBe(hint);
      expect(row.props.accessibilityState, testID).toEqual({
        busy: testID === 'data-transfer-import-ticktick',
        disabled: true,
      });
    }

    for (const spinner of tree.root.findAllByType(ActivityIndicator)) {
      expect(spinner.props.accessible).toBe(false);
      expect(spinner.props.accessibilityElementsHidden).toBe(true);
      expect(spinner.props.importantForAccessibility).toBe('no-hide-descendants');
    }
  });

  it('offers Getting Started recovery from the normal folded backup section', () => {
    const handleAddGettingStartedContent = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SyncBackupSection
          {...baseProps}
          handleAddGettingStartedContent={handleAddGettingStartedContent}
        />,
      );
    });

    expand(tree, 'backup-disclosure');

    expect(renderedText(tree)).toContain('settings.gettingStartedContentAction');
    expect(renderedText(tree)).toContain('settings.gettingStartedContentDesc');
    act(() => {
      tree.root.findByProps({ testID: 'add-getting-started-content' }).props.onPress();
    });
    expect(handleAddGettingStartedContent).toHaveBeenCalledTimes(1);
  });

  it('exposes the Getting Started action as a disabled button without a false busy spinner', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SyncBackupSection
          {...baseProps}
          isGettingStartedDisabled
          isGettingStartedBusy={false}
        />,
      );
    });
    expand(tree, 'backup-disclosure');

    const action = tree.root.findByProps({ testID: 'add-getting-started-content' });
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.accessibilityState).toEqual({ busy: false, disabled: true });
    expect(action.props.disabled).toBe(true);
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
  });
});

describe('sync settings disclosure accessibility', () => {
  it('shows activity only on the exact recovery snapshot', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <RecoverySnapshotsCard
          backupAction="snapshot:data.second.snapshot.json"
          formatRecoverySnapshotLabel={(name) => name}
          handleRestoreRecoverySnapshot={noop}
          isBackupBusy
          isLoadingRecoverySnapshots={false}
          isSyncing={false}
          recoverySnapshots={['data.first.snapshot.json', 'data.second.snapshot.json']}
          recoverySnapshotsOpen
          setRecoverySnapshotsOpen={noop}
          tr={translate}
          t={translate}
          tc={tc}
        />,
      );
    });

    const spinners = tree.root.findAllByType(ActivityIndicator);
    expect(spinners).toHaveLength(1);
    expect(
      spinners[0].parent?.findAllByType(Text).some((node) => node.props.children === 'data.second.snapshot.json'),
    ).toBe(true);
  });

  it('gives same-minute recovery snapshots unique names and exact busy and disabled states', () => {
    const tr = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => (
      values?.snapshotName ? `${key}:${values.snapshotName}` : key
    );
    const firstSnapshot = 'data.2026-08-09T12-34-05.snapshot.json';
    const secondSnapshot = 'data.2026-08-09T12-34-52.snapshot.json';
    const visualMinuteLabel = '8/9/2026 12:34 PM';
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <RecoverySnapshotsCard
          backupAction={`snapshot:${secondSnapshot}`}
          formatRecoverySnapshotLabel={() => visualMinuteLabel}
          handleRestoreRecoverySnapshot={noop}
          isBackupBusy
          isLoadingRecoverySnapshots={false}
          isSyncing={false}
          recoverySnapshots={[firstSnapshot, secondSnapshot]}
          recoverySnapshotsOpen
          setRecoverySnapshotsOpen={noop}
          tr={tr}
          t={translate}
          tc={tc}
        />,
      );
    });

    for (const snapshot of [firstSnapshot, secondSnapshot]) {
      const row = tree.root.findByProps({ testID: `recovery-snapshot-${snapshot}` });
      expect(row.props.accessibilityRole).toBe('button');
      expect(row.props.accessibilityLabel).toBe(
        `settings.recoverySnapshotsRestoreNamed:${visualMinuteLabel} (${snapshot})`,
      );
      expect(row.props.accessibilityHint).toBe('settings.recoverySnapshotsConfirm');
      expect(row.props.accessibilityState).toEqual({
        busy: snapshot === secondSnapshot,
        disabled: true,
      });
    }
    expect(tree.root.findAllByType(Text).filter((node) => node.props.children === visualMinuteLabel)).toHaveLength(2);

    const spinner = tree.root.findByType(ActivityIndicator);
    expect(spinner.props.accessible).toBe(false);
    expect(spinner.props.accessibilityElementsHidden).toBe(true);
    expect(spinner.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('exposes recovery snapshots as a collapsed button and hides its decorative chevron', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <RecoverySnapshotsCard
          backupAction={null}
          formatRecoverySnapshotLabel={(name) => name}
          handleRestoreRecoverySnapshot={noop}
          isBackupBusy={false}
          isLoadingRecoverySnapshots={false}
          isSyncing={false}
          recoverySnapshots={[]}
          recoverySnapshotsOpen={false}
          setRecoverySnapshotsOpen={noop}
          tr={translate}
          t={translate}
          tc={tc}
        />,
      );
    });

    const disclosure = tree.root.findByProps({ testID: 'recovery-snapshots-disclosure' });
    expect(disclosure.props.accessibilityRole).toBe('button');
    expect(disclosure.props.accessibilityState).toEqual({ expanded: false });
    const chevron = tree.root.findByProps({ testID: 'recovery-snapshots-chevron' });
    expect(chevron.props.accessible).toBe(false);
    expect(chevron.props.accessibilityElementsHidden).toBe(true);
    expect(chevron.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('exposes sync preferences as an expanded button and hides its decorative chevron', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SyncPreferencesCard
          syncAiEnabled={false}
          syncAppearanceEnabled={false}
          syncExternalCalendarsEnabled={false}
          syncGtdEnabled={false}
          syncLanguageEnabled={false}
          syncOptionsOpen
          syncSavedFiltersEnabled={false}
          t={translate}
          tc={tc}
          toggleSyncOptionsOpen={noop}
          updateSyncPreferences={noop}
        />,
      );
    });

    const disclosure = tree.root.findByProps({ testID: 'sync-preferences-disclosure' });
    expect(disclosure.props.accessibilityRole).toBe('button');
    expect(disclosure.props.accessibilityState).toEqual({ expanded: true });
    const chevron = tree.root.findByProps({ testID: 'sync-preferences-chevron' });
    expect(chevron.props.accessible).toBe(false);
    expect(chevron.props.accessibilityElementsHidden).toBe(true);
    expect(chevron.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});

describe('BackgroundSyncInfoCard', () => {
  const findIntervalButton = (tree: renderer.ReactTestRenderer, labelKey: string) =>
    tree.root.findAllByType(TouchableOpacity).find((candidate) => (
      candidate.findAllByType(Text).some((textNode) => textNode.props.children === labelKey)
    ));

  it('shows the interval picker for a backend that supports scheduled background sync', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <BackgroundSyncInfoCard
          interval="15m"
          isRemoteBackend
          onSelectInterval={vi.fn()}
          tr={translate}
          tc={tc}
        />,
      );
    });

    expect(findIntervalButton(tree, 'settings.syncMobile.backgroundSyncIntervalOff')).toBeTruthy();
    expect(findIntervalButton(tree, 'settings.syncMobile.backgroundSyncIntervalEvery15Minutes')).toBeTruthy();
    expect(findIntervalButton(tree, 'settings.syncMobile.backgroundSyncIntervalEveryHour')).toBeTruthy();
    expect(findIntervalButton(tree, 'settings.syncMobile.backgroundSyncIntervalEvery6Hours')).toBeTruthy();
  });

  it('calls onSelectInterval with the tapped option', () => {
    const onSelectInterval = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <BackgroundSyncInfoCard
          interval="15m"
          isRemoteBackend
          onSelectInterval={onSelectInterval}
          tr={translate}
          tc={tc}
        />,
      );
    });

    const hourButton = findIntervalButton(tree, 'settings.syncMobile.backgroundSyncIntervalEveryHour');
    act(() => {
      hourButton?.props.onPress();
    });

    expect(onSelectInterval).toHaveBeenCalledWith('1h');
  });

  it('hides the interval picker for a backend without scheduled background sync', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <BackgroundSyncInfoCard
          interval="15m"
          isRemoteBackend={false}
          onSelectInterval={vi.fn()}
          tr={translate}
          tc={tc}
        />,
      );
    });

    expect(findIntervalButton(tree, 'settings.syncMobile.backgroundSyncIntervalOff')).toBeFalsy();
    expect(renderedText(tree)).toContain('settings.syncMobile.scheduledBackgroundSyncIsAvailableForWebdavSelfHostedCloud');
  });
});
