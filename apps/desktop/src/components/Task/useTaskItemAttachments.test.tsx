import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { Attachment, Task } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { TaskAttachmentOverlays } from './TaskAttachmentOverlays';
import { useTaskItemAttachments } from './useTaskItemAttachments';

const openMock = vi.fn();
const invokeMock = vi.fn();
const mkdirMock = vi.fn();
const writeFileMock = vi.fn();
const removeMock = vi.fn();

vi.mock('@tauri-apps/api/path', () => ({
    dataDir: vi.fn(async () => '/data'),
    join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invokeMock(...args),
    convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Data: 1 },
    readFile: vi.fn(),
    readTextFile: vi.fn(),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    writeFile: (...args: unknown[]) => writeFileMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: (...args: unknown[]) => openMock(...args),
}));

vi.mock('../../lib/runtime', () => ({
    isTauriRuntime: () => true,
}));

const logWarnMock = vi.fn();
vi.mock('../../lib/app-log', () => ({
    logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

vi.mock('../../lib/ai-config', () => ({
    loadAIKey: vi.fn(async () => ''),
}));

vi.mock('../../lib/speech-to-text', () => ({
    processAudioCapture: vi.fn(),
    resolveSpeechCapture: vi.fn(async () => ({ ready: false, reason: 'disabled', config: { provider: 'gemini', model: '' } })),
}));

vi.mock('../../lib/open-attachment-target', () => ({
    openAttachmentTarget: vi.fn(async () => undefined),
}));

const task = {
    id: 'task-1',
    title: 'Task',
    status: 'inbox',
    attachments: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
} as unknown as Task;

const t = (key: string) => key;

describe('useTaskItemAttachments addFileAttachment', () => {
    beforeEach(() => {
        openMock.mockReset();
        invokeMock.mockReset();
        mkdirMock.mockClear();
        writeFileMock.mockClear();
    });

    it('copies the picked file into app storage and attaches the managed copy', async () => {
        openMock.mockResolvedValue('C:\\docs\\notes.txt');
        invokeMock.mockResolvedValue({ uri: '/data/mindwtr/attachments/id-1.txt', size: 1024 });

        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));
        await act(async () => {
            await result.current.addFileAttachment();
        });

        expect(invokeMock).toHaveBeenCalledWith('import_attachment_file', expect.objectContaining({
            path: 'C:\\docs\\notes.txt',
            fileName: expect.stringMatching(/\.txt$/),
            maxBytes: expect.any(Number),
        }));
        expect(result.current.attachmentError).toBeNull();
        expect(result.current.editAttachments).toHaveLength(1);
        expect(result.current.editAttachments[0]).toMatchObject({
            kind: 'file',
            title: 'notes.txt',
            uri: '/data/mindwtr/attachments/id-1.txt',
            size: 1024,
            localStatus: 'available',
        });
    });

    it('rejects the file and shows an error when the picked file cannot be read', async () => {
        openMock.mockResolvedValue('R:\\notes.txt');
        invokeMock.mockRejectedValue('File does not exist or cannot be accessed.');

        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));
        await act(async () => {
            await result.current.addFileAttachment();
        });

        expect(result.current.editAttachments).toHaveLength(0);
        expect(result.current.attachmentError).toBe('attachments.fileNotReadable');
    });

    it('shows the size error when the picked file exceeds the limit', async () => {
        openMock.mockResolvedValue('C:\\docs\\huge.iso');
        invokeMock.mockRejectedValue(new Error('file_too_large'));

        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));
        await act(async () => {
            await result.current.addFileAttachment();
        });

        expect(result.current.editAttachments).toHaveLength(0);
        expect(result.current.attachmentError).toBe('attachments.fileTooLarge');
    });
});

describe('useTaskItemAttachments addDroppedFileAttachments', () => {
    beforeEach(() => {
        openMock.mockReset();
        invokeMock.mockReset();
        mkdirMock.mockClear();
        writeFileMock.mockClear();
        // No Rust "get_managed_data_dir" command in this test environment;
        // getManagedDataDir() falls back to dataDir() + "mindwtr".
        invokeMock.mockRejectedValue(new Error('get_managed_data_dir not supported'));
    });

    it('writes a dropped file into the managed attachments dir and appends an attachment', async () => {
        const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));
        await act(async () => {
            await result.current.addDroppedFileAttachments([file]);
        });

        expect(mkdirMock).toHaveBeenCalledWith('/data/mindwtr/attachments', { recursive: true });
        expect(writeFileMock).toHaveBeenCalledWith(
            expect.stringMatching(/^\/data\/mindwtr\/attachments\/.+\.txt$/),
            expect.any(Uint8Array),
        );
        expect(result.current.attachmentError).toBeNull();
        expect(result.current.editAttachments).toHaveLength(1);
        expect(result.current.editAttachments[0]).toMatchObject({
            kind: 'file',
            title: 'notes.txt',
            size: file.size,
            localStatus: 'available',
            mimeType: 'text/plain',
        });
    });

    it('rejects an oversized dropped file before reading its bytes', async () => {
        const hugeFile = new File(['x'], 'huge.bin');
        Object.defineProperty(hugeFile, 'size', { value: 50 * 1024 * 1024 + 1 });

        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));
        await act(async () => {
            await result.current.addDroppedFileAttachments([hugeFile]);
        });

        expect(writeFileMock).not.toHaveBeenCalled();
        expect(result.current.editAttachments).toHaveLength(0);
        expect(result.current.attachmentError).toBe('attachments.fileTooLarge');
    });
});

describe('useTaskItemAttachments resetAttachmentState orphan cleanup', () => {
    beforeEach(() => {
        openMock.mockReset();
        invokeMock.mockReset();
        mkdirMock.mockClear();
        writeFileMock.mockClear();
        removeMock.mockClear();
        invokeMock.mockRejectedValue(new Error('get_managed_data_dir not supported'));
    });

    it('deletes the copied file when cancelling after an import', async () => {
        const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));
        await act(async () => {
            await result.current.addDroppedFileAttachments([file]);
        });
        expect(result.current.editAttachments).toHaveLength(1);
        const addedUri = result.current.editAttachments[0].uri;

        await act(async () => {
            result.current.resetAttachmentState(task.attachments);
            await Promise.resolve();
        });

        expect(removeMock).toHaveBeenCalledWith(addedUri);
        expect(result.current.editAttachments).toEqual(task.attachments || []);
    });

    it('deletes a copied draft file when the editor component unmounts', async () => {
        const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        const { result, unmount } = renderHook(() => useTaskItemAttachments({ task, t }));
        await act(async () => {
            await result.current.addDroppedFileAttachments([file]);
        });
        const addedUri = result.current.editAttachments[0].uri;

        await act(async () => {
            unmount();
            await Promise.resolve();
        });

        expect(removeMock).toHaveBeenCalledWith(addedUri);
    });

    it('removes the managed copy when a converted link persists, keeps it on cancel', async () => {
        // #913/#1001 follow-up: converting a pre-fix file-kind link to a
        // pointer must clean up the copy the app restored into data/attachments
        // — but only once the conversion actually saves.
        const legacy = {
            id: 'legacy-1',
            kind: 'file' as const,
            title: 'spec.docx',
            uri: '/data/mindwtr/attachments/legacy-1.docx',
            cloudKey: 'attachments/legacy-1.docx',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));

        // Round 1: convert, then cancel — the copy must survive.
        act(() => {
            result.current.resetAttachmentState([legacy]);
        });
        act(() => {
            result.current.editLinkAttachment(legacy);
        });
        act(() => {
            result.current.handleAddLinkAttachment('D:/docs/spec.docx');
        });
        await act(async () => {
            result.current.resetAttachmentState([legacy]);
            await Promise.resolve();
        });
        expect(removeMock).not.toHaveBeenCalled();

        // Round 2: convert, then save — now the copy is orphaned.
        act(() => {
            result.current.editLinkAttachment(legacy);
        });
        act(() => {
            result.current.handleAddLinkAttachment('D:/docs/spec.docx');
        });
        const savedPointer = { ...legacy, kind: 'link' as const, uri: 'D:/docs/spec.docx' };
        await act(async () => {
            result.current.resetAttachmentState([savedPointer]);
            await Promise.resolve();
        });
        expect(removeMock).toHaveBeenCalledWith('/data/mindwtr/attachments/legacy-1.docx');
    });

    it('does not remove a file that was already on the task', async () => {
        const existingAttachment = {
            id: 'existing-1',
            kind: 'file' as const,
            title: 'existing.txt',
            uri: '/data/mindwtr/attachments/existing-1.txt',
            size: 10,
            localStatus: 'available' as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const taskWithAttachment = { ...task, attachments: [existingAttachment] };
        const { result } = renderHook(() => useTaskItemAttachments({ task: taskWithAttachment, t }));

        await act(async () => {
            result.current.resetAttachmentState(taskWithAttachment.attachments);
            await Promise.resolve();
        });

        expect(removeMock).not.toHaveBeenCalled();
        expect(result.current.editAttachments).toEqual(taskWithAttachment.attachments);
    });

    it('removes a managed file only after its soft-delete is saved', async () => {
        const existingAttachment = {
            id: 'existing-1',
            kind: 'file' as const,
            title: 'existing.txt',
            uri: '/data/mindwtr/attachments/existing-1.txt',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const taskWithAttachment = { ...task, attachments: [existingAttachment] };
        const { result } = renderHook(() => useTaskItemAttachments({ task: taskWithAttachment, t }));

        act(() => result.current.removeAttachment(existingAttachment.id));
        const deleted = result.current.editAttachments[0];
        await act(async () => {
            result.current.resetAttachmentState(taskWithAttachment.attachments);
            await Promise.resolve();
        });
        expect(removeMock).not.toHaveBeenCalled();

        act(() => result.current.removeAttachment(existingAttachment.id));
        const committedDelete = result.current.editAttachments[0];
        expect(committedDelete.deletedAt).toBeTruthy();
        await act(async () => {
            result.current.resetAttachmentState([committedDelete]);
            await Promise.resolve();
        });
        expect(removeMock).toHaveBeenCalledWith(existingAttachment.uri);
        expect(deleted.deletedAt).toBeTruthy();
    });

    it('waits for durable persistence before deleting a baseline-owned file', async () => {
        const existingAttachment = {
            id: 'existing-1',
            kind: 'file' as const,
            title: 'existing.txt',
            uri: '/data/mindwtr/attachments/existing-1.txt',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const taskWithAttachment = { ...task, attachments: [existingAttachment] };
        const { result } = renderHook(() => useTaskItemAttachments({ task: taskWithAttachment, t }));

        act(() => result.current.removeAttachment(existingAttachment.id));
        const committedDelete = result.current.editAttachments[0];
        act(() => result.current.beginAttachmentSave());
        await act(async () => {
            result.current.resetAttachmentState([committedDelete]);
            await Promise.resolve();
        });
        expect(removeMock).not.toHaveBeenCalled();

        await act(async () => {
            result.current.settlePersistedAttachmentSave([committedDelete]);
            await Promise.resolve();
        });
        expect(removeMock).toHaveBeenCalledWith(existingAttachment.uri);
    });

    it('preserves draft and baseline files when a submitted save never becomes durable', async () => {
        const existingAttachment = {
            id: 'existing-1',
            kind: 'file' as const,
            title: 'existing.txt',
            uri: '/data/mindwtr/attachments/existing-1.txt',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const taskWithAttachment = { ...task, attachments: [existingAttachment] };
        const { result, unmount } = renderHook(() => useTaskItemAttachments({ task: taskWithAttachment, t }));

        act(() => result.current.removeAttachment(existingAttachment.id));
        const optimisticDelete = result.current.editAttachments[0];
        act(() => result.current.beginAttachmentSave());
        act(() => result.current.resetAttachmentState([optimisticDelete]));
        await act(async () => {
            unmount();
            await Promise.resolve();
        });

        expect(removeMock).not.toHaveBeenCalled();
    });

    it('never removes an orphaned file in a sibling directory that merely shares the managed dir prefix', async () => {
        // e.g. `/data/mindwtr/attachments-old/x.pdf` — `startsWith('/data/mindwtr/attachments')`
        // would wrongly match this without a path-separator boundary.
        const siblingAttachment = {
            id: 'sibling-1',
            kind: 'file' as const,
            title: 'x.pdf',
            uri: '/data/mindwtr/attachments-old/x.pdf',
            size: 10,
            localStatus: 'available' as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));
        act(() => {
            // Simulate the sibling-dir attachment having entered edit state
            // this session (e.g. imported/synced data), so cancelling treats
            // it as orphaned relative to the saved (empty) task.attachments.
            result.current.setEditAttachments([siblingAttachment]);
        });

        await act(async () => {
            result.current.resetAttachmentState(task.attachments);
            await Promise.resolve();
        });

        expect(removeMock).not.toHaveBeenCalled();
    });

    it('never removes a managed-directory file owned by another attachment id', async () => {
        const mismatchedAttachment = {
            id: 'draft-1',
            kind: 'file' as const,
            title: 'notes.txt',
            uri: '/data/mindwtr/attachments/other-id.txt',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));
        act(() => {
            result.current.setEditAttachments([mismatchedAttachment]);
        });

        await act(async () => {
            result.current.resetAttachmentState(task.attachments);
            await Promise.resolve();
        });

        expect(removeMock).not.toHaveBeenCalled();
    });

    it('never removes a link attachment added in the session', async () => {
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));

        act(() => {
            result.current.addLinkAttachment();
        });
        act(() => {
            result.current.handleAddLinkAttachment('https://example.com');
        });
        expect(result.current.editAttachments).toHaveLength(1);
        expect(result.current.editAttachments[0]).toMatchObject({ kind: 'link' });

        await act(async () => {
            result.current.resetAttachmentState(task.attachments);
            await Promise.resolve();
        });

        expect(removeMock).not.toHaveBeenCalled();
    });

    it('keeps a local file path added through the link prompt a pointer', async () => {
        // #1001: "Add link" and "Link to file…" promise a reference, no copy.
        // A kind:'file' record here hands the user's own file to attachment
        // sync, which uploads the bytes and re-homes the attachment onto its
        // own copy the first time the original moves.
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));

        act(() => {
            result.current.addLinkAttachment();
        });
        act(() => {
            result.current.handleAddLinkAttachment('/home/demo/spec.pdf');
        });

        expect(result.current.editAttachments[0]).toMatchObject({
            kind: 'link',
            title: 'spec.pdf',
            uri: '/home/demo/spec.pdf',
        });
        expect(invokeMock).not.toHaveBeenCalledWith('import_attachment_file', expect.anything());
        expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('converts a pre-fix file-kind link back to a pointer via edit', () => {
        // #1001 follow-up: "Add link" items recorded before the pointer fix
        // carry kind:'file' plus managed-copy bookkeeping. Editing one must be
        // allowed and re-saving must produce a clean pointer.
        const legacy = {
            id: 'legacy-1',
            kind: 'file',
            title: 'spec.docx',
            uri: 'D:/docs/spec.docx',
            cloudKey: 'attachments/legacy-1.docx',
            fileHash: 'abc123',
            localStatus: 'available',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        } as Attachment;
        const { result } = renderHook(() => useTaskItemAttachments({ task, t }));

        act(() => {
            result.current.resetAttachmentState([legacy]);
        });
        act(() => {
            result.current.editLinkAttachment(legacy);
        });
        expect(result.current.showLinkPrompt).toBe(true);
        act(() => {
            result.current.handleAddLinkAttachment('D:/docs/spec.docx');
        });

        const converted = result.current.editAttachments[0];
        expect(converted).toMatchObject({
            id: 'legacy-1',
            kind: 'link',
            uri: 'D:/docs/spec.docx',
        });
        expect(converted.cloudKey).toBeUndefined();
        expect(converted.fileHash).toBeUndefined();
        expect(converted.localStatus).toBeUndefined();
    });
});

// The overlays take the hook's result whole, so they can be rendered over the
// real hook instead of a wall of hand-built props.
function OverlaysHarness({ openTarget }: { openTarget?: Attachment }) {
    const attachments = useTaskItemAttachments({ task, t });
    return (
        <LanguageProvider>
            <button type="button" onClick={attachments.addLinkAttachment}>add-link</button>
            <button type="button" onClick={attachments.addObsidianNoteAttachment}>add-obsidian</button>
            {openTarget && (
                <button type="button" onClick={() => attachments.openAttachment(openTarget)}>open-attachment</button>
            )}
            <ul>
                {attachments.editAttachments.map((attachment) => (
                    <li key={attachment.id}>{attachment.uri}</li>
                ))}
            </ul>
            <TaskAttachmentOverlays attachments={attachments} t={t} />
        </LanguageProvider>
    );
}

describe('TaskAttachmentOverlays', () => {
    it('adds the typed link through the hook when the link prompt is confirmed', () => {
        render(<OverlaysHarness />);

        fireEvent.click(screen.getByText('add-link'));
        expect(screen.getByRole('dialog', { name: 'attachments.addLink' })).toBeTruthy();

        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'https://example.com' } });
        fireEvent.click(screen.getByText('common.save'));

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByText('https://example.com')).toBeTruthy();
    });

    it('labels the prompt for the Obsidian variant', () => {
        render(<OverlaysHarness />);

        fireEvent.click(screen.getByText('add-obsidian'));

        expect(screen.getByRole('dialog', { name: 'attachments.attachObsidianNote' })).toBeTruthy();
    });

    it('shows the image viewer for an image the hook opened', () => {
        const image: Attachment = {
            id: 'image-1',
            kind: 'file',
            title: 'photo.png',
            uri: '/data/mindwtr/attachments/photo.png',
            mimeType: 'image/png',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        render(<OverlaysHarness openTarget={image} />);

        fireEvent.click(screen.getByText('open-attachment'));

        expect(screen.getByRole('dialog', { name: 'photo.png' })).toBeTruthy();
    });
});
