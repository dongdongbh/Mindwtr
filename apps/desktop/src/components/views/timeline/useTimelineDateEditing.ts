import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { planTimelineProjectDateEdit, planTimelineTaskDateEdit, type TimelineDateEdit, type TimelineDateEditKind } from '@mindwtr/core';
import { commitTimelineDateEdit } from '../../../lib/timeline-date-edit';
import { showUndoToast } from '../../../lib/undo-registry';
import { useUiStore } from '../../../store/ui-store';

type Target = Parameters<typeof commitTimelineDateEdit>[0];
type Preview = { target: Target; edit: TimelineDateEdit; dates: { start?: string; due?: string } | null };
type Gesture = {
    target: Target; kind: TimelineDateEditKind; pointerId: number; x: number; lastX: number;
    scrollLeft: number; dayWidth: number; days: number; dragged: boolean;
};

const targetId = (target: Target) => target.kind === 'task' ? target.task.id : target.project.id;
const targetKey = (target: Target) => `${target.kind}:${targetId(target)}`;
const plan = (target: Target, edit: TimelineDateEdit) => target.kind === 'task'
    ? planTimelineTaskDateEdit(target.task, edit) : planTimelineProjectDateEdit(target.project, edit);

export function useTimelineDateEditing({
    dayWidth, geometryKey, scrollRef, t,
}: {
    dayWidth: number; geometryKey: string; scrollRef: RefObject<HTMLDivElement | null>; t: (key: string) => string;
}) {
    const gestureRef = useRef<Gesture | null>(null);
    const blockedRef = useRef(false);
    const suppressClickRef = useRef<string | null>(null);
    const [pending, setPending] = useState(false);
    const [preview, setPreview] = useState<Preview | null>(null);
    const previewRef = useRef<Preview | null>(null);

    const save = useCallback(async (target: Target, edit: TimelineDateEdit) => {
        if (blockedRef.current || edit.days === 0) return;
        blockedRef.current = true;
        setPending(true);
        const toast = (key: string) => useUiStore.getState().showToast(t(`timeline.${key}`), 'error');
        try {
            const result = await commitTimelineDateEdit(target, edit);
            if (result.status === 'saved') {
                const undo = () => {
                    void result.undo().then((restored) => {
                        if (!restored) toast('dateUndoConflict');
                    }).catch(() => {
                        toast('dateUndoFailed');
                        showUndoToast(t('timeline.dateUndoFailed'), undo, t);
                    });
                };
                showUndoToast(t('timeline.datesUpdated'), undo, t);
            } else if (result.status !== 'noop') {
                toast(result.status === 'conflict' ? 'dateEditConflict' : 'dateEditFailed');
            }
        } catch {
            toast('dateEditFailed');
        } finally {
            blockedRef.current = false;
            setPending(false);
        }
    }, [t]);

    const cancel = useCallback(() => {
        const gesture = gestureRef.current;
        if (gesture?.dragged) suppressClickRef.current = targetKey(gesture.target);
        gestureRef.current = null;
        previewRef.current = null;
        setPreview(null);
    }, []);

    useEffect(() => {
        cancel();
        // Zoom or range changes cancel rather than reinterpret captured pixels.
    }, [geometryKey, cancel]);

    useEffect(() => {
        const move = (event?: globalThis.PointerEvent) => {
            const gesture = gestureRef.current;
            if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
            if (event) gesture.lastX = event.clientX;
            const displacement = gesture.lastX - gesture.x + (scrollRef.current?.scrollLeft ?? 0) - gesture.scrollLeft;
            if (!gesture.dragged && Math.abs(displacement) < 4) return;
            gesture.dragged = true;
            suppressClickRef.current = targetKey(gesture.target);
            const days = Math.round(displacement / gesture.dayWidth);
            if (days === gesture.days && previewRef.current) return;
            gesture.days = days;
            const edit = { kind: gesture.kind, days };
            const result = days === 0 ? null : plan(gesture.target, edit);
            const dates = result?.effectiveDates ?? (days === 0
                ? gesture.target.kind === 'task'
                    ? { start: gesture.target.task.startTime, due: gesture.target.task.dueDate }
                    : { start: gesture.target.project.startDate, due: gesture.target.project.dueDate }
                : null);
            const next = { target: gesture.target, edit, dates };
            previewRef.current = next;
            setPreview(next);
        };
        const up = (event: globalThis.PointerEvent) => {
            const gesture = gestureRef.current;
            if (!gesture || event.pointerId !== gesture.pointerId) return;
            move(event);
            gestureRef.current = null;
            setPreview(null);
            previewRef.current = null;
            if (!gesture.dragged || gesture.days === 0) return;
            const edit = { kind: gesture.kind, days: gesture.days };
            if (!plan(gesture.target, edit)) {
                useUiStore.getState().showToast(t('timeline.dateEditFailed'), 'error');
                return;
            }
            void save(gesture.target, edit);
        };
        const pointerCancel = (event: globalThis.PointerEvent) => {
            if (gestureRef.current?.pointerId === event.pointerId) cancel();
        };
        const key = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Escape' || !gestureRef.current) return;
            event.preventDefault();
            cancel();
        };
        const scroll = () => move();
        const scroller = scrollRef.current;
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', pointerCancel);
        window.addEventListener('keydown', key);
        window.addEventListener('blur', cancel);
        scroller?.addEventListener('scroll', scroll);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', pointerCancel);
            window.removeEventListener('keydown', key);
            window.removeEventListener('blur', cancel);
            scroller?.removeEventListener('scroll', scroll);
            gestureRef.current = null;
        };
    }, [cancel, save, scrollRef, t, geometryKey]);
    const onPointerDown = (event: PointerEvent<HTMLElement>, target: Target, kind: TimelineDateEditKind) => {
        if (event.button !== 0 || blockedRef.current || gestureRef.current) return;
        suppressClickRef.current = null;
        previewRef.current = null;
        event.stopPropagation();
        const snapshot: Target = target.kind === 'task'
            ? { ...target, task: { ...target.task }, project: target.project ? { ...target.project } : undefined }
            : { ...target, project: { ...target.project } };
        gestureRef.current = {
            target: snapshot, kind, pointerId: event.pointerId, x: event.clientX, lastX: event.clientX,
            scrollLeft: scrollRef.current?.scrollLeft ?? 0, dayWidth, days: 0, dragged: false,
        };
    };
    const onKeyDown = (event: KeyboardEvent<HTMLElement>, target: Target, kind: TimelineDateEditKind) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        if (gestureRef.current || blockedRef.current || event.repeat) return;
        void save(target, { kind, days: event.key === 'ArrowLeft' ? -1 : 1 });
    };
    const consumeClick = (target: Target) => {
        if (suppressClickRef.current !== targetKey(target)) return false;
        suppressClickRef.current = null;
        return true;
    };
    return { preview, pending, onPointerDown, onKeyDown, consumeClick };
}
