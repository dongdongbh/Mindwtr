import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';

/**
 * Which grouping headings a task list has folded, per grouping axis, device-local
 * and never synced — the same shape desktop keeps in localStorage (#963, #970).
 *
 * One key per list rather than one nested blob, so two screens folding groups at
 * the same time cannot write over each other's lists.
 */
export function getTaskGroupCollapseStorageKey(listKey: string): string {
  return `mindwtr:view:group-collapse:${listKey}:v1`;
}

/** Grouping axis → folded group ids. */
export type TaskGroupCollapseState = Record<string, string[]>;

export function readTaskGroupCollapseState(raw: string | null): TaskGroupCollapseState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const state: TaskGroupCollapseState = {};
    Object.entries(parsed).forEach(([axis, ids]) => {
      if (!Array.isArray(ids)) return;
      const groupIds = ids.filter((id): id is string => typeof id === 'string');
      if (groupIds.length > 0) state[axis] = groupIds;
    });
    return state;
  } catch {
    return {};
  }
}

export function serializeTaskGroupCollapseState(state: TaskGroupCollapseState): string {
  return JSON.stringify(state);
}

/**
 * Folded state for one list's grouping headings. Keyed by axis so switching
 * Group from Area to Tags shows that axis's own folds instead of inheriting the
 * previous one's.
 */
export function useCollapsedTaskGroups(listKey: string, groupBy: string) {
  const [state, setState] = useState<TaskGroupCollapseState>({});
  const touchedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(getTaskGroupCollapseStorageKey(listKey))
      .then((raw) => {
        // Nothing stored is the common case; re-setting an empty object then would
        // re-render every list on mount for no change.
        if (!raw || !active || touchedRef.current) return;
        setState(readTaskGroupCollapseState(raw));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [listKey]);

  const collapsedGroupIds = useMemo(() => new Set(state[groupBy] ?? []), [groupBy, state]);

  const toggleGroup = useCallback((groupId: string) => {
    touchedRef.current = true;
    setState((current) => {
      const ids = current[groupBy] ?? [];
      const nextIds = ids.includes(groupId)
        ? ids.filter((id) => id !== groupId)
        : [...ids, groupId];
      const next = { ...current, [groupBy]: nextIds };
      void AsyncStorage.setItem(
        getTaskGroupCollapseStorageKey(listKey),
        serializeTaskGroupCollapseState(next),
      ).catch(() => undefined);
      return next;
    });
  }, [groupBy, listKey]);

  return { collapsedGroupIds, toggleGroup };
}
