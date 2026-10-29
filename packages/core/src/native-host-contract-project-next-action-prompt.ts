/**
 * RN's project next-action prompt (apps/mobile/components/project-next-action-prompt.tsx and
 * swipeable-task-item/ProjectNextActionPromptModal.tsx) for a host that completes tasks through completeTask (native Android).
 * After a row's Done, the host reads the prompt for the completed task; null means the project still has a next action. Its
 * three actions are RN's store writes, journaled under a request UUID: Choose makes a candidate Next (updateTask), Add parses
 * the text with the capture sheet's quick-add grammar into the project, or its section (#859, f34284f8c), and Complete project
 * archives it (updateProject). iOS uses its own prepared coordinator (native-host-contract-project-next-action.ts).
 */
import { formatI18nTemplate } from './i18n';
import { logInfo } from './logger';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, revisionOf, runStoreWrite, settleWrite, taskRevisionOf } from './native-request-receipts';
import { getProjectNextActionPromptData } from './project-utils';
import { buildQuickAddParseOptions, parseProjectNextActionInput } from './quick-add';
import { useTaskStore } from './store';
import type { TaskStatus } from './types';

type Translate = (key: string) => string;

export type NativeProjectNextActionPrompt = {
    taskId: string; projectId: string; projectRevision: string; scope: 'project' | 'section';
    title: string; description: string;
    /** RN's "Choose an existing task" list: every candidate, as RN's ScrollView shows them. */
    choose: { label: string; items: { id: string; title: string; status: TaskStatus; statusLabel: string; taskRevision: string }[] };
    add: { label: string; placeholder: string; saveAndEdit: string; button: string };
    /** Only for a project-wide prompt, as RN's (a section's prompt never offers it). */
    completeProject: { label: string } | null;
    skip: string;
    /** RN's failure toast: its title, and its message when core gives none. */
    failure: { title: string; message: string };
};

export type NativeProjectNextActionRequest = { requestId: string; taskId: string } & (
    { action: 'choose'; candidateId: string; candidateRevision: string }
    | { action: 'add'; text: string; openAfterSave: boolean }
    | { action: 'completeProject'; projectId: string; projectRevision: string });

export type NativeProjectNextActionResult = { action: 'choose' | 'completeProject'; id: string }
    | { action: 'add'; id: string; openAfterSave: boolean };

const TEXT_LIMIT = 100_000;
const id = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 500;

export function createProjectNextActionPromptMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    requestIdPattern: RegExp;
}) {
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });
    const readRequest = (value: unknown): NativeProjectNextActionRequest | null => {
        if (!isObjectRecord(value) || typeof value.requestId !== 'string' || !deps.requestIdPattern.test(value.requestId) || !id(value.taskId)) return null;
        if (value.action === 'choose') return id(value.candidateId) && id(value.candidateRevision) ? value as NativeProjectNextActionRequest : null;
        if (value.action === 'add') {
            return typeof value.text === 'string' && Boolean(value.text.trim()) && value.text.length <= TEXT_LIMIT
                && typeof value.openAfterSave === 'boolean' ? value as NativeProjectNextActionRequest : null;
        }
        return value.action === 'completeProject' && id(value.projectId) && id(value.projectRevision) ? value as NativeProjectNextActionRequest : null;
    };
    const diagnose = (action: string) => {
        try {
            logInfo('Native project next action saved', { scope: 'project-next-action', context: {
                releaseCheck: 'v1.3.8/native-project-next-action', outcome: action } });
        } catch { /* a diagnostic line never changes the write */ }
    };

    return {
        /**
         * The prompt after `taskId` was completed (RN's buildProjectNextActionPromptState): null unless the task is done in an
         * active project that has no next action left (or, in a sequential section, none left in its section).
         */
        getProjectNextActionPrompt(input: { taskId: string }): NativeHostResult<{ prompt: NativeProjectNextActionPrompt | null }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !id(input.taskId)) return fail('INVALID_INPUT', 'The completed task ID is required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.taskId);
            const sections = state._allSections.filter((section) => !section.deletedAt);
            const data = task ? getProjectNextActionPromptData(task, state._allTasks, state._allProjects, sections) : null;
            if (!task || !data) return { ok: true, value: { prompt: null } };
            const t = deps.t();
            const sectionTitle = data.scope === 'section' && task.sectionId
                ? sections.find((section) => section.id === task.sectionId)?.title : undefined;
            return { ok: true, value: { prompt: {
                taskId: task.id, projectId: data.project.id, projectRevision: revisionOf(data.project), scope: data.scope,
                title: t('projects.nextActionPromptTitle'),
                description: data.scope === 'section' && sectionTitle
                    ? formatI18nTemplate(t('projects.nextActionPromptSectionDesc'), { section: sectionTitle, project: data.project.title })
                    : formatI18nTemplate(t('projects.nextActionPromptDesc'), { project: data.project.title }),
                choose: { label: t('projects.nextActionPromptChooseExisting'), items: data.candidates.map((candidate) => ({
                    id: candidate.id, title: candidate.title, status: candidate.status, statusLabel: t(`status.${candidate.status}`),
                    taskRevision: taskRevisionOf(candidate) })) },
                add: { label: t('projects.nextActionPromptAddNew'), placeholder: t('projects.nextActionPromptPlaceholder'),
                    saveAndEdit: t('quickAdd.saveAndEdit'), button: t('projects.nextActionPromptAddButton') },
                completeProject: data.scope === 'section' ? null : { label: t('projects.nextActionPromptComplete') },
                skip: t('common.skip'),
                failure: { title: t('common.error'), message: t('projects.nextActionPromptFailed') },
            } } };
        },

        /** One of the prompt's actions, journaled under `requestId`: a replay answers the first reply and writes nothing twice. */
        async runProjectNextAction(input: NativeProjectNextActionRequest): Promise<NativeHostResult<NativeProjectNextActionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A request UUID, the completed task and one prompt action are required');
            const { requestId, ...rest } = request;
            const result = await receipts.run<NativeProjectNextActionResult>(requestId, JSON.stringify(['projectNextAction', rest]), async () => {
                const state = useTaskStore.getState();
                if (request.action === 'choose') {
                    const candidate = state._tasksById.get(request.candidateId);
                    if (!candidate || candidate.deletedAt) return fail('INVALID_INPUT', 'The chosen task no longer exists');
                    if (taskRevisionOf(candidate) !== request.candidateRevision) return fail('STALE_REVISION', 'The chosen task changed since the prompt showed it');
                    const written = await runStoreWrite(() => useTaskStore.getState().updateTask(candidate.id, { status: 'next' }));
                    return settleWrite(written, { action: 'choose' as const, id: candidate.id });
                }
                if (request.action === 'completeProject') {
                    const project = state._projectsById.get(request.projectId);
                    if (!project || project.deletedAt) return fail('INVALID_INPUT', 'The project no longer exists');
                    if (revisionOf(project) !== request.projectRevision) return fail('STALE_REVISION', 'The project changed since the prompt showed it');
                    // RN's Complete project: archiving completes the remaining tasks in core, reversible with Reactivate.
                    const written = await runStoreWrite(() => useTaskStore.getState().updateProject(project.id, { status: 'archived' }));
                    return settleWrite(written, { action: 'completeProject' as const, id: project.id });
                }
                const completed = state._tasksById.get(request.taskId);
                const project = completed?.projectId ? state._projectsById.get(completed.projectId) : undefined;
                if (!completed || !project || project.deletedAt || project.status === 'archived') {
                    return fail('INVALID_INPUT', 'The project no longer takes a next action');
                }
                // The capture sheet's quick-add grammar, so "/waiting" and friends work here too (#859, f34284f8c).
                const { title, props } = parseProjectNextActionInput(request.text.trim(), {
                    projectId: project.id,
                    sectionId: completed.sectionId,
                    projects: state.projects,
                    areas: state.areas,
                    parseOptions: buildQuickAddParseOptions(state.settings, state),
                });
                const added = { id: requestId.toLowerCase() };
                const written = await runStoreWrite(async () => {
                    const outcome = await useTaskStore.getState().addTask(title, props, { captureId: requestId });
                    if (outcome.success && outcome.id) added.id = outcome.id;
                    return outcome;
                });
                return settleWrite(written, { action: 'add' as const, id: added.id, openAfterSave: request.openAfterSave });
            });
            if (result.ok) diagnose(request.action);
            return result;
        },
    };
}
