import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('./tauri-invoke', () => ({ invokeNative: invokeMock }));

import { getActiveWorkspaceId, switchWorkspace, WorkspaceSaveError } from './workspaces';

afterEach(() => {
    invokeMock.mockReset();
    delete window.__MINDWTR_WORKSPACE_ID__;
});

describe('switchWorkspace', () => {
    it('saves pending local changes before asking native code to switch', async () => {
        const order: string[] = [];
        invokeMock.mockImplementation(async (command: string) => {
            order.push(command);
        });
        const flush = vi.fn(async () => {
            order.push('flush');
        });

        await switchWorkspace('0123456789abcdef', flush);

        expect(order).toEqual(['flush', 'switch_workspace']);
        expect(invokeMock).toHaveBeenCalledWith('switch_workspace', { id: '0123456789abcdef' });
    });

    it('does not switch when the save fails or hangs', async () => {
        await expect(switchWorkspace('0123456789abcdef', () => Promise.reject(new Error('disk full'))))
            .rejects.toBeInstanceOf(WorkspaceSaveError);
        await expect(switchWorkspace('0123456789abcdef', () => new Promise<void>(() => undefined), 5))
            .rejects.toBeInstanceOf(WorkspaceSaveError);
        expect(invokeMock).not.toHaveBeenCalled();
    });
});

describe('getActiveWorkspaceId', () => {
    it('reads the id the native init script set, and defaults otherwise', () => {
        expect(getActiveWorkspaceId()).toBe('default');
        window.__MINDWTR_WORKSPACE_ID__ = '0123456789abcdef';
        expect(getActiveWorkspaceId()).toBe('0123456789abcdef');
    });
});
