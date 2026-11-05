


import {
    buildContextAutomationNotification,
    createContextAutomationThrottle,
    parseContextAutomationHeadlessTaskData,
    type ContextAutomationNotification,
} from './context-automation';
import { tFallback, type TranslateFn } from './i18n';
import { logError, logInfo, logWarn } from './logger';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import {
    drainPendingCaptureQueue,
    type PendingCaptureAudioPort,
    type PendingCaptureLog,
    type PendingCaptureDrainDeps,
    type PendingCaptureQueuePort,
    type PendingCaptureRecordPort,
} from './pending-captures';
import { isSandboxMode, isWorkspaceTransitionActive } from './sandbox';
import { useTaskStore } from './store';

type CaptureIngestDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => TranslateFn;
    requestIdPattern: RegExp;
};


const log: PendingCaptureLog = {
    info: (message, context) => logInfo(message, { scope: context.scope, context: context.extra }),
    warn: (message, context) => logWarn(message, { scope: context.scope, context: context.extra }),
    error: (error, context) => logError(String(context.extra?.message ?? 'Pending capture failed'), {
        scope: context.scope,
        context: context.extra,
        error,
    }),
};

const isQueuePort = (value: unknown): value is PendingCaptureQueuePort => (
    isObjectRecord(value)
    && typeof value.list === 'function'
    && typeof value.read === 'function'
    && typeof value.delete === 'function'
);

const isRecordPort = (value: unknown): value is PendingCaptureRecordPort => (
    isObjectRecord(value) && typeof value.read === 'function' && typeof value.write === 'function'
);

const isAudioPort = (value: unknown): value is PendingCaptureAudioPort => (
    isObjectRecord(value) && Object.keys(value).every(name => ['resolvePath', 'transcribe', 'delete'].includes(name))
    && typeof value.resolvePath === 'function' && typeof value.delete === 'function'
    && (value.transcribe === undefined || typeof value.transcribe === 'function')
);

const isOptionalText = (value: unknown) => value === undefined || value === null || isText(value, 2000);

export function createCaptureIngestMethods(deps: CaptureIngestDeps) {


    let drainChain: Promise<unknown> = Promise.resolve();
    const throttle = createContextAutomationThrottle();


    const flushDurably = async (): Promise<void> => {
        let saved = await deps.save();
        if (!saved.ok && saved.error.code === 'SAVE_FAILED') {
            await useTaskStore.getState().retryPersistence();
            saved = await deps.save();
        }
        if (!saved.ok) throw new Error(saved.error.message);
    };

    return {


        async ingestPendingCaptures(input: {
            requestId: string;
            queue: PendingCaptureQueuePort;
            lastApplied: PendingCaptureRecordPort;
            audio?: PendingCaptureAudioPort;
            settleWatchChecklist?: PendingCaptureDrainDeps['settleWatchChecklist'];
        }): Promise<NativeHostResult<{ ingested: number }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !isQueuePort(input.queue) || !isRecordPort(input.lastApplied)
                || (input.audio !== undefined && !isAudioPort(input.audio))
                || (input.settleWatchChecklist !== undefined && typeof input.settleWatchChecklist !== 'function')) {
                return fail('INVALID_INPUT', 'A request UUID, a queue with list, read and delete, and a lastApplied record with read and write are required');
            }
            const { queue, lastApplied } = input;
            const unfinished = { owed: 0, queued: 0 };
            const run = drainChain.then(async () => {
                if (isSandboxMode() || isWorkspaceTransitionActive()) return 0;
                const { addTask, updateTask, addProject, projects, areas, tasks, people, settings } = useTaskStore.getState();
                return drainPendingCaptureQueue({
                    addTask,
                    updateTask,
                    addProject,
                    projects,
                    areas,
                    tasks,
                    people,
                    settings,
                    getTasks: () => useTaskStore.getState()._allTasks,
                    getProjects: () => useTaskStore.getState()._allProjects,
                    flushPendingSave: flushDurably,
                    queue,
                    lastApplied,
                    audio: input.audio,
                    settleWatchChecklist: input.settleWatchChecklist,
                    log,
                    onUnfinished: (state) => { unfinished[state] += 1; },
                });
            });
            drainChain = run.catch(() => undefined);
            let ingested = 0;
            let thrown: unknown;
            try {
                ingested = await run;
            } catch (error) {
                thrown = error;
            }


            if (unfinished.owed > 0) return fail('SAVE_FAILED', `${unfinished.owed} queued item(s) stored but not yet saved, recorded or removed`);
            if (thrown !== undefined) return fail('ACTION_FAILED', thrown instanceof Error ? thrown.message : String(thrown));
            if (unfinished.queued > 0) return fail('ACTION_FAILED', `${unfinished.queued} queued item(s) left for a later drain`);
            return { ok: true, value: { ingested } };
        },


        async ingestPendingAudio(input: {
            queue: PendingCaptureQueuePort;
            lastApplied: PendingCaptureRecordPort;
            audio: PendingCaptureAudioPort;
        }): Promise<NativeHostResult<{ ingested: number }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isQueuePort(input.queue) || !isRecordPort(input.lastApplied) || !isAudioPort(input.audio)) {
                return fail('INVALID_INPUT', 'A queue, a lastApplied record and an audio port with resolvePath, transcribe and delete are required');
            }
            const { queue, lastApplied, audio } = input;
            const run = drainChain.then(async () => {
                if (isSandboxMode() || isWorkspaceTransitionActive()) return 0;
                const { addTask, updateTask, addProject, projects, areas, tasks, people, settings } = useTaskStore.getState();
                return drainPendingCaptureQueue({
                    addTask, updateTask, addProject, projects, areas, tasks, people, settings,
                    getTasks: () => useTaskStore.getState()._allTasks,
                    getProjects: () => useTaskStore.getState()._allProjects,
                    flushPendingSave: flushDurably,
                    queue, lastApplied, log, audio, audioOnly: true,
                });
            });
            drainChain = run.catch(() => undefined);
            try {
                return { ok: true, value: { ingested: await run } };
            } catch (error) {
                return fail('ACTION_FAILED', error instanceof Error ? error.message : String(error));
            }
        },


        runContextAutomation(input: { url?: string | null; action?: string | null; context?: string | null }): NativeHostResult<{
            notification: ContextAutomationNotification | null;
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isOptionalText(input.url) || !isOptionalText(input.action) || !isOptionalText(input.context)) {
                return fail('INVALID_INPUT', 'url, action and context are optional text');
            }
            const payload = parseContextAutomationHeadlessTaskData(input);
            if (!payload || throttle.wasRecentlyHandled(payload)) return { ok: true, value: { notification: null } };
            const state = useTaskStore.getState();
            const t = deps.t();
            const notification = buildContextAutomationNotification(payload, {
                tasks: state.tasks,
                projects: state.projects,
                settings: state.settings,
                now: new Date(),
                resolveText: (key, fallback) => tFallback(t, key, fallback),
            });
            return { ok: true, value: { notification } };
        },
    };
}
