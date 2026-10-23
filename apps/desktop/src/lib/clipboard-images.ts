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
