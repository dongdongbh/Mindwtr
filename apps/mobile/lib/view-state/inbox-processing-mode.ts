import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Which Inbox-processing presentation this device uses. Deliberately NOT the
// synced `settings.gtd.inboxProcessing.defaultMode`: that one stays desktop-only
// because screen size, not preference, decides how many decisions fit at once —
// same reasoning as the calendar's per-device week-day count.
export const INBOX_PROCESSING_MODE_STORAGE_KEY = 'mindwtr:view:inboxProcessingMode:v1';

export const INBOX_PROCESSING_MODES = ['guided', 'quick'] as const;
export type InboxProcessingMode = typeof INBOX_PROCESSING_MODES[number];

export const DEFAULT_INBOX_PROCESSING_MODE: InboxProcessingMode = 'guided';

export function readInboxProcessingMode(raw: string | null): InboxProcessingMode {
  return INBOX_PROCESSING_MODES.includes(raw as InboxProcessingMode)
    ? raw as InboxProcessingMode
    : DEFAULT_INBOX_PROCESSING_MODE;
}

export function useInboxProcessingMode(): [InboxProcessingMode, (mode: InboxProcessingMode) => void] {
  const [mode, setMode] = useState<InboxProcessingMode>(DEFAULT_INBOX_PROCESSING_MODE);
  const touchedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(INBOX_PROCESSING_MODE_STORAGE_KEY).then((raw) => {
      if (active && !touchedRef.current) setMode(readInboxProcessingMode(raw));
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const selectMode = useCallback((next: InboxProcessingMode) => {
    touchedRef.current = true;
    setMode(next);
    void AsyncStorage.setItem(INBOX_PROCESSING_MODE_STORAGE_KEY, next).catch(() => undefined);
  }, []);

  return [mode, selectMode];
}
