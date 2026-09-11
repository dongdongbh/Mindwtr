import { AttachmentsCleanupSection } from './sync/AttachmentsCleanupSection';
import { BackupSection, ImportSection } from './sync/DataTransferSections';
import { DiagnosticsSection } from './sync/DiagnosticsSection';
import type { SettingsDataPageProps } from './sync/types';
import { OpenSandboxSetting } from '../../sandbox/OpenSandboxSetting';

export function SettingsDataPage(props: SettingsDataPageProps) {
    return (
        <div className="space-y-8">
            <BackupSection {...props} />
            <ImportSection {...props} />
            <AttachmentsCleanupSection {...props} />
            <OpenSandboxSetting
                t={props.t}
                disabled={props.transferAction !== null || props.isCleaningAttachments}
            />
            {props.isTauri && <DiagnosticsSection {...props} />}
        </div>
    );
}
