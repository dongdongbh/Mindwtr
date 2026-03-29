import { closestCenter } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { projectTaskCollisionDetection } from './project-task-dnd';

const active = { id: 'dragging-task' } as any;

describe('project-task-dnd', () => {
    it('prefers the task row underneath the pointer over a nearby row', () => {
        const args = {
            active,
            collisionRect: {
                top: 70,
                left: 0,
                width: 100,
                height: 50,
                right: 100,
                bottom: 120,
            },
            pointerCoordinates: {
                x: 50,
                y: 150,
            },
            droppableRects: new Map([
                ['section:none', { top: 0, left: 0, width: 100, height: 260, right: 100, bottom: 260 }],
                ['task-a', { top: 0, left: 0, width: 100, height: 120, right: 100, bottom: 120 }],
                ['task-b', { top: 121, left: 0, width: 100, height: 139, right: 100, bottom: 260 }],
            ]),
            droppableContainers: [
                { id: 'section:none' },
                { id: 'task-a' },
                { id: 'task-b' },
            ] as any,
        };

        expect(closestCenter(args)?.[0]?.id).not.toBe('task-b');
        expect(projectTaskCollisionDetection(args)?.[0]?.id).toBe('task-b');
    });

    it('falls back to closest-center matching when pointer coordinates are unavailable', () => {
        const args = {
            active,
            collisionRect: {
                top: 70,
                left: 0,
                width: 100,
                height: 50,
                right: 100,
                bottom: 120,
            },
            pointerCoordinates: null,
            droppableRects: new Map([
                ['task-a', { top: 0, left: 0, width: 100, height: 120, right: 100, bottom: 120 }],
                ['task-b', { top: 121, left: 0, width: 100, height: 139, right: 100, bottom: 260 }],
            ]),
            droppableContainers: [
                { id: 'task-a' },
                { id: 'task-b' },
            ] as any,
        };

        expect(projectTaskCollisionDetection(args)?.[0]?.id).toBe(closestCenter(args)?.[0]?.id);
    });
});
