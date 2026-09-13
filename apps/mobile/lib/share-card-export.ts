import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { PixelRatio, Platform } from 'react-native';
import type Svg from 'react-native-svg';

import { logInfo, logWarn } from './app-log';

const SHARE_CARD_FILE_NAME = 'mindwtr-share-card.png';
const SHARE_CARD_CAPTURE_TIMEOUT_MS = 10_000;
// Some native share extensions never settle after cancellation; keep the composer recoverable.
const SHARE_CARD_SHARE_TIMEOUT_MS = 30_000;
let shareCardFileSequence = 0;
type ShareCardExportStage = 'availability' | 'capture' | 'create' | 'download' | 'share' | 'write';

export class ShareCardUnavailableError extends Error {
  constructor() {
    super('Share card export is unavailable');
    this.name = 'ShareCardUnavailableError';
  }
}

class ShareCardShareTimeoutError extends Error {
  constructor() {
    super('Share sheet did not report completion');
    this.name = 'AbortError';
  }
}

class ShareCardFileUriError extends Error {
  readonly code = 'SHARE_CARD_FILE_URI_MISMATCH';

  constructor() {
    super('Share card cache URI did not include its filename');
    this.name = 'ShareCardFileUriError';
  }
}

export function isShareCardDismissal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLocaleLowerCase();
  return error.name === 'AbortError'
    || message.includes('cancel')
    || message.includes('dismiss')
    || message.includes('abort');
}

export function captureShareCardPng(
  svg: Svg | null,
  timeoutMs = SHARE_CARD_CAPTURE_TIMEOUT_MS,
): Promise<string> {
  if (!svg) return Promise.reject(new ShareCardUnavailableError());
  const pointScale = Platform.OS === 'ios' ? PixelRatio.get() : 1;
  const captureSize = 1080 / Math.max(1, pointScale);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new ShareCardUnavailableError());
    }, timeoutMs);
    try {
      svg.toDataURL(
        (base64) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (base64) resolve(base64);
          else reject(new ShareCardUnavailableError());
        },
        { width: captureSize, height: captureSize },
      );
    } catch (error) {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function recordExport(method: 'download' | 'share') {
  void logInfo('Share card export completed', {
    scope: 'share-card',
    extra: {
      releaseCheck: 'v1.3.0/share-card-export',
      cardKind: 'review',
      exportMethod: method,
    },
  }).catch(() => undefined);
}

function recordExportFailure(stage: ShareCardExportStage, error: unknown) {
  const nativeCode = typeof error === 'object' && error !== null && 'code' in error
    && (typeof error.code === 'string' || typeof error.code === 'number')
    ? String(error.code).slice(0, 80)
    : undefined;
  void logWarn('Share card export failed', {
    scope: 'share-card',
    extra: {
      releaseCheck: 'v1.3.0/share-card-export',
      failureStage: stage,
      errorType: error instanceof Error ? error.name : typeof error,
      nativeCode,
    },
  }).catch(() => undefined);
}

function downloadShareCard(base64: string) {
  if (typeof document === 'undefined') throw new ShareCardUnavailableError();
  const link = document.createElement('a');
  link.href = `data:image/png;base64,${base64}`;
  link.download = SHARE_CARD_FILE_NAME;
  link.rel = 'noopener';
  link.click();
}

function awaitNativeShare(share: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new ShareCardShareTimeoutError()), timeoutMs);
    share.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function exportShareCardPng(
  svg: Svg | null,
  dialogTitle: string,
  shareTimeoutMs = SHARE_CARD_SHARE_TIMEOUT_MS,
): Promise<'download' | 'share'> {
  let stage: ShareCardExportStage = 'capture';
  let file: File | null = null;
  let fileCreated = false;

  try {
    const base64 = await captureShareCardPng(svg);

    if (Platform.OS === 'web') {
      stage = 'download';
      downloadShareCard(base64);
      recordExport('download');
      return 'download';
    }

    stage = 'availability';
    if (!(await Sharing.isAvailableAsync())) throw new ShareCardUnavailableError();

    const fileName = `mindwtr-share-card-${Date.now()}-${shareCardFileSequence++}.png`;
    const cacheUri = Paths.cache.uri.endsWith('/') ? Paths.cache.uri : `${Paths.cache.uri}/`;
    file = new File(`${cacheUri}${fileName}`);
    stage = 'create';
    if (!file.uri.endsWith(fileName)) throw new ShareCardFileUriError();
    file.create();
    fileCreated = true;
    stage = 'write';
    file.write(base64, { encoding: 'base64' });
    stage = 'share';
    await awaitNativeShare(Sharing.shareAsync(file.uri, {
      dialogTitle,
      mimeType: 'image/png',
      UTI: 'public.png',
    }), shareTimeoutMs);
    recordExport('share');
    return 'share';
  } catch (error) {
    const dismissed = isShareCardDismissal(error);
    if (file && fileCreated && !dismissed) {
      try {
        file.delete();
      } catch {
        // Cache cleanup is best-effort after a failed share-sheet launch.
      }
    }
    if (!dismissed) recordExportFailure(stage, error);
    throw error;
  }
}
