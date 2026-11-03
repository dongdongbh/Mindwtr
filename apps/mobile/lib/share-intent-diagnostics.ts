import { Platform } from 'react-native';

import { logInfo, logWarn } from './app-log';

export const IOS_SHARE_CAPTURE_RELEASE_CHECK = 'v1.3.0/ios-share-capture';

export type IosSharePayloadType = 'text' | 'weburl' | 'file' | 'media' | 'unknown';

type IosShareDiagnosticEvent =
  | { stage: 'provider-status'; providerReady: boolean; dataReady: boolean; disabled: boolean }
  | { stage: 'host-url-received'; type: IosSharePayloadType; providerReady: boolean; dataReady: boolean; disabled: boolean }
  | { stage: 'payload-seen'; type: IosSharePayloadType; providerReady: boolean; dataReady: boolean; disabled: boolean; fileCount: number }
  | { stage: 'waiting'; outcome: 'data-not-ready' | 'disabled'; providerReady: boolean }
  | { stage: 'processing-started'; type: IosSharePayloadType; fileCount: number }
  | { stage: 'files-prepared'; candidateCount: number; attachedCount: number; skippedCount: number }
  | { stage: 'payload-missing'; type: IosSharePayloadType }
  | { stage: 'native-error'; outcome: 'present'; providerReady: boolean; dataReady: boolean; disabled: boolean }
  | { stage: 'navigation-requested' | 'navigation-returned'; type: IosSharePayloadType }
  | { stage: 'reset-requested' | 'reset-returned' }
  | { stage: 'form-mounted' }
  | { stage: 'submit-started'; type: 'single' | 'bulk'; count: number }
  | { stage: 'submit-rejected'; type: 'single' | 'bulk'; outcome: 'prepare-failed' | 'validation-rejected' | 'transaction-rejected' | 'transaction-threw' }
  | { stage: 'transaction-returned'; type: 'single' | 'bulk'; outcome: 'success'; count: number }
  | { stage: 'bulk-confirmed'; count: number }
  | { stage: 'cancel'; type: 'single' | 'bulk' };

const WARNING_STAGES = new Set<IosShareDiagnosticEvent['stage']>([
  'payload-missing',
  'native-error',
  'submit-rejected',
]);


export function classifyIosShareHandoffUrl(url: string | null | undefined): IosSharePayloadType | null {
  if (typeof url !== 'string') return null;
  const match = /^(?:mindwtr|mindwtr-dev):\/\/dataUrl=[^#]*(?:#([^?#]*))?$/i.exec(url);
  if (!match) return null;
  const fragment = (match[1] ?? '').toLowerCase();
  if (fragment === 'text' || fragment === 'weburl' || fragment === 'file' || fragment === 'media') {
    return fragment;
  }
  return 'unknown';
}


export function logIosShareDiagnostic(event: IosShareDiagnosticEvent): void {
  if (Platform.OS !== 'ios') return;
  const context = {
    scope: 'share-intent',
    extra: {
      releaseCheck: IOS_SHARE_CAPTURE_RELEASE_CHECK,
      ...event,
    },
    force: true,
  } as const;
  try {
    const result = WARNING_STAGES.has(event.stage)
      ? logWarn('iOS incoming share diagnostic', context)
      : logInfo('iOS incoming share diagnostic', context);
    void Promise.resolve(result).catch(() => undefined);
  } catch {

  }
}
