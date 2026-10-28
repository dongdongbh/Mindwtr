import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '../../contexts/language-context';
import type { WorkspaceList } from '../../lib/workspaces';

const { listMock, switchMock, deleteMock } = vi.hoisted(() => ({
    listMock: vi.fn(),
    switchMock: vi.fn(),
    deleteMock: vi.fn(),
}));

vi.mock('../../lib/workspaces', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/workspaces')>()),
    listWorkspaces: listMock,
    switchWorkspace: switchMock,
    deleteWorkspace: deleteMock,
}));

import { SidebarWorkspaceSwitcher } from './SidebarWorkspaceSwitcher';
import { SettingsWorkspacesSection } from '../views/settings/SettingsWorkspacesSection';

const WORK = '0123456789abcdef';
const defaultOnly: WorkspaceList = {
    activeId: 'default',
    available: true,
    unreadable: false,
    workspaces: [{ id: 'default', name: '', color: null, isDefault: true, dataDir: '/data/mindwtr' }],
};
const withWork: WorkspaceList = {
    ...defaultOnly,
    workspaces: [
        ...defaultOnly.workspaces,
        { id: WORK, name: 'Work', color: '#3b82f6', isDefault: false, dataDir: `/data/mindwtr/workspaces/${WORK}` },
    ],
};

const renderWithLanguage = (ui: React.ReactElement) => render(<LanguageProvider>{ui}</LanguageProvider>);

beforeEach(() => {
    listMock.mockReset();
    switchMock.mockReset();
    deleteMock.mockReset();
});

describe('SidebarWorkspaceSwitcher', () => {
    it('stays hidden while only the default workspace exists', async () => {
        listMock.mockResolvedValue(defaultOnly);
        const { container } = renderWithLanguage(<SidebarWorkspaceSwitcher />);
        await waitFor(() => expect(listMock).toHaveBeenCalled());
        expect(container.querySelector('[data-workspace-switcher]')).toBeNull();
    });

    it('shows the open workspace and switches only after the restart is confirmed', async () => {
        listMock.mockResolvedValue(withWork);
        switchMock.mockResolvedValue(undefined);
        renderWithLanguage(<SidebarWorkspaceSwitcher />);

        const trigger = await screen.findByRole('button', { name: 'Workspace: Default' });
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Work' }));

        expect(await screen.findByText('Mindwtr restarts to open Work.')).toBeTruthy();
        expect(switchMock).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Switch now' }));
        await waitFor(() => expect(switchMock).toHaveBeenCalledTimes(1));
        expect(switchMock.mock.calls[0][0]).toBe(WORK);
        // The pending-save flush is handed over, so it runs before the native switch.
        expect(typeof switchMock.mock.calls[0][1]).toBe('function');
    });
});

describe('SettingsWorkspacesSection', () => {
    it('offers Delete only for a closed, non-default workspace and states what it removes', async () => {
        listMock.mockResolvedValue(withWork);
        deleteMock.mockResolvedValue(undefined);
        const { container } = renderWithLanguage(<SettingsWorkspacesSection />);

        await screen.findByText('Work');
        const deleteButtons = container.querySelectorAll('[data-workspace-delete]');
        expect(deleteButtons).toHaveLength(1);
        expect(container.querySelector(`[data-workspace-row="${WORK}"] [data-workspace-delete]`)).not.toBeNull();
        expect(screen.getByText(`/data/mindwtr/workspaces/${WORK}`)).toBeTruthy();

        fireEvent.click(deleteButtons[0]);
        expect(await screen.findByText('Delete Work?')).toBeTruthy();
        expect(screen.getByText(
            "This removes the workspace's local tasks, attachments and settings from this computer. Nothing changes on its sync server.",
        )).toBeTruthy();
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(WORK));
    });
});
