import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { getWorkspaceCache } from '../lib/workspace-cache';

type SanitizePersistedViewState<T> = (value: unknown, fallback: T) => T;

function readPersistedViewState<T>(
    storageKey: string,
    fallback: T,
    sanitize?: SanitizePersistedViewState<T>
): T {
    const storage = getWorkspaceCache();
    if (!storage) return fallback;
    try {
        const raw = storage.getItem(storageKey);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw) as unknown;
        return sanitize ? sanitize(parsed, fallback) : parsed as T;
    } catch {
        return fallback;
    }
}

function savePersistedViewState<T>(storageKey: string, value: T) {
    const storage = getWorkspaceCache();
    if (!storage) return;
    try {
        storage.setItem(storageKey, JSON.stringify(value));
    } catch {
        // View state is a convenience. Storage failures should not block UI changes.
    }
}

export function usePersistedViewState<T>(
    storageKey: string,
    fallback: T,
    sanitize?: SanitizePersistedViewState<T>
): [T, Dispatch<SetStateAction<T>>] {
    const [storedState, setStoredState] = useState<{ storageKey: string; value: T }>(() => ({
        storageKey,
        value: readPersistedViewState(storageKey, fallback, sanitize),
    }));
    const state = storedState.storageKey === storageKey
        ? storedState.value
        : readPersistedViewState(storageKey, fallback, sanitize);

    const setPersistedState = useCallback<Dispatch<SetStateAction<T>>>((nextState) => {
        setStoredState((current) => {
            const currentValue = current.storageKey === storageKey
                ? current.value
                : readPersistedViewState(storageKey, fallback, sanitize);
            const next = typeof nextState === 'function'
                ? (nextState as (value: T) => T)(currentValue)
                : nextState;
            savePersistedViewState(storageKey, next);
            return { storageKey, value: next };
        });
    }, [fallback, sanitize, storageKey]);

    return [state, setPersistedState];
}
