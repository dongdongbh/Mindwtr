import { useEffect } from 'react';
import { AppState } from 'react-native';

import { getNextFutureStartRevealAt, safeParseDate, useTaskStore, type AppData, type Language, type Task } from '@mindwtr/core';

import {
  activateWatchConnectivity,
  addPendingWatchCaptureListener,
  isWatchConnectivityAvailable,
  updateWatchApplicationContext,
} from '@/modules/watch-connectivity';
import { logInfo, logWarn } from '@/lib/app-log';
import { mobilePomodoroController } from '@/lib/pomodoro-controller';
import { focusWidgetFilterKey, getFocusWidgetFilter } from '@/lib/focus-widget-filter';
import { getLocalDayKey } from '@/hooks/use-local-day-key';
import { buildWidgetPayload } from '@/lib/widget-data';
import { buildWatchApplicationContext, watchPomodoroPublicationKey } from '@/lib/watch-snapshot';

const WATCH_SNAPSHOT_RELEASE_CHECK = 'v1.3.0/watch-snapshot';
const WATCH_NUMERIC_BRIDGE_RELEASE_CHECK = 'v1.3.0/watch-numeric-bridge';
const WATCH_PUBLICATION_COALESCE_MS = 120;


function getNextReviewDueAt(tasks: readonly Task[], nowMs: number): number | null {
  let next: number | null = null;
  for (const task of tasks) {
    const reviewAt = safeParseDate(task.reviewAt)?.getTime();
    if (reviewAt === undefined || reviewAt <= nowMs) continue;
    if (next === null || reviewAt < next) next = reviewAt;
  }
  return next;
}

export function useRootLayoutWatch({
    canonicalDataReady,
    disabled = false,
  language,
  onPendingCapture,
}: {
    canonicalDataReady: boolean;
    disabled?: boolean;
  language: Language;
  onPendingCapture: () => void;
}) {
    useEffect(() => {
        if (!canonicalDataReady || disabled || !isWatchConnectivityAvailable()) return;
    let active = true;
    let activated = false;
    let activationPromise: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let publishing = false;
    let publishAgain = false;
    let lastContextKey = '';


    let lastInputs: readonly unknown[] | null = null;
    let nextRevealAt: number | null = null;
    const readInputs = () => {
      const store = useTaskStore.getState();
      return [
        store.tasks, store.projects, store.sections, store.areas, store.people, store.settings,
        watchPomodoroPublicationKey(mobilePomodoroController.getSnapshot()),
        getLocalDayKey(),
        focusWidgetFilterKey(getFocusWidgetFilter()),
      ] as const;
    };
    const inputsUnchanged = (inputs: readonly unknown[]) => lastInputs !== null
      && inputs.every((value, index) => value === lastInputs![index])
      && (nextRevealAt === null || Date.now() < nextRevealAt);
    const rememberInputs = (inputs: ReturnType<typeof readInputs>) => {
      lastInputs = inputs;
      const startAt = getNextFutureStartRevealAt(inputs[0]);
      const reviewAt = getNextReviewDueAt(inputs[0], Date.now());
      nextRevealAt = startAt === null ? reviewAt : reviewAt === null ? startAt : Math.min(startAt, reviewAt);
    };
    const forgetPublished = () => {
      lastContextKey = '';
      lastInputs = null;
    };

    const buildContext = () => {
      const store = useTaskStore.getState();
      const data: AppData = {
        tasks: store.tasks,
        projects: store.projects,
        sections: store.sections,
        areas: store.areas,
        people: store.people,
        settings: store.settings,
      };
      const widget = buildWidgetPayload(data, language, {
        maxItems: 20,
        focusFilter: getFocusWidgetFilter(),
      });
      const byId = new Map(store.tasks.map((task) => [task.id, task]));
      const focus = widget.sections.flatMap((section) => section.items.map(({ id, title }) => {
        const task = byId.get(id);
        return { id, title, createdAt: task?.createdAt, description: task?.description, checklist: task?.checklist };
      }));
      const pomodoro = mobilePomodoroController.getSnapshot();
      const linkTaskEnabled = store.settings.gtd?.pomodoro?.linkTask === true;
      const completionAlertEnabled = store.settings.gtd?.pomodoro?.completionAlert !== false;
      const linked = linkTaskEnabled && pomodoro.selectedTaskId
        ? store.tasks.find((task) => (
          task.id === pomodoro.selectedTaskId
          && !task.deletedAt
          && task.status !== 'done'
          && task.status !== 'archived'
        ))
        : undefined;
      return buildWatchApplicationContext({
        focus,
        pomodoro,
        linkedTask: linked ? { id: linked.id, title: linked.title } : undefined,
        completionAlertEnabled,
      });
    };

    const publish = async () => {
      if (!active || !activated) return;
      if (publishing) {
        publishAgain = true;
        return;
      }
      publishing = true;
      try {
        do {
          publishAgain = false;
          const inputs = readInputs();
          if (inputsUnchanged(inputs)) continue;
          const context = buildContext();
          const key = JSON.stringify(context, (field, value) => field === 'generatedAt' ? undefined : value);
          if (key === lastContextKey) {
            rememberInputs(inputs);
            continue;
          }
          await updateWatchApplicationContext(context);
          if (!active) return;
          lastContextKey = key;
          rememberInputs(inputs);
          void logInfo('Watch snapshot published', {
            scope: 'watch',
            extra: {
              releaseCheck: WATCH_NUMERIC_BRIDGE_RELEASE_CHECK,
              outcome: 'published',
              focusCount: context.focus.length,
              timerPhase: context.pomodoro.phase,
              timerRunning: context.pomodoro.isRunning,
            },
          });
        } while (publishAgain && active);
      } catch {
        void logWarn('Watch snapshot publication failed', {
          scope: 'watch',
          extra: { releaseCheck: WATCH_SNAPSHOT_RELEASE_CHECK, outcome: 'failed' },
        });
      } finally {
        publishing = false;
      }
    };

    const requestPublish = () => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void publish();
      }, WATCH_PUBLICATION_COALESCE_MS);
    };

    const nativeListener = addPendingWatchCaptureListener(() => {
      onPendingCapture();

      forgetPublished();
      requestPublish();
    });
    const unsubscribeStore = useTaskStore.subscribe(requestPublish);
    let timerKey = watchPomodoroPublicationKey(mobilePomodoroController.getSnapshot());
    const unsubscribePomodoro = mobilePomodoroController.subscribe(() => {
      const nextKey = watchPomodoroPublicationKey(mobilePomodoroController.getSnapshot());
      if (nextKey === timerKey) return;
      timerKey = nextKey;
      requestPublish();
    });
    const minuteInterval = setInterval(requestPublish, 60_000);

    const ensureActivated = () => {
      if (activated || activationPromise) return activationPromise ?? Promise.resolve();
      activationPromise = activateWatchConnectivity()
        .then(() => {
          if (!active) return;
          activated = true;
          forgetPublished();
          requestPublish();
        })
        .catch(() => {
          void logWarn('Watch connectivity activation failed', {
            scope: 'watch',
            extra: { releaseCheck: WATCH_SNAPSHOT_RELEASE_CHECK, outcome: 'activation-failed' },
          });
        })
        .finally(() => {
          activationPromise = null;
        });
      return activationPromise;
    };
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;


      activated = false;
      void ensureActivated();
    });
    void ensureActivated();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      clearInterval(minuteInterval);
      appStateSubscription.remove();
      nativeListener.remove();
      unsubscribeStore();
      unsubscribePomodoro();
    };
  }, [canonicalDataReady, disabled, language, onPendingCapture]);
}
