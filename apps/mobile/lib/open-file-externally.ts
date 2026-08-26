import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

import { getContentUriAsync } from './file-system';

// Extension fallback for attachments whose stored mimeType is missing — an
// untyped VIEW intent makes Android show "no app can open this" even when a
// viewer is installed. Common document/media types only; anything else goes
// out as */* and lets the resolver decide.
const MIME_BY_EXTENSION: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    epub: 'application/epub+zip',
    zip: 'application/zip',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
};

const resolveViewMimeType = (uri: string, mimeType?: string): string => {
    const stored = mimeType?.trim();
    if (stored) return stored;
    const extension = uri.split('?')[0]?.split('.').pop()?.toLowerCase() ?? '';
    return MIME_BY_EXTENSION[extension] ?? '*/*';
};

/**
 * Opens a local file in an Android viewer app via ACTION_VIEW. The share sheet
 * (ACTION_SEND) only reaches send/save targets — PDF and document VIEWERS
 * register for ACTION_VIEW — so opening attachments through sharing read as
 * "I can only save it, not open it" (feedback 29f56873). Returns false on
 * non-Android platforms and when no installed app can view the type, so the
 * caller can fall back to its existing share-sheet path.
 */
export async function tryOpenWithAndroidViewer(uri: string, mimeType?: string): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    try {
        const contentUri = await getContentUriAsync(uri);
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: contentUri,
            // FLAG_GRANT_READ_URI_PERMISSION — the viewer cannot read the
            // app-private file without an explicit read grant on the URI.
            flags: 1,
            type: resolveViewMimeType(uri, mimeType),
        });
        return true;
    } catch {
        // No viewer installed for this type, or the URI grant failed — the
        // caller's share sheet is still a way out.
        return false;
    }
}

export const __openFileExternallyTestUtils = { resolveViewMimeType };
