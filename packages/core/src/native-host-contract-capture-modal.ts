/**
 * The native host contract for the capture confirmation screen: React Native's
 * capture modal (app/capture-modal.tsx), which capture links, shares, assistant
 * notes and a widget's quick capture (`capture-quick`) open. Kept in its own
 * file and spread into createNativeHostContract; every rule comes from
 * capture-modal-model.ts, the module React Native's screen calls.
 *
 * - openCaptureModal takes the route params an entry hands React Native's
 *   screen (`params`: initialValue, text, title, initialProps, project,
 *   returnTo, origin, URI-encoded as its router gives them). It returns the
 *   screen's first draft. Keep both, and send both with every call.
 * - Every control in the view carries its edit: the ? button, and the copilot
 *   chips. Typing sends setText or setDescription. editCaptureModal returns the
 *   next draft.
 * - Save and Save & edit are submitCaptureModal with a capture UUID; the new
 *   task takes that UUID as its ID. Several lines answer confirmLines: show the
 *   question, and send submitCaptureModalLines with one UUID per line on
 *   "Create tasks". Its Cancel, its backdrop and Android's back close it.
 * - Cancel is discardCaptureModal. React Native asks no discard question: Cancel
 *   drops the draft at once. Android's back with no question open is the
 *   host's own back.
 * - After a save or a discard, `close` says where to go: back to the screen
 *   behind; with nothing behind, to `returnTo` (an app path, React Native's
 *   route) or the Inbox. `returnToPreviousApp` then puts the app behind the one
 *   the user came from (#1169).
 * - A failed save: set `failed` in the draft; the card shows the failure until
 *   the next save starts (clear it when submitting).
 * - The AI: `view.copilot.request` is what React Native asks the AI now; send
 *   it to requestAICopilot, and the answer back as a setSuggestion edit. A host
 *   that binds AI (createNativeHostContract's `ai`) is asked for any provider:
 *   requestAICopilot loads the key itself and answers null without one, as
 *   React Native asks nothing with no key. A host without it is asked only for
 *   a provider that needs no key (an OpenAI-compatible endpoint).
 *
 * Shared files (initialProps.attachments, which prepareSharedFiles copies into
 * the managed attachments folder): the screen shows and saves only managed
 * copies, as React Native's saves only files in its attachments folder
 * (filterManagedAttachments). A host without its attachment IO takes none.
 *
 * A project a save creates (a +Project, or the link's project param) takes an id
 * from the capture UUID (a batch's first) and its name: a retry files the task
 * there, renamed since or not, and refuses one deleted or archived since
 * (STALE_REVISION).
 *
 * Saves retry exactly (native-request-receipts.ts): on the native host a
 * landed request's receipt is on disk, so a replay after a restart answers its
 * first reply, and the same UUID with another draft is refused. With no
 * receipt, the task a capture UUID created answers only when it is what the
 * draft writes (isTaskOfDraft).
 *
 * Only functions read this module's imports from native-host-contract.ts, so
 * the import cycle between the two files is safe.
 */
import { executeCaptureTransaction, type CaptureTaskPlan } from './capture';
import {
    buildCaptureModalRequest,
    buildCaptureModalView,
    checkCaptureModalLines,
    createCaptureModalDraft,
    getCaptureModalBulkConfirm,
    planCaptureModalRequest,
    readCaptureModalInitialProps,
    readCaptureModalOrigin,
    readCaptureModalProjectParam,
    resolveCaptureModalAfterSave,
    applyCaptureModalEdit,
    sanitizeCaptureReturnToParam,
    saveCaptureModalLines,
    type CaptureModalDraft,
    type CaptureModalEdit,
    type CaptureModalParams,
    type CaptureModalView,
} from './capture-modal-model';
import { isAIKeyRequired } from './ai-config';
import { resolveDefaultNewTaskAreaId } from './area-utils';
import type { DateFormatter } from './date';
import type { TranslateFn } from './i18n';
import { NATIVE_HOST_CONTRACT_VERSION, type NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isText, isTimeEstimate } from './native-host-contract-menu-views';
import { captureProjectId, captureProjects, isTaskOfPlan } from './native-host-contract-quick-capture';
import { createNativeRequestReceipts, withRequestProject } from './native-request-receipts';
import { buildQuickAddParseOptions, parseQuickAdd, splitQuickAddBulkLines, type QuickAddParseOptions } from './quick-add';
import { getQuickCaptureInvalidDateNotice, type QuickCaptureNotice } from './quick-capture-model';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { useTaskStore } from './store';
import type { Project, Task } from './types';
import type { NativeAttachmentsHost } from './native-host-contract-attachments';

type CaptureModalDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    t: () => TranslateFn;
    /** The user's date formatting (createDateFormatter). */
    formatDate: () => DateFormatter;
    requestIdPattern: RegExp;
    /** The host binds AI: requestAICopilot, which checks the key, answers the copilot's question. */
    aiBound: () => boolean;
    /** The host's attachment IO (createNativeHostContract's `attachments`): which shared files are managed copies. */
    attachments: () => NativeAttachmentsHost | null;
};

export type NativeCaptureModalView = CaptureModalView & {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** Changes with the data, settings, language and minute. */
    revision: string;
};

/** Where to go when the screen closes: back, else `returnTo`, else the Inbox; then maybe behind the previous app. */
export type NativeCaptureModalClose = { returnTo: string | null; returnToPreviousApp: boolean };

export type NativeCaptureModalSubmitResult =
    /** A blank title: Save does nothing. */
    | { kind: 'nothing' }
    /** Several lines: ask with this text, then send submitCaptureModalLines. Nothing was written. */
    | { kind: 'confirmLines'; confirm: ReturnType<typeof getCaptureModalBulkConfirm>; lineCount: number }
    /** Show the toast and keep the draft. Nothing was written; the capture UUID stays free. */
    | { kind: 'refused'; notice: QuickCaptureNotice }
    | {
        kind: 'saved';
        taskId: string;
        projectId: string | null;
        /**
         * close: close the screen. open: replace it with the task's editor (#1029).
         * openInProject: the project screen behind opens the task's editor; close
         * the screen (#938).
         */
        next: 'close' | 'open' | 'openInProject';
        /** Null for `open`. */
        close: NativeCaptureModalClose | null;
    };

export type NativeCaptureModalLinesResult =
    | { kind: 'saved'; taskIds: string[]; close: NativeCaptureModalClose }
    /** A line's date command could not be read. Nothing was written; the UUIDs stay free. */
    | { kind: 'refused'; notice: QuickCaptureNotice };

const TEXT_LIMIT = 100_000;
const NOTE_LIMIT = 500_000;
const PARAM_KEYS = new Set<string>(['initialProps', 'initialValue', 'origin', 'project', 'returnTo', 'text', 'title']);
const DRAFT_KEYS = ['text', 'description', 'showHelp', 'suggestion', 'applied', 'failed'];
const PART_KINDS = new Set<string>(['context', 'timeEstimate', 'tag']);

/** A route param, URI-encoded: at most the popup's note limit (a share's body rides initialProps). */
export const CAPTURE_MODAL_PARAM_LIMIT = NOTE_LIMIT;
const isParamValue = (value: unknown) => isText(value, CAPTURE_MODAL_PARAM_LIMIT)
    || (Array.isArray(value) && value.length <= 16 && value.every((entry) => isText(entry, CAPTURE_MODAL_PARAM_LIMIT)));
const readParams = (value: unknown): CaptureModalParams | null => (
    isObjectRecord(value) && Object.entries(value).every(([key, entry]) => PARAM_KEYS.has(key) && (entry === undefined || isParamValue(entry)))
        ? value as CaptureModalParams
        : null
);
const isTagList = (value: unknown) => Array.isArray(value) && value.length <= 100 && value.every((entry) => isText(entry) && entry.length > 0);
/** A suggestion or the applied parts: only these keys, each valid. */
const isCopilotRecord = (value: unknown, tagsRequired: boolean): boolean => {
    if (!isObjectRecord(value)) return false;
    if (Object.keys(value).some((key) => key !== 'context' && key !== 'timeEstimate' && key !== 'tags')) return false;
    return (value.context === undefined || (isText(value.context) && value.context.length > 0))
        && (value.timeEstimate === undefined || isTimeEstimate(value.timeEstimate))
        && (tagsRequired ? isTagList(value.tags) : value.tags === undefined || isTagList(value.tags));
};
const readDraftValue = (value: unknown): CaptureModalDraft | null => {
    if (!isObjectRecord(value) || Object.keys(value).length !== DRAFT_KEYS.length || !DRAFT_KEYS.every((key) => key in value)) return null;
    const valid = isText(value.text, TEXT_LIMIT) && isText(value.description, NOTE_LIMIT)
        && typeof value.showHelp === 'boolean' && typeof value.failed === 'boolean'
        && (value.suggestion === null || isCopilotRecord(value.suggestion, false))
        && isCopilotRecord(value.applied, true);
    return valid ? value as CaptureModalDraft : null;
};
/** The fields a draft sets that isTaskOfPlan leaves out. */
const DRAFT_FIELDS = ['description', 'startTime', 'reviewAt', 'assignedTo', 'energyLevel', 'timeEstimate'] as const;
const sameValue = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
/**
 * Whether a stored task is what this draft writes: isTaskOfPlan, and the
 * description, dates, person, energy, estimate and links the draft sets. The
 * check for a capture UUID reused when no receipt answers it.
 */
const isTaskOfDraft = (task: Task, plan: CaptureTaskPlan, requestId: string): boolean => (
    isTaskOfPlan(task, plan, requestId)
    && DRAFT_FIELDS.every((field) => sameValue(task[field], plan.props[field]))
    && sameValue(task.attachments?.map((attachment) => attachment.uri), plan.props.attachments?.map((attachment) => attachment.uri))
);

const isEdit = (edit: unknown): edit is CaptureModalEdit => {
    if (!isObjectRecord(edit)) return false;
    switch (edit.type) {
        case 'setText':
            return isText(edit.value, TEXT_LIMIT);
        case 'setDescription':
            return isText(edit.value, NOTE_LIMIT);
        case 'toggleHelp':
            return true;
        case 'applyCopilot':
            return Array.isArray(edit.parts) && edit.parts.length <= 100 && edit.parts.every((part) => (
                isObjectRecord(part) && PART_KINDS.has(part.kind as string) && isText(part.value) && part.value.length > 0
            ));
        case 'setSuggestion':
            return isText(edit.title, TEXT_LIMIT) && isCopilotRecord(edit.suggestion, false);
        default:
            return false;
    }
};

export function createCaptureModalMethods(deps: CaptureModalDeps) {
    // The screen's parse options, rebuilt when the data they read changes, as React Native's memo is.
    let cachedParseOptions: { key: unknown[]; options: QuickAddParseOptions } | null = null;
    const parseOptions = () => {
        const state = useTaskStore.getState();
        const key = [state.tasks, state._allTasks, state.people, state.settings];
        if (!cachedParseOptions || cachedParseOptions.key.some((entry, index) => entry !== key[index])) {
            cachedParseOptions = { key, options: buildQuickAddParseOptions(state.settings, state) };
        }
        return cachedParseOptions.options;
    };
    const receipts = createNativeRequestReceipts({
        save: async () => {
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) {
                return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
            }
            return deps.save();
        },
    });
    const notApplied = (message: string | undefined): NativeHostResult<never> => fail('ACTION_FAILED', message ?? 'Failed to add task');

    /** The screen's preset from its params, with only the shared files that are managed copies (see the module comment). */
    const presetOf = (params: CaptureModalParams): Partial<Task> => {
        const state = useTaskStore.getState();
        const { attachments: shared, ...preset } = readCaptureModalInitialProps(params.initialProps, state.projects, state.areas);
        const managed = deps.attachments()?.canUploadAttachmentFrom;
        const attachments = managed ? shared?.filter((attachment) => managed(attachment.uri)) : undefined;
        return attachments?.length ? { ...preset, attachments } : preset;
    };
    const parse = (text: string, projects: readonly Project[]) => (
        parseQuickAdd(text, projects as Project[], new Date(), useTaskStore.getState().areas, parseOptions())
    );
    const requestFor = (params: CaptureModalParams, draft: CaptureModalDraft, text: string, projects: readonly Project[]) => {
        const state = useTaskStore.getState();
        return buildCaptureModalRequest({
            parsed: parse(text, projects),
            text,
            projects,
            initialProps: presetOf(params),
            projectParam: readCaptureModalProjectParam(params),
            defaultAreaId: resolveDefaultNewTaskAreaId(state.settings, state.areas),
            description: draft.description,
            copilot: draft.applied,
            timeEstimatesEnabled: resolveFeatureFlags(state.settings).timeEstimates,
        });
    };
    /**
     * The store's projects, with each project this request made (captureProjectId of the
     * project a text would create: its +Project, or the link's project param) matched first
     * under the name the text gives it. A replay files its task there, renamed since or not,
     * never in a project given that name since. Null when one is deleted or archived.
     */
    const ownedProjects = (requestId: string, params: CaptureModalParams, draft: CaptureModalDraft, texts: readonly string[]): Project[] | null => {
        let projects: Project[] = [...useTaskStore.getState().projects];
        for (const text of texts) {
            // The project the text would create with no project to match.
            const bare = planCaptureModalRequest(requestFor(params, draft, text, []));
            const title = bare.success ? bare.projectToCreate?.title : undefined;
            if (!title) continue;
            const matched = withRequestProject(projects, captureProjectId(requestId, title), title);
            if (!matched) return null;
            projects = matched;
        }
        return projects;
    };
    const projectGone = () => fail('STALE_REVISION', 'The project this capture created is gone');
    const copilotSettings = () => {
        const { settings } = useTaskStore.getState();
        return {
            aiEnabled: settings.ai?.enabled === true,
            keyRequired: isAIKeyRequired(settings),
            // requestAICopilot loads the key; a host without AI holds none, so a provider that needs one is never asked.
            hasKey: deps.aiBound(),
            timeEstimatesEnabled: resolveFeatureFlags(settings).timeEstimates,
        };
    };
    const view = (params: CaptureModalParams, draft: CaptureModalDraft): NativeCaptureModalView => {
        const state = useTaskStore.getState();
        const now = new Date();
        const ai = copilotSettings();
        return {
            ...buildCaptureModalView(draft, {
                t: deps.t(),
                settings: state.settings,
                projects: state.projects,
                areas: state.areas,
                tasks: state.tasks,
                initialProps: presetOf(params),
                parsed: parse(draft.text, state.projects),
                formatDate: deps.formatDate(),
                aiKey: { required: ai.keyRequired, available: ai.hasKey },
            }),
            version: NATIVE_HOST_CONTRACT_VERSION,
            revision: deps.revision(now),
        };
    };
    const closeOf = (params: CaptureModalParams, returnToPreviousApp: boolean): NativeCaptureModalClose => ({
        returnTo: sanitizeCaptureReturnToParam(params.returnTo),
        returnToPreviousApp,
    });

    /** The shared input checks: readiness, params and draft. */
    const readScreen = (input: unknown): NativeHostResult<{ params: CaptureModalParams; draft: CaptureModalDraft }> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        if (!isObjectRecord(input)) return fail('INVALID_INPUT', 'params and draft are required');
        const params = readParams(input.params);
        if (!params) return fail('INVALID_INPUT', 'params must hold the screen\'s route params as text');
        const draft = readDraftValue(input.draft);
        if (!draft) return fail('INVALID_INPUT', 'draft must hold every field of the screen\'s draft with a valid value');
        return { ok: true, value: { params, draft } };
    };

    return {
        /** Open the screen for an entry's route params: its first draft (the entry's title and description) and view. */
        openCaptureModal(input: { params: CaptureModalParams }): NativeHostResult<{ draft: CaptureModalDraft; view: NativeCaptureModalView }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const params = isObjectRecord(input) ? readParams(input.params) : null;
            if (!params) return fail('INVALID_INPUT', 'params must hold the screen\'s route params as text');
            const draft = createCaptureModalDraft(params, presetOf(params));
            return { ok: true, value: { draft, view: view(params, draft) } };
        },

        /** The screen for these params and this draft. */
        getCaptureModalView(input: { params: CaptureModalParams; draft: CaptureModalDraft }): NativeHostResult<NativeCaptureModalView> {
            const read = readScreen(input);
            if (!read.ok) return read;
            return { ok: true, value: view(read.value.params, read.value.draft) };
        },

        /** Apply an input's or a control's edit. Nothing is written. */
        editCaptureModal(input: {
            params: CaptureModalParams;
            draft: CaptureModalDraft;
            edit: CaptureModalEdit;
        }): NativeHostResult<{ draft: CaptureModalDraft; view: NativeCaptureModalView }> {
            const read = readScreen(input);
            if (!read.ok) return read;
            if (!isEdit(input.edit)) return fail('INVALID_INPUT', 'edit is not a valid capture screen edit');
            const draft = applyCaptureModalEdit(read.value.draft, input.edit, copilotSettings());
            if (!draft) return fail('INVALID_INPUT', 'edit names a copilot part the screen does not show');
            return { ok: true, value: { draft, view: view(read.value.params, draft) } };
        },

        /**
         * Save (`openAfterSave`: Save & edit), as React Native's Save does. On
         * ACTION_FAILED or SAVE_FAILED set `failed`; reuse `captureId` to retry
         * the same draft: it is written at most once.
         */
        async submitCaptureModal(input: {
            params: CaptureModalParams;
            draft: CaptureModalDraft;
            captureId: string;
            openAfterSave?: boolean;
        }): Promise<NativeHostResult<NativeCaptureModalSubmitResult>> {
            const read = readScreen(input);
            if (!read.ok) return read;
            if (input.openAfterSave !== undefined && typeof input.openAfterSave !== 'boolean') {
                return fail('INVALID_INPUT', 'openAfterSave must be a boolean');
            }
            const { params, draft } = read.value;
            if (!draft.text.trim()) return { ok: true, value: { kind: 'nothing' } };
            const lines = splitQuickAddBulkLines(draft.text);
            if (lines.length > 1) {
                return { ok: true, value: { kind: 'confirmLines', confirm: getCaptureModalBulkConfirm(lines, deps.t()), lineCount: lines.length } };
            }
            // A refusal writes nothing, so it stays out of the receipts: the capture UUID stays free.
            const planned = planCaptureModalRequest(requestFor(params, draft, draft.text, useTaskStore.getState().projects));
            if (!planned.success) {
                return planned.reason === 'invalid-date-command'
                    ? { ok: true, value: { kind: 'refused', notice: getQuickCaptureInvalidDateNotice(deps.t(), planned.invalidDateCommands) } }
                    : notApplied(undefined);
            }
            const openAfterSave = input.openAfterSave === true;
            const captureId = input.captureId;
            return receipts.run<NativeCaptureModalSubmitResult>(
                captureId,
                JSON.stringify(['captureModal', params, draft.text, draft.description, draft.applied, openAfterSave]),
                async () => {
                    const saved = (taskId: string, projectId: string | undefined): NativeHostResult<NativeCaptureModalSubmitResult> => {
                        const after = resolveCaptureModalAfterSave({
                            openAfterSave, taskId, projectId, returnTo: sanitizeCaptureReturnToParam(params.returnTo), origin: readCaptureModalOrigin(params),
                        });
                        return {
                            ok: true,
                            value: {
                                kind: 'saved',
                                taskId,
                                projectId: projectId ?? null,
                                next: after.kind,
                                close: after.kind === 'open' ? null : closeOf(params, after.kind === 'close' && after.returnToPreviousApp),
                            },
                        };
                    };
                    const owned = ownedProjects(captureId, params, draft, [draft.text]);
                    if (!owned) return projectGone();
                    const request = requestFor(params, draft, draft.text, owned);
                    // With no receipt to answer it, the task this capture UUID created answers the
                    // retry, but only when it is what this draft writes.
                    const existing = useTaskStore.getState()._allTasks.find((task) => task.id === captureId.toLowerCase());
                    if (existing) {
                        const plan = planCaptureModalRequest(request);
                        return plan.success && isTaskOfDraft(existing, plan, captureId)
                            ? saved(existing.id, existing.projectId)
                            : fail('INVALID_INPUT', 'Capture ID already belongs to another task');
                    }
                    try {
                        const projects = captureProjects(captureId);
                        const result = await executeCaptureTransaction(request.input, {
                            addProject: projects.addProject,
                            addTask: (title, props) => useTaskStore.getState().addTask(title, props, { captureId }),
                        }, request.options);
                        if (projects.made.stale) return projectGone();
                        if (!result.success) return notApplied('error' in result ? result.error : result.reason);
                        return saved(result.createdTaskId ?? captureId.toLowerCase(), result.props.projectId);
                    } catch (error) {
                        return notApplied(error instanceof Error ? error.message : String(error));
                    }
                },
            );
        },

        /**
         * "Create tasks" after confirmLines: one task per line in one store write,
         * as React Native does; the screen then closes. Send one capture UUID per
         * line and reuse the same list to retry. Every line is checked before
         * anything is written: a date command it cannot read refuses the whole
         * batch. A list that names only some tasks of a saved batch is refused.
         */
        async submitCaptureModalLines(input: {
            params: CaptureModalParams;
            draft: CaptureModalDraft;
            captureIds: string[];
        }): Promise<NativeHostResult<NativeCaptureModalLinesResult>> {
            const read = readScreen(input);
            if (!read.ok) return read;
            const { params, draft } = read.value;
            const lines = splitQuickAddBulkLines(draft.text);
            if (lines.length < 2) return fail('INVALID_INPUT', 'text must hold several lines');
            const ids = input.captureIds;
            if (!Array.isArray(ids) || ids.length !== lines.length
                || !ids.every((id) => typeof id === 'string' && deps.requestIdPattern.test(id))
                || new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
                return fail('INVALID_INPUT', 'Send one distinct capture UUID per line');
            }
            const buildRequest = async (line: string, projects: readonly Project[]) => requestFor(params, draft, line, projects);
            // A refusal writes nothing, so it stays out of the receipts: the UUIDs stay free.
            const refusal = await checkCaptureModalLines({ lines, projects: useTaskStore.getState().projects, buildRequest });
            if (refusal?.kind === 'refused') {
                return { ok: true, value: { kind: 'refused', notice: getQuickCaptureInvalidDateNotice(deps.t(), refusal.invalidDateCommands) } };
            }
            const taskIds = ids.map((id) => id.toLowerCase());
            const close = closeOf(params, readCaptureModalOrigin(params) === 'system');
            return receipts.run<NativeCaptureModalLinesResult>(
                ids[0],
                JSON.stringify(['captureModalLines', params, draft.text, draft.description, draft.applied, ids]),
                async () => {
                    const state = useTaskStore.getState();
                    // The batch's projects take ids from its first capture UUID (the receipt's).
                    const owned = ownedProjects(ids[0], params, draft, lines);
                    if (!owned) return projectGone();
                    // One store write makes every line, so a batch that landed holds all its UUIDs. A batch
                    // saved before a restart answers from its tasks when each matches its line; a list that
                    // names only some saved tasks is not that batch.
                    const existing = taskIds.map((id) => state._allTasks.find((task) => task.id === id));
                    if (existing.some(Boolean)) {
                        const matches = existing.every((task, index) => {
                            const plan = task && planCaptureModalRequest(requestFor(params, draft, lines[index], owned));
                            return Boolean(task && plan?.success && isTaskOfDraft(task, plan, ids[0]));
                        });
                        return matches
                            ? { ok: true, value: { kind: 'saved', taskIds, close } }
                            : fail('INVALID_INPUT', 'These capture IDs do not name the batch saved under them');
                    }
                    try {
                        const projects = captureProjects(ids[0]);
                        const outcome = await saveCaptureModalLines({
                            lines,
                            projects: owned,
                            buildRequest,
                            actions: {
                                addProject: projects.addProject,
                                addTasks: (items) => useTaskStore.getState().addTasks(items),
                            },
                            captureIds: ids,
                        });
                        if (projects.made.stale) return projectGone();
                        if (outcome.kind !== 'saved') return notApplied(undefined);
                        return { ok: true, value: { kind: 'saved', taskIds, close } };
                    } catch (error) {
                        return notApplied(error instanceof Error ? error.message : String(error));
                    }
                },
            );
        },

        /** Cancel: the draft is dropped, nothing is written, and `close` says where to go. */
        discardCaptureModal(input: { params: CaptureModalParams }): NativeHostResult<{ close: NativeCaptureModalClose }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const params = isObjectRecord(input) ? readParams(input.params) : null;
            if (!params) return fail('INVALID_INPUT', 'params must hold the screen\'s route params as text');
            return { ok: true, value: { close: closeOf(params, readCaptureModalOrigin(params) === 'system') } };
        },
    };
}
