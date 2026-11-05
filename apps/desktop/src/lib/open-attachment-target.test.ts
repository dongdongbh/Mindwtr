import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const openShellMock = vi.hoisted(() => vi.fn());
const logInfoMock = vi.hoisted(() => vi.fn());

vi.mock('./app-log', () => ({
    logInfo: logInfoMock,
    logWarn: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
    open: openShellMock,
}));

import { openAttachmentTarget } from './open-attachment-target';

describe('openAttachmentTarget', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        openShellMock.mockReset();
        logInfoMock.mockReset();
        vi.restoreAllMocks();
        delete (window as any).__TAURI_INTERNALS__;
        delete (window as any).__TAURI__;
    });

    it('hands a Joplin attachment unchanged to the OS before logging success without its URI', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
        const uri = 'joplin://x-callback-url/openNote?id=Note%2FCase%2520';
        openShellMock.mockImplementation(async () => {
            expect(logInfoMock).not.toHaveBeenCalled();
        });

        await openAttachmentTarget(uri, 'joplin-note-link');

        expect(openShellMock).toHaveBeenCalledWith(uri);
        expect(invokeMock).not.toHaveBeenCalled();
        expect(logInfoMock).toHaveBeenCalledExactlyOnceWith('Joplin link handed to the OS', {
            scope: 'links', force: true,
            extra: { releaseCheck: 'v1.3.8/joplin-link-open' },
        });
    });

    it('propagates a Joplin handoff failure without logging success or opening a browser', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
        const error = new Error('No installed handler');
        openShellMock.mockRejectedValue(error);
        const openSpy = vi.spyOn(window, 'open');

        await expect(openAttachmentTarget('joplin://x-callback-url/openNote?id=a')).rejects.toBe(error);

        expect(logInfoMock).not.toHaveBeenCalled();
        expect(openSpy).not.toHaveBeenCalled();
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('passes an UpNote attachment to the OS without decoding its noteId', async () => {
        (window as any).__TAURI_INTERNALS__ = {};
        const uri = 'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true';
        await openAttachmentTarget(uri, 'note-link');
        expect(openShellMock).toHaveBeenCalledWith(uri);
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('propagates a missing UpNote handler for the UI to offer recovery', async () => {
        (window as any).__TAURI_INTERNALS__ = {};
        openShellMock.mockRejectedValue(new Error('No installed handler'));
        const openSpy = vi.spyOn(window, 'open');
        await expect(openAttachmentTarget('upnote://x-callback-url/openNote?noteId=a')).rejects.toThrow('No installed handler');
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('opens web links through the Tauri shell opener', async () => {
        (window as any).__TAURI_INTERNALS__ = {};

        await openAttachmentTarget('https://example.com/file.pdf');

        expect(openShellMock).toHaveBeenCalledWith('https://example.com/file.pdf');
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('opens local paths through the desktop open_path command', async () => {
        (window as any).__TAURI_INTERNALS__ = {};

        await openAttachmentTarget('file:///tmp/a1.pdf', 'a1');

        expect(invokeMock).toHaveBeenCalledWith('open_path', {
            path: '/tmp/a1.pdf',
            attachmentId: 'a1',
        });
        expect(openShellMock).not.toHaveBeenCalled();
    });

    it('passes a folder link and its id to open_path unchanged', async () => {
        (window as any).__TAURI_INTERNALS__ = {};

        await openAttachmentTarget('/Users/dd/Projects/Alpha', 'folder-1');

        expect(invokeMock).toHaveBeenCalledWith('open_path', {
            path: '/Users/dd/Projects/Alpha',
            attachmentId: 'folder-1',
        });
        expect(openShellMock).not.toHaveBeenCalled();
    });

    it('uses browser file urls outside Tauri', async () => {
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

        await openAttachmentTarget('/tmp/My Doc.pdf');

        expect(openSpy).toHaveBeenCalledWith('file:///tmp/My Doc.pdf', '_blank');
        expect(invokeMock).not.toHaveBeenCalled();
        expect(openShellMock).not.toHaveBeenCalled();
    });
});
