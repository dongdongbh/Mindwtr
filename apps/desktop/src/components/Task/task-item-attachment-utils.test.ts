import { beforeEach, describe, expect, it, vi } from 'vitest';

const convertFileSrcMock = vi.hoisted(() => vi.fn((value: string) => `asset://${value}`));

vi.mock('@tauri-apps/api/core', async () => ({
    SERIALIZE_TO_IPC_FN: '__TAURI_TO_IPC_KEY__',
    Channel: class {},
    PluginListener: class {
        async unregister() {
            return undefined;
        }
    },
    Resource: class {},
    addPluginListener: async () => ({
        unregister: async () => undefined,
    }),
    checkPermissions: async () => undefined,
    convertFileSrc: convertFileSrcMock,
    invoke: async () => undefined,
    isTauri: () => true,
    requestPermissions: async () => undefined,
    transformCallback: () => 1,
}));

import { resolveAttachmentSource } from './task-item-attachment-utils';

describe('task-item attachment utils', () => {
    beforeEach(() => {
        convertFileSrcMock.mockClear();
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            writable: true,
            value: {},
        });
    });

    it('normalizes Windows file paths before converting them for Tauri previews', () => {
        expect(resolveAttachmentSource('C:\\Users\\demo\\Pictures\\receipt.png')).toBe(
            'asset://C:/Users/demo/Pictures/receipt.png'
        );
        expect(convertFileSrcMock).toHaveBeenCalledWith('C:/Users/demo/Pictures/receipt.png');
    });

    it('decodes file URIs before converting them for Tauri previews', () => {
        expect(resolveAttachmentSource('file:///C:/Users/demo/Pictures/My%20Receipt.png')).toBe(
            'asset://C:/Users/demo/Pictures/My Receipt.png'
        );
        expect(convertFileSrcMock).toHaveBeenCalledWith('C:/Users/demo/Pictures/My Receipt.png');
    });

    it.each(['\\\\host\\share\\image.png', 'file://host/share/image.png', 'file:///%5c%5chost/share/image.png'])('does not create an asset source for %s', (uri) => {
        expect(resolveAttachmentSource(uri)).toBe('');
        expect(convertFileSrcMock).not.toHaveBeenCalled();
    });
});
