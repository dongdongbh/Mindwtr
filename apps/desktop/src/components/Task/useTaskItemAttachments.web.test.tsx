import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Attachment, Task } from '@mindwtr/core';
import { useTaskItemAttachments } from './useTaskItemAttachments';

const fetchWebCloudAttachmentBlobMock = vi.fn();
const fetchWebCloudAttachmentTextMock = vi.fn();
const openAttachmentTargetMock = vi.fn(async (..._args: unknown[]) => undefined);
const revokeObjectUrlMock = vi.fn();

vi.mock('@tauri-apps/api/path', () => ({ dataDir: vi.fn(async () => '/data'), join: vi.fn(async (...p: string[]) => p.join('/')) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Data: 1 },
    readFile: vi.fn(),
    readTextFile: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    remove: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../lib/app-log', () => ({ logWarn: vi.fn() }));
vi.mock('../../lib/ai-config', () => ({ loadAIKey: vi.fn(async () => '') }));
vi.mock('../../lib/speech-to-text', () => ({ processAudioCapture: vi.fn(), resolveSpeechCapture: vi.fn() }));

vi.mock('../../lib/runtime', () => ({
    isTauriRuntime: () => false,
}));

vi.mock('../../lib/open-attachment-target', () => ({
    openAttachmentTarget: (...args: unknown[]) => openAttachmentTargetMock(...args),
}));

vi.mock('../../lib/web-attachment-source', () => ({
    fetchWebCloudAttachmentBlob: (...args: unknown[]) => fetchWebCloudAttachmentBlobMock(...args),
    fetchWebCloudAttachmentText: (...args: unknown[]) => fetchWebCloudAttachmentTextMock(...args),
}));

const task = {
    id: 'task-1',
    title: 'Task',
    status: 'inbox',
    attachments: [],
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
} as unknown as Task;

const t = (key: string) => key;

// Real synced records carry `mimeType` (the importer sets it); with a metadata-only
// attachment that is the only thing the web build can classify on, since `uri` is empty.
const makeAttachment = (title: string, mimeType?: string): Attachment => ({
    id: 'attachment-1',
    kind: 'file',
    title,
    mimeType,
    uri: '',
    cloudKey: `attachments/attachment-1.${title.split('.').pop()}`,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
} as Attachment);

describe('useTaskItemAttachments in the web build', () => {
    beforeEach(() => {
        fetchWebCloudAttachmentBlobMock.mockReset();
        fetchWebCloudAttachmentTextMock.mockReset();
        openAttachmentTargetMock.mockClear();
        // jsdom has neither; the hook revokes the blob URLs it is handed.
        (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectUrlMock;
        revokeObjectUrlMock.mockClear();
    });

    it('opens a metadata-only attachment as a blob URL in a new tab', async () => {
        fetchWebCloudAttachmentBlobMock.mockResolvedValue('blob:cloud-bytes');
        const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));

        await act(async () => {
            result.current.openAttachment(makeAttachment('report.pdf'));
        });

        await waitFor(() => expect(openSpy).toHaveBeenCalledWith('blob:cloud-bytes', '_blank'));
        expect(openAttachmentTargetMock).not.toHaveBeenCalled();
        expect(result.current.attachmentError).toBeNull();
        openSpy.mockRestore();
    });

    it('surfaces the unsupported message when the bytes cannot be fetched', async () => {
        fetchWebCloudAttachmentBlobMock.mockResolvedValue(null);
        const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));

        await act(async () => {
            result.current.openAttachment(makeAttachment('report.pdf'));
        });

        await waitFor(() => expect(result.current.attachmentError).toBe('attachments.fileNotSupported'));
        expect(openSpy).not.toHaveBeenCalled();
        openSpy.mockRestore();
    });

    it('reads a text attachment from the cloud instead of throwing', async () => {
        fetchWebCloudAttachmentTextMock.mockResolvedValue('hello from the server');
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));

        await act(async () => {
            result.current.openAttachment(makeAttachment('notes.txt', 'text/plain'));
        });

        await waitFor(() => expect(result.current.textContent).toBe('hello from the server'));
        expect(result.current.textError).toBeNull();
    });

    it('plays an audio attachment from the cloud blob', async () => {
        fetchWebCloudAttachmentBlobMock.mockResolvedValue('blob:audio-bytes');
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));

        await act(async () => {
            result.current.openAttachment(makeAttachment('memo.m4a', 'audio/mp4'));
        });

        await waitFor(() => expect(result.current.audioSource).toBe('blob:audio-bytes'));

        // The hook owns the URL it was handed: closing the player revokes it.
        act(() => result.current.closeAudio());
        expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:audio-bytes');
    });
});
