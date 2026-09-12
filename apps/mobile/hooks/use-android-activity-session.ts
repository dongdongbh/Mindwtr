import * as React from 'react';

import {
  clearAndroidActivitySession,
  getCurrentAndroidActivityId,
  retainAndroidActivitySession,
  takeAndroidActivitySession,
} from '@/lib/android-activity-session';

type UseAndroidActivitySessionOptions<T> = {
  enabled?: boolean;
  getValue?: () => T | null | undefined;
  onRestore: (value: T) => void;
  ownerId: string;
  validate: (value: unknown) => value is T;
  value?: T | null | undefined;
};

/**
 * Restores component state across a verified Android Activity replacement.
 * It intentionally has no disk fallback: process death uses the existing
 * route/session behavior and never leaves unfinished drafts at rest.
 */
export function useAndroidActivitySession<T>({
  enabled = true,
  getValue,
  onRestore,
  ownerId,
  validate,
  value,
}: UseAndroidActivitySessionOptions<T>): {
  clear: () => void;
  rearm: () => void;
  sourceActivityId: number | null;
} {
  const [sourceActivityId] = React.useState(() => getCurrentAndroidActivityId());
  const latestValueRef = React.useRef(value);
  const getValueRef = React.useRef(getValue);
  const onRestoreRef = React.useRef(onRestore);
  const validateRef = React.useRef(validate);
  const explicitlyClearedRef = React.useRef(false);
  latestValueRef.current = value;
  getValueRef.current = getValue;
  onRestoreRef.current = onRestore;
  validateRef.current = validate;

  const clear = React.useCallback(() => {
    explicitlyClearedRef.current = true;
    clearAndroidActivitySession(ownerId);
  }, [ownerId]);

  // A durable action can disarm retention before it starts, then rearm the
  // same mounted owner if the action fails and leaves its draft editable.
  const rearm = React.useCallback(() => {
    explicitlyClearedRef.current = false;
  }, []);

  React.useLayoutEffect(() => {
    explicitlyClearedRef.current = false;
    if (!enabled) {
      clearAndroidActivitySession(ownerId);
      return undefined;
    }

    const recovered = takeAndroidActivitySession(ownerId, validateRef.current);
    if (recovered) onRestoreRef.current(recovered.value);

    return () => {
      const latestValue = getValueRef.current?.() ?? latestValueRef.current;
      if (explicitlyClearedRef.current || latestValue == null) {
        clearAndroidActivitySession(ownerId);
        return;
      }
      retainAndroidActivitySession(ownerId, latestValue, sourceActivityId);
    };
  }, [enabled, ownerId, sourceActivityId]);

  return React.useMemo(() => ({ clear, rearm, sourceActivityId }), [clear, rearm, sourceActivityId]);
}
