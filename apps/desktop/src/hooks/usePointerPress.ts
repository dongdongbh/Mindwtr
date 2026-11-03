import { useCallback, useEffect, useRef } from 'react';


export function usePointerPress() {
    const pressActiveRef = useRef(false);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        const handleDown = () => {
            pressActiveRef.current = true;
        };
        const handleUp = () => {
            pressActiveRef.current = false;
        };
        document.addEventListener('pointerdown', handleDown, true);
        document.addEventListener('pointerup', handleUp, true);
        document.addEventListener('pointercancel', handleUp, true);
        return () => {
            document.removeEventListener('pointerdown', handleDown, true);
            document.removeEventListener('pointerup', handleUp, true);
            document.removeEventListener('pointercancel', handleUp, true);
        };
    }, []);


    const runAfterPointerRelease = useCallback((callback: () => void) => {
        if (typeof document === 'undefined' || !pressActiveRef.current) {
            window.setTimeout(callback, 0);
            return;
        }
        const handleRelease = () => {
            document.removeEventListener('pointerup', handleRelease, true);
            document.removeEventListener('pointercancel', handleRelease, true);


            window.setTimeout(callback, 0);
        };
        document.addEventListener('pointerup', handleRelease, true);
        document.addEventListener('pointercancel', handleRelease, true);
    }, []);

    return { runAfterPointerRelease };
}
