


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

    attachments: () => NativeAttachmentsHost | null;
};


export type NativeSharedFile = { path: string | null; name: string | null; mimeType: string | null; size: number | null };


export type NativeEntryPointInput =
    | { kind: 'link'; url: string; scheme: string }
    | { kind: 'share'; text: string | null; title: string | null; subject: string | null }
    | { kind: 'createNote'; name: string | null; text: string | null; extraText: string | null };

export type NativeEntryPoint = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;


    route: string | null;

    taskId: string | null;

    projectId: string | null;

    search: { query: string; filters: GlobalSearchFilterState | null } | null;

    capture: { text: string; options: QuickCaptureOptions } | null;

    captureModal: { params: CaptureModalParams } | null;

    notice: QuickCaptureNotice | Omit<QuickCaptureNotice, 'title'> | null;


    contextAutomation: ContextAutomationPayload | null;
};


export type NativeQuickCaptureImport =

    | { kind: 'confirmLines'; confirm: ReturnType<typeof getQuickCaptureBulkConfirm>; lineCount: number; text: string }
    | { kind: 'setText'; text: string }
    | { kind: 'empty' }
    | { kind: 'refused'; notice: QuickCaptureNotice };

const URL_LIMIT = 16_000;

const TEXT_LIMIT = 100_000;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{0,31}$/;
const isOptionalString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const longerThan = (value: string | null, max: number) => (value?.length ?? 0) > max;


const captureModalParams = (title: string, props: { description?: string; tags?: string[] }, project?: string): CaptureModalParams => ({
    initialValue: encodeURIComponent(title),
    ...(Object.keys(props).length > 0 ? { initialProps: encodeURIComponent(JSON.stringify(props)) } : {}),
    ...(project ? { project: encodeURIComponent(project) } : {}),
});

const fitsCaptureModal = (params: CaptureModalParams) => Object.values(params).every((param) => typeof param === 'string' && param.length <= CAPTURE_MODAL_PARAM_LIMIT);

export function createEntryPointMethods(deps: EntryPointDeps) {
    const opened = (value: Partial<Omit<NativeEntryPoint, 'version'>>): NativeHostResult<NativeEntryPoint> => ({
        ok: true,
        value: { version: NATIVE_HOST_CONTRACT_VERSION, route: null, taskId: null, projectId: null, search: null, capture: null, captureModal: null, notice: null, contextAutomation: null, ...value },
    });
    const notice = (titleKey: string, title: string, messageKey: string, message: string): QuickCaptureNotice => ({
        tone: 'warning', title: tFallback(deps.t(), titleKey, title), message: tFallback(deps.t(), messageKey, message),
    });


    const shareUnreadable = () => notice('share.unavailable', 'Share unavailable',
        'share.readFailed', 'Mindwtr could not read text, a URL, or a file from the shared item.');


    const emptyPopup = () => {
        const state = useTaskStore.getState();
        const options = createQuickCaptureOptions({
            initialProps: {},
            projects: state.projects,
            defaultAreaId: resolveQuickCaptureDefaultAreaId(state.settings, state.areas),
        });
        return { text: '', options };
    };


    const payloadCapture = (payload: ShortcutCapturePayload): Pick<NativeEntryPoint, 'captureModal'> | null => {
        const tags = normalizeShortcutTags(payload.tags);
        const props = { ...(payload.note ? { description: payload.note } : {}), ...(tags.length > 0 ? { tags } : {}) };
        const params = captureModalParams(payload.title, props, payload.project);
        return fitsCaptureModal(params) ? { captureModal: { params } } : null;
    };


    const resolveLink = (url: string, scheme: string): NativeHostResult<NativeEntryPoint> => {
        if (url.slice(0, scheme.length + 1).toLowerCase() !== `${scheme}:`) return opened({});
        const path = `mindwtr:${url.slice(scheme.length + 1)}`;

        const sandbox = isSandboxMode();

        const automation = sandbox ? null : parseContextAutomationUrl(path);
        if (automation) return opened({ contextAutomation: automation });
        const route = resolveSystemPath(path, true);
        switch (route.kind) {
            case 'shareHandoff':
                return opened({});
            case 'dropboxCallback':
                return opened({ route: route.path.split('?')[0] });
            case 'openFeature':

                return route.path.startsWith('/capture-quick')
                    ? opened({ route: '/inbox', capture: emptyPopup() })
                    : opened({ route: route.path });
            case 'entityOpen': {
                const entity = parseEntityOpenUrl(path);
                const target = entity && !sandbox ? resolveEntityOpenTarget(entity.kind, entity.id, useTaskStore.getState()) : null;
                if (!target) {

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

            case 'quickCapture':
                return opened({ captureModal: { params: { origin: 'system' } } });
            case 'path':

                if (route.path.startsWith('/capture-quick')) return opened({ route: '/inbox', capture: emptyPopup() });
                break;
        }

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

                const share = isSandboxMode() ? null : readAndroidTextShare(input);
                if (!share) return opened({});
                const draft = buildShareCaptureDraft({ shareSubject: share.subject, shareText: share.text, shareWebUrl: share.webUrl });
                const params = draft && captureModalParams(draft.title, draft.description !== undefined ? { description: draft.description } : {});


                if (!params || !fitsCaptureModal(params) || longerThan(input.text, TEXT_LIMIT * 5)
                    || longerThan(input.title, TEXT_LIMIT) || longerThan(input.subject, TEXT_LIMIT)) {
                    return opened({ notice: shareUnreadable() });
                }

                return opened({ route: '/inbox', captureModal: { params } });
            }
            if (input.kind === 'createNote') {
                if (!isOptionalString(input.name) || !isOptionalString(input.text) || !isOptionalString(input.extraText)) {
                    return fail('INVALID_INPUT', 'A note\'s name and text are text or null');
                }
                const payload = buildCreateNoteCapture(input);

                if (isSandboxMode()) return opened(payload ? { route: '/inbox' } : {});


                const capture = payload && payloadCapture(payload);
                if (!capture || [input.name, input.text, input.extraText].some((value) => longerThan(value, TEXT_LIMIT))) {
                    return opened({ notice: shareUnreadable() });
                }
                return opened({ route: '/inbox', ...capture });
            }
            return fail('INVALID_INPUT', 'An entry point is a link, a share or a note');
        },


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

            if (isSandboxMode()) return opened({});

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

                logError: (error, context) => logError(`Shared file copy failed: ${error instanceof Error ? error.name : 'unknown'}`, { scope: context.scope, context: context.extra }),
            });


            const unreadable = input.files.filter((file) => !file.path?.trim()).length;
            const skipped = result.candidateCount - result.attachedCount + (result.attachedCount > 0 ? unreadable : 0);
            try {
                logInfo('Native file share prepared', { scope: 'share-intent', context: {
                    releaseCheck: 'v1.3.7/native-share-files', candidates: result.candidateCount, attached: result.attachedCount, skipped, unreadable,
                } });
            } catch {                                         }
            const webUrl = input.text ? readAndroidTextShare({ text: input.text })?.webUrl ?? null : null;
            const draft = result.params ? null : buildShareCaptureDraft({ shareSubject: input.subject, shareText: input.text, shareWebUrl: webUrl });
            const params = result.params ?? (draft && captureModalParams(draft.title, draft.description !== undefined ? { description: draft.description } : {}));
            const skippedNotice = skipped > 0
                ? { tone: 'warning' as const, title: tFallback(deps.t(), 'common.notice', 'Notice'),
                    message: tFallback(deps.t(), 'share.filesSkipped', '{{count}} shared file(s) could not be attached (too large, blocked file type, or unreadable).').replace('{{count}}', String(skipped)) }
                : null;
            if (params && fitsCaptureModal(params)) return opened({ route: '/inbox', captureModal: { params }, notice: skippedNotice });

            return opened({ notice: unreadable === 0 && skippedNotice ? skippedNotice : shareUnreadable() });
        },


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

            if (input.text === null || input.text.length > TEXT_LIMIT) {
                return {
                    ok: true,
                    value: {
                        kind: 'refused',
                        notice: { tone: 'warning', title: t('common.notice'), message: tFallback(t, 'quickAdd.bulkImportError', 'Could not read that text file.'), durationMs: 4200 },
                    },
                };
            }

            const lines = splitQuickAddBulkLines(input.text);
            if (lines.length === 0) return { ok: true, value: { kind: 'empty' } };
            if (lines.length === 1) return { ok: true, value: { kind: 'setText', text: lines[0] } };
            return { ok: true, value: { kind: 'confirmLines', confirm: getQuickCaptureBulkConfirm(lines, t), lineCount: lines.length, text: input.text } };
        },
    };
}
