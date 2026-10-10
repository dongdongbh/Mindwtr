import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../../../../packages/core/src/i18n/locales/en';
import type { McpServerStatus } from '../../../lib/mcp-server';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), copy: vi.fn(), write: vi.fn(), log: vi.fn(), available: true }));
vi.mock('../../../contexts/language-context', () => ({ useLanguage: () => ({ t: (key: string) => en[key] ?? key }) }));
vi.mock('../../../lib/mcp-server', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../../lib/mcp-server')>(),
    getMcpServerStatus: mocks.get,
    setMcpServerConfig: mocks.set,
    isMcpServerAvailable: () => mocks.available,
}));
vi.mock('../../../lib/app-log', () => ({ logInfo: mocks.log, logWarn: mocks.log }));
import { SettingsMcpSection } from './SettingsMcpSection';

const off: McpServerStatus = {
    enabled: false, running: false, allowWrite: false, port: 8722, url: null, token: null, error: null,
};
const running: McpServerStatus = {
    ...off, enabled: true, running: true, url: 'http://127.0.0.1:8722/mcp', token: 'never-render-this-token',
};

function openSection() {
    const view = render(<SettingsMcpSection isTauri />);
    fireEvent.click(view.getByRole('button', { name: /Local MCP server/ }));
    return view;
}

describe('SettingsMcpSection', () => {
    beforeEach(() => {
        mocks.available = true;
        mocks.get.mockReset().mockResolvedValue(off);
        mocks.set.mockReset().mockResolvedValue(running);
        mocks.copy.mockReset().mockResolvedValue(undefined);
        mocks.write.mockReset();
        mocks.log.mockReset().mockResolvedValue(null);
        vi.stubGlobal('ClipboardItem', undefined);
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: mocks.copy } });
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('starts collapsed and requires opt-in with read permission and remote AI disclosure', async () => {
        const view = render(<SettingsMcpSection isTauri />);
        expect(view.getByRole('button', { name: /Local MCP server/ })).toHaveAttribute('aria-expanded', 'false');
        expect(view.queryByRole('switch')).not.toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: /Local MCP server/ }));
        await waitFor(() => expect(view.getByRole('switch')).toBeEnabled());
        expect(view.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
        expect(view.getByText(en['settings.mcpReadPermission'])).toBeInTheDocument();
        expect(view.getByText(en['settings.mcpPrivacy'])).toBeInTheDocument();
        expect(mocks.set).not.toHaveBeenCalled();
        fireEvent.click(view.getByRole('switch'));
        await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({ enabled: true, allowWrite: false }));
        expect(view.getByRole('switch', { name: en['settings.mcpAllowWrite'] })).toHaveAttribute('aria-checked', 'false');
        expect(view.getByRole('switch', { name: 'Allow changes' })).toBeInTheDocument();
        expect(view.getByText('Allow connected AI clients to add, edit, complete, and delete tasks, and to add, edit, or delete projects. Off means read-only access.')).toBeInTheDocument();
    });

    it.each([false, true])('shows unavailable state without native reads when availability is %s', (isBrowser) => {
        mocks.available = false;
        const view = render(<SettingsMcpSection isTauri={!isBrowser} />);
        fireEvent.click(view.getByRole('button', { name: /Local MCP server/ }));
        expect(view.getByText(en['settings.mcpUnavailable'])).toBeInTheDocument();
        expect(view.queryByRole('switch')).not.toBeInTheDocument();
        expect(mocks.get).not.toHaveBeenCalled();
    });

    it('shows safe startup errors and retries the enabled config', async () => {
        mocks.get.mockResolvedValue({ ...off, enabled: true, error: 'port_in_use' });
        const view = openSection();
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(en['settings.mcpError.port_in_use']));
        expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeDisabled();
        fireEvent.click(view.getByRole('button', { name: en['common.retry'] }));
        await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({ enabled: true, allowWrite: false }));
        expect(view.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('copies fresh bearer details only on click and never renders the token', async () => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        expect(view.container).not.toHaveTextContent(running.token!);
        expect(mocks.copy).not.toHaveBeenCalled();
        mocks.get.mockResolvedValue({ ...running, token: 'fresh-token' });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1));
        expect(JSON.parse(mocks.copy.mock.calls[0][0]).mcpServers.mindwtr.headers.Authorization).toBe('Bearer fresh-token');
        await waitFor(() => expect(view.getByText(en['settings.mcpCopied'])).toBeInTheDocument());
        expect(view.container).not.toHaveTextContent('fresh-token');
    });

    it('starts the clipboard write during the click and supplies fresh native details later', async () => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        let resolve!: (status: McpServerStatus) => void;
        mocks.get.mockImplementationOnce(() => new Promise<McpServerStatus>((done) => { resolve = done; }));
        let data!: Promise<Blob>;
        vi.stubGlobal('ClipboardItem', class {
            constructor(items: Record<string, Promise<Blob>>) { data = items['text/plain']; }
        });
        mocks.write.mockImplementation(() => data.then(() => undefined));
        vi.stubGlobal('navigator', { clipboard: { write: mocks.write, writeText: mocks.copy } });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        expect(mocks.write).toHaveBeenCalledTimes(1);
        expect(view.queryByText(en['settings.mcpCopied'])).not.toBeInTheDocument();
        await act(async () => resolve({ ...running, token: 'fresh-deferred-token' }));
        const blob = await data;
        expect(blob.type).toBe('text/plain');
        const text = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsText(blob);
        });
        expect(JSON.parse(text).mcpServers.mindwtr.headers.Authorization).toBe('Bearer fresh-deferred-token');
        expect(mocks.copy).not.toHaveBeenCalled();
        expect(view.getByText(en['settings.mcpCopied'])).toBeInTheDocument();
        expect(view.container).not.toHaveTextContent('fresh-deferred-token');
    });

    it.each(['constructor-throw', 'write-throw', 'write-reject'])('observes %s before a late native failure and retains the action lock', async (failure) => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        let reject!: (error: Error) => void;
        mocks.get.mockImplementationOnce(() => new Promise<McpServerStatus>((_done, fail) => { reject = fail; }));
        vi.stubGlobal('ClipboardItem', class {
            constructor() { if (failure === 'constructor-throw') throw new Error('private constructor failure'); }
        });
        mocks.write.mockImplementation(() => {
            if (failure === 'write-throw') throw new Error('private clipboard failure');
            return Promise.reject(new Error('private clipboard failure'));
        });
        vi.stubGlobal('navigator', { clipboard: { write: mocks.write, writeText: mocks.copy } });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        await act(async () => { await Promise.resolve(); });
        expect(view.getByRole('button', { name: en['settings.mcpRotate'] })).toBeDisabled();
        expect(mocks.log).not.toHaveBeenCalled();
        await act(async () => reject(new Error('private native failure')));
        expect(view.getByRole('alert')).toHaveTextContent(en['settings.mcpError.config_failed']);
        expect(view.queryByText(en['settings.mcpCopied'])).not.toBeInTheDocument();
        expect(mocks.copy).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledExactlyOnceWith('MCP connection action completed', {
            scope: 'mcp', extra: {
                releaseCheck: 'v1.3.5/mcp-connection-actions', operation: 'copy', outcome: 'native-failed', backend: 'clipboard-item',
            },
        });
        expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('private');
    });

    it('reports an early clipboard rejection only after the fresh native request settles', async () => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        let resolve!: (status: McpServerStatus) => void;
        mocks.get.mockImplementationOnce(() => new Promise<McpServerStatus>((done) => { resolve = done; }));
        vi.stubGlobal('ClipboardItem', class {});
        mocks.write.mockRejectedValue(new Error('private clipboard failure'));
        vi.stubGlobal('navigator', { clipboard: { write: mocks.write, writeText: mocks.copy } });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        await act(async () => { await Promise.resolve(); });
        expect(view.getByRole('button', { name: en['settings.mcpRotate'] })).toBeDisabled();
        await act(async () => resolve(running));
        expect(view.getByText(en['settings.mcpCopyFailed'])).toBeInTheDocument();
        expect(view.queryByText(en['settings.mcpCopied'])).not.toBeInTheDocument();
        expect(mocks.copy).not.toHaveBeenCalled();
        expect(mocks.log.mock.calls[0][1].extra.outcome).toBe('clipboard-failed');
    });

    it('waits for clipboard completion before success and unlocking other actions', async () => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        let finish!: () => void;
        vi.stubGlobal('ClipboardItem', class {});
        mocks.write.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
        vi.stubGlobal('navigator', { clipboard: { write: mocks.write, writeText: mocks.copy } });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        await act(async () => { await Promise.resolve(); });
        expect(view.getByRole('button', { name: en['settings.mcpRotate'] })).toBeDisabled();
        expect(view.queryByText(en['settings.mcpCopied'])).not.toBeInTheDocument();
        expect(mocks.log).not.toHaveBeenCalled();
        await act(async () => finish());
        expect(view.getByText(en['settings.mcpCopied'])).toBeInTheDocument();
        expect(view.getByRole('button', { name: en['settings.mcpRotate'] })).toBeEnabled();
        expect(mocks.log.mock.calls[0][1].extra.outcome).toBe('copied');
    });

    it('rejects deferred clipboard data after unmount without publishing credentials or success', async () => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        let resolve!: (status: McpServerStatus) => void;
        mocks.get.mockImplementationOnce(() => new Promise<McpServerStatus>((done) => { resolve = done; }));
        let data!: Promise<Blob>;
        vi.stubGlobal('ClipboardItem', class {
            constructor(items: Record<string, Promise<Blob>>) { data = items['text/plain']; }
        });
        const publish = vi.fn();
        mocks.write.mockImplementation(() => data.then(publish));
        vi.stubGlobal('navigator', { clipboard: { write: mocks.write, writeText: mocks.copy } });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        view.unmount();
        await act(async () => resolve({ ...running, token: 'late-private-token' }));
        expect(publish).not.toHaveBeenCalled();
        expect(mocks.copy).not.toHaveBeenCalled();
        expect(mocks.log).not.toHaveBeenCalled();
    });

    it.each([{ running: false, token: null }, { error: 'exited' as const }])('rejects unusable native details on the modern clipboard path: %s', async (patch) => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        let data!: Promise<Blob>;
        vi.stubGlobal('ClipboardItem', class {
            constructor(items: Record<string, Promise<Blob>>) { data = items['text/plain']; }
        });
        const publish = vi.fn();
        mocks.write.mockImplementation(() => data.then(publish));
        vi.stubGlobal('navigator', { clipboard: { write: mocks.write, writeText: mocks.copy } });
        mocks.get.mockResolvedValue({ ...running, ...patch });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        await waitFor(() => expect(view.getByText(en['settings.mcpCopyFailed'])).toBeInTheDocument());
        expect(publish).not.toHaveBeenCalled();
        expect(mocks.copy).not.toHaveBeenCalled();
        expect(view.queryByText(en['settings.mcpCopied'])).not.toBeInTheDocument();
        expect(mocks.log.mock.calls[0][1].extra.outcome).toBe('invalid-status');
    });

    it.each([
        { running: false, url: null },
        { token: null },
        { error: 'start_failed' as const },
    ])('does not acknowledge an invalid rotation: %s', async (patch) => {
        mocks.get.mockResolvedValue(running);
        mocks.set.mockResolvedValue({ ...running, ...patch });
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpRotate'] })).toBeEnabled());
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpRotate'] }));
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(en[`settings.mcpError.${patch.error ?? 'config_failed'}`]));
        expect(view.queryByText(en['settings.mcpTokenRotated'])).not.toBeInTheDocument();
        expect(mocks.copy).not.toHaveBeenCalled();
    });

    it('does not copy stale details after the helper stops', async () => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        mocks.get.mockResolvedValue({ ...running, running: false, url: null, token: null, error: 'exited' });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(en['settings.mcpError.exited']));
        expect(mocks.copy).not.toHaveBeenCalled();
    });

    it('discloses revocation and serializes rotation with all other actions', async () => {
        mocks.get.mockResolvedValue(running);
        let resolve!: (status: McpServerStatus) => void;
        mocks.set.mockImplementation(() => new Promise<McpServerStatus>((done) => { resolve = done; }));
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpRotate'] })).toBeEnabled());
        expect(view.getByText(en['settings.mcpRotateHint'])).toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpRotate'] }));
        expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ enabled: true, allowWrite: false, regenerateToken: true });
        expect(view.getByRole('switch', { name: en['settings.mcpEnable'] })).toBeDisabled();
        expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeDisabled();
        await act(async () => resolve({ ...running, token: 'rotated-token' }));
        expect(view.getByText(en['settings.mcpTokenRotated'])).toBeInTheDocument();
        expect(mocks.copy).not.toHaveBeenCalled();
        expect(view.container).not.toHaveTextContent('rotated-token');
        mocks.get.mockResolvedValue({ ...running, token: 'rotated-token' });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1));
        expect(JSON.parse(mocks.copy.mock.calls[0][0]).mcpServers.mindwtr.headers.Authorization).toBe('Bearer rotated-token');
        expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('rotated-token');
    });

    it('safely handles command and clipboard failures', async () => {
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await waitFor(() => expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled());
        mocks.copy.mockRejectedValue(new Error('raw credential-bearing clipboard failure'));
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpCopy'] }));
        await waitFor(() => expect(view.getByText(en['settings.mcpCopyFailed'])).toBeInTheDocument());
        mocks.set.mockRejectedValue(new Error('raw credential-bearing native failure'));
        fireEvent.click(view.getByRole('switch', { name: en['settings.mcpAllowWrite'] }));
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(en['settings.mcpError.config_failed']));
        expect(view.container).not.toHaveTextContent('raw credential-bearing');
        expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeDisabled();
    });

    it('polls enabled status to show a crash and cancels polling on disable and unmount', async () => {
        vi.useFakeTimers();
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await act(async () => { await Promise.resolve(); });
        mocks.get.mockResolvedValue({ ...running, running: false, error: 'exited', url: null });
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        expect(view.getByRole('alert')).toHaveTextContent(en['settings.mcpError.exited']);
        mocks.set.mockResolvedValue(off);
        fireEvent.click(view.getByRole('switch', { name: en['settings.mcpEnable'] }));
        await act(async () => { await Promise.resolve(); });
        const reads = mocks.get.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
        expect(mocks.get).toHaveBeenCalledTimes(reads);
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does no periodic work while disabled', async () => {
        vi.useFakeTimers();
        openSection();
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
        expect(mocks.get).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores an old poll response after rotation and cleans up while enabled', async () => {
        vi.useFakeTimers();
        mocks.get.mockResolvedValue(running);
        const view = openSection();
        await act(async () => { await Promise.resolve(); });
        let resolvePoll!: (status: McpServerStatus) => void;
        mocks.get.mockImplementationOnce(() => new Promise<McpServerStatus>((done) => { resolvePoll = done; }));
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        mocks.set.mockResolvedValue({ ...running, token: 'rotated-token' });
        fireEvent.click(view.getByRole('button', { name: en['settings.mcpRotate'] }));
        await act(async () => { await Promise.resolve(); });
        await act(async () => resolvePoll({ ...running, running: false, error: 'exited' }));
        expect(view.queryByRole('alert')).not.toBeInTheDocument();
        expect(view.getByText(en['settings.mcpRunning'])).toBeInTheDocument();
        expect(view.getByRole('button', { name: en['settings.mcpCopy'] })).toBeEnabled();
        const reads = mocks.get.mock.calls.length;
        view.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
        expect(mocks.get).toHaveBeenCalledTimes(reads);
        expect(vi.getTimerCount()).toBe(0);
    });
});
