/**
 * The native host contract for work that arrives while the app is closed: the
 * pending-captures queue (pending-captures.ts) and context automation
 * (context-automation.ts). Kept in its own file and spread into
 * createNativeHostContract. The native runner boots the host, activates it
 * after the validated load, replays its journal, then calls these; Kotlin only
 * lists, reads and deletes files and posts the notification.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the
 * import cycle between the two files is safe.
 */
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

// React Native's app log shape onto core's logger.
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
    isObjectRecord(value)
    && typeof value.resolvePath === 'function'
    && typeof value.transcribe === 'function'
    && typeof value.delete === 'function'
);

const isOptionalText = (value: unknown) => value === undefined || value === null || isText(value, 2000);

export function createCaptureIngestMethods(deps: CaptureIngestDeps) {
    // React Native's drainPendingCapturesFromStore: one drain at a time, since each
    // reads a file, writes the store, then deletes the file.
    let drainChain: Promise<unknown> = Promise.resolve();
    const throttle = createContextAutomationThrottle();

    // React Native's flushPendingTaskActionSave: resolves only once the store's
    // writes are durable. Exhausted save retries leave a persistence failure,
    // so a replay recovers it before its queue file may go.
    const flushDurably = async (): Promise<void> => {
        let saved = await deps.save();
        if (!saved.ok && saved.error.code === 'SAVE_FAILED') {
            await useTaskStore.getState().retryPersistence();
            saved = await deps.save();
        }
        if (!saved.ok) throw new Error(saved.error.message);
    };

    return {
        /**
         * Drains the pending-captures queue into the store. `queue` lists, reads and
         * deletes the files under the app's `files/pending-captures/`. `lastApplied`
         * reads and writes the device's record of the last queued command applied to
         * each task, React Native's RKStorage value under
         * PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY; a write resolves once durable. Captures,
         * check-offs and defers are stored; `audio` and `pomodoro` items stay in the
         * queue untouched. A file is deleted only after its write is durable.
         * `ingested` counts the items stored and removed. A capture, check-off or
         * defer a failure keeps queued fails the call, so the caller drains again:
         * SAVE_FAILED once its store write landed but its save, its lastApplied
         * write or its delete did not finish (owed: a later edit of that task must
         * wait for the retry), whatever later items do; ACTION_FAILED when nothing
         * of it landed. A record that did not reach the disk still removes the file.
         *
         * Every call drains again, so a replay after a restart is safe: a capture is
         * created under its own UUID and a replay finds that task; a check-off or
         * defer is found in the lastApplied record, and one older than the last
         * command applied to its task writes nothing. The request ID
         * names the journal entry. In sandbox mode, or during a workspace switch,
         * nothing is read.
         */
        async ingestPendingCaptures(input: {
            requestId: string;
            queue: PendingCaptureQueuePort;
            lastApplied: PendingCaptureRecordPort;
        }): Promise<NativeHostResult<{ ingested: number }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !isQueuePort(input.queue) || !isRecordPort(input.lastApplied)) {
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
            // Every item's state is settled before the answer, and a later item's throw never hides an earlier one: an item
            // stored but not saved, recorded or removed is owed (SAVE_FAILED: the journal keeps this request and newer edits wait
            // for its replay); a throw or an item a failure left queued needs a later drain.
            if (unfinished.owed > 0) return fail('SAVE_FAILED', `${unfinished.owed} queued item(s) stored but not yet saved, recorded or removed`);
            if (thrown !== undefined) return fail('ACTION_FAILED', thrown instanceof Error ? thrown.message : String(thrown));
            if (unfinished.queued > 0) return fail('ACTION_FAILED', `${unfinished.queued} queued item(s) left for a later drain`);
            return { ok: true, value: { ingested } };
        },

        /**
         * The queued voice captures (an Android widget recording), as React Native's foreground drain turns them into tasks:
         * each `audio` item's recording goes through [audio]'s transcription, and a transcript becomes one task under the
         * capture's UUID, so a replay never makes a second one; its file and recording then go. No transcript (no speech
         * provider set up, or one this host cannot reach yet) leaves the item and its recording for a later run, as in RN.
         * Every other item is left for [ingestPendingCaptures]. Not journaled: a transcription waits on the network, and the
         * capture UUID makes a repeat exact. Runs in the same chain as the journaled drain, never beside it.
         */
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

        /**
         * An automation trigger, as the ACTIVATE_CONTEXT or DEACTIVATE_CONTEXT
         * broadcast carries it: its `url`, or its `action` and `context` extras.
         * Answers the notification to post, or null: data it cannot read,
         * deactivation, a repeat within 10 s or a start past the window's budget,
         * and a context with no next action post nothing. Nothing is written, so
         * a replay after a restart builds the same notification again; the
         * throttle is per process, as in React Native.
         */
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
