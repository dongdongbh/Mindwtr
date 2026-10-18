/**
 * Settings › Data's preview and result texts, the one home for both apps: React Native's backup actions hook
 * (use-sync-settings-backup-actions.ts) and the native apps' backup document (native-backup-document.ts) both build them here.
 * Each builder takes the caller's translator (RN's `tr`, the native host's template translator). Moved from the RN hook
 * byte-identical (its parity fixture: use-sync-settings-backup-actions.parity.fixtures.json).
 */
import { createImportDiagnostics, formatImportDiagnostic, type ImportDiagnostic, type ImportDiagnosticTranslator } from './import-diagnostics';

type Translate = ImportDiagnosticTranslator;
type ProjectLine = { name: string; taskCount: number; areaName?: string };

// A warning is RN's sentence, or a diagnostic the native backup document already built from its stored code and count.
type Warning = string | ImportDiagnostic;
const warningLines = (warnings: readonly Warning[], t: Translate): string[] => warnings
    .map((warning) => typeof warning === 'string' ? createImportDiagnostics([warning], 'warning')[0] : warning)
    .map((diagnostic) => formatImportDiagnostic(diagnostic, t));

/** The first four projects (`• [area / ]name: count`), then how many more. */
const projectLines = (projects: readonly ProjectLine[], t: Translate, withArea: boolean): string[] => {
    const lines = projects
        .slice(0, 4)
        .map((project) => `• ${withArea && project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
    if (projects.length > 4) {
        lines.push(t('settings.backupMobile.moreProjects', { projectCount: projects.length - 4 }));
    }
    return lines;
};

// Drops the absent lines only: an '' is the blank line before a project list or the warnings (RN dropped it with filter(Boolean)).
const join = (details: (string | null)[]): string => details.filter((line) => line !== null).join('\n');

/**
 * Restore and merge preview the same file identically; only the sentence about what the action does to local data differs
 * ([effect]).
 */
export function buildBackupPreviewSummary(validation: {
    metadata?: { backupAt?: string | null; fileName?: string | null; taskCount?: number; projectCount?: number } | null;
    diagnostics?: readonly ImportDiagnostic[];
    warnings?: readonly string[];
}, effect: string, t: Translate): string {
    const warningDiagnostics = validation.diagnostics ?? createImportDiagnostics(validation.warnings ?? [], 'warning');
    const warnings = warningDiagnostics
        .filter((diagnostic) => diagnostic.severity === 'warning')
        .map((diagnostic) => formatImportDiagnostic(diagnostic, t));
    return join([
        validation.metadata?.backupAt
            ? t('settings.backupMobile.backupDateLabel', { backupDate: new Date(validation.metadata.backupAt).toLocaleString() })
            : validation.metadata?.fileName
                ? t('settings.backupMobile.fileLabel', { fileName: validation.metadata.fileName })
                : null,
        t('settings.backupMobile.backupPreviewCounts', { taskCount: validation.metadata?.taskCount ?? 0, projectCount: validation.metadata?.projectCount ?? 0 }),
        effect,
        ...(warnings.length > 0 ? ['', ...warnings] : []),
    ]);
}

export function buildTodoistPreviewSummary(preview: {
    taskCount: number; projectCount: number; sectionCount: number; checklistItemCount: number; projects: readonly ProjectLine[]; warnings: readonly string[];
}, t: Translate): string {
    const projects = projectLines(preview.projects, t, false);
    return join([
        t('settings.backupMobile.importTodoistTasksFromProjects', { taskCount: preview.taskCount, projectCount: preview.projectCount }),
        preview.sectionCount > 0 ? t('settings.backupMobile.sectionsWillBePreserved', { sectionCount: preview.sectionCount }) : null,
        preview.checklistItemCount > 0 ? t('settings.backupMobile.subtasksWillBecomeChecklistItems', { subtaskCount: preview.checklistItemCount }) : null,
        ...(projects.length > 0 ? ['', ...projects] : []),
        ...(preview.warnings.length > 0 ? ['', ...warningLines(preview.warnings, t)] : []),
    ]);
}

export function buildTickTickPreviewSummary(preview: {
    taskCount: number; fileName: string; areaCount: number; projectCount: number; checklistItemCount: number; recurringCount: number;
    projects: readonly ProjectLine[]; warnings: readonly string[];
}, t: Translate): string {
    const projects = projectLines(preview.projects, t, true);
    return join([
        t('settings.backupMobile.importTasksFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
        preview.areaCount > 0 ? t('settings.backupMobile.ticktickAreasWillBeCreated', { areaCount: preview.areaCount }) : null,
        preview.projectCount > 0 ? t('settings.backupMobile.ticktickProjectsWillBeCreated', { projectCount: preview.projectCount }) : null,
        preview.checklistItemCount > 0 ? t('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: preview.checklistItemCount }) : null,
        preview.recurringCount > 0 ? t('settings.backupMobile.recurringTasksWillKeepSupportedRepeatRules', { taskCount: preview.recurringCount }) : null,
        ...(projects.length > 0 ? ['', ...projects] : []),
        ...(preview.warnings.length > 0 ? ['', ...warningLines(preview.warnings, t)] : []),
    ]);
}

export function buildDgtPreviewSummary(preview: {
    taskCount: number; fileName: string; areaCount: number; projectCount: number; checklistItemCount: number; standaloneTaskCount: number;
    projects: readonly ProjectLine[]; warnings: readonly string[];
}, t: Translate): string {
    const projects = projectLines(preview.projects, t, true);
    return join([
        t('settings.backupMobile.importTasksFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
        preview.areaCount > 0 ? t('settings.backupMobile.dgtAreasWillBeCreated', { areaCount: preview.areaCount }) : null,
        preview.projectCount > 0 ? t('settings.backupMobile.projectsWillBeCreated', { projectCount: preview.projectCount }) : null,
        preview.checklistItemCount > 0 ? t('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: preview.checklistItemCount }) : null,
        preview.standaloneTaskCount > 0 ? t('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: preview.standaloneTaskCount }) : null,
        ...(projects.length > 0 ? ['', ...projects] : []),
        ...(preview.warnings.length > 0 ? ['', ...warningLines(preview.warnings, t)] : []),
    ]);
}

export function buildOmniFocusPreviewSummary(preview: {
    taskCount: number; fileName: string; projectCount: number; areaCount: number; checklistItemCount: number; standaloneTaskCount: number;
    projects: readonly ProjectLine[]; warnings: readonly string[];
}, t: Translate): string {
    const projects = projectLines(preview.projects, t, false);
    return join([
        t('settings.backupMobile.importTaskCountFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
        preview.projectCount > 0 ? t('settings.backupMobile.projectsWillBeCreatedWhenNeeded', { projectCount: preview.projectCount }) : null,
        preview.areaCount > 0 ? t('settings.backupMobile.omnifocusAreasWillBeCreated', { areaCount: preview.areaCount }) : null,
        preview.checklistItemCount > 0 ? t('settings.backupMobile.nestedTasksWillBecomeChecklistItems', { taskCount: preview.checklistItemCount }) : null,
        preview.standaloneTaskCount > 0 ? t('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: preview.standaloneTaskCount }) : null,
        t('settings.backupMobile.importedTasksKeepOmnifocusNotesDatesTagsRecurrenceAndChecklist'),
        ...(projects.length > 0 ? ['', ...projects] : []),
        ...(preview.warnings.length > 0 ? ['', ...warningLines(preview.warnings, t)] : []),
    ]);
}

export function buildMindwtrCsvPreviewSummary(preview: {
    taskCount: number; fileName: string; areaCount: number; projectCount: number; sectionCount: number; checklistItemCount: number;
    standaloneTaskCount: number; projects: readonly ProjectLine[]; warnings: readonly string[];
}, t: Translate): string {
    const projects = projectLines(preview.projects, t, true);
    return join([
        t('settings.backupMobile.importTasksFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
        preview.areaCount > 0 ? t('settings.backupMobile.mindwtrCsvAreasWillBeCreated', { areaCount: preview.areaCount }) : null,
        preview.projectCount > 0 ? t('settings.backupMobile.projectsWillBeCreatedWhenNeeded', { projectCount: preview.projectCount }) : null,
        preview.sectionCount > 0 ? t('settings.backupMobile.mindwtrCsvSectionsWillBeCreated', { sectionCount: preview.sectionCount }) : null,
        preview.checklistItemCount > 0 ? t('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: preview.checklistItemCount }) : null,
        preview.standaloneTaskCount > 0 ? t('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: preview.standaloneTaskCount }) : null,
        ...(projects.length > 0 ? ['', ...projects] : []),
        ...(preview.warnings.length > 0 ? ['', ...warningLines(preview.warnings, t)] : []),
    ]);
}

/** Merge backup's result: what changed, then the snapshot its Undo restores. */
export const buildMergeResultMessage = (merged: { added: number; updated: number }, snapshotName: string, t: Translate): string => [
    t('settings.mergeBackupSummary', { addedCount: merged.added, updatedCount: merged.updated }),
    t('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
].join('\n');

export const buildTodoistResultMessage = (result: { importedTaskCount: number; importedProjectCount: number; importedChecklistItemCount: number; warnings: readonly Warning[] },
    snapshotName: string, t: Translate): string => join([
    t('settings.backupMobile.importedTodoistTasksIntoProjects', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount }),
    result.importedChecklistItemCount > 0 ? t('settings.backupMobile.subtasksBecameChecklistItems', { subtaskCount: result.importedChecklistItemCount }) : null,
    t('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
    ...(result.warnings.length > 0 ? ['', ...warningLines(result.warnings, t)] : []),
]);

/** TickTick's and DGT GTD's result (the same lines). */
export const buildAreaImportResultMessage = (result: {
    importedTaskCount: number; importedProjectCount: number; importedAreaCount: number; importedChecklistItemCount: number; warnings: readonly Warning[];
}, snapshotName: string, t: Translate): string => join([
    t('settings.backupMobile.importedTaskProjectAreaCounts', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount, areaCount: result.importedAreaCount }),
    result.importedChecklistItemCount > 0 ? t('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: result.importedChecklistItemCount }) : null,
    t('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
    ...(result.warnings.length > 0 ? ['', ...warningLines(result.warnings, t)] : []),
]);

export const buildOmniFocusResultMessage = (result: {
    importedTaskCount: number; importedProjectCount: number; importedAreaCount: number; importedChecklistItemCount: number;
    importedStandaloneTaskCount: number; warnings: readonly Warning[];
}, snapshotName: string, t: Translate): string => join([
    t('settings.backupMobile.importedTaskProjectCounts', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount }),
    result.importedAreaCount > 0 ? t('settings.backupMobile.omnifocusAreasCreated', { areaCount: result.importedAreaCount }) : null,
    result.importedChecklistItemCount > 0 ? t('settings.backupMobile.nestedTasksBecameChecklistItems', { taskCount: result.importedChecklistItemCount }) : null,
    result.importedStandaloneTaskCount > 0 ? t('settings.backupMobile.tasksStayedOutsideProjects', { taskCount: result.importedStandaloneTaskCount }) : null,
    t('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
    ...(result.warnings.length > 0 ? ['', ...warningLines(result.warnings, t)] : []),
]);

export const buildMindwtrCsvResultMessage = (result: {
    importedTaskCount: number; importedProjectCount: number; importedSectionCount: number; importedAreaCount: number;
    importedChecklistItemCount: number; warnings: readonly Warning[];
}, snapshotName: string, t: Translate): string => join([
    t('settings.backupMobile.importedTaskProjectSectionAreaCounts', {
        taskCount: result.importedTaskCount,
        projectCount: result.importedProjectCount,
        sectionCount: result.importedSectionCount,
        areaCount: result.importedAreaCount,
    }),
    result.importedChecklistItemCount > 0 ? t('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: result.importedChecklistItemCount }) : null,
    t('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
    ...(result.warnings.length > 0 ? ['', ...warningLines(result.warnings, t)] : []),
]);
