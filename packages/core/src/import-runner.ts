// Shell-side seam: the desktop and mobile data-transfer modules each repeated the same
// addBreadcrumb -> logInfo(start) -> transaction -> logInfo(complete)/logError boilerplate once
// per import source. This module owns that boilerplate once; each shell keeps only its own
// boundaries object (storage/refresh/snapshot plumbing) and its own logInfo/logError module.
import { prepareRestoredBackupDataForSync, validateBackupJson, type BackupValidation } from './backup-transfer';
import {
    runDataTransferTransaction,
    type DataTransferStaleDetails,
    type DataTransferApplication,
} from './data-transfer-transaction';
import {
    applyDgtImport,
    parseDgtImportSource,
    type DgtImportParseResult,
    type ParsedDgtImportData,
} from './dgt-import';
import { addBreadcrumb } from './log-breadcrumbs';
import { createImportDiagnostics, type ImportDiagnostic } from './import-diagnostics';
import type { ImportSourceInput } from './import-source-reader';
import {
    applyMindwtrCsvImport,
    parseMindwtrCsvImportSource,
    type MindwtrCsvImportParseResult,
    type ParsedMindwtrCsvImportData,
} from './mindwtr-csv-import';
import {
    applyOmniFocusImport,
    parseOmniFocusImportSource,
    type OmniFocusImportParseResult,
    type ParsedOmniFocusImportData,
} from './omnifocus-import';
import { mergeAppDataWithStats } from './sync';
import { normalizeAttachmentsForSyncMerge } from './sync-normalization';
import type { EntityMergeStats, MergeResult } from './sync-types';
import {
    applyTickTickImport,
    parseTickTickImportSource,
    type ParsedTickTickImportData,
    type TickTickImportParseResult,
} from './ticktick-import';
import {
    applyTodoistImport,
    parseTodoistImportSource,
    type ParsedTodoistProject,
    type TodoistImportParseResult,
} from './todoist-import';
import type { AppData, Attachment } from './types';

export type ImportSourceId = 'backup' | 'backup-merge' | 'dgt' | 'mindwtr-csv' | 'omnifocus' | 'ticktick' | 'todoist';
export type ImportPickerSourceId = Exclude<ImportSourceId, 'backup' | 'backup-merge'>;

export type ImportDescriptorInput = ImportSourceInput & {
    appVersion?: string | null;
    lastModified?: number | null;
};

type RawImportSourceParseResultMap = {
    backup: BackupValidation;
    'backup-merge': BackupValidation;
    dgt: DgtImportParseResult;
    'mindwtr-csv': MindwtrCsvImportParseResult;
    omnifocus: OmniFocusImportParseResult;
    ticktick: TickTickImportParseResult;
    todoist: TodoistImportParseResult;
};

export type ImportSourceParseResultMap = {
    [S in keyof RawImportSourceParseResultMap]: RawImportSourceParseResultMap[S] & {
        diagnostics: ImportDiagnostic[];
    };
};

export type DataTransferBoundaries = {
    createRecoverySnapshot: (currentData: AppData) => Promise<string | null>;
    flushPendingSave: () => Promise<void>;
    getCurrentChangeAt: () => number;
    onStale?: (details: DataTransferStaleDetails) => void;
    persistData: (data: AppData) => Promise<void>;
    readCurrentData: () => Promise<AppData>;
    refreshData: () => Promise<void>;
};

export type TransferLogInfo = (
    message: string,
    context?: { extra?: Record<string, unknown>; scope?: string }
) => unknown;
export type TransferLogError = (
    error: unknown,
    context: { extra?: Record<string, unknown>; scope: string }
) => unknown;

export type ImportRunnerLog = {
    logError: TransferLogError;
    logInfo: TransferLogInfo;
};

// Maps each import source to its real parsed-input and applied-result types. The descriptor
// table below is keyed off this so each entry's `apply`/`countExtra` is checked against the
// actual importer signature instead of erasing to `unknown` and casting back per source.
type ImportTypeMap = {
    backup: { parsed: AppData; result: AppData };
    'backup-merge': { parsed: AppData; result: MergeResult };
    todoist: { parsed: ParsedTodoistProject[]; result: ReturnType<typeof applyTodoistImport> };
    ticktick: { parsed: ParsedTickTickImportData; result: ReturnType<typeof applyTickTickImport> };
    dgt: { parsed: ParsedDgtImportData; result: ReturnType<typeof applyDgtImport> };
    'mindwtr-csv': { parsed: ParsedMindwtrCsvImportData; result: ReturnType<typeof applyMindwtrCsvImport> };
    omnifocus: { parsed: ParsedOmniFocusImportData; result: ReturnType<typeof applyOmniFocusImport> };
};

type ImportDescriptor<S extends ImportSourceId> = {
    apply: (data: AppData, parsed: ImportTypeMap[S]['parsed']) => { data: AppData; result: ImportTypeMap[S]['result'] };
    completeLabel: string;
    countExtra: (result: ImportTypeMap[S]['result']) => Record<string, string>;
    operation: string;
    parse: (input: ImportDescriptorInput) => RawImportSourceParseResultMap[S];
    source: S;
    startLabel: string;
};

const toBackupCountExtra = (data: AppData): Record<string, string> => ({
    tasks: String(data.tasks.filter((task) => !task.deletedAt).length),
    projects: String(data.projects.filter((project) => !project.deletedAt).length),
    sections: String(data.sections.filter((section) => !section.deletedAt).length),
    areas: String(data.areas.filter((area) => !area.deletedAt).length),
});

// The backup is user-supplied bytes, so its attachment paths get the same sanitizing the sync
// merge applies (bad uri -> '', bad cloudKey/fileHash -> undefined; the record itself survives).
// mergeAppDataWithStats normalizes incoming entities again downstream — this pins the shape at
// the entry point so the guarantee does not depend on which importer consumes it.
const filterAdditiveBackupAttachments = (
    incoming: Attachment[] | undefined,
    current: Attachment[] | undefined,
): Attachment[] | undefined => {
    const locallyDeletedIds = new Set(current?.filter((item) => item.deletedAt).map((item) => item.id));
    return normalizeAttachmentsForSyncMerge(
        incoming?.filter((item) => !item.deletedAt && !locallyDeletedIds.has(item.id)),
    );
};

// `resolvedUsingIncoming` counts every record the backup supplied, records this device had
// never seen included, so the records that were genuinely *changed* are what's left once the
// additions come out. Both shells report merge results through this, so the arithmetic can't
// drift between desktop and mobile.
export const summarizeBackupMerge = (result: MergeResult): { added: number; updated: number } => ({
    added: result.stats.tasks.incomingOnly,
    updated: Math.max(0, result.stats.tasks.resolvedUsingIncoming - result.stats.tasks.incomingOnly),
});

const toMergeCountExtra = (entity: string, stats: EntityMergeStats): Record<string, string> => ({
    [`${entity}Added`]: String(stats.incomingOnly),
    [`${entity}Updated`]: String(Math.max(0, stats.resolvedUsingIncoming - stats.incomingOnly)),
});

const parseBackupInput = (input: ImportDescriptorInput): BackupValidation => validateBackupJson(
    input.text ?? new TextDecoder().decode(input.bytes ?? undefined),
    {
        appVersion: input.appVersion,
        fileModifiedAt: input.lastModified,
        fileName: input.fileName,
    },
);

const IMPORT_DESCRIPTORS: { [S in ImportSourceId]: ImportDescriptor<S> } = {
    backup: {
        operation: 'restoreBackup',
        source: 'backup',
        startLabel: 'Backup restore started',
        completeLabel: 'Backup restore complete',
        parse: parseBackupInput,
        apply: (currentData, parsed) => {
            const restored = prepareRestoredBackupDataForSync(parsed, { previousData: currentData });
            return { data: restored, result: restored };
        },
        countExtra: toBackupCountExtra,
    },
    // Same file, opposite intent: restore replaces local data and deliberately outranks local
    // tombstones (prepareRestoredBackupDataForSync stamps fresh revisions), while merge is
    // additive. Incoming entity/attachment tombstones are ignored, local tombstones still
    // participate in the ordinary merge, and live incoming records retain newer-wins semantics.
    'backup-merge': {
        operation: 'mergeBackup',
        source: 'backup-merge',
        startLabel: 'Backup merge started',
        completeLabel: 'Backup merge complete',
        parse: parseBackupInput,
        apply: (currentData, parsed) => {
            const currentTasksById = new Map(currentData.tasks.map((item) => [item.id, item]));
            const currentProjectsById = new Map(currentData.projects.map((item) => [item.id, item]));
            const currentSectionsById = new Map(currentData.sections.map((item) => [item.id, item]));
            const currentAreasById = new Map(currentData.areas.map((item) => [item.id, item]));
            const currentPeopleById = new Map((currentData.people ?? []).map((item) => [item.id, item]));
            const additiveBackup: AppData = {
                ...parsed,
                tasks: parsed.tasks
                    .filter((item) => {
                        const current = currentTasksById.get(item.id);
                        return !item.deletedAt && !item.purgedAt && !current?.deletedAt && !current?.purgedAt;
                    })
                    .map((item) => ({
                        ...item,
                        attachments: filterAdditiveBackupAttachments(
                            item.attachments,
                            currentTasksById.get(item.id)?.attachments,
                        ),
                    })),
                projects: parsed.projects
                    .filter((item) => {
                        const current = currentProjectsById.get(item.id);
                        return !item.deletedAt && !item.purgedAt && !current?.deletedAt && !current?.purgedAt;
                    })
                    .map((item) => ({
                        ...item,
                        attachments: filterAdditiveBackupAttachments(
                            item.attachments,
                            currentProjectsById.get(item.id)?.attachments,
                        ),
                    })),
                sections: parsed.sections.filter((item) => (
                    !item.deletedAt && !currentSectionsById.get(item.id)?.deletedAt
                )),
                areas: parsed.areas.filter((item) => (
                    !item.deletedAt && !currentAreasById.get(item.id)?.deletedAt
                )),
                people: parsed.people?.filter((item) => (
                    !item.deletedAt && !currentPeopleById.get(item.id)?.deletedAt
                )),
            };
            const merge = mergeAppDataWithStats(currentData, additiveBackup);
            return { data: merge.data, result: merge };
        },
        countExtra: (result) => ({
            ...toMergeCountExtra('tasks', result.stats.tasks),
            ...toMergeCountExtra('projects', result.stats.projects),
            ...toMergeCountExtra('sections', result.stats.sections),
            ...toMergeCountExtra('areas', result.stats.areas),
        }),
    },
    todoist: {
        operation: 'importTodoist',
        source: 'todoist',
        startLabel: 'Todoist import started',
        completeLabel: 'Todoist import complete',
        parse: parseTodoistImportSource,
        apply: (data, parsed) => {
            const result = applyTodoistImport(data, parsed);
            return { data: result.data, result };
        },
        countExtra: (result) => ({
            tasks: String(result.importedTaskCount),
            projects: String(result.importedProjectCount),
            sections: String(result.importedSectionCount),
            checklistItems: String(result.importedChecklistItemCount),
        }),
    },
    ticktick: {
        operation: 'importTickTick',
        source: 'ticktick',
        startLabel: 'TickTick import started',
        completeLabel: 'TickTick import complete',
        parse: parseTickTickImportSource,
        apply: (data, parsed) => {
            const result = applyTickTickImport(data, parsed);
            return { data: result.data, result };
        },
        countExtra: (result) => ({
            tasks: String(result.importedTaskCount),
            projects: String(result.importedProjectCount),
            areas: String(result.importedAreaCount),
            checklistItems: String(result.importedChecklistItemCount),
        }),
    },
    dgt: {
        operation: 'importDgt',
        source: 'dgt',
        startLabel: 'DGT import started',
        completeLabel: 'DGT import complete',
        parse: parseDgtImportSource,
        apply: (data, parsed) => {
            const result = applyDgtImport(data, parsed);
            return { data: result.data, result };
        },
        countExtra: (result) => ({
            tasks: String(result.importedTaskCount),
            projects: String(result.importedProjectCount),
            areas: String(result.importedAreaCount),
            checklistItems: String(result.importedChecklistItemCount),
        }),
    },
    omnifocus: {
        operation: 'importOmniFocus',
        source: 'omnifocus',
        startLabel: 'OmniFocus import started',
        completeLabel: 'OmniFocus import complete',
        parse: parseOmniFocusImportSource,
        apply: (data, parsed) => {
            const result = applyOmniFocusImport(data, parsed);
            return { data: result.data, result };
        },
        countExtra: (result) => ({
            areas: String(result.importedAreaCount),
            checklistItems: String(result.importedChecklistItemCount),
            tasks: String(result.importedTaskCount),
            projects: String(result.importedProjectCount),
            standaloneTasks: String(result.importedStandaloneTaskCount),
        }),
    },
    'mindwtr-csv': {
        operation: 'importMindwtrCsv',
        source: 'mindwtr-csv',
        startLabel: 'Mindwtr CSV import started',
        completeLabel: 'Mindwtr CSV import complete',
        parse: parseMindwtrCsvImportSource,
        apply: (data, parsed) => {
            const result = applyMindwtrCsvImport(data, parsed);
            return { data: result.data, result };
        },
        countExtra: (result) => ({
            tasks: String(result.importedTaskCount),
            projects: String(result.importedProjectCount),
            sections: String(result.importedSectionCount),
            areas: String(result.importedAreaCount),
            checklistItems: String(result.importedChecklistItemCount),
            standaloneTasks: String(result.importedStandaloneTaskCount),
        }),
    },
};

export function parseImportSource<S extends ImportSourceId>(
    source: S,
    input: ImportDescriptorInput,
): ImportSourceParseResultMap[S] {
    const result = IMPORT_DESCRIPTORS[source].parse(input);
    const structuredDiagnostics = (result as { diagnostics?: ImportDiagnostic[] }).diagnostics;
    return {
        ...result,
        diagnostics: structuredDiagnostics ?? [
            ...createImportDiagnostics(result.warnings, 'warning'),
            ...createImportDiagnostics(result.errors, 'error'),
        ],
    } as ImportSourceParseResultMap[S];
}

/** Shared import policy for native hosts that persist a prepared document with an
 * atomic request receipt. This only computes the application; callers still own
 * the serialized write barrier, recovery snapshot, persistence and canonical reload.
 */
export function applyImportSource<S extends ImportSourceId>(
    source: S,
    currentData: AppData,
    parsed: ImportTypeMap[S]['parsed'],
): DataTransferApplication<ImportTypeMap[S]['result']> {
    return IMPORT_DESCRIPTORS[source].apply(currentData, parsed);
}

// Closing this on `source` (rather than two free type parameters the caller had to spell out)
// lets `parsed`'s and the return value's types be inferred from the source id literal itself —
// `ImportTypeMap[S]` is exact per source, so every cast this function used to need to bridge
// "the caller's declared TParsed/TResult" against "whatever IMPORT_DESCRIPTORS[source] resolves
// to at runtime" is now just a correct, unconditional type instead of an erasure.
export async function runImport<S extends ImportSourceId>(
    source: S,
    parsed: ImportTypeMap[S]['parsed'],
    boundaries: DataTransferBoundaries,
    log: ImportRunnerLog
): Promise<{ result: ImportTypeMap[S]['result']; snapshotName: string | null }> {
    const descriptor = IMPORT_DESCRIPTORS[source];
    addBreadcrumb('transfer:restore');
    void log.logInfo(descriptor.startLabel, {
        scope: 'transfer',
        extra: { operation: descriptor.operation, source: descriptor.source },
    });
    try {
        const transaction = await runDataTransferTransaction({
            ...boundaries,
            operation: descriptor.operation,
            apply: (currentData: AppData) => applyImportSource(source, currentData, parsed),
        });
        const result = transaction.result;
        void log.logInfo(descriptor.completeLabel, {
            scope: 'transfer',
            extra: {
                operation: descriptor.operation,
                source: descriptor.source,
                ...descriptor.countExtra(result),
            },
        });
        return { snapshotName: transaction.snapshot, result };
    } catch (error) {
        void log.logError(error, { scope: 'transfer', extra: { operation: descriptor.operation } });
        throw error;
    }
}
