import type { createNativeHostContract } from '../../../packages/core/src/native-host-contract';
import type { NativeAIHost } from '../../../packages/core/src/native-host-contract-ai';
import type { SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';
import type { TaskDraft } from '../../../packages/core/src/task-draft';
import type { ChecklistItem } from '../../../packages/core/src/types';
import { getTaskAIProjectContext } from '../../../packages/core/src/ai-task-actions';
import { taskEditValuesEqual } from '../../../packages/core/src/json-value-equality';
import { detach, exact, record } from '../../../packages/core/src/native-host-contract-project-shared';
import { resolveFeatureFlags } from '../../../packages/core/src/resolve-feature-flags';
import { isSandboxMode, isWorkspaceTransitionActive } from '../../../packages/core/src/sandbox';
import { getStorageAdapter, useTaskStore } from '../../../packages/core/src/store';

type Contract = Pick<ReturnType<typeof createNativeHostContract>, 'editTaskDraft' | 'getTaskEditorAI'
    | 'getStrings' | 'requestTaskEditorClarify' | 'requestTaskEditorBreakdown'>;
type Request = { operation: 'clarify'; id: string; draft: TaskDraft }
    | { operation: 'breakdown'; id: string; draft: TaskDraft; checklist: ChecklistItem[] };
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const invalid = () => new Error('INVALID_INPUT: Task AI requires a bounded canonical editor request');
const stale = () => new Error('STALE_REVISION: Task AI owner changed');

/** Shared only by the two private manual AI owners; no general storage or networking authority. */
export function createIOSReadOnlyAIHost(deps: { isFossBuild: boolean }, provider: string,
    current: () => void, admit: (payload: object) => unknown): NativeAIHost {
    const accept = (payload: object) => { if (admit(payload) !== '') throw stale(); };
    const unavailable = async (): Promise<never> => { throw new Error('NOT_READY: Task AI storage is private'); };
    const host: NativeAIHost = {
        platform: { isFossBuild: deps.isFossBuild },
        storage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable },
        secrets: { get: unavailable, set: unavailable, delete: unavailable },
        loadRequestKey: async selected => {
            current();
            if (selected !== provider) throw stale();
            const raw = admit({ phase: 'credential', provider: selected });
            let credential: unknown;
            try { credential = typeof raw === 'string' && raw.length <= 32 * 1024 ? JSON.parse(raw) : null; }
            catch { throw new Error('NOT_READY: Task AI credential is unavailable'); }
            current();
            if (!record(credential) || !exact(credential, ['value'])
                || credential.value !== null && (typeof credential.value !== 'string' || credential.value.length > 4000))
                throw new Error('NOT_READY: Task AI credential is unavailable');
            return credential.value;
        },
        fetch: async (url, init) => {
            current();
            accept({ phase: 'http', url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url });
            try { return await globalThis.fetch(url, init); }
            finally { current(); }
        },
    };
    return host;
}

/** Private manual editor actions; the native callback owns the actual editor/session and its workers. */
export function createIOSTaskAI(deps: { contract: Contract; adapter: () => SqliteAdapter | null;
    isIOS: () => boolean; otherAIActive: () => boolean; isFossBuild: boolean }) {
    let active = false;
    let selectedHost: NativeAIHost | null = null;
    const ready = () => {
        const adapter = deps.adapter(), state = useTaskStore.getState();
        if (!deps.isIOS() || !adapter || getStorageAdapter() !== adapter || !adapter.concurrentWritesGuarded
            || isSandboxMode() || isWorkspaceTransitionActive() || state.isLoading || deps.otherAIActive())
            throw new Error('NOT_READY: Task AI requires current personal editor storage');
        if (state.persistenceFailure) throw new Error('SAVE_FAILED: Task AI requires saved storage');
        return adapter;
    };
    const input = (json: string, request: boolean) => {
        if (typeof json !== 'string' || json.length > 2_000_000 || new TextEncoder().encode(json).byteLength > 2_000_000)
            throw invalid();
        let value: Record<string, unknown> | null;
        try { value = detach<Record<string, unknown>>(JSON.parse(json)); } catch { throw invalid(); }
        if (!value || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 500
            || !exact(value, request ? value.operation === 'breakdown'
                ? ['operation', 'id', 'draft', 'checklist'] : ['operation', 'id', 'draft'] : ['id', 'draft'])
            || request && value.operation !== 'clarify' && value.operation !== 'breakdown') throw invalid();
        // Core owns the complete draft/checklist grammar and canonical field defaults.
        const editor = unwrap(deps.contract.editTaskDraft({ id: value.id, draft: value.draft as TaskDraft,
            ...(value.operation === 'breakdown' ? { checklist: value.checklist as ChecklistItem[] } : {}) }));
        if (editor.readOnly) throw new Error('INVALID_INPUT: Task AI is unavailable for a read-only task');
        return { value, id: value.id, draft: editor.draft };
    };
    const snapshot = (request: Request) => {
        const state = useTaskStore.getState(), task = state._tasksById.get(request.id);
        if (!task || task.deletedAt) throw stale();
        const projectIds = Array.from(new Set([task.projectId, request.draft.projectId].filter(Boolean)));
        return {
            task,
            projects: projectIds.map(id => state._allProjects.find(project => project.id === id) ?? null),
            projectContext: getTaskAIProjectContext({ projectId: request.draft.projectId,
                projects: state.projects, tasks: state.tasks, taskId: request.id }),
            configuration: state.settings.ai ?? {},
            timeEstimates: resolveFeatureFlags(state.settings).timeEstimates,
            language: unwrap(deps.contract.getStrings({ keys: [] })).language,
        };
    };
    return {
        get active() { return active; },
        get host() { return selectedHost; },
        options(json: string) {
            ready();
            const { id, draft } = input(json, false);
            const view = unwrap(deps.contract.getTaskEditorAI({ id, draft }));
            return { enabled: view.enabled, clarify: view.clarify, breakdown: view.breakdown, working: view.working };
        },
        witness(json: string) {
            ready();
            const { id, draft } = input(json, false);
            const value = snapshot({ operation: 'clarify', id, draft });
            // Keep canonical visible-array ordering and its first-20 bound; native must not guess SQLite ordering.
            const contextTaskIDs = draft.projectId ? useTaskStore.getState().tasks
                .filter(task => task.projectId === draft.projectId && task.id !== id && !task.deletedAt)
                .slice(0, 20).map(task => task.id) : [];
            return { language: value.language, projectContext: value.projectContext, contextTaskIDs };
        },
        async request(json: string, owner: unknown, signal: AbortSignal) {
            const adapter = ready();
            if (active || typeof owner !== 'function') throw invalid();
            const { value, id, draft } = input(json, true);
            const request: Request = value.operation === 'breakdown'
                ? { operation: 'breakdown', id, draft, checklist: value.checklist as ChecklistItem[] }
                : { operation: 'clarify', id, draft };
            const frozen = JSON.parse(JSON.stringify(snapshot(request))) as ReturnType<typeof snapshot>;
            const provider = frozen.configuration.provider ?? 'openai';
            if (provider !== 'openai' && provider !== 'gemini' && provider !== 'anthropic')
                throw new Error('NOT_READY: Task AI provider is unavailable');
            const admit = (payload: object): unknown => {
                try { return owner(JSON.stringify(payload)); } catch { throw stale(); }
            };
            const accept = (payload: object) => { if (admit(payload) !== '') throw stale(); };
            const current = () => {
                if (signal.aborted || ready() !== adapter || !taskEditValuesEqual(snapshot(request), frozen)) throw stale();
                accept({ phase: 'current' });
            };
            const host = createIOSReadOnlyAIHost(deps, provider, current, admit);
            active = true;
            try {
                accept({ phase: 'begin', provider, configuration: JSON.stringify(frozen.configuration), language: frozen.language });
                current();
                // Canonical actions capture their host before their first await. Never lend it while HTTP waits.
                selectedHost = host;
                let pending;
                try {
                    pending = request.operation === 'clarify'
                        ? deps.contract.requestTaskEditorClarify(request, { signal }).then(unwrap)
                        : deps.contract.requestTaskEditorBreakdown(request, { signal }).then(unwrap);
                } finally { selectedHost = null; }
                const answer = await pending;
                current();
                return answer;
            } finally { selectedHost = null; active = false; }
        },
    };
}
