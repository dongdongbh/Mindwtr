import { SHARE_CARD_SIZE, type ShareCardKind } from '@mindwtr/core/share-card';

import { logInfo } from './app-log';
import { isTauriRuntime } from './runtime';

const SHARE_CARD_RELEASE_CHECK = 'v1.3.0/share-card-export';
const SHARE_CARD_RENDER_TIMEOUT_MS = 10_000;

export async function renderSvgToPng(svg: string): Promise<Blob> {
    if (typeof document === "undefined" || typeof Image === "undefined") {
        throw new Error('Image rendering is unavailable.');
    }

    const source = URL.createObjectURL(
        new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
    );
    try {
        return await new Promise<Blob>((resolve, reject) => {
            const image = new Image();
            image.decoding = 'sync';
            let settled = false;
            const finish = (result: Blob | Error) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeoutId);
                image.onload = null;
                image.onerror = null;
                if (result instanceof Error) reject(result);
                else resolve(result);
            };
            const timeoutId = window.setTimeout(() => {
                finish(new Error('Image rendering timed out.'));
            }, SHARE_CARD_RENDER_TIMEOUT_MS);

            image.onload = () => {
                if (settled) return;
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = SHARE_CARD_SIZE;
                    canvas.height = SHARE_CARD_SIZE;
                    const context = canvas.getContext('2d');
                    if (!context) {
                        finish(new Error('Image rendering is unavailable.'));
                        return;
                    }
                    context.drawImage(
                        image,
                        0,
                        0,
                        SHARE_CARD_SIZE,
                        SHARE_CARD_SIZE,
                    );
                    canvas.toBlob((blob) => {
                        if (!settled) {
                            finish(
                                blob
                                    ?? new Error(
                                        'Could not encode the share image.',
                                    ),
                            );
                        }
                    }, 'image/png');
                } catch (error) {
                    finish(
                        error instanceof Error
                            ? error
                            : new Error('Could not create the share image.'),
                    );
                }
            };
            image.onerror = () => {
                finish(new Error('Could not load the share image.'));
            };
            image.src = source;
        });
    } finally {
        URL.revokeObjectURL(source);
    }
}

const reportSuccessfulExport = (
    kind: ShareCardKind,
    operation: 'copy' | 'save',
) => {
    void logInfo('Share card exported', {
        scope: 'share-card',
        extra: {
            releaseCheck: SHARE_CARD_RELEASE_CHECK,
            kind,
            operation,
        },
    });
};

export async function saveShareCardPng(
    blob: Blob,
    kind: ShareCardKind,
    dialogTitle: string,
): Promise<boolean> {
    const fileName = `mindwtr-${kind}.png`;
    if (isTauriRuntime()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const selected = await save({
            defaultPath: fileName,
            filters: [{ name: 'PNG', extensions: ['png'] }],
            title: dialogTitle,
        });
        if (!selected || typeof selected !== 'string') return false;
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(selected, new Uint8Array(await blob.arrayBuffer()));
    } else {
        if (typeof document === 'undefined')
            throw new Error('Browser download is unavailable.');
        const url = URL.createObjectURL(blob);
        try {
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            link.click();
        } finally {
            URL.revokeObjectURL(url);
        }
    }
    reportSuccessfulExport(kind, 'save');
    return true;
}

export function canCopyShareCardPng(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        typeof navigator.clipboard?.write === 'function' &&
        typeof ClipboardItem !== 'undefined'
    );
}

export async function copyShareCardPng(
    blob: Blob,
    kind: ShareCardKind,
): Promise<void> {
    if (!canCopyShareCardPng())
        throw new Error('Image clipboard is unavailable.');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    reportSuccessfulExport(kind, 'copy');
}
