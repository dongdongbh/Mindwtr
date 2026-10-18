import { describe, expect, it } from 'vitest';
import { getClipboardImageFiles } from './clipboard-images';

describe('getClipboardImageFiles', () => {
    const image = () => new File(['png'], 'image.png', { type: 'image/png' });
    const clipboard = (files: File[], items: File[] = []): DataTransfer => ({
        files,
        items: items.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    }) as unknown as DataTransfer;

    it('imports an image once when items and files contain distinct File wrappers', () => {
        const file = image();
        expect(getClipboardImageFiles(clipboard([file], [image()]))).toEqual([file]);
    });

    it('preserves multiple files even when their names and sizes match', () => {
        const files = [image(), image()];
        expect(getClipboardImageFiles(clipboard(files, [image(), image()]))).toEqual(files);
    });

    it('falls back to items when files contains no images', () => {
        const file = image();
        expect(getClipboardImageFiles(clipboard([new File(['text'], 'note.txt', { type: 'text/plain' })], [file]))).toEqual([file]);
    });

    it('returns no images for empty or text-only clipboard data', () => {
        expect(getClipboardImageFiles(null)).toEqual([]);
        expect(getClipboardImageFiles(clipboard([]))).toEqual([]);
        expect(getClipboardImageFiles(clipboard([], [new File(['text'], 'note.txt', { type: 'text/plain' })]))).toEqual([]);
    });
});
