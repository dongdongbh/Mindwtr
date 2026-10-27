import { RefObject, useLayoutEffect, useState, type CSSProperties } from 'react';

type UseDropdownPositionOptions = {
    open: boolean;
    containerRef: RefObject<HTMLElement | null>;
    dropdownRef: RefObject<HTMLElement | null>;
};

const MIN_LIST_HEIGHT = 120;
const MAX_LIST_HEIGHT = 320;
const VIEWPORT_MARGIN_PX = 8;
const DROPDOWN_GAP_PX = 4;
// A small trigger (the bulk toolbar's Destination button) still gets a menu wide
// enough for project and area names (#1470).
const MIN_DROPDOWN_WIDTH_PX = 240;
const DROPDOWN_CHROME_PX = 84;
const MIN_DROPDOWN_SPACE = MIN_LIST_HEIGHT + DROPDOWN_CHROME_PX;

export function useDropdownPosition({ open, containerRef, dropdownRef }: UseDropdownPositionOptions) {
    const [openUpward, setOpenUpward] = useState(false);
    const [listMaxHeight, setListMaxHeight] = useState(192);
    const [fixedDropdownStyle, setFixedDropdownStyle] = useState<CSSProperties>({
        position: 'fixed',
        left: 0,
        top: 0,
        width: 0,
    });

    useLayoutEffect(() => {
        if (!open) return;

        const updatePosition = () => {
            const trigger = containerRef.current;
            const dropdown = dropdownRef.current;
            if (!trigger || !dropdown) return;

            const triggerRect = trigger.getBoundingClientRect();
            const dropdownWidth = Math.min(
                Math.max(triggerRect.width, MIN_DROPDOWN_WIDTH_PX),
                window.innerWidth - VIEWPORT_MARGIN_PX * 2,
            );
            const maxLeft = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - dropdownWidth - VIEWPORT_MARGIN_PX);
            const spaceAbove = triggerRect.top - VIEWPORT_MARGIN_PX;
            const spaceBelow = window.innerHeight - triggerRect.bottom - VIEWPORT_MARGIN_PX;
            const shouldOpenUp = spaceBelow < MIN_DROPDOWN_SPACE && spaceAbove > spaceBelow;
            setOpenUpward(shouldOpenUp);
            setFixedDropdownStyle({
                position: 'fixed',
                left: Math.min(Math.max(VIEWPORT_MARGIN_PX, triggerRect.left), maxLeft),
                top: shouldOpenUp ? 'auto' : triggerRect.bottom + DROPDOWN_GAP_PX,
                bottom: shouldOpenUp ? window.innerHeight - triggerRect.top + DROPDOWN_GAP_PX : 'auto',
                width: dropdownWidth,
            });

            const availableSpace = shouldOpenUp ? spaceAbove : spaceBelow;
            const nextListHeight = Math.max(
                MIN_LIST_HEIGHT,
                Math.min(MAX_LIST_HEIGHT, Math.floor(availableSpace - DROPDOWN_CHROME_PX))
            );
            setListMaxHeight(nextListHeight);
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [open, containerRef, dropdownRef]);

    return {
        dropdownClassName: openUpward ? 'bottom-full mb-1' : 'top-full mt-1',
        fixedDropdownStyle,
        listMaxHeight,
    };
}
