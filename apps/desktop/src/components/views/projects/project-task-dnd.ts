import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core';

export const projectTaskCollisionDetection: CollisionDetection = (args) => {
    const pointerCollisions = pointerWithin(args);

    if (pointerCollisions.length > 0) {
        return pointerCollisions;
    }

    return closestCenter(args);
};
