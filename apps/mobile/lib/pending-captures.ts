import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    ANDROID_QUICK_CAPTURE_SOURCE,
    PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY,
    PENDING_CAPTURES_DIRECTORY,
    drainPendingCaptureQueue,
    type AppData,
    type PendingAudioCapture,
    type PendingCaptureStoreDeps,
} from '@mindwtr/core';

import { logError, logInfo, logWarn } from './app-log';
import { settleWatchChecklist } from '../modules/watch-connectivity';
import { deleteAsync, documentDirectory, getInfoAsync, readAsStringAsync, readDirectoryAsync } from './file-system';


export {
    ANDROID_CAPTURE_INTENT_SOURCE,
    ANDROID_QUICK_CAPTURE_SOURCE,
    PENDING_CAPTURES_DIRECTORY,
    applyPendingCompletion,
    buildPendingCaptureTaskProps,
    parsePendingCapture,
} from '@mindwtr/core';
export type {
    PendingAudioCapture,
    PendingCapture,
    PendingCompletion,
    PendingDefer,
    PendingPomodoro,
    PendingQueueItem,
} from '@mindwtr/core';

type IngestDeps = PendingCaptureStoreDeps & {
    transcribeAudio?: (audioPath: string, settings: AppData['settings']) => Promise<string | null>;
};

const APPLE_WATCH_SOURCE = 'apple-watch';
const QUICK_CAPTURE_AUDIO_DIRECTORY = 'quick-capture-audio';
const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

function hasRawDotSegment(fileUri: string): boolean {
    if (!/^file:/i.test(fileUri)) return false;
    const rawPath = fileUri.slice('file:'.length).split(/[?#]/, 1)[0];
    return rawPath.split('/').some((segment) => {
        try {
            const decoded = decodeURIComponent(segment);
            return decoded === '.' || decoded === '..';
        } catch {
            return true;
        }
    });
}

export function resolveSafeWatchAudioPath(audioPath: string, id: string): string | null {
    if (!documentDirectory || !UUID_PATTERN.test(id)) return null;
    try {
        const candidate = new URL(audioPath);
        if (
            candidate.protocol !== 'file:'
            || candidate.host !== ''
            || candidate.search !== ''
            || candidate.hash !== ''
        ) return null;
        const segments = decodeURIComponent(candidate.pathname).split('/').filter(Boolean);
        if (
            segments.at(-3) !== 'Documents'
            || segments.at(-2) !== 'watch-audio'
            || segments.at(-1) !== `${id}.wav`
        ) return null;
        const currentDocuments = documentDirectory.endsWith('/') ? documentDirectory : `${documentDirectory}/`;
        return new URL(`watch-audio/${id}.wav`, currentDocuments).href;
    } catch {
        return null;
    }
}

export function isSafeWatchAudioPath(audioPath: string, id: string): boolean {
    return resolveSafeWatchAudioPath(audioPath, id) !== null;
}


export function resolveSafeAndroidQuickCaptureAudioPath(audioPath: string, id: string): string | null {
    if (!documentDirectory || !UUID_PATTERN.test(id) || hasRawDotSegment(audioPath)) return null;
    try {
        const currentDocuments = documentDirectory.endsWith('/') ? documentDirectory : `${documentDirectory}/`;
        const expected = new URL(`${QUICK_CAPTURE_AUDIO_DIRECTORY}/${id}.wav`, currentDocuments);
        const candidate = new URL(audioPath);
        if (
            candidate.protocol !== 'file:'
            || candidate.host !== ''


            || Boolean(candidate.username)
            || Boolean(candidate.password)
            || candidate.search !== ''
            || candidate.hash !== ''
            || candidate.href !== expected.href
        ) return null;
        return expected.href;
    } catch {
        return null;
    }
}

export function isSafeAndroidQuickCaptureAudioPath(audioPath: string, id: string): boolean {
    return resolveSafeAndroidQuickCaptureAudioPath(audioPath, id) !== null;
}

function resolveSafePendingAudioPath(capture: PendingAudioCapture): string | null {
    if (capture.source === ANDROID_QUICK_CAPTURE_SOURCE) {
        return resolveSafeAndroidQuickCaptureAudioPath(capture.audioPath, capture.id);
    }


    if (!capture.source || capture.source === APPLE_WATCH_SOURCE) {
        return resolveSafeWatchAudioPath(capture.audioPath, capture.id);
    }
    return null;
}

export async function ingestPendingCaptures({ transcribeAudio, ...deps }: IngestDeps): Promise<number> {
    if (!documentDirectory) return 0;
    const dir = `${documentDirectory}${PENDING_CAPTURES_DIRECTORY}`;
    return drainPendingCaptureQueue({
        ...deps,
        settleWatchChecklist,
        queue: {
            list: async () => ((await getInfoAsync(dir)).exists ? readDirectoryAsync(dir) : null),
            read: (name) => readAsStringAsync(`${dir}/${name}`),
            delete: (name) => deleteAsync(`${dir}/${name}`, { idempotent: true }),
        },
        lastApplied: {
            read: () => AsyncStorage.getItem(PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY),
            write: (value) => AsyncStorage.setItem(PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY, value),
        },
        log: {
            info: (message, context) => logInfo(message, context),
            warn: (message, context) => logWarn(message, context),
            error: (error, context) => logError(error, context),
        },

        onUnfinished: (state) => logWarn('Pending capture left unfinished', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.4/pending-capture-unfinished', state },
        }),
        audio: {
            resolvePath: resolveSafePendingAudioPath,
            transcribe: transcribeAudio,
            delete: (audioPath) => deleteAsync(audioPath, { idempotent: true }),
        },
    });
}
