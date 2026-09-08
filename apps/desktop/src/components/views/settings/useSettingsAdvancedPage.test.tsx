import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSettingsAdvancedPage } from './useSettingsAdvancedPage';

const native = vi.hoisted(() => ({
    rendering: vi.fn(async () => ({ disableHardwareAcceleration: false })),
    status: vi.fn(async () => ({ enabled: false, running: false, port: 3000, url: null, error: null })),
}));
vi.mock('../../../lib/desktop-rendering', () => ({
    getDesktopRenderingConfig: native.rendering,
    setDesktopRenderingConfig: vi.fn(),
}));
vi.mock('../../../lib/local-api-server', () => ({
    DEFAULT_LOCAL_API_PORT: 3000,
    getLocalApiServerStatus: native.status,
    normalizeLocalApiPortInput: vi.fn(),
    setLocalApiServerConfig: vi.fn(),
}));

describe('useSettingsAdvancedPage resource loading', () => {
    it('defers native reads and does not reload over a port draft on rerender', async () => {
        const { result, rerender } = renderHook(({ loadEnabled }) => useSettingsAdvancedPage({
            loadEnabled, isTauri: true, showSaved: vi.fn(),
            t: { localApiPortInvalid: 'Invalid port', networkProxyInvalid: 'Invalid proxy' },
        }), { initialProps: { loadEnabled: false } });
        expect(native.rendering).not.toHaveBeenCalled();
        expect(native.status).not.toHaveBeenCalled();
        rerender({ loadEnabled: true });
        await waitFor(() => expect(result.current.localApiPortInput).toBe('3000'));
        await act(async () => {});
        act(() => result.current.onLocalApiPortInputChange('3456'));
        rerender({ loadEnabled: true });
        expect(result.current.localApiPortInput).toBe('3456');
        expect(native.rendering).toHaveBeenCalledTimes(1);
        expect(native.status).toHaveBeenCalledTimes(1);
    });
});
