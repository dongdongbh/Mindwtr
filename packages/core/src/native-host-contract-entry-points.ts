/**
 * The native host contract for outside entry points: what a link, an Android text share, an assistant note, or the
 * capture popup's Import .txt opens. Kept in its own file and spread into createNativeHostContract. Kotlin reads the
 * intent (its data, its text extras, the picked file's text) and opens what this names; every rule is core's:
 * React Native's system-path rules and its root layout's capture, share and entity handling (entry-points.ts,
 * capture-deeplink.ts), and the capture popup's import (quick-capture-model.ts).
 *
 * Where React Native opens its capture confirmation screen (capture-modal.tsx: a capture link, a share, an assistant
 * note, a widget's quick capture), this answers the route params React Native pushes to it, which openCaptureModal
 * takes (native-host-contract-capture-modal.ts): a capture link's tags and project stay the screen's props, never
 * title text. The capture feature (React Native's capture-quick tab route) opens the capture popup, as there.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the import cycle between the two files
 * is safe.
 */
import {
    normalizeShortcutTags,
    parseEntityOpenUrl,
    parseShortcutCaptureUrl,
    type ShortcutCapturePayload,
} from './capture-deeplink';
import {
    buildCreateNoteCapture,
    buildShareCaptureDraft,
    readAndroidTextShare,
    resolveEntityOpenTarget,
    resolveSystemPath,
} from './entry-points';
import { parseContextAutomationUrl, type ContextAutomationPayload } from './context-automation';
import { DEFAULT_GLOBAL_SEARCH_FILTERS, type GlobalSearchFilterState } from './global-search-model';
import type { CaptureModalParams } from './capture-modal-model';
import { CAPTURE_MODAL_PARAM_LIMIT } from './native-host-contract-capture-modal';
import { tFallback, type TranslateFn } from './i18n';
import { NATIVE_HOST_CONTRACT_VERSION, type NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import { splitQuickAddBulkLines } from './quick-add';
import {
    createQuickCaptureOptions,
    getQuickCaptureBulkConfirm,
    resolveQuickCaptureDefaultAreaId,
    type QuickCaptureNotice,
    type QuickCaptureOptions,
} from './quick-capture-model';
import { isSandboxMode } from './sandbox';
import { logError, logInfo, logWarn } from './logger';
import type { NativeAttachmentsHost } from './native-host-contract-attachments';
import { requestRowId } from './native-request-receipts';
import { buildShareIntentFileCaptureParams, SHARE_INTENT_MAX_FILES } from './share-capture-files';
import type { Attachment } from './types';
import { useTaskStore } from './store';

type EntryPointDeps = {
    readiness: () => NativeHostResult<null>;
    t: () => TranslateFn;
    requestIdPattern: RegExp;
    /** The host's attachment IO (createNativeHostContract's `attachments`): a file share's copies. */
    attachments: () => NativeAttachmentsHost | null;
};

/**
 * A shared file as the host staged it when the share arrived (the share's read grant ends with it): the staged copy's
 * absolute path (null: it could not be read), and the provider's display name, MIME type and size (null when unknown).
 */
export type NativeSharedFile = { path: string | null; name: string | null; mimeType: string | null; size: number | null };

/** A link's whole URL and the app's own scheme; a text share's EXTRA_TEXT, EXTRA_TITLE and EXTRA_SUBJECT; an assistant note's name and text extras. */
export type NativeEntryPointInput =
    | { kind: 'link'; url: string; scheme: string }
    | { kind: 'share'; text: string | null; title: string | null; subject: string | null }
    | { kind: 'createNote'; name: string | null; text: string | null; extraText: string | null };

export type NativeEntryPoint = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /**
     * React Native's route the entry goes to (Expo Router's path: '/inbox', '/focus', '/projects', '/projects-screen',
     * '/waiting', '/someday', '/review-tab', '/calendar', '/global-search', '/settings', or any other path a link names).
     * Null: the app stays where it is.
     */
    route: string | null;
    /** A task to open in the editor over the route, on its View tab, and outline on its row (React Native's taskId and setHighlightTask). */
    taskId: string | null;
    /** A project to open on React Native's Projects screen. */
    projectId: string | null;
    /** React Native's global search, open with this query and these filters (null: core's defaults). */
    search: { query: string; filters: GlobalSearchFilterState | null } | null;
    /** The capture popup, open with this text and these options (the capture feature, as React Native's tab route opens it). */
    capture: { text: string; options: QuickCaptureOptions } | null;
    /** React Native's capture confirmation screen, with the route params React Native pushes to it (openCaptureModal's `params`). */
    captureModal: { params: CaptureModalParams } | null;
    /** React Native's toast (a missing task link's has no title). */
    notice: QuickCaptureNotice | Omit<QuickCaptureNotice, 'title'> | null;
    /**
     * A context automation link (`mindwtr://contexts?context=@home&contextAction=activate`): run it as the automation broadcast
     * runs (runContextAutomation), open nothing, and leave the app, as React Native's root layout does.
     */
    contextAutomation: ContextAutomationPayload | null;
};

/** The capture popup's Import .txt: ask to create one task per line, put one line in the field, do nothing, or refuse. */
export type NativeQuickCaptureImport =
    /** Ask with this text, then send submitQuickCaptureLines with `text` as the text and one capture ID per line. */
    | { kind: 'confirmLines'; confirm: ReturnType<typeof getQuickCaptureBulkConfirm>; lineCount: number; text: string }
    | { kind: 'setText'; text: string }
    | { kind: 'empty' }
    | { kind: 'refused'; notice: QuickCaptureNotice };

const URL_LIMIT = 16_000;
/** The capture popup's text limit (native-host-contract-quick-capture.ts). */
const TEXT_LIMIT = 100_000;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{0,31}$/;
const isOptionalString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const longerThan = (value: string | null, max: number) => (value?.length ?? 0) > max;

/**
 * The capture screen's route params for a title and its preset props, as React Native's root layout pushes them
 * (openCaptureConfirmation, buildShareIntentCaptureParams): each value URI-encoded, the props as JSON.
 */
const captureModalParams = (title: string, props: { description?: string; tags?: string[] }, project?: string): CaptureModalParams => ({
    initialValue: encodeURIComponent(title),
    ...(Object.keys(props).length > 0 ? { initialProps: encodeURIComponent(JSON.stringify(props)) } : {}),
    ...(project ? { project: encodeURIComponent(project) } : {}),
});
/** Whether the capture screen takes these params: each at most its limit, encoded. */
const fitsCaptureModal = (params: CaptureModalParams) => Object.values(params).every((param) => typeof param === 'string' && param.length <= CAPTURE_MODAL_PARAM_LIMIT);

export function createEntryPointMethods(deps: EntryPointDeps) {
    const opened = (value: Partial<Omit<NativeEntryPoint, 'version'>>): NativeHostResult<NativeEntryPoint> => ({
        ok: true,
        value: { version: NATIVE_HOST_CONTRACT_VERSION, route: null, taskId: null, projectId: null, search: null, capture: null, captureModal: null, notice: null, contextAutomation: null, ...value },
    });
    const notice = (titleKey: string, title: string, messageKey: string, message: string): QuickCaptureNotice => ({
        tone: 'warning', title: tFallback(deps.t(), titleKey, title), message: tFallback(deps.t(), messageKey, message),
    });

    /** React Native's toast for a shared item it cannot read. */
    const shareUnreadable = () => notice('share.unavailable', 'Share unavailable',
        'share.readFailed', 'Mindwtr could not read text, a URL, or a file from the shared item.');

    /** The capture popup's fresh options, as React Native's capture-quick tab route opens it. */
    const emptyPopup = () => {
        const state = useTaskStore.getState();
        const options = createQuickCaptureOptions({
            initialProps: {},
            projects: state.projects,
            defaultAreaId: resolveQuickCaptureDefaultAreaId(state.settings, state.areas),
        });
        return { text: '', options };
    };

    /**
     * A capture link's payload (an assistant note's too) on the capture screen, as React Native's
     * openCaptureConfirmation pushes it: the title, the note and tags as preset props, and the project as the screen's
     * fallback project (matched there by id or title, created there when none matches). Null: longer than the screen takes.
     */
    const payloadCapture = (payload: ShortcutCapturePayload): Pick<NativeEntryPoint, 'captureModal'> | null => {
        const tags = normalizeShortcutTags(payload.tags);
        const props = { ...(payload.note ? { description: payload.note } : {}), ...(tags.length > 0 ? { tags } : {}) };
        const params = captureModalParams(payload.title, props, payload.project);
        return fitsCaptureModal(params) ? { captureModal: { params } } : null;
    };

    /**
     * A link through React Native's system-path rules, then what its root layout opens for it. [scheme] is the app's
     * own (the development build's mindwtr-native-dev); it stands for mindwtr, so the shared rules read the link. A link
     * of another scheme opens nothing.
     */
    const resolveLink = (url: string, scheme: string): NativeHostResult<NativeEntryPoint> => {
        if (url.slice(0, scheme.length + 1).toLowerCase() !== `${scheme}:`) return opened({});
        const path = `mindwtr:${url.slice(scheme.length + 1)}`;
        // React Native's root layout handles no capture, share or entity link in sandbox mode: they stay on the Inbox.
        const sandbox = isSandboxMode();
        // React Native's context automation hook reads every link first; it is off in sandbox mode, where the link is a route.
        const automation = sandbox ? null : parseContextAutomationUrl(path);
        if (automation) return opened({ contextAutomation: automation });
        const route = resolveSystemPath(path, true);
        switch (route.kind) {
            case 'shareHandoff':
                return opened({});
            case 'dropboxCallback':
                return opened({ route: route.path.split('?')[0] });
            case 'openFeature':
                // The capture feature opens the quick capture popup over the Inbox (the capture-quick route).
                return route.path.startsWith('/capture-quick')
                    ? opened({ route: '/inbox', capture: emptyPopup() })
                    : opened({ route: route.path });
            case 'entityOpen': {
                const entity = parseEntityOpenUrl(path);
                const target = entity && !sandbox ? resolveEntityOpenTarget(entity.kind, entity.id, useTaskStore.getState()) : null;
                if (!target) {
                    // React Native says a task link found no task (#1368); a missing project link stays silent.
                    return opened(entity?.kind === 'task' && !sandbox
                        ? { route: '/inbox', notice: { tone: 'error', message: tFallback(deps.t(), 'task.linkNotFound',
                            'This task is not in this library. It may have been deleted or not synced to this device.') } }
                        : { route: '/inbox' });
                }
                return target.pathname === '/focus'
                    ? opened({ route: '/focus', taskId: target.taskId })
                    : opened({ route: '/projects-screen', projectId: target.projectId ?? null });
            }
            case 'capture': {
                if (sandbox) return opened({ route: '/inbox' });
                const payload = parseShortcutCaptureUrl(path);
                const capture = payload && payloadCapture(payload);
                if (!capture) {
                    return opened({
                        route: '/inbox',
                        notice: notice('shortcuts.captureUnavailable', 'Capture shortcut unavailable',
                            'shortcuts.missingTitle', 'Mindwtr could not read a task title from that shortcut link.'),
                    });
                }
                return opened({ route: '/inbox', ...capture });
            }
            // The capture screen from a widget, the tile or a control: it puts the app behind the previous one when it closes (#1169).
            case 'quickCapture':
                return opened({ captureModal: { params: { origin: 'system' } } });
            case 'path':
                // The detailed capture shortcut's link (#1333) is the capture-quick tab route, as the capture feature's.
                if (route.path.startsWith('/capture-quick')) return opened({ route: '/inbox', capture: emptyPopup() });
                break;
        }
        // Any other link is Expo Router's route by its path (host and path): a list, or the global search with its query.
        let parsed: URL;
        try {
            parsed = new URL(path);
        } catch {
            return opened({ route: '/inbox' });
        }
        const segments = [parsed.hostname, ...parsed.pathname.split('/')].filter(Boolean);
        const target = `/${segments.join('/')}`;
        if (target !== '/global-search') return opened({ route: target });
        const includeCompleted = (parsed.searchParams.get('includeCompleted') ?? '').toLowerCase() === 'true';
        return opened({
            route: target,
            search: {
                query: parsed.searchParams.get('q') ?? '',
                filters: includeCompleted ? { ...DEFAULT_GLOBAL_SEARCH_FILTERS, includeCompleted: true } : null,
            },
        });
    };

    return {
        /**
         * What an entry point opens: a link (VIEW with the app's scheme), a text share (SEND text/plain), or an assistant
         * note (CREATE_NOTE). Nothing is written: a capture opens the capture screen (or the popup), and its Save is that
         * screen's own command.
         */
        resolveNativeEntryPoint(input: NativeEntryPointInput): NativeHostResult<NativeEntryPoint> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input)) return fail('INVALID_INPUT', 'An entry point is required');
            if (input.kind === 'link') {
                if (!isText(input.url, URL_LIMIT) || typeof input.scheme !== 'string' || !SCHEME_PATTERN.test(input.scheme)) {
                    return fail('INVALID_INPUT', 'A link needs its URL and the app\'s scheme');
                }
                return resolveLink(input.url, input.scheme);
            }
            if (input.kind === 'share') {
                if (!isOptionalString(input.text) || !isOptionalString(input.title) || !isOptionalString(input.subject)) {
                    return fail('INVALID_INPUT', 'A share\'s text, title and subject are text or null');
                }
                // React Native's root layout takes no share in sandbox mode, and the provider reports none without text.
                const share = isSandboxMode() ? null : readAndroidTextShare(input);
                if (!share) return opened({});
                const draft = buildShareCaptureDraft({ shareSubject: share.subject, shareText: share.text, shareWebUrl: share.webUrl });
                const params = draft && captureModalParams(draft.title, draft.description !== undefined ? { description: draft.description } : {});
                // The capture screen takes each param at most at its text limit, encoded; a longer share is one the app cannot
                // read, and says so as React Native does for a share it cannot read.
                if (!params || !fitsCaptureModal(params) || longerThan(input.text, TEXT_LIMIT * 5)
                    || longerThan(input.title, TEXT_LIMIT) || longerThan(input.subject, TEXT_LIMIT)) {
                    return opened({ notice: shareUnreadable() });
                }
                // React Native replaces the screen it was on with the capture screen, so it closes to the Inbox.
                return opened({ route: '/inbox', captureModal: { params } });
            }
            if (input.kind === 'createNote') {
                if (!isOptionalString(input.name) || !isOptionalString(input.text) || !isOptionalString(input.extraText)) {
                    return fail('INVALID_INPUT', 'A note\'s name and text are text or null');
                }
                const payload = buildCreateNoteCapture(input);
                // React Native's root layout handles no capture link and shows no share failure in sandbox mode.
                if (isSandboxMode()) return opened(payload ? { route: '/inbox' } : {});
                // React Native leaves an empty note as it came, and its share reader then refuses the unknown action; a note
                // longer than the capture screen takes is one this app cannot read either.
                const capture = payload && payloadCapture(payload);
                if (!capture || [input.name, input.text, input.extraText].some((value) => longerThan(value, TEXT_LIMIT))) {
                    return opened({ notice: shareUnreadable() });
                }
                return opened({ route: '/inbox', ...capture });
            }
            return fail('INVALID_INPUT', 'An entry point is a link, a share or a note');
        },

        /**
         * A file share (SEND of any type but text/plain, SEND_MULTIPLE), as React Native's root layout opens it
         * (share-capture-files.ts): the host staged each file (at most React Native's six) when the share arrived; core
         * copies each into the managed attachments folder and opens the capture screen with them, the subject (else the
         * text, else the first file's name) as its title. Skipped files (too large, a blocked type, a failed copy, and one
         * the host could not stage, when others were attached) are counted in one notice; with none attached, the text
         * opens as a text share would, else the share could not be read (also on a host without attachment storage). Each copy's ID derives from the request UUID (the entry's), so a replay after a restart names the same
         * copies. The host deletes the staged files once the entry opened.
         */
        async prepareSharedFiles(input: { requestId: string; files: NativeSharedFile[]; text: string | null; subject: string | null }): Promise<NativeHostResult<NativeEntryPoint>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const isFile = (file: unknown): file is NativeSharedFile => isObjectRecord(file) && isOptionalString(file.path)
                && isOptionalString(file.name) && isOptionalString(file.mimeType) && (file.size === null || (typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0));
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !Array.isArray(input.files) || input.files.length > SHARE_INTENT_MAX_FILES || !input.files.every(isFile)
                || !isOptionalString(input.text) || !isOptionalString(input.subject)
                || longerThan(input.text, TEXT_LIMIT * 5) || longerThan(input.subject, TEXT_LIMIT)) {
                return fail('INVALID_INPUT', `A request UUID, at most ${SHARE_INTENT_MAX_FILES} staged files, and the share's text and subject (text or null) are required`);
            }
            const host = deps.attachments();
            const persist = host?.persistAttachmentLocallyDetailed;
            // React Native's root layout takes no share in sandbox mode.
            if (isSandboxMode()) return opened({});
            // A host without attachment storage cannot read a file share: React Native's notice, so the entry leaves the queue.
            if (!host || !persist) return opened({ notice: shareUnreadable() });
            const id = input.requestId.toLowerCase();
            let index = 0;
            const copies = new Map<string, Attachment>();
            const result = await buildShareIntentFileCaptureParams({
                files: input.files.map((file) => ({ path: file.path, fileName: file.name, mimeType: file.mimeType, size: file.size })),
                shareSubject: input.subject,
                shareText: input.text,
            }, {
                newId: () => requestRowId(id, `share-file:${index++}`),
                persistAttachmentLocallyDetailed: async (attachment) => {
                    const outcome = await persist.call(host, attachment);
                    copies.set(outcome.attachment.uri, outcome.attachment);
                    return outcome;
                },
                deleteFile: async (uri) => {
                    const copy = copies.get(uri);
                    if (copy) await host.deleteManagedAttachmentFile(copy);
                },
                logWarn: (message, context) => logWarn(message, { scope: context.scope, context: context.extra }),
                // The error's name only: a provider's message can carry the file's name.
                logError: (error, context) => logError(`Shared file copy failed: ${error instanceof Error ? error.name : 'unknown'}`, { scope: context.scope, context: context.extra }),
            });
            // A file the host could not stage (no path) is no candidate of React Native's rule. React Native reports it on its
            // share error channel ("Share unavailable") and opens the others: here it is counted with the skipped files when
            // others were attached, and the share could not be read when none was.
            const unreadable = input.files.filter((file) => !file.path?.trim()).length;
            const skipped = result.candidateCount - result.attachedCount + (result.attachedCount > 0 ? unreadable : 0);
            try {
                logInfo('Native file share prepared', { scope: 'share-intent', context: {
                    releaseCheck: 'v1.3.7/native-share-files', candidates: result.candidateCount, attached: result.attachedCount, skipped, unreadable,
                } });
            } catch { /* Diagnostics never fail the share. */ }
            const webUrl = input.text ? readAndroidTextShare({ text: input.text })?.webUrl ?? null : null;
            const draft = result.params ? null : buildShareCaptureDraft({ shareSubject: input.subject, shareText: input.text, shareWebUrl: webUrl });
            const params = result.params ?? (draft && captureModalParams(draft.title, draft.description !== undefined ? { description: draft.description } : {}));
            const skippedNotice = skipped > 0
                ? { tone: 'warning' as const, title: tFallback(deps.t(), 'common.notice', 'Notice'),
                    message: tFallback(deps.t(), 'share.filesSkipped', '{{count}} shared file(s) could not be attached (too large, blocked file type, or unreadable).').replace('{{count}}', String(skipped)) }
                : null;
            if (params && fitsCaptureModal(params)) return opened({ route: '/inbox', captureModal: { params }, notice: skippedNotice });
            // Nothing readable at all; when files were only skipped, their notice already says why nothing arrived.
            return opened({ notice: unreadable === 0 && skippedNotice ? skippedNotice : shareUnreadable() });
        },

        /**
         * The capture popup's Import .txt, as React Native's handleImportTextFile: several lines ask to create one task
         * per line (the popup's Create tasks, with `text` in place of the field's), one line goes into the field, and an
         * empty file does nothing. `text` null: the picked file could not be read. Sandbox mode refuses, as React
         * Native does. Nothing is written.
         */
        planQuickCaptureImport(input: { text: string | null }): NativeHostResult<NativeQuickCaptureImport> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || (input.text !== null && typeof input.text !== 'string')) {
                return fail('INVALID_INPUT', 'The file\'s text, or null when it could not be read, is required');
            }
            const t = deps.t();
            if (isSandboxMode()) {
                return { ok: true, value: { kind: 'refused', notice: { tone: 'warning', title: t('common.notice'), message: t('sandbox.unavailable'), durationMs: 4200 } } };
            }
            // The popup takes at most its text limit, so a longer file is one this app cannot import.
            if (input.text === null || input.text.length > TEXT_LIMIT) {
                return {
                    ok: true,
                    value: {
                        kind: 'refused',
                        notice: { tone: 'warning', title: t('common.notice'), message: tFallback(t, 'quickAdd.bulkImportError', 'Could not read that text file.'), durationMs: 4200 },
                    },
                };
            }
            // React Native splits the file as the popup splits pasted lines; submitQuickCaptureLines splits `text` the same way.
            const lines = splitQuickAddBulkLines(input.text);
            if (lines.length === 0) return { ok: true, value: { kind: 'empty' } };
            if (lines.length === 1) return { ok: true, value: { kind: 'setText', text: lines[0] } };
            return { ok: true, value: { kind: 'confirmLines', confirm: getQuickCaptureBulkConfirm(lines, t), lineCount: lines.length, text: input.text } };
        },
    };
}
