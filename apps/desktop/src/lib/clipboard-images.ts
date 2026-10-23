export function getClipboardImageFiles(data: DataTransfer | null): File[] {
    if (!data) return [];
    const files = Array.from(data.files ?? []).filter((file) => file.type.toLowerCase().startsWith('image/'));
    if (files.length > 0) return files;
    return Array.from(data.items ?? []).flatMap((item) => {
        if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) return [];
        const file = item.getAsFile();
        return file ? [file] : [];
    });
}

export function getImageExtension(file: File): string {
    const types: Record<string, string> = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
        'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/heic': 'heic', 'image/heif': 'heif',
    };
    const extension = file.name.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
    return types[file.type.toLowerCase()] || (extension === 'jpeg' ? 'jpg' : extension) || 'png';
}

/** A paste that carried nothing at all: how WebKitGTK (Linux) delivers a clipboard image. */
export function isEmptyPasteEvent(data: DataTransfer | null): boolean {
    return !data?.getData?.('text/plain') && (data?.types?.length ?? 0) === 0;
}

// The async clipboard API still reads that image; the Rust side allows WebKit's clipboard
// permission request (#690). Permission denied or unsupported reads as no images.
export async function readAsyncClipboardImageFiles(): Promise<File[]> {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return [];
    try {
        const items = await navigator.clipboard.read();
        const blobs = await Promise.all(items.map(async (item) => {
            const imageType = item.types.find((type) => type.toLowerCase().startsWith('image/'));
            return imageType ? { blob: await item.getType(imageType), type: imageType } : null;
        }));
        return blobs
            .filter((entry): entry is { blob: Blob; type: string } => entry !== null)
            .map(({ blob, type }, index) => new File([blob], `clipboard-${index}`, { type }));
    } catch {
        return [];
    }
}
