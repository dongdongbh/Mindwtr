/**
 * The native host contract for Settings › Sync (React Native's
 * `sync-settings-screen.tsx` in sync mode). Kept in its own file and spread into
 * createNativeHostContract. The rules are core's: the screen model
 * (sync-settings-model.ts), the transport actions (sync-settings-transport.ts) and
 * the encryption card (sync-encryption-card.ts), the same code React Native runs.
 *
 * A host binds its device through `NativeSyncSettingsHost` (createNativeHostContract's
 * `syncSettings` option): RN's key-value keys (sync-storage-keys.ts), RN's secret
 * store, the mobile sync service, and later the folder picker (File Sync), Dropbox
 * sign-in and the encryption transitions. Until a host passes them, the File Sync
 * folder, Dropbox and the encryption actions answer ACTION_FAILED, and the view
 * still shows the stored backend: which backends a build supports comes from
 * `platform` (as on React Native), never from which ports are bound.
 *
 * One visit is one screen, as on React Native: openSyncSettings reads the stored
 * configuration, closeSyncSettings drops what the visit staged (a backend chosen
 * but not proven). The view is read with getSyncSettings; while a command runs
 * (a sync, an encryption change), reads show its progress.
 *
 * Screen state the host keeps, reset on every visit: the text fields' drafts, and
 * whether the history, the settings sync options and the recovery snapshots are
 * open. A field's draft starts at the view's `value`, and takes the view's value
 * again whenever it changes (React Native's forms do this). The password and the
 * token never come back: the view shows `mask`, RN's dots, and a draft that was
 * not edited is sent as null ("keep the stored one"). Send the form's drafts to
 * getSyncSettings as `draft` so the form's checks follow the typed text.
 *
 * Toasts are React Native's, in order: each command answers the toasts shown
 * since the last answer (`toasts`), whichever action showed them.
 *
 * Replay rules. setSyncPreference is a synced-settings write with a request
 * receipt: target-state, so a replay writes nothing when the option already holds
 * the value. The other commands act on this device's sync configuration and must
 * never be written to disk, by the request journal or by durable receipts
 * (`NATIVE_SYNC_SETTINGS_UNJOURNALED_COMMANDS`): several carry a secret, which
 * must never reach disk outside the keystore, and the configuration commit is
 * itself crash-safe (the backend key is the activation flag, so a crash leaves the
 * old or the new proven configuration). They keep no request payload, only a
 * fingerprint of their input: a retry of a request still running joins it, a retry
 * of one that finished answers without running again, and the same UUID with other
 * input answers INVALID_INPUT. Each is also target-state or compare-and-set, so a
 * replay after a restart writes nothing wrong: a backend already proven is not
 * activated again, Off already stored writes nothing, a form's Save or Sync now
 * carries the view's `configRevision` and answers STALE_REVISION once the stored
 * configuration changed (its own commit included), an encryption submit needs its
 * flow open (a new visit has none), and Dropbox connect or disconnect does nothing
 * when the account is already in that state. Off answers SAVE_FAILED when the
 * device store refuses it, and the screen keeps showing the stored backend.
 * getSyncSettings's `draft.token` is a typed token too; it is a read.
 *
 * The URL field shows the URL as typed. Every other text that leaves the screen (the
 * status, the history, toasts, error answers, the error log) goes through the
 * transport's one redaction (`redactText`): no URL credentials and none of the
 * configured secrets, a short one as a whole word.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the
 * import cycle between the two files is safe.
 */
import { getDocsGuideUrl } from './docs-guidance';
import { createDateFormatter } from './date';
import { isDropboxClientConfigured, type DropboxAuthTokens } from './dropbox-auth-tokens';
import type { Language } from './i18n/i18n-types';
import { NATIVE_HOST_CONTRACT_VERSION, type NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import { useTaskStore } from './store';
import { isSyncEncryptionCleanupDeferredError } from './sync-encryption-service';
import type { SyncEncryptionStatus, SyncEncryptionTransitionKind } from './sync-encryption';
import {
    createSyncEncryptionCard,
    getSyncEncryptionCardMessages,
    type SyncEncryptionCard,
    type SyncEncryptionCardFlow,
    type SyncEncryptionCardHost,
    type SyncEncryptionPassphraseField,
} from './sync-encryption-card';
import {
    buildSyncConflictLines,
    buildSyncHistoryLines,
    buildSyncPreferenceRows,
    buildSyncPreferencesUpdate,
    createSyncSettingsTranslator,
    formatSyncClockSkew,
    redactSyncText,
    getCloudKitStatusDetails,
    getSyncBackendCurrentLabel,
    getSyncBackendGroups,
    getSyncBackendOptionLabel,
    getSyncBackendOptions,
    getSyncFailureMessage,
    getSyncFolderLabel,
    getSyncLastErrorText,
    getSyncLastStatusLine,
    getSyncLastStatusSummary,
    getSyncPreferenceValues,
    getSyncSelfHostedFormState,
    getSyncWebDavFormState,
    isSyncBackendOptionSelected,
    resolveSyncBackendSelection,
    SYNC_PREFERENCE_KEYS,
    type CloudKitAccountStatus,
    type SyncPreferenceKey,
    type SyncSettingsBackendOption,
} from './sync-settings-model';
import {
    createSyncSettingsTransport,
    type SyncSettingsCancel,
    type SyncSettingsDropboxPort,
    type SyncSettingsSelfHostedFields,
    type SyncSettingsToast,
    type SyncSettingsTransport,
    type SyncSettingsTransportHost,
    type SyncSettingsTransportParams,
    type SyncSettingsWebDavFields,
    SyncSettingsWriteError,
} from './sync-settings-transport';
import { isValidCloudSyncToken } from './cloud';
import {
    CLOUD_ALLOW_INSECURE_HTTP_KEY,
    CLOUD_PROVIDER_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_BOOKMARK_KEY,
    SYNC_PATH_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from './sync-storage-keys';
import { deterministicHash128Hex } from './uuid';

type Translate = (key: string) => string;

/** What a host binds for Settings › Sync. */
export type NativeSyncSettingsHost = {
    platform: {
        os: 'android' | 'ios';
        /** FOSS builds never offer Dropbox. */
        isFossBuild: boolean;
        /** The build's Dropbox app key, or '' when none is configured. */
        dropboxAppKey: string;
        /** iOS with CloudKit (React Native: `isCloudKitAvailable()`); false on Android. */
        cloudKitAvailable?: boolean;
    };
    /** RN's key-value store (RKStorage on Android), with RN's keys. Durable when a write resolves. */
    storage: SyncSettingsTransportHost['storage'];
    /** RN's secret store (the keystore), with RN's keys. */
    secrets: SyncSettingsTransportHost['secrets'];
    /** The mobile sync service's performMobileSync (core's createMobileSyncService). */
    performSync: SyncSettingsTransportHost['performSync'];
    clearSyncConfigCache(): void;
    /** Brings the background sync job in line with the stored backend. */
    reconcileBackgroundSync(): Promise<unknown>;
    rememberWebdavCapabilityProof(config: SyncSettingsWebDavFields): Promise<void>;
    encryption: {
        /** Selected host capability: only unlock an existing saved WebDAV location. */
        unlockOnly?: boolean;
        /** Internal selected host capability; production iOS does not bind it yet. */
        mode?: 'saved-webdav-enable-unlock';
        getStatus(): Promise<SyncEncryptionStatus>;
        getIncompleteTransition(): Promise<SyncEncryptionTransitionKind | null>;
        /** True while no durable sync backend exists (transitions then run local-only). */
        isBackendPending(): Promise<boolean>;
        /** The transitions (core's sync encryption service on the host's crypto); absent until the host has them. */
        transitions?: Pick<SyncEncryptionCardHost, 'enable' | 'change' | 'disable' | 'provide' | 'decline' | 'abandon' | 'recheck' | 'randomBytes'>;
    };
    /** The app log: an info line (no secrets are ever passed) and an error. */
    log: { info(message: string, context: { scope: string; extra: Record<string, string>; force?: boolean }): unknown; error(error: unknown): void };
    addBreadcrumb?(message: string): void;
    /** The system folder picker (File Sync); absent until the host has it. */
    pickSyncFolder?(): Promise<{ uri: string; bookmark?: string | null } | null>;
    /**
     * Dropbox sign-in and tokens; absent until the host has them. Its token reads are
     * core's createDropboxTokenStore over `storage` and `secrets`; without it the Dropbox
     * panel shows the account as not connected and its actions refuse.
     */
    dropbox?: SyncSettingsDropboxPort;
    /** iCloud's account (iOS, with `platform.cloudKitAvailable`); without it the status reads unknown. */
    cloudKit?: { getAccountStatus(): Promise<CloudKitAccountStatus> };
    /** Recovery snapshot file names, newest first; absent until the Data screen moves. */
    listRecoverySnapshots?(): Promise<string[]>;
};

/** Commands a host must not write to its request journal (see the header). */
export const NATIVE_SYNC_SETTINGS_UNJOURNALED_COMMANDS = [
    'openSyncSettings',
    'closeSyncSettings',
    'selectSyncBackend',
    'saveSyncBackend',
    'syncNow',
    'testSyncConnection',
    'pickSyncFolder',
    'connectDropbox',
    'disconnectDropbox',
    'runSyncEncryptionAction',
] as const;

export type SyncSettingsDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    language: () => Language;
    /** The device locale React Native's dates follow (toLocaleString). */
    systemLocale: () => string | null;
    dataRevision: () => string;
    requestIdPattern: RegExp;
    host: () => NativeSyncSettingsHost | null;
};

export type NativeSyncToast = { title: string; message: string; tone: SyncSettingsToast['tone']; durationMs: number | null };

/** A row action: `enabled` says whether it can be pressed; `tinted` whether its label draws in the tint. */
export type NativeSyncAction = { label: string; description: string | null; enabled: boolean; tinted: boolean; busy: boolean };

export type NativeSyncLastSyncCard = {
    title: string;
    status: string;
    /** The counts, then the resolved conflicts (or their IDs). */
    lines: string[];
    /** Drawn in the danger color. */
    error: string | null;
    /** The five newest syncs; draw `closed` or `open` as the toggle's text. */
    history: { closed: string; open: string; entries: string[] } | null;
};

type NativeTextField = { label: string; placeholder: string | null; value: string };

export type NativeSyncPanel =
    | {
        kind: 'webdav';
        title: string;
        url: NativeTextField & { hint: string; invalid: string | null };
        allowInsecureHttp: { label: string; hint: string; value: boolean };
        username: NativeTextField;
        password: { label: string; placeholder: string; mask: string };
        save: NativeSyncAction;
        syncNow: NativeSyncAction;
        test: NativeSyncAction;
        lastSync: NativeSyncLastSyncCard;
    }
    | {
        kind: 'selfhosted';
        url: NativeTextField & { hints: string[]; invalid: string | null };
        allowInsecureHttp: { label: string; hint: string; value: boolean };
        token: { label: string; placeholder: string; mask: string; hint: string; invalid: string | null };
        save: NativeSyncAction;
        syncNow: NativeSyncAction;
        test: NativeSyncAction;
        lastSync: NativeSyncLastSyncCard;
    }
    | {
        kind: 'file';
        help: { title: string; text: string; tip: string };
        title: string;
        folder: { label: string; value: string; select: NativeSyncAction };
        syncNow: NativeSyncAction;
        /** Drawn inside the settings card, under Sync now. */
        lastSync: NativeSyncLastSyncCard;
    }
    | {
        kind: 'dropbox';
        title: string;
        description: string;
        redirect: string;
        /** Drawn in the danger color. */
        notConfigured: string | null;
        status: string;
        connected: boolean;
        connect: NativeSyncAction;
        test: NativeSyncAction;
        syncNow: NativeSyncAction;
        lastSync: NativeSyncLastSyncCard;
    }
    | {
        kind: 'cloudkit';
        help: { title: string; text: string; status: string };
        syncNow: NativeSyncAction;
        lastSync: NativeSyncLastSyncCard;
    };

export type NativeSyncEncryptionAction =
    | { type: 'open'; flow: Exclude<SyncEncryptionCardFlow, 'none'> }
    | { type: 'submit'; flow: Exclude<SyncEncryptionCardFlow, 'none'> }
    | { type: 'cancel' }
    | { type: 'generate' }
    | { type: 'reveal' }
    | { type: 'decline' }
    | { type: 'retry' }
    | { type: 'recheck' };

/** The encryption card's rows in screen order; a text's tone is its color. */
export type NativeSyncEncryptionRow =
    | { kind: 'text'; text: string; tone: 'label' | 'description' | 'warning' | 'danger' }
    /** The host's own secure text field; its text goes back with `{ type: 'typed' }`. */
    /** `maxLength`: the most characters core takes (a longer text is refused, never cut); `tooLong`: what to say then. */
    | { kind: 'field'; field: SyncEncryptionPassphraseField; label: string; secure: boolean; maxLength: number; tooLong: string }
    | { kind: 'reveal'; label: string; revealed: boolean; action: NativeSyncEncryptionAction }
    | { kind: 'action'; label: string; action: NativeSyncEncryptionAction; enabled: boolean; busy: boolean };

export type NativeSyncEncryptionCard = {
    title: string;
    guide: { title: string; description: string; url: string } | null;
    rows: NativeSyncEncryptionRow[];
};

export type NativeSyncSettings = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /**
     * The stored sync configuration's revision (a fingerprint, secrets included but
     * never readable). A form's Save, and its Sync now, send the revision of the view
     * the form was built from: a configuration stored since answers STALE_REVISION.
     */
    configRevision: string;
    title: string;
    backend: {
        title: string;
        current: string;
        hint: string;
        /** Each option goes to selectSyncBackend. */
        options: { option: SyncSettingsBackendOption; label: string; selected: boolean }[];
        group: { title: string; description: string } | null;
    };
    guide: { title: string; description: string; url: string };
    off: { title: string; description: string } | null;
    panel: NativeSyncPanel | null;
    /** Null when the backend cannot encrypt, or while its state is first read. */
    encryption: NativeSyncEncryptionCard | null;
    preferences: { title: string; description: string; rows: { key: SyncPreferenceKey; label: string; hint: string | null; value: boolean }[] };
    recoverySnapshots: { title: string; description: string; empty: string; snapshots: string[] };
    /** The disclosure glyphs React Native draws after a folded card's title. */
    disclosure: { closed: string; open: string };
    busy: { syncing: boolean; testing: boolean; dropbox: boolean; encryption: boolean };
};

/** A form's fields as the host sends them; a null password or token keeps the stored one. */
export type NativeSyncWebDavFields = { url: string; username: string; password: string | null; allowInsecureHttp: boolean };
export type NativeSyncSelfHostedFields = { url: string; token: string | null; allowInsecureHttp: boolean };
export type NativeSyncCommandResult = { toasts: NativeSyncToast[] };

type Screen = {
    host: NativeSyncSettingsHost;
    transport: SyncSettingsTransport;
    card: SyncEncryptionCard | null;
    cardCancels: (() => void)[];
    /** The read a finished transport action started; the next action's start cancels it. */
    edgeRefresh: (() => void) | null;
    lastBusy: boolean;
    lastBackend: string;
    effectsQueued: boolean;
    /** True until openSyncSettings has read the stored configuration. */
    opening: boolean;
    snapshots: string[];
    cancels: (() => void)[];
    pending: Set<Promise<unknown>>;
    generation: number;
    configRevision: string;
    unsubscribe: () => void;
};

const MONTH_FIRST_LOCALE = /^en(?:[-_]US)?$/i;
/** Date.prototype.toLocaleString's options (ECMA-402 ToDateTimeOptions "any", "all"). */
const TO_LOCALE_STRING_OPTIONS: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
};
const PASSWORD_DOTS = '••••••••';
const PASSPHRASE_FIELDS = new Set<string>(['current', 'next', 'confirm']);
const FLOWS = new Set<string>(['enable', 'change', 'disable', 'unlock', 'abandon']);
/** The longest passphrase a field takes (runSyncEncryptionAction's `typed`): a host's field stops there and says so. */
export const SYNC_ENCRYPTION_PASSPHRASE_MAX_LENGTH = 1000;

/** A value's 128-bit fingerprint: never readable, the same for the same value. */
const fingerprint = (value: unknown): string => deterministicHash128Hex(JSON.stringify(value));
/** A secret's fingerprint, or null. */
const secretPrint = (secret: string | null | undefined) => (secret === null || secret === undefined ? null : fingerprint(['secret', secret]));

const CONFIGURATION_KEYS = [
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
    SYNC_PATH_BOOKMARK_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
    CLOUD_PROVIDER_KEY,
    CLOUD_URL_KEY,
    CLOUD_ALLOW_INSECURE_HTTP_KEY,
];

/** The stored configuration's revision: every key the commit writes, and both secrets as fingerprints. */
const readConfigRevision = async (host: NativeSyncSettingsHost): Promise<string> => {
    const entries = await host.storage.multiGet(CONFIGURATION_KEYS);
    const password = await host.secrets.get(WEBDAV_PASSWORD_KEY);
    const token = await host.secrets.get(CLOUD_TOKEN_KEY);
    return fingerprint([entries, secretPrint(password), secretPrint(token)]);
};

/** A form's fields as a request identity: the password or token only as fingerprints. */
const fieldsPrint = (fields: NativeSyncWebDavFields | NativeSyncSelfHostedFields | null) => (
    !fields ? null : 'password' in fields ? { ...fields, password: secretPrint(fields.password) } : { ...fields, token: secretPrint(fields.token) }
);

const readWebDavFields = (value: unknown): NativeSyncWebDavFields | null => (
    isObjectRecord(value) && Object.keys(value).every((key) => ['url', 'username', 'password', 'allowInsecureHttp'].includes(key))
        && isText(value.url, 2000) && isText(value.username, 500) && (value.password === null || isText(value.password, 2000))
        && typeof value.allowInsecureHttp === 'boolean'
        ? value as NativeSyncWebDavFields
        : null
);

const readSelfHostedFields = (value: unknown): NativeSyncSelfHostedFields | null => (
    isObjectRecord(value) && Object.keys(value).every((key) => ['url', 'token', 'allowInsecureHttp'].includes(key))
        && isText(value.url, 2000) && (value.token === null || isText(value.token, 2000)) && typeof value.allowInsecureHttp === 'boolean'
        ? value as NativeSyncSelfHostedFields
        : null
);

export function createSyncSettingsMethods(deps: SyncSettingsDeps) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            if (error instanceof NativeAttachmentCleanupUnconfirmedError) throw error;
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });
    const toasts: NativeSyncToast[] = [];
    let screen: Screen | null = null;

    const takeToasts = (): NativeSyncToast[] => toasts.splice(0, toasts.length);

    /** The host's error log, through the open screen's redaction (URL credentials and secrets). */
    const logError = (host: NativeSyncSettingsHost, error: unknown) => {
        host.log.error(screen?.host === host
            ? screen.transport.redactError(error)
            : new Error(redactSyncText(error instanceof Error ? error.message : String(error))));
    };

    /** React Native's screen props, from the host and the store as they are now. */
    const params = (host: NativeSyncSettingsHost): SyncSettingsTransportParams => {
        const t = deps.t();
        const tr = createSyncSettingsTranslator(t);
        const settings = useTaskStore.getState().settings;
        const isFossBuild = host.platform.isFossBuild;
        // The build decides which backends it supports, as on React Native. A port the host
        // has not bound yet only refuses its actions: it never turns a stored backend off.
        const dropboxAppKey = host.platform.dropboxAppKey.trim();
        const push = (toast: SyncSettingsToast) => {
            toasts.push({ title: toast.title, message: toast.message, tone: toast.tone, durationMs: toast.durationMs ?? null });
        };
        return {
            dropboxAppKey,
            dropboxConfigured: !isFossBuild && isDropboxClientConfigured(dropboxAppKey),
            getCloudKitStatusDetails: (status) => getCloudKitStatusDetails(status, tr),
            getSyncFailureToastMessage: (error) => getSyncFailureMessage(error, t),
            isExpoGo: false,
            isFossBuild,
            lastSyncStats: settings.lastSyncStats ?? null,
            lastSyncStatus: settings.lastSyncStatus,
            tr,
            resetSyncStatusForBackendSwitch: () => {
                useTaskStore.getState().updateSettings({
                    lastSyncStatus: 'idle',
                    lastSyncError: undefined,
                }).catch((error) => logError(host, error));
            },
            showSettingsErrorToast: (title, message, durationMs = 4200) => push({ title, message, tone: 'error', durationMs }),
            showSettingsWarning: (title, message, durationMs = 4200) => push({ title, message, tone: 'warning', durationMs }),
            showToast: push,
            supportsNativeICloudSync: host.platform.os === 'ios' && host.platform.cloudKitAvailable === true,
            t,
        };
    };

    const unavailable = (what: string) => async (): Promise<never> => {
        throw new Error(`${what} is not available on this host yet`);
    };

    const createTransport = (host: NativeSyncSettingsHost) => createSyncSettingsTransport({
        params: () => params(host),
        storage: host.storage,
        secrets: host.secrets,
        platform: { os: () => host.platform.os },
        logInfo: (message, context) => host.log.info(message, context),
        logSettingsError: (error) => host.log.error(error),
        performSync: (syncPathOverride, options) => host.performSync(syncPathOverride, options),
        clearSyncConfigCache: () => host.clearSyncConfigCache(),
        reconcileBackgroundSync: () => host.reconcileBackgroundSync(),
        pickSyncFolder: async () => {
            if (!host.pickSyncFolder) throw new Error('The folder picker is not available on this host yet');
            const picked = await host.pickSyncFolder();
            return picked ? { __fileUri: picked.uri, __fileBookmark: picked.bookmark ?? undefined } : null;
        },
        getCloudKitAccountStatus: () => (host.cloudKit ? host.cloudKit.getAccountStatus() : Promise.resolve('unknown' as const)),
        rememberWebdavCapabilityProof: (config) => host.rememberWebdavCapabilityProof(config),
        encryption: { getStatus: () => host.encryption.getStatus(), getIncompleteTransition: () => host.encryption.getIncompleteTransition() },
        dropbox: host.dropbox ?? {
            authorize: unavailable('Dropbox'),
            redirectUri: () => '',
            isConnected: async () => false,
            disconnect: unavailable('Dropbox'),
            clearTokens: unavailable('Dropbox'),
            revokeTokens: unavailable('Dropbox'),
            getStoredTokens: async (): Promise<DropboxAuthTokens | null> => null,
            saveTokens: unavailable('Dropbox'),
            getValidAccessToken: unavailable('Dropbox'),
            forceRefreshAccessToken: unavailable('Dropbox'),
            getValidAccessTokenForTokens: unavailable('Dropbox'),
            forceRefreshAccessTokenForTokens: unavailable('Dropbox'),
            testAccess: unavailable('Dropbox'),
        },
        core: host.addBreadcrumb ? { addBreadcrumb: (message) => host.addBreadcrumb?.(message) } : undefined,
    });

    const createCard = (current: Screen): SyncEncryptionCard => {
        const { host } = current;
        const transitions = host.encryption.transitions;
        const missing = unavailable('Sync encryption');
        return createSyncEncryptionCard({
            getStatus: () => host.encryption.getStatus(),
            isBackendPending: () => host.encryption.isBackendPending(),
            enable: transitions ? (passphrase, options) => transitions.enable(passphrase, options) : missing,
            change: transitions ? (current, next, options) => transitions.change(current, next, options) : missing,
            disable: transitions ? (options) => transitions.disable(options) : missing,
            provide: transitions ? (passphrase) => transitions.provide(passphrase) : missing,
            decline: transitions ? () => transitions.decline() : missing,
            abandon: transitions ? () => transitions.abandon() : missing,
            recheck: transitions ? () => transitions.recheck() : missing,
            isCleanupDeferredError: (error): error is Error & { cleanupKind?: string; outcome?: unknown } => isSyncEncryptionCleanupDeferredError(error),
            randomBytes: (length) => {
                if (!transitions) throw new Error('Sync encryption is not available on this host yet');
                return transitions.randomBytes(length);
            },
            // The service reads the worklist from the sync location, not from here.
            appData: () => null,
            logSettingsError: (error) => host.log.error(current.transport.redactError(error)),
        });
    };

    const track = (current: Screen, promise: Promise<unknown>) => {
        current.pending.add(promise);
        void promise.finally(() => current.pending.delete(promise));
    };

    /** Waits for every read the screen started, as React Native's effects finish before a user acts. */
    const settle = async (current: Screen) => {
        while (current.pending.size > 0) await Promise.allSettled(Array.from(current.pending));
    };

    const startRead = (current: Screen, read: SyncSettingsCancel | ((() => void) & { done: Promise<void> })) => {
        current.cancels.push(read);
        track(current, read.done);
    };

    /**
     * React Native mounts the encryption card while the backend can encrypt, and
     * reads its state on mount and whenever a transport action finishes.
     */
    const syncCard = (current: Screen) => {
        const state = current.transport.getState();
        const selection = resolveSyncBackendSelection({
            syncBackend: state.syncBackend,
            cloudProvider: state.cloudProvider,
            isFossBuild: current.host.platform.isFossBuild,
            supportsCloudKit: params(current.host).supportsNativeICloudSync,
        });
        const busy = state.isSyncing || state.isTestingConnection || state.dropboxBusy;
        if (!selection.isEncryptionCapableBackend) {
            if (current.card) {
                for (const cancel of current.cardCancels.splice(0)) cancel();
                current.card = null;
                current.edgeRefresh = null;
            }
            current.lastBusy = busy;
            return;
        }
        if (!current.card) {
            current.card = createCard(current);
            current.card.subscribe(() => { current.generation += 1; });
            const read = current.card.refresh();
            current.cardCancels.push(read);
            track(current, read.done);
            current.lastBusy = busy;
            return;
        }
        if (busy !== current.lastBusy) {
            current.edgeRefresh?.();
            current.edgeRefresh = null;
        }
        if (current.lastBusy && !busy) {
            const read = current.card.refresh();
            current.cardCancels.push(read);
            current.edgeRefresh = read;
            track(current, read.done);
        }
        current.lastBusy = busy;
    };

    const openScreen = async (host: NativeSyncSettingsHost): Promise<Screen> => {
        closeScreen();
        const transport = createTransport(host);
        const current: Screen = {
            host, transport, card: null, cardCancels: [], edgeRefresh: null, lastBusy: false, lastBackend: 'off', effectsQueued: false, opening: true,
            snapshots: [], cancels: [], pending: new Set(), generation: 0, configRevision: '', unsubscribe: () => undefined,
        };
        screen = current;
        // React Native runs these after the render a state change causes: after the
        // action's synchronous part, once for a batch of changes.
        current.unsubscribe = transport.subscribe(() => {
            current.generation += 1;
            if (current.effectsQueued) return;
            current.effectsQueued = true;
            track(current, Promise.resolve().then(() => {
                current.effectsQueued = false;
                if (screen !== current) return;
                syncCard(current);
                const { syncBackend } = transport.getState();
                // iCloud's account is read again whenever iCloud becomes the backend.
                if (syncBackend !== current.lastBackend && syncBackend === 'cloudkit') track(current, transport.refreshCloudKitAccountStatus());
                current.lastBackend = syncBackend;
            }));
        });
        startRead(current, transport.load());
        track(current, transport.refreshCloudKitAccountStatus());
        startRead(current, transport.loadDropboxState());
        if (host.listRecoverySnapshots) {
            track(current, host.listRecoverySnapshots()
                .then((names) => { current.snapshots = names; })
                .catch((error) => host.log.error(transport.redactError(error))));
        }
        await settle(current);
        // An unreadable secret leaves no revision: a form's Save then reads as stale.
        current.configRevision = await readConfigRevision(host).catch(() => '');
        current.opening = false;
        return current;
    };

    function closeScreen() {
        if (!screen) return;
        screen.unsubscribe();
        for (const cancel of [...screen.cancels, ...screen.cardCancels]) cancel();
        screen.card?.closeFlow();
        screen = null;
    }

    const formatDateTime = (iso: string): string => {
        // React Native draws these with the device locale's toLocaleString (Hermes: its
        // Intl on the platform's ICU). An engine with Intl (the Android host backs it with
        // ICU) gives the same text; without it a month-first device gets en-US's text and
        // others day-first.
        const locale = deps.systemLocale();
        const date = new Date(iso);
        if (typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function' && !Number.isNaN(date.getTime())) {
            try {
                return new Intl.DateTimeFormat(locale ?? undefined, TO_LOCALE_STRING_OPTIONS).format(date);
            } catch {
                // A locale tag Intl refuses falls back below.
            }
        }
        const monthFirst = !locale || MONTH_FIRST_LOCALE.test(locale);
        return createDateFormatter({ language: 'en', dateFormat: 'system' })(iso, monthFirst ? 'M/d/yyyy, h:mm:ss a' : 'd/M/yyyy, HH:mm:ss');
    };

    const lastSyncCard = (t: Translate, redact: (text: string) => string): NativeSyncLastSyncCard => {
        const state = useTaskStore.getState();
        const settings = state.settings;
        const summary = getSyncLastStatusSummary(settings);
        const conflictLines = buildSyncConflictLines(summary.lastSyncStats, {
            tasks: state._allTasks,
            projects: state._allProjects,
            sections: state._allSections,
            areas: state._allAreas,
            people: state._allPeople,
        }, t);
        const lines: string[] = [];
        if (summary.showLastSyncStats) {
            lines.push(`${t('settings.lastSyncConflicts')}: ${summary.conflictCount}`);
            if (summary.maxClockSkewMs > 0) lines.push(`${t('settings.lastSyncSkew')}: ${formatSyncClockSkew(summary.maxClockSkewMs)}`);
            if (summary.timestampAdjustments > 0) lines.push(`${t('settings.lastSyncAdjusted')}: ${summary.timestampAdjustments}`);
            lines.push(...conflictLines);
            if (conflictLines.length === 0 && summary.conflictIds.length > 0) {
                lines.push(`${t('settings.lastSyncConflictIds')}: ${summary.conflictIds.join(', ')}`);
            }
        }
        const error = getSyncLastErrorText(settings.lastSyncError, t, redact);
        const entries = buildSyncHistoryLines(settings.lastSyncHistory, t, formatDateTime, redact);
        const toggle = `${t('settings.syncHistory')} (${entries.length})`;
        return {
            title: t('settings.lastSync'),
            status: getSyncLastStatusLine(settings, t, formatDateTime),
            lines,
            error: settings.lastSyncStatus === 'error' && error ? error : null,
            history: entries.length > 0 ? { closed: `${toggle} ▸`, open: `${toggle} ▾`, entries } : null,
        };
    };

    const action = (label: string, description: string | null, enabled: boolean, tinted: boolean, busy = false): NativeSyncAction => (
        { label, description, enabled, tinted, busy }
    );

    type Draft = { url?: string; token?: string | null };

    const buildPanel = (current: Screen, draft: Draft): NativeSyncPanel | null => {
        const t = deps.t();
        const tr = createSyncSettingsTranslator(t);
        const host = current.host;
        const state = current.transport.getState();
        const p = params(host);
        const selection = resolveSyncBackendSelection({
            syncBackend: state.syncBackend,
            cloudProvider: state.cloudProvider,
            isFossBuild: p.isFossBuild,
            supportsCloudKit: p.supportsNativeICloudSync,
        });
        const { isSyncing, isTestingConnection, dropboxBusy, dropboxConnected } = state;
        if (state.syncBackend === 'file') {
            const hasPath = Boolean(state.syncPath);
            return {
                kind: 'file',
                help: {
                    title: tr('settings.syncMobile.howToSync'),
                    text: host.platform.os === 'ios' ? t('settings.fileSyncHowToIos') : t('settings.fileSyncHowToAndroid'),
                    tip: t('settings.fileSyncTip'),
                },
                title: t('settings.syncSettings'),
                folder: {
                    label: t('settings.syncFolderLocation'),
                    value: getSyncFolderLabel(state.syncPath, t) ?? '',
                    select: action(t('settings.selectFolder'), null, true, true),
                },
                syncNow: action(t('settings.syncNow'), t('settings.syncReadMergeFolder'), !isSyncing && hasPath, hasPath, isSyncing),
                lastSync: lastSyncCard(t, current.transport.redactText),
            };
        }
        if (state.syncBackend === 'webdav') {
            const url = draft.url ?? state.webdavUrl;
            const form = getSyncWebDavFormState(url);
            return {
                kind: 'webdav',
                title: t('settings.syncBackendWebdav'),
                url: {
                    label: t('settings.webdavUrl'),
                    placeholder: t('settings.webdavUrlPlaceholder'),
                    value: state.webdavUrl,
                    hint: t('settings.webdavHint'),
                    invalid: form.urlError ? t('settings.invalidUrlHttp') : null,
                },
                allowInsecureHttp: { label: t('settings.allowInsecureHttp'), hint: t('settings.allowInsecureHttpHint'), value: state.webdavAllowInsecureHttp },
                username: { label: t('settings.webdavUsername'), placeholder: t('settings.webdavUsernamePlaceholder'), value: state.webdavUsername },
                password: { label: t('settings.webdavPassword'), placeholder: PASSWORD_DOTS, mask: '•'.repeat(state.webdavPassword.length) },
                save: action(t('settings.webdavSave'), t('settings.webdavUrl'), form.canUseActions, form.canUseActions),
                syncNow: action(t('settings.syncNow'), t('settings.syncReadMergeWebdav'), !isSyncing && form.canUseActions, form.canUseActions, isSyncing),
                test: action(
                    t('settings.testConnection'), t('settings.webdavTestHint'),
                    !isSyncing && !isTestingConnection && form.canUseActions, form.canUseActions, isTestingConnection,
                ),
                lastSync: lastSyncCard(t, current.transport.redactText),
            };
        }
        if (!selection.isCloudSyncSelected) return null;
        if (selection.isCloudKitSyncSelected) {
            const details = getCloudKitStatusDetails(state.cloudKitAccountStatus, tr);
            return {
                kind: 'cloudkit',
                help: { title: 'iCloud Sync', text: details.helpText, status: `${tr('settings.syncMobile.accountStatus')}: ${details.label}` },
                syncNow: action(
                    t('settings.syncNow'), tr('settings.syncMobile.readAndMergeTheLatestCloudkitDataNow'),
                    !isSyncing && details.syncEnabled, details.syncEnabled, isSyncing,
                ),
                lastSync: lastSyncCard(t, current.transport.redactText),
            };
        }
        if (selection.isSelfHostedSyncSelected) {
            const url = draft.url ?? state.cloudUrl;
            const token = draft.token ?? state.cloudToken;
            const form = getSyncSelfHostedFormState(url, token, isValidCloudSyncToken);
            return {
                kind: 'selfhosted',
                url: {
                    label: t('settings.cloudUrl'),
                    placeholder: t('settings.cloudUrlPlaceholder'),
                    value: state.cloudUrl,
                    hints: [t('settings.cloudHint'), t('settings.cloudBaseUrlHint')],
                    invalid: form.urlError ? t('settings.invalidUrlHttp') : null,
                },
                allowInsecureHttp: { label: t('settings.allowInsecureHttp'), hint: t('settings.allowInsecureHttpHint'), value: state.cloudAllowInsecureHttp },
                token: {
                    label: t('settings.cloudToken'),
                    placeholder: PASSWORD_DOTS,
                    mask: '•'.repeat(state.cloudToken.length),
                    hint: t('settings.cloudTokenHint'),
                    invalid: form.tokenError ? t('settings.cloudTokenInvalid') : null,
                },
                save: action(t('settings.cloudSave'), t('settings.cloudUrl'), form.canUseActions, form.canUseActions),
                syncNow: action(t('settings.syncNow'), t('settings.syncReadMergeSelfHosted'), !isSyncing && form.canUseActions, form.canUseActions, isSyncing),
                test: action(
                    t('settings.testConnection'), t('settings.cloudTestHint'),
                    !isSyncing && !isTestingConnection && form.canUseActions, form.canUseActions, isTestingConnection,
                ),
                lastSync: lastSyncCard(t, current.transport.redactText),
            };
        }
        if (selection.isDropboxSyncSelected) {
            const configured = p.dropboxConfigured;
            return {
                kind: 'dropbox',
                title: tr('settings.dropboxAppKey'),
                description: tr('settings.syncMobile.oauthWithDropboxAppFolderAccessMindwtrSyncsAppsMindwtr'),
                redirect: `${tr('settings.dropboxRedirectUri')}: ${host.dropbox?.redirectUri() ?? ''}`,
                notConfigured: configured ? null : tr('settings.syncMobile.dropboxAppKeyIsNotConfiguredForThisBuild'),
                status: dropboxConnected ? tr('settings.syncMobile.statusConnected') : tr('settings.syncMobile.statusNotConnected'),
                connected: dropboxConnected,
                connect: action(
                    dropboxConnected ? tr('settings.dropboxDisconnect') : tr('settings.dropboxConnect'),
                    dropboxConnected
                        ? tr('settings.syncMobile.revokeAppTokenAndRemoveLocalAuth')
                        : tr('settings.syncMobile.openDropboxOauthSignInInBrowser'),
                    !dropboxBusy && configured, configured, dropboxBusy,
                ),
                test: action(
                    t('settings.testConnection'), t('settings.dropboxTestHint'),
                    !isTestingConnection && configured && dropboxConnected, dropboxConnected, isTestingConnection,
                ),
                syncNow: action(
                    t('settings.syncNow'), tr('settings.syncMobile.readAndMergeDropboxData'),
                    !isSyncing && configured && dropboxConnected, dropboxConnected, isSyncing,
                ),
                lastSync: lastSyncCard(t, current.transport.redactText),
            };
        }
        return null;
    };

    const isUnlockOnlyAction = (target: { type?: unknown; flow?: unknown; field?: unknown }) => (
        target.type === 'open' || target.type === 'submit' ? target.flow === 'unlock'
            : target.type === 'typed' ? target.field === 'current'
                : target.type === 'cancel' || target.type === 'decline' || target.type === 'retry'
    );
    const encryptionMode = (current: Screen) => current.host.encryption.mode === 'saved-webdav-enable-unlock'
        ? 'saved-webdav-enable-unlock' : current.host.encryption.unlockOnly === true ? 'unlock-only' : 'full';
    const hasProvenWebDavBackend = (current: Screen) => {
        const proven = current.transport.getProven();
        return current.transport.getState().syncBackend === 'webdav' && proven.backend === 'webdav' && !proven.pending;
    };
    const canUnlock = (current: Screen) => {
        const card = current.card?.getState();
        return card?.state === 'remote-encrypted-no-key' && !card.incompleteTransition;
    };
    const canEnable = (current: Screen) => {
        const card = current.card?.getState();
        return card?.state === 'off' && !card.partlyEncrypted
            && (card.incompleteTransitionKind === null || card.incompleteTransitionKind === 'enable');
    };
    const canAbandonEnable = (current: Screen) => current.card?.getState().incompleteTransitionKind === 'enable';
    const canRecheck = (current: Screen) => {
        const card = current.card?.getState();
        return card?.state === 'off' && card.partlyEncrypted && !card.incompleteTransition;
    };
    const selectedEncryptionActionAllowed = (current: Screen, target: { type?: unknown; flow?: unknown; field?: unknown }): boolean => {
        const mode = encryptionMode(current);
        if (mode === 'full') return true;
        if (!hasProvenWebDavBackend(current)) return false;
        if (mode === 'unlock-only') return isUnlockOnlyAction(target)
            && (canUnlock(current) || target.type === 'retry' || target.type === 'cancel');
        if (target.type === 'retry' || target.type === 'cancel') return true;
        if (target.type === 'open' || target.type === 'submit') {
            return target.flow === 'unlock' ? canUnlock(current)
                : target.flow === 'enable' ? canEnable(current)
                    : target.flow === 'abandon' && canAbandonEnable(current);
        }
        if (target.type === 'typed') {
            const flow = current.card?.getState().flow;
            return flow === 'unlock' ? target.field === 'current' && canUnlock(current)
                : flow === 'enable' && (target.field === 'next' || target.field === 'confirm') && canEnable(current);
        }
        return target.type === 'decline' ? canUnlock(current)
            : target.type === 'recheck' && canRecheck(current);
    };

    const buildEncryption = (current: Screen): NativeSyncEncryptionCard | null => {
        const card = current.card?.getState();
        if (!card) return null;
        const t = deps.t();
        const language = deps.language();
        const rows: NativeSyncEncryptionRow[] = [];
        const text = (value: string, tone: 'label' | 'description' | 'warning' | 'danger' = 'description') => rows.push({ kind: 'text', text: value, tone });
        const mode = encryptionMode(current);
        const act = (label: string, target: NativeSyncEncryptionAction, disabled = false) => {
            if (!selectedEncryptionActionAllowed(current, target)) return;
            rows.push({ kind: 'action', label, action: target, enabled: !(disabled || card.busy), busy: card.busy });
        };
        const field = (label: string, name: SyncEncryptionPassphraseField) => {
            if (!selectedEncryptionActionAllowed(current, { type: 'typed', field: name })) return;
            rows.push({ kind: 'field', field: name, label, secure: mode !== 'full' || !card.revealed,
                maxLength: SYNC_ENCRYPTION_PASSPHRASE_MAX_LENGTH, tooLong: t('settings.syncEncryptionPassphraseTooLong') });
        };
        const reveal = () => {
            if (mode === 'full') rows.push({ kind: 'reveal', label: t('settings.syncEncryptionShowPassphrase'), revealed: card.revealed, action: { type: 'reveal' } });
        };
        const { errorMessage, progressLabel, warningMessage } = getSyncEncryptionCardMessages(card, t);
        const error = () => {
            if (errorMessage) text(errorMessage, 'danger');
        };
        const generated = () => {
            if (card.generated) text(t('settings.syncEncryptionGeneratedHint'));
        };
        if (card.state === null) {
            if (!card.stateUnavailable) return null;
            text(t('settings.syncEncryptionStateUnavailable'), 'danger');
            act(t('settings.syncEncryptionRetry'), { type: 'retry' });
            return { title: t('settings.syncEncryption'), guide: null, rows };
        }
        if (card.state === 'off' && card.partlyEncrypted) {
            // Partly encrypted here: nothing syncs or turns on until the location is whole again.
            text(t('settings.syncEncryptionDesc'));
            text(t('settings.syncEncryptionPartlyEncrypted'), 'danger');
            act(t('settings.syncEncryptionRecheck'), { type: 'recheck' });
        } else if (card.state === 'off') {
            text(t('settings.syncEncryptionDesc'));
            if (card.flow === 'none') {
                act(t('settings.syncEncryptionEnable'), { type: 'open', flow: 'enable' });
            } else if (card.flow === 'enable') {
                text(t('settings.syncEncryptionWarningLost'), 'warning');
                text(t('settings.syncEncryptionWarningDevices'), 'warning');
                if (card.pendingFirstSync) text(t('settings.syncEncryptionEnableBeforeFirstSyncHint'));
                field(t('settings.syncEncryptionPassphrase'), 'next');
                field(t('settings.syncEncryptionPassphraseConfirm'), 'confirm');
                error();
                reveal();
                act(t('settings.syncEncryptionGenerate'), { type: 'generate' });
                generated();
                act(t('settings.syncEncryptionEnable'), { type: 'submit', flow: 'enable' }, !card.nextPassphrase || !card.confirmPassphrase);
                act(t('common.cancel'), { type: 'cancel' });
            }
        }
        if (card.state === 'enabled' || card.state === 'remote-plaintext') {
            text(t('settings.syncEncryptionStatusOn'), 'label');
            text(card.state === 'remote-plaintext' ? t('settings.syncEncryptionRemotePlaintextDesc') : t('settings.syncEncryptionDesc'));
            if (card.flow === 'none') {
                // Changing the passphrase would run against a location that no
                // longer holds ciphertext — disabling there is the only remedy.
                if (card.state === 'enabled') act(t('settings.syncEncryptionChange'), { type: 'open', flow: 'change' });
                act(t('settings.syncEncryptionDisable'), { type: 'open', flow: 'disable' });
            }
            if (card.flow === 'change') {
                field(t('settings.syncEncryptionCurrentPassphrase'), 'current');
                field(t('settings.syncEncryptionNewPassphrase'), 'next');
                field(t('settings.syncEncryptionPassphraseConfirm'), 'confirm');
                error();
                reveal();
                act(t('settings.syncEncryptionGenerate'), { type: 'generate' });
                generated();
                act(
                    t('settings.syncEncryptionChange'), { type: 'submit', flow: 'change' },
                    !card.currentPassphrase || !card.nextPassphrase || !card.confirmPassphrase,
                );
                act(t('common.cancel'), { type: 'cancel' });
            }
            if (card.flow === 'disable') {
                text(t(card.pendingFirstSync
                    ? 'settings.syncEncryptionDisableWarningNoBackend'
                    : 'settings.syncEncryptionDisableWarning'), 'warning');
                error();
                act(t('settings.syncEncryptionDisable'), { type: 'submit', flow: 'disable' });
                act(t('common.cancel'), { type: 'cancel' });
            }
        }
        if (card.state === 'remote-encrypted-no-key') {
            text(t('settings.syncEncryptionLockedTitle'), 'label');
            text(t('settings.syncEncryptionLockedDesc'));
            text(t('settings.syncEncryptionPausedDesc'));
            text(t('settings.syncEncryptionLockedRecheckHint'));
            if (card.flow === 'none') {
                act(t('settings.syncEncryptionUnlock'), { type: 'open', flow: 'unlock' });
            } else if (card.flow === 'unlock') {
                field(t('settings.syncEncryptionPassphrase'), 'current');
                error();
                reveal();
                act(t('settings.syncEncryptionUnlock'), { type: 'submit', flow: 'unlock' }, !card.currentPassphrase);
                act(t('settings.syncEncryptionDecline'), { type: 'decline' });
                if (mode !== 'full') act(t('common.cancel'), { type: 'cancel' });
            }
        }
        if (card.flow === 'abandon') {
            text(t('settings.syncEncryptionAbandonWarning'), 'warning');
            error();
            act(t('settings.syncEncryptionAbandon'), { type: 'submit', flow: 'abandon' });
            act(t('common.cancel'), { type: 'cancel' });
        }
        if (progressLabel) text(progressLabel);
        if (warningMessage) text(warningMessage, 'warning');
        // Errors raised outside a flow (an incomplete transition found by the
        // status read) have no field to sit next to.
        if (card.flow === 'none') error();
        // An unfinished change this device cannot finish (its location is gone): drop it here only. Offered in an open flow too,
        // right where a retry just failed.
        if (card.flow !== 'abandon' && card.incompleteTransition) act(t('settings.syncEncryptionAbandon'), { type: 'open', flow: 'abandon' });
        return {
            title: t('settings.syncEncryption'),
            guide: {
                title: t('settings.syncEncryptionGuideTitle'),
                description: t('settings.syncEncryptionGuideDesc'),
                url: getDocsGuideUrl('data-sync/', language, 'sync-encryption'),
            },
            rows,
        };
    };

    const buildView = (current: Screen, draft: Draft): NativeSyncSettings => {
        const t = deps.t();
        const tr = createSyncSettingsTranslator(t);
        const state = current.transport.getState();
        const p = params(current.host);
        const selection = resolveSyncBackendSelection({
            syncBackend: state.syncBackend,
            cloudProvider: state.cloudProvider,
            isFossBuild: p.isFossBuild,
            supportsCloudKit: p.supportsNativeICloudSync,
        });
        const groups = getSyncBackendGroups({ t, isFossBuild: p.isFossBuild, supportsCloudKit: p.supportsNativeICloudSync });
        const selected = (option: SyncSettingsBackendOption) => isSyncBackendOptionSelected(option, state.syncBackend, selection);
        const group = groups.find((entry) => entry.options.some(selected));
        const settings = useTaskStore.getState().settings;
        const card = current.card?.getState();
        return {
            version: NATIVE_HOST_CONTRACT_VERSION,
            revision: `${deps.dataRevision()}:${deps.language()}:${deps.systemLocale() ?? ''}:${current.generation}`,
            configRevision: current.configRevision,
            title: t('settings.sync'),
            backend: {
                title: t('settings.syncBackend'),
                current: getSyncBackendCurrentLabel(state.syncBackend, selection, t),
                hint: t('settings.syncBackendChoiceHint'),
                options: getSyncBackendOptions(groups).map((option) => ({ option, label: getSyncBackendOptionLabel(option, t), selected: selected(option) })),
                group: group ? { title: group.title, description: group.description } : null,
            },
            guide: { title: t('settings.syncSetupGuideTitle'), description: t('settings.syncSetupGuideDesc'), url: getDocsGuideUrl('data-sync/', deps.language()) },
            off: state.syncBackend === 'off' ? { title: t('settings.syncOff'), description: t('settings.syncOffDesc') } : null,
            panel: buildPanel(current, draft),
            encryption: buildEncryption(current),
            preferences: {
                title: t('settings.syncPreferences'),
                description: t('settings.syncPreferencesDesc'),
                rows: buildSyncPreferenceRows(settings.syncPreferences, t),
            },
            recoverySnapshots: {
                title: t('settings.recoverySnapshots'),
                description: tr('settings.syncMobile.savedAutomaticallyBeforeRestoreAndImportOperations'),
                empty: t('settings.recoverySnapshotsEmpty'),
                snapshots: current.snapshots,
            },
            disclosure: { closed: '▸', open: '▾' },
            busy: { syncing: state.isSyncing, testing: state.isTestingConnection, dropbox: state.dropboxBusy, encryption: card?.busy === true },
        };
    };

    /** The open screen, or why there is none. */
    const openedScreen = (): { ok: true; value: Screen } | NativeHostResult<never> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        if (!screen || screen.opening) return fail('ACTION_FAILED', 'Open Settings › Sync first (openSyncSettings), and wait for it');
        return { ok: true, value: screen };
    };

    // Screen commands keep no request payload (several carry a secret), only a fingerprint
    // of their input: a retry of a request still running joins it, a retry of one that
    // finished answers without running it again, and the same UUID with other input is
    // refused. Neither survives a restart; each command is target-state or
    // compare-and-set instead.
    // ponytail: remembers the last 50 finished request UUIDs; an older retry runs as a replay.
    const running = new Map<string, { identity: string; result: Promise<NativeHostResult<NativeSyncCommandResult>> }>();
    const finished = new Map<string, { identity: string; value: NativeSyncCommandResult }>();

    const screenActionReceipt = (
        requestId: string,
        print: string,
    ): NativeHostResult<NativeSyncCommandResult> | Promise<NativeHostResult<NativeSyncCommandResult>> | null => {
        const joined = running.get(requestId);
        const done = finished.get(requestId);
        const known = joined?.identity ?? done?.identity;
        if (known !== undefined && known !== print) return fail('INVALID_INPUT', 'Request ID already belongs to another action');
        if (joined) return joined.result;
        // A finished request answers its first reply and runs nothing (receipt semantics).
        return done ? { ok: true, value: done.value } : null;
    };

    /**
     * Runs a screen action under its request UUID; answers the toasts once its reads
     * settle. `run` may answer a refusal (STALE_REVISION); a device write the store
     * refused answers SAVE_FAILED. Neither is remembered, so the exact retry runs.
     */
    const runScreenAction = (
        requestId: string,
        identity: unknown,
        current: Screen,
        run: () => Promise<NativeHostResult<never> | void> | NativeHostResult<never> | void,
    ): Promise<NativeHostResult<NativeSyncCommandResult>> => {
        const print = fingerprint(identity);
        const receipt = screenActionReceipt(requestId, print);
        if (receipt) return Promise.resolve(receipt);
        const result = (async (): Promise<NativeHostResult<NativeSyncCommandResult>> => {
            if (screen !== current) return fail('ACTION_FAILED', 'Settings › Sync was closed; open it again');
            let cleanupUnconfirmed = false;
            try {
                const refused = await run();
                if (refused && !refused.ok) return fail(refused.error.code, current.transport.redactText(refused.error.message));
            } catch (error) {
                if (error instanceof NativeAttachmentCleanupUnconfirmedError) {
                    cleanupUnconfirmed = true;
                    throw error;
                }
                const message = current.transport.redactText(error instanceof Error ? error.message : String(error));
                return fail(error instanceof SyncSettingsWriteError ? 'SAVE_FAILED' : 'ACTION_FAILED', message);
            } finally {
                if (!cleanupUnconfirmed) {
                    await settle(current);
                    current.configRevision = await readConfigRevision(current.host).catch(() => current.configRevision);
                }
            }
            const value = { toasts: takeToasts() };
            finished.set(requestId, { identity: print, value });
            if (finished.size > 50) finished.delete(finished.keys().next().value as string);
            return { ok: true, value };
        })().finally(() => running.delete(requestId));
        running.set(requestId, { identity: print, result });
        return result;
    };

    /** A form command's compare-and-set: the stored configuration must be the one its form was built from. */
    const refuseStaleConfiguration = async (current: Screen, revision: string): Promise<NativeHostResult<never> | null> => (
        await readConfigRevision(current.host) === revision
            ? null
            : fail('STALE_REVISION', 'The stored sync configuration changed since this form was read; read the screen again')
    );

    const isRequestId = (value: unknown): value is string => typeof value === 'string' && deps.requestIdPattern.test(value);

    /**
     * Off is the target already: stored, proven, shown, and its status reset. React
     * Native would write the same values again; a replay writes nothing.
     */
    const isOffAlready = async (current: Screen): Promise<boolean> => {
        const proven = current.transport.getProven();
        const settings = useTaskStore.getState().settings;
        if (current.transport.getState().syncBackend !== 'off' || proven.backend !== 'off' || proven.pending) return false;
        if (settings.lastSyncStatus !== 'idle' || settings.lastSyncError !== undefined) return false;
        const [[, stored]] = await current.host.storage.multiGet([SYNC_BACKEND_KEY]);
        return stored === 'off';
    };

    /** The panel's action, as the view shows it for these fields: null when it cannot be pressed. */
    const panelAction = (current: Screen, pick: 'save' | 'syncNow' | 'test', draft: Draft) => {
        const panel = buildPanel(current, draft);
        if (!panel) return null;
        const control = (panel as Record<string, unknown>)[pick] as NativeSyncAction | undefined;
        return control?.enabled ? panel : null;
    };

    const webdavSettings = (current: Screen, fields: NativeSyncWebDavFields): SyncSettingsWebDavFields => ({
        allowInsecureHttp: fields.allowInsecureHttp,
        password: fields.password ?? current.transport.getState().webdavPassword,
        url: fields.url,
        username: fields.username,
    });
    const selfHostedSettings = (current: Screen, fields: NativeSyncSelfHostedFields): SyncSettingsSelfHostedFields => ({
        allowInsecureHttp: fields.allowInsecureHttp,
        token: fields.token ?? current.transport.getState().cloudToken,
        url: fields.url,
    });

    return {
        /**
         * Opens Settings › Sync: reads the stored configuration (a backend this
         * build cannot use is turned off, as on React Native), the Dropbox and
         * iCloud accounts and the encryption state. Answers the view and any toasts.
         */
        async openSyncSettings(): Promise<NativeHostResult<NativeSyncSettings & NativeSyncCommandResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return fail('ACTION_FAILED', 'Sync is not available on this host yet');
            if (host.encryption.mode !== undefined
                && (host.encryption.mode !== 'saved-webdav-enable-unlock' || host.encryption.unlockOnly !== undefined)) {
                return fail('ACTION_FAILED', 'The selected sync encryption mode cannot be combined with unlockOnly');
            }
            const current = await openScreen(host);
            // A close, or another open, while this one read: its view is gone.
            if (screen !== current) return fail('ACTION_FAILED', 'Settings › Sync closed or opened again before it finished opening');
            return { ok: true, value: { ...buildView(current, {}), toasts: takeToasts() } };
        },

        /** Leaves the screen: a backend chosen but not proven is dropped. */
        closeSyncSettings(): NativeHostResult<null> {
            closeScreen();
            takeToasts();
            return { ok: true, value: null };
        },

        /** The open screen. `draft` is the form's typed URL and token (null: the token was not edited). */
        getSyncSettings(input: { draft?: Draft } = {}): NativeHostResult<NativeSyncSettings> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const draft = isObjectRecord(input) ? input.draft ?? {} : null;
            if (!draft || !isObjectRecord(draft) || Object.keys(draft).some((key) => key !== 'url' && key !== 'token')
                || (draft.url !== undefined && !isText(draft.url, 2000))
                || (draft.token !== undefined && draft.token !== null && !isText(draft.token, 2000))) {
                return fail('INVALID_INPUT', 'draft is an optional { url, token } of typed text');
            }
            return { ok: true, value: buildView(opened.value, draft as Draft) };
        },

        /** Chooses a backend option; a complete target activates through its first sync. */
        async selectSyncBackend(input: { requestId: string; option: SyncSettingsBackendOption }): Promise<NativeHostResult<NativeSyncCommandResult>> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const current = opened.value;
            const offered = buildView(current, {}).backend.options.map((entry) => entry.option);
            if (!isObjectRecord(input) || !isRequestId(input.requestId) || !offered.includes(input.option)) {
                return fail('INVALID_INPUT', 'A request UUID and a backend option the screen offers are required');
            }
            return runScreenAction(input.requestId, ['selectSyncBackend', input.option], current, async () => {
                if (input.option === 'off' && await isOffAlready(current)) {
                    const saved = await durableSave();
                    return saved.ok ? undefined : saved;
                }
                switch (input.option) {
                    case 'off': {
                        let writeFailed = false;
                        let writeError: unknown;
                        try {
                            await current.transport.handleSelectSyncBackend('off');
                        } catch (error) {
                            if (error instanceof NativeAttachmentCleanupUnconfirmedError) throw error;
                            writeFailed = true;
                            writeError = error;
                        }
                        // Off resets status before its KV write, including a refused write.
                        // Acknowledge only after that queued store change is durable.
                        const saved = await durableSave();
                        if (writeFailed) throw writeError;
                        if (!saved.ok) return saved;
                        if (current.host.platform.os === 'ios') {
                            try {
                                await current.host.log.info('Native Sync Off durably acknowledged', {
                                    scope: 'native-sync', force: true,
                                    extra: { releaseCheck: 'v1.3.5/native-sync-off-durable', operation: 'off', outcome: 'confirmed' },
                                });
                            } catch {
                                // Diagnostics are best-effort after the durable acknowledgement.
                            }
                        }
                        return undefined;
                    }
                    case 'dropbox':
                    case 'selfhosted':
                    case 'cloudkit':
                        return current.transport.handleSelectCloudProvider(input.option);
                    default:
                        return current.transport.handleSelectSyncBackend(input.option);
                }
            });
        },

        /** The WebDAV or self-hosted form's Save: proves the settings with a sync, then stores them. */
        async saveSyncBackend(input: {
            requestId: string;
            /** The view's `configRevision` when the form was read. */
            revision: string;
            webdav?: NativeSyncWebDavFields;
            selfHosted?: NativeSyncSelfHostedFields;
        }): Promise<NativeHostResult<NativeSyncCommandResult>> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const current = opened.value;
            const webdav = isObjectRecord(input) && input.webdav !== undefined ? readWebDavFields(input.webdav) : null;
            const selfHosted = isObjectRecord(input) && input.selfHosted !== undefined ? readSelfHostedFields(input.selfHosted) : null;
            if (!isObjectRecord(input) || !isRequestId(input.requestId) || !isText(input.revision, 100) || Boolean(webdav) === Boolean(selfHosted)) {
                return fail('INVALID_INPUT', 'A request UUID, the form\'s configRevision and the shown form\'s fields (webdav or selfHosted) are required');
            }
            const kind = webdav ? 'webdav' : 'selfhosted';
            const panel = panelAction(current, 'save', webdav ? { url: webdav.url } : { url: selfHosted!.url, token: selfHosted!.token });
            if (!panel || panel.kind !== kind) return fail('ACTION_FAILED', 'That form\'s Save is not available now; read the screen again');
            const identity = ['saveSyncBackend', input.revision, fieldsPrint(webdav ?? selfHosted)];
            return runScreenAction(input.requestId, identity, current, async () => {
                const stale = await refuseStaleConfiguration(current, input.revision);
                if (stale) return stale;
                return webdav
                    ? current.transport.handleSaveWebDavSettings(webdavSettings(current, webdav))
                    : current.transport.handleSaveSelfHostedSettings(selfHostedSettings(current, selfHosted!));
            });
        },

        /**
         * The shown panel's Sync now. The WebDAV and self-hosted forms send their
         * fields (React Native syncs what the form holds); the other panels send none.
         */
        async syncNow(input: {
            requestId: string;
            /** With a form's fields: the view's `configRevision` when the form was read. */
            revision?: string;
            webdav?: NativeSyncWebDavFields;
            selfHosted?: NativeSyncSelfHostedFields;
        }): Promise<NativeHostResult<NativeSyncCommandResult>> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const current = opened.value;
            const kind = buildPanel(current, {})?.kind;
            const webdav = isObjectRecord(input) && input.webdav !== undefined ? readWebDavFields(input.webdav) : null;
            const selfHosted = isObjectRecord(input) && input.selfHosted !== undefined ? readSelfHostedFields(input.selfHosted) : null;
            const withFields = kind === 'webdav' || kind === 'selfhosted';
            const fieldsOk = kind === 'webdav' ? Boolean(webdav) && input.selfHosted === undefined
                : kind === 'selfhosted' ? Boolean(selfHosted) && input.webdav === undefined
                    : input?.webdav === undefined && input?.selfHosted === undefined;
            if (!isObjectRecord(input) || !isRequestId(input.requestId) || !fieldsOk
                || (withFields ? !isText(input.revision, 100) : input.revision !== undefined)) {
                return fail('INVALID_INPUT', 'A request UUID, and the WebDAV or self-hosted form\'s fields with its configRevision when that form shows, are required');
            }
            const draft = webdav ? { url: webdav.url } : selfHosted ? { url: selfHosted.url, token: selfHosted.token } : {};
            if (!panelAction(current, 'syncNow', draft)) return fail('ACTION_FAILED', 'Sync now is not available now; read the screen again');
            const identity = ['syncNow', kind, input.revision ?? null, fieldsPrint(webdav ?? selfHosted)];
            return runScreenAction(input.requestId, identity, current, async () => {
                // A form's Sync now stores the form's settings, as its Save does.
                if (withFields) {
                    const stale = await refuseStaleConfiguration(current, input.revision!);
                    if (stale) return stale;
                }
                switch (kind) {
                    case 'webdav':
                        return current.transport.handleSync({ backend: 'webdav', webdav: webdavSettings(current, webdav!) });
                    case 'selfhosted':
                        return current.transport.handleSync({ backend: 'cloud', cloud: selfHostedSettings(current, selfHosted!), cloudProvider: 'selfhosted' });
                    case 'file':
                        return current.transport.handleSync({ backend: 'file' });
                    case 'dropbox':
                        return current.transport.handleSync({ backend: 'cloud', cloudProvider: 'dropbox' });
                    default:
                        return current.transport.handleSync({ backend: 'cloudkit', cloudProvider: 'cloudkit' });
                }
            });
        },

        /** The shown panel's Test connection; it stores nothing but the WebDAV capability proof. */
        async testSyncConnection(input: {
            webdav?: NativeSyncWebDavFields;
            selfHosted?: NativeSyncSelfHostedFields;
        } = {}): Promise<NativeHostResult<NativeSyncCommandResult>> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const current = opened.value;
            const kind = buildPanel(current, {})?.kind;
            const webdav = isObjectRecord(input) && input.webdav !== undefined ? readWebDavFields(input.webdav) : null;
            const selfHosted = isObjectRecord(input) && input.selfHosted !== undefined ? readSelfHostedFields(input.selfHosted) : null;
            const fieldsOk = kind === 'webdav' ? Boolean(webdav) : kind === 'selfhosted' ? Boolean(selfHosted) : kind === 'dropbox' && !webdav && !selfHosted;
            if (!isObjectRecord(input) || !fieldsOk) return fail('INVALID_INPUT', 'The WebDAV or self-hosted form\'s fields, or nothing for Dropbox, are required');
            const draft = webdav ? { url: webdav.url } : selfHosted ? { url: selfHosted.url, token: selfHosted.token } : {};
            if (!panelAction(current, 'test', draft)) return fail('ACTION_FAILED', 'Test connection is not available now; read the screen again');
            if (kind === 'webdav') await current.transport.handleTestConnection('webdav', { webdav: webdavSettings(current, webdav!) });
            else if (kind === 'selfhosted') await current.transport.handleTestConnection('cloud', { cloud: selfHostedSettings(current, selfHosted!), cloudProvider: 'selfhosted' });
            else await current.transport.handleTestDropboxConnection();
            await settle(current);
            return { ok: true, value: { toasts: takeToasts() } };
        },

        /** File Sync's Select folder: the system picker, then the picked folder activates through its first sync. */
        async pickSyncFolder(input: { requestId: string }): Promise<NativeHostResult<NativeSyncCommandResult>> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const current = opened.value;
            if (!isObjectRecord(input) || !isRequestId(input.requestId)) return fail('INVALID_INPUT', 'A request UUID is required');
            if (!current.host.pickSyncFolder) return fail('ACTION_FAILED', 'The folder picker is not available on this host yet');
            if (buildPanel(current, {})?.kind !== 'file') return fail('ACTION_FAILED', 'Select folder is not available now; read the screen again');
            return runScreenAction(input.requestId, ['pickSyncFolder'], current, () => current.transport.handleSetSyncPath());
        },

        /** Dropbox's Connect: sign-in, then the account activates through its first sync. Nothing when already connected. */
        async connectDropbox(input: { requestId: string }): Promise<NativeHostResult<NativeSyncCommandResult>> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const current = opened.value;
            if (!isObjectRecord(input) || !isRequestId(input.requestId)) return fail('INVALID_INPUT', 'A request UUID is required');
            if (!current.host.dropbox) return fail('ACTION_FAILED', 'Dropbox is not available on this host yet');
            const panel = buildPanel(current, {});
            if (panel?.kind !== 'dropbox' || !panel.connect.enabled) return fail('ACTION_FAILED', 'Connect Dropbox is not available now; read the screen again');
            return runScreenAction(input.requestId, ['connectDropbox'], current, () => {
                // Target state: the toggle shows Disconnect for a connected account.
                if (panel.connected) return undefined;
                return current.transport.handleConnectDropbox();
            });
        },

        /** Dropbox's Disconnect: turns Dropbox sync off first, then revokes and forgets the tokens. Nothing when not connected. */
        async disconnectDropbox(input: { requestId: string }): Promise<NativeHostResult<NativeSyncCommandResult>> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const current = opened.value;
            if (!isObjectRecord(input) || !isRequestId(input.requestId)) return fail('INVALID_INPUT', 'A request UUID is required');
            if (!current.host.dropbox) return fail('ACTION_FAILED', 'Dropbox is not available on this host yet');
            const panel = buildPanel(current, {});
            if (panel?.kind !== 'dropbox' || !panel.connect.enabled) return fail('ACTION_FAILED', 'Disconnect Dropbox is not available now; read the screen again');
            return runScreenAction(input.requestId, ['disconnectDropbox'], current, () => {
                // Target state: the toggle shows Connect once the account is gone.
                if (!panel.connected) return undefined;
                return current.transport.handleDisconnectDropbox();
            });
        },

        /** A settings sync option. Target-state: an option already holding the value is not written. */
        async setSyncPreference(input: { requestId: string; key: SyncPreferenceKey; value: boolean }): Promise<NativeHostResult<{ changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isRequestId(input.requestId)
                || !(SYNC_PREFERENCE_KEYS as readonly string[]).includes(input.key as string) || typeof input.value !== 'boolean') {
                return fail('INVALID_INPUT', 'A request UUID, a sync option and a boolean are required');
            }
            return receipts.run<{ changed: boolean }>(input.requestId, JSON.stringify(['syncPreference', input.key, input.value]), async () => {
                const settings = useTaskStore.getState().settings;
                if (getSyncPreferenceValues(settings.syncPreferences)[input.key] === input.value) return { ok: true, value: { changed: false } };
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(
                    buildSyncPreferencesUpdate(settings.syncPreferences, { [input.key]: input.value }),
                ));
                return settleWrite(written, { changed: true });
            });
        },

        /**
         * The encryption card. `typed` sends a field's text as the user edits it
         * (it clears the card's error); `generate` answers the new passphrase, to
         * show in both new-passphrase fields; a `submit` (with its request UUID)
         * runs the open flow with the typed fields and answers once it finishes.
         */
        async runSyncEncryptionAction(input: {
            requestId?: string;
            revision?: string;
            action: NativeSyncEncryptionAction | { type: 'typed'; field: SyncEncryptionPassphraseField; value: string };
        }): Promise<NativeHostResult<NativeSyncCommandResult & { passphrase: string | null }>> {
            const opened = openedScreen();
            if (!opened.ok) return opened;
            const current = opened.value;
            const card = current.card;
            const target = isObjectRecord(input) && isObjectRecord(input.action) ? input.action : null;
            const type = target?.type;
            const valid = target && (
                (type === 'open' || type === 'submit') ? Object.keys(target).length === 2 && FLOWS.has(target.flow as string)
                    : type === 'typed' ? Object.keys(target).length === 3 && PASSPHRASE_FIELDS.has(target.field as string) && isText(target.value, 1000)
                        : ['cancel', 'generate', 'reveal', 'decline', 'retry', 'recheck'].includes(type as string) && Object.keys(target).length === 1
            );
            if (type === 'typed' && typeof target!.value === 'string' && target!.value.length > SYNC_ENCRYPTION_PASSPHRASE_MAX_LENGTH) {
                return fail('INVALID_INPUT', deps.t()('settings.syncEncryptionPassphraseTooLong'));
            }
            const mode = encryptionMode(current);
            const selected = mode !== 'full';
            const needsRequest = type === 'submit' || type === 'decline'
                || mode === 'saved-webdav-enable-unlock' && type === 'recheck';
            if (!valid || (needsRequest ? !isRequestId(input.requestId) : input.requestId !== undefined)) {
                return fail('INVALID_INPUT', 'An encryption card action is required; an owned submit, decline or selected recheck takes a request UUID');
            }
            if ((selected || input.revision !== undefined) && (!isText(input.revision, 100) || !input.revision)) {
                return fail('INVALID_INPUT', 'An encryption action requires a nonempty configuration revision of at most 100 characters');
            }
            if (!card) return fail('ACTION_FAILED', 'This backend has no encryption card; read the screen again');
            const printCardFields = () => {
                const fields = card.getState();
                return [secretPrint(fields.currentPassphrase), secretPrint(fields.nextPassphrase), secretPrint(fields.confirmPassphrase)];
            };
            const capturedFields = printCardFields(), capturedFlow = card.getState().flow;
            // The passphrases the submit runs with are part of its identity, as fingerprints.
            const identity = ['encryption', target, ...capturedFields,
                ...(input.revision === undefined ? [] : [input.revision])];
            // A Recheck disables and can remove its own button. Its exact receipt
            // bypasses current-card admission, but still belongs to this saved target.
            if (mode === 'saved-webdav-enable-unlock' && type === 'recheck') {
                const receipt = screenActionReceipt(input.requestId!, fingerprint(identity));
                if (receipt) {
                    if ('ok' in receipt && !receipt.ok) return receipt;
                    const stale = await refuseStaleConfiguration(current, input.revision!);
                    if (stale) return stale;
                    const [[, stored]] = await current.host.storage.multiGet([SYNC_BACKEND_KEY]);
                    if (stored?.trim() !== 'webdav' || !hasProvenWebDavBackend(current)) {
                        return fail('ACTION_FAILED', 'This action requires a saved WebDAV backend without a staged selection');
                    }
                    const result = await receipt;
                    return result.ok ? { ok: true, value: { ...result.value, passphrase: null } } : result;
                }
            }
            if (selected && !selectedEncryptionActionAllowed(current, target!)) {
                return fail('ACTION_FAILED', mode === 'unlock-only'
                    ? 'This host only supports unlocking saved WebDAV encryption'
                    : 'This encryption action is not available for the saved WebDAV location');
            }
            const refuseSelectedConfiguration = async (): Promise<NativeHostResult<never> | null> => {
                if (input.revision !== undefined) {
                    const stale = await refuseStaleConfiguration(current, input.revision);
                    if (stale) return stale;
                }
                if (selected) {
                    const [[, stored]] = await current.host.storage.multiGet([SYNC_BACKEND_KEY]);
                    if (stored?.trim() !== 'webdav' || !hasProvenWebDavBackend(current)) {
                        return fail('ACTION_FAILED', mode === 'unlock-only'
                            ? 'Unlock requires a saved WebDAV backend without a staged selection'
                            : 'This action requires a saved WebDAV backend without a staged selection');
                    }
                    if (type !== 'retry' && type !== 'cancel' && !selectedEncryptionActionAllowed(current, target!)) {
                        return fail('ACTION_FAILED', mode === 'unlock-only'
                            ? 'This WebDAV location is not available for passphrase unlock'
                            : 'This encryption action is not available for the saved WebDAV location');
                    }
                }
                const actualFields = printCardFields();
                if (screen !== current || current.card !== card || card.getState().flow !== capturedFlow
                    || capturedFields.some((print, index) => print !== actualFields[index])) {
                    return fail('ACTION_FAILED', 'The encryption card changed while its configuration was checked; read the screen again');
                }
                return null;
            };
            const offered = (buildEncryption(current)?.rows ?? []).some((row) => (
                (row.kind === 'action' && row.enabled) || row.kind === 'reveal')
                && row.action.type === type
                && (!('flow' in row.action) || ('flow' in target! && row.action.flow === target!.flow)));
            if (type !== 'typed' && !offered) return fail('ACTION_FAILED', 'That encryption action is not showing; read the screen again');
            if (type === 'typed' && !(buildEncryption(current)?.rows ?? []).some((row) => row.kind === 'field' && row.field === target!.field)) {
                return fail('ACTION_FAILED', 'That field is not showing; read the screen again');
            }
            if ((type === 'generate' || type === 'submit' || type === 'decline' || type === 'recheck') && !current.host.encryption.transitions) {
                return fail('ACTION_FAILED', 'Sync encryption is not available on this host yet');
            }
            if (!needsRequest && (selected || input.revision !== undefined)) {
                const refused = await refuseSelectedConfiguration();
                if (refused) return refused;
            }
            const answer = (passphrase: string | null = null) => ({ ok: true as const, value: { toasts: takeToasts(), passphrase } });
            if (type === 'recheck' && mode !== 'saved-webdav-enable-unlock') {
                await card.recheckLocation();
                return answer();
            }
            switch (type) {
                case 'open':
                    card.openFlow(target!.flow as SyncEncryptionCardFlow);
                    return answer();
                case 'cancel':
                    card.closeFlow();
                    return answer();
                case 'reveal':
                    card.toggleRevealed();
                    return answer();
                case 'typed':
                    card.setField(target!.field as SyncEncryptionPassphraseField, target!.value as string);
                    return answer();
                case 'generate':
                    card.generate();
                    return answer(card.getState().nextPassphrase);
                case 'retry':
                    await card.retryState();
                    return answer();
                default: {
                    const run = type === 'decline'
                        ? () => card.decline()
                        : type === 'recheck' ? () => card.recheckLocation()
                        : target!.flow === 'enable' ? () => card.submitEnable()
                            : target!.flow === 'change' ? () => card.submitChange()
                                : target!.flow === 'disable' ? () => card.submitDisable()
                                    : target!.flow === 'abandon' ? () => card.submitAbandon()
                                        : () => card.submitUnlock();
                    const result = await runScreenAction(input.requestId!, identity, current, async () => {
                        try {
                            if (selected || input.revision !== undefined) {
                                const refused = await refuseSelectedConfiguration();
                                if (refused) return refused;
                            }
                            await run();
                        } finally {
                            // Only the owned submit retires text; joined or rejected callers do not own it.
                            if (selected && type === 'submit') card.clearPassphrases();
                        }
                    });
                    return result.ok ? { ok: true, value: { ...result.value, passphrase: null } } : result;
                }
            }
        },
    };
}
