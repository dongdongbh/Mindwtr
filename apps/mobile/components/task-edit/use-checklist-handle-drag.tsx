import React from 'react';
import { Keyboard, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { checklistDropIndex, checklistEdgeScroll } from './checklist-editor-rows';

export type ChecklistDragScroll = {
    begin: () => void;
    end: () => void;
    offset: () => number;
    viewport: () => { top: number; bottom: number };
    scrollBy: (delta: number) => void;
};
export const ChecklistDragScrollContext = React.createContext<ChecklistDragScroll | null>(null);

type Drag = { row: string; startY: number; pointer: number; originTop: number; originOffset: number; moved: boolean; measured: boolean };

export function useChecklistHandleDrag({ sessionId, rows, onMove, onStart, onMenu }: {
    sessionId?: string;
    rows: readonly string[];
    onMove: (from: number, to: number) => void;
    onStart: () => void;
    onMenu: (row: string) => void;
}) {
    const scroll = React.useContext(ChecklistDragScrollContext);
    const listRef = React.useRef<View | null>(null);
    const layouts = React.useRef(new Map<string, { y: number; height: number }>());
    const active = React.useRef<Drag | null>(null);
    const frame = React.useRef<number | null>(null);
    const latest = React.useRef({ rows, onMove, onStart, onMenu, scroll });
    latest.current = { rows, onMove, onStart, onMenu, scroll };
    const [indicator, setIndicator] = React.useState<{ row: string; target: string } | null>(null);

    const targetIndex = React.useCallback((drag: Drag) => {
        const current = latest.current;
        if (!drag.measured || current.rows.some((row) => !layouts.current.has(row))) return -1;
        const pointer = drag.pointer - drag.originTop + (current.scroll?.offset() ?? 0) - drag.originOffset;
        return checklistDropIndex(current.rows.map((row) => {
            const layout = layouts.current.get(row);
            return layout ? layout.y + layout.height / 2 : Number.POSITIVE_INFINITY;
        }), pointer);
    }, []);

    const finish = React.useCallback((commit: boolean) => {
        const drag = active.current;
        active.current = null;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        latest.current.scroll?.end();
        setIndicator(null);
        if (!drag) return;
        if (commit && drag.moved) {
            const from = latest.current.rows.indexOf(drag.row);
            const to = targetIndex(drag);
            if (from >= 0 && to >= 0 && from !== to) latest.current.onMove(from, to);
        } else if (commit) {
            latest.current.onMenu(drag.row);
        }
    }, [targetIndex]);

    const tick = React.useCallback(function tick() {
        const drag = active.current;
        if (!drag) return;
        const current = latest.current;
        if (!current.rows.includes(drag.row)) { finish(false); return; }
        if (drag.moved) {
            const viewport = current.scroll?.viewport();
            if (viewport && viewport.bottom > viewport.top) current.scroll?.scrollBy(checklistEdgeScroll(drag.pointer, viewport.top, viewport.bottom));
            const target = current.rows[targetIndex(drag)];
            if (target) setIndicator((previous) => previous?.row === drag.row && previous.target === target
                ? previous : { row: drag.row, target });
        }
        frame.current = requestAnimationFrame(tick);
    }, [finish, targetIndex]);

    React.useEffect(() => {
        setIndicator(null);
        return () => {
        active.current = null;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        latest.current.scroll?.end();
        };
    }, [sessionId]);

    return {
        listRef,
        indicator,
        rowLayout: (row: string, event: LayoutChangeEvent) => layouts.current.set(row, event.nativeEvent.layout),
        handleProps: (row: string) => ({
            onStartShouldSetResponder: () => rows.length > 0,
            onResponderTerminationRequest: () => false,
            onResponderGrant: (event: GestureResponderEvent) => {
                finish(false);
                const pointer = event.nativeEvent.pageY;
                latest.current.onStart();
                Keyboard.dismiss();
                latest.current.scroll?.begin();
                const drag: Drag = { row, startY: pointer, pointer, originTop: 0,
                    originOffset: latest.current.scroll?.offset() ?? 0, moved: false, measured: false };
                active.current = drag;
                listRef.current?.measureInWindow((_x, y) => {
                    if (active.current === drag) { drag.originTop = y; drag.measured = true; }
                });
                frame.current = requestAnimationFrame(tick);
            },
            onResponderMove: (event: GestureResponderEvent) => {
                const drag = active.current;
                if (!drag) return;
                drag.pointer = event.nativeEvent.pageY;
                drag.moved ||= latest.current.rows.length > 1 && Math.abs(drag.pointer - drag.startY) > 6;
            },
            onResponderRelease: () => finish(true),
            onResponderTerminate: () => finish(false),
            onTouchCancel: () => finish(false),
            onAccessibilityTap: () => latest.current.onMenu(row),
        }),
    };
}
