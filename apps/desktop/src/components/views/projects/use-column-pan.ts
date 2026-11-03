import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';


export function useMiddleMousePan(ref: RefObject<HTMLElement | null>) {


    const stopRef = useRef<(() => void) | null>(null);
    useEffect(() => () => stopRef.current?.(), []);

    return useCallback((event: ReactPointerEvent) => {
        if (event.button !== 1) return;
        const element = ref.current;
        if (!element) return;

        event.preventDefault();

        let lastX = event.clientX;
        const onMove = (moveEvent: PointerEvent) => {
            element.scrollLeft -= moveEvent.clientX - lastX;
            lastX = moveEvent.clientX;
        };
        const stop = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            stopRef.current = null;
        };
        stopRef.current = stop;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
    }, [ref]);
}
