import { findLiveAttachmentResourceReferences, holdRestoreUndoAttachments, markMissingLocalAttachmentFiles } from './attachment-cleanup';
import type { LocalAttachmentPresence } from './attachment-transfer';
import { MAX_BACKUP_SOURCE_BYTES, serializeBackupData } from './backup-transfer';
import { base64ToBytes } from './base64-bytes';
import { runSerializedSyncDocumentWriteOperation } from './data-transfer-transaction';
import { createImportDiagnostic, createImportDiagnostics, formatImportDiagnostic, importDiagnosticLocationParams, type ImportDiagnostic, type ImportDiagnosticCode, type ImportDiagnosticTranslator } from './import-diagnostics';
import { DEFAULT_IMPORT_SOURCE_LIMITS } from './import-source-reader';
import { applyImportSource, parseImportSource, summarizeBackupMerge } from './import-runner';
import { taskEditValuesEqual } from './json-value-equality';
import type { MindwtrCsvImportExecutionResult } from './mindwtr-csv-import';
import type { TodoistImportExecutionResult } from './todoist-import';
import type { TickTickImportExecutionResult } from './ticktick-import';
import type { DgtImportExecutionResult } from './dgt-import';
import type { OmniFocusImportExecutionResult } from './omnifocus-import';
import { MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES, UNDO_LIMIT_EXCEEDED, type NativeReceiptSqliteAdapter } from './native-request-receipts';
import { DATA_TRANSFER_TOAST_MS } from './data-settings-model';
import {
    buildAreaImportResultMessage, buildBackupPreviewSummary, buildDgtPreviewSummary, buildMergeResultMessage, buildMindwtrCsvPreviewSummary,
    buildMindwtrCsvResultMessage, buildOmniFocusPreviewSummary, buildOmniFocusResultMessage, buildTickTickPreviewSummary,
    buildTodoistPreviewSummary, buildTodoistResultMessage,
} from './data-transfer-messages';
import { formatRecoverySnapshotLabel } from './recovery-snapshot-names';
import { flushPendingSave, useTaskStore } from './store';
import { markNextLoadAsDocumentReplacement } from './store-settings';
import { stripSensitiveSettings } from './store-helpers';
import { logInfo } from './logger';
import { validateMergedSyncData } from './sync-normalization';
import type { AppData } from './types';

export const MAX_NATIVE_BACKUP_PLAN_BYTES = 512 * 1024 * 1024;
export type NativeBackupDocumentMetadata = { fileName: string; lastModified: number; appVersion: string };
export type NativeBackupOperationReference = { id: string; sha256: string; byteCount: number };
export type NativeBackupJsonDocumentReply = {
    version: 1; operation: 'merge' | 'restore' | 'replace'; snapshotName: string; added: number; updated: number;
};
export type NativeBackupCsvImportResult = Omit<MindwtrCsvImportExecutionResult, 'data'>;
export type NativeBackupTodoistImportResult = Omit<TodoistImportExecutionResult, 'data'>;
export type NativeBackupTickTickImportResult = Omit<TickTickImportExecutionResult, 'data'>;
export type NativeBackupDgtImportResult = Omit<DgtImportExecutionResult, 'data'>;
export type NativeBackupOmniFocusImportResult = Omit<OmniFocusImportExecutionResult, 'data'>;
/** `undo: false`: the operation ran without Undo, its library too large to undo (large-library pass b; never a snapshot restore). */
export type NativeBackupDocumentReply = (NativeBackupJsonDocumentReply | {
    version: 1; operation: 'csv'; snapshotName: string; result: NativeBackupCsvImportResult;
} | {
    version: 1; operation: 'todoist'; snapshotName: string; result: NativeBackupTodoistImportResult;
} | {
    version: 1; operation: 'ticktick'; snapshotName: string; result: NativeBackupTickTickImportResult;
} | {
    version: 1; operation: 'dgt'; snapshotName: string; result: NativeBackupDgtImportResult;
} | {
    version: 1; operation: 'omnifocus'; snapshotName: string; result: NativeBackupOmniFocusImportResult;
}) & { undo?: false };
type Operation = 'merge' | 'restore' | 'replace' | 'csv' | 'todoist' | 'ticktick' | 'dgt' | 'omnifocus';
export type NativeBackupDocumentPrepareInput = {
    requestId: string; mode: Operation; snapshotName: string;
    text: string; metadata: NativeBackupDocumentMetadata;
    /**
     * A host with a measured memory limit (Android): the picked file's bytes and that limit. The library's bytes are core's
     * (SQLite pages), so the source and the library are refused together before any parse and again inside the document lane
     * (a write queued ahead may have grown the library), and the plan freezes how large the library may grow while its Undo
     * still fits (`maxLibraryBytes`).
     */
    admission?: { sourceBytes: number; maxTransferBytes: number };
};
type Plan = {
    version: 1; requestId: string; mode: Operation; preparedAt: string;
    expectedCurrent: AppData; data: AppData; reply: NativeBackupDocumentReply;
    /**
     * The library's SQLite bytes the commit may leave, its receipt included: the limit less the recovery snapshot's bytes, or for a
     * snapshot restore (no recovery snapshot) the limit itself. A plan from before large-library pass b may carry it for any mode.
     */
    maxLibraryBytes?: number;
    /** The library's SQLite bytes the commit may leave while its Undo still fits: past them it lands without Undo (pass b). */
    undoLibraryBytes?: number;
};
class BackupInputError extends Error {}
function invalid(message = 'Invalid backup document input'): never { throw new BackupInputError(`INVALID_INPUT: ${message}`); }
function tooLarge(message: string): never { throw new BackupInputError(`TOO_LARGE: ${message}`); }
const UNDO_TOO_LARGE = 'TOO_LARGE: The imported library would be too large to undo';
// The commit decides Undo from the real bytes, on the line the admission before pass b used: the recovery snapshot and the
// saved library fit the limit together. Prepare only estimates it, to ask "Undo may not be available" first.
// ponytail: the estimate is today's SQLite bytes (SQLite keeps its pages when rows go) plus the planned compact JSON's growth at
// 1.8 SQLite bytes per compact JSON byte (step 0 run 6: 1.3 per pretty byte; compact JSON is 0.74 of pretty). Measured against
// the real library after: 0.92x to 1.35x, so a question can come and Undo still stay, or none come and Undo go (its toast says so).
const SQLITE_BYTES_PER_JSON_BYTE = 1.8;
const logUndoUnavailable = (operation: string, outcome: 'estimate' | 'after-save'): void => {
    try {
        logInfo(outcome === 'estimate' ? 'Native data transfer may run without Undo: the library may be too large to undo'
            : 'Native data transfer ran without Undo: the library is too large to undo', { scope: 'transfer', category: 'storage',
            context: { releaseCheck: 'v1.3.7/large-library-no-undo', operation, outcome } });
    } catch { /* Logging must not change the transfer. */ }
};
const RESTORE_TOO_LARGE = 'TOO_LARGE: The restored library would exceed the transfer limit';
function saveFailed(): never { throw new Error('SAVE_FAILED: Backup document outcome could not be verified'); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => record(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
const uuid = (value: unknown): value is string => typeof value === 'string'
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const mode = (value: unknown): value is Operation => value === 'merge' || value === 'restore' || value === 'replace' || value === 'csv' || value === 'todoist' || value === 'ticktick' || value === 'dgt' || value === 'omnifocus';
const snapshotPattern = /^data\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{3})(?:\.\d+)?)?\.snapshot\.json$/u;
const snapshot = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length > 128) return false;
    const match = snapshotPattern.exec(value);
    if (!match) return false;
    const timestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5] ?? '000'}Z`;
    return Number.isFinite(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp;
};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const metadataValid = (value: unknown): value is NativeBackupDocumentMetadata => exact(value, ['fileName', 'lastModified', 'appVersion'])
    && typeof value.fileName === 'string' && value.fileName.length <= 1024
    && typeof value.appVersion === 'string' && value.appVersion.length <= 128
    && typeof value.lastModified === 'number' && Number.isFinite(value.lastModified) && value.lastModified >= 0;

// Count without allocating a second encoded copy of a document up to 512 MiB.
// Unpaired UTF-16 surrogates become the UTF-8 replacement character, as TextEncoder does.
const withinUtf8Limit = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && value.length <= limit && utf8Bytes(value, limit) <= limit;
/** [value]'s UTF-8 bytes, counting stops once past [limit]. */
const utf8Bytes = (value: string, limit = Number.POSITIVE_INFINITY): number => {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
            && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4; index += 1;
        } else bytes += 3;
        if (bytes > limit) return bytes;
    }
    return bytes;
};
/**
 * An import's warnings as stored (plan, receipt, result record): `<code>:<count>` plus bounded numeric CSV locations, never the file's words. A warning
 * can quote the source (an unsupported rule, a renamed project's name); RN's toast shows counts and safe CSV positions.
 * Renamed container names stay in this process's memory ([liveWarnings]) until its toast is built or the operation fails. iOS
 * still reads a string list. A plan, receipt or reply written before this form (English sentences, which can quote the file) is
 * read through [storedReply] at every boundary (plan, receipt, result), so its words are never stored or shown again.
 */
const WARNING_TOKEN = /^([a-z]+(?:-[a-z]+)*):(\d{1,9})(?: \[csv-locations=[\d:,]+; omitted=\d+\])?$/u;
const persistedWarnings = (warnings: readonly string[]): string[] => warnings.map((warning) => {
    const token = WARNING_TOKEN.exec(warning);
    const diagnostic = token ? { code: token[1], params: { count: Number(token[2]) } } : createImportDiagnostic(warning, 'warning');
    const { code } = diagnostic;
    const count = typeof diagnostic.params.count === 'number' ? diagnostic.params.count : 1;
    const { locations, omittedLocations } = code === 'unknown-columns' || code === 'unmapped-date'
        ? importDiagnosticLocationParams(warning) : {};
    return `${code}:${count}${typeof locations === 'string' ? ` [csv-locations=${locations}; omitted=${omittedLocations}]` : ''}`;
});
/** [reply] with its warnings in the stored form (an older reply's sentences become codes and counts). */
const storedReply = <R extends NativeBackupDocumentReply>(reply: R): R => 'result' in reply
    ? { ...reply, result: { ...reply.result, warnings: persistedWarnings(reply.result.warnings) } } : reply;
const COUNTED_WARNINGS = new Set<ImportDiagnosticCode>(['adjusted-records', 'duplicate-identity', 'empty-records', 'invalid-archive-entry',
    'missing-parent', 'skipped-archive-entry', 'skipped-existing-records', 'unknown-columns', 'unmapped-date', 'unmapped-status', 'unsupported-recurrence']);
const warningDiagnostic = (warning: string): ImportDiagnostic => {
    const token = WARNING_TOKEN.exec(persistedWarnings([warning])[0]);
    if (!token) return { code: 'adjusted-records', params: { count: 1 }, severity: 'warning' };
    const code = COUNTED_WARNINGS.has(token[1] as ImportDiagnosticCode) ? token[1] as ImportDiagnosticCode : 'adjusted-records';
    return { code, params: { count: Number(token[2]), ...importDiagnosticLocationParams(warning) }, severity: 'warning' };
};
/** The last prepared import's full warnings, only when one names a renamed container; one operation at a time. */
let liveWarnings: { snapshotName: string; tokens: string[]; diagnostics: ImportDiagnostic[] } | null = null;
/** Drops the names an import's toast would show: on every failure and refusal, and once the toast is built. */
export const releaseNativeBackupDocumentWarnings = (): void => { liveWarnings = null; };
/** Tests: whether any import's warning names are still held. */
export const nativeBackupDocumentWarningsHeld = (): boolean => liveWarnings !== null;
const parseSource = (text: unknown, metadata: unknown) => {
    if (!withinUtf8Limit(text, MAX_BACKUP_SOURCE_BYTES)) invalid('Backup source exceeds 128 MiB');
    if (!metadataValid(metadata)) invalid();
    return parseImportSource('backup', { text, ...metadata });
};
const sextet = (code: number): number => code >= 65 && code <= 90 ? code - 65
    : code >= 97 && code <= 122 ? code - 71 : code >= 48 && code <= 57 ? code + 4
        : code === 43 ? 62 : code === 47 ? 63 : -1;
// Validate canonical padding and trailing bits, and bound decoded bytes before allocating.
const decodeBinarySource = (text: unknown, metadata: unknown, label: 'CSV' | 'Todoist' | 'TickTick' | 'DGT' | 'OmniFocus') => {
    const limit = DEFAULT_IMPORT_SOURCE_LIMITS.maxInputBytes;
    if (typeof text !== 'string') invalid();
    if (text.length > 4 * Math.ceil(limit / 3)) invalid(`${label} source exceeds 16 MiB`);
    if (text.length % 4 !== 0) invalid();
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    const size = text.length / 4 * 3 - padding;
    if (size > limit) invalid(`${label} source exceeds 16 MiB`);
    const end = text.length - padding;
    for (let index = 0; index < end; index += 1) if (sextet(text.charCodeAt(index)) < 0) invalid();
    if (padding && (end < 2 || (sextet(text.charCodeAt(end - 1)) & (padding === 2 ? 15 : 3)) !== 0)) invalid();
    if (!metadataValid(metadata)) invalid();
    return { bytes: base64ToBytes(text), fileName: metadata.fileName };
};
const parseCsvSource = (text: unknown, metadata: unknown) => parseImportSource('mindwtr-csv', decodeBinarySource(text, metadata, 'CSV'));
const parseTodoistSource = (text: unknown, metadata: unknown) => parseImportSource('todoist', decodeBinarySource(text, metadata, 'Todoist'));
const parseTickTickSource = (text: unknown, metadata: unknown) => parseImportSource('ticktick', decodeBinarySource(text, metadata, 'TickTick'));
const parseDgtSource = (text: unknown, metadata: unknown) => parseImportSource('dgt', decodeBinarySource(text, metadata, 'DGT'));
const parseOmniFocusSource = (text: unknown, metadata: unknown) => parseImportSource('omnifocus', decodeBinarySource(text, metadata, 'OmniFocus'));
const inspectCsv = (text: string, metadata: NativeBackupDocumentMetadata, t: ImportDiagnosticTranslator) => {
    const model = { valid: false, title: t('settings.backupMobile.importMindwtrCsvData'), summary: '',
        confirmLabel: t('settings.backupMobile.import'), cancelLabel: t('common.cancel'),
        errorTitle: t('settings.backupMobile.importFailed'), errorMessage: t('settings.backupMobile.theSelectedFileIsNotASupportedMindwtrCsvFile') };
    try {
        const parsed = parseCsvSource(text, metadata);
        if (!parsed.valid || !parsed.parsedData || !parsed.preview) {
            const error = parsed.diagnostics.find((item) => item.severity === 'error');
            return { ...model, errorMessage: error ? formatImportDiagnostic(error, t) : model.errorMessage };
        }
        return { ...model, valid: true, summary: buildMindwtrCsvPreviewSummary(parsed.preview, t), errorMessage: '' };
    } catch { return model; }
};
const inspectTodoist = (text: string, metadata: NativeBackupDocumentMetadata, t: ImportDiagnosticTranslator) => {
    const model = { valid: false, title: t('settings.backupMobile.importTodoistData'), summary: '',
        confirmLabel: t('settings.backupMobile.import'), cancelLabel: t('common.cancel'),
        errorTitle: t('settings.backupMobile.importFailed'), errorMessage: t('settings.backupMobile.theSelectedFileIsNotASupportedTodoistExport') };
    try {
        const parsed = parseTodoistSource(text, metadata);
        if (!parsed.valid || !parsed.preview) {
            const error = parsed.diagnostics.find((item) => item.severity === 'error');
            return { ...model, errorMessage: error ? formatImportDiagnostic(error, t) : model.errorMessage };
        }
        return { ...model, valid: true, summary: buildTodoistPreviewSummary(parsed.preview, t), errorMessage: '' };
    } catch { return model; }
};
const inspectTickTick = (text: string, metadata: NativeBackupDocumentMetadata, t: ImportDiagnosticTranslator) => {
    const model = { valid: false, title: t('settings.backupMobile.importTicktickData'), summary: '',
        confirmLabel: t('settings.backupMobile.import'), cancelLabel: t('common.cancel'),
        errorTitle: t('settings.backupMobile.importFailed'), errorMessage: t('settings.backupMobile.theSelectedFileIsNotASupportedTicktickBackup') };
    try {
        const parsed = parseTickTickSource(text, metadata);
        if (!parsed.valid || !parsed.preview || !parsed.parsedData) {
            const error = parsed.diagnostics.find((item) => item.severity === 'error');
            return { ...model, errorMessage: error ? formatImportDiagnostic(error, t) : model.errorMessage };
        }
        return { ...model, valid: true, summary: buildTickTickPreviewSummary(parsed.preview, t), errorMessage: '' };
    } catch { return model; }
};

const inspectDgt = (text: string, metadata: NativeBackupDocumentMetadata, t: ImportDiagnosticTranslator) => {
    const model = { valid: false, title: t('settings.backupMobile.importDgtGtdData'), summary: '',
        confirmLabel: t('settings.backupMobile.import'), cancelLabel: t('common.cancel'),
        errorTitle: t('settings.backupMobile.importFailed'), errorMessage: t('settings.backupMobile.theSelectedFileIsNotASupportedDgtGtdExport') };
    try {
        const parsed = parseDgtSource(text, metadata);
        if (!parsed.valid || !parsed.preview || !parsed.parsedData) {
            const error = parsed.diagnostics.find((item) => item.severity === 'error');
            return { ...model, errorMessage: error ? formatImportDiagnostic(error, t) : model.errorMessage };
        }
        return { ...model, valid: true, summary: buildDgtPreviewSummary(parsed.preview, t), errorMessage: '' };
    } catch { return model; }
};

const inspectOmniFocus = (text: string, metadata: NativeBackupDocumentMetadata, t: ImportDiagnosticTranslator) => {
    const model = { valid: false, title: t('settings.backupMobile.importOmnifocusData'), summary: '',
        confirmLabel: t('settings.backupMobile.import'), cancelLabel: t('common.cancel'),
        errorTitle: t('settings.backupMobile.importFailed'), errorMessage: t('settings.backupMobile.theSelectedFileIsNotASupportedOmnifocusExport') };
    try {
        const parsed = parseOmniFocusSource(text, metadata);
        if (!parsed.valid || !parsed.preview || !parsed.parsedData) {
            const error = parsed.diagnostics.find((item) => item.severity === 'error');
            return { ...model, errorMessage: error ? formatImportDiagnostic(error, t) : model.errorMessage };
        }
        return { ...model, valid: true, summary: buildOmniFocusPreviewSummary(parsed.preview, t), errorMessage: '' };
    } catch { return model; }
};

/** RN's immutable inspection preview. Invalid files are ordinary localized values. */
export function inspectNativeBackupDocument(text: string, metadata: NativeBackupDocumentMetadata, t: ImportDiagnosticTranslator, format: 'json' | 'json-restore' | 'csv' | 'todoist' | 'ticktick' | 'dgt' | 'omnifocus' = 'json') {
    if (format === 'csv') return inspectCsv(text, metadata, t);
    if (format === 'todoist') return inspectTodoist(text, metadata, t);
    if (format === 'ticktick') return inspectTickTick(text, metadata, t);
    if (format === 'dgt') return inspectDgt(text, metadata, t);
    if (format === 'omnifocus') return inspectOmniFocus(text, metadata, t);
    if (format !== 'json' && format !== 'json-restore') invalid();
    const replacing = format === 'json-restore';
    const model = {
        valid: false, title: t(replacing ? 'settings.backupMobile.restoreBackup' : 'settings.mergeBackup'), summary: '',
        confirmLabel: t(replacing ? 'markdown.referenceRestore' : 'settings.mergeBackupAction'),
        cancelLabel: t('common.cancel'), errorTitle: t('settings.backupMobile.invalidBackup'),
        errorMessage: t('settings.backupMobile.thisFileIsNotAValidMindwtrBackup'),
    };
    if (!withinUtf8Limit(text, MAX_BACKUP_SOURCE_BYTES)) {
        return { ...model, errorMessage: formatImportDiagnostic({ code: 'backup-source-too-large', severity: 'error',
            params: { maxSizeMb: 128 } }, t) };
    }
    try {
        const validation = parseSource(text, metadata);
        if (!validation.valid || !validation.data) {
            const errors = validation.diagnostics.filter((item) => item.severity === 'error');
            return { ...model, errorMessage: errors.length ? errors.map((item) => formatImportDiagnostic(item, t)).join('\n') : model.errorMessage };
        }
        const effect = t(replacing ? 'settings.backupMobile.thisWillReplaceAllCurrentLocalDataARecoverySnapshot' : 'settings.mergeBackupConfirm');
        return { ...model, valid: true, summary: buildBackupPreviewSummary(validation, effect, t), errorMessage: '' };
    } catch { return model; }
}

const flush = async () => {
    if (useTaskStore.getState().persistenceFailure) saveFailed();
    await flushPendingSave();
    if (useTaskStore.getState().persistenceFailure) saveFailed();
};
const completeDocument = (value: unknown): value is AppData => record(value)
    && ['tasks', 'projects', 'sections', 'areas', 'people'].every((field) => Array.isArray(value[field]))
    && record(value.settings) && validateMergedSyncData(value as unknown as AppData).length === 0;

/**
 * Where a host with a file channel (Android, pass D1c) takes prepare's two texts instead of the reply: [recovery] once with the
 * whole recovery snapshot (none for a snapshot restore), then [plan] with the plan's parts in order. The parts join to the
 * exact text the reply would carry, so the plan's bytes and hash do not depend on the host.
 */
export type NativeBackupPrepareSink = { recovery(text: string): void; plan(part: string): void };
/** A sink's own failure (a host's file limit or write error): prepare answers it as the sink worded it. */
class SinkFailure extends Error { constructor(readonly failure: unknown) { super('Prepare sink failed'); } }
const sinkCall = (work: () => void): void => { try { work(); } catch (error) { throw new SinkFailure(error); } };
/** The plan's text in parts: its fields, then each large document stringified on its own, never the whole plan at once. */
function* planParts(plan: Plan): Generator<string> {
    yield `{"version":${JSON.stringify(plan.version)},"requestId":${JSON.stringify(plan.requestId)},"mode":${JSON.stringify(plan.mode)},"preparedAt":${JSON.stringify(plan.preparedAt)},"expectedCurrent":`;
    yield JSON.stringify(plan.expectedCurrent);
    yield ',"data":';
    yield JSON.stringify(plan.data);
    yield `,"reply":${JSON.stringify(plan.reply)}${plan.maxLibraryBytes === undefined ? '' : `,"maxLibraryBytes":${JSON.stringify(plan.maxLibraryBytes)}`}${plan.undoLibraryBytes === undefined ? '' : `,"undoLibraryBytes":${JSON.stringify(plan.undoLibraryBytes)}`}}`;
}

/** Freeze shared RN policy against a fresh durable base; this performs no document write (a [sink] only receives its texts). */
/**
 * [undo] (only with an admission and a recovery snapshot): whether prepare's estimate says Undo fits (large-library pass b). It
 * only decides whether to ask first; the commit decides Undo from the real bytes (its reply's `undo: false`).
 */
type PreparedUndo = { undo?: boolean };
export async function prepareNativeBackupDocument(adapter: NativeReceiptSqliteAdapter, input: NativeBackupDocumentPrepareInput): Promise<{ planJSON: string; recoveryJSON: string | null } & PreparedUndo>;
export async function prepareNativeBackupDocument(adapter: NativeReceiptSqliteAdapter, input: NativeBackupDocumentPrepareInput, sink: NativeBackupPrepareSink): Promise<{ written: true; recovery: boolean } & PreparedUndo>;
export async function prepareNativeBackupDocument(adapter: NativeReceiptSqliteAdapter, input: NativeBackupDocumentPrepareInput, sink?: NativeBackupPrepareSink): Promise<({ planJSON: string; recoveryJSON: string | null } | { written: true; recovery: boolean }) & PreparedUndo> {
    releaseNativeBackupDocumentWarnings();
    const fields = ['requestId', 'mode', 'snapshotName', 'text', 'metadata'];
    const admission: unknown = (input as { admission?: unknown }).admission;
    const admitted = admission === undefined ? exact(input, fields) : exact(input, [...fields, 'admission'])
        && exact(admission, ['sourceBytes', 'maxTransferBytes']) && count(admission.sourceBytes) && count(admission.maxTransferBytes);
    if (!admitted || !uuid(input.requestId) || !mode(input.mode) || !snapshot(input.snapshotName)) invalid();
    const admit = async (): Promise<number> => {
        if (!input.admission) return 0;
        const libraryBytes = await adapter.libraryBytes();
        if (input.admission.sourceBytes + libraryBytes > input.admission.maxTransferBytes) {
            tooLarge('The selected file and the library exceed the transfer limit');
        }
        return libraryBytes;
    };
    await admit();
    // Parse owned bytes before admission; no untrusted thrown details escape.
    let parsed: ReturnType<typeof parseSource>['data'];
    let csv: ReturnType<typeof parseCsvSource>['parsedData'];
    let todoist: ReturnType<typeof parseTodoistSource>['parsedProjects'] | undefined;
    let ticktick: ReturnType<typeof parseTickTickSource>['parsedData'];
    let dgt: ReturnType<typeof parseDgtSource>['parsedData'];
    let omnifocus: ReturnType<typeof parseOmniFocusSource>['parsedData'];
    try {
        if (input.mode === 'csv') { const validation = parseCsvSource(input.text, input.metadata); if (!validation.valid || !validation.parsedData) invalid(); csv = validation.parsedData; }
        else if (input.mode === 'todoist') { const validation = parseTodoistSource(input.text, input.metadata); if (!validation.valid || !validation.preview) invalid(); todoist = validation.parsedProjects; }
        else if (input.mode === 'ticktick') { const validation = parseTickTickSource(input.text, input.metadata); if (!validation.valid || !validation.parsedData) invalid(); ticktick = validation.parsedData; }
        else if (input.mode === 'dgt') { const validation = parseDgtSource(input.text, input.metadata); if (!validation.valid || !validation.parsedData) invalid(); dgt = validation.parsedData; }
        else if (input.mode === 'omnifocus') { const validation = parseOmniFocusSource(input.text, input.metadata); if (!validation.valid || !validation.parsedData) invalid(); omnifocus = validation.parsedData; }
        else { const validation = parseSource(input.text, input.metadata); if (!validation.valid || !validation.data) invalid(); parsed = validation.data; }
    }
    catch (error) { if (error instanceof BackupInputError) throw error; return invalid(); }
    // A host with a sink hands its input over: the source text goes once parsed, so it is not kept through the lane.
    if (sink) (input as { text: string }).text = '';
    const { requestId, mode: operation, snapshotName } = input;
    const appVersion = input.metadata.appVersion;
    try {
        return await runSerializedSyncDocumentWriteOperation(async () => {
            await flush();
            // Again in the lane: a write queued ahead of this one may have grown the library since the first check.
            const libraryBytes = await admit();
            // A legacy settings.ai.apiKey (an older build saved it) never reaches the plan, the recovery snapshot or the saved
            // result; the commit's baseline check ignores it the same way (NativeReceiptSqliteAdapter.saveDocumentWithReceipt).
            const raw = await adapter.getData();
            if (!completeDocument(raw)) invalid();
            const current: AppData = { ...raw, settings: stripSensitiveSettings(raw.settings) };
            // No copy: no import policy changes the document it applies to (a deep-frozen test per mode guards this), so the
            // baseline and its recovery snapshot read `current` itself.
            const expectedCurrent = current;
            const applied = operation === 'merge' ? applyImportSource('backup-merge', current, parsed!) : null;
            const csvApplied = operation === 'csv' ? applyImportSource('mindwtr-csv', current, csv!) : null;
            const todoistApplied = operation === 'todoist' ? applyImportSource('todoist', current, todoist!) : null;
            const ticktickApplied = operation === 'ticktick' ? applyImportSource('ticktick', current, ticktick!) : null;
            const dgtApplied = operation === 'dgt' ? applyImportSource('dgt', current, dgt!) : null;
            const omnifocusApplied = operation === 'omnifocus' ? applyImportSource('omnifocus', current, omnifocus!) : null;
            const appliedData = omnifocusApplied?.data ?? dgtApplied?.data ?? ticktickApplied?.data ?? todoistApplied?.data ?? csvApplied?.data ?? applied?.data ?? applyImportSource('backup', current, parsed!).data;
            // The parsed source is applied: its objects go before the recovery snapshot and the plan are stringified.
            parsed = csv = ticktick = dgt = omnifocus = null; todoist = undefined;
            // A key inside the picked file (an older export) is never planned or saved either.
            const data: AppData = { ...appliedData, settings: stripSensitiveSettings(appliedData.settings) };
            const counts = applied ? summarizeBackupMerge(applied.result) : { added: 0, updated: 0 };
            let reply: NativeBackupDocumentReply;
            if (omnifocusApplied) {
                const result = omnifocusApplied.result;
                reply = { version: 1, operation: 'omnifocus', snapshotName, result: {
                    importedAreaCount: result.importedAreaCount, importedChecklistItemCount: result.importedChecklistItemCount,
                    importedProjectCount: result.importedProjectCount, importedSectionCount: result.importedSectionCount,
                    importedStandaloneTaskCount: result.importedStandaloneTaskCount, importedTaskCount: result.importedTaskCount, warnings: persistedWarnings(result.warnings),
                } };
            } else if (dgtApplied) {
                const result = dgtApplied.result;
                reply = { version: 1, operation: 'dgt', snapshotName, result: {
                    importedAreaCount: result.importedAreaCount, importedChecklistItemCount: result.importedChecklistItemCount,
                    importedProjectCount: result.importedProjectCount, importedSectionCount: result.importedSectionCount,
                    importedTaskCount: result.importedTaskCount, warnings: persistedWarnings(result.warnings),
                } };
            } else if (ticktickApplied) {
                const result = ticktickApplied.result;
                reply = { version: 1, operation: 'ticktick', snapshotName, result: {
                    importedAreaCount: result.importedAreaCount, importedChecklistItemCount: result.importedChecklistItemCount,
                    importedProjectCount: result.importedProjectCount, importedSectionCount: result.importedSectionCount,
                    importedTaskCount: result.importedTaskCount, warnings: persistedWarnings(result.warnings),
                } };
            } else if (todoistApplied) {
                const result = todoistApplied.result;
                reply = { version: 1, operation: 'todoist', snapshotName, result: {
                    importedChecklistItemCount: result.importedChecklistItemCount, importedProjectCount: result.importedProjectCount,
                    importedSectionCount: result.importedSectionCount, importedTaskCount: result.importedTaskCount, warnings: persistedWarnings(result.warnings),
                } };
            } else if (csvApplied) {
                const result = csvApplied.result;
                reply = { version: 1, operation: 'csv', snapshotName, result: {
                    importedAreaCount: result.importedAreaCount, importedChecklistItemCount: result.importedChecklistItemCount,
                    importedProjectCount: result.importedProjectCount, importedSectionCount: result.importedSectionCount,
                    importedStandaloneTaskCount: result.importedStandaloneTaskCount, importedTaskCount: result.importedTaskCount, warnings: persistedWarnings(result.warnings),
                } };
            } else reply = { version: 1, operation: operation as 'merge' | 'restore' | 'replace', snapshotName, ...counts };
            validateReply(reply);
            const rawWarnings = (omnifocusApplied ?? dgtApplied ?? ticktickApplied ?? todoistApplied ?? csvApplied)?.result.warnings ?? [];
            const plan: Plan = { version: 1, requestId, mode: operation, preparedAt: new Date().toISOString(),
                expectedCurrent, data, reply };
            if (!completeDocument(data)) invalid();
            let recoveryJSON = operation !== 'restore' ? serializeBackupData(expectedCurrent) : null;
            const recovery = recoveryJSON !== null;
            if (recoveryJSON !== null) {
                if (!withinUtf8Limit(recoveryJSON, MAX_BACKUP_SOURCE_BYTES)) invalid('Recovery snapshot exceeds 128 MiB');
                if (!parseSource(recoveryJSON, { fileName: snapshotName, lastModified: Date.now(), appVersion }).valid) invalid('Recovery snapshot is not a valid backup');
            }
            // Undo restores the recovery snapshot over the library left after: both must fit the limit together. When they cannot,
            // the operation still runs, without Undo, as RN's does (large-library pass b); its recovery snapshot is still written.
            const undoRoom = input.admission && recoveryJSON !== null ? input.admission.maxTransferBytes - utf8Bytes(recoveryJSON) : null;
            if (input.admission && recoveryJSON === null) {
                // A snapshot restore has no recovery snapshot to admit: its result library itself stays within the limit.
                plan.maxLibraryBytes = input.admission.maxTransferBytes;
            }
            // A sink takes the recovery text before the plan is stringified, and this frame lets it go.
            if (sink && recoveryJSON !== null) { const text = recoveryJSON; sinkCall(() => sink.recovery(text)); recoveryJSON = null; }
            let planJSON = '';
            let planBytes = 0;
            let undo: boolean | undefined;
            const partBytes: number[] = [];
            for (const part of planParts(plan)) {
                const bytes = utf8Bytes(part, MAX_NATIVE_BACKUP_PLAN_BYTES - planBytes);
                planBytes += bytes;
                partBytes.push(bytes);
                if (planBytes > MAX_NATIVE_BACKUP_PLAN_BYTES) invalid('Prepared backup plan exceeds 512 MiB');
                if (sink) sinkCall(() => sink.plan(part)); else planJSON += part;
                // The documents' parts are out (expectedCurrent, then data): decide the Undo before the last part writes the reply.
                if (undoRoom !== null && partBytes.length === 4) {
                    const estimate = Math.ceil(libraryBytes + Math.max(0, partBytes[3] - partBytes[1]) * SQLITE_BYTES_PER_JSON_BYTE);
                    undo = undoRoom >= 0 && estimate <= undoRoom;
                    // A recovery snapshot past the limit alone can never be undone; otherwise the commit measures.
                    if (undoRoom >= 0) plan.undoLibraryBytes = undoRoom;
                    else plan.reply = { ...plan.reply, undo: false };
                    if (!undo) logUndoUnavailable(operation, 'estimate');
                }
            }
            const diagnostics = createImportDiagnostics(rawWarnings, 'warning');
            if (diagnostics.some((diagnostic) => diagnostic.code === 'renamed-container')) {
                liveWarnings = { snapshotName, tokens: [...(reply as { result: { warnings: string[] } }).result.warnings], diagnostics };
            }
            const prepared = undo === undefined ? {} : { undo };
            return sink ? { written: true as const, recovery, ...prepared } : { planJSON, recoveryJSON, ...prepared };
        });
    } catch (error) {
        if (error instanceof BackupInputError) throw error;
        if (error instanceof SinkFailure) throw error.failure;
        return saveFailed();
    }
}

const validateReply = (value: unknown, snapshotName?: string, operation?: Operation): NativeBackupDocumentReply => {
    if (record(value) && 'undo' in value) {
        // An operation that ran without Undo; a snapshot restore never offers one.
        if (value.undo !== false || value.operation === 'restore') invalid();
        const { undo: _undo, ...body } = value;
        validateReply(body, snapshotName, operation);
        return value as NativeBackupDocumentReply;
    }
    if (!record(value) || value.version !== 1 || !mode(value.operation) || !snapshot(value.snapshotName)
        || snapshotName !== undefined && value.snapshotName !== snapshotName || operation !== undefined && value.operation !== operation) invalid();
    if (value.operation === 'csv' || value.operation === 'todoist' || value.operation === 'ticktick' || value.operation === 'dgt' || value.operation === 'omnifocus') {
        const counts = value.operation === 'csv' || value.operation === 'omnifocus'
            ? ['importedAreaCount', 'importedChecklistItemCount', 'importedProjectCount', 'importedSectionCount', 'importedStandaloneTaskCount', 'importedTaskCount']
            : value.operation === 'ticktick' || value.operation === 'dgt' ? ['importedAreaCount', 'importedChecklistItemCount', 'importedProjectCount', 'importedSectionCount', 'importedTaskCount']
                : ['importedChecklistItemCount', 'importedProjectCount', 'importedSectionCount', 'importedTaskCount'];
        const result = value.result;
        if (!exact(value, ['version', 'operation', 'snapshotName', 'result']) || !exact(result, [...counts, 'warnings'])
            || !counts.every((field) => count(result[field])) || !Array.isArray(result.warnings)
            || !result.warnings.every((warning) => typeof warning === 'string')) invalid();
        if (!withinUtf8Limit(JSON.stringify(value), MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES)) invalid(`${value.operation === 'csv' ? 'CSV' : value.operation === 'ticktick' ? 'TickTick' : value.operation === 'dgt' ? 'DGT' : value.operation === 'omnifocus' ? 'OmniFocus' : 'Todoist'} import result exceeds 64 KiB`);
    } else if (!exact(value, ['version', 'operation', 'snapshotName', 'added', 'updated']) || !count(value.added) || !count(value.updated)
        || (value.operation === 'restore' || value.operation === 'replace') && (value.added !== 0 || value.updated !== 0)) invalid();
    return value as NativeBackupDocumentReply;
};
const readPlan = (reference: NativeBackupOperationReference, planJSON: string, snapshotName: string): Plan => {
    if (!exact(reference, ['id', 'sha256', 'byteCount']) || !uuid(reference.id)
        || typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.sha256)
        || !Number.isSafeInteger(reference.byteCount) || reference.byteCount < 1 || reference.byteCount > 8192
        || !snapshot(snapshotName) || !withinUtf8Limit(planJSON, MAX_NATIVE_BACKUP_PLAN_BYTES)) invalid();
    let value: unknown;
    try { value = JSON.parse(planJSON); } catch { return invalid(); }
    const fields = ['version', 'requestId', 'mode', 'preparedAt', 'expectedCurrent', 'data', 'reply'];
    if (!(exact(value, fields) || exact(value, [...fields, 'maxLibraryBytes']) && count(value.maxLibraryBytes)
        || exact(value, [...fields, 'undoLibraryBytes']) && count(value.undoLibraryBytes))
        || value.version !== 1 || value.requestId !== reference.id || !mode(value.mode)
        || typeof value.preparedAt !== 'string' || !Number.isFinite(Date.parse(value.preparedAt))
        || new Date(value.preparedAt).toISOString() !== value.preparedAt
        ) invalid();
    try { if (!completeDocument(value.expectedCurrent) || !completeDocument(value.data)) invalid(); }
    catch { return invalid(); }
    validateReply(value.reply, snapshotName, value.mode);
    // An older plan's warnings (sentences) are committed, compared and answered as codes and counts.
    return { ...(value as Plan), reply: storedReply((value as Plan).reply) };
};
const payload = (reference: NativeBackupOperationReference, plan: Pick<Plan, 'mode'>) => JSON.stringify(['backupDocument', plan.mode, reference.id, reference.sha256]);
const matchedReply = (reply: unknown, plan: Pick<Plan, 'mode' | 'reply'>): NativeBackupDocumentReply => {
    try {
        const validated = storedReply(validateReply(reply, plan.reply.snapshotName, plan.mode));
        // The commit may add `undo: false` (its library ended larger than the plan's estimate); it never takes one away.
        const { undo, ...body } = validated;
        const { undo: planned, ...expected } = plan.reply;
        if (!taskEditValuesEqual(body, expected) || planned === false && undo !== false) saveFailed();
        return validated;
    } catch { return saveFailed(); }
};

/** Read terminal success proof only: never flush, reload, reapply policy or save. */
export async function readNativeBackupDocumentOutcome(adapter: NativeReceiptSqliteAdapter, reference: NativeBackupOperationReference, planJSON: string, snapshotName: string): Promise<NativeBackupDocumentReply | null> {
    const plan = readPlan(reference, planJSON, snapshotName);
    try {
        const result = await adapter.readDurableReceipt(reference.id, payload(reference, plan));
        if (!result.ok) saveFailed();
        return result.value === null ? null : matchedReply(result.value, plan);
    } catch { return saveFailed(); }
}

/** Commit only the frozen plan, or reload after an exact durable replay. */
/** A host's plan text, handed over once (Android's file channel): no caller's frame keeps the text while the commit runs. */
export type NativeBackupPlanSource = { take(): string };
/** [options.getLocalAttachmentPresence]: the host's local file check; a live file attachment whose file is gone is saved as 'missing'. */
export type NativeBackupCommitOptions = { getLocalAttachmentPresence?: (uri: string) => Promise<LocalAttachmentPresence> };
export async function commitNativeBackupDocument(adapter: NativeReceiptSqliteAdapter, reference: NativeBackupOperationReference, planJSON: string | NativeBackupPlanSource, snapshotName: string, options: NativeBackupCommitOptions = {}): Promise<NativeBackupDocumentReply> {
    try {
        return await commitPlan(adapter, reference, planJSON, snapshotName, options);
    } catch (error) {
        // A stale, refused or failed commit shows its failure, never this operation's result: its names go now.
        releaseNativeBackupDocumentWarnings();
        throw error;
    }
}

async function commitPlan(adapter: NativeReceiptSqliteAdapter, reference: NativeBackupOperationReference, planJSON: string | NativeBackupPlanSource, snapshotName: string, options: NativeBackupCommitOptions): Promise<NativeBackupDocumentReply> {
    // The plan's two documents are held only until the adapter took them (cut g, pass D1c); its small fields stay.
    let plan: Plan | null = readPlan(reference, typeof planJSON === 'string' ? planJSON : planJSON.take(), snapshotName);
    const kept = { mode: plan.mode, reply: plan.reply, maxLibraryBytes: plan.maxLibraryBytes, undoLibraryBytes: plan.undoLibraryBytes };
    const ownedReference = { ...reference };
    try {
        return await runSerializedSyncDocumentWriteOperation(async () => {
            await flush();
            // Every mode but a snapshot restore wrote a recovery snapshot of expectedCurrent: the result toast's Undo. Only its
            // attachments' paths and keys stay, never the document.
            const undoReferences = kept.mode !== 'restore' ? findLiveAttachmentResourceReferences(plan!.expectedCurrent) : null;
            let result;
            try {
                // This plan was parsed here and nobody else holds it, so the adapter may keep its objects without a copy.
                const saving = adapter.saveDocumentWithReceipt({ requestId: ownedReference.id, payload: payload(ownedReference, kept),
                    expectedCurrent: plan!.expectedCurrent, reply: kept.reply, owned: true,
                    data: options.getLocalAttachmentPresence
                        ? await markMissingLocalAttachmentFiles(plan!.data, options.getLocalAttachmentPresence) : plan!.data,
                    ...(kept.maxLibraryBytes === undefined ? {} : { maxLibraryBytes: kept.maxLibraryBytes }),
                    ...(kept.undoLibraryBytes === undefined ? {} : { undoLibraryBytes: kept.undoLibraryBytes }) });
                plan = null;
                result = await saving;
            } catch (error) {
                if (error instanceof Error && error.message === 'Stale document receipt baseline') {
                    throw new Error('STALE_REVISION: Local data changed after backup preparation');
                }
                if (error instanceof Error && error.message === UNDO_LIMIT_EXCEEDED) throw new Error(kept.mode === 'restore' ? RESTORE_TOO_LARGE : UNDO_TOO_LARGE);
                return saveFailed();
            }
            const reply = matchedReply(result.reply, kept);
            if (reply.undo === false && kept.reply.undo !== false && !result.replayed) logUndoUnavailable(kept.mode, 'after-save');
            // An operation that ran without Undo offers none: nothing to hold.
            if (undoReferences && reply.undo !== false) holdRestoreUndoAttachments(undoReferences);
            try {
                markNextLoadAsDocumentReplacement();
                // Maintenance resumes only after the native journal has been cleared.
                await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad: true });
            } catch { throw new Error('SAVE_FAILED: Backup document was saved but reload failed'); }
            return reply;
        });
    } catch (error) {
        if (error instanceof Error && (error.message === 'STALE_REVISION: Local data changed after backup preparation'
            || error.message === UNDO_TOO_LARGE || error.message === RESTORE_TOO_LARGE
            || error.message === 'SAVE_FAILED: Backup document was saved but reload failed')) throw error;
        return saveFailed();
    }
}

const IMPORT_OPERATIONS = new Set(['csv', 'todoist', 'ticktick', 'dgt', 'omnifocus']);
/** The size refusals core words itself (decodeBinarySource, prepare); any other text is no capacity reason, whatever it says. */
const CAPACITY_REFUSALS = new Set(['INVALID_INPUT: Recovery snapshot exceeds 128 MiB', 'INVALID_INPUT: Prepared backup plan exceeds 512 MiB',
    ...['CSV', 'Todoist', 'TickTick', 'DGT', 'OmniFocus'].map((label) => `INVALID_INPUT: ${label} source exceeds 16 MiB`)]);
/**
 * RN's failure toast for a restore, merge, snapshot restore or import that did not land ([operation]: core's backup document
 * mode), from the failure's text ([error]: `CODE: message`, or `TOO_LARGE` when the host refused a file or a plan by size):
 * RN's title (an import's "Import failed", "Merge failed", else "Restore failed"); an import's words through RN's
 * formatThrownImportError, a backup's own words without their code (RN's formatThrownBackupError); a size refusal as core's
 * limit text. A failure ends the operation, so its warning names ([liveWarnings]) go too.
 */
export function buildNativeBackupDocumentFailure(operation: string, error: string, t: ImportDiagnosticTranslator, limitMb: number) {
    releaseNativeBackupDocumentWarnings();
    const imported = IMPORT_OPERATIONS.has(operation);
    const title = imported ? t('settings.backupMobile.importFailed')
        : operation === 'merge' ? t('settings.mergeBackupFailed') : t('settings.backupMobile.restoreFailed');
    const words = /^[A-Z_]+: /u.test(error) ? error.slice(error.indexOf(': ') + 2) : error;
    // Core's own capacity refusals (a recovery snapshot past the backup cap, a source past 16 MiB, a plan past 512 MiB) are an
    // import's size limit too, as iOS shows them; they read as an unreadable export before (D1c step 0).
    const capacity = imported && CAPACITY_REFUSALS.has(error);
    if (error === 'TOO_LARGE' || error.startsWith('TOO_LARGE: ') || capacity) {
        return { title, message: imported ? t('settings.importDiagnostics.limitExceeded') : t('settings.backupDiagnostics.tooLarge', { maxSizeMb: limitMb }) };
    }
    return { title, message: imported ? formatImportDiagnostic(createImportDiagnostic(words, 'error'), t) : words };
}

/** RN's result toast: its title and lines, Undo (none after a snapshot restore), and RN's duration (null: the toast's default). */
export function buildNativeBackupDocumentResult(reply: NativeBackupDocumentReply, t: ImportDiagnosticTranslator) {
    validateReply(reply);
    if ('result' in reply) {
        const tokens = persistedWarnings(reply.result.warnings);
        const live = liveWarnings && liveWarnings.snapshotName === reply.snapshotName && taskEditValuesEqual(liveWarnings.tokens, tokens)
            ? liveWarnings.diagnostics : null;
        releaseNativeBackupDocumentWarnings();
        return importResult({ ...reply, result: { ...reply.result, warnings: live ?? tokens.map(warningDiagnostic) } } as ImportReplyWithDiagnostics, t);
    }
    return importResult(reply as ImportReplyWithDiagnostics, t);
}
type ImportReplyWithDiagnostics = NativeBackupDocumentReply extends infer R
    ? R extends { result: infer Result } ? Omit<R, 'result'> & { result: Omit<Result, 'warnings'> & { warnings: ImportDiagnostic[] } } : R
    : never;
function importResult(reply: ImportReplyWithDiagnostics, t: ImportDiagnosticTranslator) {
    const durationMs = reply.operation === 'restore' ? null : DATA_TRANSFER_TOAST_MS[reply.operation];
    // Without Undo (large-library pass b) the toast says so plainly instead of only dropping the button.
    const noUndo = reply.undo === false;
    const withUndoNote = (message: string) => (noUndo ? `${message}\n\n${t('settings.backupMobile.undoUnavailableResult')}` : message);
    const imported = (message: string) => ({ title: t('settings.backupMobile.importComplete'), message: withUndoNote(message),
        undoLabel: noUndo ? '' : t('settings.undoImport'), doneLabel: t('common.done'), durationMs });
    if (reply.operation === 'omnifocus') return imported(buildOmniFocusResultMessage(reply.result, reply.snapshotName, t));
    if (reply.operation === 'ticktick' || reply.operation === 'dgt') return imported(buildAreaImportResultMessage(reply.result, reply.snapshotName, t));
    if (reply.operation === 'todoist') return imported(buildTodoistResultMessage(reply.result, reply.snapshotName, t));
    if (reply.operation === 'csv') return imported(buildMindwtrCsvResultMessage(reply.result, reply.snapshotName, t));
    return {
        title: t(reply.operation === 'merge' ? 'settings.mergeBackup' : 'settings.backupMobile.restoreComplete'),
        message: withUndoNote(reply.operation === 'merge' ? buildMergeResultMessage(reply, reply.snapshotName, t)
            : reply.operation === 'replace' ? t('settings.backupMobile.backupRestoredWithSnapshot', { snapshotName: reply.snapshotName })
                : t('settings.backupMobile.recoverySnapshotRestored')),
        undoLabel: reply.operation !== 'restore' && !noUndo ? t('settings.undoImport') : '', doneLabel: t('common.done'), durationMs,
    };
}

/**
 * Android's leftover result (a death after its commit, before its toast) offers Undo again at the next start: its recovery
 * snapshot's attachments are held again first, as the commit held them (attachment-cleanup.ts holdRestoreUndoAttachments).
 * Parsing the snapshot costs what the Undo's own prepare costs, and the transfer limit admitted that. Answers whether it held.
 */
export function holdNativeBackupUndoAttachments(snapshotText: string, snapshotName: string): boolean {
    if (!snapshot(snapshotName)) invalid();
    const validation = parseSource(snapshotText, { fileName: snapshotName, lastModified: 0, appVersion: '0.0.0' });
    if (!validation.valid || !validation.data) return false;
    holdRestoreUndoAttachments(findLiveAttachmentResourceReferences(validation.data));
    return true;
}

/** The question before an operation that may run without Undo (large-library pass b; RN has no such limit, so no such question). */
export function buildNativeBackupNoUndoConfirmation(t: ImportDiagnosticTranslator) {
    return { title: t('settings.backupMobile.undoUnavailableTitle'), message: t('settings.backupMobile.undoUnavailableConfirm'),
        confirmLabel: t('settings.backupMobile.undoUnavailableContinue'), cancelLabel: t('common.cancel') };
}

/** RN's question before a snapshot restore: the Undo words after an import or restore, else the Recovery snapshots row's. */
export function buildNativeBackupSnapshotRestoreConfirmation(snapshotName: string, t: ImportDiagnosticTranslator, undo = true) {
    if (!snapshot(snapshotName)) invalid();
    const label = formatRecoverySnapshotLabel(snapshotName);
    return undo
        ? { title: t('settings.undoImportConfirmTitle'), message: t('settings.undoImportConfirm', { snapshotName: label }),
            confirmLabel: t('markdown.referenceRestore'), cancelLabel: t('common.cancel') }
        : { title: t('settings.backupMobile.restoreRecoverySnapshot'),
            message: t('settings.backupMobile.restoreSnapshotReplaceLocalData', { snapshotName: label }),
            confirmLabel: t('markdown.referenceRestore'), cancelLabel: t('common.cancel') };
}
