import type { createNativeHostContract } from '../../../packages/core/src/native-host-contract';
import type { NativeAIHost } from '../../../packages/core/src/native-host-contract-ai';
import type { SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';
import { detach, exact, record } from '../../../packages/core/src/native-host-contract-project-shared';
import { taskEditValuesEqual } from '../../../packages/core/src/json-value-equality';
import { getProcessInboxTokenPools, type ProcessInboxDraftEdit } from '../../../packages/core/src/process-inbox-model';
import { isSandboxMode, isWorkspaceTransitionActive } from '../../../packages/core/src/sandbox';
import { getStorageAdapter, useTaskStore } from '../../../packages/core/src/store';
import { resolveFeatureFlags } from '../../../packages/core/src/resolve-feature-flags';
import { createIOSReadOnlyAIHost } from './host-ios-task-ai';

type Contract = Pick<ReturnType<typeof createNativeHostContract>, 'getInboxProcessingStep' | 'getStrings' | 'requestInboxClarify'>;
type Request = { sessionId: string; taskId: string; step: string };
const unwrap = <T>(value: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!value.ok) throw new Error(`${value.error.code}: ${value.error.message}`);
    return value.value;
};
const invalid = () => new Error('INVALID_INPUT: Inbox AI requires its current bounded processing session');
const stale = () => new Error('STALE_REVISION: Inbox AI processing owner changed');
const text = (value: unknown, limit: number, nonempty = true): value is string => typeof value === 'string'
    && value.length <= limit && (!nonempty || Boolean(value.trim()));
const json = (raw: string): Record<string, unknown> => {
    if (typeof raw !== 'string' || raw.length > 2_000_000 || new TextEncoder().encode(raw).byteLength > 2_000_000) throw invalid();
    let value: unknown;
    try { value = detach(JSON.parse(raw)); } catch { throw invalid(); }
    if (!record(value)) throw invalid();
    return value;
};
const request = (value: unknown): Request => {
    if (!record(value) || !exact(value, ['sessionId', 'taskId', 'step']) || !text(value.sessionId, 500)
        || !text(value.taskId, 500) || !text(value.step, 100)) throw invalid();
    return { sessionId: value.sessionId, taskId: value.taskId, step: value.step };
};

export function createIOSInboxAI(deps: { contract: Contract; adapter: () => SqliteAdapter | null;
    isIOS: () => boolean; otherAIActive: () => boolean; isFossBuild: boolean }) {
    let active = false, selectedHost: NativeAIHost | null = null;
    const ready = () => {
        const adapter = deps.adapter(), state = useTaskStore.getState();
        if (!deps.isIOS() || !adapter || getStorageAdapter() !== adapter || !adapter.concurrentWritesGuarded
            || isSandboxMode() || isWorkspaceTransitionActive() || state.isLoading || deps.otherAIActive())
            throw new Error('NOT_READY: Inbox AI requires current personal processing storage');
        if (state.persistenceFailure) throw new Error('SAVE_FAILED: Inbox AI requires saved storage');
        return adapter;
    };
    const snapshot = (input: Request) => {
        const view = unwrap(deps.contract.getInboxProcessingStep(input)), state = useTaskStore.getState();
        const task = state._tasksById.get(input.taskId);
        if (!task || task.deletedAt || view.taskId !== input.taskId || view.step !== input.step) throw stale();
        return { view: { draft: view.draft, mode: view.mode, step: view.step,
            contexts: getProcessInboxTokenPools(state.tasks).contexts,
            language: unwrap(deps.contract.getStrings({ keys: [] })).language },
            task, configuration: state.settings.ai ?? {}, timeEstimates: resolveFeatureFlags(state.settings).timeEstimates };
    };
    return {
        get active() { return active; },
        get host() { return selectedHost; },
        witness(raw: string) { ready(); return detach(snapshot(request(json(raw))).view); },
        async request(raw: string, owner: unknown, signal: AbortSignal) {
            const adapter = ready(), input = request(json(raw));
            if (active || typeof owner !== 'function') throw invalid();
            const frozen = JSON.parse(JSON.stringify(snapshot(input))) as ReturnType<typeof snapshot>, provider = frozen.configuration.provider ?? 'openai';
            if (provider !== 'openai' && provider !== 'gemini' && provider !== 'anthropic') throw invalid();
            const admit = (value: object): unknown => { try { return owner(JSON.stringify(value)); } catch { throw stale(); } };
            const accept = (value: object) => { if (admit(value) !== '') throw stale(); };
            const current = () => {
                if (signal.aborted || ready() !== adapter || !taskEditValuesEqual(snapshot(input), frozen)) throw stale();
                accept({ phase: 'current' });
            };
            const host = createIOSReadOnlyAIHost(deps, provider, current, admit);
            active = true;
            try {
                accept({ phase: 'begin', provider, configuration: JSON.stringify(frozen.configuration), language: frozen.view.language });
                current();
                selectedHost = host;
                let pending;
                try { pending = deps.contract.requestInboxClarify(input, { signal }).then(unwrap); }
                finally { selectedHost = null; }
                const answer = await pending;
                current(); return answer;
            } finally { selectedHost = null; active = false; }
        },
        apply(raw: string, owner: unknown) {
            ready();
            const value = json(raw);
            if (active || typeof owner !== 'function' || !exact(value, ['request', 'expected', 'edits'])
                || !record(value.expected) || !Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > 2) throw invalid();
            const input = request(value.request);
            const edits: ProcessInboxDraftEdit[] = value.edits.map((edit, index) => {
                if (!record(edit) || index === 0 && (!exact(edit, ['type', 'field', 'value']) || edit.type !== 'set'
                    || edit.field !== 'title' || !text(edit.value, 10_000, false))
                    || index === 1 && (!exact(edit, ['type', 'value']) || edit.type !== 'addContext' || !text(edit.value, 500))) throw invalid();
                return index === 0 ? { type: 'set', field: 'title', value: edit.value as string }
                    : { type: 'addContext', value: edit.value as string };
            });
            if (owner() !== '' || !taskEditValuesEqual(snapshot(input).view, value.expected)) throw stale();
            let view = unwrap(deps.contract.getInboxProcessingStep(input));
            for (const edit of edits) view = unwrap(deps.contract.getInboxProcessingStep({ ...input, edit }));
            return view;
        },
    };
}
