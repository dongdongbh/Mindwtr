export function getClipboardImageFiles(data: DataTransfer | null): File[] {
    if (!data) return [];
    const files: File[] = [];
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
    }
    for (const file of Array.from(data.files ?? [])) {
        if (!file.type.toLowerCase().startsWith('image/')) continue;
        if (files.includes(file)) continue;
        files.push(file);
    }
    return files;
}

export function getImageExtension(file: File): string {
    const mime = file.type.toLowerCase();
    if (mime === 'image/png') return 'png';
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/gif') return 'gif';
    if (mime === 'image/bmp') return 'bmp';
    if (mime === 'image/svg+xml') return 'svg';
    if (mime === 'image/heic') return 'heic';
    if (mime === 'image/heif') return 'heif';
    const nameMatch = file.name.match(/\.([a-z0-9]{2,5})$/i);
    if (nameMatch?.[1]) return nameMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : nameMatch[1].toLowerCase();
    return 'png';
}

