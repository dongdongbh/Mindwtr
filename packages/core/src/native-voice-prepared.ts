import type { AppData, AppSettings, Attachment, Project, Task } from './types';
import type { QuickCaptureOptions } from './quick-capture-model';
import type { NativePreparedQuickCapture, NativePreparedQuickCaptureV2 } from './native-host-contract-quick-capture';
import { readNativeQuickCaptureInput, validatePreparedQuickCapture } from './native-host-contract-quick-capture';
import { readNativeCaptureCopilotApplied, type NativeCaptureCopilotApplied } from './native-capture-copilot';
import { exact, isNativeJsonWithinBytes, record } from './native-json';
import { taskEditValuesEqual } from './json-value-equality';
import { readNativeAttachments } from './native-host-contract-attachments';
import { validRawTask } from './native-host-contract-task-save';
import { buildTaskUpdatesFromSpeechResult } from './task-speech';
import type { SpeechToTaskResult } from './speech-to-task';
import { NATIVE_VOICE_MAX_AUDIO_BYTES } from './speech-to-task';
import { buildNewProject } from './store-projects/project-actions';
import { applyTaskUpdates, createProjectOrderReserver, nextRevision } from './store-helpers';
import { prepareTaskUpdatesForStore } from './store-tasks';
import { findSelectableProjectByTitleAndArea } from './project-utils';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { requestRowId } from './native-request-receipts';
import { rawReadTaskSnapshot } from './sqlite-raw-snapshot';
import { sameTaskSqliteRow } from './store-projects/section-actions';
import { nativeVoiceISO, NATIVE_VOICE_UUID, readNativeVoiceSettingsRequest, nativeVoiceSettingsWitness,
    type NativeVoiceSettingsRequest, type NativeVoiceSettingsWitness } from './native-voice-settings';

export type NativeVoiceCaptureRequest = { version: 1; requestId: string; text: string; options: QuickCaptureOptions;
    recordedAt: string; attachment: Attachment | null; openAfterSave: boolean; applied: NativeCaptureCopilotApplied | null };
export type NativeVoiceCaptureResult = { kind: 'saved'; taskId: string; titleAtSave: string; generated: boolean; taskAtSave: Task };
export type NativeVoiceResultRequest = { version: 1; requestId: string; capture: NativeVoiceCaptureRequest; result: SpeechToTaskResult; at: string };
export type NativeVoiceResult = { taskId: string; outcome: 'applied' | 'discarded' | 'empty' | 'skipped' };
export type NativeVoiceBasis = { tasks: Array<{ id: string; projectId: string | null; order: number | null; orderNum: number | null }>;
    projects: Project[]; areas: AppData['areas']; sections: AppData['sections']; settings: AppSettings };
export type NativePreparedVoiceSettings = { version: 1; kind: 'settings'; request: NativeVoiceSettingsRequest };
export type NativePreparedVoiceCapture = { version: 3; kind: 'capture'; request: NativeVoiceCaptureRequest; capture: NativePreparedQuickCapture | NativePreparedQuickCaptureV2; task: Task };
export type NativePreparedVoiceResult = { version: 1; kind: 'result'; request: NativeVoiceResultRequest; initial: NativeVoiceCaptureResult;
    basis: NativeVoiceBasis; taskBefore: Task; taskAfter: Task; project: Project | null; outcome: 'applied' | 'discarded' };
export type NativeVoicePrepared = NativePreparedVoiceSettings | NativePreparedVoiceCapture | NativePreparedVoiceResult;
export type NativeVoiceRequest = NativeVoiceSettingsRequest | NativeVoiceCaptureRequest | NativeVoiceResultRequest;
export const NATIVE_VOICE_JOURNAL_BYTES = 2 * 1024 * 1024;

export function readNativeVoiceCaptureRequest(value: unknown): NativeVoiceCaptureRequest | null {
    if (!record(value) || !exact(value, ['version', 'requestId', 'text', 'options', 'recordedAt', 'attachment', 'openAfterSave', 'applied'])
        || !isNativeJsonWithinBytes(value, 128 * 1024) || value.version !== 1 || typeof value.requestId !== 'string'
        || !NATIVE_VOICE_UUID.test(value.requestId) || !nativeVoiceISO(value.recordedAt) || typeof value.openAfterSave !== 'boolean') return null;
    const capture = readNativeQuickCaptureInput({ text: value.text, options: value.options, captureId: value.requestId, openAfterSave: value.openAfterSave });
    if (!capture || capture.text.split(/\r?\n/).filter(line => line.trim()).length > 1) return null;
    const applied = value.applied === null ? null : readNativeCaptureCopilotApplied(value.applied);
    if (value.applied !== null && !applied) return null;
    const attachments = value.attachment === null ? [] : readNativeAttachments([value.attachment]);
    const attachment = attachments?.[0];
    if (!attachments || attachment && (!record(attachment) || !exact(attachment, ['id', 'kind', 'title', 'uri', 'mimeType', 'size', 'fileHash', 'localStatus', 'createdAt', 'updatedAt'])
        || attachment.kind !== 'file' || attachment.mimeType !== 'audio/mp4' || attachment.localStatus !== 'available'
        || typeof attachment.size !== 'number' || !Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > NATIVE_VOICE_MAX_AUDIO_BYTES
        || !attachment.fileHash || !/^[a-f0-9]{64}$/.test(attachment.fileHash) || !attachment.uri.startsWith('file:///'))) return null;
    return { version: 1, requestId: value.requestId, text: capture.text, options: capture.options, recordedAt: value.recordedAt,
        attachment: attachment ?? null, openAfterSave: value.openAfterSave, applied };
}
export function readNativeVoiceResultRequest(value: unknown): NativeVoiceResultRequest | null {
    if (!record(value) || !exact(value, ['version', 'requestId', 'capture', 'result', 'at']) || value.version !== 1
        || typeof value.requestId !== 'string' || !NATIVE_VOICE_UUID.test(value.requestId) || !nativeVoiceISO(value.at)
        || !isNativeJsonWithinBytes(value, 256 * 1024) || !record(value.result)) return null;
    const capture = readNativeVoiceCaptureRequest(value.capture), result = value.result;
    const textFields = ['transcript', 'title', 'description', 'dueDate', 'startTime', 'projectTitle', 'language'];
    if (!capture || capture.requestId === value.requestId || typeof result.transcript !== 'string'
        || Object.keys(result).some(field => ![...textFields, 'tags', 'contexts'].includes(field))
        || textFields.some(field => result[field] !== undefined && result[field] !== null
            && (typeof result[field] !== 'string' || (result[field] as string).length > (field === 'transcript' || field === 'description' ? 64000 : 4000)))
        || ['tags', 'contexts'].some(field => result[field] !== undefined && result[field] !== null && (!Array.isArray(result[field])
            || (result[field] as unknown[]).length > 1000 || !(result[field] as unknown[]).every(token => typeof token === 'string' && token.length <= 200)))) return null;
    return { version: 1, requestId: value.requestId, capture, result: { ...result } as SpeechToTaskResult, at: value.at };
}

const validTask = (value: unknown): value is Task => record(value) && typeof value.id === 'string' && validRawTask(value, value.id);
const pick = <T extends object>(value: T, fields: string[]) => Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(value, field))
    .map(field => [field, (value as Record<string, unknown>)[field]]));
/** Only container/order/mapping fields consulted by the deterministic late effect. */
export function nativeVoiceBasis(data: AppData): NativeVoiceBasis | null {
    const voice = nativeVoiceSettingsWitness(data.settings); if (!voice) return null;
    const settings: AppSettings = { deviceId: data.settings.deviceId,
        ai: { speechToText: { mode: voice.mode ?? 'smart_parse', fieldStrategy: voice.fieldStrategy ?? 'smart' } },
        gtd: data.settings.gtd?.defaultProjectFlowMode === undefined ? {} : { defaultProjectFlowMode: data.settings.gtd.defaultProjectFlowMode } };
    return JSON.parse(JSON.stringify({ tasks: data.tasks.map(task => ({ id: task.id, projectId: task.projectId ?? null,
        order: task.order ?? null, orderNum: task.orderNum ?? null })),
        projects: data.projects.map(project => pick(project, ['id', 'title', 'color', 'order', 'status', 'isSequential', 'flowMode', 'areaId', 'areaTitle',
            'createdAt', 'updatedAt', 'rev', 'revBy', 'deletedAt', 'purgedAt', 'cancelledAt', 'archivedAt'])),
        areas: (data.areas ?? []).map(area => pick(area, ['id', 'name', 'color', 'order', 'createdAt', 'updatedAt', 'rev', 'revBy', 'deletedAt'])),
        sections: (data.sections ?? []).map(section => pick(section, ['id', 'projectId', 'title', 'order', 'isSequential', 'createdAt', 'updatedAt', 'rev', 'revBy', 'deletedAt'])),
        settings })) as NativeVoiceBasis;
}
const safeGenerated = (request: NativeVoiceCaptureRequest) => request.applied === null && !request.text.trim() && !request.options.note.trim()
    && !request.options.dueDate && !request.options.startTime && !request.options.contexts.length && !request.options.projectId
    && !request.options.areaId && !request.options.priority && !request.options.focus;
export function readNativeVoiceCaptureResult(value: unknown, request: NativeVoiceCaptureRequest): NativeVoiceCaptureResult | null {
    if (!record(value) || !exact(value, ['kind', 'taskId', 'titleAtSave', 'generated', 'taskAtSave']) || value.kind !== 'saved'
        || value.taskId !== request.requestId || value.generated !== safeGenerated(request) || typeof value.titleAtSave !== 'string'
        || !validTask(value.taskAtSave) || value.taskAtSave.id !== request.requestId || value.taskAtSave.title !== value.titleAtSave
        || request.attachment && !value.taskAtSave.attachments?.some(attachment => taskEditValuesEqual(attachment, request.attachment))) return null;
    return { kind: 'saved', taskId: request.requestId, generated: value.generated, titleAtSave: value.titleAtSave, taskAtSave: value.taskAtSave };
}
export const nativeVoiceCaptureResult = (prepared: NativePreparedVoiceCapture): NativeVoiceCaptureResult => ({ kind: 'saved', taskId: prepared.task.id,
    titleAtSave: prepared.task.title, generated: safeGenerated(prepared.request), taskAtSave: prepared.task });

export function planNativeVoiceSpeechResult(request: NativeVoiceResultRequest, initial: NativeVoiceCaptureResult, taskBefore: Task,
    basis: NativeVoiceBasis): { taskAfter: Task; project: Project | null; outcome: 'applied' | 'discarded' } | { outcome: 'empty' | 'skipped' } {
    if (initial.taskId !== request.capture.requestId || taskBefore.id !== initial.taskId || taskBefore.deletedAt || taskBefore.purgedAt
        || taskBefore.status === 'reference' || isStatusListTaskReadOnly(taskBefore, basis.projects)) return { outcome: 'skipped' };
    const plan = buildTaskUpdatesFromSpeechResult(taskBefore, request.result, basis.settings);
    if (taskBefore.title !== initial.titleAtSave) delete plan.updates.title;
    if (!Object.keys(plan.updates).length && !plan.suggestedProjectTitle) {
        if (!initial.generated || !safeGenerated(request.capture) || !sameTaskSqliteRow(taskBefore, initial.taskAtSave)) return { outcome: 'empty' };
        return { taskAfter: { ...taskBefore, deletedAt: request.at, updatedAt: request.at, rev: nextRevision(taskBefore.rev),
            revBy: basis.settings.deviceId }, project: null, outcome: 'discarded' };
    }
    const deviceId = basis.settings.deviceId; if (!deviceId) throw new Error('Voice result needs the saved capture device');
    let project: Project | null = null;
    if (plan.suggestedProjectTitle && !taskBefore.projectId) {
        const targetAreaId = plan.updates.areaId ?? taskBefore.areaId;
        const match = findSelectableProjectByTitleAndArea(basis.projects, plan.suggestedProjectTitle, targetAreaId);
        if (match) plan.updates.projectId = match.id;
        else {
            project = buildNewProject({ title: plan.suggestedProjectTitle, color: DEFAULT_PROJECT_COLOR,
                id: requestRowId(request.requestId, 'speech-project'), initialProps: targetAreaId ? { areaId: targetAreaId } : undefined,
                existingProjects: basis.projects, existingAreas: basis.areas ?? [], settings: basis.settings, deviceId, now: request.at });
            plan.updates.projectId = project.id;
        }
    }
    const normalized = prepareTaskUpdatesForStore({ task: taskBefore, updates: plan.updates,
        allProjects: project ? [...basis.projects, project] : basis.projects, allSections: basis.sections, allAreas: basis.areas,
        settings: basis.settings, nowMs: Date.parse(request.at),
        projectOrderReserver: createProjectOrderReserver(basis.tasks.map(row => ({ ...row, projectId: row.projectId ?? undefined,
            order: row.order ?? undefined, orderNum: row.orderNum ?? undefined })) as Task[]) });
    if (!normalized.ok) throw new Error('Voice result destination changed');
    const { updatedTask, nextRecurringTask } = applyTaskUpdates(taskBefore, normalized.updates, request.at);
    if (nextRecurringTask) throw new Error('Voice result cannot create a recurrence');
    return { taskAfter: { ...updatedTask, rev: nextRevision(taskBefore.rev), revBy: deviceId }, project, outcome: 'applied' };
}

/** Metadata grammar and deterministic correspondence only; grants no storage/file authority. */
export function readNativeVoicePrepared(value: unknown): NativeVoicePrepared | null {
    if (!record(value) || !isNativeJsonWithinBytes(value, NATIVE_VOICE_JOURNAL_BYTES)) return null;
    if (value.kind === 'settings') {
        const request = readNativeVoiceSettingsRequest(value.request);
        return request && value.version === 1 && exact(value, ['version', 'kind', 'request']) ? { version: 1, kind: 'settings', request } : null;
    }
    if (value.kind === 'capture') {
        const request = readNativeVoiceCaptureRequest(value.request), capture = value.capture;
        if (!request || value.version !== 3 || !exact(value, ['version', 'kind', 'request', 'capture', 'task']) || !record(capture)
            || (capture.version !== 1 && capture.version !== 2) || !validTask(value.task) || !record(capture.task)) return null;
        const decoded = validatePreparedQuickCapture({ request: capture.request, prepared: capture });
        if (!decoded.ok) return null;
        const base = capture as unknown as NativePreparedQuickCapture | NativePreparedQuickCaptureV2;
        const inner = base.version === 2 ? base.request.capture : base.request;
        if (request.applied === null ? base.version !== 1
            : base.version !== 2 || !taskEditValuesEqual(base.request.applied, request.applied)) return null;
        const expected = { ...base.task, ...(request.attachment ? { attachments: [...(base.task.attachments ?? []), request.attachment] } : {}) };
        if (inner.captureId !== request.requestId || inner.openAfterSave !== request.openAfterSave
            || !taskEditValuesEqual(inner.options, request.options) || request.text.trim() && inner.text !== request.text
            || !request.text.trim() && inner.text !== base.task.title || !taskEditValuesEqual(value.task, expected)) return null;
        return { version: 3, kind: 'capture', request, capture: base, task: value.task as Task };
    }
    if (value.kind !== 'result' || value.version !== 1 || !exact(value, ['version', 'kind', 'request', 'initial', 'basis', 'taskBefore', 'taskAfter', 'project', 'outcome'])) return null;
    const request = readNativeVoiceResultRequest(value.request);
    if (!request || !record(value.initial) || !exact(value.initial, ['kind', 'taskId', 'titleAtSave', 'generated', 'taskAtSave'])
        || value.initial.kind !== 'saved' || typeof value.initial.titleAtSave !== 'string' || typeof value.initial.generated !== 'boolean'
        || !validTask(value.initial.taskAtSave) || value.initial.taskId !== request.capture.requestId
        || (value.initial.taskAtSave as Task).id !== value.initial.taskId || (value.initial.taskAtSave as Task).title !== value.initial.titleAtSave
        || !validTask(value.taskBefore) || !validTask(value.taskAfter) || !record(value.basis)
        || !exact(value.basis, ['tasks', 'projects', 'areas', 'sections', 'settings'])) return null;
    try {
        const basis = value.basis as unknown as NativeVoiceBasis;
        // Reprojection rejects hidden settings/paths and malformed context before planning.
        const replayBasis = nativeVoiceBasis({ ...basis, tasks: basis.tasks as unknown as Task[] });
        if (!replayBasis || !taskEditValuesEqual(replayBasis, basis)) return null;
        const initial = value.initial as unknown as NativeVoiceCaptureResult;
        const plan = planNativeVoiceSpeechResult(request, initial, value.taskBefore as Task, basis);
        if (!('taskAfter' in plan) || !taskEditValuesEqual(plan.taskAfter, value.taskAfter)
            || !taskEditValuesEqual(plan.project, value.project) || plan.outcome !== value.outcome) return null;
        return { version: 1, kind: 'result', request, initial, basis, taskBefore: value.taskBefore as Task,
            taskAfter: value.taskAfter as Task, project: plan.project, outcome: plan.outcome };
    } catch { return null; }
}
export const nativeVoicePreparedWitness = (settings: AppSettings, expected: NativeVoiceSettingsWitness): boolean =>
    taskEditValuesEqual(nativeVoiceSettingsWitness(settings), expected);
export const nativeVoiceRawTask = (task: Task): Task | null => rawReadTaskSnapshot(task);
