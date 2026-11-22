import { enrichCapturedTaskLinkTitle, extractWebPageTitle, fetchWebPageTitle, getBareHttpUrl } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';

export async function loadDesktopLinkTitle(url: string): Promise<string | null> {
    if (!isTauriRuntime()) return fetchWebPageTitle(url);
    try {
        const html = await invokeNative<unknown>('load_public_link_html', { url });
        return typeof html === 'string' ? extractWebPageTitle(html) : null;
    } catch {
        return null;
    }
}

export type LinkTitleCapture = { taskId: string; url: string };

export function getLinkTitleCapture(taskId: string | undefined, input: string): LinkTitleCapture | undefined {
    const url = getBareHttpUrl(input);
    return taskId && url ? { taskId, url } : undefined;
}

export function enrichDesktopCapturedLinkTitle({ taskId, url }: LinkTitleCapture): void {
    void enrichCapturedTaskLinkTitle(taskId, url, loadDesktopLinkTitle).catch(() => undefined);
}
