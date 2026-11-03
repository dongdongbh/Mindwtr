import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRootLayoutGmailCapture } from './use-root-layout-gmail-capture';

const mocks = vi.hoisted(() => ({
    appState: 'active', listeners: new Set<(state: string) => void>(),
    create: vi.fn(), register: vi.fn(), addTasks: vi.fn(), flush: vi.fn(), logInfo: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: {
    get currentState() { return mocks.appState; },
    addEventListener: (_event: string, listener: (state: string) => void) => {
        mocks.listeners.add(listener);
        return { remove: () => mocks.listeners.delete(listener) };
    },
} }));
vi.mock('@mindwtr/core', () => ({ useTaskStore: { getState: () => ({ addTasks: mocks.addTasks }) } }));
vi.mock('@/lib/gmail-capture', () => ({ createGmailCaptureController: mocks.create, registerGmailCaptureController: mocks.register }));
vi.mock('@/lib/pending-capture-persistence', () => ({ flushPendingTaskActionSave: mocks.flush }));
vi.mock('@/lib/app-log', () => ({ logInfo: mocks.logInfo }));

function Harness({ ready = true, disabled = false }: { ready?: boolean; disabled?: boolean }) {
    useRootLayoutGmailCapture({ canonicalDataReady: ready, disabled });
    return null;
}
const controller = () => ({ start: vi.fn(), pause: vi.fn(), resume: vi.fn(), dispose: vi.fn(), pollNow: vi.fn(), invalidate: vi.fn(), handleConfigChanged: vi.fn() });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.appState = 'active';
    mocks.create.mockImplementation(controller);
});

describe('RN Gmail lifecycle', () => {
    it('waits for canonical hydration and leaves sandbox capture disabled', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<Harness ready={false} />); });
        expect(mocks.create).not.toHaveBeenCalled();
        act(() => { tree.update(<Harness disabled />); });
        expect(mocks.create).not.toHaveBeenCalled();
        act(() => { tree.update(<Harness />); });
        expect(mocks.create).toHaveBeenCalledOnce();
        const options = mocks.create.mock.calls[0][0];
        await options.addTasks([]);
        expect(mocks.addTasks).toHaveBeenCalledWith([]);
        expect(options.flushPendingSave).toBe(mocks.flush);
        act(() => tree.unmount());
    });

    it('disposes on background and creates a fresh controller on foreground without cancelling OAuth', () => {
        const first = controller();
        const second = controller();
        mocks.create.mockReturnValueOnce(first).mockReturnValueOnce(second);
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<Harness />); });
        expect(first.start).toHaveBeenCalledOnce();
        act(() => mocks.listeners.forEach((listener) => listener('inactive')));
        expect(first.pause).toHaveBeenCalledOnce();
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(mocks.register).toHaveBeenLastCalledWith(null);
        act(() => mocks.listeners.forEach((listener) => listener('active')));
        expect(second.start).toHaveBeenCalledOnce();
        expect(mocks.register).toHaveBeenLastCalledWith(second);
        act(() => tree.unmount());
        expect(second.dispose).toHaveBeenCalledOnce();
        expect(mocks.listeners.size).toBe(0);
    });

    it('does not start from a background mount and stops on sandbox entry', () => {
        mocks.appState = 'background';
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<Harness />); });
        expect(mocks.create).not.toHaveBeenCalled();
        act(() => mocks.listeners.forEach((listener) => listener('active')));
        const active = mocks.create.mock.results[0].value;
        act(() => tree.update(<Harness disabled />));
        expect(active.dispose).toHaveBeenCalledOnce();
        expect(mocks.listeners.size).toBe(0);
        act(() => tree.unmount());
    });
});
