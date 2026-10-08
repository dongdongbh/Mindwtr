import { getAttachmentUnrecoverablePatch } from '../mobile-attachment-availability';
import {
    applyProjectLifecycleTransition,
    applyTaskUpdates,
    createProjectOrderReserver,
    ensureDeviceId,
    getNextDataChangeAt,
    nextRevision,
    normalizeTaskUpdate,
    persist,
    replaceEntitiesInArray,
} from '../store-helpers';
import {
    isProjectCancelled,
    normalizeProjectLifecycleFields,
    normalizeProjectUpdate,
} from '../project-status';
import { normalizeCancellationTimestamp, normalizeTaskForLoad } from '../task-status';
import { mapSqliteTaskRow, rawReadTaskSnapshot } from '../sqlite-adapter';
import { rawReadProjectSnapshot, rawReadRow, rememberRawReadRow } from '../sqlite-raw-snapshot';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from '../task-sync-schema';
import { logInfo, logWarn } from '../logger';
import { clearDerivedCache } from '../store-settings';
import { generateUUID as uuidv4 } from '../uuid';
import { DEFAULT_PROJECT_COLOR } from '../color-constants';
import { findSelectableProjectByTitleAndArea, normalizeProjectTaskSortBy } from '../project-utils';
import { PROJECT_SQLITE_COLUMNS, projectFromSqliteRow, projectToSqliteRow } from '../project-sync-schema';
import { taskEditValuesEqual } from '../json-value-equality';
import { planAttachmentLinkBatch, softDeleteAttachment } from '../attachment-editor-model';
import type { Area, Attachment, TaskSortBy } from '../types';
import type { Project, ProjectCoreActions, ProjectActionContext, Section, Task, TaskStatus } from './shared';
import type { PreparedProjectArea, PreparedProjectAttachmentWrite, PreparedProjectFileAddWrite, PreparedProjectFileRemoveWrite, PreparedProjectCreate, PreparedProjectDate, PreparedProjectDelete, PreparedProjectDeleteUndo, PreparedProjectDuplicate, PreparedProjectLifecycle, PreparedProjectFlow, PreparedProjectTaskSort, PreparedProjectFocus, PreparedProjectNotesWrite, PreparedProjectTagsWrite, PreparedProjectRename, PreparedProjectStatus, PreparedTaskEditResult, PreparedTrashProjectRestore, ProjectAttachmentIntent, ProjectFileRemoveIntent, ProjectFlowAction, TaskStore } from '../store-types';
import { projectTagsForIntent, type ProjectTagsIntent } from '../project-tags';
import { settingsWithPurgedParentAttachmentDeletes } from '../attachment-cleanup';
import {
    compactPurgedProjectForLocalStorage,
    compactPurgedProjectSectionTombstone,
} from '../tombstone-compaction';
import { actionFail, actionOk, mutateEntities, projectDeleteUndoReattachments,
    type DetachedProjectTask } from './shared';
import { sameSectionSqliteRow, sameTaskSqliteRow } from './section-actions';
import { buildTaskContainerMovePatch, reserveTaskContainerProjectOrder } from '../task-container-rules';
import type { PreparedAreaAuthority, SelectedProjectAvailabilityWrite } from '../store-types';
import { getAttachmentAvailabilityPatch } from '../mobile-attachment-availability';

const duplicateProjectAttachmentCopy = (attachment: NonNullable<Project['attachments']>[number], now: string,
    nextId: () => string) => ({
    ...attachment,
    id: nextId(),
    createdAt: now,
    updatedAt: now,
    deletedAt: undefined,
    cloudKey: undefined,
    fileHash: undefined,
    localStatus: undefined,
    contentRev: undefined,
    contentMtimeMs: undefined,
    contentSize: undefined,
});

/** Exact RN duplicateProject allocation and row policy, with caller-owned IDs. */
export const projectDuplicateEffect = (scope: PreparedProjectDuplicate['scope'], deviceId: string,
    now: string, nextId: () => string): PreparedProjectDuplicate['effect'] => {
    const source = scope.project;
    const maxOrder = scope.sameAreaProjects
        .reduce((max, row) => Math.max(max, Number.isFinite(row.order) ? row.order : -1), -1);
    const projectAttachments = (source.attachments || [])
        .filter((attachment) => !attachment.deletedAt)
        .map((attachment) => duplicateProjectAttachmentCopy(attachment, now, nextId));
    const project: Project = {
        ...source,
        id: nextId(),
        title: `${source.title} (Copy)`,
        order: maxOrder + 1,
        isFocused: false,
        cancelledAt: undefined,
        archivedAt: source.status === 'archived' ? now : undefined,
        attachments: projectAttachments.length > 0 ? projectAttachments : undefined,
        createdAt: now,
        updatedAt: now,
        deletedAt: undefined,
        rev: 1,
        revBy: deviceId,
    };
    const sectionIdMap = new Map<string, string>();
    const sections = scope.sections.filter((section) => !section.deletedAt).map((section) => {
        const id = nextId();
        sectionIdMap.set(section.id, id);
        return { ...section, id, projectId: project.id, createdAt: now, updatedAt: now,
            deletedAt: undefined, rev: 1, revBy: deviceId };
    });
    const tasks = scope.tasks.filter((task) => !task.deletedAt).map((task) => {
        const checklist = task.checklist?.map((item) => ({
            ...item, id: nextId(), isCompleted: false,
        }));
        const attachments = (task.attachments || [])
            .filter((attachment) => !attachment.deletedAt)
            .map((attachment) => duplicateProjectAttachmentCopy(attachment, now, nextId));
        const nextSectionId = task.sectionId ? sectionIdMap.get(task.sectionId) : undefined;
        const result: Task = {
            ...task,
            id: nextId(),
            projectId: project.id,
            sectionId: nextSectionId,
            status: (task.status === 'reference' ? 'reference' : 'next') as TaskStatus,
            startTime: undefined,
            dueDate: undefined,
            reviewAt: undefined,
            completedAt: undefined,
            cancelledAt: undefined,
            archivedAt: undefined,
            isFocusedToday: false,
            pushCount: 0,
            checklist,
            attachments: attachments.length > 0 ? attachments : undefined,
            createdAt: now,
            updatedAt: now,
            deletedAt: undefined,
            purgedAt: undefined,
            rev: 1,
            revBy: deviceId,
        };
        return result;
    });
    return { project, sections, tasks };
};

type BuildNewProjectParams = {
    title: string;
    color?: string;
    initialProps?: Partial<Project>;
    existingProjects: readonly Project[];
    /** Needed only to stamp `areaTitle`, the denormalized copy of the area name
     *  that every other project writer keeps in step. Omitting it at creation
     *  leaves a project the sync merge has to repair on the next cycle. */
    existingAreas: readonly Area[];
    settings: TaskStore['settings'];
    deviceId: string;
    now: string;
    id?: string;
};

/** At most this many projects can be starred (focused) at once. */
export const MAX_FOCUSED_PROJECTS = 5;

/** RN's existing toggle policy, shared with the prepared native writer. */
export const projectFocusToggleUpdate = (project: Project, focusedProjectCount: number): { isFocused: boolean } | null => {
    if (project.status !== 'active' && !project.isFocused) return null;
    if (!project.isFocused && focusedProjectCount >= MAX_FOCUSED_PROJECTS) return null;
    return { isFocused: !project.isFocused };
};

export const countFocusedLiveProjects = (projects: readonly Project[]): number =>
    projects.filter((project) => !project.deletedAt && project.isFocused).length;

const projectJsonColumns = new Set(['tagIds', 'attachments']);
/** Compare the complete persisted Project, tolerating only JSON object-member key order. */
export const sameProjectSqliteRow = (left: Project, right: Project): boolean => {
    const before = projectToSqliteRow(left);
    const after = projectToSqliteRow(right);
    return before.length === after.length && before.every((value, index) => {
        const other = after[index];
        return projectJsonColumns.has(PROJECT_SQLITE_COLUMNS[index]) && typeof value === 'string'
            && typeof other === 'string' ? taskEditValuesEqual(JSON.parse(value), JSON.parse(other))
                : Object.is(value, other);
    });
};

/** Add must not silently normalize a raw scalar cell that its frozen DTO cannot retain. */
export const projectFileAddScalarCellsMatchWriter = (project: Project): boolean => {
    const projection = projectToSqliteRow(project), raw = rawReadRow(project, projection).row;
    return projection.every((value, index) => projectJsonColumns.has(PROJECT_SQLITE_COLUMNS[index])
        || PROJECT_SQLITE_COLUMNS[index] === 'viewSectionIds'
        || Object.is(raw[index], value));
};

/** Project-owned file Add retains raw JSON presence through the display codec. */
export const sameProjectFileAddSqliteRow = (left: Project, right: Project): boolean => {
    if (!projectFileAddScalarCellsMatchWriter(left) || !projectFileAddScalarCellsMatchWriter(right)) return false;
    const before = rawReadProjectSnapshot(left), after = rawReadProjectSnapshot(right);
    return !!before && !!after && sameProjectSqliteRow(before, after);
};

/** Match the actual saved Project to either host's live display without changing its raw witness. */
export const projectFileAddLiveRowMatches = (live: Project, saved: Project): boolean => {
    if (sameProjectFileAddSqliteRow(live, saved)) return true;
    const values = projectToSqliteRow(rawReadProjectSnapshot(saved) ?? saved);
    const display = normalizeProjectLifecycleFields(projectFromSqliteRow(Object.fromEntries(
        PROJECT_SQLITE_COLUMNS.map((column, index) => [column, values[index]]))));
    return sameProjectSqliteRow(live, display);
};

/** One exact selected availability write, preserving every untouched raw SQL cell. */
const selectedProjectAvailabilityPlan = (before: Project, rawBefore: unknown[], attachmentId: string,
    targetURI: string, deviceIdBefore: string | null, deviceIdToInitialize: string | null,
    updateAt: string, ordinary: boolean): SelectedProjectAvailabilityWrite | null => {
    if (before.deletedAt || before.purgedAt || rawBefore.length !== PROJECT_SQLITE_COLUMNS.length
        || !Number.isFinite(Date.parse(updateAt)) || new Date(updateAt).toISOString() !== updateAt
        || (deviceIdBefore === null ? !deviceIdToInitialize : deviceIdToInitialize !== null)) return null;
    const matches = before.attachments?.filter((item) => item.id === attachmentId) ?? [];
    const selected = matches.length === 1 ? matches[0] : undefined;
    if (!selected || selected.kind !== 'file' || selected.deletedAt || !targetURI
        || selected.uri === targetURI && (!ordinary || selected.localStatus === 'available')) return null;
    const rev = nextRevision(before.rev);
    if (!Number.isSafeInteger(rev) || rev <= (before.rev ?? 0)) return null;
    const patch = getAttachmentAvailabilityPatch(selected, { ...selected, uri: targetURI, localStatus: 'available' });
    const after: Project = { ...before, attachments: before.attachments!.map((item) => item.id === attachmentId
        ? { ...item, ...patch } : item), rev, revBy: deviceIdBefore ?? deviceIdToInitialize!, updatedAt: updateAt };
    const rawAfter = [...rawBefore];
    for (const field of ['attachments', 'rev', 'revBy', 'updatedAt'] as const)
        rawAfter[PROJECT_SQLITE_COLUMNS.indexOf(field)] = field === 'attachments' ? JSON.stringify(after.attachments) : after[field];
    return { projectId: before.id, attachmentId, targetURI, before, after, rawBefore, rawAfter,
        deviceIdBefore, deviceIdToInitialize, updateAt };
};

/** Relocated repair keeps its historical different-URI requirement. */
export const projectAvailabilityWritePlan = (before: Project, rawBefore: unknown[], attachmentId: string,
    targetURI: string, deviceIdBefore: string | null, deviceIdToInitialize: string | null, updateAt: string) =>
    selectedProjectAvailabilityPlan(before, rawBefore, attachmentId, targetURI,
        deviceIdBefore, deviceIdToInitialize, updateAt, false);

/** Private ordinary availability still requires a real metadata change.
 * The caller must independently prove owned absent-target publication or an existing verified managed generation. */
export const projectFileAvailabilityWritePlan = (before: Project, rawBefore: unknown[], attachmentId: string,
    targetURI: string, deviceIdBefore: string | null, deviceIdToInitialize: string | null, updateAt: string) =>
    selectedProjectAvailabilityPlan(before, rawBefore, attachmentId, targetURI,
        deviceIdBefore, deviceIdToInitialize, updateAt, true);

/** Private WebDAV outcomes retain RN metadata presence; measured file hashes are proof only. */
export const projectWebDavAvailabilityWritePlan = (before: Project, rawBefore: unknown[], attachmentId: string,
    targetURI: string, deviceIdBefore: string | null, deviceIdToInitialize: string | null, updateAt: string,
    outcome: 'available' | 'unrecoverable'): SelectedProjectAvailabilityWrite | null => {
    const matches = before.attachments?.filter(item => item.id === attachmentId) ?? [];
    const selected = matches.length === 1 ? matches[0] : undefined;
    if (!selected || selected.kind !== 'file' || selected.deletedAt || before.deletedAt || before.purgedAt
        || rawBefore.length !== PROJECT_SQLITE_COLUMNS.length || !targetURI) return null;
    if (outcome === 'available') {
        if (selected.uri !== targetURI || selected.localStatus !== 'available') return projectFileAvailabilityWritePlan(
            before, rawBefore, attachmentId, targetURI, deviceIdBefore, deviceIdToInitialize, updateAt);
        if (deviceIdToInitialize !== null || updateAt !== before.updatedAt) return null;
        return { projectId: before.id, attachmentId, targetURI, outcome: 'noop', before, after: before,
            rawBefore, rawAfter: [...rawBefore], deviceIdBefore, deviceIdToInitialize: null, updateAt };
    }
    if (!Number.isFinite(Date.parse(updateAt)) || new Date(updateAt).toISOString() !== updateAt
        || (deviceIdBefore === null ? !deviceIdToInitialize : deviceIdToInitialize !== null)) return null;
    const rev = nextRevision(before.rev);
    if (!Number.isSafeInteger(rev) || rev <= (before.rev ?? 0)) return null;
    const patch = getAttachmentUnrecoverablePatch({ ...selected, cloudKey: undefined, fileHash: undefined,
        localStatus: 'missing', deletedAt: updateAt, updatedAt: updateAt });
    const after: Project = { ...before, attachments: before.attachments!.map(item => {
        if (item.id !== attachmentId) return item;
        const resolved = { ...item, ...patch };
        // The private JSON envelope preserves RN's persisted absence, not undefined values.
        delete resolved.cloudKey; delete resolved.fileHash;
        return resolved;
    }), rev, revBy: deviceIdBefore ?? deviceIdToInitialize!, updatedAt: updateAt };
    const rawAfter = [...rawBefore];
    for (const field of ['attachments', 'rev', 'revBy', 'updatedAt'] as const)
        rawAfter[PROJECT_SQLITE_COLUMNS.indexOf(field)] = field === 'attachments' ? JSON.stringify(after.attachments) : after[field];
    return { projectId: before.id, attachmentId, targetURI, outcome: 'unrecoverable', before, after,
        rawBefore, rawAfter, deviceIdBefore, deviceIdToInitialize, updateAt };
};

export const sameProjectAvailabilityRawRow = (project: Project, cells: unknown[]): boolean =>
    projectFileAddScalarCellsMatchWriter(project)
    && taskEditValuesEqual(rawReadRow(project, projectToSqliteRow(project)).row, cells);

/** The existing RN Restore policy, also used to derive native prepared effects. */
export const projectRestoreEffect = (scope: PreparedTrashProjectRestore['scope'], deviceId: string,
    now: string): PreparedTrashProjectRestore['effect'] => {
    const target = scope.project;
    const restoredArea = scope.area && scope.area.id === target.areaId && !scope.area.deletedAt
        ? scope.area : undefined;
    const restoredProject: Project = { ...target, deletedAt: undefined,
        areaId: restoredArea ? target.areaId : undefined,
        areaTitle: restoredArea
            ? (typeof target.areaTitle === 'string' && target.areaTitle.trim().length > 0
                ? target.areaTitle : restoredArea.name) : undefined,
        updatedAt: now, rev: nextRevision(target.rev), revBy: deviceId };
    const sections = scope.sections.filter((row) => row.deletedAt === target.deletedAt).map((before) => ({
        before, after: { ...before, deletedAt: undefined, updatedAt: now,
            rev: nextRevision(before.rev), revBy: deviceId } as Section,
    }));
    const restoredSectionIds = new Set(scope.sections
        .filter((row) => !row.deletedAt || row.deletedAt === target.deletedAt).map((row) => row.id));
    const tasks = scope.tasks.filter((row) => row.deletedAt === target.deletedAt && !row.purgedAt)
        .map((before) => ({ before, after: { ...before, deletedAt: undefined,
            sectionId: before.sectionId && restoredSectionIds.has(before.sectionId)
                ? before.sectionId : undefined,
            updatedAt: now, rev: nextRevision(before.rev), revBy: deviceId } as Task }));
    return { project: { before: target, after: restoredProject }, tasks, sections };
};

/** RN deleteProject's complete Project/Section/Task update, without broad snapshot replacement. */
export const projectDeleteEffect = (scope: PreparedProjectDelete['scope'], deviceId: string,
    now: string): PreparedProjectDelete['effect'] => {
    const project = scope.project;
    return {
        project: { before: project, after: { ...project, deletedAt: now, updatedAt: now,
            rev: nextRevision(project.rev), revBy: deviceId } },
        sections: scope.sections.filter((row) => !row.deletedAt).map((before) => ({ before,
            after: { ...before, deletedAt: now, updatedAt: now,
                rev: nextRevision(before.rev), revBy: deviceId } })),
        tasks: scope.tasks.filter((row) => !row.deletedAt).map((before) => ({ before,
            after: { ...before, projectId: undefined, sectionId: undefined, updatedAt: now,
                rev: nextRevision(before.rev), revBy: deviceId } })),
    };
};

/** RN Undo eligibility applied to current rows after the shared Project restore projection. */
export const projectDeleteUndoEffect = (scope: PreparedProjectDeleteUndo['scope'],
    links: readonly DetachedProjectTask[], deviceId: string, now: string): PreparedProjectDeleteUndo['effect'] => {
    // RN restores children owned by the Project, while the prepared witness also
    // tracks inconsistent section-only rows for the mutation-boundary CAS.
    const restored = projectRestoreEffect({ ...scope,
        tasks: scope.tasks.filter((row) => row.projectId === scope.project.id) }, deviceId, now);
    const restoredSections = replaceEntitiesInArray(scope.sections, restored.sections.map((row) => row.after));
    const restoredTasks = replaceEntitiesInArray(scope.tasks, restored.tasks.map((row) => row.after));
    const candidates = scope.linkedTasks.flatMap(({ row }) => row ? [row] : []);
    const projectedCandidates = candidates.map((row) =>
        restored.tasks.find((pair) => pair.before.id === row.id)?.after ?? row);
    const reattachments = projectDeleteUndoReattachments(scope.project.id, links,
        restoredSections, projectedCandidates);
    const reserveOrder = createProjectOrderReserver(restoredTasks);
    return { project: restored.project, sections: restored.sections,
        tasks: [...restored.tasks, ...reattachments.map(({ id, updates }) => {
            const before = candidates.find((row) => row.id === id)!;
            const container = buildTaskContainerMovePatch({ task: before, updates,
                allProjects: [restored.project.after], allSections: restoredSections,
                allAreas: scope.area ? [scope.area] : [], reserveProjectOrder: false });
            if (!container.ok) throw new Error(container.error);
            const normalized = normalizeTaskUpdate(before, { ...updates, ...container.updates });
            const adjusted = reserveTaskContainerProjectOrder({ task: before,
                updates: { ...normalized, ...container.updates }, projectOrderReserver: reserveOrder });
            const { updatedTask } = applyTaskUpdates(before, { ...adjusted,
                rev: nextRevision(before.rev), revBy: deviceId }, now);
            return { before, after: updatedTask };
        })] };
};

const sameOwnedRows = <T extends { id: string }>(current: T[], frozen: T[], same: (a: T, b: T) => boolean) => {
    if (current.length !== frozen.length || new Set(frozen.map((row) => row.id)).size !== frozen.length) return false;
    const byId = new Map(current.map((row) => [row.id, row]));
    return byId.size === current.length && frozen.every((row) => {
        const saved = byId.get(row.id);
        return saved !== undefined && same(saved, row);
    });
};

const projectDeleteScopeRows = (state: TaskStore, projectId: string) => {
    const sections = state._allSections.filter((section) => section.projectId === projectId);
    const sectionIds = new Set(sections.map((section) => section.id));
    const tasks = state._allTasks.filter((task) => task.projectId === projectId
        || (task.sectionId !== undefined && sectionIds.has(task.sectionId)));
    return { sections, tasks };
};

const projectLifecycleScopeRows = (state: TaskStore, projectId: string) => {
    const sections = state._allSections.filter((section) => section.projectId === projectId);
    const sectionIds = new Set(sections.map((section) => section.id));
    const tasks = state._allTasks.filter((task) => task.projectId === projectId
        || (!task.projectId && task.sectionId !== undefined && sectionIds.has(task.sectionId)));
    return { sections, tasks };
};

const afterRows = <T extends { id: string }>(scope: T[], effect: { before: T; after: T }[]) =>
    scope.map((row) => effect.find((pair) => pair.before.id === row.id)?.after ?? row);

const sameLinkedTasks = (state: TaskStore, linked: PreparedProjectDeleteUndo['scope']['linkedTasks']) =>
    linked.every(({ id, row }) => {
        const current = state._tasksById.get(id) ?? null;
        return current === null || row === null ? current === row : sameTaskSqliteRow(current, row);
    });

export const projectFocusEffect = (project: Project, focusedProjectCount: number, focused: boolean,
    deviceId: string, now: string): PreparedProjectFocus['effect'] | null => {
    const update = projectFocusToggleUpdate(project, focusedProjectCount);
    return update?.isFocused === focused ? { project: { before: project, after: {
        ...project, ...update, updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    } } } : null;
};

export const normalizeProjectRenameTitle = (title: string): string => title.trim();

/** RN updateProject's nonarchived title-only lifecycle result, without child writes. */
export const projectRenameEffect = (project: Project, title: string, deviceId: string,
    now: string): PreparedProjectRename['effect'] => {
    const normalizedTitle = normalizeProjectRenameTitle(title);
    const transition = applyProjectLifecycleTransition(project, { title: normalizedTitle }, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** RN updateProject's nonstatus flow-field lifecycle result, without child writes. */
export const projectFlowEffect = (project: Project, action: ProjectFlowAction, deviceId: string,
    now: string): PreparedProjectFlow['effect'] | null => {
    if (action.kind === 'setScope' && (!project.isSequential || project.sequentialScope === action.scope)) return null;
    const patch: Partial<Project> = action.kind === 'toggleType'
        ? { isSequential: !project.isSequential } : { sequentialScope: action.scope };
    const transition = applyProjectLifecycleTransition(project, patch, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** RN updateProject's Project-only sort result, normalized for synced storage. */
export const projectTaskSortEffect = (project: Project, sortBy: TaskSortBy, deviceId: string,
    now: string): PreparedProjectTaskSort['effect'] | null => {
    const desired = normalizeProjectTaskSortBy(sortBy);
    if (normalizeProjectTaskSortBy(project.taskSortBy) === desired) return null;
    const transition = applyProjectLifecycleTransition(project, { taskSortBy: desired }, [], [], now, deviceId);
    const after = normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    });
    if (!desired) delete after.taskSortBy;
    return { project: { before: project, after } };
};

/** Empty against absent or empty Notes is a no-op; every other character is raw data. */
export const isProjectNotesWriteNoop = (project: Project, text: string): boolean =>
    project.supportNotes === text || (text === '' && !project.supportNotes);

/** RN updateProject's raw supportNotes-only lifecycle result, without child writes. */
export const projectNotesWriteEffect = (project: Project, text: string, deviceId: string,
    now: string): PreparedProjectNotesWrite['effect'] => {
    const transition = applyProjectLifecycleTransition(project, { supportNotes: text }, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** RN updateProject's tagIds-only lifecycle result, preserving unrelated raw columns. */
export const projectTagsWriteEffect = (project: Project, intent: ProjectTagsIntent, deviceId: string,
    now: string): PreparedProjectTagsWrite['effect'] | null => {
    const tagIds = projectTagsForIntent(project.tagIds ?? [], intent);
    if (taskEditValuesEqual(project.tagIds ?? [], tagIds)) return null;
    const transition = applyProjectLifecycleTransition(project, { tagIds }, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** RN updateProject's URL-only attachment change, with IDs fixed by the prepared request. */
export const projectAttachmentWriteEffect = (project: Project, intent: ProjectAttachmentIntent, ids: string[],
    deviceId: string, now: string): PreparedProjectAttachmentWrite['effect'] | null => {
    let attachments: NonNullable<Project['attachments']>;
    if (intent.kind === 'add') {
        let index = 0;
        const batch = planAttachmentLinkBatch(intent.text, { newId: () => ids[index++] ?? '', now, t: (key) => key });
        if (batch.kind !== 'add' || index !== ids.length || ids.some((id) => (project.attachments ?? []).some((row) => row.id === id))) return null;
        attachments = [...(project.attachments ?? []), ...batch.added];
    } else {
        const target = project.attachments?.find((row) => row.id === intent.attachmentId);
        if (ids.length !== 1 || ids[0] !== intent.attachmentId || target?.kind !== 'link' || target.deletedAt) return null;
        attachments = softDeleteAttachment(project.attachments ?? [], intent.attachmentId, now);
    }
    const transition = applyProjectLifecycleTransition(project, { attachments }, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** RN Remove tombstones file metadata; file bytes belong to the later sync cleanup policy. */
export const projectFileRemoveWriteEffect = (project: Project, intent: ProjectFileRemoveIntent, ids: string[],
    deviceId: string, now: string): PreparedProjectFileRemoveWrite['effect'] | null => {
    const target = project.attachments?.find((row) => row.id === intent.attachmentId);
    if (intent.kind !== 'remove' || ids.length !== 1 || ids[0] !== intent.attachmentId
        || target?.kind !== 'file' || target.deletedAt) return null;
    const attachments = softDeleteAttachment(project.attachments ?? [], intent.attachmentId, now);
    const transition = applyProjectLifecycleTransition(project, { attachments }, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** RN Project file Add appends completed metadata through the existing Project lifecycle. */
export const projectFileAddWriteEffect = (project: Project, attachment: Attachment, deviceId: string,
    now: string): PreparedProjectFileAddWrite['effect'] | null => {
    if (attachment.kind !== 'file' || (project.attachments?.length ?? 0) >= 1_000
        || project.attachments?.some((row) => row.id === attachment.id)) return null;
    const attachments = [...(project.attachments ?? []), attachment];
    const transition = applyProjectLifecycleTransition(project, { attachments }, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** RN updateProject's Active/Waiting/Someday lifecycle result, without child writes. */
export const projectStatusEffect = (project: Project, status: 'active' | 'waiting' | 'someday',
    deviceId: string, now: string): PreparedProjectStatus['effect'] => {
    const transition = applyProjectLifecycleTransition(project, { status }, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** RN updateProject's Complete/Cancel/Reactivate helper and exact changed child rows. */
export const projectLifecycleEffect = (scope: PreparedProjectLifecycle['scope'],
    action: PreparedProjectLifecycle['request']['action'], deviceId: string,
    now: string): PreparedProjectLifecycle['effect'] => {
    let updates: Partial<Project>;
    switch (action) {
        case 'complete': updates = { status: 'archived' }; break;
        case 'cancel': updates = { status: 'archived', cancelledAt: now }; break;
        case 'reactivate': updates = { status: 'active' }; break;
        default: throw new Error('Unknown Project lifecycle action');
    }
    const transition = applyProjectLifecycleTransition(scope.project, updates,
        scope.tasks, scope.sections, now, deviceId);
    const incomingStatus = transition.projectUpdates.status ?? scope.project.status;
    const statusChanged = incomingStatus !== scope.project.status;
    const projectAfter = normalizeProjectLifecycleFields({
        ...scope.project,
        ...transition.projectUpdates,
        ...(statusChanged && incomingStatus !== 'active' ? { isFocused: false } : {}),
        updatedAt: now,
        rev: nextRevision(scope.project.rev),
        revBy: deviceId,
    });
    return {
        project: { before: scope.project, after: projectAfter },
        tasks: scope.tasks.flatMap((before, index) => {
            const after = transition.tasks[index];
            return taskEditValuesEqual(before, after) ? [] : [{ before, after }];
        }),
        sections: scope.sections.flatMap((before, index) => {
            const after = transition.sections[index];
            return taskEditValuesEqual(before, after) ? [] : [{ before, after }];
        }),
    };
};

/** RN updateProject's Project date lifecycle result, with no child writes. */
export const projectDateEffect = (project: Project, field: 'startDate' | 'dueDate' | 'reviewAt', value: string | null,
    deviceId: string, now: string): PreparedProjectDate['effect'] => {
    const transition = applyProjectLifecycleTransition(project, { [field]: value ?? undefined }, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

/** Clearing absent/null/empty preserves the original raw representation. */
export const isProjectDateNoop = (project: Project, field: 'startDate' | 'dueDate' | 'reviewAt', value: string | null): boolean =>
    value === null ? !project[field] : project[field] === value;

/** RN's destination-tail max includes tombstones and ignores nonfinite orders. */
export const projectAreaOrderMax = (projects: readonly Project[], areaId: string | null): number => projects
    .filter((project) => (project.areaId ?? null) === areaId)
    .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);

/** Own `areaId` is a selection; omission must leave Area metadata untouched. */
export const projectAreaSelection = (project: Project, updates: Partial<Project>,
    projects: readonly Project[], areas: readonly Area[]) => {
    const selected = Object.prototype.hasOwnProperty.call(updates, 'areaId');
    const areaId = selected ? updates.areaId ?? undefined : project.areaId;
    const changed = selected && (areaId ?? undefined) !== (project.areaId ?? undefined);
    const areaTitle = selected
        ? (areaId ? areas.find((area) => area.id === areaId && !area.deletedAt)?.name?.trim() || undefined : undefined)
        : project.areaTitle;
    const metadataChanged = selected && (changed || areaTitle !== project.areaTitle);
    const order = changed && !Number.isFinite(updates.order)
        ? projectAreaOrderMax(projects, areaId ?? null) + 1 : updates.order;
    return { selected, metadataChanged, fields: selected ? { areaId, areaTitle } : {}, order };
};

/** The same Area/title/order transition as RN updateProject, with one Project row only. */
export const projectAreaEffect = (project: Project, areaId: string | null,
    projects: readonly Project[], areas: readonly Area[], deviceId: string,
    now: string): PreparedProjectArea['effect'] => {
    const area = projectAreaSelection(project, { areaId: areaId ?? undefined }, projects, areas);
    const patch = { ...area.fields, ...(Number.isFinite(area.order) ? { order: area.order } : {}) };
    const transition = applyProjectLifecycleTransition(project, patch, [], [], now, deviceId);
    return { project: { before: project, after: normalizeProjectLifecycleFields({
        ...project, ...transition.projectUpdates,
        updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId,
    }) } };
};

export const buildNewProject = ({
    title,
    color,
    initialProps,
    existingProjects,
    existingAreas,
    settings,
    deviceId,
    now,
    id,
}: BuildNewProjectParams): Project => {
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    const targetAreaId = initialProps?.areaId;
    const maxOrder = existingProjects
        .filter((project) => (project.areaId ?? undefined) === (targetAreaId ?? undefined))
        .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
    const baseOrder = Number.isFinite(initialProps?.order) ? (initialProps?.order as number) : maxOrder + 1;
    const hasExplicitFlowMode = Boolean(
        initialProps && Object.prototype.hasOwnProperty.call(initialProps, 'isSequential')
    );
    const useSequentialDefault = !hasExplicitFlowMode
        && settings.gtd?.defaultProjectFlowMode === 'sequential';

    const baseProject: Project = {
        id: id ?? uuidv4(),
        title: trimmedTitle,
        color: color ?? DEFAULT_PROJECT_COLOR,
        order: baseOrder,
        status: 'active',
        rev: 1,
        revBy: deviceId,
        createdAt: now,
        updatedAt: now,
        // Canonical form for both is an explicit `false` (sync-normalization.ts
        // materializes them); see the same note in store-tasks.ts.
        isSequential: false,
        isFocused: false,
        ...(useSequentialDefault ? { isSequential: true } : {}),
        tagIds: [],
    };
    const project: Project = {
        ...baseProject,
        ...initialProps,
        tagIds: initialProps?.tagIds ?? [],
    };
    // Normalize the initial props as an update to the defaults, so entering a
    // non-active status at creation clears focus exactly like a later edit.
    const lifecycleProject = normalizeProjectLifecycleFields({
        ...project,
        ...normalizeProjectUpdate(baseProject, initialProps ?? {}),
        archivedAt: project.status === 'archived' ? now : undefined,
    });
    // Resolved from the FINAL areaId, which initialProps may have supplied.
    const areaTitle = lifecycleProject.areaId
        ? existingAreas.find((area) => area.id === lifecycleProject.areaId && !area.deletedAt)?.name?.trim() || undefined
        : undefined;
    return areaTitle === lifecycleProject.areaTitle ? lifecycleProject : { ...lifecycleProject, areaTitle };
};

const commitProjectAvailabilityWrite = async (input: SelectedProjectAvailabilityWrite, authority: PreparedAreaAuthority,
    { set, debouncedSave, getSaveGeneration }: Pick<ProjectActionContext, 'set' | 'debouncedSave' | 'getSaveGeneration'>,
    ordinary: boolean): Promise<PreparedTaskEditResult> => {
    let result: PreparedTaskEditResult = { success: false, reason: 'conflict' };
    const planned = ordinary && input.outcome !== undefined
        ? projectWebDavAvailabilityWritePlan(input.before, input.rawBefore, input.attachmentId, input.targetURI,
            input.deviceIdBefore, input.deviceIdToInitialize, input.updateAt, input.outcome === 'noop' ? 'available' : 'unrecoverable')
        : (ordinary ? projectFileAvailabilityWritePlan : projectAvailabilityWritePlan)(input.before, input.rawBefore, input.attachmentId, input.targetURI,
            input.deviceIdBefore, input.deviceIdToInitialize, input.updateAt);
    if (!planned || !taskEditValuesEqual(planned, input)) return result;
    set((state) => {
        const bound = authority.state, durable = authority.snapshot;
        if (state._allTasks !== bound._allTasks || state._allProjects !== bound._allProjects
            || state._allSections !== bound._allSections || state._allAreas !== bound._allAreas
            || state._allPeople !== bound._allPeople || state.settings !== bound.settings
            || state.lastDataChangeAt !== bound.lastDataChangeAt || state.persistenceFailure) return state;
        const matches = durable.projects.filter((row) => row.id === input.projectId);
        const current = matches.length === 1 ? matches[0] : undefined;
        const live = state._projectsById.get(input.projectId);
        if (!current || !live || !projectFileAddLiveRowMatches(live, current)) return state;
        if (ordinary && sameProjectAvailabilityRawRow(current, input.rawAfter)
            && (durable.settings.deviceId ?? null) === (input.deviceIdBefore ?? input.deviceIdToInitialize)
            && (state.settings.deviceId ?? null) === (input.deviceIdBefore ?? input.deviceIdToInitialize)) {
            result = { success: true, id: current.id, outcome: 'replayed' }; return state;
        }
        if (!sameProjectAvailabilityRawRow(current, input.rawBefore)
            || !taskEditValuesEqual(rawReadProjectSnapshot(current), input.before)
            || (durable.settings.deviceId ?? null) !== input.deviceIdBefore
            || (state.settings.deviceId ?? null) !== input.deviceIdBefore) return state;
        const after = { ...planned.after };
        rememberRawReadRow(after, Object.fromEntries(PROJECT_SQLITE_COLUMNS.map((column, index) =>
            [column, planned.rawAfter[index]])), PROJECT_SQLITE_COLUMNS, projectToSqliteRow(after));
        const projects = replaceEntitiesInArray(durable.projects, [after]);
        const settings = input.deviceIdToInitialize
            ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
        persist(set, debouncedSave, { ...state, _allTasks: durable.tasks, _allProjects: durable.projects,
            _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings },
        { ...durable, projects, settings });
        const lastDataChangeAt = getNextDataChangeAt(state.lastDataChangeAt);
        authority.saveBoundary = { taskReference: state._allTasks, lastDataChangeAt,
            generation: getSaveGeneration(), failure: state.persistenceFailure };
        result = { success: true, id: current.id, outcome: 'applied' };
        return { _allProjects: replaceEntitiesInArray(state._allProjects, [after]), lastDataChangeAt,
            ...(input.deviceIdToInitialize ? { settings: { ...state.settings, deviceId: input.deviceIdToInitialize } } : {}) };
    });
    return result;
};


export const createProjectCoreActions = ({
    set,
    get,
    debouncedSave,
    flushPendingSave,
    getSaveGeneration,
}: ProjectActionContext): ProjectCoreActions => ({
    addProject: async (title: string, color: string, initialProps?: Partial<Project>) => {
        const changeAt = Date.now();
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!trimmedTitle) {
            set({ error: 'Project title is required' });
            return null;
        }
        if (
            initialProps
            && Object.prototype.hasOwnProperty.call(initialProps, 'cancelledAt')
            && initialProps.cancelledAt != null
            && normalizeCancellationTimestamp(initialProps.cancelledAt) === undefined
        ) {
            set({ error: 'Cancellation timestamp must be an ISO datetime with timezone' });
            return null;
        }
        const targetAreaId = typeof initialProps?.areaId === 'string' ? initialProps.areaId : undefined;
        let createdProject: Project | null = null;
        let existingProject: Project | null = null;
        set((state) => {
            const duplicate = findSelectableProjectByTitleAndArea(state._allProjects, trimmedTitle, targetAreaId);
            if (duplicate) {
                existingProject = duplicate;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const now = new Date().toISOString();
            const newProject = buildNewProject({
                title: trimmedTitle,
                color,
                initialProps,
                existingProjects: state._allProjects,
                existingAreas: state._allAreas,
                settings: state.settings,
                deviceId: deviceState.deviceId,
                now,
            });
            createdProject = newProject;
            const newAllProjects = [...state._allProjects, newProject];
            persist(set, debouncedSave, state, {
                projects: newAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (existingProject) {
            return existingProject;
        }
        return createdProject;
    },

    /** Apply exactly one validated native project row; never re-run title or area selection on receipt replay. */
    commitPreparedProjectCreate: async (input: PreparedProjectCreate): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared project creation conflicts with current data' };
        set((state) => {
            const existing = state._projectsById.get(input.project.id);
            const sameRow = existing && JSON.stringify(projectToSqliteRow(existing)) === JSON.stringify(projectToSqliteRow(input.project));
            // The complete target is durable authority even if its area, order, or settings changed afterward.
            if (sameRow) {
                result = { success: true, id: input.project.id, outcome: 'replayed' };
                return state;
            }
            if (existing || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || (state.settings.gtd?.defaultProjectFlowMode ?? null) !== input.defaultProjectFlowMode) return state;
            const area = input.selectedArea;
            if (area) {
                const current = state._areasById.get(area.id);
                if (!current || current.deletedAt || current.name !== area.name
                    || (current.color ?? null) !== area.color) return state;
            }
            const max = projectAreaOrderMax(state._allProjects, area?.id ?? null);
            if (max !== input.orderMax
                || findSelectableProjectByTitleAndArea(state._allProjects, input.project.title, area?.id)) return state;
            const projects = [...state._allProjects, input.project];
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: input.project.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectFocus: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Focus conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const planned = projectFocusEffect(current, countFocusedLiveProjects(state._allProjects), input.request.focused,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!planned || !taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectRename: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project rename conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const normalized = normalizeProjectRenameTitle(input.request.title);
            if (!normalized || normalized === current.title) return state;
            const planned = projectRenameEffect(current, normalized,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectFlow: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project flow conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            // Complete after-row receipt precedes mutable status, token, and device guards.
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const planned = projectFlowEffect(current, input.request.action,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!planned || !taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectTaskSort: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project task sort conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const planned = projectTaskSortEffect(current, input.request.sortBy,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!planned || !taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectNotesWrite: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Notes edit conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            // A complete after-row receipt precedes mutable status, token, and device guards.
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)
                || isProjectNotesWriteNoop(current, input.request.text)) return state;
            const planned = projectNotesWriteEffect(current, input.request.text,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectTagsWrite: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Tags edit conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            // A complete after-row receipt precedes mutable status, token, and device guards.
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const planned = projectTagsWriteEffect(current, input.request.intent,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!planned || !taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectAttachmentWrite: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project attachment edit conflicts with current data' };
        const intent = input.request.intent;
        if ('version' in input && input.version !== 1
            || intent.kind === 'remove' && input.scope.project.attachments
                ?.find((row) => row.id === intent.attachmentId)?.kind !== 'link') return result;
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const planned = projectAttachmentWriteEffect(current, input.request.intent, input.result.attachmentIds,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!planned || !taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectFileRemoveWrite: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project file removal conflicts with current data' };
        if (input.version !== 2 || input.request.intent.kind !== 'remove'
            || input.scope.project.attachments?.find((row) => row.id === input.request.intent.attachmentId)?.kind !== 'file') return result;
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const planned = projectFileRemoveWriteEffect(current, input.request.intent, input.result.attachmentIds,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!planned || !taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectFileAddWrite: async (input, authority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project file Add conflicts with current data' };
        if ((input.version !== 3 && input.version !== 4) || input.kind !== 'project-file-add'
            || input.version === 3 && ('version' in input.request || 'sourceSha256' in input.request)
            || input.version === 4 && (input.request.version !== 2
                || typeof input.request.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.request.sourceSha256)
                || input.attachment.fileHash !== input.request.sourceSha256)
            || input.attachment.id !== input.request.requestId || input.result.id !== input.request.projectId
            || !taskEditValuesEqual(input.result.attachmentIds, [input.request.requestId])) return result;
        const planned = projectFileAddWriteEffect(input.scope.project, input.attachment,
            input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
        if (!planned || !taskEditValuesEqual(planned, input.effect)) return result;
        set((state) => {
            const bound = authority.state, durable = authority.snapshot;
            if (state._allTasks !== bound._allTasks || state._allProjects !== bound._allProjects
                || state._allSections !== bound._allSections || state._allAreas !== bound._allAreas
                || state._allPeople !== bound._allPeople || state.settings !== bound.settings
                || state.lastDataChangeAt !== bound.lastDataChangeAt) return state;
            const matches = durable.projects.filter((row) => row.id === input.request.projectId);
            const current = matches.length === 1 ? matches[0] : undefined;
            const live = state._projectsById.get(input.request.projectId);
            if (!current || !live || !(projectFileAddLiveRowMatches(live, current)
                || state.persistenceFailure && projectFileAddLiveRowMatches(live, input.effect.project.after))) return state;
            if ((!input.deviceIdToInitialize || durable.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectFileAddSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (current.deletedAt || current.purgedAt || current.status === 'archived'
                || (durable.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectFileAddSqliteRow(current, input.scope.project)) return state;
            const projects = replaceEntitiesInArray(durable.projects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
            const liveSettings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, { ...state, _allTasks: durable.tasks, _allProjects: durable.projects,
                _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings },
            { ...durable, projects, settings });
            const lastDataChangeAt = getNextDataChangeAt(state.lastDataChangeAt);
            authority.saveBoundary = { taskReference: state._allTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: state.persistenceFailure };
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: replaceEntitiesInArray(state._allProjects, [planned.project.after]),
                settings: liveSettings, lastDataChangeAt };
        });
        return result;
    },

    commitSelectedProjectAvailability: (input, authority) =>
        commitProjectAvailabilityWrite(input, authority, { set, debouncedSave, getSaveGeneration }, false),
    commitPreparedProjectFileAvailability: (input, authority) =>
        commitProjectAvailabilityWrite(input, authority, { set, debouncedSave, getSaveGeneration }, true),

    commitPreparedProjectStatus: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project status conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            // A complete after-row receipt precedes mutable status, token, and device guards.
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || current.status === input.request.status
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const planned = projectStatusEffect(current, input.request.status,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectDate: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project date conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            // A complete after-row receipt precedes mutable date, token, and device guards.
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || isProjectDateNoop(current, input.request.field, input.request.value)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const planned = projectDateEffect(current, input.request.field, input.request.value,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectArea: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Area conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            // The full after-row receipt precedes all mutable Project, Area and order checks.
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameProjectSqliteRow(current, input.effect.project.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)) return state;
            const selected = input.scope.selectedArea;
            const area = selected ? state._areasById.get(selected.id) : null;
            if (selected && (!area || area.deletedAt || area.name !== selected.name)) return state;
            if (projectAreaOrderMax(state._allProjects, input.request.areaId) !== input.scope.orderMax) return state;
            if ((current.areaId ?? null) === input.request.areaId
                && (current.areaTitle ?? null) === (selected?.name.trim() || null)) return state;
            const planned = projectAreaEffect(current, input.request.areaId, state._allProjects,
                state._allAreas, input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    cancelProject: async (id: string) => {
        const project = get()._projectsById.get(id);
        if (!project || project.deletedAt || project.purgedAt) {
            const message = 'Project not found';
            set({ error: message });
            return actionFail(message);
        }
        const alreadyCancelled = isProjectCancelled(project);
        const retryingFailedCancellation = alreadyCancelled && Boolean(get().persistenceFailure);
        if (!alreadyCancelled) {
            const result = await get().updateProject(id, {
                status: 'archived',
                cancelledAt: new Date().toISOString(),
            });
            if (!result.success) return result;
        } else if (retryingFailedCancellation) {
            // A terminal flush dequeues its exhausted snapshot. The in-memory
            // cancellation still needs a fresh durable retry on the next user
            // acknowledgement attempt, without changing its revision or time.
            await get().persistSnapshot();
        }
        try {
            await flushPendingSave();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const message = `Failed to save project cancellation: ${detail}`;
            set({ error: message });
            return actionFail(message);
        }
        if (!alreadyCancelled || retryingFailedCancellation) {
            logInfo('Commitment cancellation saved', {
                scope: 'store',
                category: 'storage',
                context: {
                    releaseCheck: 'v1.3.0/commitment-cancelled',
                    kind: 'project',
                    outcome: 'cancelled',
                    count: 1,
                },
            });
        }
        return actionOk({ id });
    },

    commitPreparedProjectLifecycle: async (input, raw): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project lifecycle conflicts with current data' };
        set((memory) => {
            let state = memory;
            const durable = raw?.authority.snapshot;
            if (raw && durable) {
                const before = raw.authority.state;
                if (raw.requireBefore !== true || input.request.action !== 'complete'
                    || memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                    || memory._allSections !== before._allSections || memory._allAreas !== before._allAreas
                    || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                    || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
                const bound = <T extends { id: string }>(rows: T[], effects: { before: T; after: T }[], captures: { id: string; before: T | null }[]) =>
                    captures.length === effects.length && new Set(captures.map((row) => row.id)).size === captures.length
                    && effects.every((effect) => { const capture = captures.find((row) => row.id === effect.after.id);
                        const current = rows.filter((row) => row.id === effect.after.id);
                        return current.length === 1 && capture?.before !== null && taskEditValuesEqual(current[0], capture?.before); });
                const rawTasks = durable.tasks.map(rawReadTaskSnapshot);
                const rawProjects = durable.projects.map(rawReadProjectSnapshot);
                if (rawProjects.some((row) => !row) || rawTasks.some((row) => !row) || !bound(rawTasks.filter((row): row is Task => row !== null), input.effect.tasks, raw.rawBefore.tasks)
                    || !bound(rawProjects.filter((row): row is Project => row !== null), [input.effect.project], raw.rawBefore.projects)
                    || !bound(durable.sections ?? [], input.effect.sections, raw.rawBefore.sections)) return memory;
                const tasks = durable.tasks.map((task) => { const values = taskToSqliteRow(task);
                    return normalizeTaskForLoad(mapSqliteTaskRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, i) => [column, values[i]]))), input.updateAt); });
                const projects = durable.projects.map(normalizeProjectLifecycleFields); const sections = durable.sections ?? [];
                state = { ...memory, _allTasks: tasks, _allProjects: projects, _allSections: sections,
                    _tasksById: new Map(tasks.map((row) => [row.id, row])), _projectsById: new Map(projects.map((row) => [row.id, row])),
                    _sectionsById: new Map(sections.map((row) => [row.id, row])), settings: durable.settings };
            }
            const current = state._projectsById.get(input.request.projectId);
            if (!current || current.deletedAt || current.purgedAt) return memory;
            const { tasks, sections } = projectLifecycleScopeRows(state, current.id);
            const planned = projectLifecycleEffect(input.scope, input.request.action,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return memory;
            const sourceStatusMatches = input.request.action !== 'reactivate'
                ? current.status !== 'archived' : current.status === 'archived';
            if (!sourceStatusMatches || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)
                || !sameOwnedRows(tasks, input.scope.tasks, sameTaskSqliteRow)
                || !sameOwnedRows(sections, input.scope.sections, sameSectionSqliteRow)) return memory;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const nextTasks = replaceEntitiesInArray(state._allTasks, planned.tasks.map((row) => row.after));
            const nextSections = replaceEntitiesInArray(state._allSections, planned.sections.map((row) => row.after));
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            clearDerivedCache();
            if (raw && durable) {
                const tasks = replaceEntitiesInArray(durable.tasks, planned.tasks.map((row) => row.after));
                const projects = replaceEntitiesInArray(durable.projects, [planned.project.after]);
                const sections = replaceEntitiesInArray(durable.sections ?? [], planned.sections.map((row) => row.after));
                const freshTasks = tasks.map((row) => normalizeTaskForLoad(row));
                const freshProjects = projects.map(normalizeProjectLifecycleFields);
                persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks, _allProjects: durable.projects,
                    _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings },
                    { ...durable, tasks, projects, sections, settings });
                const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
                raw.authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                    generation: getSaveGeneration(), failure: memory.persistenceFailure };
                result = { success: true, id: current.id, outcome: 'applied' };
                return { _allTasks: freshTasks, _allProjects: freshProjects, _allSections: sections,
                    _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings, lastDataChangeAt };
            }
            persist(set, debouncedSave, state, { projects, tasks: nextTasks, sections: nextSections,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, _allTasks: nextTasks, _allSections: nextSections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    updateProject: async (id: string, updates: Partial<Project>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingProject = false;
        let selectedAreaMetadataChanged = false;
        if (
            Object.prototype.hasOwnProperty.call(updates, 'cancelledAt')
            && updates.cancelledAt != null
            && normalizeCancellationTimestamp(updates.cancelledAt) === undefined
        ) {
            const message = 'Cancellation timestamp must be an ISO datetime with timezone';
            set({ error: message });
            return actionFail(message);
        }
        set((state) => {
            const allProjects = state._allProjects;
            const oldProject = allProjects.find(p => p.id === id);
            if (!oldProject) {
                missingProject = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);

            const lifecycle = applyProjectLifecycleTransition(
                oldProject,
                updates,
                state._allTasks,
                state._allSections,
                now,
                deviceState.deviceId,
            );
            const newAllTasks = lifecycle.tasks;
            const newAllSections = lifecycle.sections;
            const incomingStatus = lifecycle.projectUpdates.status ?? oldProject.status;
            const statusChanged = incomingStatus !== oldProject.status;

            let adjustedOrder = updates.order;
            // The picker supplies an own areaId key even for No Area (undefined).
            // Omission is an unrelated Project edit and must preserve area metadata.
            const area = projectAreaSelection(oldProject, updates, allProjects, state._allAreas);
            selectedAreaMetadataChanged = area.metadataChanged;
            if (Number.isFinite(area.order)) adjustedOrder = area.order;

            const finalProjectUpdates: Partial<Project> = {
                ...lifecycle.projectUpdates,
                ...area.fields,
                ...(Number.isFinite(adjustedOrder) ? { order: adjustedOrder } : {}),
                ...(statusChanged && incomingStatus !== 'active'
                    ? { isFocused: false }
                    : {}),
            };

            const newAllProjects = allProjects.map(project =>
                project.id === id
                    ? {
                        ...normalizeProjectLifecycleFields({
                            ...project,
                            ...finalProjectUpdates,
                            updatedAt: now,
                            rev: nextRevision(project.rev),
                            revBy: deviceState.deviceId,
                        }),
                    }
                    : project
            );

            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allTasks: newAllTasks,
                _allSections: newAllSections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (missingProject) {
            const message = 'Project not found';
            logWarn('updateProject skipped: project not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        if (selectedAreaMetadataChanged) {
            logInfo('Project Area selection synchronized metadata', {
                scope: 'store', category: 'storage',
                context: { releaseCheck: 'v1.3.3/rn-project-area-selection-metadata' },
            });
        }

        return actionOk();
    },

    deleteProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingProject = false;
        set((state) => {
            const target = state._allProjects.find((project) => project.id === id && !project.deletedAt);
            if (!target) {
                missingProject = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const sections = state._allSections.filter((section) => section.projectId === id);
            const sectionIdsForProject = new Set(sections.map((section) => section.id));
            const scope = { project: target, sections,
                tasks: state._allTasks.filter((task) => task.projectId === id
                    || (task.sectionId !== undefined && sectionIdsForProject.has(task.sectionId))) };
            const effect = projectDeleteEffect(scope, deviceState.deviceId, now);
            const newAllProjects = replaceEntitiesInArray(state._allProjects, [effect.project.after]);
            const newAllSections = replaceEntitiesInArray(state._allSections, effect.sections.map((row) => row.after));
            const newAllTasks = replaceEntitiesInArray(state._allTasks, effect.tasks.map((row) => row.after));
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allTasks: newAllTasks,
                _allSections: newAllSections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingProject) {
            const message = 'Project not found';
            logWarn('deleteProject skipped: project not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        return actionOk();
    },

    commitPreparedProjectDelete: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Delete conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            if (!current || current.purgedAt) return state;
            const { tasks, sections } = projectDeleteScopeRows(state, current.id);
            const planned = projectDeleteEffect(input.scope,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return state;
            const expectedTasks = afterRows(input.scope.tasks, planned.tasks);
            const expectedSections = afterRows(input.scope.sections, planned.sections);
            const relevantAfterSections = new Set(expectedSections.map((row) => row.id));
            const relevantAfterTasks = expectedTasks.filter((row) => row.projectId === current.id
                || (row.sectionId !== undefined && relevantAfterSections.has(row.sectionId)));
            if (input.request.source !== 'archive' && sameProjectSqliteRow(current, planned.project.after)
                && (state.settings.deviceId ?? null) === (input.deviceIdToInitialize ?? input.deviceIdBefore)
                && sameOwnedRows(sections, expectedSections, sameSectionSqliteRow)
                && expectedTasks.every((row) => {
                    const saved = state._tasksById.get(row.id);
                    return saved && sameTaskSqliteRow(saved, row);
                }) && sameOwnedRows(tasks, relevantAfterTasks, sameTaskSqliteRow)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (current.deletedAt || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)
                || !sameOwnedRows(tasks, input.scope.tasks, sameTaskSqliteRow)
                || !sameOwnedRows(sections, input.scope.sections, sameSectionSqliteRow)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const nextTasks = replaceEntitiesInArray(state._allTasks, planned.tasks.map((row) => row.after));
            const nextSections = replaceEntitiesInArray(state._allSections, planned.sections.map((row) => row.after));
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            clearDerivedCache();
            persist(set, debouncedSave, state, { projects, tasks: nextTasks, sections: nextSections,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, _allTasks: nextTasks, _allSections: nextSections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectDeleteUndo: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Delete Undo conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.delete.request.projectId);
            if (!current || current.purgedAt) return state;
            const links = input.delete.prepared.effect.tasks.map((pair) => ({ id: pair.before.id,
                ...(pair.before.sectionId ? { sectionId: pair.before.sectionId } : {}) }));
            const { tasks, sections } = projectDeleteScopeRows(state, current.id);
            const area = state._allAreas.find((row) => row.id === input.scope.project.areaId) ?? null;
            const planned = projectDeleteUndoEffect(input.scope, links,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return state;
            const expectedTasks = afterRows(input.scope.tasks, planned.tasks);
            for (const row of planned.tasks) {
                if (!expectedTasks.some((entry) => entry.id === row.after.id)) expectedTasks.push(row.after);
            }
            const expectedSections = afterRows(input.scope.sections, planned.sections);
            const expectedSectionIds = new Set(expectedSections.map((row) => row.id));
            const expectedRelevantTasks = expectedTasks.filter((row) => row.projectId === current.id
                || (row.sectionId !== undefined && expectedSectionIds.has(row.sectionId)));
            const untouchedLinked = input.scope.linkedTasks.filter(({ id }) =>
                !planned.tasks.some((pair) => pair.before.id === id));
            if (sameProjectSqliteRow(current, planned.project.after)
                && (state.settings.deviceId ?? null) === (input.deviceIdToInitialize ?? input.deviceIdBefore)
                && taskEditValuesEqual(area, input.scope.area)
                && sameOwnedRows(tasks, expectedRelevantTasks, sameTaskSqliteRow)
                && sameOwnedRows(sections, expectedSections, sameSectionSqliteRow)
                && sameLinkedTasks(state, untouchedLinked)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current.deletedAt || !sameProjectSqliteRow(current, input.delete.prepared.effect.project.after)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)
                || !sameOwnedRows(tasks, input.scope.tasks, sameTaskSqliteRow)
                || !sameOwnedRows(sections, input.scope.sections, sameSectionSqliteRow)
                || !taskEditValuesEqual(area, input.scope.area)
                || !sameLinkedTasks(state, input.scope.linkedTasks)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const nextTasks = replaceEntitiesInArray(state._allTasks, planned.tasks.map((row) => row.after));
            const nextSections = replaceEntitiesInArray(state._allSections, planned.sections.map((row) => row.after));
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            clearDerivedCache();
            persist(set, debouncedSave, state, { projects, tasks: nextTasks, sections: nextSections,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, _allTasks: nextTasks, _allSections: nextSections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    restoreProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingProject = false;
        set((state) => {
            const target = state._allProjects.find((project) => project.id === id);
            // A purged project is the compacted tombstone of a permanent
            // delete, so it counts as missing: reviving it would turn the
            // emptied shell into a live project titled "(deleted)" and sync it
            // to every device.
            if (!target || target.purgedAt) {
                missingProject = true;
                return state;
            }
            if (!target.deletedAt) {
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const scope = { project: target,
                tasks: state._allTasks.filter((task) => task.projectId === id),
                sections: state._allSections.filter((section) => section.projectId === id),
                area: state._allAreas.find((area) => area.id === target.areaId) ?? null };
            const effect = projectRestoreEffect(scope, deviceState.deviceId, now);
            const newAllProjects = replaceEntitiesInArray(state._allProjects, [effect.project.after]);
            const newAllSections = replaceEntitiesInArray(state._allSections, effect.sections.map((row) => row.after));
            const newAllTasks = replaceEntitiesInArray(state._allTasks, effect.tasks.map((row) => row.after));
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        return missingProject ? actionFail('Project not found') : actionOk();
    },

    commitPreparedTrashProjectRestore: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Restore conflicts with current data' };
        set((state) => {
            const current = state._projectsById.get(input.request.projectId);
            if (!current || current.purgedAt) return state;
            const tasks = state._allTasks.filter((row) => row.projectId === current.id);
            const sections = state._allSections.filter((row) => row.projectId === current.id);
            const area = state._allAreas.find((row) => row.id === input.scope.project.areaId) ?? null;
            const planned = projectRestoreEffect(input.scope,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, input.effect)) return state;
            const expectedAfterTasks = input.scope.tasks.map((row) =>
                planned.tasks.find((pair) => pair.before.id === row.id)?.after ?? row);
            const expectedAfterSections = input.scope.sections.map((row) =>
                planned.sections.find((pair) => pair.before.id === row.id)?.after ?? row);
            // A COMMIT may have landed before Swift could persist its terminal ACK.
            // Recognize only the entire exact saved effect; any later child edit or
            // new Project-owned row makes this cold retry stale.
            if (sameProjectSqliteRow(current, planned.project.after)
                && (state.settings.deviceId ?? null) === (input.deviceIdToInitialize ?? input.deviceIdBefore)
                && taskEditValuesEqual(area, input.scope.area)
                && sameOwnedRows(tasks, expectedAfterTasks, sameTaskSqliteRow)
                && sameOwnedRows(sections, expectedAfterSections, sameSectionSqliteRow)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current.deletedAt
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameProjectSqliteRow(current, input.scope.project)
                || !sameOwnedRows(tasks, input.scope.tasks, sameTaskSqliteRow)
                || !sameOwnedRows(sections, input.scope.sections, sameSectionSqliteRow)
                || !taskEditValuesEqual(area, input.scope.area)) return state;
            const projects = replaceEntitiesInArray(state._allProjects, [planned.project.after]);
            const nextSections = replaceEntitiesInArray(state._allSections, planned.sections.map((row) => row.after));
            const nextTasks = replaceEntitiesInArray(state._allTasks, planned.tasks.map((row) => row.after));
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            clearDerivedCache();
            persist(set, debouncedSave, state, { projects, sections: nextSections, tasks: nextTasks,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allProjects: projects, _allSections: nextSections, _allTasks: nextTasks, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    purgeProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingProject = false;
        set((state) => {
            // Only a trashed project can be purged, the same rule purgeTasks uses.
            // Callers take their ids when a confirm dialog opens, so a sync merge can
            // restore the project before the user confirms; purging it then would
            // trash a live project and strip its live tasks in one step.
            const target = state._allProjects.find((project) => (
                project.id === id && project.deletedAt && !project.purgedAt
            ));
            if (!target) {
                missingProject = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const sectionIdsForProject = new Set(
                state._allSections
                    .filter((section) => section.projectId === id)
                    .map((section) => section.id)
            );
            const nextSettings = settingsWithPurgedParentAttachmentDeletes(deviceState.settings,
                state._allTasks, state._allProjects, new Set(), new Set([id]));
            const settingsChanged = deviceState.updated || nextSettings !== deviceState.settings;

            const newAllProjects = state._allProjects.map((project) =>
                project.id === id
                    ? compactPurgedProjectForLocalStorage({
                        ...project,
                        deletedAt: project.deletedAt ?? now,
                        purgedAt: now,
                        updatedAt: now,
                        rev: nextRevision(project.rev),
                        revBy: deviceState.deviceId,
                    })
                    : project
            );
            const newAllSections = state._allSections.map((section) =>
                sectionIdsForProject.has(section.id)
                    ? compactPurgedProjectSectionTombstone({
                        ...section,
                        deletedAt: now,
                        updatedAt: now,
                        rev: nextRevision(section.rev),
                        revBy: deviceState.deviceId,
                    }, now)
                    : section
            );
            const newAllTasks = state._allTasks.map(task =>
                !task.deletedAt && (task.projectId === id || (task.sectionId && sectionIdsForProject.has(task.sectionId)))
                    ? {
                        ...task,
                        projectId: undefined,
                        sectionId: undefined,
                        updatedAt: now,
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    }
                    : task
            );
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(settingsChanged ? { settings: nextSettings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(settingsChanged ? { settings: nextSettings } : {}),
            };
        });
        if (missingProject) {
            const message = 'Project not found';
            logWarn('purgeProject skipped: project not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        return actionOk();
    },

    purgeDeletedProjects: async () => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        set((state) => {
            const selectedProjects = state._allProjects.filter((project) => project.deletedAt && !project.purgedAt);
            if (selectedProjects.length === 0) return state;
            const selectedIds = new Set(selectedProjects.map((project) => project.id));
            const deviceState = ensureDeviceId(state.settings);
            const sectionIdsForProjects = new Set(
                state._allSections
                    .filter((section) => selectedIds.has(section.projectId))
                    .map((section) => section.id)
            );
            const nextSettings = settingsWithPurgedParentAttachmentDeletes(deviceState.settings,
                state._allTasks, state._allProjects, new Set(), selectedIds);
            const settingsChanged = deviceState.updated || nextSettings !== deviceState.settings;

            const newAllProjects = state._allProjects.map((project) =>
                selectedIds.has(project.id)
                    ? compactPurgedProjectForLocalStorage({
                        ...project,
                        deletedAt: project.deletedAt ?? now,
                        purgedAt: now,
                        updatedAt: now,
                        rev: nextRevision(project.rev),
                        revBy: deviceState.deviceId,
                    })
                    : project
            );
            const newAllSections = state._allSections.map((section) =>
                sectionIdsForProjects.has(section.id)
                    ? compactPurgedProjectSectionTombstone({
                        ...section,
                        deletedAt: now,
                        updatedAt: now,
                        rev: nextRevision(section.rev),
                        revBy: deviceState.deviceId,
                    }, now)
                    : section
            );
            const newAllTasks = state._allTasks.map(task =>
                !task.deletedAt && (task.projectId && selectedIds.has(task.projectId)
                    || task.sectionId && sectionIdsForProjects.has(task.sectionId))
                    ? {
                        ...task,
                        projectId: undefined,
                        sectionId: undefined,
                        updatedAt: now,
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    }
                    : task
            );
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(settingsChanged ? { settings: nextSettings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(settingsChanged ? { settings: nextSettings } : {}),
            };
        });
        return actionOk();
    },

    commitPreparedProjectDuplicate: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Duplicate conflicts with current data' };
        set((state) => {
            const source = state._projectsById.get(input.request.projectId);
            if (!source || source.deletedAt || source.purgedAt) return state;
            const areaId = input.scope.project.areaId;
            const area = state._allAreas.find((row) => row.id === areaId) ?? null;
            const sections = state._allSections.filter((row) => row.projectId === source.id);
            const tasks = state._allTasks.filter((row) => row.projectId === source.id);
            const sameAreaProjects = state._allProjects.filter((row) => !row.deletedAt
                && (row.areaId ?? undefined) === (areaId ?? undefined));
            const created = input.effect;
            const copy = state._projectsById.get(created.project.id);
            const copySections = state._allSections.filter((row) => row.projectId === created.project.id);
            const copyTasks = state._allTasks.filter((row) => row.projectId === created.project.id);
            const sameSource = sameProjectSqliteRow(source, input.scope.project)
                && sameOwnedRows(sections, input.scope.sections, sameSectionSqliteRow)
                && sameOwnedRows(tasks, input.scope.tasks, sameTaskSqliteRow)
                && taskEditValuesEqual(area, input.scope.area);
            if (copy && sameSource
                && (state.settings.deviceId ?? null) === (input.deviceIdToInitialize ?? input.deviceIdBefore)
                && sameProjectSqliteRow(copy, created.project)
                && sameOwnedRows(copySections, created.sections, sameSectionSqliteRow)
                && sameOwnedRows(copyTasks, created.tasks, sameTaskSqliteRow)
                && sameOwnedRows(sameAreaProjects, [...input.scope.sameAreaProjects, created.project], sameProjectSqliteRow)) {
                result = { success: true, id: created.project.id, outcome: 'replayed' };
                return state;
            }
            if (copy || copySections.length || copyTasks.length || !sameSource
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameOwnedRows(sameAreaProjects, input.scope.sameAreaProjects, sameProjectSqliteRow)) return state;
            const allIds = new Set<string>();
            for (const row of state._allProjects) {
                allIds.add(row.id);
                for (const attachment of row.attachments ?? []) allIds.add(attachment.id);
            }
            for (const row of state._allSections) allIds.add(row.id);
            for (const row of state._allTasks) {
                allIds.add(row.id);
                for (const item of row.checklist ?? []) allIds.add(item.id);
                for (const attachment of row.attachments ?? []) allIds.add(attachment.id);
            }
            if (input.ids.some((id) => allIds.has(id))) return state;
            const projects = [...state._allProjects, created.project];
            const nextSections = [...state._allSections, ...created.sections];
            const nextTasks = [...state._allTasks, ...created.tasks];
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            clearDerivedCache();
            persist(set, debouncedSave, state, { projects, sections: nextSections, tasks: nextTasks,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: created.project.id, outcome: 'applied' };
            return { _allProjects: projects, _allSections: nextSections, _allTasks: nextTasks, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    duplicateProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let createdProject: Project | null = null;
        set((state) => {
            const sourceProject = state._allProjects.find((project) => project.id === id && !project.deletedAt);
            if (!sourceProject) return state;
            const deviceState = ensureDeviceId(state.settings);
            const effect = projectDuplicateEffect({ project: sourceProject,
                sections: state._allSections.filter((section) => section.projectId === id),
                tasks: state._allTasks.filter((task) => task.projectId === id),
                sameAreaProjects: state._allProjects.filter((project) => !project.deletedAt
                    && (project.areaId ?? undefined) === (sourceProject.areaId ?? undefined)),
                area: state._allAreas.find((area) => area.id === sourceProject.areaId) ?? null,
            }, deviceState.deviceId, now, uuidv4);
            createdProject = effect.project;

            const newAllProjects = [...state._allProjects, effect.project];
            const newAllSections = [...state._allSections, ...effect.sections];
            const newAllTasks = [...state._allTasks, ...effect.tasks];
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        return createdProject;
    },

    toggleProjectFocus: async (id: string) => {
        await mutateEntities({ set, debouncedSave }, {
            collection: 'projects',
            select: (state) => state._allProjects.filter((project) => project.id === id),
            buildUpdates: (project) => projectFocusToggleUpdate(project,
                get().getDerivedState().focusedProjectCount),
        });
    },
});
