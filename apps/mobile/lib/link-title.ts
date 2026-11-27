import { Platform } from 'react-native';
import { enrichCapturedTaskLinkTitle, fetchWebPageTitle, getBareHttpUrl, isSandboxMode } from '@mindwtr/core';

const linkTitleUserAgent = () => `Mindwtr (${Platform.OS === 'ios' ? 'iOS' : 'Android'}; +https://github.com/dongdongbh/Mindwtr)`;

export async function fetchMobileLinkTitle(url: string) {
    const { fetch } = await import('expo/fetch');
    return fetchWebPageTitle(url, (address, init) => fetch(address, {
        credentials: 'omit',
        redirect: 'error',
        headers: { ...(init.headers as Record<string, string>), 'User-Agent': linkTitleUserAgent() },
        signal: init.signal ?? undefined,
    }));
}

export function enrichMobileCaptureTitle(taskId: string | null | undefined, text: string) {
    const url = getBareHttpUrl(text);
    if (taskId && url && !isSandboxMode()) void enrichCapturedTaskLinkTitle(taskId, url, fetchMobileLinkTitle);
}
