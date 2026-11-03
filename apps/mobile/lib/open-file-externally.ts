import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { resolveAttachmentViewMimeType } from '@mindwtr/core';

import { getContentUriAsync } from './file-system';


const resolveViewMimeType = (uri: string, mimeType?: string): string => resolveAttachmentViewMimeType(uri, mimeType);


export async function tryOpenWithAndroidViewer(uri: string, mimeType?: string): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    try {
        const contentUri = await getContentUriAsync(uri);
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: contentUri,


            flags: 1,
            type: resolveViewMimeType(uri, mimeType),
        });
        return true;
    } catch {


        return false;
    }
}

export const __openFileExternallyTestUtils = { resolveViewMimeType };
