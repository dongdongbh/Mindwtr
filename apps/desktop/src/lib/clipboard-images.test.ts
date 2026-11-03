import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClipboardImageFiles, isEmptyPasteEvent, readAsyncClipboardImageFiles } from './clipboard-images';

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

describe('WebKitGTK image paste fallback', () => {
    afterEach(() => { Reflect.deleteProperty(navigator, 'clipboard'); });

    it('treats only a paste with no text and no types as empty', () => {
        expect(isEmptyPasteEvent({ types: [], getData: () => '' } as unknown as DataTransfer)).toBe(true);
        expect(isEmptyPasteEvent({ types: ['text/plain'], getData: () => 'hi' } as unknown as DataTransfer)).toBe(false);
        expect(isEmptyPasteEvent(null)).toBe(true);
    });

    it('returns the clipboard images and nothing when reading is refused', async () => {
        const png = new Blob(['png'], { type: 'image/png' });
        const read = vi.fn(async () => [{ types: ['text/plain'], getType: vi.fn() }, { types: ['image/png'], getType: async () => png }]);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read } });
        const files = await readAsyncClipboardImageFiles();
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ name: 'clipboard-0', type: 'image/png' });
        read.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
        await expect(readAsyncClipboardImageFiles()).resolves.toEqual([]);
    });
});
