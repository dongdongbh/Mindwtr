import { AttachmentsCleanupSection } from './sync/AttachmentsCleanupSection';
import { ArchiveRetentionSection } from './ArchiveRetentionSection';
import { BackupSection, ImportSection } from './sync/DataTransferSections';
import { DiagnosticsSection } from './sync/DiagnosticsSection';
import type { SettingsDataPageProps } from './sync/types';
import { OpenSandboxSetting } from '../../sandbox/OpenSandboxSetting';
import { SettingsWorkspacesSection } from './SettingsWorkspacesSection';

export function SettingsDataPage(props: SettingsDataPageProps) {
    return (
        <div className="space-y-8">
            {props.isTauri && <SettingsWorkspacesSection />}
            <BackupSection {...props} />
            <ImportSection {...props} />
            <ArchiveRetentionSection t={props.t} />
            <AttachmentsCleanupSection {...props} />
            <OpenSandboxSetting
                t={props.t}
                disabled={props.transferAction !== null || props.isCleaningAttachments}
            />
            {props.isTauri && <DiagnosticsSection {...props} />}
        </div>
    );
}
