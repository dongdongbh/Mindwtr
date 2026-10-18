import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTaskStore, type Attachment, type Project } from '@mindwtr/core';

import { appendProjectAttachments, useProjectAttachmentActions } from './useProjectAttachmentActions';
import { holdSyncSave } from '../../../test/hold-sync-save';
import { useUiStore } from '../../../store/ui-store';
import { isTauriRuntime } from '../../../lib/runtime';

const dialogOpenMock = vi.hoisted(() => vi.fn());
const shellOpenMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellOpenMock }));

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/runtime', () => ({
    isTauriRuntime: vi.fn(() => false),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: dialogOpenMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

const baseProject: Project = {
    id: 'project-1',
    title: 'Project 1',
    status: 'active',
    color: '#94a3b8',
    order: 0,
    tagIds: [],
    attachments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

const initialTaskState = useTaskStore.getState();

describe('useProjectAttachmentActions', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    afterEach(() => {
        useTaskStore.setState(initialTaskState, true);
    });

    /** The hook writes through the store: [updateProject] is the store write it reaches. */
    const setup = (selectedProject: Project | undefined = baseProject, updateProject = vi.fn()) => {
        useTaskStore.setState({ _allProjects: selectedProject ? [selectedProject] : [], updateProject });
        const params: Parameters<typeof useProjectAttachmentActions>[0] = {
            t: (key) => key,
            selectedProject,
        };

        const hook = renderHook(() => useProjectAttachmentActions(params));
        return { hook, params, updateProject };
    };

    it('recovers a failed project UpNote link by copying its original URI', async () => {
        vi.mocked(isTauriRuntime).mockReturnValue(true);
        shellOpenMock.mockRejectedValue(new Error('No installed handler'));
        useUiStore.setState({ toasts: [] });
        const copy = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
        const uri = 'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true';
        const attachment: Attachment = { id: 'note-1', kind: 'link', title: 'Note', uri, createdAt: baseProject.createdAt, updatedAt: baseProject.updatedAt };
        const { hook, updateProject } = setup({ ...baseProject, attachments: [attachment] });
        await act(async () => hook.result.current.openAttachment(attachment));
        expect(shellOpenMock).toHaveBeenCalledWith(uri);
        expect(hook.result.current.attachmentError).toContain('Make sure the app');
        expect(updateProject).not.toHaveBeenCalled();
        await act(async () => useUiStore.getState().toasts[0].action?.onClick());
        expect(copy).toHaveBeenCalledWith(uri);
        vi.mocked(isTauriRuntime).mockReturnValue(false);
    });

    it('reports file attachments as unsupported on web runtime', async () => {
        const { hook } = setup();

        await act(async () => {
            await hook.result.current.addProjectFileAttachment();
        });

        expect(hook.result.current.attachmentError).toBe('attachments.fileNotSupported');
    });

    it('opens attachments in a browser tab on web runtime', async () => {
        const { hook } = setup();
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
        const attachment: Attachment = {
            id: 'attachment-1',
            kind: 'file',
            title: 'Notes',
            uri: '/tmp/notes.txt',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };

        await act(async () => {
            await hook.result.current.openAttachment(attachment);
        });

        expect(openSpy).toHaveBeenCalledWith('file:///tmp/notes.txt', '_blank');
    });

    it('links a picked folder to the project as a plain link', async () => {
        vi.mocked(isTauriRuntime).mockReturnValue(true);
        dialogOpenMock.mockResolvedValue('/Users/dd/Projects/Alpha');
        invokeMock.mockResolvedValue(true);
        const { hook, updateProject } = setup();

        await act(async () => {
            await hook.result.current.addProjectFolderLinkAttachment();
        });

        expect(dialogOpenMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
        expect(updateProject).toHaveBeenCalledWith('project-1', {
            attachments: [expect.objectContaining({
                kind: 'link',
                title: 'Alpha',
                uri: '/Users/dd/Projects/Alpha',
                mimeType: 'inode/directory',
            })],
        });
        const [{ attachments }] = vi.mocked(updateProject).mock.calls[0].slice(1) as [Partial<Project>];
        expect(invokeMock).toHaveBeenCalledWith('remember_link_folder_access', {
            attachmentId: attachments?.[0].id,
            path: '/Users/dd/Projects/Alpha',
        });
        vi.mocked(isTauriRuntime).mockReturnValue(false);
    });

    describe('behind a sync save', () => {
        const file = (id: string): Attachment => ({
            id, kind: 'file', title: `${id}.pdf`, uri: `/data/attachments/${id}.pdf`, createdAt: baseProject.createdAt, updatedAt: baseProject.updatedAt,
        });
        const opened: Project = { ...baseProject, rev: 1, attachments: [file('A')] };
        const publishSibling = () => holdSyncSave(() => useTaskStore.setState({ _allProjects: [{ ...opened, rev: 3, attachments: [file('A'), file('B')] }] }));
        const storedIds = () => useTaskStore.getState()._projectsById.get(opened.id)?.attachments?.map((item) => [item.id, Boolean(item.deletedAt)]);

        it('links a folder onto the attachments a sync save published while the write waited', async () => {
            vi.mocked(isTauriRuntime).mockReturnValue(true);
            dialogOpenMock.mockResolvedValue('/Users/dd/Projects/Alpha');
            invokeMock.mockResolvedValue(true);
            const { hook } = setup(opened, initialTaskState.updateProject as never);
            const finish = publishSibling();
            await act(async () => {
                await hook.result.current.addProjectFolderLinkAttachment();
                await finish();
            });
            await vi.waitFor(() => expect(storedIds()).toEqual([['A', false], ['B', false], [expect.any(String), false]]));
            vi.mocked(isTauriRuntime).mockReturnValue(false);
        });

        it('removes an attachment by id on the row a sync save published while the write waited', async () => {
            const { hook } = setup(opened, initialTaskState.updateProject as never);
            const finish = publishSibling();
            act(() => hook.result.current.removeProjectAttachment('A'));
            await act(finish);
            await vi.waitFor(() => expect(storedIds()).toEqual([['A', true], ['B', false]]));
        });

        it('appends prompt links onto the attachments a sync save published while the write waited', async () => {
            setup(opened, initialTaskState.updateProject as never);
            const finish = publishSibling();
            const written = appendProjectAttachments(opened.id, [{ ...file('L'), kind: 'link' }]);
            await finish();
            await written;
            expect(storedIds()).toEqual([['A', false], ['B', false], ['L', false]]);
        });
    });
});
