import { afterEach, expect, it, vi } from 'vitest';
import { registerWebServiceWorker } from './web-service-worker';

afterEach(() => vi.unstubAllGlobals());

it('reports only an acknowledgement from the current controller, once per page', () => {
    const listeners = new Map<string, (event: Partial<MessageEvent>) => void>();
    const previous = { postMessage: vi.fn() };
    const online = { postMessage: vi.fn() };
    const workers = {
        controller: previous,
        addEventListener: vi.fn((type: string, listener: (event: Partial<MessageEvent>) => void) => listeners.set(type, listener)),
        register: vi.fn().mockResolvedValue({}),
    };
    vi.stubGlobal('navigator', { serviceWorker: workers });
    const reported = vi.fn();
    registerWebServiceWorker(reported);
    expect(workers.register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' });
    expect(previous.postMessage).toHaveBeenCalledWith('mindwtr-service-worker-mode');
    expect(reported).not.toHaveBeenCalled();
    workers.controller = online;
    listeners.get('controllerchange')!({});
    expect(online.postMessage).toHaveBeenCalledWith('mindwtr-service-worker-mode');
    const reply = (source: unknown, data = 'mindwtr-service-worker-online-only') => {
        listeners.get('message')!({ source: source as ServiceWorker, data });
    };
    reply(previous);
    reply(online, 'other-message');
    expect(reported).not.toHaveBeenCalled();
    reply(online);
    reply(online);
    expect(reported).toHaveBeenCalledTimes(1);
});
