import type { TaskStatus } from '@mindwtr/core';
import { CONTEXTS_AXES, sanitizeAxis, type ContextsGroupBy } from '../components/views/list/next-grouping';
import { getWorkspaceCache } from './workspace-cache';

export const CONTEXTS_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:contexts:v1';
export const NO_CONTEXT_TOKEN = '__no_context__';
export const CONTEXTS_TOKEN_SELECTION_EVENT = 'mindwtr:contexts-token-selection';

const CONTEXT_STATUS_VALUES: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'];
const LEGACY_CONTEXT_STATUS_VALUES: Array<TaskStatus | 'all'> = ['all', ...CONTEXT_STATUS_VALUES];

// The dropdown this sanitizer has to agree with is CONTEXTS_AXES, so read that
// array rather than keeping a second copy of it here.
export type ContextsViewGroupBy = ContextsGroupBy;

export type ContextsPersistedViewState = {
    selectedContext: string | null;
    statusFilters: TaskStatus[];
    groupBy: ContextsViewGroupBy;
};

export const DEFAULT_CONTEXTS_VIEW_STATE: ContextsPersistedViewState = {
    selectedContext: null,
    statusFilters: [],
    groupBy: 'none',
};

export type ContextsTokenSelectionEventDetail = {
    selectedContext: string | null;
};

export function sanitizeContextsViewState(
    value: unknown,
    fallback: ContextsPersistedViewState,
): ContextsPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<ContextsPersistedViewState> & { statusFilter?: unknown }
        : {};
    const selectedContext = typeof parsed.selectedContext === 'string' && parsed.selectedContext.trim()
        ? parsed.selectedContext
        : null;
    const normalizeStatusFilters = (candidate: unknown, defaultValue: TaskStatus[]): TaskStatus[] => {
        if (Array.isArray(candidate)) {
            const next = candidate.filter((item): item is TaskStatus => (
                typeof item === 'string' && CONTEXT_STATUS_VALUES.includes(item as TaskStatus)
            ));
            return Array.from(new Set(next));
        }
        if (LEGACY_CONTEXT_STATUS_VALUES.includes(candidate as TaskStatus | 'all')) {
            return candidate === 'all' ? [] : [candidate as TaskStatus];
        }
        return defaultValue;
    };
    const legacyFallback = parsed.statusFilter === undefined
        ? fallback.statusFilters
        : normalizeStatusFilters(parsed.statusFilter, fallback.statusFilters);
    const groupBy = sanitizeAxis(CONTEXTS_AXES, parsed.groupBy, fallback.groupBy);
    return {
        selectedContext,
        statusFilters: normalizeStatusFilters(parsed.statusFilters, legacyFallback),
        groupBy,
    };
}

export function readContextsViewState(): ContextsPersistedViewState {
    const storage = getWorkspaceCache();
    if (!storage) return DEFAULT_CONTEXTS_VIEW_STATE;
    try {
        const raw = storage.getItem(CONTEXTS_VIEW_STATE_STORAGE_KEY);
        if (!raw) return DEFAULT_CONTEXTS_VIEW_STATE;
        return sanitizeContextsViewState(JSON.parse(raw) as unknown, DEFAULT_CONTEXTS_VIEW_STATE);
    } catch {
        return DEFAULT_CONTEXTS_VIEW_STATE;
    }
}

export function persistContextsViewSelection(selectedContext: string | null): ContextsPersistedViewState {
    const nextState = {
        ...readContextsViewState(),
        selectedContext,
    };
    const storage = getWorkspaceCache();
    if (storage) {
        try {
            storage.setItem(CONTEXTS_VIEW_STATE_STORAGE_KEY, JSON.stringify(nextState));
        } catch {
            // View state is non-critical; navigation should still proceed.
        }
    }
    return nextState;
}

export function dispatchContextsTokenSelection(selectedContext: string | null): void {
    persistContextsViewSelection(selectedContext);
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
        new CustomEvent<ContextsTokenSelectionEventDetail>(CONTEXTS_TOKEN_SELECTION_EVENT, {
            detail: { selectedContext },
        }),
    );
}

export function subscribeContextsTokenSelection(
    handler: (detail: ContextsTokenSelectionEventDetail) => void,
): () => void {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const listener: EventListener = (event) => {
        const detail = (event as CustomEvent<ContextsTokenSelectionEventDetail | undefined>).detail;
        if (!detail) return;
        handler(detail);
    };

    window.addEventListener(CONTEXTS_TOKEN_SELECTION_EVENT, listener);
    return () => window.removeEventListener(CONTEXTS_TOKEN_SELECTION_EVENT, listener);
}
