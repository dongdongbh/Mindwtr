import { useEffect, useRef } from 'react';

import { parseContextAutomationUrl } from '@/lib/context-automation';
import {
  __resetContextAutomationDedupeForTests,
  handleContextAutomationPayload,
  wasContextAutomationRecentlyHandled,
} from '@/lib/context-automation-handler';

type ResolveText = (key: string, fallback: string) => string;

type UseRootLayoutContextAutomationParams = {
  canonicalDataReady: boolean;
  disabled?: boolean;
  incomingUrl: string | null;
  incomingUrlKey: number;
  returnToBackground?: () => void;
  resolveText: ResolveText;
};

export { __resetContextAutomationDedupeForTests };

export function useRootLayoutContextAutomation({
  canonicalDataReady,
  disabled = false,
  incomingUrl,
  incomingUrlKey,
  returnToBackground,
  resolveText,
}: UseRootLayoutContextAutomationParams) {


  const lastHandledKey = useRef<number>(0);

  useEffect(() => {
    if (!canonicalDataReady || disabled) return;
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
  }, [canonicalDataReady, disabled, incomingUrl, incomingUrlKey, resolveText, returnToBackground]);
}
