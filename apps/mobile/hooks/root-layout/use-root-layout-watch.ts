import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useTaskStore, type AppData, type Language } from '@mindwtr/core';

import {
  activateWatchConnectivity,
  addPendingWatchCaptureListener,
  isWatchConnectivityAvailable,
  updateWatchApplicationContext,
} from '@/modules/watch-connectivity';
import { logInfo, logWarn } from '@/lib/app-log';
import { mobilePomodoroController } from '@/lib/pomodoro-controller';
import { getFocusWidgetFilter } from '@/lib/focus-widget-filter';
import { buildWidgetPayload } from '@/lib/widget-data';
import { buildWatchApplicationContext, watchPomodoroPublicationKey } from '@/lib/watch-snapshot';

const WATCH_SNAPSHOT_RELEASE_CHECK = 'v1.3.0/watch-snapshot';
const WATCH_NUMERIC_BRIDGE_RELEASE_CHECK = 'v1.3.0/watch-numeric-bridge';
const WATCH_PUBLICATION_COALESCE_MS = 120;

export function useRootLayoutWatch({
    dataReady,
    disabled = false,
  language,
  onPendingCapture,
}: {
    dataReady: boolean;
    disabled?: boolean;
  language: Language;
  onPendingCapture: () => void;
}) {
    useEffect(() => {
        if (!dataReady || disabled || !isWatchConnectivityAvailable()) return;
    let active = true;
    let activated = false;
    let activationPromise: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let publishing = false;
    let publishAgain = false;
    let lastContextKey = '';

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
      const focus = widget.sections.flatMap((section) => section.items.map(({ id, title }) => ({ id, title })));
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
          const context = buildContext();
          const key = JSON.stringify(context, (field, value) => field === 'generatedAt' ? undefined : value);
          if (key === lastContextKey) continue;
          await updateWatchApplicationContext(context);
          if (!active) return;
          lastContextKey = key;
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

    const nativeListener = addPendingWatchCaptureListener(onPendingCapture);
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
          lastContextKey = '';
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
      // Foreground is both the retry boundary for failed activation and a
      // chance to replace context after pairing/session state changed.
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
  }, [dataReady, disabled, language, onPendingCapture]);
}
