import { normalizeClockTimeInput } from './date';
import { FOCUS_TASK_LIMIT_OPTIONS } from './focus-utils';
import { buildGtdSettingsModel, buildGtdSettingsUpdate, GTD_AUTO_ARCHIVE_DAY_OPTIONS,
    GTD_DEFAULT_AREA_ACTIVE_OPTION, isGtdSettingStored, readGtdTaskOpenMode, resolveTaskOpenTab, resolveGtdPomodoroDurations,
    type GtdSettingsEdit, type GtdSettingsModel } from './gtd-settings-model';
import { strToU8 } from 'fflate';
import type { PomodoroDurations } from './pomodoro';
import { taskEditValuesEqual } from './json-value-equality';
import { DEFAULT_TASK_EDITOR_ORDER, TASK_EDITOR_SECTIONABLE_FIELDS, TASK_EDITOR_SECTION_ORDER } from './task-editor-layout';
import { compareAreasByOrder } from './task-utils';
import { revisionsToken } from './native-request-receipts';
import { readAreaDurableData, createAreaSaveGuard } from './native-host-contract-area-durable';
import type { NativeHostResult } from './native-host-contract';
import { detach, exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { validRawTask } from './native-host-contract-task-save';
import { useTaskStore } from './store';
import { gtdArchiveEffects, gtdWorkflowNestedPath, gtdWorkflowWitness, timestampAtLeastAfter,
    gtdWorkflowTargetArea, gtdWorkflowTaskEditorSelected, gtdWorkflowPresetSelected,
    gtdWorkflowSettingsEdit, gtdWorkflowPomodoroField,
    type GtdWorkflowPomodoroType, type GtdWorkflowPomodoroBooleanType,
    type GtdWorkflowPomodoroWitness, type GtdWorkflowPomodoroDurationsWitness,
    type GtdWorkflowType, type GtdWorkflowDirectType, type GtdWorkflowReviewType, type GtdWorkflowInboxType,
    type GtdWorkflowCaptureParseType, type GtdWorkflowCaptureParseWitness,
    type GtdWorkflowTaskEditorSection, type GtdWorkflowTaskEditorWitness, type GtdWorkflowTaskEditorSelected,
    type GtdWorkflowPresetWitness, type GtdWorkflowPresetSelected,
    type GtdWorkflowWitness, type GtdWorkflowDirectWitness,
    type GtdWorkflowReviewWitness, type GtdWorkflowInboxWitness,
    type GtdWorkflowAreaWitness, type GtdWorkflowTargetArea, type GtdArchiveEffect } from './store-settings';
import { ensureDeviceId } from './store-helpers';
import type { AppData, AppSettings, Area, TaskEditorFieldId, TaskEditorSectionId } from './types';

export type { GtdWorkflowType, GtdWorkflowWitness } from './store-settings';
export type GtdWorkflowEdit = Extract<GtdSettingsEdit,
    { type: GtdWorkflowDirectType | 'defaultArea' | 'taskEditorSectionOpen'
        | 'taskEditorPreset' | 'taskEditorFieldVisible' | 'taskEditorFieldSection' | 'taskEditorReset' }>
    | { type: 'taskEditorOrder'; field: TaskEditorFieldId; value: TaskEditorFieldId[] }
    | { type: 'focusIncludeStartDates'; value: boolean }
    | { type: GtdWorkflowReviewType | GtdWorkflowInboxType | GtdWorkflowCaptureParseType; value: boolean }
    | { type: GtdWorkflowPomodoroBooleanType; value: boolean }
    | { type: 'pomodoroDurations'; value: PomodoroDurations };
export type NativeGtdWorkflowRequest = { requestId: string; edit: GtdWorkflowEdit;
    expected: GtdWorkflowWitness };
export type NativeGtdWorkflowResult = { type: Exclude<GtdWorkflowType,
    'taskEditorSectionOpen' | 'taskEditorFieldVisible' | 'taskEditorFieldSection' | 'taskEditorOrder'
        | 'taskEditorReset' | 'pomodoroDurations'>;
    value: string | number | boolean; changed: boolean }
    | { type: 'taskEditorSectionOpen'; section: GtdWorkflowTaskEditorSection; value: boolean; changed: boolean }
    | { type: 'taskEditorFieldVisible'; field: TaskEditorFieldId; value: boolean; changed: boolean }
    | { type: 'taskEditorFieldSection'; field: TaskEditorFieldId; value: TaskEditorSectionId; changed: boolean }
    | { type: 'taskEditorOrder'; field: TaskEditorFieldId; value: TaskEditorFieldId[]; changed: boolean }
    | { type: 'taskEditorReset'; changed: boolean }
    | { type: 'pomodoroDurations'; value: PomodoroDurations; changed: boolean };
export type NativePreparedGtdWorkflow = { version: 1; request: NativeGtdWorkflowRequest;
    preparedAt: string; deviceIdBefore: string | null; deviceIdToInitialize: string | null;
    after: { value?: string | number | boolean | TaskEditorFieldId[] | PomodoroDurations; stamp: string;
        selected?: GtdWorkflowTaskEditorSelected | GtdWorkflowPresetSelected }; result: NativeGtdWorkflowResult;
    targetArea?: GtdWorkflowTargetArea | null; archiveEffects?: GtdArchiveEffect[] };
export type NativeGtdWorkflowOptions = { hub: GtdSettingsModel['hub'];
    expected: Record<Exclude<GtdWorkflowDirectType, 'autoArchiveDays'>, GtdWorkflowDirectWitness>
        & { pomodoro: GtdWorkflowReviewWitness | null } };
export type NativeGtdPomodoroOptions = { pomodoro: GtdSettingsModel['pomodoro']; expected: {
    pomodoro: GtdWorkflowReviewWitness | null;
    pomodoroDurations: GtdWorkflowPomodoroDurationsWitness | null;
} & Record<Exclude<GtdWorkflowPomodoroBooleanType, 'pomodoro'>, GtdWorkflowPomodoroWitness | null> };
export type NativeGtdArchiveOptions = { archive: GtdSettingsModel['archive']; expected: GtdWorkflowDirectWitness };
export type NativeGtdReviewOptions = { review: GtdSettingsModel['review'];
    expected: Record<GtdWorkflowReviewType, GtdWorkflowReviewWitness> };
export type NativeGtdInboxOptions = { inbox: GtdSettingsModel['inbox'];
    expected: Record<GtdWorkflowInboxType, GtdWorkflowInboxWitness> };
export type NativeGtdCaptureParseOptions = { capture: Pick<GtdSettingsModel['capture'],
    'title' | 'description' | 'quickAddAutoClean' | 'naturalLanguageDates'>;
    expected: Record<GtdWorkflowCaptureParseType, GtdWorkflowCaptureParseWitness> };
export type NativeGtdTaskEditorOpenOptions = { taskEditor: { title: string; description: string;
    groups: { id: GtdWorkflowTaskEditorSection; title: string;
        defaultOpen: NonNullable<GtdSettingsModel['taskEditor']['groups'][number]['defaultOpen']> }[] };
    expected: Record<GtdWorkflowTaskEditorSection, GtdWorkflowTaskEditorWitness> };
export type NativeGtdTaskEditorPresetOptions = { taskEditor: { title: string; description: string;
    openMode: GtdSettingsModel['taskEditor']['openMode'];
    presets: GtdSettingsModel['taskEditor']['presets']; reset: GtdSettingsModel['taskEditor']['reset'] };
    expected: GtdWorkflowPresetWitness };
export type NativeGtdTaskEditorFieldOptions = { taskEditor: { title: string; description: string;
    initiallyExpanded: GtdSettingsModel['taskEditor']['initiallyExpanded'];
    expandedResetKey: GtdSettingsModel['taskEditor']['expandedResetKey'];
    groups: { id: GtdSettingsModel['taskEditor']['groups'][number]['id']; title: string; count: number;
        fields: (Pick<GtdSettingsModel['taskEditor']['groups'][number]['fields'][number],
            'id' | 'label' | 'visible' | 'status' | 'visibility'> & { sheet: Pick<
                GtdSettingsModel['taskEditor']['groups'][number]['fields'][number]['sheet'],
                'title' | 'section' | 'visible' | 'sections' | 'order' | 'doneLabel'> })[] }[] };
    expected: GtdWorkflowPresetWitness };
export type NativeGtdCaptureAreaOptions = { capture: Pick<GtdSettingsModel['capture'], 'title' | 'description' | 'defaultArea'>;
    expected: GtdWorkflowAreaWitness; offset: number; total: number; revision: string };
export type NativeGtdWorkflowPreparation = { kind: 'noop'; result: NativeGtdWorkflowResult }
    | { kind: 'prepared'; prepared: NativePreparedGtdWorkflow };
export type NativeGtdWorkflowDraft = { valid: true; value: string | PomodoroDurations } | { valid: false; value: null };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TYPES: Exclude<GtdWorkflowDirectType, 'autoArchiveDays'>[] =
    ['defaultScheduleTime', 'focusTaskLimit', 'focusIncludeStartDates', 'defaultProjectFlowMode'];
const POMODORO_TYPES: GtdWorkflowPomodoroType[] = ['pomodoro', 'pomodoroLinkTask', 'pomodoroAutoStartBreaks',
    'pomodoroAutoStartFocus', 'pomodoroCompletionAlert', 'pomodoroDurations'];
const isPomodoro = (type: GtdWorkflowType): type is GtdWorkflowPomodoroType => POMODORO_TYPES.includes(type as GtdWorkflowPomodoroType);
const REVIEW_TYPES: GtdWorkflowReviewType[] = ['dailyReviewFocusStep', 'weeklyReviewContextStep'];
const INBOX_TYPES: GtdWorkflowInboxType[] = ['inboxTwoMinute', 'inboxProjectFirst', 'inboxContextStep', 'inboxSchedule'];
const CAPTURE_PARSE_TYPES: GtdWorkflowCaptureParseType[] = ['quickAddAutoClean', 'naturalLanguageDates'];
const TASK_EDITOR_SECTIONS: GtdWorkflowTaskEditorSection[] = ['scheduling', 'organization', 'details'];
const isReview = (type: GtdWorkflowType): type is GtdWorkflowReviewType =>
    type === 'dailyReviewFocusStep' || type === 'weeklyReviewContextStep';
const isInbox = (type: GtdWorkflowType): type is GtdWorkflowInboxType =>
    type === 'inboxTwoMinute' || type === 'inboxProjectFirst'
        || type === 'inboxContextStep' || type === 'inboxSchedule';
const isNested = (type: GtdWorkflowType): type is GtdWorkflowReviewType | GtdWorkflowInboxType =>
    isReview(type) || isInbox(type);
const isCaptureParse = (type: GtdWorkflowType): type is GtdWorkflowCaptureParseType =>
    type === 'quickAddAutoClean' || type === 'naturalLanguageDates';
const isTaskEditor = (type: GtdWorkflowType): type is 'taskEditorSectionOpen' => type === 'taskEditorSectionOpen';
const isPreset = (type: GtdWorkflowType): type is 'taskEditorPreset' => type === 'taskEditorPreset';
const isField = (type: GtdWorkflowType): type is 'taskEditorFieldVisible' => type === 'taskEditorFieldVisible';
const isFieldSection = (type: GtdWorkflowType): type is 'taskEditorFieldSection' => type === 'taskEditorFieldSection';
const isOrder = (type: GtdWorkflowType): type is 'taskEditorOrder' => type === 'taskEditorOrder';
const isReset = (type: GtdWorkflowType): type is 'taskEditorReset' => type === 'taskEditorReset';
const isLayout = (type: GtdWorkflowType): type is 'taskEditorPreset' | 'taskEditorFieldVisible'
    | 'taskEditorFieldSection' | 'taskEditorOrder' | 'taskEditorReset' => isPreset(type) || isField(type)
        || isFieldSection(type) || isOrder(type) || isReset(type);
const isTaskEditorEdit = (edit: GtdWorkflowEdit): edit is Extract<GtdWorkflowEdit, { type: 'taskEditorSectionOpen' }> =>
    edit.type === 'taskEditorSectionOpen';
const same = taskEditValuesEqual;
const bounded = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const iso = (value: unknown): value is string => bounded(value, 40)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const fullOrder = (value: unknown): value is TaskEditorFieldId[] => Array.isArray(value)
    && value.length === DEFAULT_TASK_EDITOR_ORDER.length
    && new Set(value).size === DEFAULT_TASK_EDITOR_ORDER.length
    && value.every((field) => DEFAULT_TASK_EDITOR_ORDER.includes(field));

const validDurations = (value: unknown): value is PomodoroDurations => record(value)
    && exact(value, ['focusMinutes', 'breakMinutes'])
    && [value.focusMinutes, value.breakMinutes].every((minutes) => typeof minutes === 'number'
        && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 180);

const validEdit = (value: unknown): value is GtdWorkflowEdit => {
    if (!record(value) || !exact(value, value.type === 'taskEditorReset' ? ['type']
        : value.type === 'taskEditorSectionOpen'
        ? ['type', 'section', 'value'] : value.type === 'taskEditorFieldVisible'
            || value.type === 'taskEditorFieldSection' || value.type === 'taskEditorOrder'
        ? ['type', 'field', 'value'] : ['type', 'value'])) return false;
    switch (value.type) {
        case 'defaultScheduleTime':
            return bounded(value.value, 50) && normalizeClockTimeInput(value.value) === value.value;
        case 'focusTaskLimit':
            return FOCUS_TASK_LIMIT_OPTIONS.includes(value.value as never);
        case 'autoArchiveDays':
            return GTD_AUTO_ARCHIVE_DAY_OPTIONS.includes(value.value as never);
        case 'focusIncludeStartDates':
            return typeof value.value === 'boolean';
        case 'defaultProjectFlowMode':
            return value.value === 'parallel' || value.value === 'sequential';
        case 'defaultArea':
            return bounded(value.value);
        case 'taskEditorSectionOpen':
            return TASK_EDITOR_SECTIONS.includes(value.section as GtdWorkflowTaskEditorSection)
                && typeof value.value === 'boolean';
        case 'taskEditorPreset': return value.value === 'simple' || value.value === 'standard' || value.value === 'full';
        case 'taskEditorFieldVisible':
            return DEFAULT_TASK_EDITOR_ORDER.includes(value.field as TaskEditorFieldId)
                && typeof value.value === 'boolean';
        case 'taskEditorFieldSection':
            return TASK_EDITOR_SECTIONABLE_FIELDS.includes(value.field as TaskEditorFieldId)
                && TASK_EDITOR_SECTION_ORDER.includes(value.value as TaskEditorSectionId);
        case 'taskEditorOrder':
            return DEFAULT_TASK_EDITOR_ORDER.includes(value.field as TaskEditorFieldId) && fullOrder(value.value);
        case 'taskEditorReset': return true;
        case 'pomodoroDurations': return validDurations(value.value);
        case 'pomodoro':
        case 'pomodoroLinkTask':
        case 'pomodoroAutoStartBreaks':
        case 'pomodoroAutoStartFocus':
        case 'pomodoroCompletionAlert':
        case 'dailyReviewFocusStep':
        case 'weeklyReviewContextStep':
        case 'inboxTwoMinute':
        case 'inboxProjectFirst':
        case 'inboxContextStep':
        case 'inboxSchedule':
        case 'quickAddAutoClean':
        case 'naturalLanguageDates':
            return typeof value.value === 'boolean';
        default: return false;
    }
};

const validWitness = (value: unknown, type: GtdWorkflowType): value is GtdWorkflowWitness =>
    isPomodoro(type) ? validPomodoroWitness(value, type) : isLayout(type) ? validPresetWitness(value) : record(value) && exact(value, type === 'defaultArea'
        ? ['modePresent', 'mode', 'idPresent', 'id', 'stampPresent', 'stamp'] : isNested(type)
        ? ['parentPresent', 'present', 'value', 'stampPresent', 'stamp']
        : isTaskEditor(type) ? ['taskEditorPresent', 'sectionOpenPresent', 'present', 'value', 'stampPresent', 'stamp']
        : ['present', 'value', 'stampPresent', 'stamp'])
    && typeof value.stampPresent === 'boolean'
    && (type === 'defaultArea'
        ? typeof value.modePresent === 'boolean' && typeof value.idPresent === 'boolean'
            && (value.modePresent ? value.mode === null || bounded(value.mode) : value.mode === null)
            && (value.idPresent ? value.id === null || bounded(value.id) : value.id === null)
        : typeof value.present === 'boolean'
    && (!isTaskEditor(type) || typeof value.taskEditorPresent === 'boolean'
        && typeof value.sectionOpenPresent === 'boolean'
        && (value.taskEditorPresent || !value.sectionOpenPresent)
        && (value.sectionOpenPresent || !value.present))
    && (!isNested(type) || typeof value.parentPresent === 'boolean'
        && (value.parentPresent || !value.present))
    && (value.present ? isNested(type) || isCaptureParse(type) || isTaskEditor(type) || type === 'focusIncludeStartDates'
        ? typeof value.value === 'boolean' : type === 'autoArchiveDays'
        ? typeof value.value === 'number' && Number.isFinite(value.value)
        : type === 'focusTaskLimit'
        ? typeof value.value === 'number' && Number.isSafeInteger(value.value) && Math.abs(value.value) <= 1_000_000
        : bounded(value.value) : value.value === null))
    && (value.stampPresent ? iso(value.stamp) : value.stamp === null);

const validTargetArea = (value: unknown): value is GtdWorkflowTargetArea => record(value)
    && exact(value, ['id', 'createdAt', 'updatedAt', 'revPresent', 'rev', 'revByPresent', 'revBy'])
    && bounded(value.id) && value.id.length > 0
    && bounded(value.createdAt) && value.createdAt.length > 0
    && bounded(value.updatedAt) && value.updatedAt.length > 0
    && typeof value.revPresent === 'boolean' && typeof value.revByPresent === 'boolean'
    && (value.revPresent ? typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0 : value.rev === null)
    && (value.revByPresent ? bounded(value.revBy) : value.revBy === null);

const readRequest = (input: unknown): NativeGtdWorkflowRequest | null => {
    if (!isNativeJsonWithinBytes(input, 8192)) return null;
    const request = detach<Record<string, unknown>>(input);
    return request && exact(request, ['requestId', 'edit', 'expected'])
        && typeof request.requestId === 'string' && UUID.test(request.requestId)
        && validEdit(request.edit) && validWitness(request.expected, request.edit.type)
        ? request as NativeGtdWorkflowRequest : null;
};

const plannedStamp = (preparedAt: string, witness: GtdWorkflowWitness) =>
    timestampAtLeastAfter(preparedAt, witness.stamp ?? undefined);
const settingsByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): AppSettings => {
    if (isPomodoro(edit.type)) {
        if (edit.type === 'pomodoro') {
            const raw = witness as GtdWorkflowReviewWitness;
            return { ...(raw.parentPresent ? { features: raw.present ? { pomodoro: raw.value } : {} } : {}) } as AppSettings;
        }
        const raw = witness as GtdWorkflowPomodoroWitness | GtdWorkflowPomodoroDurationsWitness;
        return { ...(raw.gate.featuresPresent ? { features: raw.gate.enabled.present
            ? { pomodoro: raw.gate.enabled.value } : {} } : {}),
            gtd: { ...(raw.parentPresent ? { pomodoro: raw.present
                ? { [gtdWorkflowPomodoroField(edit.type)]: raw.value } : {} } : {}) } } as AppSettings;
    }
    if (edit.type === 'defaultArea') {
        const pair = witness as GtdWorkflowAreaWitness;
        return { gtd: { ...(pair.modePresent ? { defaultAreaMode: pair.mode } : {}),
            ...(pair.idPresent ? { defaultAreaId: pair.id } : {}) } } as AppSettings;
    }
    if (isNested(edit.type)) {
        const { field, parent } = gtdWorkflowNestedPath(edit.type);
        const nested = witness as GtdWorkflowReviewWitness;
        return { gtd: { [parent]: nested.parentPresent
            ? (nested.present ? { [field]: nested.value } : {}) : undefined } } as AppSettings;
    }
    if (isTaskEditorEdit(edit)) {
        const selected = witness as GtdWorkflowTaskEditorWitness;
        return { gtd: { ...(selected.taskEditorPresent ? { taskEditor: selected.sectionOpenPresent
            ? { sectionOpen: selected.present ? { [edit.section]: selected.value } : {} } : {} } : {}) } } as AppSettings;
    }
    if (isLayout(edit.type)) {
        const preset = witness as GtdWorkflowPresetWitness;
        const layout = Object.fromEntries((['order', 'hidden', 'sections', 'sectionOpen'] as const)
            .flatMap((field) => preset[field].present ? [[field, preset[field].value]] : []));
        const features = Object.fromEntries((['priorities', 'timeEstimates'] as const)
            .flatMap((field) => preset[field].present ? [[field, preset[field].value]] : []));
        return { gtd: { ...(preset.taskEditorPresent ? { taskEditor: layout } : {}) },
            ...(preset.featuresPresent ? { features } : {}) } as AppSettings;
    }
    if (edit.type === 'quickAddAutoClean') {
        const scalar = witness as GtdWorkflowCaptureParseWitness;
        return { ...(scalar.present ? { quickAddAutoClean: scalar.value } : {}) } as AppSettings;
    }
    const direct = witness as GtdWorkflowDirectWitness | GtdWorkflowCaptureParseWitness;
    return { gtd: direct.present ? { [edit.type]: direct.value } : {} } as AppSettings;
};
const validPresetWitness = (value: unknown): value is GtdWorkflowPresetWitness => {
    if (!record(value) || !exact(value, ['taskEditorPresent', 'order', 'hidden', 'sections', 'sectionOpen',
        'featuresPresent', 'priorities', 'timeEstimates', 'stampPresent', 'stamp'])
        || typeof value.taskEditorPresent !== 'boolean' || typeof value.featuresPresent !== 'boolean'
        || typeof value.stampPresent !== 'boolean'
        || (value.stampPresent ? !iso(value.stamp) : value.stamp !== null)) return false;
    for (const field of ['order', 'hidden', 'sections', 'sectionOpen', 'priorities', 'timeEstimates']) {
        const raw = value[field];
        if (!record(raw) || !exact(raw, ['present', 'value']) || typeof raw.present !== 'boolean'
            || (!raw.present && raw.value !== null)) return false;
    }
    const projected = settingsByWitness({ type: 'taskEditorPreset', value: 'standard' }, value as GtdWorkflowPresetWitness);
    projected.syncPreferencesUpdatedAt = value.stampPresent ? { gtd: value.stamp as string } : {};
    return same(gtdWorkflowWitness(projected, 'taskEditorPreset'), value);
};
const validPomodoroWitness = (value: unknown, type: GtdWorkflowPomodoroType): value is GtdWorkflowWitness => {
    if (!record(value) || !exact(value, type === 'pomodoro'
        ? ['parentPresent', 'present', 'value', 'stampPresent', 'stamp']
        : ['parentPresent', 'present', 'value', 'gate', 'stampPresent', 'stamp'])
        || typeof value.parentPresent !== 'boolean' || typeof value.present !== 'boolean'
        || (!value.parentPresent && value.present) || (!value.present && value.value !== null)
        || typeof value.stampPresent !== 'boolean' || (value.stampPresent ? !iso(value.stamp) : value.stamp !== null)) return false;
    if (type !== 'pomodoro') {
        const gate = value.gate;
        if (!record(gate) || !exact(gate, ['featuresPresent', 'enabled']) || typeof gate.featuresPresent !== 'boolean'
            || !record(gate.enabled) || !exact(gate.enabled, ['present', 'value'])
            || typeof gate.enabled.present !== 'boolean' || (!gate.featuresPresent && gate.enabled.present)
            || (gate.enabled.present ? typeof gate.enabled.value !== 'boolean' : gate.enabled.value !== null)) return false;
    }
    const edit: GtdWorkflowEdit = type === 'pomodoroDurations'
        ? { type, value: { focusMinutes: 25, breakMinutes: 5 } } : { type, value: true };
    const settings = settingsByWitness(edit, value as GtdWorkflowWitness);
    settings.syncPreferencesUpdatedAt = value.stampPresent ? { gtd: value.stamp as string } : {};
    return same(gtdWorkflowWitness(settings, type), value);
};
const pomodoroOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness, allowNoop = false): boolean => {
    if (!isPomodoro(edit.type)) return true;
    const settings = settingsByWitness(edit, witness);
    const model = buildGtdSettingsModel({ settings, areas: [], taskOpenMode: 'automatic', t: (key) => key });
    if (edit.type !== 'pomodoro' && !model.pomodoro.controls) return false;
    if (edit.type === 'pomodoroDurations' || allowNoop && isGtdSettingStored(settings, gtdWorkflowSettingsEdit(edit))) return true;
    const offered = edit.type === 'pomodoro' ? model.hub.pomodoro.edit
        : model.pomodoro.controls![gtdWorkflowPomodoroField(edit.type) as 'linkTask' | 'autoStartBreaks' | 'autoStartFocus' | 'completionAlert'].edit;
    return same(offered, edit);
};
const storedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean =>
    isGtdSettingStored(settingsByWitness(edit, witness), gtdWorkflowSettingsEdit(edit));
const nestedOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean => {
    if (!isNested(edit.type)) return true;
    const model = buildGtdSettingsModel({ settings: settingsByWitness(edit, witness), areas: [],
        taskOpenMode: 'automatic', t: (key) => key });
    const offered = isReview(edit.type)
        ? edit.type === 'dailyReviewFocusStep' ? model.review.dailyFocusStep.edit : model.review.weeklyContextStep.edit
        : edit.type === 'inboxTwoMinute' ? model.inbox.twoMinute.edit
            : edit.type === 'inboxProjectFirst' ? model.inbox.projectFirst.edit
                : edit.type === 'inboxContextStep' ? model.inbox.contextStep.edit : model.inbox.schedule.edit;
    return same(offered, edit);
};
const captureParseOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean => {
    if (!isCaptureParse(edit.type)) return true;
    const model = buildGtdSettingsModel({ settings: settingsByWitness(edit, witness), areas: [],
        taskOpenMode: 'automatic', t: (key) => key });
    return same(model.capture[edit.type].edit, edit);
};
const focusStartDatesOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean => {
    if (edit.type !== 'focusIncludeStartDates') return true;
    const model = buildGtdSettingsModel({ settings: settingsByWitness(edit, witness), areas: [],
        taskOpenMode: 'automatic', t: (key) => key });
    return same(model.hub.focusIncludeStartDates.edit, edit);
};
const taskEditorSelectedAfter = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): GtdWorkflowTaskEditorSelected | null => {
    if (!isTaskEditorEdit(edit)) return null;
    const settings = settingsByWitness(edit, witness);
    const update = buildGtdSettingsUpdate(settings, gtdWorkflowSettingsEdit(edit));
    const after = update && gtdWorkflowWitness({ ...settings, ...update }, edit.type, edit.section);
    return after ? gtdWorkflowTaskEditorSelected(after) : null;
};
const taskEditorOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean => {
    if (!isTaskEditorEdit(edit)) return true;
    const model = buildGtdSettingsModel({ settings: settingsByWitness(edit, witness), areas: [],
        taskOpenMode: 'automatic', t: (key) => key });
    return same(model.taskEditor.groups.find((group) => group.id === edit.section)?.defaultOpen?.edit, edit);
};
const presetSelectedAfter = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): GtdWorkflowPresetSelected | null => {
    if (!isLayout(edit.type)) return null;
    const settings = settingsByWitness(edit, witness);
    const update = buildGtdSettingsUpdate(settings, gtdWorkflowSettingsEdit(edit));
    const after = update && gtdWorkflowWitness({ ...settings, ...update }, 'taskEditorPreset');
    return after ? gtdWorkflowPresetSelected(after) : null;
};
const presetOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean => {
    if (edit.type !== 'taskEditorPreset') return true;
    const model = buildGtdSettingsModel({ settings: settingsByWitness(edit, witness), areas: [],
        taskOpenMode: 'automatic', t: (key) => key });
    return model.taskEditor.presets.options.some((option) => same(option.edit, edit));
};
const fieldOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean => {
    if (edit.type !== 'taskEditorFieldVisible' && edit.type !== 'taskEditorFieldSection') return true;
    const model = buildGtdSettingsModel({ settings: settingsByWitness(edit, witness), areas: [],
        taskOpenMode: 'automatic', t: (key) => key });
    const row = model.taskEditor.groups.flatMap((group) => group.fields)
        .find((field) => field.id === edit.field);
    return edit.type === 'taskEditorFieldVisible' ? same(row?.visibility.edit, edit)
        : !!row?.sheet.sections?.options.some((option) => same(option.edit, edit));
};
const orderOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean => {
    if (edit.type !== 'taskEditorOrder') return true;
    const model = buildGtdSettingsModel({ settings: settingsByWitness(edit, witness), areas: [],
        taskOpenMode: 'automatic', t: (key) => key });
    const row = model.taskEditor.groups.flatMap((group) => group.fields)
        .find((field) => field.id === edit.field);
    const sharedEdit = { type: edit.type, value: edit.value };
    return !!row && [row.sheet.order.moveUp, row.sheet.order.moveDown]
        .some((move) => !move.disabled && same(move.edit, sharedEdit));
};
const resetOfferedByWitness = (edit: GtdWorkflowEdit, witness: GtdWorkflowWitness): boolean => {
    if (edit.type !== 'taskEditorReset') return true;
    const model = buildGtdSettingsModel({ settings: settingsByWitness(edit, witness), areas: [],
        taskOpenMode: 'automatic', t: (key) => key });
    return same(model.taskEditor.reset.edit, edit);
};

const validArchiveEffects = (request: NativeGtdWorkflowRequest, prepared: Record<string, unknown>): boolean => {
    if (request.edit.type !== 'autoArchiveDays') return prepared.archiveEffects === undefined;
    if (!Array.isArray(prepared.archiveEffects) || !iso(prepared.preparedAt)) return false;
    const settings = settingsByWitness(request.edit, request.expected);
    const update = buildGtdSettingsUpdate(settings, gtdWorkflowSettingsEdit(request.edit));
    if (!update) return false;
    const afterSettings = { ...settings, ...update };
    const deviceId = prepared.deviceIdBefore ?? prepared.deviceIdToInitialize;
    if (typeof deviceId !== 'string') return false;
    const ids = new Set<string>();
    for (const value of prepared.archiveEffects) {
        if (!record(value) || !exact(value, ['before', 'after']) || !record(value.before)
            || !bounded(value.before.id) || !value.before.id
            || !validRawTask(value.before, value.before.id) || !validRawTask(value.after, value.before.id)
            || ids.has(value.before.id)) return false;
        ids.add(value.before.id);
        try {
            const projected = gtdArchiveEffects([value.before], afterSettings, prepared.preparedAt, deviceId);
            if (projected.length !== 1 || !same(projected[0].after, value.after)) return false;
        } catch { return false; }
    }
    return true;
};

/** Pure validation of the frozen edit and its scalar/group receipt before storage opens. */
const readPrepared = (input: unknown): NativePreparedGtdWorkflow | null => {
    if (!isNativeJsonWithinBytes(input, 2_000_000)) return null;
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const prepared = envelope.prepared;
    if (!request || request.edit.type !== 'autoArchiveDays' && !isNativeJsonWithinBytes(input, 8192)
        || !exact(prepared, request.edit.type === 'defaultArea'
        ? ['version', 'request', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'after', 'result', 'targetArea']
        : request.edit.type === 'autoArchiveDays'
        ? ['version', 'request', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'after', 'result', 'archiveEffects']
        : ['version', 'request', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'after', 'result']) || prepared.version !== 1
        || !same(prepared.request, request) || !iso(prepared.preparedAt)
        || !(prepared.deviceIdBefore === null || bounded(prepared.deviceIdBefore) && Boolean(prepared.deviceIdBefore))
        || (prepared.deviceIdBefore === null ? !UUID.test(String(prepared.deviceIdToInitialize))
            : prepared.deviceIdToInitialize !== null)
        || !record(prepared.after) || !exact(prepared.after, isReset(request.edit.type)
            ? ['stamp', 'selected'] : isTaskEditorEdit(request.edit) || isLayout(request.edit.type)
            ? ['value', 'stamp', 'selected'] : ['value', 'stamp'])
        || request.edit.type !== 'taskEditorReset' && !same(prepared.after.value, request.edit.value)
        || prepared.after.stamp !== plannedStamp(prepared.preparedAt, request.expected)
        || isTaskEditorEdit(request.edit) && (!record(prepared.after.selected)
            || !exact(prepared.after.selected, ['taskEditorPresent', 'sectionOpenPresent', 'present', 'value'])
            || !same(prepared.after.selected, taskEditorSelectedAfter(request.edit, request.expected)))
        || isLayout(request.edit.type) && (!record(prepared.after.selected)
            || !exact(prepared.after.selected, ['taskEditorPresent', 'order', 'hidden', 'sections', 'sectionOpen',
                'featuresPresent', 'priorities', 'timeEstimates'])
            || !same(prepared.after.selected, presetSelectedAfter(request.edit, request.expected)))
        || !record(prepared.result) || !exact(prepared.result, isReset(request.edit.type)
            ? ['type', 'changed'] : isTaskEditorEdit(request.edit)
            ? ['type', 'section', 'value', 'changed'] : isField(request.edit.type) || isFieldSection(request.edit.type)
                || isOrder(request.edit.type)
            ? ['type', 'field', 'value', 'changed'] : ['type', 'value', 'changed'])
        || !same(prepared.result, request.edit.type === 'taskEditorReset'
            ? { type: request.edit.type, changed: true } : isTaskEditorEdit(request.edit)
            ? { type: request.edit.type, section: request.edit.section, value: request.edit.value, changed: true }
            : request.edit.type === 'taskEditorFieldVisible' || request.edit.type === 'taskEditorFieldSection'
                || request.edit.type === 'taskEditorOrder'
            ? { type: request.edit.type, field: request.edit.field, value: request.edit.value, changed: true }
            : { type: request.edit.type, value: request.edit.value, changed: true })
        || storedByWitness(request.edit, request.expected)
        || !pomodoroOfferedByWitness(request.edit, request.expected)
        || !nestedOfferedByWitness(request.edit, request.expected)
        || !captureParseOfferedByWitness(request.edit, request.expected)
        || !focusStartDatesOfferedByWitness(request.edit, request.expected)
        || !taskEditorOfferedByWitness(request.edit, request.expected)
        || !presetOfferedByWitness(request.edit, request.expected)
        || !fieldOfferedByWitness(request.edit, request.expected)
        || !orderOfferedByWitness(request.edit, request.expected)
        || !resetOfferedByWitness(request.edit, request.expected)
        || !validArchiveEffects(request, prepared)
        || request.edit.type === 'defaultArea' && (request.edit.value === ''
            || request.edit.value === GTD_DEFAULT_AREA_ACTIVE_OPTION
            ? prepared.targetArea !== null
            : !validTargetArea(prepared.targetArea) || prepared.targetArea.id !== request.edit.value)) return null;
    return prepared as NativePreparedGtdWorkflow;
};

export function createGtdWorkflowMethods(deps: { readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>; t: () => (key: string) => string }) {
    const saves = createAreaSaveGuard(deps.save);
    const resultFor = (edit: GtdWorkflowEdit, changed: boolean): NativeGtdWorkflowResult =>
        edit.type === 'pomodoroDurations' ? { type: edit.type, value: edit.value, changed }
            : edit.type === 'taskEditorReset' ? { type: edit.type, changed }
            : isTaskEditorEdit(edit) ? { type: edit.type, section: edit.section, value: edit.value, changed }
            : edit.type === 'taskEditorFieldVisible'
                ? { type: edit.type, field: edit.field, value: edit.value, changed }
                : edit.type === 'taskEditorFieldSection'
                    ? { type: edit.type, field: edit.field, value: edit.value, changed }
                : edit.type === 'taskEditorOrder'
                    ? { type: edit.type, field: edit.field, value: edit.value, changed }
            : { type: edit.type, value: edit.value, changed };
    const hubFor = (data: AppData): GtdSettingsModel['hub'] => {
        // The full shared model also builds six unavailable subpages. Keep their
        // malformed legacy siblings out of this hub-only display projection;
        // the raw saved Settings object remains the write authority.
        const gtd = data.settings.gtd;
        const display = { ...data.settings, gtd: { defaultScheduleTime: gtd?.defaultScheduleTime,
            focusTaskLimit: gtd?.focusTaskLimit, focusIncludeStartDates: gtd?.focusIncludeStartDates,
            defaultProjectFlowMode: gtd?.defaultProjectFlowMode } };
        return buildGtdSettingsModel({ settings: display, areas: [],
            taskOpenMode: 'automatic', t: deps.t() }).hub;
    };
    const pomodoroFor = (data: AppData): GtdSettingsModel['pomodoro'] => {
        const raw = data.settings.gtd?.pomodoro;
        const features = data.settings.features;
        // Display only selected inputs; unsupported raw cells stay untouched and
        // their null witnesses disable edits rather than silently repairing them.
        const display = { features: { pomodoro: features?.pomodoro === true }, gtd: { pomodoro: {
            linkTask: raw?.linkTask === true, autoStartBreaks: raw?.autoStartBreaks === true,
            autoStartFocus: raw?.autoStartFocus === true, completionAlert: raw?.completionAlert !== false,
            customDurations: raw?.customDurations,
        } } };
        return buildGtdSettingsModel({ settings: display, areas: [], taskOpenMode: 'automatic', t: deps.t() }).pomodoro;
    };
    const archiveFor = (data: AppData): GtdSettingsModel['archive'] => {
        const display = { gtd: { autoArchiveDays: data.settings.gtd?.autoArchiveDays } } as AppSettings;
        return buildGtdSettingsModel({ settings: display, areas: [],
            taskOpenMode: 'automatic', t: deps.t() }).archive;
    };
    const reviewFor = (data: AppData): GtdSettingsModel['review'] => {
        // Only the two Review fields are display inputs; other legacy GTD
        // subpages stay out of this read while raw Settings remains authority.
        const gtd = data.settings.gtd;
        const display = { ...data.settings, gtd: {
            dailyReview: { includeFocusStep: gtd?.dailyReview?.includeFocusStep },
            weeklyReview: { includeContextStep: gtd?.weeklyReview?.includeContextStep },
        } };
        return buildGtdSettingsModel({ settings: display, areas: [],
            taskOpenMode: 'automatic', t: deps.t() }).review;
    };
    const inboxFor = (data: AppData): GtdSettingsModel['inbox'] => {
        const inbox = data.settings.gtd?.inboxProcessing;
        const display = { ...data.settings, gtd: { inboxProcessing: {
            twoMinuteEnabled: inbox?.twoMinuteEnabled, projectFirst: inbox?.projectFirst,
            contextStepEnabled: inbox?.contextStepEnabled, scheduleEnabled: inbox?.scheduleEnabled,
        } } };
        return buildGtdSettingsModel({ settings: display, areas: [],
            taskOpenMode: 'automatic', t: deps.t() }).inbox;
    };
    const captureParseFor = (data: AppData): NativeGtdCaptureParseOptions['capture'] => {
        const gtd = data.settings.gtd;
        const display = { quickAddAutoClean: data.settings.quickAddAutoClean,
            gtd: { naturalLanguageDates: gtd?.naturalLanguageDates } } as AppSettings;
        const capture = buildGtdSettingsModel({ settings: display, areas: [],
            taskOpenMode: 'automatic', t: deps.t() }).capture;
        return { title: capture.title, description: capture.description,
            quickAddAutoClean: capture.quickAddAutoClean,
            naturalLanguageDates: capture.naturalLanguageDates };
    };
    const taskEditorOpenFor = (expected: NativeGtdTaskEditorOpenOptions['expected']): NativeGtdTaskEditorOpenOptions['taskEditor'] => {
        const sectionOpen = Object.fromEntries(TASK_EDITOR_SECTIONS.flatMap((section) =>
            expected[section].present ? [[section, expected[section].value]] : []));
        const model = buildGtdSettingsModel({ settings: { gtd: { taskEditor: { sectionOpen } } } as AppSettings,
            areas: [], taskOpenMode: 'automatic', t: deps.t() }).taskEditor;
        return { title: model.title, description: model.description,
            groups: TASK_EDITOR_SECTIONS.map((id) => {
                const group = model.groups.find((entry) => entry.id === id);
                return { id, title: group!.title, defaultOpen: group!.defaultOpen! };
            }) };
    };
    const taskEditorPresetFor = (expected: GtdWorkflowPresetWitness, rawMode: string | null): NativeGtdTaskEditorPresetOptions['taskEditor'] => {
        const model = buildGtdSettingsModel({ settings: settingsByWitness(
            { type: 'taskEditorPreset', value: 'standard' }, expected), areas: [],
        taskOpenMode: readGtdTaskOpenMode(rawMode), t: deps.t() }).taskEditor;
        return { title: model.title, description: model.description, openMode: model.openMode, presets: model.presets,
            reset: model.reset };
    };
    const taskEditorFieldFor = (expected: GtdWorkflowPresetWitness): NativeGtdTaskEditorFieldOptions['taskEditor'] => {
        const model = buildGtdSettingsModel({ settings: settingsByWitness(
            { type: 'taskEditorFieldVisible', field: 'description', value: false }, expected), areas: [],
        taskOpenMode: 'automatic', t: deps.t() }).taskEditor;
        return { title: model.title, description: model.description,
            initiallyExpanded: model.initiallyExpanded, expandedResetKey: model.expandedResetKey,
            groups: model.groups.map((group) => ({ id: group.id, title: group.title, count: group.count,
                fields: group.fields.map((field) => ({ id: field.id, label: field.label,
                    visible: field.visible, status: field.status, visibility: field.visibility,
                    sheet: { title: field.sheet.title, section: field.sheet.section,
                        visible: field.sheet.visible, sections: field.sheet.sections, order: field.sheet.order,
                        doneLabel: field.sheet.doneLabel } })) })) };
    };
    const captureFor = (data: AppData): GtdSettingsModel['capture'] => {
        const gtd = data.settings.gtd;
        const display = { gtd: { defaultAreaMode: gtd?.defaultAreaMode,
            defaultAreaId: gtd?.defaultAreaId } } as AppSettings;
        return buildGtdSettingsModel({ settings: display, areas: data.areas ?? [],
            taskOpenMode: 'automatic', t: deps.t() }).capture;
    };
    const orderedLiveAreas = (data: AppData): Area[] => [...(data.areas ?? [])]
        .filter((area) => !area.deletedAt).sort(compareAreasByOrder);
    const areaRevision = (areas: readonly Area[]): string => revisionsToken(areas.map((area) =>
        JSON.stringify([area.id, area.name, area.order, area.createdAt, area.updatedAt, area.rev ?? null, area.revBy ?? null])));
    return {
        getTaskOpenTab(input: unknown): NativeHostResult<{ tab: 'task' | 'view' }> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, ['rawMode', 'automaticTab', 'explicitEdit', 'readOnly'])
                || !(input.rawMode === null || bounded(input.rawMode, 200))
                || !(input.automaticTab === 'task' || input.automaticTab === 'view')
                || typeof input.explicitEdit !== 'boolean' || typeof input.readOnly !== 'boolean'
                || !isNativeJsonWithinBytes(input, 8192))
                return fail('INVALID_INPUT', 'Task opening needs a bounded mode, tab and flags');
            return { ok: true, value: { tab: resolveTaskOpenTab({
                mode: readGtdTaskOpenMode(input.rawMode), automaticTab: input.automaticTab,
                explicitEdit: input.explicitEdit, readOnly: input.readOnly,
            }) } };
        },
        async getGtdTaskEditorFieldOptions(input: unknown): Promise<NativeHostResult<NativeGtdTaskEditorFieldOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, []) || !isNativeJsonWithinBytes(input, 8192))
                return fail('INVALID_INPUT', 'GTD Task Editor field options take an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const expected = gtdWorkflowWitness(read.value.authority.snapshot.settings, 'taskEditorFieldVisible');
            if (!expected) return fail('INVALID_INPUT', 'Saved Task Editor layout has an unsupported value');
            const value = { taskEditor: taskEditorFieldFor(expected), expected };
            return isNativeJsonWithinBytes(value, 65_536) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Task Editor field options exceed the bounded response');
        },
        async getGtdTaskEditorPresetOptions(input: unknown): Promise<NativeHostResult<NativeGtdTaskEditorPresetOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, Object.prototype.hasOwnProperty.call(input, 'rawMode') ? ['rawMode'] : [])
                || (Object.prototype.hasOwnProperty.call(input, 'rawMode') && !(input.rawMode === null || bounded(input.rawMode, 200)))
                || !isNativeJsonWithinBytes(input, 8192))
                return fail('INVALID_INPUT', 'GTD Task Editor preset options need a bounded raw mode');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const expected = gtdWorkflowWitness(read.value.authority.snapshot.settings, 'taskEditorPreset');
            if (!expected) return fail('INVALID_INPUT', 'Saved Task Editor preset has an unsupported value');
            const value = { taskEditor: taskEditorPresetFor(expected, (input.rawMode as string | null | undefined) ?? null), expected };
            return isNativeJsonWithinBytes(value, 65_536) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Task Editor preset options exceed the bounded response');
        },
        async getGtdTaskEditorOpenOptions(input: unknown): Promise<NativeHostResult<NativeGtdTaskEditorOpenOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, []) || !isNativeJsonWithinBytes(input, 8192))
                return fail('INVALID_INPUT', 'GTD Task Editor options take an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const expected = {} as NativeGtdTaskEditorOpenOptions['expected'];
            for (const section of TASK_EDITOR_SECTIONS) {
                const witness = gtdWorkflowWitness(read.value.authority.snapshot.settings, 'taskEditorSectionOpen', section);
                if (!witness) return fail('INVALID_INPUT', `Saved ${section} Task Editor default has an unsupported value`);
                expected[section] = witness;
            }
            const value = { taskEditor: taskEditorOpenFor(expected), expected };
            return isNativeJsonWithinBytes(value, 65_536) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Task Editor options exceed the bounded response');
        },
        async getGtdCaptureParseOptions(input: unknown): Promise<NativeHostResult<NativeGtdCaptureParseOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, []) || !isNativeJsonWithinBytes(input, 8192))
                return fail('INVALID_INPUT', 'GTD Capture parse options take an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const expected = {} as Record<GtdWorkflowCaptureParseType, GtdWorkflowCaptureParseWitness>;
            for (const type of CAPTURE_PARSE_TYPES) {
                const witness = gtdWorkflowWitness(snapshot.settings, type);
                if (!witness) return fail('INVALID_INPUT', `Saved ${type} GTD Capture preference has an unsupported value`);
                expected[type] = witness;
            }
            const value = { capture: captureParseFor(snapshot), expected };
            return isNativeJsonWithinBytes(value, 65_536) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Capture parse options exceed the bounded response');
        },
        async getGtdCaptureAreaOptions(input: unknown): Promise<NativeHostResult<NativeGtdCaptureAreaOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, input.revision === undefined
                ? ['offset', 'limit'] : ['offset', 'limit', 'revision'])
                || !Number.isSafeInteger(input.offset) || (input.offset as number) < 0
                || !Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100
                || (input.offset as number) > 0 && (!bounded(input.revision, 100) || !input.revision)
                || input.revision !== undefined && (!bounded(input.revision, 100) || !input.revision)
                || !isNativeJsonWithinBytes(input, 8192))
                return fail('INVALID_INPUT', 'A bounded GTD Capture area page is required');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const expected = gtdWorkflowWitness(snapshot.settings, 'defaultArea');
            if (!expected) return fail('INVALID_INPUT', 'Saved Default Area has an unsupported value');
            const areas = orderedLiveAreas(snapshot);
            if (areas.some((area) => !gtdWorkflowTargetArea(area) || !bounded(area.name)))
                return fail('INVALID_INPUT', 'Saved Area choices have an unsupported value');
            const revision = areaRevision(areas);
            if (input.revision !== undefined && input.revision !== revision)
                return fail('STALE_REVISION', 'Area choices changed; reopen Default Area');
            const capture = captureFor(snapshot);
            const options = capture.defaultArea.options;
            const offset = input.offset as number;
            const limit = input.limit as number;
            const value = { capture: { title: capture.title, description: capture.description,
                defaultArea: { ...capture.defaultArea, options: options.slice(offset, offset + limit) } },
                expected, offset, total: options.length, revision };
            return isNativeJsonWithinBytes(value, 262_144) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Capture area page exceeds the bounded response');
        },
        async getGtdWorkflowOptions(input: unknown): Promise<NativeHostResult<NativeGtdWorkflowOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'GTD options take an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const expected = { pomodoro: gtdWorkflowWitness(snapshot.settings, 'pomodoro') } as NativeGtdWorkflowOptions['expected'];
            for (const type of TYPES) {
                const witness = gtdWorkflowWitness(snapshot.settings, type);
                if (!witness) return fail('INVALID_INPUT', `Saved ${type} GTD default has an unsupported value`);
                expected[type] = witness;
            }
            const value = { hub: hubFor(snapshot), expected };
            return isNativeJsonWithinBytes(value, 2_000_000) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD options exceed the bounded response');
        },
        async getGtdPomodoroOptions(input: unknown): Promise<NativeHostResult<NativeGtdPomodoroOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'GTD Pomodoro options take an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const expected = {} as NativeGtdPomodoroOptions['expected'];
            for (const type of POMODORO_TYPES) {
                const witness = gtdWorkflowWitness(snapshot.settings, type);
                Object.assign(expected, { [type]: type === 'pomodoro' || witness && 'gate' in witness
                    && witness.gate.enabled.value === true ? witness : null });
            }
            const value = { pomodoro: pomodoroFor(snapshot), expected };
            return isNativeJsonWithinBytes(value, 65_536) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Pomodoro options exceed the bounded response');
        },
        async getGtdArchiveOptions(input: unknown): Promise<NativeHostResult<NativeGtdArchiveOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'GTD Archive options take an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const expected = gtdWorkflowWitness(snapshot.settings, 'autoArchiveDays');
            if (!expected) return fail('INVALID_INPUT', 'Saved Auto-archive choice has an unsupported value');
            const value = { archive: archiveFor(snapshot), expected };
            return isNativeJsonWithinBytes(value, 262_144) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Archive options exceed the bounded response');
        },
        async getGtdReviewOptions(input: unknown): Promise<NativeHostResult<NativeGtdReviewOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'GTD Review options take an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const expected = {} as Record<GtdWorkflowReviewType, GtdWorkflowReviewWitness>;
            for (const type of REVIEW_TYPES) {
                const witness = gtdWorkflowWitness(snapshot.settings, type);
                if (!witness) return fail('INVALID_INPUT', `Saved ${type} GTD Review step has an unsupported value`);
                expected[type] = witness;
            }
            const value = { review: reviewFor(snapshot), expected };
            return isNativeJsonWithinBytes(value, 2_000_000) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Review options exceed the bounded response');
        },
        async getGtdInboxOptions(input: unknown): Promise<NativeHostResult<NativeGtdInboxOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'GTD Inbox options take an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const expected = {} as Record<GtdWorkflowInboxType, GtdWorkflowInboxWitness>;
            for (const type of INBOX_TYPES) {
                const witness = gtdWorkflowWitness(snapshot.settings, type);
                if (!witness) return fail('INVALID_INPUT', `Saved ${type} GTD Inbox step has an unsupported value`);
                expected[type] = witness;
            }
            const value = { inbox: inboxFor(snapshot), expected };
            return isNativeJsonWithinBytes(value, 2_000_000) ? { ok: true, value }
                : fail('INVALID_INPUT', 'GTD Inbox options exceed the bounded response');
        },
        normalizeGtdWorkflowDraft(input: unknown): NativeHostResult<NativeGtdWorkflowDraft> {
            if (record(input) && input.type === 'pomodoroDurations') {
                if (!exact(input, ['type', 'focusMinutes', 'breakMinutes', 'expected'])
                    || !bounded(input.focusMinutes, 512) || strToU8(input.focusMinutes).length > 512
                    || !bounded(input.breakMinutes, 512) || strToU8(input.breakMinutes).length > 512
                    || !validPomodoroWitness(input.expected, 'pomodoroDurations')
                    || !('gate' in input.expected) || input.expected.gate.enabled.value !== true)
                    return fail('INVALID_INPUT', 'Bounded Pomodoro duration drafts and their selected witness are required');
                const settings = settingsByWitness({ type: 'pomodoroDurations',
                    value: { focusMinutes: 25, breakMinutes: 5 } }, input.expected);
                return { ok: true, value: { valid: true,
                    value: resolveGtdPomodoroDurations(settings, input.focusMinutes, input.breakMinutes) } };
            }
            if (!record(input) || !exact(input, ['value']) || !bounded(input.value, 50))
                return fail('INVALID_INPUT', 'A bounded GTD time draft is required');
            const value = normalizeClockTimeInput(input.value);
            return { ok: true, value: value === null ? { valid: false, value: null } : { valid: true, value } };
        },
        probeGtdWorkflowOutcome(input: unknown): NativeHostResult<NativeGtdWorkflowResult> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'GTD workflow outcome is unknown; refresh GTD')
                : fail('INVALID_INPUT', 'A bounded GTD workflow request is required');
        },
        async prepareGtdWorkflow(input: unknown): Promise<NativeHostResult<NativeGtdWorkflowPreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded GTD workflow request is required');
            const preparedAt = new Date().toISOString();
            const read = await readAreaDurableData(false, request.edit.type === 'autoArchiveDays'); if (!read.ok) return read;
            const settings = read.value.authority.snapshot.settings;
            const current = gtdWorkflowWitness(settings, request.edit.type,
                isTaskEditorEdit(request.edit) ? request.edit.section : undefined);
            if (!current || !same(current, request.expected)
                || (settings.deviceId ?? null) !== (read.value.authority.state.settings.deviceId ?? null))
                return fail('STALE_REVISION', 'GTD workflow default changed; refresh GTD');
            let targetArea: GtdWorkflowTargetArea | null = null;
            if (request.edit.type === 'defaultArea') {
                const selected = request.edit.value;
                const areas = orderedLiveAreas(read.value.authority.snapshot);
                if (areas.some((area) => !gtdWorkflowTargetArea(area) || !bounded(area.name)))
                    return fail('INVALID_INPUT', 'Saved Area choices have an unsupported value');
                const capture = captureFor(read.value.authority.snapshot);
                if (!capture.defaultArea.options.some((option) => same(option.edit, request.edit)))
                    return fail('INVALID_INPUT', 'GTD Capture area choice is unavailable');
                if (selected !== '' && selected !== GTD_DEFAULT_AREA_ACTIVE_OPTION) {
                    targetArea = gtdWorkflowTargetArea(areas.find((area) => area.id === selected));
                    if (!targetArea) return fail('STALE_REVISION', 'Selected Area changed; refresh Capture');
                }
            }
            if (isOrder(request.edit.type) && !orderOfferedByWitness(request.edit, current))
                return fail('INVALID_INPUT', 'GTD Task Editor order choice is unavailable');
            if (isReset(request.edit.type) && !resetOfferedByWitness(request.edit, current))
                return fail('INVALID_INPUT', 'GTD Task Editor reset choice is unavailable');
            if (!pomodoroOfferedByWitness(request.edit, current, true))
                return fail('INVALID_INPUT', 'GTD Pomodoro choice is unavailable');
            if (isGtdSettingStored(settings, gtdWorkflowSettingsEdit(request.edit)))
                return { ok: true, value: { kind: 'noop', result: resultFor(request.edit, false) } };
            if (isReview(request.edit.type)) {
                const review = reviewFor(read.value.authority.snapshot);
                const toggle = request.edit.type === 'dailyReviewFocusStep'
                    ? review.dailyFocusStep : review.weeklyContextStep;
                if (!same(toggle.edit, request.edit))
                    return fail('INVALID_INPUT', 'GTD Review choice is unavailable');
            } else if (isInbox(request.edit.type)) {
                const inbox = inboxFor(read.value.authority.snapshot);
                const toggle = request.edit.type === 'inboxTwoMinute' ? inbox.twoMinute
                    : request.edit.type === 'inboxProjectFirst' ? inbox.projectFirst
                        : request.edit.type === 'inboxContextStep' ? inbox.contextStep : inbox.schedule;
                if (!same(toggle.edit, request.edit))
                    return fail('INVALID_INPUT', 'GTD Inbox choice is unavailable');
            } else if (isCaptureParse(request.edit.type)) {
                const capture = captureParseFor(read.value.authority.snapshot);
                if (!same(capture[request.edit.type].edit, request.edit))
                    return fail('INVALID_INPUT', 'GTD Capture parse choice is unavailable');
            } else if (isTaskEditorEdit(request.edit)) {
                if (!taskEditorOfferedByWitness(request.edit, current))
                    return fail('INVALID_INPUT', 'GTD Task Editor choice is unavailable');
            } else if (isPreset(request.edit.type)) {
                if (!presetOfferedByWitness(request.edit, current))
                    return fail('INVALID_INPUT', 'GTD Task Editor preset choice is unavailable');
            } else if (isField(request.edit.type) || isFieldSection(request.edit.type)) {
                if (!fieldOfferedByWitness(request.edit, current))
                    return fail('INVALID_INPUT', 'GTD Task Editor field choice is unavailable');
            } else if (request.edit.type === 'autoArchiveDays') {
                if (!archiveFor(read.value.authority.snapshot).options.some((option) => same(option.edit, request.edit)))
                    return fail('INVALID_INPUT', 'GTD Auto-archive choice is unavailable');
            } else {
                const hub = hubFor(read.value.authority.snapshot);
                if (request.edit.type === 'focusTaskLimit'
                    && !hub.focusTaskLimit.options.some((option) => same(option.edit, request.edit))
                    || request.edit.type === 'focusIncludeStartDates'
                        && !same(hub.focusIncludeStartDates.edit, request.edit)
                    || request.edit.type === 'defaultProjectFlowMode'
                        && !hub.defaultProjectFlowMode.options.some((option) => same(option.edit, request.edit)))
                    return fail('INVALID_INPUT', 'GTD workflow choice is unavailable');
            }
            const update = buildGtdSettingsUpdate(settings, gtdWorkflowSettingsEdit(request.edit));
            if (!update) return fail('INVALID_INPUT', 'GTD workflow default cannot be saved');
            const selected = isLayout(request.edit.type)
                ? presetSelectedAfter(request.edit, current) : taskEditorSelectedAfter(request.edit, current);
            if ((isTaskEditorEdit(request.edit) || isLayout(request.edit.type)) && !selected)
                return fail('INVALID_INPUT', 'GTD Task Editor receipt is unavailable');
            const device = ensureDeviceId(settings);
            let archiveEffects: GtdArchiveEffect[] | null = null;
            if (request.edit.type === 'autoArchiveDays') {
                try {
                    archiveEffects = JSON.parse(JSON.stringify(gtdArchiveEffects(read.value.authority.snapshot.tasks,
                        { ...settings, ...update }, preparedAt, device.deviceId))) as GtdArchiveEffect[];
                } catch { return fail('INVALID_INPUT', 'GTD Auto-archive effects are not bounded JSON'); }
            }
            const prepared: NativePreparedGtdWorkflow = { version: 1, request, preparedAt,
                deviceIdBefore: settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                after: { ...(request.edit.type === 'taskEditorReset' ? {} : { value: request.edit.value }),
                    stamp: plannedStamp(preparedAt, request.expected),
                    ...(selected ? { selected } : {}) },
                result: resultFor(request.edit, true),
                ...(request.edit.type === 'defaultArea' ? { targetArea } : {}),
                ...(archiveEffects ? { archiveEffects } : {}) };
            const frozen = detach<NativePreparedGtdWorkflow>(prepared);
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'GTD workflow default exceeds the bounded journal');
        },
        validatePreparedGtdWorkflow(input: unknown): NativeHostResult<NativeGtdWorkflowResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared GTD workflow default does not match the request');
        },
        async commitPreparedGtdWorkflow(input: unknown): Promise<NativeHostResult<NativeGtdWorkflowResult>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared GTD workflow default does not match the request');
            const read = await readAreaDurableData(true, prepared.request.edit.type === 'autoArchiveDays'); if (!read.ok) return read;
            if (!saves.mayApply(prepared, read.value.adapter))
                return fail('SAVE_FAILED', 'GTD workflow default has an unresolved persistence failure');
            const applied = await useTaskStore.getState().commitPreparedGtdWorkflow(prepared, read.value.authority);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'GTD workflow default changed; refresh GTD');
            const saved = await saves.finish(prepared, read.value.adapter,
                applied.outcome === 'replayed', read.value.authority.saveBoundary);
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
