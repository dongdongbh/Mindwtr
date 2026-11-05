import type { FilterCriteria } from '@mindwtr/core';

export const STATUS_DRAG_STEP_PX = 72;
export const STATUS_DRAG_TRIGGER_PX = 28;

const withTokenList = (
    criteria: FilterCriteria,
    key: 'contexts' | 'tags',
    values: string[],
): FilterCriteria => {
    const next = { ...criteria };
    if (values.length > 0) {
        next[key] = values;
    } else {
        delete next[key];
    }
    return next;
};


export const toggleCriteriaToken = (criteria: FilterCriteria, token: string): FilterCriteria => {
    const key: 'contexts' | 'tags' = token.trim().startsWith('#') ? 'tags' : 'contexts';
    const current = criteria[key] ?? [];
    const next = current.includes(token)
        ? current.filter((item) => item !== token)
        : [...current, token];
    return withTokenList(criteria, key, next);
};

type ResolveBoardDropColumnIndexArgs = {
    translationX: number;
    currentColumnIndex: number;
    columnCount: number;
    stepPx?: number;
    triggerPx?: number;
};

const clamp = (value: number, min: number, max: number): number => {
    if (value < min) return min;
    if (value > max) return max;
    return value;
};

export const resolveBoardDropColumnIndex = ({
    translationX,
    currentColumnIndex,
    columnCount,
    stepPx = STATUS_DRAG_STEP_PX,
    triggerPx = STATUS_DRAG_TRIGGER_PX,
}: ResolveBoardDropColumnIndexArgs): number => {
    if (!Number.isFinite(columnCount) || columnCount <= 0) {
        return currentColumnIndex;
    }
    const absDelta = Math.abs(translationX);
    if (absDelta < triggerPx) {
        return clamp(currentColumnIndex, 0, columnCount - 1);
    }

    const direction = translationX < 0 ? -1 : 1;
    const additionalSteps = Math.floor((absDelta - triggerPx) / Math.max(1, stepPx));
    const columnsMoved = direction * (1 + additionalSteps);
    const nextIndex = currentColumnIndex + columnsMoved;
    return clamp(nextIndex, 0, columnCount - 1);
};

type BoardColumnBounds = {
    index: number;
    top: number;
    bottom: number;
};

type ResolveBoardDropColumnIndexFromYArgs = {
    dragCenterY: number;
    currentColumnIndex: number;
    columnBounds: BoardColumnBounds[];
};

export const resolveBoardDropColumnIndexFromY = ({
    dragCenterY,
    currentColumnIndex,
    columnBounds,
}: ResolveBoardDropColumnIndexFromYArgs): number => {
    if (!Number.isFinite(dragCenterY) || columnBounds.length === 0) {
        return currentColumnIndex;
    }

    const sortedBounds = [...columnBounds]
        .filter((item) => Number.isFinite(item.top) && Number.isFinite(item.bottom) && item.bottom >= item.top)
        .sort((a, b) => a.top - b.top);

    if (sortedBounds.length === 0) {
        return currentColumnIndex;
    }

    const directMatch = sortedBounds.find((item) => dragCenterY >= item.top && dragCenterY <= item.bottom);
    if (directMatch) {
        return directMatch.index;
    }

    let nearest = sortedBounds[0];
    let nearestDistance = dragCenterY < nearest.top ? nearest.top - dragCenterY : dragCenterY - nearest.bottom;
    for (let i = 1; i < sortedBounds.length; i += 1) {
        const candidate = sortedBounds[i];
        const distance = dragCenterY < candidate.top ? candidate.top - dragCenterY : dragCenterY - candidate.bottom;
        if (distance < nearestDistance) {
            nearest = candidate;
            nearestDistance = distance;
        }
    }

    return nearest.index;
};

type ColumnTaskLayout = {
    id: string;
    top: number;
    height: number;
};

type ResolveBoardColumnDropTargetArgs = {
    taskId: string;
    dragCenterY: number;
    columnTasks: ColumnTaskLayout[];
};


export const resolveBoardColumnDropTarget = ({
    taskId,
    dragCenterY,
    columnTasks,
}: ResolveBoardColumnDropTargetArgs): { columnIds: string[]; afterId: string | null } | null => {
    if (!Number.isFinite(dragCenterY)) return null;

    const sortedTasks = [...columnTasks]
        .filter((item) => Number.isFinite(item.top) && Number.isFinite(item.height) && item.height >= 0)
        .sort((a, b) => a.top - b.top);
    if (!sortedTasks.some((item) => item.id === taskId)) return null;

    const others = sortedTasks.filter((item) => item.id !== taskId);
    let insertIndex = 0;
    for (const item of others) {
        if (dragCenterY > item.top + (item.height / 2)) {
            insertIndex += 1;
        }
    }

    return {
        columnIds: sortedTasks.map((item) => item.id),
        afterId: insertIndex > 0 ? others[insertIndex - 1].id : null,
    };
};
