import { createGmailCaptureRuntime, type GmailCaptureConfig } from '@mindwtr/core/gmail-capture';
import { invokeNative, invokeNativeOr } from './tauri-invoke';

const runtime = createGmailCaptureRuntime({
    status: () => invokeNativeOr<GmailCaptureConfig>({
        available: false, connected: false, account: null, accountId: null, labelId: null, enabled: false,
    }, 'gmail_capture_status'),
    connect: () => invokeNative('gmail_capture_connect'),
    cancel: () => invokeNative('gmail_capture_cancel'),
    labels: () => invokeNative('gmail_capture_labels'),
    configure: (labelId, enabled) => invokeNative('gmail_capture_configure', { labelId, enabled }),
    disconnect: () => invokeNative('gmail_capture_disconnect'),
    poll: () => invokeNative('gmail_capture_poll'),
    validate: (batchId) => invokeNative('gmail_capture_validate', { batchId }),
    commit: (batchId) => invokeNative('gmail_capture_commit', { batchId }),
});

export const {
    getGmailCaptureConfig, getGmailCaptureLabels, connectGmailCapture, cancelGmailCapture,
    configureGmailCapture, disconnectGmailCapture, getGmailCaptureStatus, subscribeGmailCaptureStatus,
    createGmailCaptureController, registerGmailCaptureController, pollGmailCaptureNow,
} = runtime;
export { gmailCaptureIdFor, toGmailCaptureError, gmailCaptureErrorTranslation } from '@mindwtr/core/gmail-capture';
export type {
    GmailCaptureConfig, GmailCaptureLabel, GmailCaptureBatch, GmailCaptureErrorKind,
    GmailCaptureError, GmailCaptureStatus, GmailCaptureController,
} from '@mindwtr/core/gmail-capture';
