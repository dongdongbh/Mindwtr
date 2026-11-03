import type { Attachment, AttachmentAvailabilityPort } from '@mindwtr/core';

import {
    ensureAttachmentAvailableDetailed,
    getAttachmentAvailabilityPatch,
    getAttachmentDownloadIdentity,
    getAttachmentUnrecoverablePatch,
    hasAttachmentDownloadIdentity,
} from './attachment-sync-availability';


export const attachmentAvailabilityPort: AttachmentAvailabilityPort = {
    ensureAttachmentAvailableDetailed: (attachment) => ensureAttachmentAvailableDetailed(attachment),
    getAttachmentDownloadIdentity: (attachment) => getAttachmentDownloadIdentity(attachment),
    hasAttachmentDownloadIdentity: (attachment, identity): attachment is Attachment => hasAttachmentDownloadIdentity(attachment, identity),
    getAttachmentAvailabilityPatch: (current, resolved) => getAttachmentAvailabilityPatch(current, resolved),
    getAttachmentUnrecoverablePatch: (resolved) => getAttachmentUnrecoverablePatch(resolved),
};
