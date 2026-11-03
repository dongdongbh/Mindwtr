import { describe, expect, it } from 'vitest';
import { projectsViewCollisionDetection, projectsViewKeyboardCoordinates, resolveTaskSidebarDropTarget } from './projects-view-dnd';
import { getProjectAreaContainerId } from './project-area-dnd';

type Rect = { top: number; left: number; width: number; height: number; bottom: number; right: number };

const rect = (top: number, height: number): Rect => ({
    top,
    left: 0,
    width: 200,
    height,
    bottom: top + height,
    right: 200,
});

const buildContainer = (id: string, containerRect: Rect, data: Record<string, unknown>) => ({
    id,
    key: id,
    data: { current: data },
    disabled: false,
    node: { current: null as HTMLElement | null },
    rect: { current: containerRect },
});

type Container = ReturnType<typeof buildContainer>;

const buildArgs = ({
    activeId,
    activeData,
    containers,
    pointer,
}: {
    activeId: string;
    activeData: Record<string, unknown>;
    containers: Container[];
    pointer: { x: number; y: number } | null;
}) => ({
    active: {
        id: activeId,
        data: { current: activeData },
        rect: { current: { initial: rect(0, 30), translated: rect(0, 30) } },
    },
    collisionRect: rect(0, 30),
    droppableRects: new Map(containers.map((container) => [container.id, container.rect.current])),
    droppableContainers: containers,
    pointerCoordinates: pointer,
});

describe('projectsViewCollisionDetection', () => {
    it('keeps section drags on headers in the same project', () => {
        const header = buildContainer('header-1', rect(100, 30), { type: 'project-section', projectId: 'p1' });
        const foreignHeader = buildContainer('header-2', rect(0, 30), { type: 'project-section', projectId: 'p2' });
        const task = buildContainer('task-1', rect(0, 30), { type: 'task', sortable: true });
        const taskZone = buildContainer('section:s1', rect(0, 300), { zone: 'section' });
        const sidebar = buildContainer('p1', rect(0, 30), { type: 'project', section: 'active' });
        const args = buildArgs({
            activeId: 'header-0', activeData: { type: 'project-section', projectId: 'p1', sectionId: 's0' },
            containers: [header, foreignHeader, task, taskZone, sidebar], pointer: { x: 100, y: 10 },
        });
        expect(projectsViewCollisionDetection(args as never).map((collision) => collision.id)).toEqual(['header-1']);
    });

    it('never treats a section header as a task drop target', () => {
        const args = buildArgs({
            activeId: 't1', activeData: { type: 'task', sortable: true },
            containers: [buildContainer('header-1', rect(0, 30), { type: 'project-section', projectId: 'p1' })],
            pointer: { x: 100, y: 10 },
        });
        expect(projectsViewCollisionDetection(args as never)).toEqual([]);
    });

    it('keeps project drags inside their own sidebar section', () => {
        const activeZone = buildContainer(
            getProjectAreaContainerId('active', 'a1'),
            rect(0, 100),
            { zone: 'projectArea', section: 'active', areaId: 'a1' },
        );
        const deferredZone = buildContainer(
            getProjectAreaContainerId('deferred', 'a1'),
            rect(0, 100),
            { zone: 'projectArea', section: 'deferred', areaId: 'a1' },
        );
        const args = buildArgs({
            activeId: 'p1',
            activeData: { type: 'project', section: 'deferred' },
            containers: [activeZone, deferredZone],
            pointer: { x: 100, y: 50 },
        });

        const collisions = projectsViewCollisionDetection(args as never);
        expect(collisions.map((collision) => String(collision.id))).toEqual([
            getProjectAreaContainerId('deferred', 'a1'),
        ]);
    });

    it('prefers sidebar project rows over the surrounding area zone for task drags', () => {
        const zone = buildContainer(
            getProjectAreaContainerId('active', 'a1'),
            rect(0, 300),
            { zone: 'projectArea', section: 'active', areaId: 'a1' },
        );
        const projectRow = buildContainer('proj-1', rect(10, 30), { type: 'project', section: 'active' });
        const args = buildArgs({
            activeId: 't1',
            activeData: { type: 'task', sortable: true },
            containers: [zone, projectRow],
            pointer: { x: 100, y: 25 },
        });

        const collisions = projectsViewCollisionDetection(args as never);
        expect(collisions.map((collision) => String(collision.id))).toEqual(['proj-1']);
    });

    it('never offers archived sidebar targets to task drags', () => {
        const archivedZone = buildContainer(
            getProjectAreaContainerId('archived', 'a1'),
            rect(0, 300),
            { zone: 'projectArea', section: 'archived', areaId: 'a1' },
        );
        const archivedRow = buildContainer('proj-arch', rect(10, 30), { type: 'project', section: 'archived' });
        const args = buildArgs({
            activeId: 't1',
            activeData: { type: 'task', sortable: true },
            containers: [archivedZone, archivedRow],
            pointer: { x: 100, y: 25 },
        });

        expect(projectsViewCollisionDetection(args as never)).toEqual([]);
    });

    it('excludes the task list as a target when the drag is not sortable', () => {
        const taskRow = buildContainer('t2', rect(10, 30), { type: 'task', sortable: false });
        const sectionZone = buildContainer('section:none', rect(0, 300), { zone: 'section' });
        const args = buildArgs({
            activeId: 't1',
            activeData: { type: 'task', sortable: false },
            containers: [taskRow, sectionZone],
            pointer: { x: 100, y: 25 },
        });

        expect(projectsViewCollisionDetection(args as never)).toEqual([]);
    });

    it('falls back to closest-center over workspace containers only for sortable task drags', () => {
        const taskRow = buildContainer('t2', rect(100, 30), { type: 'task', sortable: true });
        const projectRow = buildContainer('proj-1', rect(400, 30), { type: 'project', section: 'active' });
        const args = buildArgs({
            activeId: 't1',
            activeData: { type: 'task', sortable: true },
            containers: [taskRow, projectRow],
            pointer: null,
        });

        const collisions = projectsViewCollisionDetection(args as never);
        expect(collisions.map((collision) => String(collision.id))).toEqual(['t2']);
    });
});

describe('resolveTaskSidebarDropTarget', () => {
    it('resolves active and deferred project rows', () => {
        expect(resolveTaskSidebarDropTarget('proj-1', { type: 'project', section: 'active' }))
            .toEqual({ kind: 'project', projectId: 'proj-1' });
        expect(resolveTaskSidebarDropTarget('proj-2', { type: 'project', section: 'deferred' }))
            .toEqual({ kind: 'project', projectId: 'proj-2' });
    });

    it('resolves area zones to area targets', () => {
        expect(resolveTaskSidebarDropTarget(
            getProjectAreaContainerId('active', 'a1'),
            { zone: 'projectArea', section: 'active', areaId: 'a1' },
        )).toEqual({ kind: 'area', areaId: 'a1' });
    });

    it('rejects archived targets and workspace containers', () => {
        expect(resolveTaskSidebarDropTarget('proj-3', { type: 'project', section: 'archived' })).toBeNull();
        expect(resolveTaskSidebarDropTarget(
            getProjectAreaContainerId('archived', 'a1'),
            { zone: 'projectArea', section: 'archived', areaId: 'a1' },
        )).toBeNull();
        expect(resolveTaskSidebarDropTarget('section:none', { zone: 'section' })).toBeNull();
        expect(resolveTaskSidebarDropTarget('t2', { type: 'task', sortable: true })).toBeNull();
    });
});


describe('projectsViewKeyboardCoordinates', () => {
    it.each(['ArrowDown', 'ArrowRight'])('moves to the next header with %s despite intervening tasks and other projects', (code) => {
        const horizontal = code === 'ArrowRight';
        const positioned = (offset: number, size = 30) => horizontal
            ? { ...rect(0, 30), left: offset, right: offset + size, width: size }
            : rect(offset, size);
        const sectionData = { type: 'project-section', projectId: 'p1', sectionId: 's1' };
        const containers = [
            buildContainer('first', positioned(0), sectionData),
            buildContainer('task-1', positioned(60, 40), { type: 'task', sortable: true }),
            buildContainer('task-2', positioned(110, 40), { type: 'task', sortable: true }),
            buildContainer('foreign', positioned(150), { type: 'project-section', projectId: 'p2' }),
            buildContainer('second', positioned(200), { ...sectionData, sectionId: 's2' }),
        ].map((container) => ({ ...container, node: { current: document.createElement('div') } }));
        const args = buildArgs({ activeId: 'first', activeData: sectionData, containers, pointer: null });
        const coordinates = projectsViewKeyboardCoordinates(new KeyboardEvent('keydown', { code }), {
            currentCoordinates: { x: 0, y: 0 },
            context: {
                ...args,
                collisionRect: positioned(0),
                droppableContainers: {
                    getEnabled: () => containers,
                    get: (id: string) => containers.find((container) => container.id === id),
                },
                over: { id: 'first' },
                scrollableAncestors: [],
            },
        } as never);
        expect(coordinates).toEqual(horizontal ? { x: 200, y: 0 } : { x: 0, y: 200 });
        expect(projectsViewCollisionDetection({ ...args, collisionRect: positioned(horizontal ? coordinates!.x : coordinates!.y) } as never)[0]?.id)
            .toBe('second');
    });
});
