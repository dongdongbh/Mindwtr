import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    push: vi.fn(),
}));

vi.mock('expo-router', () => ({
    router: routerMocks,
}));

let openContextsScreen: typeof import('./task-meta-navigation').openContextsScreen;
let openProjectScreen: typeof import('./task-meta-navigation').openProjectScreen;
let openTaskScreen: typeof import('./task-meta-navigation').openTaskScreen;

describe('task-meta-navigation', () => {
    beforeAll(async () => {
        ({ openContextsScreen, openProjectScreen, openTaskScreen } = await import('./task-meta-navigation'));
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('navigates to the project screen', () => {
        openProjectScreen('project-1');

        expect(routerMocks.navigate).toHaveBeenCalledWith({
            pathname: '/projects-screen',
            params: { projectId: 'project-1' },
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
            params: { projectId: 'project-1', taskId: 'task-1', openToken: '12345' },
        });
    });

    it('opens an unprojected task on the focus screen', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(98765);

        openTaskScreen('task-9');

        expect(routerMocks.push).toHaveBeenCalledWith({
            pathname: '/focus',
            params: { taskId: 'task-9', openToken: '98765' },
        });
    });

    it('ignores empty navigation inputs', () => {
        openProjectScreen('');
        openContextsScreen('');
        openTaskScreen('');

        expect(routerMocks.navigate).not.toHaveBeenCalled();
        expect(routerMocks.push).not.toHaveBeenCalled();
    });
});
