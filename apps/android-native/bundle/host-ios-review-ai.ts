import type { createNativeHostContract } from '../../../packages/core/src/native-host-contract';
import { NATIVE_HOST_MAX_WINDOW } from '../../../packages/core/src/native-host-contract';
import type { NativeAIHost } from '../../../packages/core/src/native-host-contract-ai';
import type { SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';
import { detach, exact, record } from '../../../packages/core/src/native-host-contract-project-shared';
import { taskEditValuesEqual } from '../../../packages/core/src/json-value-equality';
import { logInfo } from '../../../packages/core/src/logger';
import { getReviewSequenceBlockedNextIds, getWeeklyReviewBuckets } from '../../../packages/core/src/review-utils';
import { getWeeklyReviewSettings } from '../../../packages/core/src/review-views-model';
import { NativeReceiptSqliteAdapter, revisionOf } from '../../../packages/core/src/native-request-receipts';
import { isSandboxMode, isWorkspaceTransitionActive } from '../../../packages/core/src/sandbox';
import { taskFromSqliteRow } from '../../../packages/core/src/task-sync-schema';
import { projectFromSqliteRow } from '../../../packages/core/src/project-sync-schema';
import { sectionFromSqliteRow } from '../../../packages/core/src/section-sync-schema';
import { getStorageAdapter, useTaskStore } from '../../../packages/core/src/store';
import { createIOSReadOnlyAIHost } from './host-ios-task-ai';

type Contract = Pick<ReturnType<typeof createNativeHostContract>, 'getStrings' | 'requestWeeklyReviewAnalysis' | 'runReviewAction'>;
const invalid = () => new Error('INVALID_INPUT: Review AI requires a bounded canonical review request');
const stale = () => new Error('STALE_REVISION: Review AI owner changed');
const unwrap = <T>(value: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!value.ok) throw new Error(`${value.error.code}: ${value.error.message}`);
    return value.value;
};
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const json = (raw: string): Record<string, unknown> => {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 2_000_000) throw invalid();
    let value: unknown; try { value = detach(JSON.parse(raw)); } catch { throw invalid(); }
    if (!record(value)) throw invalid(); return value;
};
const analyzeRequest = (raw: string) => { if (!exact(json(raw), [])) throw invalid(); };
export const readReviewAIApply = (raw: string) => {
    const input = json(raw);
    if (!exact(input, ['requestId', 'suggestions', 'taskRevisions']) || !text(input.requestId, 36)
        || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.requestId)
        || !Array.isArray(input.suggestions) || input.suggestions.length < 1 || input.suggestions.length > NATIVE_HOST_MAX_WINDOW
        || !record(input.taskRevisions)) throw invalid();
    const suggestions = input.suggestions.map(value => {
        if (!record(value) || !exact(value, ['id', 'action', 'reason']) || !text(value.id, 500) || value.id.startsWith('project:')
            || !['someday', 'archive'].includes(value.action as string) || typeof value.reason !== 'string' || value.reason.length > 2000) throw invalid();
        return { id: value.id, action: value.action as 'someday' | 'archive', reason: value.reason };
    });
    const ids = suggestions.map(row => row.id), revisions = input.taskRevisions;
    if (new Set(ids).size !== ids.length || Object.keys(revisions).length !== ids.length || !ids.every(id => text(revisions[id], 200))) throw invalid();
    return { requestId: input.requestId, action: { type: 'applySuggestions' as const, suggestions, taskRevisions: revisions as Record<string, string> } };
};

/** Manual full-bucket analysis; only explicit selected Apply enters the canonical durable writer. */
export function createIOSReviewAI(deps: { contract: Contract; adapter: () => SqliteAdapter | null;
    isIOS: () => boolean; otherAIActive: () => boolean; isFossBuild: boolean }) {
    let active = false, selectedHost: NativeAIHost | null = null;
    const ready = (retry = false) => {
        const adapter = deps.adapter(), state = useTaskStore.getState();
        if (!deps.isIOS() || !adapter || getStorageAdapter() !== adapter || !adapter.concurrentWritesGuarded
            || isSandboxMode() || isWorkspaceTransitionActive() || state.isLoading || deps.otherAIActive())
            throw new Error('NOT_READY: Review AI requires current personal review storage');
        if (!retry && state.persistenceFailure) throw new Error('SAVE_FAILED: Review AI requires saved storage');
        return adapter;
    };
    const snapshot = () => {
        const state = useTaskStore.getState(), { weekStart } = getWeeklyReviewSettings(state.settings);
        const items = getWeeklyReviewBuckets(state.tasks, state.projects, { weekStart, sections: state.sections, sequenceAware: true }).staleItems;
        return { items, taskRevisions: Object.fromEntries(items.filter(item => item.status !== 'project').map(item => [item.id, revisionOf(state._tasksById.get(item.id)!)])),
            language: unwrap(deps.contract.getStrings({ keys: [] })).language, weekStart: weekStart ?? null };
    };
    return {
        get active() { return active; }, get host() { return selectedHost; },
        witness(raw: string) { ready(); analyzeRequest(raw); return JSON.parse(JSON.stringify(snapshot())) as ReturnType<typeof snapshot>; },
        async request(raw: string, owner: unknown, signal: AbortSignal) {
            const adapter = ready(); analyzeRequest(raw);
            if (active || typeof owner !== 'function') throw invalid();
            const frozen = JSON.parse(JSON.stringify(snapshot())) as ReturnType<typeof snapshot>,
                configuration = JSON.parse(JSON.stringify(useTaskStore.getState().settings.ai ?? {})) as NonNullable<ReturnType<typeof useTaskStore.getState>['settings']['ai']>, provider = configuration.provider ?? 'openai';
            if (provider !== 'openai' && provider !== 'gemini' && provider !== 'anthropic') throw invalid();
            const admit = (value: object): unknown => { try { return owner(JSON.stringify(value)); } catch { throw stale(); } };
            const accept = (value: object) => { if (admit(value) !== '') throw stale(); };
            const current = () => {
                if (signal.aborted || ready() !== adapter || !taskEditValuesEqual(JSON.parse(JSON.stringify(snapshot())), frozen)
                    || !taskEditValuesEqual(useTaskStore.getState().settings.ai ?? {}, configuration)) throw stale();
                accept({ phase: 'current' });
            };
            const host = createIOSReadOnlyAIHost(deps, provider, current, admit);
            active = true;
            try {
                accept({ phase: 'begin', provider, configuration: JSON.stringify(configuration), language: frozen.language }); current();
                logInfo('Native iOS review sequence candidates prepared', { scope: 'ai', force: true,
                    context: { releaseCheck: 'v1.3.8/ios-review-sequence', outcome: 'prepared', candidateCount: frozen.items.length } });
                selectedHost = host;
                let pending; try { pending = deps.contract.requestWeeklyReviewAnalysis({ signal }, true).then(unwrap); }
                finally { selectedHost = null; }
                const answer = await pending; current(); return answer;
            } finally { selectedHost = null; active = false; }
        },
        validateApply(raw: string, durableSQLJSON: string): null {
            ready();
            const input = readReviewAIApply(raw);
            let durable: unknown;
            try { durable = JSON.parse(durableSQLJSON); } catch { throw invalid(); }
            if (!record(durable) || !Array.isArray(durable.tasks) || !durable.tasks.every(record)
                || !Array.isArray(durable.projects) || !durable.projects.every(record)
                || !Array.isArray(durable.sections) || !durable.sections.every(record)) throw invalid();
            const blocked = getReviewSequenceBlockedNextIds(durable.tasks.map(taskFromSqliteRow), durable.projects.map(projectFromSqliteRow), durable.sections.map(sectionFromSqliteRow));
            if (input.action.suggestions.some(item => blocked.has(item.id))) throw stale();
            return null;
        },
        async outcome(raw: string) {
            const adapter = ready(true), input = readReviewAIApply(raw);
            if (!(adapter instanceof NativeReceiptSqliteAdapter)) throw invalid();
            return unwrap(await adapter.readDurableReceipt(input.requestId, JSON.stringify(['review', input.action]), { committedOnly: true }));
        },
        async apply(raw: string) {
            ready(true); if (active) throw invalid();
            return unwrap(await deps.contract.runReviewAction(readReviewAIApply(raw)));
        },
    };
}
