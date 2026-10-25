import type { AppData } from './types';
import type { StoreActionResult, TaskStore } from './store-types';
import { backfillArchiveClocks, getArchiveRetentionPreview, isArchiveRetentionDays } from './archive-retention';
import { ensureDeviceId, getNextDataChangeAt, nextRevision, persist } from './store-helpers';
import { compactPurgedProjectForLocalStorage, compactPurgedProjectSectionTombstone, compactPurgedTaskForLocalStorage } from './tombstone-compaction';
import { clearDerivedCache, timestampAtLeastAfter } from './store-settings';
import { logInfo } from './logger';
import { settingsWithPurgedParentAttachmentDeletes } from './attachment-cleanup';
import { retainTaxonomyEffects } from './taxonomy-catalog';

type Context = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    debouncedSave: (data: AppData, onError?: (message: string) => void) => void;
    flushPendingSave: () => Promise<void>;
};

// R-2: a device that was offline must not purge before it has merged the remote, or a
// restore made on another device loses to the fresh purge tombstone. Session-scoped on purpose.
let syncCompletedThisSession = false;
let deferralLogged = false;

/** Called by the shared sync cycle once it has read and merged (or confirmed unchanged) the remote. */
export const markArchiveRetentionSyncCompleted = (): void => { syncCompletedThisSession = true; };
export const isArchiveRetentionSyncCompleted = (): boolean => syncCompletedThisSession;
export const resetArchiveRetentionSyncForTests = (): void => {
    syncCompletedThisSession = false;
    deferralLogged = false;
};

const canWrite = (state: TaskStore): boolean =>
    !state.isLoading && !state.persistenceFailure && state.editLockCount === 0 && Boolean(state.settings.deviceId);

const saveFailure = (error: unknown): StoreActionResult => ({
    success: false,
    error: `Failed to save Archive retention: ${error instanceof Error ? error.message : String(error)}`,
});

export const createArchiveRetentionActions = ({ set, debouncedSave, flushPendingSave }: Context):
    Pick<TaskStore, 'setArchiveRetentionDays' | 'runArchiveRetention'> => ({
    setArchiveRetentionDays: async (days) => {
        if (!isArchiveRetentionDays(days)) return { success: false, error: 'Archive retention must be an integer from 0 to 36500 days' };
        let result: StoreActionResult = { success: true };
        let changed = false;
        set((state) => {
            if (!canWrite(state)) {
                result = { success: false, error: 'Archive retention is unavailable while data is loading, editing, or unsaved' };
                return state;
            }
            const nowMs = Date.now();
            const now = new Date(nowMs).toISOString();
            const preview = days > 0
                ? getArchiveRetentionPreview({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections }, days, nowMs)
                : null;
            const backfill = preview
                ? backfillArchiveClocks({ tasks: state._allTasks, projects: state._allProjects }, preview, now, state.settings.deviceId!)
                : { tasks: state._allTasks, projects: state._allProjects };
            const oldDays = state.settings.gtd?.archiveRetentionDays ?? 0;
            if (oldDays === days && backfill.tasks === state._allTasks && backfill.projects === state._allProjects) return state;
            const settings: AppData['settings'] = oldDays === days ? state.settings : {
                ...state.settings,
                gtd: { ...state.settings.gtd, archiveRetentionDays: days },
                syncPreferencesUpdatedAt: {
                    ...state.settings.syncPreferencesUpdatedAt,
                    gtd: timestampAtLeastAfter(now, state.settings.syncPreferencesUpdatedAt?.gtd),
                },
            };
            changed = true;
            clearDerivedCache();
            persist(set, debouncedSave, state, { tasks: backfill.tasks, projects: backfill.projects, settings });
            return {
                _allTasks: backfill.tasks, _allProjects: backfill.projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, nowMs),
            };
        });
        if (!result.success || !changed) return result;
        try { await flushPendingSave(); } catch (error) { return saveFailure(error); }
        return result;
    },

    runArchiveRetention: async ({ syncConfigured }) => {
        let result: StoreActionResult = { success: true };
        let purged = { tasks: 0, projects: 0, sections: 0 };
        let changed = false;
        let deferred = false;
        set((state) => {
            // Automatic calls before hydration or during an editor/save failure are safe no-ops.
            if (!canWrite(state)) return state;
            const days = state.settings.gtd?.archiveRetentionDays;
            if (!isArchiveRetentionDays(days) || days === 0) return state;
            if (syncConfigured && !syncCompletedThisSession) {
                deferred = true;
                return state;
            }
            const nowMs = Date.now();
            const now = new Date(nowMs).toISOString();
            const preview = getArchiveRetentionPreview({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections }, days, nowMs);
            const taskIds = new Set(preview.taskIds);
            const projectIds = new Set(preview.projectIds);
            const sectionIds = new Set(preview.sectionIds);
            if (!taskIds.size && !projectIds.size && !sectionIds.size
                && !preview.legacyTaskIds.length && !preview.legacyProjectIds.length) return state;
            const device = ensureDeviceId(state.settings);
            const backfill = backfillArchiveClocks({ tasks: state._allTasks, projects: state._allProjects }, preview, now, device.deviceId);
            const tasks = backfill.tasks.map((task) => taskIds.has(task.id)
                ? compactPurgedTaskForLocalStorage({ ...task, deletedAt: now, purgedAt: now, updatedAt: now,
                    rev: nextRevision(task.rev), revBy: device.deviceId }) : task);
            const projects = backfill.projects.map((project) => projectIds.has(project.id)
                ? compactPurgedProjectForLocalStorage({ ...project, deletedAt: now, purgedAt: now, updatedAt: now,
                    rev: nextRevision(project.rev), revBy: device.deviceId }) : project);
            // Purging archived rows can leave their tokens unused (a Project-only tag), so keep them saved.
            const changedPairs = <T>(before: T[], after: T[]) => after.flatMap((row, index) =>
                row !== before[index] ? [{ before: before[index], after: row }] : []);
            const settings = retainTaxonomyEffects(settingsWithPurgedParentAttachmentDeletes(device.settings,
                state._allTasks, state._allProjects, taskIds, projectIds),
            changedPairs(state._allTasks, tasks), changedPairs(state._allProjects, projects));
            const sections = state._allSections.map((section) => sectionIds.has(section.id)
                ? compactPurgedProjectSectionTombstone({ ...section, deletedAt: now, updatedAt: now,
                    rev: nextRevision(section.rev), revBy: device.deviceId }, now) : section);
            purged = { tasks: taskIds.size, projects: projectIds.size, sections: sectionIds.size };
            changed = true;
            clearDerivedCache();
            persist(set, debouncedSave, state, { tasks, projects, sections, settings });
            return { _allTasks: tasks, _allProjects: projects, _allSections: sections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, nowMs) };
        });
        if (deferred && !deferralLogged) {
            deferralLogged = true;
            logInfo('Archive retention deferred until the first sync', { scope: 'store', category: 'storage', context: {
                releaseCheck: 'v1.3.5/archive-retention-after-sync',
            } });
        }
        if (!result.success || !changed) return result;
        try { await flushPendingSave(); } catch (error) { return saveFailure(error); }
        if (purged.tasks || purged.projects || purged.sections) {
            logInfo('Archive retention cleanup saved', { scope: 'store', category: 'storage', context: {
                releaseCheck: 'v1.3.4/archive-retention',
                taskCount: purged.tasks, projectCount: purged.projects, sectionCount: purged.sections,
            } });
        }
        return result;
    },
});
