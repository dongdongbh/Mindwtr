import { enrichCapturedTaskLinkTitle, fetchWebPageTitle, getBareHttpUrl, isSandboxMode } from '@mindwtr/core';

export async function fetchMobileLinkTitle(url: string) {
    const { fetch } = await import('expo/fetch');
    return fetchWebPageTitle(url, (address, init) => fetch(address, {
        credentials: 'omit',
        redirect: 'error',
        headers: init.headers,
        signal: init.signal ?? undefined,
    }));
}

export function enrichMobileCaptureTitle(taskId: string | null | undefined, text: string) {
    const url = getBareHttpUrl(text);
    if (taskId && url && !isSandboxMode()) void enrichCapturedTaskLinkTitle(taskId, url, fetchMobileLinkTitle);
}
