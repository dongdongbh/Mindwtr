


import { AREA_PRESET_COLORS, DEFAULT_AREA_COLOR } from './color-constants';
import { countLiveProjectsByArea } from './area-project-usage';
import { createBackupFileName, serializeBackupData } from './backup-transfer';
import { bytesToBase64 } from './base64-bytes';
import { serializeMindwtrCsv } from './mindwtr-csv-export';
import { buildTaskNotesExportZip } from './tasknotes-export';
import { getInMemoryAppDataSnapshot } from './sync-client-helpers';
import { isSandboxMode, isWorkspaceTransitionActive } from './sandbox';
import { canUseJalaliCalendar, createDateFormatter, getSystemWeekStart, normalizeClockTimeInput, type DateFormattingConfig } from './date';
import { isArchiveRetentionDays } from './archive-retention';
import {
    buildArchiveRetentionReview,
    buildDataSettingsModel,
    buildDataSettingsUpdate,
    isDataSettingStored,
    type ArchiveRetentionReview,
    type DataSettingsEdit,
    type DataSettingsModel,
} from './data-settings-model';
import {
    buildNotificationsSettingsModel,
    buildNotificationsSettingsUpdate,
    isNotificationsSettingStored,
    NOTIFICATIONS_BOOLEAN_SETTINGS,
    NOTIFICATIONS_TIME_PATTERN,
    NOTIFICATIONS_TIME_SETTINGS,
    type NotificationsSettingsEdit,
    type NotificationsSettingsModel,
} from './notifications-settings-model';
import {
    buildGeneralSettingsModel,
    buildGeneralSettingsUpdate,
    getGeneralSettingsDeviceWrites,
    isGeneralSettingStored,
    MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS,
    MOBILE_QUICK_ACCESS_VIEW_OPTIONS,
    resolveGeneralThemeMode,
    SETTINGS_LANGUAGE_OPTIONS,
    type GeneralSettingsEdit,
    type GeneralSettingsModel,
    type SettingsDeviceWrite,
} from './general-settings-model';
import { FOCUS_TASK_LIMIT_OPTIONS } from './focus-utils';
import {
    buildGtdSettingsModel,
    buildGtdSettingsUpdate,
    getGtdSettingsDeviceWrites,
    GTD_AUTO_ARCHIVE_DAY_OPTIONS,
    GTD_DEFAULT_AREA_ACTIVE_OPTION,
    GTD_TASK_OPEN_MODES,
    isGtdSettingStored,
    readGtdTaskOpenMode,
    type GtdSettingsEdit,
    type GtdSettingsModel,
} from './gtd-settings-model';
import { formatLocalDate } from './import-source-reader';
import { tFallback } from './i18n';
import type { Language } from './i18n/i18n-types';
import { logInfo } from './logger';
import { getSavedTaxonomyTokens, normalizeTaxonomyToken } from './taxonomy-catalog';
import { isSupportedLanguage } from './i18n/i18n-constants';
import {
    buildManagePersonRow,
    getManageDeleteConfirm,
    getManageEditorDraft,
    getManageEditorText,
    getManageSettingsText,
    isManageAreaNameTaken,
    isManageEditorSaveDisabled,
    MANAGE_OPEN_SECTIONS_STORAGE_KEY,
    MANAGE_SECTION_ORDER,
    parseManageOpenSections,
    planManageEditorSave,
    sortManageAreas,
    sortManagePeople,
    type ManageConfirm,
    type ManageEditorDraft,
    type ManageEditorTarget,
    type ManageEditorWrite,
    type ManageSectionKey,
    type ManageUntranslatedText,
} from './manage-settings-model';
import { NATIVE_HOST_CONTRACT_VERSION, type NativeHostResult } from './native-host-contract';
import { nativeAboutHeartbeat, type NativeAboutHost } from './native-host-contract-about';
import { resetHeartbeatOptOutMarker, sendMobileAnalyticsOptOut } from './analytics-heartbeat';
import { fail, firstWindow, isObjectRecord, isPaging, isText, page, type NativeWindow } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, isRevision, refuseStale, revisionOf, revisionsToken, runStoreWrite, settleWrite } from './native-request-receipts';
import { getPersonNameKey, getPersonTaskCounts } from './people';
import { SETTINGS_THEME_VALUE_SET } from './settings-options';
import {
    buildSettingsAdvancedMenu,
    buildSettingsMenu,
    getSettingsSyncBadge,
    type SettingsMenuRow,
    type SettingsSyncBadgeState,
} from './settings-menu-model';
import { getPersistenceStatus, useTaskStore } from './store';
import { themeDescriptor } from './theme-scheme';
import { normalizeTagId } from './store-helpers';
import { formatTagIdPreservingCase } from './store-projects/shared';
import { DEFAULT_TASK_EDITOR_ORDER, isTaskEditorSectionableField, TASK_EDITOR_SECTION_ORDER } from './task-editor-layout';
import type { Project, Task, TaskEditorFieldId } from './types';
import { sortViewSectionDefinitions } from './view-sections';

type Translate = (key: string) => string;


export function buildNativeGeneralSettingsModel(settings: import('./types').AppSettings, deps: Pick<SettingsDeps,
    't' | 'language' | 'systemLocale' | 'dateFormatting'>, deviceTheme?: string | null,
appSearch: { supported: boolean; enabled: boolean } = { supported: false, enabled: false }): GeneralSettingsModel {
    const locale = deps.systemLocale() ?? '';
    const sample = createDateFormatter({ ...deps.dateFormatting(), dateFormat: 'system',
        calendarSystem: settings.calendarSystem, timeFormat: settings.timeFormat })(new Date(), 'P');
    return buildGeneralSettingsModel({ settings,
        themeMode: resolveGeneralThemeMode(settings.theme, deviceTheme), language: deps.language(),
        systemLocale: locale, systemWeekStart: getSystemWeekStart(locale), systemDateSample: sample,
        appSearch, t: deps.t() });
}

export type SettingsDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    language: () => Language;
    systemLocale: () => string | null;

    dateFormatting: () => DateFormattingConfig;

    dataRevision: () => string;
    requestIdPattern: RegExp;

    about?: () => NativeAboutHost | null;

    persistentCapture?: () => NativePersistentCaptureHost | null;
};


export type NativePersistentCaptureHost = { read(): boolean; write(enabled: boolean): void };


export const NATIVE_SETTINGS_SCREENS: readonly string[] = ['general', 'gtd', 'manage', 'notifications', 'sync', 'data', 'advanced', 'ai', 'about', 'calendar'];

type NativeMenuRow<Id extends string = string> = SettingsMenuRow<Id> & { enabled: boolean };

export type NativeSettingsMenu = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    title: string;
    searchPlaceholder: string;

    groups: NativeMenuRow[][];
    noMatches: string | null;

    advanced: { title: string; rows: NativeMenuRow[] };
};

export type NativeGeneralSettings = GeneralSettingsModel & { version: typeof NATIVE_HOST_CONTRACT_VERSION; revision: string };

export type NativeGtdSettings = GtdSettingsModel & { version: typeof NATIVE_HOST_CONTRACT_VERSION; revision: string };

export type NativeDataSettings = DataSettingsModel & { version: typeof NATIVE_HOST_CONTRACT_VERSION; revision: string };

export type NativeNotificationsSettings = NotificationsSettingsModel & { version: typeof NATIVE_HOST_CONTRACT_VERSION; revision: string };


export type NativePersistentCaptureNotification = { post: NotificationsSettingsModel['persistentCaptureNotification'] | null };

export type NativeNotificationsWriteResult = NativeSettingsWriteResult & { persistentCapture?: NativePersistentCaptureNotification };


export type NativeSettingsWriteResult = { changed: boolean; deviceWrites: SettingsDeviceWrite[] };


export type NativeManageEditorTarget =
    | { type: 'area'; id: string; revision: string }
    | { type: 'newArea' }
    | { type: 'unassignedArea' }
    | { type: 'newPerson' }
    | { type: 'newContext' | 'newTag' }
    | { type: 'person'; id: string; revision: string }
    | { type: 'context' | 'tag'; name: string; revision: string };


export type NativeManageDeleteTarget = { type: 'area' | 'person'; id: string; revision: string } | { type: 'context' | 'tag'; name: string; revision: string };


type ReadTarget = NativeManageEditorTarget | { type: 'area' | 'person'; id: string } | { type: 'context' | 'tag'; name: string };


type NativeManageEdit = { target: NativeManageEditorTarget; draft: ManageEditorDraft };

export type NativeManageAreaRow = { id: string; name: string; color: string; edit: NativeManageEdit; delete: NativeManageDeleteTarget; deleteConfirm: ManageConfirm };
export type NativeManagePersonRow = ReturnType<typeof buildManagePersonRow> & {
    id: string;
    name: string;
    edit: NativeManageEdit;
    delete: NativeManageDeleteTarget;
    deleteConfirm: ManageConfirm;
};
export type NativeManageValueRow = { value: string; edit: NativeManageEdit; delete: NativeManageDeleteTarget; deleteConfirm: ManageConfirm };
export type ManageListName = 'areas' | 'people' | 'contexts' | 'tags';

export type NativeManageSettings = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;

    revision: string;
    title: string;

    sections: { key: ManageSectionKey; title: string; count: number; open: boolean; toggle: SettingsDeviceWrite }[];


    openSectionsRestore: SettingsDeviceWrite | null;
    areas: {
        unassigned: { label: string; description: string; color: string; edit: NativeManageEdit };
        rows: NativeWindow<NativeManageAreaRow>;

        empty: string | null;
        newArea: { label: string; hint: string; addLabel: string; color: string; edit: NativeManageEdit };
    };

    somedaySections: { emptyHint: string | null };
    people: {
        rows: NativeWindow<NativeManagePersonRow>;
        empty: string | null;
        newPerson: { label: string; hint: string; addLabel: string; edit: NativeManageEdit };
        text: { openReference: string; openReferenceFailed: string; editLabel: string; deleteLabel: string; countHint: string };
    };
    contexts: { rows: NativeWindow<NativeManageValueRow>; empty: string | null; create: { label: string; addLabel: string; edit: NativeManageEdit } };
    tags: { rows: NativeWindow<NativeManageValueRow>; empty: string | null; create: { label: string; addLabel: string; edit: NativeManageEdit } };

    editor: {
        text: Record<ManageEditorTarget['type'], ReturnType<typeof getManageEditorText>>;
        colors: { color: string; label: string }[];
    };
};

const EDITOR_TYPES: ManageEditorTarget['type'][] = ['area', 'newArea', 'unassignedArea', 'newPerson', 'person', 'context', 'tag', 'newContext', 'newTag'];
const WEEK_STARTS = new Set(['system', 'sunday', 'monday', 'saturday']);
const DATE_FORMATS = new Set(['system', 'dmy', 'mdy', 'ymd']);
const TIME_FORMATS = new Set(['system', '12h', '24h']);
const CALENDAR_SYSTEMS = new Set(['gregorian', 'jalali']);
const LANGUAGES = new Set<string>(SETTINGS_LANGUAGE_OPTIONS.map((lang) => lang.id));
const SYNC_BADGES = new Set<string>(['hidden', 'syncing', 'healthy', 'attention']);


function readGeneralEdit(value: unknown, calendarSystemShown: boolean): GeneralSettingsEdit | null {
    if (!isObjectRecord(value) || Object.keys(value).some((key) => key !== 'type' && key !== 'value')) return null;
    const v = value.value;
    const ok = (() => {
        switch (value.type) {
            case 'theme': return SETTINGS_THEME_VALUE_SET.has(v as never);
            case 'quickAccessView': return MOBILE_QUICK_ACCESS_VIEW_OPTIONS.includes(v as never);
            case 'appLockRelockDelay': return MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS.includes(v as never);
            case 'language': return LANGUAGES.has(v as string);
            case 'weekStart': return WEEK_STARTS.has(v as string);
            case 'dateFormat': return DATE_FORMATS.has(v as string);
            case 'timeFormat': return TIME_FORMATS.has(v as string);

            case 'calendarSystem': return calendarSystemShown && CALENDAR_SYSTEMS.has(v as string);
            case 'showTaskAge':
            case 'appLock':
            case 'appSearch':
                return typeof v === 'boolean';
            default: return false;
        }
    })();
    return ok ? value as GeneralSettingsEdit : null;
}

const GTD_BOOLEAN_EDITS = new Set<string>([
    'pomodoro', 'pomodoroLinkTask', 'pomodoroAutoStartBreaks', 'pomodoroAutoStartFocus', 'pomodoroCompletionAlert',
    'saveAudioAttachments', 'quickAddAutoClean', 'naturalLanguageDates', 'markdownEditorAssist', 'focusIncludeStartDates',
    'dailyReviewFocusStep', 'weeklyReviewContextStep',
    'inboxTwoMinute', 'inboxProjectFirst', 'inboxContextStep', 'inboxSchedule',
]);
const OPENABLE_SECTIONS = new Set<string>(['scheduling', 'organization', 'details']);
const isTaskEditorField = (value: unknown): value is TaskEditorFieldId => DEFAULT_TASK_EDITOR_ORDER.includes(value as TaskEditorFieldId);


function readGtdEdit(value: unknown, liveAreaIds: Set<string>): GtdSettingsEdit | null {
    if (!isObjectRecord(value)) return null;
    const { type, value: v } = value;
    const only = (...keys: string[]) => Object.keys(value).every((key) => key === 'type' || keys.includes(key));
    if (type === 'defaultScheduleTime') {
        const normalized = only('value') && isText(v, 50) ? normalizeClockTimeInput(v) : null;
        return normalized === null ? null : { type, value: normalized };
    }
    const ok = (() => {
        if (GTD_BOOLEAN_EDITS.has(type as string)) return only('value') && typeof v === 'boolean';
        switch (type) {
            case 'focusTaskLimit': return only('value') && FOCUS_TASK_LIMIT_OPTIONS.includes(v as never);
            case 'defaultProjectFlowMode': return only('value') && (v === 'parallel' || v === 'sequential');
            case 'autoArchiveDays': return only('value') && GTD_AUTO_ARCHIVE_DAY_OPTIONS.includes(v as number);
            case 'pomodoroDurations': return only('focusMinutes', 'breakMinutes') && isText(value.focusMinutes, 20) && isText(value.breakMinutes, 20);
            case 'captureMethod': return only('value') && (v === 'text' || v === 'audio');
            case 'defaultArea': return only('value') && (v === '' || v === GTD_DEFAULT_AREA_ACTIVE_OPTION || liveAreaIds.has(v as string));
            case 'taskOpenMode': return only('value') && GTD_TASK_OPEN_MODES.includes(v as never);
            case 'taskEditorPreset': return only('value') && (v === 'simple' || v === 'standard' || v === 'full');
            case 'taskEditorFieldVisible': return only('field', 'value') && isTaskEditorField(value.field) && typeof v === 'boolean';

            case 'taskEditorOrder':
                return only('value') && Array.isArray(v) && v.length === DEFAULT_TASK_EDITOR_ORDER.length
                    && new Set(v).size === v.length && v.every(isTaskEditorField);
            case 'taskEditorFieldSection':
                return only('field', 'value') && isTaskEditorField(value.field) && isTaskEditorSectionableField(value.field)
                    && TASK_EDITOR_SECTION_ORDER.includes(v as never);
            case 'taskEditorSectionOpen': return only('section', 'value') && OPENABLE_SECTIONS.has(value.section as string) && typeof v === 'boolean';
            case 'taskEditorReset': return only();
            default: return false;
        }
    })();
    return ok ? value as GtdSettingsEdit : null;
}

const isName = (value: unknown): value is string => isText(value, 500) && value.trim().length > 0;

const NOTIFICATIONS_BOOLEANS = new Set<string>([...NOTIFICATIONS_BOOLEAN_SETTINGS, 'persistentCapture']);
const NOTIFICATIONS_TIMES = new Set<string>(NOTIFICATIONS_TIME_SETTINGS);


const readNotificationsEdit = (value: unknown): NotificationsSettingsEdit | null => {
    if (!isObjectRecord(value) || Object.keys(value).length !== 2 || typeof value.type !== 'string') return null;
    const v = value.value;
    const ok = NOTIFICATIONS_BOOLEANS.has(value.type) ? typeof v === 'boolean'
        : NOTIFICATIONS_TIMES.has(value.type) ? typeof v === 'string' && NOTIFICATIONS_TIME_PATTERN.test(v)
            : value.type === 'taskReminderDefault' ? v === 'send' || v === 'skip'
                : value.type === 'weeklyReviewDay' && Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 6;
    return ok ? { type: value.type, value: v } as NotificationsSettingsEdit : null;
};


const persistentCaptureOn = (capture: NativePersistentCaptureHost): boolean => {
    try {
        return capture.read();
    } catch {
        return false;
    }
};


const readDataEdit = (value: unknown, analyticsAvailable: boolean): DataSettingsEdit | null => {
    if (!isObjectRecord(value) || Object.keys(value).length !== 2) return null;
    if (value.type === 'archiveRetentionDays') return isArchiveRetentionDays(value.value) ? { type: value.type, value: value.value } : null;
    return typeof value.value === 'boolean' && (value.type === 'debugLogging' || (value.type === 'analyticsOptOut' && analyticsAvailable))
        ? { type: value.type, value: value.value }
        : null;
};


export type NativeArchiveRetentionRun = {
    outcome: 'purged' | 'unchanged' | 'skipped' | 'failed';
    purged: { tasks: number; projects: number; sections: number };
    skipped: 'editor-open' | 'off' | 'not-ready' | 'waiting-for-sync' | null;
};

export function createSettingsMethods(deps: SettingsDeps) {

    let lastRetentionLine = '';
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });

    const heartbeat = () => {
        const host = deps.about?.() ?? null;
        const bound = host ? nativeAboutHeartbeat(host) : null;
        return bound?.available ? bound : null;
    };

    const manageRevision = () => `${deps.dataRevision()}:${deps.language()}`;

    const systemLocale = () => deps.systemLocale() ?? '';

    const notificationsModel = (persistentCapture: { enabled: boolean } | null) => buildNotificationsSettingsModel({
        settings: useTaskStore.getState().settings, t: deps.t(), language: deps.language(), systemLocale: systemLocale(),
        ...(persistentCapture ? { persistentCapture } : {}),
    });

    const generalModel = (input: { deviceTheme?: string | null; appSearch?: { supported: boolean; enabled: boolean } }) => {
        const state = useTaskStore.getState();
        return buildNativeGeneralSettingsModel(state.settings, deps, input.deviceTheme, input.appSearch);
    };


    const contextCarried = (name: string, except?: string) => {
        const key = normalizeTaxonomyToken('context', name).toLowerCase();
        const state = useTaskStore.getState();
        const match = (ctx: string) => normalizeTaxonomyToken('context', ctx).toLowerCase() === key
            && (except === undefined || normalizeTaxonomyToken('context', ctx) !== normalizeTaxonomyToken('context', except));
        return state._allTasks.some((task) => (task.contexts ?? []).some(match))
            || getSavedTaxonomyTokens(state.settings, 'context').some(match);
    };
    const tagCarried = (name: string, except?: string) => {
        const key = normalizeTagId(name);
        const { _allTasks, _allProjects, settings } = useTaskStore.getState();
        const match = (tag: string) => normalizeTagId(tag) === key && tag !== except;
        return _allTasks.some((task) => (task.tags ?? []).some(match)) || _allProjects.some((project) => (project.tagIds ?? []).some(match))
            || getSavedTaxonomyTokens(settings, 'tag').some(match);
    };


    const carriersRevisions = (type: 'context' | 'tag') => {
        const { _allTasks, _allProjects, settings } = useTaskStore.getState();
        const keyOf = type === 'context' ? (name: string) => normalizeTaxonomyToken('context', name).toLowerCase() : normalizeTagId;
        const byKey = new Map<string, string[]>();
        const add = (row: Task | Project, names: readonly string[] | undefined) => {
            for (const key of new Set((names ?? []).map(keyOf))) {
                const carriers = byKey.get(key);
                const entry = `${row.id}@${revisionOf(row)}`;
                if (carriers) carriers.push(entry);
                else byKey.set(key, [entry]);
            }
        };
        _allTasks.forEach((task) => add(task, type === 'context' ? task.contexts : task.tags));
        if (type === 'tag') _allProjects.forEach((project) => add(project, project.tagIds));
        return (name: string) => {
            const carriers = byKey.get(keyOf(name)) ?? [];
            const entries = (type === 'context' ? settings.taxonomy?.contexts : settings.taxonomy?.tags) ?? [];
            return revisionsToken([...carriers, ...entries.filter((entry) => keyOf(entry.token) === keyOf(name)).map((entry) => JSON.stringify(entry))].sort());
        };
    };


    const refuseStaleTarget = (target: NativeManageEditorTarget | NativeManageDeleteTarget): NativeHostResult<never> | null => {
        if (!('revision' in target)) return null;
        const state = useTaskStore.getState();
        switch (target.type) {
            case 'area': return refuseStale([state._allAreas.find((area) => area.id === target.id)], [target.revision], 'The area changed since Manage showed it; read Manage again');
            case 'person': return refuseStale([state._allPeople.find((person) => person.id === target.id)], [target.revision], 'The person changed since Manage showed them; read Manage again');
            default: return carriersRevisions(target.type)(target.name) === target.revision
                ? null
                : fail('STALE_REVISION', `The ${target.type} changed since Manage showed it; read Manage again`);
        }
    };

    const storeData = () => {
        const state = useTaskStore.getState();
        return [state._allTasks, state._allProjects, state._allAreas, state._allPeople, state.settings];
    };


    const pendingWrites = (writes: ManageEditorWrite[]): ManageEditorWrite[] => {
        const state = useTaskStore.getState();
        return writes.filter((write) => {
            switch (write.kind) {
                case 'addContext':
                case 'addTag':
                    return !getSavedTaxonomyTokens(state.settings, write.kind === 'addContext' ? 'context' : 'tag')
                        .some((token) => token.toLowerCase() === write.name.trim().toLowerCase());

                case 'updateSettings':
                    return state.settings.appearance?.unassignedAreaColor !== write.updates.appearance?.unassignedAreaColor;


                case 'addArea':
                    return !isManageAreaNameTaken('newArea', write.name, state.areas);
                case 'renameContext':
                    return contextCarried(write.from, write.to.trim());
                case 'renameTag':
                    return tagCarried(write.from, formatTagIdPreservingCase(write.to));
                default:
                    return true;
            }
        });
    };


    const runEditorWrite = async (write: ManageEditorWrite, newId: string) => {
        const state = useTaskStore.getState();
        switch (write.kind) {
            case 'updateSettings':
                return state.updateSettings(write.updates);
            case 'addContext':
                return state.addContext(write.name);
            case 'addTag':
                return state.addTag(write.name);
            case 'addArea': {
                const named = state._allAreas.some((area) => area.name?.trim().toLowerCase() === write.name.trim().toLowerCase());
                return (await state.addArea(write.name, named ? write.props : { ...write.props, id: newId })) ? undefined : { success: false, error: 'Area creation failed' };
            }
            case 'addPerson': {
                const named = state._allPeople.some((person) => getPersonNameKey(person.name) === getPersonNameKey(write.name));
                return (await state.addPerson(write.name, named ? write.props : { ...write.props, id: newId })) ? undefined : { success: false, error: 'Person creation failed' };
            }
            case 'updatePerson':
                return state.updatePerson(write.id, write.updates);
            case 'renamePerson':
                return state.renamePerson(write.id, write.name, write.options);
            case 'updateArea':
                return state.updateArea(write.id, write.updates);
            case 'renameContext':
                return state.renameContext(write.from, write.to);
            case 'renameTag':
                return state.renameTag(write.from, write.to);
        }
    };


    const resolveTarget = (target: ReadTarget): ManageEditorTarget | null => {
        const state = useTaskStore.getState();
        switch (target.type) {
            case 'area': {
                const area = state.areas.find((entry) => entry.id === target.id);
                return area ? { type: 'area', id: area.id, name: area.name, color: area.color } : null;
            }
            case 'person': {
                const person = state.people.find((entry) => entry.id === target.id);
                return person ? { type: 'person', id: person.id, name: person.name, note: person.note, referenceLink: person.referenceLink } : null;
            }
            case 'unassignedArea':
                return { type: 'unassignedArea', color: state.settings.appearance?.unassignedAreaColor || DEFAULT_AREA_COLOR };
            case 'context':
            case 'tag':
                return { type: target.type, name: target.name };
            default:
                return target;
        }
    };


    const readEditorTarget = (value: unknown): ReadTarget | null => {
        if (!isObjectRecord(value)) return null;
        const revision = 'revision' in value ? value.revision : undefined;
        if (revision !== undefined && !isRevision(revision)) return null;
        const keys = Object.keys(value).length - ('revision' in value ? 1 : 0);
        const withRevision = <T extends object>(target: T) => (revision === undefined ? target : { ...target, revision });
        switch (value.type) {
            case 'newArea':
            case 'newPerson':
            case 'newContext':
            case 'newTag':
            case 'unassignedArea':
                return Object.keys(value).length === 1 ? { type: value.type } : null;
            case 'area':
            case 'person':
                return keys === 2 && isName(value.id) ? withRevision({ type: value.type, id: value.id }) : null;
            case 'context':
            case 'tag':
                return keys === 2 && isName(value.name) ? withRevision({ type: value.type, name: value.name }) : null;
            default:
                return null;
        }
    };

    const readWriteTarget = (value: unknown): NativeManageEditorTarget | null => {
        const target = readEditorTarget(value);
        return target && (target.type === 'newArea' || target.type === 'newPerson' || target.type === 'newContext' || target.type === 'newTag' || target.type === 'unassignedArea' || 'revision' in target)
            ? target as NativeManageEditorTarget
            : null;
    };


    const manageUntranslated = (t: Translate): ManageUntranslatedText => {
        const tf = (key: string, fallback: string) => tFallback(t, key, fallback);
        return {
            newAreaHint: tf('areas.newHint', 'Create an area for related projects and tasks.'),
            peopleEmpty: tf('people.empty', 'No people yet'),
            newPersonHint: tf('people.newHint', 'Add someone you delegate or wait on.'),
            editPerson: tf('people.edit', 'Edit person'),
            personNamePlaceholder: tf('people.namePlaceholder', 'Person name'),
            notePlaceholder: tf('people.notePlaceholder', 'Note'),
            referencePlaceholder: tf('people.referencePlaceholder', 'Reference link, including obsidian://'),
            openReference: tf('people.openReference', 'Open reference link'),
            openReferenceFailed: tf('people.openReferenceFailed', 'Could not open this reference link.'),
        };
    };

    const buildManage = (openSectionsRaw: string | null) => {
        const state = useTaskStore.getState();
        const t = deps.t();
        const untranslated = manageUntranslated(t);
        const text = getManageSettingsText(t, untranslated);
        const open = parseManageOpenSections(openSectionsRaw);
        const areas = sortManageAreas(state.areas);
        const people = sortManagePeople(state.people);
        const counts = getPersonTaskCounts(state._allTasks);
        const { allContexts, allTags } = state.getDerivedState();
        const somedayCount = sortViewSectionDefinitions(state.settings.gtd?.viewSections?.someday).length;
        const unassignedColor = state.settings.appearance?.unassignedAreaColor || DEFAULT_AREA_COLOR;

        const areaRows: NativeManageAreaRow[] = areas.map((area) => {
            const target = { type: 'area' as const, id: area.id, revision: revisionOf(area) };
            return {
                id: area.id,
                name: area.name,
                color: area.color || DEFAULT_AREA_COLOR,
                edit: { target, draft: getManageEditorDraft({ type: 'area', id: area.id, name: area.name, color: area.color }) },
                delete: target,
                deleteConfirm: getManageDeleteConfirm(t, area.name, 'areas.deleteConfirm'),
            };
        });
        const personRows: NativeManagePersonRow[] = people.map((person) => {
            const target = { type: 'person' as const, id: person.id, revision: revisionOf(person) };
            return {
                id: person.id,
                name: person.name,
                ...buildManagePersonRow(person, counts, t),
                edit: {
                    target,
                    draft: getManageEditorDraft({ type: 'person', id: person.id, name: person.name, note: person.note, referenceLink: person.referenceLink }),
                },
                delete: target,
                deleteConfirm: getManageDeleteConfirm(t, person.name, 'people.deleteConfirm'),
            };
        });
        const valueRows = (type: 'context' | 'tag', values: readonly string[]): NativeManageValueRow[] => {
            const revisionFor = carriersRevisions(type);
            return values.map((value) => {
                const target = { type, name: value, revision: revisionFor(value) };
                return { value, edit: { target, draft: getManageEditorDraft({ type, name: value }) }, delete: target, deleteConfirm: getManageDeleteConfirm(t, value) };
            });
        };
        const counted: Record<ManageSectionKey, number> = {
            areas: areas.length, somedaySections: somedayCount, people: people.length, contexts: allContexts.length, tags: allTags.length,
        };
        const contextRows = valueRows('context', allContexts);
        const tagRows = valueRows('tag', allTags);
        const lists: Record<ManageListName, readonly (NativeManageAreaRow | NativeManagePersonRow | NativeManageValueRow)[]> = {
            areas: areaRows, people: personRows, contexts: contextRows, tags: tagRows,
        };
        const changeColor = t('projects.changeColor');
        const view: Omit<NativeManageSettings, 'version' | 'revision'> = {
            title: text.title,
            sections: MANAGE_SECTION_ORDER.map((key) => ({
                key,
                title: text.sections[key],
                count: counted[key],
                open: open[key],
                toggle: { key: MANAGE_OPEN_SECTIONS_STORAGE_KEY, value: JSON.stringify({ ...open, [key]: !open[key] }) },
            })),
            openSectionsRestore: openSectionsRaw ? { key: MANAGE_OPEN_SECTIONS_STORAGE_KEY, value: JSON.stringify(open) } : null,
            areas: {
                unassigned: {
                    label: text.areas.unassignedLabel,
                    description: text.areas.unassignedDescription,
                    color: unassignedColor,
                    edit: { target: { type: 'unassignedArea' }, draft: getManageEditorDraft({ type: 'unassignedArea', color: unassignedColor }) },
                },
                rows: firstWindow(areaRows),
                empty: areas.length === 0 ? text.areas.empty : null,
                newArea: {
                    label: text.areas.newLabel,
                    hint: text.areas.newHint,
                    addLabel: text.areas.addLabel,
                    color: DEFAULT_AREA_COLOR,
                    edit: { target: { type: 'newArea' }, draft: getManageEditorDraft({ type: 'newArea' }) },
                },
            },
            somedaySections: { emptyHint: somedayCount === 0 ? text.somedaySections.emptyHint : null },
            people: {
                rows: firstWindow(personRows),
                empty: people.length === 0 ? text.people.empty : null,
                newPerson: {
                    label: text.people.newLabel,
                    hint: text.people.newHint,
                    addLabel: text.people.addLabel,
                    edit: { target: { type: 'newPerson' }, draft: getManageEditorDraft({ type: 'newPerson' }) },
                },
                text: (({ openReference, openReferenceFailed, editLabel, deleteLabel, countHint }) => (
                    { openReference, openReferenceFailed, editLabel, deleteLabel, countHint }
                ))(text.people),
            },
            contexts: { rows: firstWindow(contextRows), empty: allContexts.length === 0 ? text.contexts.empty : null,
                create: { label: text.contexts.newLabel, addLabel: text.contexts.addLabel,
                    edit: { target: { type: 'newContext' }, draft: getManageEditorDraft({ type: 'newContext' }) } } },
            tags: { rows: firstWindow(tagRows), empty: allTags.length === 0 ? text.tags.empty : null,
                create: { label: text.tags.newLabel, addLabel: text.tags.addLabel,
                    edit: { target: { type: 'newTag' }, draft: getManageEditorDraft({ type: 'newTag' }) } } },
            editor: {
                text: Object.fromEntries(EDITOR_TYPES.map((type) => [type, getManageEditorText(t, type, untranslated)])) as NativeManageSettings['editor']['text'],
                colors: AREA_PRESET_COLORS.map((color) => ({ color, label: `${changeColor}: ${color}` })),
            },
        };
        return { view, lists };
    };

    const readOpenSections = (value: unknown): string | null | undefined => (
        value === undefined || value === null ? null : isText(value, 2000) ? value : undefined
    );

    const menuRow = <Id extends string>(row: SettingsMenuRow<Id>): NativeMenuRow<Id> => ({ ...row, enabled: NATIVE_SETTINGS_SCREENS.includes(row.id) });

    return {


        getSettingsMenu(input: { query?: string; syncBadge?: SettingsSyncBadgeState; updateAvailable?: boolean } = {}): NativeHostResult<NativeSettingsMenu> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || (input.query !== undefined && !isText(input.query, 500))
                || (input.syncBadge !== undefined && !SYNC_BADGES.has(input.syncBadge as string))
                || (input.updateAvailable !== undefined && typeof input.updateAvailable !== 'boolean')) {
                return fail('INVALID_INPUT', 'A search text, a sync badge state and an update flag are optional; nothing else is accepted');
            }
            const t = deps.t();
            const badge = getSettingsSyncBadge(input.syncBadge ?? 'hidden', t, themeDescriptor(useTaskStore.getState().settings.theme)?.statusPreset);
            const menu = buildSettingsMenu({
                t,
                query: input.query ?? '',
                sync: badge ? { color: badge.color, accessibilityLabel: badge.accessibilityLabel } : undefined,
                updateAvailable: input.updateAvailable === true,
            });
            const advanced = buildSettingsAdvancedMenu(t);
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: manageRevision(),
                    title: menu.title,
                    searchPlaceholder: menu.searchPlaceholder,
                    groups: menu.groups.map((group) => group.map(menuRow)),
                    noMatches: menu.noMatches,
                    advanced: { title: advanced.title, rows: advanced.rows.map(menuRow) },
                },
            };
        },


        getGeneralSettings(input: { deviceTheme?: string | null; appSearch?: { supported: boolean; enabled: boolean } } = {}): NativeHostResult<NativeGeneralSettings> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input)
                || (input.deviceTheme !== undefined && input.deviceTheme !== null && !isText(input.deviceTheme, 100))
                || (input.appSearch !== undefined && (!isObjectRecord(input.appSearch)
                    || typeof input.appSearch.supported !== 'boolean' || typeof input.appSearch.enabled !== 'boolean'))) {
                return fail('INVALID_INPUT', 'deviceTheme must be text or null, and appSearch { supported, enabled } booleans');
            }
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: `${manageRevision()}:${systemLocale()}:${formatLocalDate(new Date())}`,
                    ...generalModel(input),
                },
            };
        },


        async setGeneralSetting(input: { requestId: string; edit: GeneralSettingsEdit }): Promise<NativeHostResult<NativeSettingsWriteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const calendarSystemShown = canUseJalaliCalendar({ language: deps.language(), systemLocale: systemLocale() });
            const edit = isObjectRecord(input) ? readGeneralEdit(input.edit, calendarSystemShown) : null;
            if (!edit || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A request UUID and an edit the General screen offers are required');
            }
            return receipts.run<NativeSettingsWriteResult>(input.requestId, JSON.stringify(['general', edit]), async () => {
                const deviceWrites = getGeneralSettingsDeviceWrites(edit);
                const settings = useTaskStore.getState().settings;
                const update = buildGeneralSettingsUpdate(settings, edit);
                if (!update || isGeneralSettingStored(settings, edit)) return { ok: true, value: { changed: false, deviceWrites } };
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(update));
                return settleWrite(written, { changed: true, deviceWrites });
            });
        },


        getGtdSettings(input: { taskOpenMode?: string | null; captureIntent?: { enabled: boolean | null } } = {}): NativeHostResult<NativeGtdSettings> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || (input.taskOpenMode !== undefined && input.taskOpenMode !== null && !isText(input.taskOpenMode, 100))
                || (input.captureIntent !== undefined && (!isObjectRecord(input.captureIntent)
                    || Object.keys(input.captureIntent).some((key) => key !== 'enabled')
                    || (typeof input.captureIntent.enabled !== 'boolean' && input.captureIntent.enabled !== null)))) {
                return fail('INVALID_INPUT', 'taskOpenMode must be the stored text or null, and captureIntent { enabled } a boolean or null');
            }
            const state = useTaskStore.getState();
            const model = buildGtdSettingsModel({
                settings: state.settings,
                areas: state.areas,
                taskOpenMode: readGtdTaskOpenMode(input.taskOpenMode),
                ...(input.captureIntent ? { captureIntent: { enabled: input.captureIntent.enabled } } : {}),
                t: deps.t(),
            });
            return { ok: true, value: { version: NATIVE_HOST_CONTRACT_VERSION, revision: manageRevision(), ...model } };
        },


        async setGtdSetting(input: { requestId: string; edit: GtdSettingsEdit }): Promise<NativeHostResult<NativeSettingsWriteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const liveAreaIds = new Set(useTaskStore.getState().areas.filter((area) => !area.deletedAt).map((area) => area.id));
            const edit = isObjectRecord(input) ? readGtdEdit(input.edit, liveAreaIds) : null;
            if (!edit || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A request UUID and an edit the GTD screens offer are required');
            }
            return receipts.run<NativeSettingsWriteResult>(input.requestId, JSON.stringify(['gtd', edit]), async () => {
                const deviceWrites = getGtdSettingsDeviceWrites(edit);
                const settings = useTaskStore.getState().settings;
                const update = buildGtdSettingsUpdate(settings, edit);
                if (!update || isGtdSettingStored(settings, edit)) return { ok: true, value: { changed: false, deviceWrites } };
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(update));
                return settleWrite(written, { changed: true, deviceWrites });
            });
        },


        getManageSettings(input: { openSections?: string | null } = {}): NativeHostResult<NativeManageSettings> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const openSections = isObjectRecord(input) ? readOpenSections(input.openSections) : undefined;
            if (openSections === undefined) return fail('INVALID_INPUT', 'openSections must be the stored text or null');
            const { view } = buildManage(openSections);
            return { ok: true, value: { version: NATIVE_HOST_CONTRACT_VERSION, revision: manageRevision(), ...view } };
        },


        getManageSettingsList(input: { list: ManageListName; offset: number; limit: number; revision: string }): NativeHostResult<{
            version: typeof NATIVE_HOST_CONTRACT_VERSION;
            revision: string;
            list: ManageListName;
            total: number;
            items: (NativeManageAreaRow | NativeManagePersonRow | NativeManageValueRow)[];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !['areas', 'people', 'contexts', 'tags'].includes(input.list as string)
                || typeof input.revision !== 'string' || !isPaging(input)) {
                return fail('INVALID_INPUT', 'A list, a valid window and the Manage revision are required');
            }
            const revision = manageRevision();
            if (input.revision !== revision) return fail('STALE_REVISION', 'Manage changed; read it again');
            const items = buildManage(null).lists[input.list as ManageListName];
            return {
                ok: true,
                value: { version: NATIVE_HOST_CONTRACT_VERSION, revision, list: input.list as ManageListName, total: items.length, items: page(items, input) },
            };
        },


        checkManageEditor(input: { target: NativeManageEditorTarget; name: string }): NativeHostResult<{
            nameTaken: boolean;
            saveDisabled: boolean;
            message: string | null;
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const target = isObjectRecord(input) ? readEditorTarget(input.target) : null;
            if (!target || !isText(input.name, 500)) return fail('INVALID_INPUT', 'An editor target and the name as typed are required');
            const { areas } = useTaskStore.getState();
            const t = deps.t();
            const nameTaken = isManageAreaNameTaken(target.type, input.name, areas);
            const tokenKind = target.type === 'newContext' || target.type === 'context' ? 'context'
                : target.type === 'newTag' || target.type === 'tag' ? 'tag' : null;
            return {
                ok: true,
                value: {
                    nameTaken,
                    saveDisabled: isManageEditorSaveDisabled(target.type, input.name, areas)
                        || (tokenKind !== null && !normalizeTaxonomyToken(tokenKind, input.name)),
                    message: nameTaken ? getManageEditorText(t, target.type, manageUntranslated(t)).nameTaken : null,
                },
            };
        },


        async saveManageEditor(input: {
            requestId: string;
            target: NativeManageEditorTarget;
            name?: string;
            color?: string;
            note?: string;
            referenceLink?: string;
        }): Promise<NativeHostResult<{ changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const target = isObjectRecord(input) ? readWriteTarget(input.target) : null;
            if (!target || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || (input.name !== undefined && !isText(input.name, 500))
                || (input.color !== undefined && !isText(input.color, 50))
                || (input.note !== undefined && !isText(input.note, 10_000))
                || (input.referenceLink !== undefined && !isText(input.referenceLink, 2000))) {
                return fail('INVALID_INPUT', 'A request UUID, an editor target (with the revision its row showed) and text fields are required');
            }
            const fields = { name: input.name ?? '', color: input.color ?? null, note: input.note ?? '', referenceLink: input.referenceLink ?? '' };
            const tokenKind = target.type === 'newContext' || target.type === 'context' ? 'context'
                : target.type === 'newTag' || target.type === 'tag' ? 'tag' : null;
            if (tokenKind && !normalizeTaxonomyToken(tokenKind, fields.name)) return fail('INVALID_INPUT', 'A context or tag name is required');
            const { requestId } = input;
            return receipts.run<{ changed: boolean }>(requestId, JSON.stringify(['manageEditor', target, fields]), async () => {


                const newId = requestId.toLowerCase();
                const { _allAreas, _allPeople } = useTaskStore.getState();
                if ((target.type === 'newArea' && _allAreas.some((area) => area.id === newId))
                    || (target.type === 'newPerson' && _allPeople.some((person) => person.id === newId))) {
                    return { ok: true, value: { changed: false } };
                }
                const resolved = resolveTarget(target);
                if (!resolved) return fail('INVALID_INPUT', 'That item is not available');
                const draft = { ...getManageEditorDraft(resolved), name: fields.name, note: fields.note, referenceLink: fields.referenceLink };
                if (fields.color !== null) {

                    if (!(AREA_PRESET_COLORS as readonly string[]).includes(fields.color) && fields.color !== draft.color) {
                        return fail('INVALID_INPUT', 'That color is not offered');
                    }
                    draft.color = fields.color;
                }
                const plan = planManageEditorSave(resolved, draft, useTaskStore.getState().settings);
                if (!plan) return fail('INVALID_INPUT', 'A name is required');
                const writes = pendingWrites(plan);
                if (writes.length === 0) return { ok: true, value: { changed: false } };
                const refused = refuseStaleTarget(target);
                if (refused) return refused;
                const before = storeData();
                const written = await runStoreWrite(async () => {
                    const results = [];
                    for (const write of writes) results.push(await runEditorWrite(write, newId));
                    return results;
                });

                return settleWrite(written, { changed: storeData().some((data, index) => data !== before[index]) });
            });
        },


        async deleteManageItem(input: { requestId: string; target: NativeManageDeleteTarget; ifUnused?: true }): Promise<NativeHostResult<{ changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const target = isObjectRecord(input) ? readWriteTarget(input.target) : null;
            if (!target || (target.type !== 'area' && target.type !== 'person' && target.type !== 'context' && target.type !== 'tag')
                || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || (input.ifUnused !== undefined && (input.ifUnused !== true || target.type !== 'area'))) {
                return fail('INVALID_INPUT', 'A request UUID and an area, person, context or tag, with the revision its row showed, are required');
            }
            const ifUnused = input.ifUnused === true;
            return receipts.run<{ changed: boolean }>(input.requestId, JSON.stringify(ifUnused ? ['manageDelete', target, 'ifUnused'] : ['manageDelete', target]), async () => {
                const state = useTaskStore.getState();
                const present = target.type === 'area'
                    ? state.areas.some((area) => area.id === target.id)
                    : target.type === 'person'
                        ? state.people.some((person) => person.id === target.id)
                        : target.type === 'context' ? contextCarried(target.name) : tagCarried(target.name);
                if (!present) return { ok: true, value: { changed: false } };
                const refused = refuseStaleTarget(target);
                if (refused) return refused;
                if (ifUnused && target.type === 'area' && countLiveProjectsByArea(state._allProjects).has(target.id))
                    return fail('STALE_REVISION', 'A project uses this area now; refresh before deleting it');
                const written = await runStoreWrite(() => {
                    switch (target.type) {
                        case 'area': return state.deleteArea(target.id);
                        case 'person': return state.deletePerson(target.id);
                        case 'context': return state.deleteContext(target.name);
                        default: return state.deleteTag(target.name);
                    }
                });
                return settleWrite(written, { changed: true });
            });
        },


        getNotificationsSettings(): NativeHostResult<NativeNotificationsSettings> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const capture = deps.persistentCapture?.() ?? null;
            const model = notificationsModel(capture ? { enabled: persistentCaptureOn(capture) } : null);
            return { ok: true, value: { version: NATIVE_HOST_CONTRACT_VERSION, revision: manageRevision(), ...model } };
        },


        async setNotificationsSetting(input: { requestId: string; edit: NotificationsSettingsEdit }): Promise<NativeHostResult<NativeNotificationsWriteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const edit = isObjectRecord(input) ? readNotificationsEdit(input.edit) : null;
            const capture = deps.persistentCapture?.() ?? null;
            if (!edit || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || (edit.type === 'persistentCapture' && !capture)) {
                return fail('INVALID_INPUT', 'A request UUID and an edit the Notifications screen offers are required');
            }
            return receipts.run<NativeNotificationsWriteResult>(input.requestId, JSON.stringify(['notifications', edit]), async () => {
                if (edit.type === 'persistentCapture') {
                    const enabled = edit.value as boolean;
                    let changed = false;
                    try {
                        if (capture!.read() !== enabled) {
                            capture!.write(enabled);
                            changed = true;
                        }
                    } catch (error) {
                        return fail('ACTION_FAILED', error instanceof Error ? error.message : String(error));
                    }
                    return { ok: true, value: { changed, deviceWrites: [], persistentCapture: { post: enabled ? notificationsModel(null).persistentCaptureNotification : null } } };
                }
                const settings = useTaskStore.getState().settings;
                if (isNotificationsSettingStored(settings, edit)) return { ok: true, value: { changed: false, deviceWrites: [] } };
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(buildNotificationsSettingsUpdate(edit)!));
                return settleWrite(written, { changed: true, deviceWrites: [] });
            });
        },


        getPersistentCaptureNotification(): NativeHostResult<NativePersistentCaptureNotification> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const capture = deps.persistentCapture?.() ?? null;
            if (!capture) return { ok: true, value: { post: null } };
            let on: boolean;
            try {
                on = capture.read();
            } catch {
                return fail('ACTION_FAILED', 'The persistent capture switch could not be read');
            }
            return { ok: true, value: { post: on ? notificationsModel(null).persistentCaptureNotification : null } };
        },


        getDataSettings(): NativeHostResult<NativeDataSettings> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const model = buildDataSettingsModel(useTaskStore.getState().settings, deps.t(), heartbeat() !== null, deps.language());
            return { ok: true, value: { version: NATIVE_HOST_CONTRACT_VERSION, revision: manageRevision(), ...model } };
        },


        getArchiveRetentionReview(input: { days: number }): NativeHostResult<{ review: ArchiveRetentionReview | null; edit: DataSettingsEdit }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isArchiveRetentionDays(input.days)) {
                return fail('INVALID_INPUT', 'Archive retention must be an integer from 0 to 36500 days');
            }
            const state = useTaskStore.getState();
            return { ok: true, value: { review: buildArchiveRetentionReview(
                { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections, settings: state.settings },
                input.days, deps.t()), edit: { type: 'archiveRetentionDays', value: input.days } } };
        },


        async runArchiveRetention(input: { editorOpen: boolean; selectedBackend: string | null }): Promise<NativeHostResult<NativeArchiveRetentionRun>> {
            if (!isObjectRecord(input) || typeof input.editorOpen !== 'boolean'
                || (input.selectedBackend !== null && typeof input.selectedBackend !== 'string')) {
                return fail('INVALID_INPUT', 'An editor state and a selected sync backend are required');
            }
            const none = { tasks: 0, projects: 0, sections: 0 };
            let run: NativeArchiveRetentionRun;
            if (input.editorOpen) run = { outcome: 'skipped', purged: none, skipped: 'editor-open' };
            else if (!deps.readiness().ok) run = { outcome: 'skipped', purged: none, skipped: 'not-ready' };
            else {
                const result = await useTaskStore.getState().runArchiveRetention({ syncConfigured: input.selectedBackend !== 'off' });
                const purged = result.purged ?? none;
                run = !result.success ? { outcome: 'failed', purged: none, skipped: null }
                    : result.skipped ? { outcome: 'skipped', purged: none, skipped: result.skipped }
                        : { outcome: purged.tasks || purged.projects || purged.sections ? 'purged' : 'unchanged', purged, skipped: null };
            }
            const logged = `${run.outcome}/${run.skipped}`;
            if (run.outcome === 'purged' || logged !== lastRetentionLine) {
                lastRetentionLine = logged;
                logInfo('Native archive retention ran', { scope: 'store', category: 'storage', context: {
                    releaseCheck: 'v1.3.8/native-archive-retention', outcome: run.outcome, skipped: run.skipped ?? 'none',
                    taskCount: run.purged.tasks, projectCount: run.purged.projects, sectionCount: run.purged.sections,
                } });
            }
            return { ok: true, value: run };
        },


        getDataBackup(format: 'json' | 'csv' | 'tasknotes' = 'json'): NativeHostResult<{ fileName: string; content: string; encoding: 'utf8' | 'base64' }> {
            if (format !== 'json' && format !== 'csv' && format !== 'tasknotes') return fail('INVALID_INPUT', 'Unsupported export format');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (isSandboxMode() || isWorkspaceTransitionActive()) {
                return fail('NOT_READY', 'Backup export requires a stable personal workspace');
            }
            const persistence = getPersistenceStatus();
            if (persistence.queued || persistence.inFlight || persistence.immediate || persistence.retrying || persistence.failed) {
                return fail('NOT_READY', 'Backup export is unavailable while saving is pending');
            }
            try {
                const snapshot = getInMemoryAppDataSnapshot();
                if (format === 'tasknotes') {
                    return { ok: true, value: {
                        fileName: createBackupFileName().replace(/\.json$/u, '-tasknotes.zip'),
                        content: bytesToBase64(buildTaskNotesExportZip(snapshot).zip),
                        encoding: 'base64',
                    } };
                }
                return { ok: true, value: {
                    fileName: createBackupFileName().replace(/\.json$/u, format === 'csv' ? '.csv' : '.json'),
                    content: format === 'csv'
                        ? serializeMindwtrCsv(snapshot)
                        : serializeBackupData(snapshot),
                    encoding: 'utf8',
                } };
            } catch {

                return fail('ACTION_FAILED', 'Could not prepare the backup');
            }
        },


        async seedGettingStarted(input: { requestId: string; language: string }): Promise<NativeHostResult<{ projectId: string | null }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || typeof input.language !== 'string' || !isSupportedLanguage(input.language)) {
                return fail('INVALID_INPUT', 'A request UUID and a supported language are required');
            }
            const { language } = input;
            let outcome: 'created' | 'repaired' | 'unchanged' | null = null;
            const result = await receipts.run<{ projectId: string | null }>(input.requestId, JSON.stringify(['gettingStarted', language]), async () => {
                const before = useTaskStore.getState();
                const known = new Set(before._allProjects.map((project) => project.id));
                let projectId: string | null = null;
                const written = await runStoreWrite(async () => {
                    const seeded = await useTaskStore.getState().seedGettingStarted({ language, awaitSave: false });
                    projectId = seeded.id ?? null;
                    return seeded;
                });
                const after = useTaskStore.getState();
                outcome = projectId !== null && !known.has(projectId) ? 'created'
                    : after._allTasks !== before._allTasks || after._allProjects !== before._allProjects ? 'repaired' : 'unchanged';
                return settleWrite(written, { projectId });
            });

            if (result.ok && outcome) {
                logInfo('Native Getting Started seeded', { scope: 'onboarding', context: { releaseCheck: 'v1.3.7/native-getting-started', outcome } });
            }
            return result;
        },


        async setDataSetting(input: { requestId: string; edit: DataSettingsEdit }): Promise<NativeHostResult<NativeSettingsWriteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const edit = isObjectRecord(input) ? readDataEdit(input.edit, heartbeat() !== null) : null;
            if (!edit || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A request UUID and a Data switch\'s edit are required');
            }
            return receipts.run<NativeSettingsWriteResult>(input.requestId, JSON.stringify(['data', edit]), async () => {
                const settings = useTaskStore.getState().settings;
                if (isDataSettingStored(settings, edit)) return { ok: true, value: { changed: false, deviceWrites: [] } };

                if (edit.type === 'archiveRetentionDays') {
                    return settleWrite(await runStoreWrite(() => useTaskStore.getState().setArchiveRetentionDays(edit.value)), { changed: true, deviceWrites: [] });
                }
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(buildDataSettingsUpdate(settings, edit)));
                if (written.ok && edit.type === 'debugLogging' && edit.value) logInfo('Debug logging enabled', { scope: 'diagnostics', force: true });


                const bound = edit.type === 'analyticsOptOut' && written.ok ? heartbeat() : null;
                if (bound) {
                    const follow = edit.value ? sendMobileAnalyticsOptOut(bound.config, bound.device) : resetHeartbeatOptOutMarker(bound.device.storage);
                    void follow.catch(() => undefined);
                    logInfo('Native analytics opt-out changed', { scope: 'analytics', context: { releaseCheck: 'v1.3.5/native-analytics-opt-out', optedOut: String(edit.value) } });
                }
                return settleWrite(written, { changed: true, deviceWrites: [] });
            });
        },
    };
}
