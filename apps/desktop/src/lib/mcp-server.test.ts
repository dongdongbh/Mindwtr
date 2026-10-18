import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ native: vi.fn(), tauri: true, sandbox: false }));
vi.mock('@mindwtr/core', () => ({ isSandboxMode: () => mocks.sandbox }));
vi.mock('./runtime', () => ({ isTauriRuntime: () => mocks.tauri }));
vi.mock('./tauri-invoke', () => ({ invokeNative: mocks.native }));
import { getMcpConnectionDetails, getMcpServerStatus, isMcpServerAvailable, setMcpServerConfig, type McpServerStatus } from './mcp-server';

const status: McpServerStatus = {
    enabled: true, running: true, allowWrite: false, allowArchive: false, allowDelete: false, port: 8722,
    url: 'http://127.0.0.1:8722/mcp', token: 'private-token', error: null,
};

describe('managed MCP adapter', () => {
    beforeEach(() => {
        mocks.tauri = true;
        mocks.sandbox = false;
        mocks.native.mockReset().mockResolvedValue(status);
    });

    it('uses the native contract and sends read-only or rotation explicitly', async () => {
        expect(await getMcpServerStatus()).toEqual(status);
        expect(mocks.native).toHaveBeenCalledWith('get_mcp_server_status');
        await setMcpServerConfig({ enabled: true, allowWrite: false });
        expect(mocks.native).toHaveBeenLastCalledWith('set_mcp_server_config', { enabled: true, allowWrite: false });
        await setMcpServerConfig({ enabled: true, allowWrite: true, regenerateToken: true });
        expect(mocks.native).toHaveBeenLastCalledWith('set_mcp_server_config', { enabled: true, allowWrite: true, regenerateToken: true });
        await setMcpServerConfig({ enabled: true, allowWrite: false, allowArchive: true, allowDelete: false, port: 19345 });
        expect(mocks.native).toHaveBeenLastCalledWith('set_mcp_server_config', {
            enabled: true, allowWrite: false, allowArchive: true, allowDelete: false, port: 19345,
        });
    });

    it.each(['browser', 'sandbox'])('never invokes external native commands in %s', async (runtime) => {
        mocks.tauri = runtime !== 'browser';
        mocks.sandbox = runtime === 'sandbox';
        expect(isMcpServerAvailable()).toBe(false);
        await expect(getMcpServerStatus()).rejects.toThrow('unavailable');
        await expect(setMcpServerConfig({ enabled: true, allowWrite: false })).rejects.toThrow('unavailable');
        expect(mocks.native).not.toHaveBeenCalled();
    });

    it('maps unexpected native error text to a safe error code', async () => {
        mocks.native.mockResolvedValue({ ...status, error: 'private-token or task text in a raw error' });
        expect((await getMcpServerStatus()).error).toBe('config_failed');
    });

    it('copies URL and bearer configuration only for a running loopback server', () => {
        const details = getMcpConnectionDetails(status);
        expect(JSON.parse(details!)).toEqual({
            mcpServers: { mindwtr: { type: 'http', url: status.url, headers: { Authorization: 'Bearer private-token' } } },
        });
        for (const patch of [
            { enabled: false }, { running: false }, { token: null }, { url: 'http://external.example/mcp' },
            { error: 'exited' as const }, { port: 19345 },
        ]) {
            expect(getMcpConnectionDetails({ ...status, ...patch })).toBeNull();
            expect(getMcpConnectionDetails({ ...status, ...patch }, 'codex')).toBeNull();
        }
    });

    it.each([1024, 19345, 65535])('copies JSON and Codex TOML for a validated custom port %s', (port) => {
        const custom = { ...status, port, url: `http://127.0.0.1:${port}/mcp` };
        expect(JSON.parse(getMcpConnectionDetails(custom)!).mcpServers.mindwtr.url).toBe(custom.url);
        expect(getMcpConnectionDetails(custom, 'codex')).toBe(
            `[mcp_servers.mindwtr]\nurl = "${custom.url}"\n\n[mcp_servers.mindwtr.http_headers]\nAuthorization = "Bearer private-token"\n`,
        );
    });

    it('escapes TOML quotes, backslashes and control characters without adding tables', () => {
        const token = 'quote" slash\\ tab\t newline\n return\r back\b form\f nul\u0000 del\u007f\n[malicious]';
        const details = getMcpConnectionDetails({ ...status, token }, 'codex')!;
        const header = details.split('\n').find((line) => line.startsWith('Authorization = '))!.slice('Authorization = '.length);
        expect(JSON.parse(header)).toBe(`Bearer ${token}`);
        expect(header).toContain('\\u007f');
        expect(details.split('\n').filter((line) => line.startsWith('['))).toEqual([
            '[mcp_servers.mindwtr]', '[mcp_servers.mindwtr.http_headers]',
        ]);
    });

    it.each([1023, 65536, 19345.5, NaN, Infinity])('rejects invalid returned ports %s', (port) => {
        const invalid = { ...status, port, url: `http://127.0.0.1:${port}/mcp` };
        expect(getMcpConnectionDetails(invalid)).toBeNull();
        expect(getMcpConnectionDetails(invalid, 'codex')).toBeNull();
    });

    it('retains the safe invalid-port error', async () => {
        mocks.native.mockResolvedValue({ ...status, error: 'invalid_port' });
        expect((await getMcpServerStatus()).error).toBe('invalid_port');
    });
});
