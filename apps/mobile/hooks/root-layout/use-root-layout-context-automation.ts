import { useEffect, useRef } from 'react';

import { parseContextAutomationUrl } from '@/lib/context-automation';
import {
  __resetContextAutomationDedupeForTests,
  handleContextAutomationPayload,
  wasContextAutomationRecentlyHandled,
} from '@/lib/context-automation-handler';

type ResolveText = (key: string, fallback: string) => string;

type UseRootLayoutContextAutomationParams = {
  dataReady: boolean;
  incomingUrl: string | null;
  incomingUrlKey: number;
  returnToBackground?: () => void;
  resolveText: ResolveText;
};

export { __resetContextAutomationDedupeForTests };

export function useRootLayoutContextAutomation({
  dataReady,
  incomingUrl,
  incomingUrlKey,
  returnToBackground,
  resolveText,
}: UseRootLayoutContextAutomationParams) {
  // Keyed per delivery, not per URL string: the same automation link can
  // arrive twice in a row and must run both times.
  const lastHandledKey = useRef<number>(0);

  useEffect(() => {
    if (!dataReady) return;
    if (!incomingUrl) return;
    if (lastHandledKey.current === incomingUrlKey) return;

    const payload = parseContextAutomationUrl(incomingUrl);
    if (!payload) return;

    if (wasContextAutomationRecentlyHandled(payload)) {
      lastHandledKey.current = incomingUrlKey;
      returnToBackground?.();
      return;
    }

    lastHandledKey.current = incomingUrlKey;

    void handleContextAutomationPayload(payload, resolveText).finally(() => {
      returnToBackground?.();
    });
  }, [dataReady, incomingUrl, incomingUrlKey, resolveText, returnToBackground]);
}
