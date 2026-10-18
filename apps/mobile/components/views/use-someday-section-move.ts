import { useCallback, useRef, useState } from 'react';
import {
  buildTaskViewSectionUndoUpdates,
  flushPendingSave,
  formatSomedaySectionMoved,
  getSomedaySectionMoveTasks,
  getSomedaySectionMoveText,
  planSomedaySectionMove,
  runStoreCommand,
  sortViewSectionDefinitions,
  useTaskStore,
  type AreaFilterSelection,
  type SomedaySectionAssignment,
  type Task,
} from '@mindwtr/core';

import { useToast } from '@/contexts/toast-context';
import { logInfo } from '@/lib/app-log';
import { assertBulkActionSucceeded } from '../use-task-list-selection';

type PreviousAssignment = SomedaySectionAssignment;
type PendingMove = {
  ids: string[];
  destination?: string;
  previous: PreviousAssignment[];
};
type PendingUndo = {
  previous: readonly PreviousAssignment[];
  destination?: string;
  count: number;
};

/** Someday's list scope, recomputed from the store at the moment of a write. */
function getLatestEligibleTasks(ids: readonly string[], filter: AreaFilterSelection): Task[] | null {
  const state = useTaskStore.getState();
  return getSomedaySectionMoveTasks({
    tasks: state.tasks,
    projects: state.projects,
    areas: state.areas ?? [],
    ids,
    resolvedAreaFilter: filter,
  });
}

export function useSomedaySectionMove(
  t: (key: string) => string,
  resolvedAreaFilter: AreaFilterSelection,
  exitSelectionMode: () => void,
) {
  const { showToast } = useToast();
  const [moveTargetIds, setMoveTargetIds] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const pendingMoveRef = useRef<PendingMove | null>(null);
  const pendingUndoRef = useRef<PendingUndo | null>(null);
  const undoBusyRef = useRef(false);

  const showMoveFailure = useCallback(() => {
    const text = getSomedaySectionMoveText(t);
    showToast({ title: text.errorTitle, message: text.moveFailed, tone: 'error', durationMs: 5200 });
  }, [showToast, t]);

  const undo = useCallback(async (previous: readonly PreviousAssignment[], destination?: string) => {
    if (undoBusyRef.current) return;
    undoBusyRef.current = true;
    try {
      const pending = pendingUndoRef.current?.previous === previous
        && pendingUndoRef.current.destination === destination ? pendingUndoRef.current : null;
      // Built on the rows as they are when the write is admitted, so a sync save's newer sections stay.
      const updates = await runStoreCommand(async () => {
        const latest = useTaskStore.getState();
        const latestTasks = previous.map(({ id }) => latest.tasks.find((task) => task.id === id)).filter((task): task is Task => Boolean(task));
        const built = buildTaskViewSectionUndoUpdates(latestTasks, 'someday', previous, destination);
        if (built.length > 0) assertBulkActionSucceeded(await latest.batchUpdateTasks(built));
        return built;
      });
      if (updates.length === 0 && !pending) return;
      if (updates.length > 0) {
        pendingUndoRef.current = { previous, destination, count: updates.length };
      }
      if (pending && updates.length === 0) {
        await useTaskStore.getState().retryPersistence();
      }
      await flushPendingSave();
      if (useTaskStore.getState().persistenceFailure) throw new Error('Someday section Undo save incomplete');
      const count = pendingUndoRef.current?.count ?? updates.length;
      pendingUndoRef.current = null;
      void logInfo('Someday section assignment saved', {
        scope: 'tasks',
        extra: { releaseCheck: 'v1.3.1/someday-section-move', count, operation: 'undo' },
      });
    } catch {
      const text = getSomedaySectionMoveText(t);
      showToast({
        title: text.errorTitle,
        message: text.undoFailed,
        tone: 'error',
        durationMs: 5200,
        actionLabel: text.undoLabel,
        onAction: () => { void undo(previous, destination); },
      });
    } finally {
      undoBusyRef.current = false;
    }
  }, [showToast, t]);

  const openForTask = useCallback((task: Task) => setMoveTargetIds([task.id]), []);
  const openForSelection = useCallback((ids: readonly string[]) => {
    if (ids.length > 0) setMoveTargetIds(Array.from(new Set(ids)));
  }, []);
  const close = useCallback(() => {
    if (!saving) setMoveTargetIds(null);
  }, [saving]);

  const move = useCallback(async (destination?: string) => {
    if (!moveTargetIds?.length || saving) return;
    setSaving(true);
    try {
      // The read, the plan and the write run as one command, so a sync save's newer rows are what the move builds on.
      const planned = await runStoreCommand(async () => {
        const latest = useTaskStore.getState();
        const sortedSections = sortViewSectionDefinitions(latest.settings?.gtd?.viewSections?.someday);
        const section = destination ? sortedSections.find((definition) => definition.id === destination) : undefined;
        if (destination && !section) return null;
        const eligibleTasks = getLatestEligibleTasks(moveTargetIds, resolvedAreaFilter);
        if (!eligibleTasks) return null;
        const plan = planSomedaySectionMove({
          ids: moveTargetIds,
          tasks: eligibleTasks,
          destination,
          pending: pendingMoveRef.current,
        });
        if (plan.previous.length > 0 && plan.updates.length > 0) {
          assertBulkActionSucceeded(await latest.batchUpdateTasks(plan.updates));
        }
        return { ...plan, section };
      });
      if (!planned) {
        showMoveFailure();
        return;
      }
      const { updates, previous, resumed, section } = planned;
      if (previous.length === 0) {
        setMoveTargetIds(null);
        exitSelectionMode();
        return;
      }
      pendingMoveRef.current = { ids: moveTargetIds, destination, previous };
      if (resumed && updates.length === 0) {
        await useTaskStore.getState().retryPersistence();
      }
      await flushPendingSave();
      if (useTaskStore.getState().persistenceFailure) throw new Error('Someday section move save incomplete');
      pendingMoveRef.current = null;
      setMoveTargetIds(null);
      exitSelectionMode();
      void logInfo('Someday section assignment saved', {
        scope: 'tasks',
        extra: { releaseCheck: 'v1.3.1/someday-section-move', count: previous.length, operation: 'move' },
      });
      showToast({
        message: formatSomedaySectionMoved(t, previous.length, section?.title),
        tone: 'success',
        durationMs: 5200,
        actionLabel: getSomedaySectionMoveText(t).undoLabel,
        onAction: () => { void undo(previous, destination); },
      });
    } catch {
      showMoveFailure();
    } finally {
      setSaving(false);
    }
  }, [exitSelectionMode, moveTargetIds, resolvedAreaFilter, saving, showMoveFailure, showToast, t, undo]);

  return { moveTargetIds, saving, openForTask, openForSelection, close, move };
}
