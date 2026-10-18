import { runStoreCommand, useTaskStore, type Attachment } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { logInfo, logWarn } from './app-log';
import { normalizeAttachmentPathForUrl } from './attachment-paths';
import { stripFileScheme } from './sync-service-utils';
import { invokeNative } from './tauri-invoke';

type PortableAttachmentMigration = {
    isPortable: boolean;
    legacyAttachmentsDir: string;
    managedAttachmentsDir: string;
    migratedFileNames: string[];
};

const normalizeDirPrefix = (dir: string): string => (
    `${normalizeAttachmentPathForUrl(dir).replace(/\/+$/, '')}/`
);

const legacyFileName = (attachment: Attachment, legacyPrefix: string): string | null => {
    if (attachment.kind !== 'file' || attachment.deletedAt) return null;
    const uri = (attachment.uri || '').trim();
    if (!uri || /^https?:\/\//i.test(uri)) return null;
    const normalized = normalizeAttachmentPathForUrl(stripFileScheme(uri));
    if (!normalized.startsWith(legacyPrefix)) return null;
    const name = normalized.slice(legacyPrefix.length);
    if (!name || name.includes('/')) return null;
    return name;
};

// Portable installs before v1.1.0 wrote attachment files to the OS data dir
// (#855). Re-home the files this store references into the portable profile
// and point the stored URIs at the new location. Idempotent: once no URI
// matches the legacy dir, every run is a no-op.
export async function migratePortableAttachments(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        const probe = await invokeNative<PortableAttachmentMigration>('migrate_portable_attachments', { fileNames: [] });
        if (!probe.isPortable || !probe.legacyAttachmentsDir || !probe.managedAttachmentsDir) return;
        const legacyPrefix = normalizeDirPrefix(probe.legacyAttachmentsDir);
        const managedPrefix = normalizeDirPrefix(probe.managedAttachmentsDir);
        if (legacyPrefix === managedPrefix) return;

        const state = useTaskStore.getState();
        const taskTargets = new Map<string, string[]>();
        const projectTargets = new Map<string, string[]>();
        const fileNames = new Set<string>();
        for (const task of state._allTasks) {
            const names = (task.attachments ?? [])
                .map((attachment) => legacyFileName(attachment, legacyPrefix))
                .filter((name): name is string => !!name);
            if (names.length === 0) continue;
            taskTargets.set(task.id, names);
            names.forEach((name) => fileNames.add(name));
        }
        for (const project of state._allProjects) {
            const names = (project.attachments ?? [])
                .map((attachment) => legacyFileName(attachment, legacyPrefix))
                .filter((name): name is string => !!name);
            if (names.length === 0) continue;
            projectTargets.set(project.id, names);
            names.forEach((name) => fileNames.add(name));
        }
        if (fileNames.size === 0) return;

        const result = await invokeNative<PortableAttachmentMigration>('migrate_portable_attachments', {
            fileNames: Array.from(fileNames),
        });
        const migrated = new Set(result.migratedFileNames);
        if (migrated.size === 0) return;

        const rewriteAttachments = (attachments: Attachment[] | undefined): Attachment[] | null => {
            if (!attachments?.length) return null;
            let changed = false;
            const next = attachments.map((attachment) => {
                const name = legacyFileName(attachment, legacyPrefix);
                if (!name || !migrated.has(name)) return attachment;
                changed = true;
                return { ...attachment, uri: `${managedPrefix}${name}` };
            });
            return changed ? next : null;
        };

        let rewritten = 0;
        // Each list is rewritten on the row as stored when its write is admitted (a sync save may publish first).
        for (const taskId of taskTargets.keys()) {
            const wrote = await runStoreCommand(async () => {
                const task = useTaskStore.getState()._allTasks.find((item) => item.id === taskId);
                const next = rewriteAttachments(task?.attachments);
                if (!next) return false;
                await useTaskStore.getState().updateTask(taskId, { attachments: next });
                return true;
            });
            if (wrote) rewritten += 1;
        }
        for (const projectId of projectTargets.keys()) {
            const wrote = await runStoreCommand(async () => {
                const project = useTaskStore.getState()._allProjects.find((item) => item.id === projectId);
                const next = rewriteAttachments(project?.attachments);
                if (!next) return false;
                await useTaskStore.getState().updateProject(projectId, { attachments: next });
                return true;
            });
            if (wrote) rewritten += 1;
        }
        void logInfo('Migrated portable attachments into the profile dir', {
            scope: 'storage',
            extra: {
                movedFiles: String(migrated.size),
                rewrittenOwners: String(rewritten),
            },
        });
    } catch (error) {
        void logWarn('Portable attachment migration failed', {
            scope: 'storage',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
}
