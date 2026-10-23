import { describe, expect, it } from 'vitest';
import { getClipboardImageFiles } from './clipboard-images';

describe('clipboard image representations', () => {
    it('uses files once when items contain distinct wrappers of those same images', () => {
        const files = [new File(['png'], 'image.png', { type: 'image/png' }), new File(['png'], 'image.png', { type: 'image/png' })];
        const clipboard = { files, items: files.map((file) => ({ kind: 'file', type: file.type,
            getAsFile: () => new File([file], file.name, { type: file.type }) })) } as unknown as DataTransfer;
        expect(getClipboardImageFiles(clipboard)).toEqual(files);
    });

    it('falls back to items only when the files representation has no images', () => {
        const file = new File(['png'], 'image.png', { type: 'image/png' });
        const clipboard = { files: [], items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } as unknown as DataTransfer;
        expect(getClipboardImageFiles(clipboard)).toEqual([file]);
        expect(getClipboardImageFiles(null)).toEqual([]);
    });
});
