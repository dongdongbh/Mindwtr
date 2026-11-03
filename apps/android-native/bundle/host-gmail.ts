import {
    clearGmailReceiptsReset,
    createGmailCaptureRuntime,
    createGmailCaptureTransport,
    generateUUID,
    gmailCaptureErrorTranslation,
    gmailReceiptsWereReset,
    openGmailReceiptStore,
    safeFormatDate,
    toGmailCaptureError,
    type GmailAuthorization,
    type GmailCaptureController,
    type GmailCaptureStatus,
    type GmailReceiptFiles,
    type GmailReceiptStore,
    type Task,
} from '@mindwtr/core';
import { DOMParser } from '@xmldom/xmldom';


export type NativeGmailBindings = {

    call: (request: { op: string; path?: string }) => Promise<unknown>;

    file: (op: string, name: string, to?: string) => string;
    sql: (name: string, sql: string, paramsJson: string) => string;
    addTasks: (items: Array<{ title: string; initialProps?: Partial<Task>; captureId: string }>) => Promise<{ success: boolean; error?: string }>;
    flushPendingSave: () => Promise<void>;

    requireSaved: () => void;
    sandbox: () => boolean;
    logInfo: (message: string, meta: { scope: string; force?: boolean; context: Record<string, string> }) => void;
    logWarn: (message: string, meta: { scope: string; force?: boolean; context: Record<string, string> }) => void;

    statusChanged: (status: GmailStatusView) => void;

    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
};


export type GmailStatusView = GmailCaptureStatus & { lastPollText: string | null; lastErrorKey: string | null };
const statusView = (status: GmailCaptureStatus): GmailStatusView => ({
    ...status,
    lastPollText: status.lastPollAt ? safeFormatDate(status.lastPollAt, 'PPpp', status.lastPollAt) : null,
    lastErrorKey: status.lastError ? gmailCaptureErrorTranslation(status.lastError) : null,
});

const STORAGE_FAILURE = { kind: 'storage', message: 'Gmail capture could not save securely.' };

export function createNativeGmail(bindings: NativeGmailBindings) {


    const request = async (op: string, path?: string): Promise<never> => {
        try {
            return await bindings.call(path === undefined ? { op } : { op, path }) as never;
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            throw { code: /^E_GMAIL_[A-Z]+$/.test(message) ? message : 'E_GMAIL_OTHER' };
        }
    };
    const authorization: GmailAuthorization = {
        status: () => request('status'),
        connect: () => request('connect'),
        cancel: () => request('cancel'),
        disconnect: () => request('disconnect'),
        get: (path) => request('get', path),
    };

    const files: GmailReceiptFiles = {
        exists: (name) => bindings.file('exists', name) === 'true',
        size: (name) => Number(bindings.file('size', name)),
        create: (name) => { bindings.file('create', name); },
        rename: (from, to) => { bindings.file('rename', from, to); },
        remove: (name) => { bindings.file('remove', name); },
        list: () => JSON.parse(bindings.file('list', '')) as string[],
        open: (name) => {
            bindings.file('open', name);
            return {
                executeSync: (sql, params = []) => ({ rows: JSON.parse(bindings.sql(name, sql, JSON.stringify(params))) as Record<string, unknown>[] }),
                close: () => { bindings.file('close', name); },
            };
        },
    };

    let store: GmailReceiptStore | undefined;
    let storeFailed = false;
    const getStore = (): GmailReceiptStore => {
        if (store) return store;
        if (storeFailed) throw STORAGE_FAILURE;
        let stage = 'file';
        try {
            store = openGmailReceiptStore(files, {
                onStage: (next) => { stage = next; },
                logWarn: (message, extra) => bindings.logWarn(message, { scope: 'gmail-capture', force: true, context: extra }),
            });
            return store;
        } catch (error) {
            storeFailed = true;
            const errorKind = error instanceof TypeError ? 'type' : error instanceof Error ? 'native' : 'storage';
            try {
                bindings.logWarn('Native Android Gmail receipt storage unavailable', { scope: 'gmail-capture', force: true,
                    context: { releaseCheck: 'v1.3.8/native-gmail-receipts', stage, errorKind } });
            } catch {                                                   }
            throw STORAGE_FAILURE;
        }
    };

    const runtime = createGmailCaptureRuntime(createGmailCaptureTransport(authorization, getStore, generateUUID, DOMParser));
    runtime.subscribeGmailCaptureStatus((status) => { try { bindings.statusChanged(statusView(status)); } catch {                                 } });


    let ready = false;
    let controller: GmailCaptureController | null = null;
    const stop = () => {
        runtime.registerGmailCaptureController(null);
        controller?.pause();
        controller?.dispose();
        controller = null;
    };
    const start = () => {
        if (controller || bindings.sandbox()) return;
        controller = runtime.createGmailCaptureController({
            addTasks: bindings.addTasks,


            flushPendingSave: async () => {
                await bindings.flushPendingSave();
                bindings.requireSaved();
            },
            initialDelayMs: 1_000,
            logInfo: (message, extra) => bindings.logInfo(message, { scope: 'gmail-capture', context: extra ?? {} }),
            ...(bindings.setTimer ? { setTimer: bindings.setTimer } : {}),
            ...(bindings.clearTimer ? { clearTimer: bindings.clearTimer } : {}),
        });
        runtime.registerGmailCaptureController(controller);
        controller.start();
    };


    const requests: Record<string, (input: { labelId?: string; enabled?: boolean }) => Promise<unknown> | unknown> = {
        config: () => runtime.getGmailCaptureConfig(),
        labels: () => runtime.getGmailCaptureLabels(),
        status: () => statusView(runtime.getGmailCaptureStatus()),
        receiptsReset: () => { try { return gmailReceiptsWereReset(files); } catch { return false; } },
        clearReceiptsReset: () => { try { clearGmailReceiptsReset(files); } catch {                                               } return null; },
        connect: async () => {
            let outcome = 'connected';
            try {
                return await runtime.connectGmailCapture();
            } catch (error) {
                outcome = toGmailCaptureError(error).kind;
                throw error;
            } finally {
                try {
                    bindings.logInfo('Native Android Gmail connect', { scope: 'gmail-capture', force: true,
                        context: { releaseCheck: 'v1.3.8/native-gmail-connect', outcome } });
                } catch {                                                   }
            }
        },
        cancel: () => runtime.cancelGmailCapture(),
        configure: (input) => runtime.configureGmailCapture(String(input.labelId ?? ''), input.enabled === true),
        disconnect: () => runtime.disconnectGmailCapture(),
        checkNow: () => runtime.pollGmailCaptureNow(),
    };

    return {

        start(appState: string) {
            ready = true;
            if (appState === 'active') start();
        },

        appState(next: string) {
            if (!ready) return;
            if (next === 'active') start();
            else stop();
        },

        async request(name: string, input: { labelId?: string; enabled?: boolean }) {
            const run = requests[name];
            if (!run) throw new Error(`INVALID_INPUT: no Gmail request ${name}`);
            try {
                return { value: (await run(input)) ?? null };
            } catch (error) {
                return { errorKey: gmailCaptureErrorTranslation(toGmailCaptureError(error)) };
            }
        },
    };
}
