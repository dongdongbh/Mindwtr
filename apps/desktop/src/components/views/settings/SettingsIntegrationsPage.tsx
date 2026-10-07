import type { ExternalCalendarSubscription } from '@mindwtr/core';
import type { SystemCalendarPermissionStatus, SystemCalendarPushTarget } from '../../../lib/system-calendar';

import { SettingsCalendarPage } from './SettingsCalendarPage';
import { SettingsEmailCaptureSection } from './SettingsEmailCaptureSection';
import { SettingsObsidianSection } from './SettingsObsidianSection';
import { SettingsMcpSection } from './SettingsMcpSection';

type Labels = {
    calendarIntegrationGuideTitle: string;
    obsidianIntegrationGuideTitle: string;
    emailCaptureGuideTitle: string;
    calendar: string;
    calendarDesc: string;
    calendarName: string;
    calendarUrl: string;
    calendarAdd: string;
    calendarChooseLocalFile: string;
    calendarRemove: string;
    calendarColorAuto: string;
    calendarShowInAreas: string;
    calendarAllAreas: string;
    externalCalendars: string;
    calendarSystemTitle: string;
    calendarSystemDesc: string;
    calendarSystemStatus: string;
    calendarSystemPermissionGranted: string;
    calendarSystemPermissionUndetermined: string;
    calendarSystemPermissionDenied: string;
    calendarSystemPermissionUnsupported: string;
    calendarSystemRequestAccess: string;
    calendarSystemDeniedHint: string;
    calendarPushTitle: string;
    calendarPushDesc: string;
    calendarPushEnable: string;
    calendarPushTarget: string;
    calendarPushManagedTarget: string;
    calendarPushRefresh: string;
    calendarPushLoading: string;
    calendarPushTargetHint: string;
    obsidianVault: string;
    obsidianVaultDesc: string;
    obsidianEnable: string;
    obsidianVaultPath: string;
    obsidianVaultPathHint: string;
    obsidianDetectedVaults: string;
    obsidianScanFolders: string;
    obsidianScanFoldersHint: string;
    obsidianInboxFile: string;
    obsidianInboxFileHint: string;
    obsidianRequiredInlineTag: string;
    obsidianRequiredInlineTagHint: string;
    obsidianDataview: string;
    obsidianDataviewDesc: string;
    obsidianDataviewMetadata: string;
    obsidianDataviewMetadataHint: string;
    obsidianTaskNotes: string;
    obsidianTaskNotesDesc: string;
    obsidianTaskNotesIncludeArchived: string;
    obsidianTaskNotesIncludeArchivedHint: string;
    obsidianNewTaskFormat: string;
    obsidianNewTaskFormatHint: string;
    obsidianNewTaskFormatAuto: string;
    obsidianNewTaskFormatInline: string;
    obsidianNewTaskFormatTaskNotes: string;
    obsidianWatching: string;
    obsidianWatcherUnavailable: string;
    obsidianSave: string;
    obsidianRemove: string;
    obsidianRescan: string;
    obsidianRescanning: string;
    obsidianLastScanned: string;
    obsidianNeverScanned: string;
    obsidianMissingMarker: string;
    browse: string;
    emailCapture: string;
    emailCaptureDesc: string;
    emailCaptureHost: string;
    emailCapturePort: string;
    emailCaptureUsername: string;
    emailCapturePassword: string;
    emailCapturePasswordHint: string;
    emailCapturePasswordStored: string;
    emailCaptureFolder: string;
    emailCaptureFolderHint: string;
    emailCaptureSave: string;
    emailCaptureRemove: string;
    emailCaptureCheckNow: string;
    emailCaptureChecking: string;
    emailCaptureLastChecked: string;
    emailCaptureNeverChecked: string;
    emailCaptureImportedCount: string;
    emailCaptureSaveFailed: string;
};

type SettingsIntegrationsPageProps = {
    t: Labels;
    isTauri: boolean;
    showSaved: () => void;
    newCalendarName: string;
    newCalendarUrl: string;
    calendarError: string | null;
    externalCalendars: ExternalCalendarSubscription[];
    showSystemCalendarSection: boolean;
    systemCalendarPermission: SystemCalendarPermissionStatus;
    calendarPushEnabled: boolean;
    calendarPushTargetCalendarId: string | null;
    calendarPushTargets: SystemCalendarPushTarget[];
    calendarPushLoading: boolean;
    /** Active theme, for the calendar swatch fills only (#974). */
    theme?: string;
    onCalendarNameChange: (value: string) => void;
    onCalendarUrlChange: (value: string) => void;
    onAddCalendar: () => void;
    onChooseLocalCalendarFile: () => Promise<void> | void;
    onToggleCalendar: (id: string, enabled: boolean) => void;
    onCalendarColorChange: (id: string, color: string | undefined) => void;
    onRemoveCalendar: (id: string) => void;
    onRequestSystemCalendarPermission: () => void;
    onToggleCalendarPush: (enabled: boolean) => Promise<void> | void;
    onCalendarPushTargetChange: (id: string | null) => Promise<void> | void;
    onRefreshCalendarPushTargets: () => Promise<void> | void;
    maskCalendarUrl: (url: string) => string;
    obsidianVaultPath: string;
    obsidianEnabled: boolean;
    obsidianScanFoldersText: string;
    obsidianInboxFile: string;
    obsidianTaskNotesIncludeArchived: boolean;
    obsidianDataviewMetadataEnabled: boolean;
    obsidianNewTaskFormat: 'auto' | 'inline' | 'tasknotes';
    obsidianLastScannedAt: string | null;
    obsidianHasVaultMarker: boolean | null;
    obsidianVaultWarning: string | null;
    obsidianIsWatching: boolean;
    obsidianWatcherError: string | null;
    isSavingObsidian: boolean;
    isScanningObsidian: boolean;
    onObsidianVaultPathChange: (value: string) => void;
    onObsidianEnabledChange: (value: boolean) => void;
    onObsidianScanFoldersTextChange: (value: string) => void;
    obsidianRequiredInlineTag: string;
    onObsidianRequiredInlineTagChange: (value: string) => void;
    onObsidianInboxFileChange: (value: string) => void;
    onObsidianTaskNotesIncludeArchivedChange: (value: boolean) => void;
    onObsidianDataviewMetadataEnabledChange: (value: boolean) => void;
    onObsidianNewTaskFormatChange: (value: 'auto' | 'inline' | 'tasknotes') => void;
    onBrowseObsidianVault: () => Promise<void> | void;
    onSaveObsidian: () => Promise<void> | void;
    onRemoveObsidian: () => Promise<void> | void;
    onRescanObsidian: () => Promise<void> | void;
};

export function SettingsIntegrationsPage({
    t,
    isTauri,
    showSaved,
    newCalendarName,
    newCalendarUrl,
    calendarError,
    externalCalendars,
    showSystemCalendarSection,
    systemCalendarPermission,
    calendarPushEnabled,
    calendarPushTargetCalendarId,
    calendarPushTargets,
    calendarPushLoading,
    theme,
    onCalendarNameChange,
    onCalendarUrlChange,
    onAddCalendar,
    onChooseLocalCalendarFile,
    onToggleCalendar,
    onCalendarColorChange,
    onRemoveCalendar,
    onRequestSystemCalendarPermission,
    onToggleCalendarPush,
    onCalendarPushTargetChange,
    onRefreshCalendarPushTargets,
    maskCalendarUrl,
    obsidianVaultPath,
    obsidianEnabled,
    obsidianScanFoldersText,
    obsidianInboxFile,
    obsidianTaskNotesIncludeArchived,
    obsidianDataviewMetadataEnabled,
    obsidianNewTaskFormat,
    obsidianLastScannedAt,
    obsidianHasVaultMarker,
    obsidianVaultWarning,
    obsidianIsWatching,
    obsidianWatcherError,
    isSavingObsidian,
    isScanningObsidian,
    onObsidianVaultPathChange,
    onObsidianEnabledChange,
    onObsidianScanFoldersTextChange,
    onObsidianInboxFileChange,
    obsidianRequiredInlineTag,
    onObsidianRequiredInlineTagChange,
    onObsidianTaskNotesIncludeArchivedChange,
    onObsidianDataviewMetadataEnabledChange,
    onObsidianNewTaskFormatChange,
    onBrowseObsidianVault,
    onSaveObsidian,
    onRemoveObsidian,
    onRescanObsidian,
}: SettingsIntegrationsPageProps) {
    return (
        <div className="space-y-6">
            <SettingsCalendarPage
                t={t}
                newCalendarName={newCalendarName}
                newCalendarUrl={newCalendarUrl}
                calendarError={calendarError}
                externalCalendars={externalCalendars}
                showSystemCalendarSection={showSystemCalendarSection}
                systemCalendarPermission={systemCalendarPermission}
                calendarPushEnabled={calendarPushEnabled}
                calendarPushTargetCalendarId={calendarPushTargetCalendarId}
                calendarPushTargets={calendarPushTargets}
                calendarPushLoading={calendarPushLoading}
                theme={theme}
                onCalendarNameChange={onCalendarNameChange}
                onCalendarUrlChange={onCalendarUrlChange}
                onAddCalendar={onAddCalendar}
                onChooseLocalCalendarFile={isTauri ? onChooseLocalCalendarFile : undefined}
                onToggleCalendar={onToggleCalendar}
                onCalendarColorChange={onCalendarColorChange}
                onRemoveCalendar={onRemoveCalendar}
                onRequestSystemCalendarPermission={onRequestSystemCalendarPermission}
                onToggleCalendarPush={onToggleCalendarPush}
                onCalendarPushTargetChange={onCalendarPushTargetChange}
                onRefreshCalendarPushTargets={onRefreshCalendarPushTargets}
                maskCalendarUrl={maskCalendarUrl}
            />

            <SettingsObsidianSection
                t={t}
                isTauri={isTauri}
                obsidianVaultPath={obsidianVaultPath}
                obsidianEnabled={obsidianEnabled}
                obsidianScanFoldersText={obsidianScanFoldersText}
                obsidianRequiredInlineTag={obsidianRequiredInlineTag}
                onObsidianRequiredInlineTagChange={onObsidianRequiredInlineTagChange}
                obsidianInboxFile={obsidianInboxFile}
                obsidianTaskNotesIncludeArchived={obsidianTaskNotesIncludeArchived}
                obsidianDataviewMetadataEnabled={obsidianDataviewMetadataEnabled}
                obsidianNewTaskFormat={obsidianNewTaskFormat}
                obsidianLastScannedAt={obsidianLastScannedAt}
                obsidianHasVaultMarker={obsidianHasVaultMarker}
                obsidianVaultWarning={obsidianVaultWarning}
                obsidianIsWatching={obsidianIsWatching}
                obsidianWatcherError={obsidianWatcherError}
                isSavingObsidian={isSavingObsidian}
                isScanningObsidian={isScanningObsidian}
                onObsidianVaultPathChange={onObsidianVaultPathChange}
                onObsidianEnabledChange={onObsidianEnabledChange}
                onObsidianScanFoldersTextChange={onObsidianScanFoldersTextChange}
                onObsidianInboxFileChange={onObsidianInboxFileChange}
                onObsidianTaskNotesIncludeArchivedChange={onObsidianTaskNotesIncludeArchivedChange}
                onObsidianDataviewMetadataEnabledChange={onObsidianDataviewMetadataEnabledChange}
                onObsidianNewTaskFormatChange={onObsidianNewTaskFormatChange}
                onBrowseObsidianVault={onBrowseObsidianVault}
                onSaveObsidian={onSaveObsidian}
                onRemoveObsidian={onRemoveObsidian}
                onRescanObsidian={onRescanObsidian}
            />

            <SettingsEmailCaptureSection
                t={t}
                isTauri={isTauri}
                showSaved={showSaved}
            />
            <SettingsMcpSection isTauri={isTauri} />
        </div>
    );
}
