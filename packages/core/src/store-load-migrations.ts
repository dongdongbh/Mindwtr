import { safeParseDate } from './date';
import { logWarn } from './logger';
import { markCoreStartupPhase } from './startup-profiler';
import { dedupeLiveAreasByName } from './area-utils';
import { normalizePeopleForLoad } from './people';
import { purgeExpiredTombstones } from './sync';
import {
    archiveSectionForProjectArchive,
    clearDeletedTaskProjectArchiveMetadata,
    completeTaskForProjectArchive,
    ensureDeviceId,
    nextRevision,
} from './store-helpers';
import { getAutoArchiveDays, shouldAutoArchiveCompletedTask } from './task-utils';
import { isTaskActionable, isTaskFinished } from './task-status';
import { generateUUID as uuidv4 } from './uuid';
import type { AppData, Area, Project, Task, TaskEditorFieldId } from './types';

// Bumped whenever a schema-shaped repair (project status/order, legacy area
// backfill) needs to run once for installs that predate it. Existing installs
// already at this version skip that block entirely.
export const MIGRATION_VERSION = 1;
export const TOMBSTONE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TASK_EDITOR_DEFAULTS_VERSION = 5;
const FOCUS_GROUP_BY_DEFAULTS_VERSION = 1;
const TASK_EDITOR_LEAN_DEFAULT_HIDDEN: TaskEditorFieldId[] = [
    'section',
    'priority',
    'energyLevel',
    'timeEstimate',
    'assignedTo',
    'location',
];

/**
 * Environment for a load pass, computed once from the data as it arrived from
 * storage (before any migration ran) so every migration below sees the same
 * "should I run" decision regardless of what earlier migrations already did.
 * This mirrors the original fetchData, which computed these once too.
 */
export type LoadContext = {
    nowIso: string;
    nowMs: number;
    isFreshInstall: boolean;
    /** Gates the one-time project/area schema backfill (migrations.version). */
    shouldRunSchemaMigration: boolean;
    /** Throttles the tombstone purge to TOMBSTONE_CLEANUP_INTERVAL_MS. */
    shouldRunTombstoneCleanup: boolean;
};

export const buildLoadContext = (
    settings: AppData['settings'],
    isFreshInstall: boolean,
    nowIso: string,
    nowMs: number
): LoadContext => {
    const migrations = settings.migrations ?? {};
    const lastTombstoneCleanupAt = safeParseDate(migrations.lastTombstoneCleanupAt)?.getTime() ?? 0;
    return {
        nowIso,
        nowMs,
        isFreshInstall,
        shouldRunSchemaMigration: (migrations.version ?? 0) < MIGRATION_VERSION,
        shouldRunTombstoneCleanup: nowMs - lastTombstoneCleanupAt > TOMBSTONE_CLEANUP_INTERVAL_MS,
    };
};

export type LoadMigration = {
    name: string;
    /** Static gate evaluated once against the context, before `data` is touched. */
    shouldRun?(ctx: LoadContext): boolean;
    /**
     * Part of the one-time legacy schema backfill gated by
     * `shouldRunSchemaMigration`. If one of these is skipped, the version bump
     * that closes that gate must be skipped too, or the step never retries.
     */
    schemaGated?: true;
    /** Returns updated data, or null when this pass made no change. */
    run(data: AppData, ctx: LoadContext): AppData | null;
    /**
     * Pre-existing (pre-refactor) quirk, preserved as-is: fetchData bumped
     * `lastDataChangeAt` — the in-memory sync-causality counter, never
     * persisted itself — only for entity-level repairs (tasks/sections/
     * people), not for area/project-order/settings migrations, even though
     * both kinds trigger a save. See runLoadMigrations' caller for how this
     * is used; do not use it to gate persistence, only the causality bump.
     */
};

const normalizeAreaForLoad = (area: Area, fallbackOrder: number, nowIso: string): Area => {
    const createdAt = typeof area?.createdAt === 'string' && area.createdAt.trim().length > 0
        ? area.createdAt
        : (typeof area?.updatedAt === 'string' && area.updatedAt.trim().length > 0 ? area.updatedAt : nowIso);
    const updatedAt = typeof area?.updatedAt === 'string' && area.updatedAt.trim().length > 0
        ? area.updatedAt
        : createdAt;
    return {
        ...area,
        order: Number.isFinite(area?.order) ? area.order : fallbackOrder,
        createdAt,
        updatedAt,
    };
};

const normalizeAreaTimestampsMigration: LoadMigration = {
    name: 'normalize-area-timestamps',
    run: (data, ctx) => {
        let changed = false;
        const areas = data.areas.map((area, index) => {
            const normalized = normalizeAreaForLoad(area, index, ctx.nowIso);
            if (normalized.createdAt !== area.createdAt || normalized.updatedAt !== area.updatedAt || normalized.order !== area.order) {
                changed = true;
            }
            return normalized;
        });
        return changed ? { ...data, areas } : null;
    },
};

// Not in LOAD_MIGRATIONS: this is the backfill group's receipt, applied by
// runLoadMigrations after the pass and only when every gated step landed.
const bumpMigrationsVersionMigration: LoadMigration = {
    name: 'bump-migrations-version',
    run: (data) => ({
        ...data,
        settings: {
            ...data.settings,
            migrations: { ...(data.settings.migrations ?? {}), version: MIGRATION_VERSION },
        },
    }),
};

const bumpTombstoneCleanupTimestampMigration: LoadMigration = {
    name: 'bump-tombstone-cleanup-timestamp',
    shouldRun: (ctx) => ctx.shouldRunTombstoneCleanup,
    run: (data, ctx) => ({
        ...data,
        settings: {
            ...data.settings,
            migrations: { ...(data.settings.migrations ?? {}), lastTombstoneCleanupAt: ctx.nowIso },
        },
    }),
};

const ensureDeviceIdMigration: LoadMigration = {
    name: 'ensure-device-id',
    run: (data) => {
        const result = ensureDeviceId(data.settings);
        return result.updated ? { ...data, settings: result.settings } : null;
    },
};

const freshInstallNotificationsDefaultMigration: LoadMigration = {
    name: 'fresh-install-notifications-default',
    run: (data, ctx) => {
        if (!ctx.isFreshInstall || data.settings.notificationsEnabled !== undefined) return null;
        return { ...data, settings: { ...data.settings, notificationsEnabled: false } };
    },
};

const taskEditorDefaultsMigration: LoadMigration = {
    name: 'task-editor-defaults',
    run: (data) => {
        const existing = data.settings.gtd?.taskEditor;
        const currentVersion = existing?.defaultsVersion ?? 0;
        if (currentVersion >= TASK_EDITOR_DEFAULTS_VERSION) return null;
        const legacyHidden = (existing?.hidden ?? []).filter((fieldId) => fieldId !== 'textDirection');
        const legacyOrder = existing?.order?.filter((fieldId) => fieldId !== 'textDirection');
        const hasCustomLayout = Boolean(
            legacyHidden.length > 0
            || (legacyOrder && legacyOrder.length > 0)
            || Object.keys(existing?.sections ?? {}).length > 0
            || Object.keys(existing?.sectionOpen ?? {}).length > 0
        );
        const hidden = new Set<TaskEditorFieldId>(
            hasCustomLayout ? legacyHidden : TASK_EDITOR_LEAN_DEFAULT_HIDDEN
        );
        if (currentVersion < 4) {
            hidden.delete('textDirection');
        }
        return {
            ...data,
            settings: {
                ...data.settings,
                gtd: {
                    ...(data.settings.gtd ?? {}),
                    taskEditor: {
                        ...(existing ?? {}),
                        ...(legacyOrder ? { order: legacyOrder } : {}),
                        hidden: Array.from(hidden),
                        defaultsVersion: TASK_EDITOR_DEFAULTS_VERSION,
                    },
                },
            },
        };
    },
};

const focusGroupByDefaultsMigration: LoadMigration = {
    name: 'focus-group-by-defaults',
    run: (data, ctx) => {
        const currentVersion = data.settings.gtd?.focusGroupByDefaultsVersion ?? 0;
        if (currentVersion >= FOCUS_GROUP_BY_DEFAULTS_VERSION) return null;
        const nextGtd = {
            ...(data.settings.gtd ?? {}),
            focusGroupByDefaultsVersion: FOCUS_GROUP_BY_DEFAULTS_VERSION,
        };
        const didMigrateLegacyContextDefault = nextGtd.focusGroupBy === 'context';
        if (didMigrateLegacyContextDefault) {
            nextGtd.focusGroupBy = 'none';
        }
        return {
            ...data,
            settings: {
                ...data.settings,
                gtd: nextGtd,
                ...(didMigrateLegacyContextDefault
                    ? {
                        syncPreferencesUpdatedAt: {
                            ...(data.settings.syncPreferencesUpdatedAt ?? {}),
                            gtd: ctx.nowIso,
                        },
                    }
                    : {}),
            },
        };
    },
};

const clearDeletedTaskProjectArchiveMetadataMigration: LoadMigration = {
    name: 'clear-deleted-task-project-archive-metadata',
    run: (data) => {
        let changed = false;
        const tasks = data.tasks.map((task) => {
            const next = clearDeletedTaskProjectArchiveMetadata(task);
            if (next !== task) changed = true;
            return next;
        });
        return changed ? { ...data, tasks } : null;
    },
};

function shouldPromoteScheduledTask(task: Task, nowMs: number): boolean {
    if (task.deletedAt || task.purgedAt) return false;
    // Explicit Waiting should remain stable even when dated items become due.
    // Waiting represents a handoff/follow-up decision, not a transient scheduling bucket.
    if (
        task.status === 'next'
        || task.status === 'waiting'
        || !isTaskActionable(task)
    ) {
        return false;
    }
    const startMs = safeParseDate(task.startTime)?.getTime() ?? NaN;
    if (Number.isFinite(startMs) && startMs <= nowMs) return true;
    const dueMs = safeParseDate(task.dueDate)?.getTime() ?? NaN;
    if (Number.isFinite(dueMs) && dueMs <= nowMs) return true;
    return false;
}

const promoteScheduledTasksMigration: LoadMigration = {
    name: 'promote-scheduled-tasks',
    run: (data, ctx) => {
        let changed = false;
        const tasks = data.tasks.map((task) => {
            if (!shouldPromoteScheduledTask(task, ctx.nowMs)) return task;
            changed = true;
            return {
                ...task,
                status: 'next' as const,
                updatedAt: ctx.nowIso,
                rev: nextRevision(task.rev),
                revBy: data.settings.deviceId,
            };
        });
        return changed ? { ...data, tasks } : null;
    },
};

const autoArchiveStaleCompletedTasks = (
    tasks: Task[],
    settings: AppData['settings'],
    context: { nowIso: string; nowMs: number; deviceId?: string; enabled?: boolean }
): { tasks: Task[]; didAutoArchive: boolean } => {
    if (context.enabled === false || getAutoArchiveDays(settings) <= 0) {
        return { tasks, didAutoArchive: false };
    }

    let didAutoArchive = false;
    const archivedTasks = tasks.map((task): Task => {
        // One rule, two clocks: the update path applies the same predicate the
        // moment a completion time is edited (#959).
        if (!shouldAutoArchiveCompletedTask(task, settings, context.nowMs)) return task;
        const completedAt = safeParseDate(task.completedAt)?.getTime() ?? NaN;
        didAutoArchive = true;
        return {
            ...task,
            status: 'archived' as const,
            completedAt: Number.isFinite(completedAt) ? task.completedAt : task.updatedAt || context.nowIso,
            isFocusedToday: false,
            updatedAt: context.nowIso,
            rev: nextRevision(task.rev),
            revBy: context.deviceId,
        };
    });

    return {
        tasks: didAutoArchive ? archivedTasks : tasks,
        didAutoArchive,
    };
};

/**
 * Shared with store-settings.ts's updateSettings, which re-runs the same
 * archive pass immediately when the user changes autoArchiveDays.
 */
export const runAutoArchive = (
    tasks: Task[],
    settings: AppData['settings'],
    context: { nowIso: string; nowMs: number; deviceId?: string; enabled?: boolean }
): { allTasks: Task[]; didAutoArchive: boolean } => {
    const result = autoArchiveStaleCompletedTasks(tasks, settings, context);
    return {
        allTasks: result.tasks,
        didAutoArchive: result.didAutoArchive,
    };
};

/**
 * Runs on every load, deliberately unthrottled. It walks the task list once and
 * the predicate rejects anything that is not `done` on its second line — the
 * same shape as promote-scheduled-tasks above, which has always run every load.
 * A twice-daily throttle used to gate it, which meant a completion you had just
 * corrected sat in Done across restarts with nothing to explain why, and cost a
 * settings write per window even when nothing was stale (#959).
 */
const autoArchiveStaleTasksMigration: LoadMigration = {
    name: 'auto-archive-stale-tasks',
    run: (data, ctx) => {
        const result = runAutoArchive(data.tasks, data.settings, {
            nowIso: ctx.nowIso,
            nowMs: ctx.nowMs,
            deviceId: data.settings.deviceId,
        });
        return result.didAutoArchive ? { ...data, tasks: result.allTasks } : null;
    },
};

const normalizePeopleForLoadMigration: LoadMigration = {
    name: 'normalize-people-for-load',
    // Depends on the task list above: assignedTo -> Person derivation reads
    // the already promoted/archived tasks.
    run: (data, ctx) => {
        const result = normalizePeopleForLoad(data.people ?? [], data.tasks, ctx.nowIso, data.settings.deviceId);
        return result.didChange ? { ...data, people: result.people } : null;
    },
};

// The next three migrations are the one-time legacy schema backfill, gated by
// the same shouldRunSchemaMigration flag and always applied together when it
// runs (each unconditionally returns updated data so later steps in this
// group and in dedupe-areas-by-name always see the up-to-date result, even
// for a project/area that itself needed no repair).
const normalizeProjectStatusAndTagsMigration: LoadMigration = {
    name: 'normalize-project-status-and-tags',
    shouldRun: (ctx) => ctx.shouldRunSchemaMigration,
    schemaGated: true,
    run: (data) => {
        const projects = data.projects.map((project) => {
            const status = project.status;
            const normalizedStatus =
                status === 'active' || status === 'someday' || status === 'waiting' || status === 'archived'
                    ? status
                    : status === 'completed'
                        ? 'archived'
                        : 'active';
            const tagIds = Array.isArray((project as Project).tagIds) ? (project as Project).tagIds : [];
            return normalizedStatus === status
                ? { ...project, tagIds }
                : { ...project, status: normalizedStatus, tagIds };
        });
        return { ...data, projects };
    },
};

const migrateProjectOrderMigration: LoadMigration = {
    name: 'migrate-project-order',
    shouldRun: (ctx) => ctx.shouldRunSchemaMigration,
    schemaGated: true,
    // Consumes normalize-project-status-and-tags' output.
    run: (data) => {
        const projectOrderCounters = new Map<string, number>();
        const projects = data.projects.map((project) => {
            const areaKey = project.areaId ?? '__none__';
            const nextIndex = projectOrderCounters.get(areaKey) ?? 0;
            const existingOrder = Number.isFinite((project as Project).order) ? (project as Project).order : undefined;
            const order = Number.isFinite(existingOrder) ? (existingOrder as number) : nextIndex;
            projectOrderCounters.set(areaKey, Math.max(nextIndex, order + 1));
            return { ...project, order } as Project;
        });
        return { ...data, projects };
    },
};

const migrateLegacyAreasMigration: LoadMigration = {
    name: 'migrate-legacy-areas',
    shouldRun: (ctx) => ctx.shouldRunSchemaMigration,
    schemaGated: true,
    // Consumes migrate-project-order's output; must run after
    // normalize-area-timestamps so area order/timestamps are already filled in.
    run: (data) => {
        let allAreas = data.areas
            .map((area, index) => ({ ...area, order: Number.isFinite(area.order) ? area.order : index }))
            .sort((a, b) => a.order - b.order);
        const areaIds = new Set(allAreas.map((area) => area.id));
        let hasLegacyAreaTitle = false;
        let hasMissingAreaId = false;
        for (const project of data.projects) {
            if (!hasLegacyAreaTitle && typeof project.areaTitle === 'string' && project.areaTitle.trim() && !project.areaId) {
                hasLegacyAreaTitle = true;
            }
            if (!hasMissingAreaId && project.areaId && !areaIds.has(project.areaId)) {
                hasMissingAreaId = true;
            }
            if (hasLegacyAreaTitle && hasMissingAreaId) break;
        }

        let projects = data.projects;
        if (hasLegacyAreaTitle || hasMissingAreaId) {
            const areaByName = new Map<string, string>();
            allAreas.forEach((area) => {
                if (area.deletedAt) return;
                const normalizedName = typeof area?.name === 'string' ? area.name.trim().toLowerCase() : '';
                if (normalizedName && !areaByName.has(normalizedName)) areaByName.set(normalizedName, area.id);
            });
            const ensureAreaForTitle = (title: string) => {
                const trimmed = title.trim();
                if (!trimmed) return undefined;
                const key = trimmed.toLowerCase();
                const existing = areaByName.get(key);
                if (existing) return existing;
                const now = new Date().toISOString();
                const id = uuidv4();
                const order = allAreas.reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1) + 1;
                allAreas = [...allAreas, { id, name: trimmed, order, createdAt: now, updatedAt: now }];
                areaByName.set(key, id);
                return id;
            };
            const areaIdExists = (areaId?: string) =>
                Boolean(areaId && allAreas.some((area) => area.id === areaId && !area.deletedAt));
            projects = data.projects.map((project) => {
                if (areaIdExists(project.areaId)) return project;
                const areaTitle = typeof project.areaTitle === 'string' ? project.areaTitle : '';
                if (!areaTitle) return project;
                const derivedId = ensureAreaForTitle(areaTitle);
                if (!derivedId) return project;
                return { ...project, areaId: derivedId };
            });
            allAreas = allAreas
                .map((area, index) => ({ ...area, order: Number.isFinite(area.order) ? area.order : index }))
                .sort((a, b) => a.order - b.order);
        }

        return { ...data, areas: allAreas, projects };
    },
};

const dedupeAreasByNameMigration: LoadMigration = {
    name: 'dedupe-areas-by-name',
    // Runs unconditionally (not just for legacy installs) so duplicate area
    // names introduced by a sync merge get cleaned up on every load. Must run
    // after migrate-legacy-areas so any areas it created are included in the
    // name-dedupe pass.
    run: (data, ctx) => {
        const deviceId = data.settings.deviceId;
        const dedupedAreas = dedupeLiveAreasByName(data.areas, { nowIso: ctx.nowIso, revBy: deviceId });
        if (!dedupedAreas.changed) return null;

        const allAreas = dedupedAreas.areas
            .map((area, index) => ({ ...area, order: Number.isFinite(area.order) ? area.order : index }))
            .sort((a, b) => a.order - b.order);

        // Duplicate areas were just tombstoned above; remap anything that
        // pointed at a losing id onto the canonical winner.
        const areaIdRemap = dedupedAreas.areaIdRemap;
        const liveAreaById = new Map(allAreas.filter((area) => !area.deletedAt).map((area) => [area.id, area] as const));
        const allProjects = data.projects.map((project) => {
            const remappedAreaId = project.areaId ? areaIdRemap.get(project.areaId) : undefined;
            if (!remappedAreaId || remappedAreaId === project.areaId) return project;
            const remappedArea = liveAreaById.get(remappedAreaId);
            return {
                ...project,
                areaId: remappedAreaId,
                areaTitle: remappedArea?.name ?? project.areaTitle,
                updatedAt: ctx.nowIso,
                rev: nextRevision(project.rev),
                revBy: deviceId,
            };
        });
        const allTasks = data.tasks.map((task) => {
            const remappedAreaId = task.areaId ? areaIdRemap.get(task.areaId) : undefined;
            if (!remappedAreaId || remappedAreaId === task.areaId) return task;
            return {
                ...task,
                areaId: task.projectId ? undefined : remappedAreaId,
                updatedAt: ctx.nowIso,
                rev: nextRevision(task.rev),
                revBy: deviceId,
            };
        });
        const configuredDefaultAreaId = data.settings.gtd?.defaultAreaId;
        const remappedDefaultAreaId = typeof configuredDefaultAreaId === 'string'
            ? areaIdRemap.get(configuredDefaultAreaId)
            : undefined;
        const settings = remappedDefaultAreaId && remappedDefaultAreaId !== configuredDefaultAreaId
            ? {
                ...data.settings,
                gtd: { ...(data.settings.gtd ?? {}), defaultAreaId: remappedDefaultAreaId },
                syncPreferencesUpdatedAt: { ...(data.settings.syncPreferencesUpdatedAt ?? {}), gtd: ctx.nowIso },
            }
            : data.settings;

        return { ...data, areas: allAreas, projects: allProjects, tasks: allTasks, settings };
    },
};

const archiveDescendantsOfArchivedProjectsMigration: LoadMigration = {
    name: 'archive-descendants-of-archived-projects',
    // Reads project.status === 'archived', so must run after any step above
    // that can change project status (normalize-project-status-and-tags).
    run: (data, ctx) => {
        const archivedProjectIds = new Set(
            data.projects
                .filter((project) => !project.deletedAt && project.status === 'archived')
                .map((project) => project.id)
        );
        if (archivedProjectIds.size === 0) return null;
        const deviceId = data.settings.deviceId;
        let changed = false;
        const tasks = data.tasks.map((task) => {
            if (task.deletedAt || isTaskFinished(task)) return task;
            if (!task.projectId || !archivedProjectIds.has(task.projectId)) return task;
            changed = true;
            return completeTaskForProjectArchive(task, ctx.nowIso, deviceId);
        });
        const sections = data.sections.map((section) => {
            if (section.deletedAt) return section;
            if (!archivedProjectIds.has(section.projectId)) return section;
            changed = true;
            return archiveSectionForProjectArchive(section, ctx.nowIso, deviceId);
        });
        return changed ? { ...data, tasks, sections } : null;
    },
};

const repairDanglingEntityReferencesMigration: LoadMigration = {
    name: 'repair-dangling-entity-references',
    // Must run after the archive pass above: section archival there changes
    // which sections are "active", which this repair depends on.
    run: (data, ctx) => {
        const deviceId = data.settings.deviceId;
        let changed = false;
        const activeAreaIds = new Set(data.areas.filter((area) => !area.deletedAt).map((area) => area.id));
        const projects = data.projects.map((project) => {
            if (project.deletedAt || !project.areaId || activeAreaIds.has(project.areaId)) return project;
            changed = true;
            return {
                ...project,
                areaId: undefined,
                updatedAt: ctx.nowIso,
                rev: nextRevision(project.rev),
                revBy: deviceId,
            };
        });
        const activeProjectIds = new Set(projects.filter((project) => !project.deletedAt).map((project) => project.id));
        const sections = data.sections.map((section) => {
            if (section.deletedAt || activeProjectIds.has(section.projectId)) return section;
            changed = true;
            return {
                ...section,
                deletedAt: ctx.nowIso,
                updatedAt: ctx.nowIso,
                rev: nextRevision(section.rev),
                revBy: deviceId,
            };
        });
        const activeSectionProjectIds = new Map(
            sections.filter((section) => !section.deletedAt).map((section) => [section.id, section.projectId])
        );
        const tasks = data.tasks.map((task) => {
            if (task.deletedAt) return task;
            let nextTask = task;
            let taskChanged = false;
            if (nextTask.projectId && !activeProjectIds.has(nextTask.projectId)) {
                nextTask = { ...nextTask, projectId: undefined, sectionId: undefined };
                taskChanged = true;
            }
            const sectionProjectId = nextTask.sectionId ? activeSectionProjectIds.get(nextTask.sectionId) : undefined;
            if (nextTask.sectionId && (!sectionProjectId || (nextTask.projectId && sectionProjectId !== nextTask.projectId))) {
                nextTask = { ...nextTask, sectionId: undefined };
                taskChanged = true;
            }
            if (nextTask.areaId && !activeAreaIds.has(nextTask.areaId)) {
                nextTask = { ...nextTask, areaId: undefined };
                taskChanged = true;
            }
            if (!taskChanged) return task;
            changed = true;
            return { ...nextTask, updatedAt: ctx.nowIso, rev: nextRevision(task.rev), revBy: deviceId };
        });
        return changed ? { ...data, projects, sections, tasks } : null;
    },
};

const purgeExpiredTombstonesMigration: LoadMigration = {
    name: 'purge-expired-tombstones',
    shouldRun: (ctx) => ctx.shouldRunTombstoneCleanup,
    // Must run last: purge only after every repair pass above has settled,
    // so nothing still-referenced above gets purged prematurely.
    run: (data, ctx) => {
        const cleanup = purgeExpiredTombstones(
            {
                tasks: data.tasks,
                projects: data.projects,
                sections: data.sections,
                areas: data.areas,
                people: data.people ?? [],
                settings: data.settings,
            },
            ctx.nowIso
        );
        if (
            cleanup.removedTaskTombstones > 0
            || cleanup.removedProjectTombstones > 0
            || cleanup.removedSectionTombstones > 0
            || cleanup.removedAreaTombstones > 0
            || cleanup.removedPersonTombstones > 0
            || cleanup.removedAttachmentTombstones > 0
            || cleanup.removedSavedFilterTombstones > 0
        ) {
            logWarn('Purged expired tombstones during data fetch', {
                scope: 'store',
                category: 'storage',
                context: {
                    removedTaskTombstones: cleanup.removedTaskTombstones,
                    removedProjectTombstones: cleanup.removedProjectTombstones,
                    removedSectionTombstones: cleanup.removedSectionTombstones,
                    removedAreaTombstones: cleanup.removedAreaTombstones,
                    removedPersonTombstones: cleanup.removedPersonTombstones,
                    removedAttachmentTombstones: cleanup.removedAttachmentTombstones,
                    removedSavedFilterTombstones: cleanup.removedSavedFilterTombstones,
                },
            });
        }
        return {
            ...data,
            tasks: cleanup.data.tasks,
            projects: cleanup.data.projects,
            sections: cleanup.data.sections,
            areas: cleanup.data.areas,
            people: cleanup.data.people ?? [],
            settings: cleanup.data.settings,
        };
    },
};

// Order is load-bearing. Each migration reads the previous migrations'
// output, so the array order below IS the dependency graph; see the comment
// on each step above for why it must come after the ones before it.
const LOAD_MIGRATIONS: LoadMigration[] = [
    normalizeAreaTimestampsMigration,
    bumpTombstoneCleanupTimestampMigration,
    // Everything below reads settings.deviceId for revBy stamping.
    ensureDeviceIdMigration,
    freshInstallNotificationsDefaultMigration,
    taskEditorDefaultsMigration,
    focusGroupByDefaultsMigration,
    clearDeletedTaskProjectArchiveMetadataMigration,
    // Must run before auto-archive: promoting a due/started task to 'next'
    // changes its status, and auto-archive only scans 'done' tasks.
    promoteScheduledTasksMigration,
    autoArchiveStaleTasksMigration,
    normalizePeopleForLoadMigration,
    normalizeProjectStatusAndTagsMigration,
    migrateProjectOrderMigration,
    migrateLegacyAreasMigration,
    dedupeAreasByNameMigration,
    archiveDescendantsOfArchivedProjectsMigration,
    repairDanglingEntityReferencesMigration,
    purgeExpiredTombstonesMigration,
];

export const runLoadMigrations = (data: AppData, ctx: LoadContext): { data: AppData; applied: string[] } => {
    let current = data;
    const applied: string[] = [];
    let schemaBackfillFailed = false;

    const apply = (migration: LoadMigration): void => {
        let result: AppData | null;
        try {
            result = migration.run(current, ctx);
        } catch (error) {
            // One malformed row must not cost the user their whole document: the
            // caller's outer catch would leave the store empty on every launch.
            // Skipping keeps the pre-migration state, which the later steps and
            // the next load both still see.
            if (migration.schemaGated) schemaBackfillFailed = true;
            logWarn('Load migration failed; continuing without it', {
                scope: 'store',
                category: 'storage',
                context: { migration: migration.name },
                error,
            });
            return;
        }
        if (!result) return;
        current = result;
        applied.push(migration.name);
        markCoreStartupPhase(`core.fetch_data.migration:${migration.name}`);
    };

    for (const migration of LOAD_MIGRATIONS) {
        if (migration.shouldRun && !migration.shouldRun(ctx)) continue;
        apply(migration);
    }

    // Last, and only when every gated step landed: this write closes
    // shouldRunSchemaMigration for good, so recording it after a skipped
    // backfill step would mean that step never runs again.
    if (ctx.shouldRunSchemaMigration && !schemaBackfillFailed) {
        apply(bumpMigrationsVersionMigration);
    }
    return { data: current, applied };
};
