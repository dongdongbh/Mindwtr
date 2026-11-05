import { createGmailCaptureRuntime } from '@mindwtr/core/gmail-capture';
import { gmailCaptureTransport } from './gmail-capture-service';

export const {
    getGmailCaptureConfig, getGmailCaptureLabels, connectGmailCapture, cancelGmailCapture,
    configureGmailCapture, disconnectGmailCapture, getGmailCaptureStatus, subscribeGmailCaptureStatus,
    createGmailCaptureController, registerGmailCaptureController, pollGmailCaptureNow,
} = createGmailCaptureRuntime(gmailCaptureTransport);

export { gmailCaptureErrorTranslation, toGmailCaptureError } from '@mindwtr/core/gmail-capture';
export { clearGmailReceiptsReset, gmailReceiptsWereReset } from './gmail-capture-storage';
export type { GmailCaptureConfig, GmailCaptureLabel, GmailCaptureController } from '@mindwtr/core/gmail-capture';
