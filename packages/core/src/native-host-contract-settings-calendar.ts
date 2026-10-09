/**
 * The native host contract for Settings › Advanced › Calendar (React Native's
 * `calendar-settings-screen.tsx`) and for the external calendars the Calendar
 * screen and the reviews show. Kept in its own file and spread into
 * createNativeHostContract. The rules are core's: the screen's
 * (calendar-settings-model.ts), the feeds and device calendar reads
 * (external-calendar-feeds.ts) and the push options (calendar-push-service.ts),
 * the same code React Native runs.
 *
 * A host binds its device through `NativeCalendarHost` (createNativeHostContract's
 * `calendar` option): RN's key-value store with RN's keys, `fetch`, local .ics
 * reads, the device calendars (CalendarContract on Android) and the app log.
 * Calendar push itself (creating the Mindwtr calendar, writing events) needs the
 * calendar writes and the calendar_sync table; until a host binds them, turning
 * push on, a new Mindwtr calendar color and deleting the Mindwtr calendar answer
 * ACTION_FAILED, and the push card still shows the stored options.
 *
 * One visit is one screen, as on React Native: openCalendarSettings reads the
 * device (push options and permission, the device calendar choices and list,
 * the subscriptions), closeCalendarSettings ends the visit, getCalendarSettings
 * reads the view. Screen state the host keeps, reset on every visit: whether the
 * push card and the device calendar card are open (a command's `open` opens
 * one), which Area choice is open (its `key`; one at a time), and the name and
 * URL drafts (send them as `draft`; a command's `clearDraft` empties both). The
 * host runs the system document picker for "Choose local .ics file" and sends
 * the picked file with addCalendarFeed; a cancelled pick sends nothing. Delete
 * Mindwtr calendar asks first with `push.target.delete.confirm`.
 *
 * Toasts are React Native's, in order: each command answers the toasts shown
 * since the last answer (`toasts`).
 *
 * Replay rules. Every write takes a request UUID (native-request-receipts.ts):
 * while its save is owed a retry only saves. A new subscription is
 * addCalendarFeed; its URL may carry a password, so it is never journaled and
 * keeps only a hash of its input. Every other write is setCalendarSetting with an
 * edit the view gave, journaled. Its receipt is durable on the native host, device
 * writes included, so a replay of a request that landed answers its first reply
 * and runs nothing. Where no receipt was kept (a death before it committed), each
 * is target-state or compare-and-set, so a replay writes nothing wrong: a subscription added takes the
 * request UUID as its ID (a retry finds it), a subscription removed is gone, and every
 * subscription edit carries the list's `revision` (the synced list's write
 * stamp) and answers STALE_REVISION once the list changed since; the push switch
 * carries the value it showed (`before`), and the push calendar and color compare
 * the stored value, the device calendar choices compare the whole stored choice,
 * and Delete Mindwtr calendar is resumable: its target is push off and no Mindwtr
 * calendar of the app's own, so a replay finishes a delete cut short; it carries
 * the saved calendar ID and creation intent revision the view showed, and a Mindwtr
 * calendar made since is never deleted (STALE_REVISION). A late refusal may leave
 * push off, but preserves that calendar. A delete the device refuses answers ACTION_FAILED and
 * keeps the calendar and its saved ID for a retry. No log line carries a URL or an
 * event title.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the
 * import cycle between the two files is safe.
 */
import {
    CALENDAR_PUSH_CALENDAR_ID_KEY,
    CALENDAR_PUSH_CREATION_INTENT_KEY,
    CALENDAR_PUSH_PENDING_KEY,
    CalendarPushOwnershipChangedError,
    createCalendarPushService,
    DEFAULT_CALENDAR_PUSH_COLOR,
    matchesCalendarPushCreationIntentRevision,
    normalizeCalendarPushColor,
    type CalendarPushService,
    type CalendarPushServiceHost,
    type CalendarPushTargetCalendar,
    type DeviceCalendarWriter,
} from './calendar-push-service';
import {
    addCalendarFeed,
    addCalendarFile,
    buildCalendarAreaChoice,
    buildCalendarPushTargetChoices,
    calendarSettingsToasts,
    getCalendarFeedColorOptions,
    getCalendarPushColorDescription,
    getCalendarPushColorLabel,
    getCalendarPushColorOptions,
    getCalendarTestRange,
    keptPushTargetEvents,
    maskCalendarFeedUrl,
    nextDeviceCalendarSelection,
    planCalendarPushColor,
    pruneDeviceCalendarSelection,
    removeCalendarFeed,
    resolveCalendarFeedsOnLoad,
    setCalendarFeedColor,
    setCalendarFeedEnabled,
    toggleCalendarAreaId,
    type CalendarSettingsToast,
} from './calendar-settings-model';
import { getDocsGuideUrl } from './docs-guidance';
import {
    createExternalCalendarFeeds,
    EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS,
    normalizeSystemCalendarSettings,
    type DeviceCalendarReader,
    type ExternalCalendarFeeds,
    type SystemCalendarInfo,
    type SystemCalendarPermissionStatus,
    type SystemCalendarSettings,
} from './external-calendar-feeds';
import { resolveI18nText, type I18nTemplateValues } from './i18n';
import type { Language } from './i18n/i18n-types';
import { taskEditValuesEqual } from './json-value-equality';
import type { ExternalCalendarSubscription } from './ics';
import { NATIVE_HOST_CONTRACT_VERSION, type NativeHostResult } from './native-host-contract';
import type { NativeCalendarFeed } from './native-host-contract-calendar';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, type NativeUnsavedWrite } from './native-request-receipts';
import { useTaskStore } from './store';
import { themeDescriptor } from './theme-scheme';
import { deterministicHash128Hex } from './uuid';

type Translate = (key: string) => string;

/** What a host binds for the external calendars and Settings › Calendar. */
export type NativeCalendarHost = {
    platform: { os: 'android' | 'ios' };
    /** RN's key-value store (RKStorage on Android), with RN's keys. Durable when a write resolves. */
    storage: CalendarPushServiceHost['storage'];
    fetch: typeof fetch;
    /** Reads a local subscription: a `file://` or `content://` URL the document picker gave. */
    readLocalFile(url: string): Promise<string>;
    /** The device calendar reads; the writes once the host has calendar push. */
    calendars: DeviceCalendarReader & Partial<Omit<DeviceCalendarWriter, keyof DeviceCalendarReader>>;
    /** This device's pushed-event map (the calendar_sync table); absent until the host has calendar push. */
    syncEntries?: CalendarPushServiceHost['syncEntries'];
    /** The app log; no line carries a URL or an event title. */
    log: CalendarPushServiceHost['log'];
};

export type CalendarSettingsDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    language: () => Language;
    requestIdPattern: RegExp;
    host: () => NativeCalendarHost | null;
};

export type NativeCalendarToast = { title: string; message: string; tone: CalendarSettingsToast['tone']; durationMs: number | null };

type Permission = SystemCalendarPermissionStatus;

export type NativeCalendarSettingsEdit =
    | { type: 'push'; before: boolean; enabled: boolean }
    | { type: 'pushTarget'; before: string | null; calendarId: string | null }
    | { type: 'pushColor'; before: string; color: string }
    | { type: 'deleteMindwtrCalendar'; calendarId: string | null; creationIntentRevision?: string | null }
    | { type: 'deviceCalendars'; before: SystemCalendarSettings; value: SystemCalendarSettings }
    | { type: 'feed'; feedId: string; field: 'enabled'; value: boolean; revision: string }
    | { type: 'feed'; feedId: string; field: 'color'; value: string | null; revision: string }
    | { type: 'feed'; feedId: string; field: 'areaIds'; value: string[]; revision: string }
    | { type: 'removeFeed'; feedId: string; revision: string };

/** addCalendarFeed's input: a subscription URL, or a local .ics file the picker gave. */
export type NativeCalendarFeedAdd =
    | { requestId: string; name: string; url: string; revision: string }
    | { requestId: string; name: string; fileName: string | null; uri: string; revision: string };

function isFeedAdd(input: unknown): input is NativeCalendarFeedAdd {
    if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !isText(input.name, 500) || !isText(input.revision, 200)) return false;
    const keys = Object.keys(input).sort().join(',');
    if (keys === 'name,requestId,revision,url') return isText(input.url, 4000) && input.url.trim().length > 0;
    return keys === 'fileName,name,requestId,revision,uri' && (input.fileName === null || isText(input.fileName, 500))
        && isText(input.uri, 4000) && input.uri.trim().length > 0;
}

/** An Area choice (#1305): `key` is its source; the host keeps one open at a time. */
export type NativeCalendarAreaChoice = {
    key: string;
    label: string;
    options: { areaId: string; label: string; checked: boolean; edit: NativeCalendarSettingsEdit }[];
};

export type NativeCalendarSettings = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    title: string;
    push: {
        title: string;
        description: string;
        enabled: boolean;
        /** The switch's edit. */
        toggle: NativeCalendarSettingsEdit;
        /** While open and on: access denied (text), or the calendar choice (`target`). */
        denied: string | null;
        target: null | {
            title: string;
            description: string;
            localHint: string | null;
            sharedAccountHint: string | null;
            /** The calendars are loading (a spinner in place of the options). */
            loading: boolean;
            options: { key: string; name: string; description: string; color: string | null; selected: boolean; accessibilityLabel: string; edit: NativeCalendarSettingsEdit }[];
            colors: null | {
                title: string;
                description: string;
                options: { color: string; selected: boolean; accessibilityLabel: string; edit: NativeCalendarSettingsEdit }[];
            };
            refresh: { label: string; description: string };
            delete: {
                label: string;
                description: string;
                busy: boolean;
                confirm: { title: string; message: string; cancel: string; confirm: string };
                edit: NativeCalendarSettingsEdit;
            };
        };
    };
    device: {
        title: string;
        description: string;
        enabled: boolean;
        toggle: NativeCalendarSettingsEdit;
        /** While open and on, without access: why, and Grant access (grantDeviceCalendarAccess). */
        access: null | { text: string; grantLabel: string };
        loading: boolean;
        /** "No device calendars found." */
        empty: string | null;
        calendars: { id: string; name: string; subtitle: string; selected: boolean; edit: NativeCalendarSettingsEdit | null; areas: NativeCalendarAreaChoice | null }[];
    };
    feeds: {
        title: string;
        description: string;
        guide: { title: string; description: string; url: string };
        name: { label: string; placeholder: string };
        url: { label: string; placeholder: string };
        /** Add: enabled once the URL draft has text; it sends addCalendarFeed with the drafts and `revision`. */
        add: { label: string; enabled: boolean };
        test: { label: string };
        /** Choose local .ics file: the host picks, then sends addCalendarFeed with the name draft, the file's name and URI, and `revision`. */
        chooseFile: { label: string };
        /** The list's revision, which every subscription edit and addCalendarFeed carries. */
        revision: string;
        /** "External calendars", while there is a subscription. */
        listTitle: string | null;
        items: {
            id: string;
            name: string;
            /** The URL masked, never its credentials. */
            url: string;
            enabled: boolean;
            toggle: NativeCalendarSettingsEdit;
            areas: NativeCalendarAreaChoice | null;
            colors: { color: string | null; fill: string | null; selected: boolean; accessibilityLabel: string; edit: NativeCalendarSettingsEdit | null }[];
            remove: { label: string; edit: NativeCalendarSettingsEdit };
        }[];
    };
};

export type NativeCalendarCommandResult = {
    changed: boolean;
    toasts: NativeCalendarToast[];
    /** A card the screen opens (React Native opens it when its switch turns on). */
    open: 'push' | 'device' | null;
    /** Empty the name and URL drafts. */
    clearDraft: boolean;
};

/** The screens that each keep their own feed load (a newer range replaces the running one). */
export const NATIVE_CALENDAR_FEED_SLOTS = ['calendar', 'weeklyReview', 'dailyReview'] as const;
export type NativeCalendarFeedSlot = typeof NATIVE_CALENDAR_FEED_SLOTS[number];

type Session = {
    host: NativeCalendarHost;
    push: {
        enabled: boolean;
        permission: Permission;
        targetId: string | null;
        targets: CalendarPushTargetCalendar[];
        color: string;
        loading: boolean;
        deleting: boolean;
    };
    device: { settings: SystemCalendarSettings; permission: Permission; calendars: SystemCalendarInfo[]; loading: boolean };
    storedFeeds: ExternalCalendarSubscription[];
};

type Draft = { name?: string; url?: string };

const DEVICE_CALENDAR_SOURCE = (calendarId: string) => `system:${calendarId}`;
const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function isSystemCalendarSettings(value: unknown): value is SystemCalendarSettings {
    if (!isObjectRecord(value) || typeof value.enabled !== 'boolean' || typeof value.selectAll !== 'boolean'
        || !Array.isArray(value.selectedCalendarIds) || !value.selectedCalendarIds.every((id) => isText(id, 500))) return false;
    const areas = value.areaIdsByCalendar;
    return areas === undefined || (isObjectRecord(areas)
        && Object.values(areas).every((ids) => Array.isArray(ids) && ids.every((id) => isText(id, 200))));
}

export type NativeDeviceCalendarSettingsEdit = Extract<NativeCalendarSettingsEdit, { type: 'deviceCalendars' }>;

/** Shared RN/native device-choice plan; provider access and storage are caller-owned. */
export function planDeviceCalendarSetting(stored: SystemCalendarSettings, edit: NativeDeviceCalendarSettingsEdit): NativeHostResult<{
    settings: SystemCalendarSettings; result: NativeCalendarCommandResult;
}> {
    const current = normalizeSystemCalendarSettings(stored);
    const settings = normalizeSystemCalendarSettings(edit.value);
    const changed = !taskEditValuesEqual(current, settings);
    if (changed && !taskEditValuesEqual(current, normalizeSystemCalendarSettings(edit.before))) {
        return fail('STALE_REVISION', 'The device calendar choices changed since the view showed them; read the view again');
    }
    return { ok: true, value: { settings, result: {
        changed, toasts: [], open: changed && settings.enabled && !current.enabled ? 'device' : null, clearDraft: false,
    } } };
}

function isEdit(edit: unknown): edit is NativeCalendarSettingsEdit {
    if (!isObjectRecord(edit)) return false;
    const keys = Object.keys(edit).sort().join(',');
    switch (edit.type) {
        case 'push': return keys === 'before,enabled,type' && typeof edit.before === 'boolean' && typeof edit.enabled === 'boolean';
        case 'pushTarget': return keys === 'before,calendarId,type'
            && (edit.before === null || isText(edit.before, 500)) && (edit.calendarId === null || isText(edit.calendarId, 500));
        case 'pushColor': return keys === 'before,color,type' && isText(edit.before, 20) && isText(edit.color, 20);
        case 'deleteMindwtrCalendar': return (keys === 'calendarId,type' || keys === 'calendarId,creationIntentRevision,type')
            && (edit.calendarId === null || isText(edit.calendarId, 500))
            && (!('creationIntentRevision' in edit) || edit.creationIntentRevision === null
                || (typeof edit.creationIntentRevision === 'string' && /^[0-9a-f]{32}$/.test(edit.creationIntentRevision)));
        case 'deviceCalendars': return keys === 'before,type,value' && isSystemCalendarSettings(edit.before) && isSystemCalendarSettings(edit.value);
        case 'removeFeed': return keys === 'feedId,revision,type' && isText(edit.revision, 200) && isText(edit.feedId, 500);
        case 'feed': {
            if (keys !== 'feedId,field,revision,type,value' || !isText(edit.revision, 200) || !isText(edit.feedId, 500)) return false;
            if (edit.field === 'enabled') return typeof edit.value === 'boolean';
            if (edit.field === 'color') return edit.value === null || isText(edit.value, 20);
            if (edit.field === 'areaIds') return Array.isArray(edit.value) && edit.value.length <= 500 && edit.value.every((id) => isText(id, 200));
            return false;
        }
        default: return false;
    }
}

const unavailable = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available on this host yet`);
};

/** Whether the host bound calendar push: the calendar writes and the calendar_sync table. */
const hasCalendarPush = (host: NativeCalendarHost): boolean => Boolean(host.syncEntries)
    && (['getSources', 'createCalendar', 'deleteCalendar', 'createEvent', 'updateEvent', 'deleteEvent'] as const)
        .every((name) => typeof host.calendars[name] === 'function');

export function createCalendarSettingsMethods(deps: CalendarSettingsDeps) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });
    const toasts: NativeCalendarToast[] = [];
    let session: Session | null = null;
    let bound: { host: NativeCalendarHost; feeds: ExternalCalendarFeeds; push: CalendarPushService } | null = null;
    type FeedLoad = Promise<NativeHostResult<NativeCalendarFeed>>;
    const feedLoads = new Map<NativeCalendarFeedSlot, { key: string; controller: AbortController; running: FeedLoad | null; last: FeedLoad; refreshedAt: number }>();

    /** Core's feeds and push for this host, made on first use. */
    const device = (host: NativeCalendarHost) => {
        if (bound?.host === host) return bound;
        const syncEntries = host.syncEntries ?? {
            ensureReady: unavailable('Calendar push'),
            get: async () => null,
            upsert: unavailable('Calendar push'),
            delete: unavailable('Calendar push'),
            getAll: async () => [],
        };
        const calendars = host.calendars;
        bound = {
            host,
            feeds: createExternalCalendarFeeds({
                platform: () => host.platform.os,
                storage: host.storage,
                fetch: host.fetch,
                readLocalFile: (url) => host.readLocalFile(url),
                calendars,
                getAllCalendarSyncEntries: (platform) => syncEntries.getAll(platform),
                logInfo: (message, context) => host.log.info(message, context),
            }),
            push: createCalendarPushService({
                platform: host.platform.os,
                os: () => host.platform.os,
                storage: host.storage,
                calendars: {
                    getPermissions: () => calendars.getPermissions(),
                    requestPermissions: () => calendars.requestPermissions(),
                    getCalendars: () => calendars.getCalendars(),
                    getEvents: (ids, start, end) => calendars.getEvents(ids, start, end),
                    getSources: calendars.getSources ? () => calendars.getSources!() : unavailable('Calendar push'),
                    createCalendar: calendars.createCalendar ? (details) => calendars.createCalendar!(details) : unavailable('Calendar push'),
                    ...(calendars.updateCalendar ? { updateCalendar: (id: string, details: { color: string }) => calendars.updateCalendar!(id, details) } : {}),
                    deleteCalendar: calendars.deleteCalendar ? (id) => calendars.deleteCalendar!(id) : unavailable('Calendar push'),
                    createEvent: calendars.createEvent ? (id, details) => calendars.createEvent!(id, details) : unavailable('Calendar push'),
                    updateEvent: calendars.updateEvent ? (id, details) => calendars.updateEvent!(id, details) : unavailable('Calendar push'),
                    deleteEvent: calendars.deleteEvent ? (id) => calendars.deleteEvent!(id) : unavailable('Calendar push'),
                },
                syncEntries,
                log: host.log,
                store: useTaskStore,
            }),
        };
        return bound;
    };

    const translators = () => {
        const t = deps.t();
        const tr = (key: string, values?: I18nTemplateValues) => resolveI18nText(t, key, { values });
        return { t, tr, toastsOf: calendarSettingsToasts(tr, t) };
    };
    const showToast = (toast: CalendarSettingsToast) => {
        toasts.push({ title: toast.title, message: toast.message, tone: toast.tone, durationMs: toast.durationMs ?? null });
    };
    const takeToasts = (): NativeCalendarToast[] => toasts.splice(0, toasts.length);
    const logError = (current: Session, error: unknown) => {
        try {
            current.host.log.error(error, { scope: 'calendar-settings', extra: {} });
        } catch { /* The log cannot fail a command. */ }
    };

    /** The subscriptions the screen shows: the synced list, else the device copy (React Native's rule). */
    const shownFeeds = (current: Session): ExternalCalendarSubscription[] => {
        const synced = useTaskStore.getState().settings.externalCalendars;
        return Array.isArray(synced) ? synced : current.storedFeeds;
    };
    /**
     * The list's revision, which every subscription edit compares: the synced list's
     * write stamp (each write, here or synced, moves it on), or the device copy itself.
     */
    const feedsRevision = (current: Session): string => {
        const settings = useTaskStore.getState().settings;
        return Array.isArray(settings.externalCalendars)
            ? `synced:${settings.syncPreferencesUpdatedAt?.externalCalendars ?? ''}`
            : `device:${deterministicHash128Hex(JSON.stringify(current.storedFeeds))}`;
    };

    // React Native's loads: loadCalendarPushTargetState, loadSystemCalendarState and the feeds effect.
    const loadPushTargets = async (current: Session) => {
        const { push } = device(current.host);
        current.push.loading = true;
        try {
            const [targetId, targets, color] = await Promise.all([
                push.getCalendarPushTargetCalendarId(),
                push.getCalendarPushTargetCalendars(),
                push.getCalendarPushColor(),
            ]);
            current.push.targetId = targetId;
            current.push.targets = targets;
            current.push.color = color;
        } catch (error) {
            logError(current, error);
            showToast(translators().toastsOf.loadWritableCalendarsFailed());
        } finally {
            current.push.loading = false;
        }
    };

    const loadPush = async (current: Session) => {
        const { push } = device(current.host);
        const [enabled, permission] = await Promise.all([push.getCalendarPushEnabled(), push.getCalendarWritePermissionStatus()]);
        current.push.enabled = enabled;
        current.push.permission = permission;
        if (permission === 'granted') {
            await loadPushTargets(current);
        } else {
            current.push.targetId = await push.getCalendarPushTargetCalendarId();
        }
    };

    const loadDevice = async (current: Session, requestAccess = false) => {
        const { feeds } = device(current.host);
        current.device.loading = true;
        try {
            const stored = await feeds.getSystemCalendarSettings();
            current.device.settings = { ...stored, areaIdsByCalendar: stored.areaIdsByCalendar ?? {} };
            const permission = requestAccess
                ? await feeds.requestSystemCalendarPermission()
                : await feeds.getSystemCalendarPermissionStatus();
            current.device.permission = permission;
            if (permission !== 'granted') {
                current.device.calendars = [];
                return;
            }
            const calendars = await feeds.getSystemCalendars();
            current.device.calendars = calendars;
            const filteredSelection = pruneDeviceCalendarSelection(stored, calendars.map((calendar) => calendar.id));
            if (!filteredSelection) return;
            current.device.settings = { ...current.device.settings, selectedCalendarIds: filteredSelection };
            await feeds.saveSystemCalendarSettings({
                enabled: stored.enabled,
                selectAll: false,
                selectedCalendarIds: filteredSelection,
                areaIdsByCalendar: stored.areaIdsByCalendar,
            });
        } catch (error) {
            logError(current, error);
            showToast(translators().toastsOf.loadDeviceCalendarsFailed());
        } finally {
            current.device.loading = false;
        }
    };

    const loadFeeds = async (current: Session) => {
        const { feeds } = device(current.host);
        try {
            const stored = await feeds.getExternalCalendars();
            current.storedFeeds = stored;
            const shown = resolveCalendarFeedsOnLoad(useTaskStore.getState().settings.externalCalendars, stored);
            if (shown.saveDeviceCopy) await feeds.saveExternalCalendars(shown.feeds);
        } catch (error) {
            logError(current, error);
            showToast(translators().toastsOf.loadSavedCalendarsFailed());
        }
    };

    /** The saved ID and intent revision of the app's Mindwtr calendar as the view shows it: what Delete compares. */
    let shownCalendarId: string | null = null;
    let shownCreationIntentRevision: string | null = null;

    const buildView = (current: Session, draft: Draft): NativeCalendarSettings => {
        const { t, tr } = translators();
        const settings = useTaskStore.getState().settings;
        const areas = useTaskStore.getState().areas;
        const themePreset = themeDescriptor(settings.theme)?.statusPreset ?? 'default';
        const { push } = current;
        const choices = buildCalendarPushTargetChoices({ targets: push.targets, targetId: push.targetId, color: push.color, tr, platform: current.host.platform.os });
        const deviceSettings = current.device.settings;
        const deviceEdit = (value: SystemCalendarSettings): NativeCalendarSettingsEdit => ({
            type: 'deviceCalendars',
            before: deviceSettings,
            value: { ...value, areaIdsByCalendar: value.areaIdsByCalendar ?? {} },
        });
        const areaChoice = (key: string, selectedIds: string[], edit: (areaId: string) => NativeCalendarSettingsEdit): NativeCalendarAreaChoice | null => {
            const choice = buildCalendarAreaChoice(selectedIds, areas, t);
            return choice && { key, label: choice.label, options: choice.options.map((option) => ({ ...option, edit: edit(option.areaId) })) };
        };
        const feedsShown = shownFeeds(current);
        const revision = feedsRevision(current);
        const url = draft.url ?? '';
        const selectedDevice = new Set(deviceSettings.selectedCalendarIds);
        return {
            version: NATIVE_HOST_CONTRACT_VERSION,
            title: t('settings.calendar'),
            push: {
                title: tr('settings.calendarMobile.pushTasksToCalendar'),
                description: tr('settings.calendarMobile.scheduledTasksAndTasksWithDueDatesAreAddedTo'),
                enabled: push.enabled,
                toggle: { type: 'push', before: push.enabled, enabled: !push.enabled },
                denied: push.enabled && push.permission === 'denied' ? tr('settings.calendarMobile.calendarAccessWasDeniedPleaseGrantAccessInSettings') : null,
                target: push.enabled && push.permission === 'granted' ? {
                    title: tr('settings.calendarMobile.syncTarget'),
                    description: tr('settings.calendarMobile.chooseAnAccountCalendarIfYourCalendarAppHidesLocal'),
                    localHint: choices.localHint ? tr('settings.calendarMobile.localCalendarTargetsStayOnThisDeviceUseAGoogle') : null,
                    sharedAccountHint: choices.sharedAccountHint ? tr('settings.calendarMobile.forASeparateColorInGoogleCalendarSelectADedicated') : null,
                    loading: push.loading,
                    options: choices.options.map((option) => ({
                        key: option.id ?? 'mindwtr-managed',
                        name: option.name,
                        description: option.description,
                        color: option.color ?? null,
                        selected: option.id === push.targetId,
                        accessibilityLabel: `${option.name}. ${option.description}`,
                        edit: { type: 'pushTarget', before: push.targetId, calendarId: option.id },
                    })),
                    colors: choices.showColors ? {
                        title: getCalendarPushColorLabel(t),
                        description: getCalendarPushColorDescription(t),
                        options: getCalendarPushColorOptions(push.color, t).map((option) => ({
                            ...option,
                            edit: { type: 'pushColor', before: push.color, color: option.color },
                        })),
                    } : null,
                    refresh: {
                        label: tr('settings.calendarMobile.refreshCalendars'),
                        description: tr('settings.calendarMobile.reloadTheListAfterAddingACalendarInGoogleCalendar'),
                    },
                    delete: {
                        label: tr('settings.calendarMobile.deleteMindwtrCalendar'),
                        description: tr('settings.calendarMobile.removeTheDedicatedCalendarAndItsPushedEventsFromThis'),
                        busy: push.deleting,
                        confirm: {
                            title: tr('settings.calendarMobile.deleteMindwtrCalendar'),
                            message: tr('settings.calendarMobile.removeTheDedicatedCalendarAndItsPushedEventsFromThis'),
                            cancel: t('common.cancel'),
                            confirm: t('common.delete'),
                        },
                        edit: { type: 'deleteMindwtrCalendar', calendarId: shownCalendarId, creationIntentRevision: shownCreationIntentRevision },
                    },
                } : null,
            },
            device: {
                title: t('settings.deviceCalendars'),
                description: t('settings.deviceCalendarsDesc'),
                enabled: deviceSettings.enabled,
                toggle: deviceEdit({ ...deviceSettings, enabled: !deviceSettings.enabled }),
                access: deviceSettings.enabled && current.device.permission !== 'granted' ? {
                    text: current.device.permission === 'denied' ? t('settings.calendarAccessDenied') : t('settings.calendarAccessRequired'),
                    grantLabel: t('settings.grantCalendarAccess'),
                } : null,
                loading: current.device.loading,
                empty: deviceSettings.enabled && current.device.permission === 'granted' && !current.device.loading && current.device.calendars.length === 0
                    ? t('settings.noDeviceCalendars')
                    : null,
                calendars: deviceSettings.enabled && current.device.permission === 'granted' && !current.device.loading
                    ? current.device.calendars.map((calendar) => {
                        const selected = deviceSettings.selectAll || selectedDevice.has(calendar.id);
                        const selection = nextDeviceCalendarSelection({
                            calendarIds: current.device.calendars.map((entry) => entry.id),
                            selectAll: deviceSettings.selectAll,
                            selectedCalendarIds: deviceSettings.selectedCalendarIds,
                            calendarId: calendar.id,
                            enabled: !selected,
                        });
                        const areaIds = deviceSettings.areaIdsByCalendar ?? {};
                        return {
                            id: calendar.id,
                            name: calendar.name,
                            subtitle: t('settings.deviceCalendar'),
                            selected,
                            edit: selection ? deviceEdit({ ...deviceSettings, ...selection }) : null,
                            areas: areaChoice(DEVICE_CALENDAR_SOURCE(calendar.id), areaIds[calendar.id] ?? [], (areaId) => deviceEdit({
                                ...deviceSettings,
                                areaIdsByCalendar: { ...areaIds, [calendar.id]: toggleCalendarAreaId(areaIds[calendar.id] ?? [], areaId) },
                            })),
                        };
                    })
                    : [],
            },
            feeds: {
                title: tr('settings.calendarMobile.icsSubscriptions'),
                description: t('settings.calendarDesc'),
                guide: {
                    title: t('settings.calendarIntegrationGuideTitle'),
                    description: t('settings.calendarIntegrationGuideDesc'),
                    url: getDocsGuideUrl('use/calendar-integration', deps.language()),
                },
                name: { label: t('settings.externalCalendarName'), placeholder: tr('settings.calendarMobile.optional') },
                url: { label: t('settings.externalCalendarUrl'), placeholder: t('settings.externalCalendarUrlPlaceholder') },
                add: { label: t('settings.externalCalendarAdd'), enabled: url.trim().length > 0 },
                test: { label: tr('settings.calendarMobile.test') },
                chooseFile: { label: tr('settings.calendarMobile.chooseLocalIcsFile') },
                revision,
                listTitle: feedsShown.length > 0 ? t('settings.externalCalendars') : null,
                items: feedsShown.map((feed) => ({
                    id: feed.id,
                    name: feed.name,
                    url: maskCalendarFeedUrl(feed.url),
                    enabled: feed.enabled,
                    toggle: { type: 'feed', feedId: feed.id, field: 'enabled', value: !feed.enabled, revision },
                    areas: areaChoice(feed.id, feed.areaIds ?? [], (areaId) => ({
                        type: 'feed', feedId: feed.id, field: 'areaIds', value: toggleCalendarAreaId(feed.areaIds ?? [], areaId), revision,
                    })),
                    colors: getCalendarFeedColorOptions(feed, t, themePreset).map((option) => ({
                        ...option,
                        // Picking the color it has writes nothing (setCalendarFeedColor).
                        edit: setCalendarFeedColor([feed], feed.id, option.color ?? undefined)
                            ? { type: 'feed', feedId: feed.id, field: 'color', value: option.color, revision }
                            : null,
                    })),
                    remove: { label: t('settings.externalCalendarRemove'), edit: { type: 'removeFeed', feedId: feed.id, revision } },
                })),
            },
        };
    };

    const newSession = (host: NativeCalendarHost): Session => ({
        host,
        push: { enabled: false, permission: 'undetermined', targetId: null, targets: [], color: DEFAULT_CALENDAR_PUSH_COLOR, loading: false, deleting: false },
        device: { settings: { enabled: false, selectAll: true, selectedCalendarIds: [], areaIdsByCalendar: {} }, permission: 'undetermined', calendars: [], loading: false },
        storedFeeds: [],
    });
    /** React Native's mount: every card's device state read, as the screen opens. */
    const loadSession = (current: Session) => Promise.all([loadPush(current), loadDevice(current), loadFeeds(current), refreshShownRevision(current.host)]);

    const openedSession = (): NativeHostResult<Session> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const host = deps.host();
        if (!host) return fail('ACTION_FAILED', 'Calendars are not available on this host yet');
        if (!session || session.host !== host) return fail('ACTION_FAILED', 'Open Settings › Calendar first (openCalendarSettings)');
        return { ok: true, value: session };
    };

    const result = (changed: boolean, extra: Partial<Omit<NativeCalendarCommandResult, 'changed' | 'toasts'>> = {}): NativeHostResult<NativeCalendarCommandResult> => ({
        ok: true,
        value: { changed, toasts: [], open: extra.open ?? null, clearDraft: extra.clearDraft ?? false },
    });
    const staleFeeds = () => fail('STALE_REVISION', 'The subscriptions changed since the view showed them; read the view again');
    const refreshShownRevision = async (host: NativeCalendarHost) => {
        const [calendarId, intent] = await Promise.all([
            host.storage.getItem(CALENDAR_PUSH_CALENDAR_ID_KEY),
            host.platform.os === 'ios' ? host.storage.getItem(CALENDAR_PUSH_CREATION_INTENT_KEY) : null,
        ]);
        shownCalendarId = calendarId;
        shownCreationIntentRevision = intent === null ? null : deterministicHash128Hex(intent);
    };

    // ---------------------------------------------------------------------------
    // The edits, each as React Native's handler runs it, made replay-safe.

    const writeFeeds = async (current: Session, next: ExternalCalendarSubscription[], extra: Partial<NativeCalendarCommandResult> = {}) => {
        await device(current.host).feeds.saveExternalCalendars(next);
        current.storedFeeds = next;
        const written = await runStoreWrite(() => useTaskStore.getState().updateSettings({ externalCalendars: next }));
        return settleWrite(written, { changed: true, toasts: [] as NativeCalendarToast[], open: extra.open ?? null, clearDraft: extra.clearDraft ?? false });
    };

    /** A new subscription, named by its request UUID (a retry finds it). */
    const applyAdd = async (current: Session, input: NativeCalendarFeedAdd): Promise<NativeHostResult<NativeCalendarCommandResult> | NativeUnsavedWrite<NativeCalendarCommandResult>> => {
        const shown = shownFeeds(current);
        if (shown.some((feed) => feed.id === input.requestId)) return result(false, { clearDraft: true });
        if (feedsRevision(current) !== input.revision) return staleFeeds();
        const { tr, toastsOf } = translators();
        const next = 'url' in input
            ? addCalendarFeed(shown, { id: input.requestId, name: input.name, url: input.url, defaultName: tr('nav.calendar') })
            : addCalendarFile(shown, { id: input.requestId, name: input.name, fileName: input.fileName, uri: input.uri, defaultName: tr('nav.calendar') });
        if (!next) return fail('INVALID_INPUT', 'A subscription needs a URL');
        const written = await writeFeeds(current, next, { clearDraft: true });
        if (!('url' in input) && (written.ok || written.error.code === 'SAVE_FAILED')) showToast(toastsOf.localFileAdded());
        return written;
    };

    const applyEdit = async (
        current: Session,
        edit: NativeCalendarSettingsEdit,
    ): Promise<NativeHostResult<NativeCalendarCommandResult> | NativeUnsavedWrite<NativeCalendarCommandResult>> => {
        const { toastsOf } = translators();
        const { feeds, push } = device(current.host);
        const pushAvailable = hasCalendarPush(current.host);
        switch (edit.type) {
            case 'push': {
                const enabledNow = await push.getCalendarPushEnabled();
                if (enabledNow === edit.enabled) return result(false);
                if (enabledNow !== edit.before) return fail('STALE_REVISION', 'Calendar push changed since the view showed it; read the view again');
                if (!edit.enabled) {
                    await push.setCalendarPushEnabled(false);
                    current.push.enabled = false;
                    push.stopCalendarPushSync();
                    showToast(toastsOf.pushDisabled());
                    await refreshShownRevision(current.host);
                    return result(true);
                }
                if (!pushAvailable) return fail('ACTION_FAILED', 'Calendar push is not available on this host yet');
                const granted = current.push.permission === 'granted' ? true : await push.requestCalendarWritePermission();
                if (!granted) {
                    current.push.permission = 'denied';
                    showToast(toastsOf.pushPermissionRequired());
                    return result(false);
                }
                current.push.permission = 'granted';
                await loadPushTargets(current);
                await push.setCalendarPushEnabled(true);
                current.push.enabled = true;
                push.startCalendarPushSync();
                // As on React Native, the first push runs on without the answer waiting for it.
                void push.runFullCalendarSync()
                    .catch((error: unknown) => logError(current, error))
                    .then(() => refreshShownRevision(current.host))
                    .catch(() => undefined);
                await refreshShownRevision(current.host);
                return result(true, { open: 'push' });
            }
            case 'pushTarget': {
                const stored = await push.getCalendarPushTargetCalendarId();
                if (stored === edit.calendarId) return result(false);
                if (stored !== edit.before) return fail('STALE_REVISION', 'The push calendar changed since the view showed it; read the view again');
                await push.setCalendarPushTargetCalendarId(edit.calendarId);
                current.push.targetId = edit.calendarId;
                if (current.push.enabled && pushAvailable) void push.runFullCalendarSync();
                showToast(toastsOf.pushTargetUpdated());
                await refreshShownRevision(current.host);
                return result(true);
            }
            case 'pushColor': {
                const stored = await push.getCalendarPushColor();
                if (!planCalendarPushColor(stored, edit.color)) return result(false);
                if (normalizeCalendarPushColor(edit.before) !== stored) return fail('STALE_REVISION', 'The Mindwtr calendar color changed since the view showed it; read the view again');
                if (!pushAvailable) return fail('ACTION_FAILED', 'Calendar push is not available on this host yet');
                let updated: boolean;
                try {
                    updated = await push.updateMindwtrCalendarColor(edit.color);
                } catch (error) {
                    // The device refused: nothing was stored, and the same request retries it.
                    logError(current, error);
                    return fail('ACTION_FAILED', 'The Mindwtr calendar color could not be changed; try again');
                }
                current.push.color = normalizeCalendarPushColor(edit.color);
                await loadPushTargets(current);
                showToast(toastsOf.pushColorUpdated(updated));
                await refreshShownRevision(current.host);
                return result(true);
            }
            case 'deleteMindwtrCalendar': {
                if (!pushAvailable) return fail('ACTION_FAILED', 'Calendar push is not available on this host yet');
                if (current.push.deleting) return fail('ACTION_FAILED', 'The Mindwtr calendar is being deleted');
                // Resumable: its target is push off and no Mindwtr calendar of the app's own, so a
                // replay finishes a delete cut short at any step. A Mindwtr calendar made since the
                // view (another saved ID or creation intent) is never deleted.
                const [savedId, marker, intent] = await Promise.all([
                    current.host.storage.getItem(CALENDAR_PUSH_CALENDAR_ID_KEY),
                    current.host.storage.getItem(CALENDAR_PUSH_PENDING_KEY),
                    current.host.platform.os === 'ios' ? current.host.storage.getItem(CALENDAR_PUSH_CREATION_INTENT_KEY) : null,
                ]);
                if ((savedId !== null && savedId !== edit.calendarId)
                    || !matchesCalendarPushCreationIntentRevision(intent, edit.creationIntentRevision)) {
                    return fail('STALE_REVISION', 'A Mindwtr calendar was made since the view showed it; read the view again');
                }
                if (savedId === null && marker === null && intent === null && !await push.getCalendarPushEnabled()) return result(false);
                current.push.deleting = true;
                try {
                    // Disable push sync first so the calendar is not recreated on the next
                    // startup or task change.
                    await push.setCalendarPushEnabled(false);
                    current.push.enabled = false;
                    push.stopCalendarPushSync();
                    const target = await push.getCalendarPushTargetCalendarId();
                    await push.deleteMindwtrCalendar(edit);
                    if (current.host.platform.os === 'ios') {
                        try {
                            await current.host.log.info('Native iOS calendar cleanup completed', {
                                scope: 'calendar-settings', extra: { releaseCheck: 'v1.3.5/ios-calendar-cleanup', outcome: 'completed' },
                            });
                        } catch { /* The log cannot revoke completed cleanup. */ }
                    }
                    const keptTargetEvents = keptPushTargetEvents(target, await push.getCalendarPushTargetCalendarId());
                    current.push.targetId = null;
                    await loadPushTargets(current);
                    showToast(toastsOf.mindwtrCalendarDeleted(keptTargetEvents));
                } catch (error) {
                    if (error instanceof CalendarPushOwnershipChangedError) {
                        return fail('STALE_REVISION', 'A Mindwtr calendar was made since the view showed it; read the view again');
                    }
                    // The calendar stays with its saved ID: the same request (or a new one) finishes it.
                    logError(current, error);
                    return fail('ACTION_FAILED', 'The Mindwtr calendar could not be deleted; try again');
                } finally {
                    current.push.deleting = false;
                    await refreshShownRevision(current.host).catch(() => undefined);
                }
                return result(true);
            }
            case 'deviceCalendars': {
                const planned = planDeviceCalendarSetting(await feeds.getSystemCalendarSettings(), edit);
                if (!planned.ok) return planned;
                if (!planned.value.result.changed) return { ok: true, value: planned.value.result };
                current.device.settings = { ...edit.value, areaIdsByCalendar: edit.value.areaIdsByCalendar ?? {} };
                await feeds.saveSystemCalendarSettings(edit.value);
                const turnedOn = planned.value.result.open === 'device';
                if (turnedOn && current.device.permission !== 'granted') await loadDevice(current, true);
                return { ok: true, value: planned.value.result };
            }
            case 'removeFeed': {
                const shown = shownFeeds(current);
                if (!shown.some((feed) => feed.id === edit.feedId)) return result(false);
                if (feedsRevision(current) !== edit.revision) return staleFeeds();
                return writeFeeds(current, removeCalendarFeed(shown, edit.feedId));
            }
            case 'feed': {
                const shown = shownFeeds(current);
                const feed = shown.find((entry) => entry.id === edit.feedId);
                if (!feed) return staleFeeds();
                const currentValue = edit.field === 'enabled' ? feed.enabled : edit.field === 'color' ? feed.color ?? null : feed.areaIds ?? [];
                if (sameJson(currentValue, edit.value)) return result(false);
                if (feedsRevision(current) !== edit.revision) return staleFeeds();
                if (edit.field === 'color') {
                    const next = setCalendarFeedColor(shown, edit.feedId, edit.value ?? undefined);
                    if (!next) return fail('INVALID_INPUT', 'A color the swatches offer is required');
                    return writeFeeds(current, next);
                }
                return writeFeeds(current, edit.field === 'enabled'
                    ? setCalendarFeedEnabled(shown, edit.feedId, edit.value)
                    : shown.map((entry) => (entry.id === edit.feedId ? { ...entry, areaIds: edit.value } : entry)));
            }
        }
    };

    // ---------------------------------------------------------------------------
    // External calendars for the Calendar screen and the reviews.

    const loadFeed = (host: NativeCalendarHost, start: Date, end: Date, timeoutMs: number | undefined, signal: AbortSignal) => {
        let failedFeeds = 0;
        return device(host).feeds.fetchExternalCalendarEvents(start, end, { signal, timeoutMs, onFeedError: () => { failedFeeds += 1; } })
            .then((data): NativeHostResult<NativeCalendarFeed> => (signal.aborted
                ? fail('STALE_REVISION', 'A newer load for this screen replaced it')
                : { ok: true, value: {
                    status: 'ready', calendars: data.calendars, events: data.events,
                    ...(failedFeeds > 0 ? { warning: translators().tr('settings.calendarMobile.failedToLoadEvents') } : {}),
                } }))
            .catch((error: unknown): NativeHostResult<NativeCalendarFeed> => (signal.aborted
                ? fail('STALE_REVISION', 'A newer load for this screen replaced it')
                : { ok: true, value: { status: 'error', message: error instanceof Error ? error.message : String(error) } }));
    };

    return {
        /** Opens Settings › Calendar: reads the device as React Native's screen does on mount. */
        async openCalendarSettings(): Promise<NativeHostResult<NativeCalendarSettings & { toasts: NativeCalendarToast[] }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return fail('ACTION_FAILED', 'Calendars are not available on this host yet');
            takeToasts();
            const current = newSession(host);
            session = current;
            try {
                await loadSession(current);
            } catch (error) {
                logError(current, error);
                return fail('ACTION_FAILED', 'Settings › Calendar could not read this device');
            }
            if (session !== current) return fail('ACTION_FAILED', 'Settings › Calendar closed or opened again before it finished opening');
            return { ok: true, value: { ...buildView(current, {}), toasts: takeToasts() } };
        },

        closeCalendarSettings(): NativeHostResult<null> {
            session = null;
            takeToasts();
            return { ok: true, value: null };
        },

        /** The open screen; `draft` is the name and URL fields' text. */
        getCalendarSettings(input: { draft?: Draft } = {}): NativeHostResult<NativeCalendarSettings> {
            const opened = openedSession();
            if (!opened.ok) return opened;
            const draft = isObjectRecord(input) ? input.draft ?? {} : null;
            if (!draft || !isObjectRecord(draft) || Object.keys(draft).some((key) => key !== 'name' && key !== 'url')
                || (draft.name !== undefined && !isText(draft.name, 500)) || (draft.url !== undefined && !isText(draft.url, 4000))) {
                return fail('INVALID_INPUT', 'draft is an optional { name, url } of typed text');
            }
            return { ok: true, value: buildView(opened.value, draft as Draft) };
        },

        /**
         * A write: an edit the view gave, with a request UUID. It needs no open screen
         * (the journal replays it at boot): it then reads the device as the screen would.
         */
        async setCalendarSetting(input: { requestId: string; edit: NativeCalendarSettingsEdit }): Promise<NativeHostResult<NativeCalendarCommandResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return fail('ACTION_FAILED', 'Calendars are not available on this host yet');
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId) || !isEdit(input.edit)) {
                return fail('INVALID_INPUT', 'A request UUID and an edit the view gave are required');
            }
            const opened = session?.host === host ? session : null;
            const outcome = await receipts.run<NativeCalendarCommandResult>(
                input.requestId,
                JSON.stringify(['calendarSetting', input.edit]),
                async () => {
                    const current = opened ?? newSession(host);
                    if (!opened) await loadSession(current);
                    return applyEdit(current, input.edit);
                },
            );
            return outcome.ok ? { ok: true, value: { ...outcome.value, toasts: takeToasts() } } : outcome;
        },

        /**
         * A new subscription: a URL (`url`), or a local .ics file the picker gave
         * (`fileName`, `uri`). Its URL may carry a user name and password, so this
         * command is never journaled (NATIVE_UNJOURNALED_COMMANDS) and its receipt
         * keeps only a hash of its input. The subscription takes the request UUID as
         * its ID: a retry finds it. It needs no open screen.
         */
        async addCalendarFeed(input: NativeCalendarFeedAdd): Promise<NativeHostResult<NativeCalendarCommandResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return fail('ACTION_FAILED', 'Calendars are not available on this host yet');
            if (!isFeedAdd(input) || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A request UUID, a name, a URL (or a file name and URI) and the list\'s revision are required');
            }
            const opened = session?.host === host ? session : null;
            const outcome = await receipts.run<NativeCalendarCommandResult>(
                input.requestId,
                // The payload's name is in NATIVE_UNJOURNALED_COMMANDS; the rest is a hash, never the URL.
                JSON.stringify(['calendarFeedAdd', deterministicHash128Hex(JSON.stringify(input))]),
                async () => {
                    const current = opened ?? newSession(host);
                    if (!opened) await loadSession(current);
                    return applyAdd(current, input);
                },
            );
            return outcome.ok ? { ok: true, value: { ...outcome.value, toasts: takeToasts() } } : outcome;
        },

        /** Grant access: the system prompt, then the device calendars again. */
        async grantDeviceCalendarAccess(): Promise<NativeHostResult<{ toasts: NativeCalendarToast[] }>> {
            const opened = openedSession();
            if (!opened.ok) return opened;
            await loadDevice(opened.value, true);
            return { ok: true, value: { toasts: takeToasts() } };
        },

        /** Refresh calendars: the push calendar list again. */
        async refreshCalendarPushTargets(): Promise<NativeHostResult<{ toasts: NativeCalendarToast[] }>> {
            const opened = openedSession();
            if (!opened.ok) return opened;
            await loadPushTargets(opened.value);
            try {
                await refreshShownRevision(opened.value.host);
            } catch (error) {
                logError(opened.value, error);
            }
            return { ok: true, value: { toasts: takeToasts() } };
        },

        /** Test: this month's events from every subscription and device calendar. */
        async testCalendarFeeds(): Promise<NativeHostResult<{ toasts: NativeCalendarToast[] }>> {
            const opened = openedSession();
            if (!opened.ok) return opened;
            const { toastsOf } = translators();
            try {
                const range = getCalendarTestRange(new Date());
                let failedFeeds = 0;
                const { events } = await device(opened.value.host).feeds.fetchExternalCalendarEvents(range.start, range.end, {
                    onFeedError: () => { failedFeeds += 1; },
                });
                showToast(toastsOf.testResult(events.length, failedFeeds, deps.language()));
            } catch (error) {
                logError(opened.value, error);
                showToast(toastsOf.testFailed());
            }
            return { ok: true, value: { toasts: takeToasts() } };
        },

        /**
         * The external calendars for a screen's range (`start` to `end`, ISO): the
         * subscriptions and the chosen device calendars, merged. Send the answer as
         * the view's `calendar`. One load runs per `slot`: the same range again joins
         * it, another range replaces it (the replaced call answers STALE_REVISION).
         * `timeoutMs` bounds the whole load (the daily review uses 15 s); each
         * subscription has its own 15 s. Send `refresh: true` when the Calendar
         * screen gains focus or the app returns from the background
         * (shouldRefreshExternalCalendarOnAppStateChange): a refresh within a second
         * of the last one answers that one's load (EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS).
         */
        loadExternalCalendarFeed(input: { slot: NativeCalendarFeedSlot; start: string; end: string; timeoutMs?: number; refresh?: boolean }): Promise<NativeHostResult<NativeCalendarFeed>> {
            const ready = deps.readiness();
            if (!ready.ok) return Promise.resolve(ready);
            const start = isObjectRecord(input) && isText(input.start, 40) ? new Date(input.start) : null;
            const end = isObjectRecord(input) && isText(input.end, 40) ? new Date(input.end) : null;
            if (!isObjectRecord(input) || !(NATIVE_CALENDAR_FEED_SLOTS as readonly unknown[]).includes(input.slot)
                || !start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()
                || (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0))
                || (input.refresh !== undefined && typeof input.refresh !== 'boolean')) {
                return Promise.resolve(fail('INVALID_INPUT', 'A screen slot, an ISO start before an ISO end, an optional positive timeoutMs and an optional refresh are required'));
            }
            const host = deps.host();
            if (!host) return Promise.resolve(fail('ACTION_FAILED', 'Calendars are not available on this host yet'));
            const key = JSON.stringify([start.toISOString(), end.toISOString(), input.timeoutMs ?? null]);
            const previous = feedLoads.get(input.slot);
            const now = Date.now();
            if (previous?.key === key) {
                if (previous.running) return previous.running;
                if (input.refresh && now - previous.refreshedAt < EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS) return previous.last;
            }
            previous?.controller.abort(new Error('A newer load for this screen replaced it'));
            const controller = new AbortController();
            const load: FeedLoad = loadFeed(host, start, end, input.timeoutMs, controller.signal).finally(() => {
                const entry = feedLoads.get(input.slot);
                if (entry?.controller === controller) entry.running = null;
            });
            const refreshedAt = input.refresh ? now : previous?.key === key ? previous.refreshedAt : 0;
            feedLoads.set(input.slot, { key, controller, running: load, last: load, refreshedAt });
            return load;
        },
    };
}
