import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    state: { error: null as string | null, isLoading: false, fetchData: vi.fn(async () => undefined) },
    adapter: 'noop', sandbox: false, transition: false,
    quiesce: vi.fn(async (): Promise<void> => undefined), publish: vi.fn(async () => true), flush: vi.fn(async () => undefined), info: vi.fn(), warn: vi.fn(),
    app: { currentState: 'background' }, register: vi.fn(),
}));
vi.mock('react-native', () => ({ AppRegistry: { registerHeadlessTask: mocks.register }, AppState: mocks.app, Platform: { OS: 'android' } }));
vi.mock('@mindwtr/core', () => ({
    flushPendingSave: mocks.flush, getStorageAdapter: () => mocks.adapter, noopStorage: 'noop',
    setStorageAdapter: (value: string) => { mocks.adapter = value; },
    isSandboxMode: () => mocks.sandbox, isWorkspaceTransitionActive: () => mocks.transition,
    useTaskStore: { getState: () => mocks.state },
}));
vi.mock('./storage-adapter', () => ({ mobileStorage: 'mobile', quiesceMobileStorage: mocks.quiesce }));
vi.mock('./widget-service', () => ({ updateMobileWidgetFromStore: mocks.publish }));
vi.mock('./app-log', () => ({ logInfo: mocks.info, logWarn: mocks.warn }));
import { runWidgetRefreshTask, WIDGET_REFRESH_TASK_NAME } from './widget-refresh-task';
describe('widget selection refresh', () => {
    beforeEach(() => {
        vi.clearAllMocks(); mocks.adapter = 'noop'; mocks.sandbox = false; mocks.transition = false;
        mocks.state.error = null; mocks.state.isLoading = false; mocks.app.currentState = 'background';
        mocks.publish.mockResolvedValue(true);
    });
    it('hydrates cold local data before publication without needing sync', async () => {
        expect(WIDGET_REFRESH_TASK_NAME).toBe('MindwtrWidgetRefresh');
        await runWidgetRefreshTask();
        expect(mocks.adapter).toBe('mobile');
        expect(mocks.state.fetchData).toHaveBeenCalledWith({ silent: true });
        expect(mocks.state.fetchData.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]);
        expect(mocks.info).toHaveBeenCalledWith('Widget selection refreshed', expect.objectContaining({ force: true }));
    });
    it('does not reload over a visible editor and refreshes successive choices', async () => {
        mocks.adapter = 'mobile'; mocks.app.currentState = 'active';
        await Promise.all([runWidgetRefreshTask(), runWidgetRefreshTask()]);
        expect(mocks.state.fetchData).not.toHaveBeenCalled();
        expect(mocks.publish).toHaveBeenCalledTimes(2);
    });
    it.each(['success', 'load failure', 'publish failure'])('waits for storage teardown after %s', async (outcome) => {
        let release!: () => void;
        mocks.quiesce.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
        if (outcome === 'load failure') mocks.state.fetchData.mockRejectedValueOnce(new Error('load'));
        if (outcome === 'publish failure') mocks.publish.mockRejectedValueOnce(new Error('publish'));
        let settled = false;
        const run = runWidgetRefreshTask().then(() => { settled = true; });
        await vi.waitFor(() => expect(mocks.quiesce).toHaveBeenCalled());
        expect(settled).toBe(false);
        expect(mocks.flush.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.quiesce.mock.invocationCallOrder[0]);
        release(); await run;
        expect(settled).toBe(true);
    });
    it('retains the last payload after failed loading or during sandbox transitions', async () => {
        mocks.state.error = 'unavailable'; await runWidgetRefreshTask();
        expect(mocks.publish).not.toHaveBeenCalled();
        mocks.state.error = null; mocks.transition = true; await runWidgetRefreshTask();
        expect(mocks.publish).not.toHaveBeenCalled();
    });
});
