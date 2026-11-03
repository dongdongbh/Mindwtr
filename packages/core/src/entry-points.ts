


import {
    isEntityOpenUrl,
    isOpenFeatureUrl,
    isShortcutCaptureUrl,
    parseOpenFeatureUrl,
    resolveOpenFeaturePath,
    type EntityOpenKind,
    type ShortcutCapturePayload,
} from './capture-deeplink';
import { DROPBOX_CALLBACK_SETTINGS_PATH, isDropboxAuthCallbackUrl } from './dropbox-auth-callback';


export type SystemPathRoute =

    | { kind: 'shareHandoff'; path: string }
    | { kind: 'dropboxCallback'; path: string }
    | { kind: 'openFeature'; path: string }

    | { kind: 'entityOpen' | 'capture'; path: '/inbox' }

    | { kind: 'quickCapture'; path: '/capture-modal?origin=system' }

    | { kind: 'path'; path: string };

const isQuickCaptureUrl = (path: string): boolean => {
    const url = new URL(path);
    if (url.protocol !== 'mindwtr:') return false;
    return url.hostname === 'capture-quick' || url.pathname === '/capture-quick';
};


export function resolveSystemPath(path: string, initial: boolean): SystemPathRoute {
    try {

        if (/^(mindwtr(?:-dev)?):\/\/dataUrl=\1ShareKey\/?(?:#(?:text|weburl|file|media))?$/.test(path)) {
            return { kind: 'shareHandoff', path: initial ? '/inbox' : '' };
        }
        if (isDropboxAuthCallbackUrl(path)) return { kind: 'dropboxCallback', path: DROPBOX_CALLBACK_SETTINGS_PATH };
        if (isOpenFeatureUrl(path)) return { kind: 'openFeature', path: resolveOpenFeaturePath(parseOpenFeatureUrl(path)?.feature ?? null) };
        if (isEntityOpenUrl(path)) return { kind: 'entityOpen', path: '/inbox' };
        if (isShortcutCaptureUrl(path)) return { kind: 'capture', path: '/inbox' };
        if (isQuickCaptureUrl(path)) {


            if (new URL(path).searchParams.get('entry') === 'details') {
                return { kind: 'path', path: '/capture-quick?mode=text' };
            }
            return { kind: 'quickCapture', path: '/capture-modal?origin=system' };
        }
    } catch {

    }
    return { kind: 'path', path };
}

const trimSharedValue = (value: string | null | undefined): string => (
    typeof value === 'string' ? value.trim() : ''
);


export type ShareCaptureDraft = { title: string; description?: string };


export function buildShareCaptureDraft({
    shareSubject,
    shareText,
    shareWebUrl,
}: {
    shareSubject?: string | null;
    shareText?: string | null;
    shareWebUrl?: string | null;
}): ShareCaptureDraft | null {
    const subject = trimSharedValue(shareSubject);
    if (subject) {
        const text = trimSharedValue(shareText);
        const url = trimSharedValue(shareWebUrl);
        const descriptionLines = [text, url && !text.includes(url) ? url : null]
            .filter((line): line is string => Boolean(line));
        return descriptionLines.length > 0 ? { title: subject, description: descriptionLines.join('\n') } : { title: subject };
    }

    const title = trimSharedValue(shareText) || trimSharedValue(shareWebUrl);
    if (!title) return null;
    const url = trimSharedValue(shareWebUrl);
    return url && url !== title ? { title, description: url } : { title };
}

type EntityRecord = { deletedAt?: string | null } | undefined;

export type EntityOpenLookup = {
    _tasksById?: { get(id: string): EntityRecord };
    _projectsById?: { get(id: string): EntityRecord };
    _areasById?: { get(id: string): EntityRecord };
};

export type EntityOpenTarget = { pathname: '/focus'; taskId: string } | { pathname: '/projects-screen'; projectId?: string };


export function resolveEntityOpenTarget(kind: EntityOpenKind, id: string, state: EntityOpenLookup): EntityOpenTarget | null {
    if (kind === 'task') {
        const task = state._tasksById?.get(id);
        if (!task || task.deletedAt) return null;
        return { pathname: '/focus', taskId: id };
    }
    if (kind === 'project') {
        const project = state._projectsById?.get(id);
        if (!project || project.deletedAt) return null;
        return { pathname: '/projects-screen', projectId: id };
    }
    const area = state._areasById?.get(id);
    if (!area || area.deletedAt) return null;
    return { pathname: '/projects-screen' };
}


const SHARED_WEB_URL_RE = /[(http(s)?)://(www.)?-a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_+.~#?&//=]*)/gi;


export type AndroidTextShare = { text: string; webUrl: string | null; subject: string | null };


export function readAndroidTextShare(input: {
    text?: string | null;
    title?: string | null;
    subject?: string | null;
}): AndroidTextShare | null {
    if (!input.text) return null;
    const webUrl = input.text.match(SHARED_WEB_URL_RE)?.find((link) => link.startsWith('http')) || null;
    return { text: input.text, webUrl, subject: input.title ?? input.subject ?? null };
}


export function buildCreateNoteCapture(input: {
    name?: string | null;
    text?: string | null;
    extraText?: string | null;
}): ShortcutCapturePayload | null {
    const rawTitle = (input.name ?? '').trim();
    const rawText = (input.text ?? input.extraText ?? '').trim();
    const title = rawTitle || rawText;
    if (!title) return null;
    return rawText && rawText !== title ? { title, note: rawText, tags: [] } : { title, tags: [] };
}
