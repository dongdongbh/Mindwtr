import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: vi.fn(() => true),
}));

vi.mock('expo-router', () => ({
    router: routerMocks,
}));

let openContextsScreen: typeof import('./task-meta-navigation').openContextsScreen;
let openProjectScreen: typeof import('./task-meta-navigation').openProjectScreen;
let openTaskScreen: typeof import('./task-meta-navigation').openTaskScreen;
let stashPendingCaptureTaskOpen: typeof import('./task-meta-navigation').stashPendingCaptureTaskOpen;
let consumePendingCaptureTaskOpen: typeof import('./task-meta-navigation').consumePendingCaptureTaskOpen;

describe('task-meta-navigation', () => {
    beforeAll(async () => {
        ({
            openContextsScreen,
            openProjectScreen,
            openTaskScreen,
            stashPendingCaptureTaskOpen,
            consumePendingCaptureTaskOpen,
        } = await import('./task-meta-navigation'));
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('navigates to the project screen with a fresh open token', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(24680);

        openProjectScreen('project-1');

        expect(routerMocks.navigate).toHaveBeenCalledWith({
            pathname: '/projects-screen',
            params: { projectId: 'project-1', openToken: '24680' },
        });
    });

    it('navigates to the contexts screen', () => {
        openContextsScreen('@health');

        expect(routerMocks.navigate).toHaveBeenCalledWith({
            pathname: '/contexts',
            params: { token: '@health' },
        });
    });

    it('opens a project task on the project screen', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(12345);

        openTaskScreen('task-1', 'project-1');

        expect(routerMocks.push).toHaveBeenCalledWith({
            pathname: '/projects-screen',
            params: { projectId: 'project-1', taskId: 'task-1', openToken: '12345', taskTab: 'view' },
        });
    });

    it('can open a task directly on the task edit tab', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(67890);

        openTaskScreen('task-2', 'project-2', 'task');

        expect(routerMocks.push).toHaveBeenCalledWith({
            pathname: '/projects-screen',
            params: { projectId: 'project-2', taskId: 'task-2', openToken: '67890', taskTab: 'task' },
        });
    });

    it('opens an unprojected task on the focus screen', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(98765);

        openTaskScreen('task-9');

        expect(routerMocks.push).toHaveBeenCalledWith({
            pathname: '/focus',
            params: { taskId: 'task-9', openToken: '98765', taskTab: 'view' },
        });
    });


    it('pops the current route and navigates in place when asked to replace', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(13579);

        openTaskScreen('task-3', 'project-3', 'task', { replace: true });

        expect(routerMocks.back).toHaveBeenCalled();
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            pathname: '/projects-screen',
            params: { projectId: 'project-3', taskId: 'task-3', openToken: '13579', taskTab: 'task' },
        });
        expect(routerMocks.push).not.toHaveBeenCalled();
        expect(routerMocks.replace).not.toHaveBeenCalled();
    });

    it('pops and navigates to the focus screen when the task has no project', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(11111);

        openTaskScreen('task-4', undefined, 'task', { replace: true });

        expect(routerMocks.back).toHaveBeenCalled();
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            pathname: '/focus',
            params: { taskId: 'task-4', openToken: '11111', taskTab: 'task' },
        });
    });

    it('falls back to replacing in place when there is no back entry', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(22222);
        routerMocks.canGoBack.mockReturnValueOnce(false);

        openTaskScreen('task-5', 'project-5', 'task', { replace: true });

        expect(routerMocks.back).not.toHaveBeenCalled();
        expect(routerMocks.replace).toHaveBeenCalledWith({
            pathname: '/projects-screen',
            params: { projectId: 'project-5', taskId: 'task-5', openToken: '22222', taskTab: 'task' },
        });
    });


    it('hands a stashed capture task open to its project exactly once', () => {
        stashPendingCaptureTaskOpen({ taskId: 'task-7', projectId: 'project-7', taskTab: 'task' });

        expect(consumePendingCaptureTaskOpen('other-project')).toBeNull();
        expect(consumePendingCaptureTaskOpen(undefined)).toBeNull();
        expect(consumePendingCaptureTaskOpen('project-7'))
            .toEqual({ taskId: 'task-7', projectId: 'project-7', taskTab: 'task' });
        expect(consumePendingCaptureTaskOpen('project-7')).toBeNull();
    });

    it('ignores empty navigation inputs', () => {
        openProjectScreen('');
        openContextsScreen('');
        openTaskScreen('');

        expect(routerMocks.navigate).not.toHaveBeenCalled();
        expect(routerMocks.push).not.toHaveBeenCalled();
    });
});
